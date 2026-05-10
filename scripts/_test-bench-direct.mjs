import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient("https://erguqrisqtugfysofwdd.supabase.co","eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",{auth:{persistSession:false}});

const { data: prompts } = await sb.from("model_prompts").select("id, kind, name, llm_model, persona_archetype").order("kind");
const { data: preds } = await sb.from("model_predictions").select("prompt_id, email_id, template_id, headline, prediction");

console.log("Prompts:", prompts.length);
console.log("Predictions:", preds.length);

const byKind = {};
for (const p of prompts) {
  const myPreds = preds.filter(pr => pr.prompt_id === p.id);
  if (!byKind[p.kind]) byKind[p.kind] = [];

  // Compute MAE if email-targeted
  let mae = null, n = 0;
  if (myPreds.length > 0 && (p.kind === "persona_recipient" || p.kind === "ctr_regressor")) {
    const eIds = myPreds.map(x => x.email_id).filter(Boolean);
    if (eIds.length > 0) {
      const { data: emails } = await sb.from("emails").select("id, status").in("id", eIds);
      const stMap = new Map(emails?.map(e => [e.id, e.status]) || []);
      let sum = 0;
      for (const pr of myPreds) {
        const st = stMap.get(pr.email_id);
        if (!st) continue;
        const clicked = st === "clicked" ? 1 : 0;
        sum += Math.abs((pr.headline ?? 0) - clicked);
        n++;
      }
      mae = n > 0 ? sum / n : null;
    }
  }

  byKind[p.kind].push({ name: p.name, model: p.llm_model, archetype: p.persona_archetype, n: myPreds.length, mae });
}

for (const kind of Object.keys(byKind)) {
  console.log("\n" + kind.toUpperCase() + ":");
  byKind[kind].sort((a,b) => (a.mae ?? 99) - (b.mae ?? 99));
  for (const r of byKind[kind]) {
    console.log("  ", r.name, "[" + r.model + "]", r.archetype || "", "n=" + r.n, r.mae != null ? "MAE=" + r.mae.toFixed(3) : "");
  }
}
