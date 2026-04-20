// Canonicalize arxiv ids so dedup checks see the same string across formats.
//   arXiv:2403.12345        -> 2403.12345
//   arxiv.org/abs/2403.12345 -> 2403.12345
//   2403.12345v2             -> 2403.12345
//   .../pdf/2403.12345v3.pdf -> 2403.12345
//
// Non-arxiv ids (synthesized like hf_12_x, external_169_a) lowercase only.

export function canonicalizeArxivId(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();

  const urlMatch = /arxiv\.org\/(?:abs|pdf)\/([^/?#]+)/i.exec(s);
  if (urlMatch) s = urlMatch[1];

  s = s.replace(/^arxiv:/i, "");
  s = s.replace(/\.pdf$/i, "");
  s = s.replace(/v\d+$/i, "");

  return s.toLowerCase();
}
