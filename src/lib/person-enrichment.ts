// Person enrichment: for one persons row, populate up to four signals
// (homepage, twitter_handle, hf_users, github_users) in parallel.
//
// Idempotent — each per-signal extractor is skipped when the value is
// already present. Re-runs are safe and only fill gaps.
//
// Sources, in order of confidence:
//   1. homepage         — S2's author.homepage field (fetched via
//                         lookupAuthorWithHomepage). Sparse but
//                         high-precision.
//   2. twitter_handle   — scrape person.homepage HTML for twitter.com /
//                         x.com links. Only runs when homepage is known
//                         (either pre-existing or just discovered).
//   3. hf_users         — (a) parse huggingface.co/<handle> from S2
//                         homepage, (b) regex paper text (title +
//                         abstract), (c) scrape person.homepage HTML.
//   4. github_users     — (a) detect <user>.github.io homepages,
//                         (b) regex paper text, (c) scrape homepage.
//
// We deliberately do NOT do HF-by-name search — bench-inverted-lookup
// showed 9% recall with 88% surname-collision false positives.
//
// Each extractor catches its own errors and returns null / [] — one
// slow API or broken scrape never blocks the others (Promise.allSettled).

import { supabase } from "@/lib/db";
import { lookupAuthorWithHomepage } from "@/lib/semantic-scholar";

// ──────────────────────────────────────────────────────────────────
// GitHub-by-email probe
// ──────────────────────────────────────────────────────────────────
// Bench result (scripts/bench-inverted-lookup.mjs, 14% recall, 100%
// precision-by-definition): given an author's email, GitHub's
// /search/commits?q=author-email:<e> returns the github user who
// signed commits with that email — and that user IS the author
// (you can't fake a commit signature without owning the email).
//
// Requires GITHUB_TOKEN. Cap at 30 req/min (we run 1/sec max).
// Errored / unauthenticated calls return null silently — non-fatal.

let nextGhAllowed = 0;

async function probeGitHubByEmail(email: string): Promise<string | null> {
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!tok) return null;
  if (!email || !email.includes("@")) return null;
  const now = Date.now();
  if (now < nextGhAllowed) await new Promise((r) => setTimeout(r, nextGhAllowed - now));
  nextGhAllowed = Date.now() + 2_100;
  try {
    const res = await fetch(
      `https://api.github.com/search/commits?q=author-email:${encodeURIComponent(email)}&per_page=1`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: "application/vnd.github.cloak-preview+json",
          Authorization: `Bearer ${tok}`,
          "User-Agent": "qiji-pipeline/1.0",
        },
      },
    );
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
      if (reset) nextGhAllowed = Math.max(Date.now() + 2_000, reset * 1_000 + 1_000);
      return null;
    }
    if (!res.ok) return null;
    const j = (await res.json()) as { items?: Array<{ author?: { login?: string } }> };
    const login = j.items?.[0]?.author?.login;
    return typeof login === "string" && login.length > 0 ? login : null;
  } catch {
    return null;
  }
}

export interface EnrichmentResult {
  person_id: string;
  signals_written: number;
  per_signal: Record<"homepage" | "twitter" | "hf" | "github", "added" | "kept" | "missed" | "errored">;
  error?: string;
}

interface PersonRow {
  id: string;
  emails: string[] | null;
  arxiv_author_names: string[] | null;
  real_name: string | null;
  hf_users: string[] | null;
  github_users: string[] | null;
  homepage: string | null;
  twitter_handle: string | null;
  affiliation: string | null;
}

interface Hint {
  title?: string;
  abstract?: string;
  author_name?: string;
}

// Filter-out lists for the regex parsers. Many huggingface.co / github.com
// URLs appear in paper text as references to upstream models or popular
// repos rather than the author's own handle. Drop the obvious ones.
const HF_HANDLE_BLACKLIST = new Set([
  "v1", "datasets", "spaces", "models", "papers", "blog", "docs", "api",
  "pricing", "settings", "login", "join", "search", "new",
]);
// GitHub's own UI routes — these show up when we scrape a github.com
// profile page and regex out hrefs. They are NOT user handles. Keep
// this list comprehensive — the failure mode is "github_users[] gets
// polluted with marketing-page slugs" (caught in backfill 2026-05-16).
const GH_HANDLE_BLACKLIST = new Set([
  "search", "topics", "trending", "marketplace", "explore", "settings",
  "features", "pricing", "enterprise", "login", "signup", "join", "new",
  "about", "contact", "security", "site", "github", "_private",
  "get-started", "mcp", "why-github", "team", "solutions", "resources",
  "customer-stories", "orgs", "trust-center", "partners", "sponsors",
  "accelerator", "collections", "premium-support", "search-github",
  "site-policy", "site-map", "site-help", "site-status", "site-terms",
  "site-privacy", "site-policies", "site-contact", "site-about",
  "site-jobs", "site-blog", "site-press", "site-shop", "site-store",
  "site-developer", "site-developers", "site-investors", "site-careers",
  "logout", "watching", "notifications", "issues", "pulls", "discussions",
  "codespaces", "organizations", "stars", "gists", "dashboard",
  "your-organizations", "your-repositories", "your-profile",
  "your-stars", "your-gists", "your-projects", "your-followers",
  "your-following", "your-codespaces", "your-issues", "your-pulls",
  "your-discussions", "your-sponsors", "advanced-search",
  "edu", "education", "students", "teachers", "campus-experts",
  "campus-program", "campus-events", "campus-community", "actions",
  "packages", "sponsors", "readme", "copilot", "models",
  "open-source", "fluent-emoji", "github-copilot", "github-actions",
  "github-pages", "github-packages", "github-codespaces",
  "github-mobile", "github-cli", "github-desktop",
  "remote-development", "language", "blog", "newsroom",
  "social-impact", "diversity", "social", "events", "shop", "store",
]);
const TWITTER_HANDLE_BLACKLIST = new Set([
  "share", "intent", "search", "home", "i", "settings", "login",
  "explore", "notifications", "messages", "compose",
]);

export async function enrichPerson(opts: {
  person_id: string;
  /** Optional hints — title/abstract/author_name when called from a
   *  fresh import. If absent, we fetch them from a linked pipeline_leads
   *  row. */
  hint?: Hint;
}): Promise<EnrichmentResult> {
  // 1. Load current person row.
  const { data: person, error: personErr } = await supabase
    .from("persons")
    .select("id, emails, arxiv_author_names, real_name, hf_users, github_users, homepage, twitter_handle, affiliation")
    .eq("id", opts.person_id)
    .maybeSingle();
  if (personErr || !person) {
    return {
      person_id: opts.person_id,
      signals_written: 0,
      per_signal: { homepage: "errored", twitter: "errored", hf: "errored", github: "errored" },
      error: personErr?.message ?? "person not found",
    };
  }
  const p = person as PersonRow;

  // 2. Determine hint context. If caller didn't pass one, try to look
  //    up a recent pipeline_leads row attached to this person.
  let hint = opts.hint;
  if (!hint) {
    const { data: lead } = await supabase
      .from("pipeline_leads")
      .select("title, abstract, author_name")
      .eq("person_id", opts.person_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lead) {
      hint = {
        title: (lead.title as string) || undefined,
        abstract: (lead.abstract as string) || undefined,
        author_name: (lead.author_name as string) || undefined,
      };
    }
  }
  const authorName =
    hint?.author_name ??
    p.real_name ??
    (p.arxiv_author_names && p.arxiv_author_names[0]) ??
    null;

  // 3. Fetch S2 (homepage) ONCE, reuse across signals. In practice
  //    S2's homepage field is almost always null (verified 2026-05-16
  //    against famous + obscure authors) so we treat this as a
  //    best-effort wash and rely on the other sources below.
  let s2Homepage: string | null = null;
  let s2Errored = false;
  if (authorName) {
    try {
      const s2 = await lookupAuthorWithHomepage(hint?.title ?? "", authorName);
      s2Homepage = s2?.homepage ?? null;
    } catch {
      s2Errored = true;
    }
  }

  // 4. GitHub-by-email probe. This single call gives us BOTH a github
  //    handle (high precision) AND a candidate homepage
  //    (https://github.com/<handle>). Skips if GITHUB_TOKEN not set.
  let ghFromEmail: string | null = null;
  const primaryEmail = p.emails && p.emails[0];
  if (primaryEmail && (!p.github_users || p.github_users.length === 0)) {
    ghFromEmail = await probeGitHubByEmail(primaryEmail);
  }

  // 5. Parse abstract for explicit "Project page / Project website"
  //    URLs. Many ML papers include these in the abstract footer.
  const projectPageUrl = extractProjectPageUrl(hint?.abstract ?? "");

  // 6. Resolve effective homepage — pre-existing OR S2 OR project page
  //    OR github profile (lowest-priority fallback so a researcher's
  //    actual lab page wins over their github).
  const effectiveHomepage =
    p.homepage ||
    s2Homepage ||
    projectPageUrl ||
    (ghFromEmail ? `https://github.com/${ghFromEmail}` : null);

  // 7. Scrape the effective homepage HTML ONCE (saves 2x duplicate
  //    fetches when we want hf + twitter + github off the same page).
  let homepageHtml: string | null = null;
  if (effectiveHomepage) {
    try {
      const res = await fetch(effectiveHomepage, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        // Truncate to 500KB — researcher home pages are tiny, anything
        // bigger is probably a CMS dashboard we don't want.
        const text = await res.text();
        homepageHtml = text.slice(0, 500_000);
      }
    } catch {
      // network failure / timeout / Cloudflare block — skip, that
      // signal just stays missed.
    }
  }

  // 8. Run extractors in parallel for clarity (they're all sync after
  //    the I/O above, but Promise.allSettled keeps the shape uniform
  //    with future async extractors).
  const [homepageR, twitterR, hfR, githubR] = await Promise.allSettled([
    extractHomepage(p, s2Homepage, projectPageUrl, ghFromEmail),
    extractTwitter(p, homepageHtml),
    extractHf(p, s2Homepage, hint, homepageHtml),
    extractGithub(p, effectiveHomepage, hint, homepageHtml, ghFromEmail),
  ]);

  // 7. Build delta + per-signal report.
  const delta: Record<string, unknown> = {};
  const per_signal: EnrichmentResult["per_signal"] = {
    homepage: signalStatusScalar(p.homepage, homepageR, s2Errored),
    twitter: signalStatusScalar(p.twitter_handle, twitterR, false),
    hf: signalStatusArr(p.hf_users, hfR),
    github: signalStatusArr(p.github_users, githubR),
  };

  if (per_signal.homepage === "added") {
    delta.homepage = (homepageR as PromiseFulfilledResult<string>).value;
  }
  if (per_signal.twitter === "added") {
    delta.twitter_handle = (twitterR as PromiseFulfilledResult<string>).value;
  }
  if (per_signal.hf === "added") {
    const newHf = (hfR as PromiseFulfilledResult<string[]>).value;
    delta.hf_users = Array.from(new Set([...(p.hf_users ?? []), ...newHf]));
  }
  if (per_signal.github === "added") {
    const newGh = (githubR as PromiseFulfilledResult<string[]>).value;
    delta.github_users = Array.from(new Set([...(p.github_users ?? []), ...newGh]));
  }

  const signalsWritten = Object.values(per_signal).filter((s) => s === "added").length;
  if (signalsWritten > 0) {
    delta.updated_at = new Date().toISOString();
    const { error: updErr } = await supabase.from("persons").update(delta).eq("id", opts.person_id);
    if (updErr) {
      return {
        person_id: opts.person_id,
        signals_written: 0,
        per_signal,
        error: `update failed: ${updErr.message}`,
      };
    }
  }
  return { person_id: opts.person_id, signals_written: signalsWritten, per_signal };
}

// ── per-signal extractors ──────────────────────────────────────────

async function extractHomepage(
  p: PersonRow,
  s2Homepage: string | null,
  projectPageUrl: string | null,
  ghFromEmail: string | null,
): Promise<string | null> {
  if (p.homepage) return null; // caller-side "kept" path
  // Priority: S2 (lab page) > paper project page > github profile.
  if (s2Homepage && /^https?:\/\//i.test(s2Homepage)) return s2Homepage;
  if (projectPageUrl) return projectPageUrl;
  if (ghFromEmail) return `https://github.com/${ghFromEmail}`;
  return null;
}

/** Find a "Project page: https://..." or "Project website: ..." URL
 *  in paper abstract text. Many ML papers include these as a footer. */
function extractProjectPageUrl(abstract: string): string | null {
  if (!abstract) return null;
  // Look for explicit "project page" / "project website" / "code is
  // available at" cues followed by a URL.
  const cuePattern =
    /(?:project\s*(?:page|website|site)|code\s*(?:is\s*)?available\s*at|website|homepage)\s*[:\-]?\s*(https?:\/\/[^\s)<>"']+)/i;
  const m = abstract.match(cuePattern);
  if (m) return cleanUrl(m[1]);
  return null;
}

function cleanUrl(url: string): string {
  // Strip trailing punctuation that often follows URLs in abstracts.
  return url.replace(/[.,;)\]>]+$/, "");
}

async function extractTwitter(p: PersonRow, homepageHtml: string | null): Promise<string | null> {
  if (p.twitter_handle) return null;
  if (!homepageHtml) return null;
  // Match twitter.com/<handle> or x.com/<handle>. Handles are 1-15 chars
  // of [A-Za-z0-9_], possibly with a leading @ which we strip.
  const m = homepageHtml.match(/(?:twitter\.com|x\.com)\/(@?[A-Za-z0-9_]{1,15})(?!\w)/i);
  if (!m) return null;
  const raw = m[1].replace(/^@/, "");
  if (TWITTER_HANDLE_BLACKLIST.has(raw.toLowerCase())) return null;
  return raw;
}

async function extractHf(
  p: PersonRow,
  s2Homepage: string | null,
  hint: Hint | undefined,
  homepageHtml: string | null,
): Promise<string[]> {
  const existing = new Set(p.hf_users ?? []);
  const found = new Set<string>();

  // Source 1: S2 homepage looks like a HF profile.
  if (s2Homepage) {
    const m = s2Homepage.match(/huggingface\.co\/([\w-]+)(?:\/|$|\?|#)/i);
    if (m) {
      const h = m[1];
      if (!HF_HANDLE_BLACKLIST.has(h.toLowerCase())) found.add(h);
    }
  }

  // Source 2: paper text (title + abstract).
  const text = `${hint?.title ?? ""} ${hint?.abstract ?? ""}`;
  if (text.trim().length > 0) {
    const matches = text.matchAll(/huggingface\.co\/([\w-]+)(?:\/|\s|\)|\.|$)/gi);
    for (const m of matches) {
      const h = m[1];
      if (!HF_HANDLE_BLACKLIST.has(h.toLowerCase())) found.add(h);
    }
  }

  // Source 3: homepage HTML.
  if (homepageHtml) {
    const matches = homepageHtml.matchAll(/huggingface\.co\/([\w-]+)(?:\/|"|'|\s|\)|<|$)/gi);
    for (const m of matches) {
      const h = m[1];
      if (!HF_HANDLE_BLACKLIST.has(h.toLowerCase())) found.add(h);
    }
  }

  return [...found].filter((h) => !existing.has(h));
}

async function extractGithub(
  p: PersonRow,
  effectiveHomepage: string | null,
  hint: Hint | undefined,
  homepageHtml: string | null,
  ghFromEmail: string | null,
): Promise<string[]> {
  const existing = new Set(p.github_users ?? []);
  const found = new Set<string>();

  // Source 0 (highest precision): GitHub commit-author email match.
  // Verified by GitHub itself — only the email owner can sign commits.
  if (ghFromEmail) found.add(ghFromEmail);

  // Source 1: homepage on github.io is unambiguous — the subdomain IS
  // the username.
  if (effectiveHomepage) {
    const m = effectiveHomepage.match(/(?:^|\/\/)([\w-]+)\.github\.io/i);
    if (m && !GH_HANDLE_BLACKLIST.has(m[1].toLowerCase())) {
      found.add(m[1]);
    }
  }

  // Source 2: paper text. github.com/<user>(/<repo>) — we want the
  // <user> half. Many false positives (referenced repos) but the
  // dedup gate on persons.github_users[] cleans up day-2 if needed.
  const text = `${hint?.title ?? ""} ${hint?.abstract ?? ""}`;
  if (text.trim().length > 0) {
    const matches = text.matchAll(/github\.com\/([\w-]+)(?:\/|\s|\)|\.|$)/gi);
    for (const m of matches) {
      const h = m[1];
      if (!GH_HANDLE_BLACKLIST.has(h.toLowerCase())) found.add(h);
    }
  }

  // Source 3: homepage HTML.
  if (homepageHtml) {
    const matches = homepageHtml.matchAll(/github\.com\/([\w-]+)(?:\/|"|'|\s|\)|<|$)/gi);
    for (const m of matches) {
      const h = m[1];
      if (!GH_HANDLE_BLACKLIST.has(h.toLowerCase())) found.add(h);
    }
  }

  return [...found].filter((h) => !existing.has(h));
}

// ── status helpers ─────────────────────────────────────────────────

function signalStatusScalar(
  existing: string | null,
  result: PromiseSettledResult<string | null>,
  upstreamErrored: boolean,
): "added" | "kept" | "missed" | "errored" {
  if (existing) return "kept";
  if (result.status === "rejected") return "errored";
  if (result.value) return "added";
  return upstreamErrored ? "errored" : "missed";
}

function signalStatusArr(
  existing: string[] | null,
  result: PromiseSettledResult<string[]>,
): "added" | "kept" | "missed" | "errored" {
  if (result.status === "rejected") return "errored";
  const hadAny = existing && existing.length > 0;
  const found = result.value;
  if (found.length > 0) return "added";
  if (hadAny) return "kept";
  return "missed";
}
