import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { llmChat } from "@/lib/llm-proxy";

// Fallback sample used when caller doesn't request real-lead bench mode.
const SAMPLE_PAPER = {
  title: "LatentUM: Unleashing the Potential of Interleaved Cross-Modal Reasoning via Latent Understanding Modeling",
  abstract: "Recent multimodal large language models (MLLMs) have demonstrated exceptional capabilities across various vision-language tasks. However, existing approaches often treat understanding and generation as separate objectives, limiting synergistic learning between the two. In this work, we propose LatentUM, a unified framework that bridges multimodal understanding and generation through latent reasoning.",
};

interface SamplePaper {
  lead_id?: string;
  title: string;
  abstract: string;
  author_name?: string;
}

async function pickRealSamples(n: number): Promise<SamplePaper[]> {
  // Pick N recent leads with non-empty abstracts so the prompt sees a
  // realistic spread of paper styles. Order randomly across the recent window.
  const { data } = await supabase
    .from("pipeline_leads")
    .select("id, title, abstract, author_name")
    .not("abstract", "is", null)
    .gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []).filter((r) => (r.abstract as string | null)?.length && r.abstract!.length > 200);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, n).map((r) => ({
    lead_id: r.id as string,
    title: (r.title as string) ?? "",
    abstract: ((r.abstract as string) ?? "").slice(0, 800),
    author_name: (r.author_name as string) ?? "",
  }));
}

async function runPromptOnce(prompt: string, paper: SamplePaper): Promise<{ output: string; error?: string }> {
  const finalPrompt = prompt
    .replace(/\{\{title\}\}/g, paper.title)
    .replace(/\{\{abstract\}\}/g, paper.abstract)
    .replace(/\{\{author_name\}\}/g, paper.author_name ?? "");
  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      user: finalPrompt,
      temperature: 0.5,
      max_tokens: 800,
    });
    return { output: r.text || "(empty output)" };
  } catch (e) {
    return { output: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const prompt: string = body.prompt;
    const numSamples: number = Math.max(1, Math.min(5, Number(body.num_samples) || 1));
    const useRealLeads: boolean = body.use_real_leads === true || numSamples > 1;

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    const samples: SamplePaper[] = useRealLeads
      ? await pickRealSamples(numSamples)
      : [];
    if (samples.length < numSamples) {
      samples.unshift(SAMPLE_PAPER);
    }

    // Run prompt in parallel against each sample. llmChat goes through
    // the proxy so we avoid the hkg1 → generativelanguage.googleapis.com
    // FAILED_PRECONDITION issue documented in memory.
    const results = await Promise.all(
      samples.slice(0, numSamples).map(async (paper) => {
        const r = await runPromptOnce(prompt, paper);
        return {
          lead_id: paper.lead_id ?? null,
          title: paper.title.slice(0, 120),
          author_name: paper.author_name ?? null,
          output: r.output,
          error: r.error ?? null,
        };
      }),
    );

    return NextResponse.json({
      model: "gemini-3-flash",
      samples: results,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Test failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
