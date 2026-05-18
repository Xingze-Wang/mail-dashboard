// Parallel drain: render ALL queued+assigned leads through generateDraft()
// using gemini-3-flash-preview, 100 concurrent workers.
//
// Usage: npx tsx scripts/_drain-snapshot-runner.ts
//
// What changed vs serial version:
//   - 100 workers each pulling from a shared cursor (Array.shift() under
//     a mutex-like flag — simple but correct since Node JS is single-thread)
//   - Atomic claim (status: queued → drafting filtered by id+status)
//     prevents double-render races between workers AND between this script
//     and the prod cron
//   - 429 retry with exponential backoff (3 tries)
//   - Status snapshot logged every 30s

import { readFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

async function main() {
  const { supabase } = await import("../src/lib/db");
  const { generateDraft, normalizeMatchedDirections } = await import("../src/lib/email-generator");
  const { getRep, classifyLead, getAssignmentConfig } = await import("../src/lib/assignment");
  const { validateDraft } = await import("../src/lib/draft-validator");

  const MODEL_MARK = "server-gemini-v5b-" + new Date().toISOString().slice(0, 10);
  const TARGET = 1500;     // upper bound; only renders what's actually queued+assigned
  const WORKERS = 100;
  const t0 = Date.now();

  console.log(`MARK=${MODEL_MARK}`);
  console.log(`fetching up to ${TARGET} queued+assigned leads...`);

  const { data: queued, error } = await supabase
    .from("pipeline_leads")
    .select("id, title, abstract, author_email, author_name, first_name, school_name, school_tier, matched_directions, assigned_rep_id, citation_count, h_index, local_score")
    .eq("status", "queued")
    .not("assigned_rep_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(TARGET);

  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  console.log(`got ${queued?.length ?? 0} leads to process with ${WORKERS} workers\n`);

  const config = await getAssignmentConfig();
  let cursor = 0;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  const errors: Record<string, number> = {};

  // Shared cursor — workers pull next index atomically (Node single-thread = safe)
  function nextIndex(): number {
    return cursor++;
  }

  // Status reporter — fires every 30s while drain is in flight
  const reporter = setInterval(() => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const rate = (ok / Math.max(1, (Date.now() - t0) / 1000)).toFixed(2);
    const eta = ((queued!.length - cursor) / Math.max(0.1, parseFloat(rate)) / 60).toFixed(1);
    console.log(`  [t=${elapsed}s] cursor=${cursor}/${queued!.length}  ok=${ok}  failed=${failed}  skipped=${skipped}  rate=${rate}/s  eta=${eta}min`);
    if (Object.keys(errors).length > 0) {
      const top = Object.entries(errors).sort(([, a], [, b]) => b - a).slice(0, 3);
      console.log(`    error types: ${top.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  }, 30_000);

  async function processOne(lead: typeof queued[0], attempt = 1): Promise<"ok" | "fail" | "skip"> {
    const id = lead.id as string;
    // Atomic claim — only on first attempt. Retries re-use the existing
    // "drafting" claim so other workers don't grab the lead mid-retry.
    if (attempt === 1) {
      const { data: claimed } = await supabase
        .from("pipeline_leads")
        .update({ status: "drafting" })
        .eq("id", id)
        .eq("status", "queued")
        .select("id")
        .maybeSingle();
      if (!claimed) return "skip";
    }

    try {
      const matchedDirs = normalizeMatchedDirections(lead.matched_directions);
      const newTier = classifyLead(config, {
        citationCount: lead.citation_count as number | null,
        hIndex: lead.h_index as number | null,
        schoolTier: lead.school_tier as number | null,
        authorEmail: lead.author_email as string,
        localScore: lead.local_score as number | null,
      });
      const rep = await getRep(lead.assigned_rep_id as number);

      const draft = await generateDraft({
        title: lead.title as string,
        abstract: (lead.abstract as string) || "",
        authorEmail: lead.author_email as string,
        firstName: (lead.first_name as string) || null,
        schoolName: (lead.school_name as string) || null,
        schoolTier: lead.school_tier as number | null,
        matchedDirections: matchedDirs,
        repName: rep?.sender_name,
        repWechatId: rep?.wechat_id,
        assignedRepId: lead.assigned_rep_id as number,
        leadId: id,
      });

      // QUALITY GATE — block bad drafts from flipping to ready.
      const validation = validateDraft({
        subject: draft.subject,
        html: draft.html,
        introOutput: draft.introOutput,
      });
      if (!validation.ok) {
        // HARD issues — throw so retry loop can rerun the LLM.
        throw new Error(
          `QUALITY_GATE_FAIL: ${validation.hard.map((h) => h.key).join(",")}`,
        );
      }

      await supabase.from("pipeline_leads").update({
        lead_tier: newTier,
        draft_subject: draft.subject,
        draft_html: draft.html,
        draft_intro_prompt_resolved: draft.introPromptResolved ?? null,
        draft_intro_output: draft.introOutput ?? null,
        draft_original_subject: draft.subject,
        draft_original_html: draft.html,
        draft_model: MODEL_MARK,
        status: "ready",
      }).eq("id", id);
      return "ok";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetriable =
        /timeout|429|rate.?limit|503|unavailable|fetch failed|ECONNRESET|empty content|QUALITY_GATE_FAIL/i.test(msg);
      const MAX_ATTEMPTS = 3;
      if (isRetriable && attempt < MAX_ATTEMPTS) {
        // Exponential backoff: 2s, 4s, 8s
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
        return processOne(lead, attempt + 1);
      }
      // Final failure — bucket + rollback
      const key =
        /429|rate.?limit/i.test(msg) ? "429" :
        /timeout/i.test(msg) ? "timeout" :
        /503|unavailable/i.test(msg) ? "503" :
        /quota/i.test(msg) ? "quota" :
        msg.slice(0, 40);
      errors[`${key} (after ${attempt} tries)`] = (errors[`${key} (after ${attempt} tries)`] ?? 0) + 1;
      await supabase.from("pipeline_leads").update({ status: "queued" }).eq("id", id);
      return "fail";
    }
  }

  async function worker(wid: number) {
    while (true) {
      const i = nextIndex();
      if (i >= queued!.length) return;
      const result = await processOne(queued![i]);
      if (result === "ok") ok++;
      else if (result === "fail") failed++;
      else skipped++;
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  clearInterval(reporter);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nDONE  ok=${ok}  failed=${failed}  skipped=${skipped}  elapsed=${elapsed}s`);
  if (Object.keys(errors).length > 0) {
    console.log("error breakdown:");
    for (const [k, v] of Object.entries(errors).sort(([, a], [, b]) => b - a)) {
      console.log(`  ${k}: ${v}`);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
