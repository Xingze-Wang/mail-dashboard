/**
 * Server-side fallback scorer — asks Gemini to estimate lead quality
 * (0-1) when Python's trained classifier wasn't in the loop.
 *
 * Intent: approximate the sentence-transformer scorer in scorer_model/.
 * The trained model sees "will this author reply + add WeChat?" as the
 * target; we prompt Gemini with the same framing so the 0-1 scale is
 * comparable enough for sorting. Not meant to replace the real scorer —
 * just a stopgap so leads inserted without going through Python aren't
 * unsortable.
 *
 * Returns null on any failure so callers can fall back to citation count.
 */

const MODEL = "gemini-2.0-flash";

export async function scoreWithGemini(
  title: string,
  abstract: string,
): Promise<number | null> {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are a lead-quality scorer for a GPU-compute sales outreach system.
A good lead is a researcher whose paper suggests they need significant compute
AND who is likely to respond positively to a free-credits offer (e.g. heavy
training, frontier model work, academic lab without big-co affiliation).

Rate the following paper from 0.00 (very poor lead) to 1.00 (excellent lead).
Return ONLY a JSON object: {"score": 0.xx}

Title: ${title.slice(0, 400)}
Abstract: ${abstract.slice(0, 1500)}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 40 },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return null;

    const data = await res.json();
    const text: string | undefined =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const match = text.match(/\{[^{}]*"score"\s*:\s*([\d.]+)[^{}]*\}/);
    if (!match) return null;
    const score = parseFloat(match[1]);
    if (isNaN(score) || score < 0 || score > 1) return null;
    return score;
  } catch {
    return null;
  }
}
