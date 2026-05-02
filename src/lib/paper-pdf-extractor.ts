// Extract author emails + GitHub/HF repo URLs from an arxiv paper's first page.
//
// The corresponding-author email is the gold-standard identity signal: when
// it matches an email we already have for a person, identity is confirmed
// end-to-end. When it surfaces a NEW email, that's an alias for the same
// person — the dedup robustness lever.
//
// arxiv exposes papers at https://arxiv.org/pdf/<id> (PDF) and
// https://arxiv.org/abs/<id> (abstract HTML). The HTML abs page often
// includes the rendered first page text via the `arxiv-vanity` template
// — but the most reliable source is parsing the PDF. We use the abs HTML
// for repos (cheap) and download the PDF for emails (expensive but worth it).
//
// Email extraction strategy: pull the first 4KB of the PDF as text (page 1
// usually fits). Match RFC-style email addresses. Filter out the citation
// emails (latex packages, common boilerplate).

const EMAIL_RE = /[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const HF_PATTERN = /(?:huggingface\.co\/(?:models?\/|datasets?\/|spaces\/)?)([\w-]+\/[\w.-]+)/gi;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;

const EMAIL_BOILERPLATE_DOMAINS = new Set([
  // PDF embedded fonts / metadata
  "adobe.com",
  "ams.org",
  "arxiv.org",
  "ctan.org",
  "openreview.net",
  "tex.stackexchange.com",
  // Common library/template domains that show up in latex bib files
  "ieee.org",
  "acm.org",
]);

function isLikelyAuthorEmail(email: string): boolean {
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] ?? "";
  if (EMAIL_BOILERPLATE_DOMAINS.has(domain)) return false;
  // Reject overly-short local parts (e.g. "a@x.y" — usually a math symbol)
  const local = lower.split("@")[0];
  if (local.length < 2) return false;
  return true;
}

function normalizeRepo(repo: string): string {
  return repo.replace(/[.,)\]\s]+$/, "").trim();
}

export interface PaperExtraction {
  emails: string[];
  hf_repo: string | null;
  github_repo: string | null;
  source_url: string;
  truncated: boolean;
}

/**
 * Pull the first ~150KB of a PDF and run text extraction. We look for the
 * first 4KB of human-readable strings — the cover page text — and pattern-
 * match emails + repos there.
 *
 * arxiv PDFs are rarely > 5MB; first page is usually < 200KB.
 */
export async function extractFromArxivPdf(arxivId: string): Promise<PaperExtraction> {
  const id = arxivId.replace(/v\d+$/, ""); // strip version
  const url = `https://arxiv.org/pdf/${encodeURIComponent(id)}`;
  const empty: PaperExtraction = {
    emails: [],
    hf_repo: null,
    github_repo: null,
    source_url: url,
    truncated: false,
  };

  let buf: ArrayBuffer;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { Range: "bytes=0-153600" }, // first 150KB
    });
    if (!res.ok && res.status !== 206) return empty;
    buf = await res.arrayBuffer();
  } catch {
    return empty;
  }

  // Convert to Latin-1 string, then strip non-printable. PDFs use a mix of
  // binary (compressed streams) and ASCII metadata. Author block on page 1
  // is usually in plaintext within /Tj operators.
  const bytes = new Uint8Array(buf);
  let text = "";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if ((c >= 32 && c < 127) || c === 10 || c === 13) text += String.fromCharCode(c);
    else text += " ";
  }
  // Collapse spaces
  text = text.replace(/\s+/g, " ");

  // Emails — pull all, dedupe, filter
  const rawEmails = text.match(EMAIL_RE) ?? [];
  const emails = [...new Set(rawEmails.map((e) => e.toLowerCase()))]
    .filter(isLikelyAuthorEmail)
    .slice(0, 20); // cap to avoid pathological PDFs

  const hfMatches = [...text.matchAll(HF_PATTERN)].map((m) => normalizeRepo(m[1]));
  const ghMatches = [...text.matchAll(GH_PATTERN)].map((m) => normalizeRepo(m[1]));

  const counts = (arr: string[]) => {
    const c = new Map<string, number>();
    for (const r of arr) c.set(r, (c.get(r) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };

  return {
    emails,
    hf_repo: counts(hfMatches.filter((r) => !r.toLowerCase().startsWith("anonymous/"))),
    github_repo: counts(ghMatches.filter((r) => !r.toLowerCase().startsWith("anonymous/"))),
    source_url: url,
    truncated: bytes.length >= 153_000,
  };
}
