// Row → wire mappers.
//
// DB columns are snake_case (pipeline_leads.author_email). API responses
// are camelCase (authorEmail). Every route today hand-rolls this
// translation, which causes two categories of bug:
//
//   1. Drift: route A exposes `author_email`, route B exposes `authorEmail`,
//      frontend has to know which one it's calling.
//   2. New columns: add a column to pipeline_leads, forget to add it to the
//      translation in one of the 10 places that map the row, and the
//      frontend silently has `undefined` for that field.
//
// These helpers exist so NEW code has a one-liner mapping to reach for.
// Existing routes are left alone — rewriting them all in one pass risks
// renaming fields the frontend depends on in non-obvious ways.

/** Row shape for pipeline_leads — keep in sync with the live table. */
export interface PipelineLeadRow {
  id: string;
  arxiv_id: string | null;
  title: string | null;
  abstract: string | null;
  authors: string | null;
  pdf_url: string | null;
  published_at: string | null;
  author_name: string | null;
  author_email: string | null;
  first_name: string | null;
  school_name: string | null;
  school_tier: number | null;
  compute_level: string | null;
  compute_confidence: number | null;
  compute_reason: string | null;
  matched_directions: string | string[] | null;
  draft_subject: string | null;
  draft_html: string | null;
  draft_original_subject?: string | null;
  draft_original_html?: string | null;
  draft_edit_distance?: number | null;
  draft_model?: string | null;
  status: string;
  s2_author_id: string | null;
  h_index: number | null;
  citation_count: number | null;
  paper_count: number | null;
  local_score: number | null;
  lead_tier: string | null;
  assigned_rep_id: number | null;
  thread_id: string | null;
  sent_at: string | null;
  created_at: string;
  override_used?: boolean | null;
  bounced_at?: string | null;
  complained_at?: string | null;
  industry_orgs?: string[] | null;
  industry_source?: string | null;
  person_id?: string | null;
  source?: string | null;
}

/** Wire shape for pipeline leads sent to the browser. */
export interface PipelineLeadDTO {
  id: string;
  arxivId: string | null;
  title: string | null;
  abstract: string | null;
  authors: string | null;
  pdfUrl: string | null;
  publishedAt: string | null;
  authorName: string | null;
  authorEmail: string | null;
  firstName: string | null;
  schoolName: string | null;
  schoolTier: number | null;
  computeLevel: string | null;
  computeConfidence: number | null;
  computeReason: string | null;
  matchedDirections: string | string[] | null;
  draftSubject: string | null;
  draftHtml: string | null;
  draftOriginalSubject?: string | null;
  draftOriginalHtml?: string | null;
  draftEditDistance?: number | null;
  draftModel?: string | null;
  status: string;
  s2AuthorId: string | null;
  hIndex: number | null;
  citationCount: number | null;
  paperCount: number | null;
  localScore: number | null;
  leadTier: string | null;
  assignedRepId: number | null;
  threadId: string | null;
  sentAt: string | null;
  createdAt: string;
  overrideUsed?: boolean | null;
  bouncedAt?: string | null;
  complainedAt?: string | null;
  industryOrgs?: string[] | null;
  industrySource?: string | null;
  personId?: string | null;
  source?: string | null;
}

export function pipelineLeadRowToDTO(l: PipelineLeadRow): PipelineLeadDTO {
  return {
    id: l.id,
    arxivId: l.arxiv_id,
    title: l.title,
    abstract: l.abstract,
    authors: l.authors,
    pdfUrl: l.pdf_url,
    publishedAt: l.published_at,
    authorName: l.author_name,
    authorEmail: l.author_email,
    firstName: l.first_name,
    schoolName: l.school_name,
    schoolTier: l.school_tier,
    computeLevel: l.compute_level,
    computeConfidence: l.compute_confidence,
    computeReason: l.compute_reason,
    matchedDirections: l.matched_directions,
    draftSubject: l.draft_subject,
    draftHtml: l.draft_html,
    draftOriginalSubject: l.draft_original_subject ?? null,
    draftOriginalHtml: l.draft_original_html ?? null,
    draftEditDistance: l.draft_edit_distance ?? null,
    draftModel: l.draft_model ?? null,
    status: l.status,
    s2AuthorId: l.s2_author_id,
    hIndex: l.h_index,
    citationCount: l.citation_count,
    paperCount: l.paper_count,
    localScore: l.local_score,
    leadTier: l.lead_tier,
    assignedRepId: l.assigned_rep_id,
    threadId: l.thread_id,
    sentAt: l.sent_at,
    createdAt: l.created_at,
    overrideUsed: l.override_used ?? null,
    bouncedAt: l.bounced_at ?? null,
    complainedAt: l.complained_at ?? null,
    industryOrgs: Array.isArray(l.industry_orgs) ? l.industry_orgs : null,
    industrySource: l.industry_source ?? null,
    personId: l.person_id ?? null,
    source: l.source ?? null,
  };
}

/** Row shape for emails. */
export interface EmailRow {
  id: string;
  from: string | null;
  to: string | null;
  cc?: string | null;
  subject: string | null;
  html?: string | null;
  text?: string | null;
  resend_id: string | null;
  status: string;
  thread_id: string | null;
  created_at: string;
  updated_at?: string | null;
  paper_arxiv_id?: string | null;
  rep_id?: number | null;
  actor_rep_id?: number | null;
}

export interface EmailDTO {
  id: string;
  from: string | null;
  to: string | null;
  cc?: string | null;
  subject: string | null;
  html?: string | null;
  text?: string | null;
  resendId: string | null;
  status: string;
  threadId: string | null;
  createdAt: string;
  updatedAt?: string | null;
  paperArxivId?: string | null;
  repId?: number | null;
  actorRepId?: number | null;
}

export function emailRowToDTO(e: EmailRow): EmailDTO {
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    cc: e.cc ?? null,
    subject: e.subject,
    html: e.html ?? null,
    text: e.text ?? null,
    resendId: e.resend_id,
    status: e.status,
    threadId: e.thread_id,
    createdAt: e.created_at,
    updatedAt: e.updated_at ?? null,
    paperArxivId: e.paper_arxiv_id ?? null,
    repId: e.rep_id ?? null,
    actorRepId: e.actor_rep_id ?? null,
  };
}
