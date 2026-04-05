import { NextRequest, NextResponse } from "next/server";

// Sample paper for testing prompt templates
const SAMPLE_PAPER = {
  title: "LatentUM: Unleashing the Potential of Interleaved Cross-Modal Reasoning via Latent Understanding Modeling",
  abstract: "Recent multimodal large language models (MLLMs) have demonstrated exceptional capabilities across various vision-language tasks. However, existing approaches often treat understanding and generation as separate objectives, limiting synergistic learning between the two. In this work, we propose LatentUM, a unified framework that bridges multimodal understanding and generation through latent reasoning. Our method introduces cross-modal latent tokens that enable seamless information flow between visual understanding and text generation pathways. We demonstrate that this approach achieves state-of-the-art performance on multiple benchmarks while requiring significantly fewer parameters than existing methods. Experiments on VQA, image captioning, and visual reasoning tasks show consistent improvements of 3-5% over strong baselines, with particularly notable gains on complex reasoning tasks requiring joint visual-textual inference.",
};

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json();

    if (!prompt) {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GOOGLE_API_KEY not configured" }, { status: 500 });
    }

    // Replace placeholders with sample data
    const finalPrompt = prompt
      .replace(/\{\{title\}\}/g, SAMPLE_PAPER.title)
      .replace(/\{\{abstract\}\}/g, SAMPLE_PAPER.abstract);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: finalPrompt }] }],
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json({ error: `Gemini API error: ${body}` }, { status: 500 });
    }

    const data = await res.json();
    const output = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(no output)";

    return NextResponse.json({
      output,
      samplePaper: { title: SAMPLE_PAPER.title, abstract: SAMPLE_PAPER.abstract.slice(0, 200) + "..." },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Test failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
