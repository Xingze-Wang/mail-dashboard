// ontology.ts — minimum-viable ontology for Qiji Pipeline.
//
// Not a query layer. Not a runtime abstraction. Just a NAMED REGISTRY
// of the entities, relationships, and actions that humans and the bot
// reason about.
//
// Why this exists:
// - When admin says "yujie's strong leads", we want a shared vocabulary
//   for entity (Lead), property (Lead.tier), relationship (Lead.owner→Rep).
// - When the bot wants to compose a multi-step plan, it needs to know
//   what entities CAN be acted upon and what actions are available.
// - When a new dev opens the codebase, they want ONE FILE that says
//   "here are the nouns and verbs of this app" instead of inferring
//   from 50 tables and 80 routes.
//
// Inspiration: Palantir ontology, but stripped down. We're 5 reps with
// 8 entities, not 5000 users with 800 entities. The win is *naming*,
// not abstracting.
//
// This file is the source of truth. The bot reads it via the
// describe_ontology tool. Future dashboards / generated forms /
// permission systems can read it too.

export type EntityKey =
  | "rep"
  | "lead"
  | "email"
  | "conversion"
  | "mission"
  | "template"
  | "learning"
  | "task"
  | "document";

export interface EntityProperty {
  name: string;
  type: "string" | "number" | "boolean" | "uuid" | "enum" | "date" | "json" | "ref";
  enum_values?: string[];
  ref?: EntityKey;                  // for "ref" type — points to another entity
  description: string;
  // Where this property lives. Usually `table.column`, sometimes
  // composed (e.g. trust_level is derived).
  source: string;
}

export interface EntityRelationship {
  name: string;
  target: EntityKey;
  // "owns" = parent-child (Rep owns Leads), "actor" = who DID an
  // action on an entity, "scoped_by" = filtered/contextual.
  kind: "owns" | "actor" | "scoped_by" | "joined" | "produced_by";
  // The column or join that links them.
  via: string;
  description: string;
}

export interface EntityAction {
  name: string;
  description: string;
  // Which tool / API route implements this action.
  implementation: string;
  // Effect class — for trust / approval gating.
  effect: "read" | "soft_write" | "hard_write" | "send_external";
  // Does it require admin approval?
  needs_approval: "never" | "if_destructive" | "always";
  // Short note explaining the approval choice (optional).
  approval_note?: string;
}

export interface OntologyEntity {
  key: EntityKey;
  // Human-readable name (singular, English + Chinese).
  name_en: string;
  name_zh: string;
  // What this entity IS, in 1-2 sentences.
  description: string;
  // The primary table where instances live.
  primary_table: string;
  // Properties humans actually reason about. NOT every column.
  // The bot uses these to construct queries / answer "what fields does
  // a Lead have?" — keep it to the ones that matter.
  key_properties: EntityProperty[];
  // Relationships to other entities.
  relationships: EntityRelationship[];
  // Actions that can be taken on this entity.
  actions: EntityAction[];
  // Vestigial / supporting tables that store events/facts about
  // this entity but aren't the primary table. Listed so devs know
  // where related data lives.
  supporting_tables?: string[];
}

// ─── REGISTRY ──────────────────────────────────────────────────────

export const ONTOLOGY: OntologyEntity[] = [
  {
    key: "rep",
    name_en: "Sales Rep",
    name_zh: "销售代表",
    description:
      "A human salesperson on the team. Owns leads, sends emails, marks WeChat conversions. Has a role (admin / senior / sales) and a trust_level that gates how many sends per day, whether bulk-send is allowed, etc.",
    primary_table: "sales_reps",
    key_properties: [
      { name: "id", type: "number", source: "sales_reps.id", description: "Primary key. Used everywhere as actor / owner reference." },
      { name: "name", type: "string", source: "sales_reps.name", description: "Display name (e.g. 'Yujie', 'Leo')." },
      { name: "email", type: "string", source: "sales_reps.email", description: "Login + Resend From-address." },
      { name: "role", type: "enum", enum_values: ["admin", "senior", "sales"], source: "sales_reps.role", description: "Permission tier. Admin sees /admin/* surfaces; sales/senior see only their own data." },
      { name: "trust_level", type: "enum", enum_values: ["novice", "training", "intermediate", "mature", "admin"], source: "sales_reps.trust_level", description: "Determines daily send cap, bulk-send eligibility, lead-cap. Auto-upgrades by send count." },
      { name: "lark_open_id", type: "string", source: "sales_reps.lark_open_id", description: "Lark user_id for DMs from Leon. NULL = rep hasn't bound Lark yet." },
      { name: "active", type: "boolean", source: "sales_reps.active", description: "Soft-delete flag. Inactive reps still in DB but excluded from assignment / missions / overview." },
    ],
    relationships: [
      { name: "owned_leads", target: "lead", kind: "owns", via: "pipeline_leads.assigned_rep_id", description: "Leads routed to this rep at discovery time." },
      { name: "sent_emails", target: "email", kind: "actor", via: "emails.actor_rep_id", description: "Emails this rep clicked Send on. NOT the same as 'lead's owner sent it' — actor is who PRESSED the button." },
      { name: "credited_conversions", target: "conversion", kind: "actor", via: "brief_lookups.marked_by_rep_id", description: "WeChat conversions this rep recorded. Closer-takes-credit — not lead owner." },
      { name: "missions", target: "mission", kind: "owns", via: "missions.rep_id", description: "Per-rep daily action checklist." },
    ],
    actions: [
      { name: "change_role", description: "Flip role between sales / senior / admin.", implementation: "propose_db_write (UPDATE sales_reps SET role)", effect: "hard_write", needs_approval: "always" },
      { name: "bump_trust", description: "Manually raise trust_level (e.g. 'Yujie has earned mature').", implementation: "propose_db_write (UPDATE sales_reps SET trust_level)", effect: "hard_write", needs_approval: "always" },
      { name: "deactivate", description: "Soft-delete a rep — they stop receiving leads.", implementation: "propose_db_write (UPDATE sales_reps SET active=false)", effect: "hard_write", needs_approval: "always" },
      { name: "list_all", description: "List all reps with role + trust.", implementation: "list_reps tool", effect: "read", needs_approval: "never" },
      { name: "get_overview", description: "Get the team-overview card for one rep (KPIs, today's brief, health).", implementation: "GET /api/admin/team-overview/<rep_id>", effect: "read", needs_approval: "never" },
    ],
    supporting_tables: ["rep_daily_quotas", "rep_daily_quotas_override", "rep_questions", "daily_rep_brief", "helper_rep_state"],
  },

  {
    key: "lead",
    name_en: "Lead",
    name_zh: "线索",
    description:
      "A researcher we want to email about Qiji's GPU grant. Discovered from arXiv papers (primary) or Discovery sources (HF / GitHub / ProductHunt). Has a tier (strong / normal) and an owner (a Rep). Sales reps act on Lead entities all day.",
    primary_table: "pipeline_leads",
    key_properties: [
      { name: "id", type: "uuid", source: "pipeline_leads.id", description: "Primary key." },
      { name: "author_name", type: "string", source: "pipeline_leads.author_name", description: "Researcher's name from the arXiv paper." },
      { name: "author_email", type: "string", source: "pipeline_leads.author_email", description: "Where outreach will be sent." },
      { name: "lead_tier", type: "enum", enum_values: ["strong", "normal"], source: "pipeline_leads.lead_tier", description: "Routing class. Strong = citations >2000 OR school_tier ∈ {1,2}." },
      { name: "school_tier", type: "enum", enum_values: ["1", "2", "3", "null"], source: "pipeline_leads.school_tier", description: "1=top global, 2=top Chinese/international, 3=other verified. NULL=unmatched." },
      { name: "h_index", type: "number", source: "pipeline_leads.h_index", description: "Semantic Scholar h-index. Best-effort — may be NULL." },
      { name: "status", type: "enum", enum_values: ["pending", "ready", "ripening", "sent", "skipped", "flagged"], source: "pipeline_leads.status", description: "Lifecycle. 'ready' = sendable. 'ripening' = paper <7d old, send requires override." },
      { name: "assigned_rep_id", type: "ref", ref: "rep", source: "pipeline_leads.assigned_rep_id", description: "OWNER — who got routed this lead. Different from actor on send." },
      { name: "draft_html", type: "string", source: "pipeline_leads.draft_html", description: "Pre-rendered baseline email draft. Final render happens at send time via template-assembler." },
      { name: "paper_title", type: "string", source: "pipeline_leads.paper_title", description: "Source paper headline." },
      { name: "geo", type: "enum", enum_values: ["cn", "edu", "overseas"], source: "derived from author_email domain", description: "Geographic bucket for routing/analytics. Computed not stored." },
    ],
    relationships: [
      { name: "owner", target: "rep", kind: "owns", via: "pipeline_leads.assigned_rep_id", description: "Inverse of Rep.owned_leads." },
      { name: "emails_sent", target: "email", kind: "produced_by", via: "emails.lead_id", description: "Emails generated from this lead (usually 1, sometimes follow-ups)." },
      { name: "conversion", target: "conversion", kind: "produced_by", via: "brief_lookups.lead_id", description: "0 or 1 WeChat conversion event per lead." },
    ],
    actions: [
      { name: "list", description: "Browse / search the lead pool. Filterable by tier, geo, status, owner.", implementation: "list_leads tool", effect: "read", needs_approval: "never" },
      { name: "get", description: "Get one lead's full state including current draft.", implementation: "get_lead tool", effect: "read", needs_approval: "never" },
      { name: "count", description: "Aggregate counts only (cheaper than list for 'how many').", implementation: "get_lead_counts tool", effect: "read", needs_approval: "never" },
      { name: "reassign", description: "Move ownership from one rep to another.", implementation: "reassign_lead tool", effect: "hard_write", needs_approval: "if_destructive" },
      { name: "skip", description: "Mark as skipped (rep decided not to send).", implementation: "skip_lead tool", effect: "soft_write", needs_approval: "never" },
      { name: "redraft", description: "Regenerate the draft with current template + overrides.", implementation: "redraft_lead tool", effect: "soft_write", needs_approval: "never" },
      { name: "send_email", description: "Actually send the lead's draft as an email.", implementation: "send_lead_email tool / POST /api/pipeline/send", effect: "send_external", needs_approval: "never", approval_note: "rep decides per-send" },
      { name: "batch_send", description: "Send N leads in one call (bulk).", implementation: "batch_send tool", effect: "send_external", needs_approval: "always", approval_note: "interactive confirm" },
    ],
    supporting_tables: ["discovery_leads", "persons", "contact_claims", "allocation_log"],
  },

  {
    key: "email",
    name_en: "Email",
    name_zh: "邮件",
    description:
      "An outbound email we sent or an inbound reply. Outbound emails are produced by the Lead → Send flow. Lifecycle status is updated via Resend webhooks. Append-only ground truth lives in webhook_events; emails.status is 'latest event wins'.",
    primary_table: "emails",
    key_properties: [
      { name: "id", type: "string", source: "emails.id", description: "Resend message id when outbound; internal id when inbound." },
      { name: "lead_id", type: "ref", ref: "lead", source: "emails.lead_id", description: "Lead this email belongs to. NULL for org-wide / non-pipeline mail." },
      { name: "actor_rep_id", type: "ref", ref: "rep", source: "emails.actor_rep_id", description: "WHO PRESSED SEND. Not necessarily the lead owner — closer-takes-credit." },
      { name: "status", type: "enum", enum_values: ["queued", "sent", "delivered", "opened", "clicked", "replied", "bounced", "complained"], source: "emails.status", description: "Latest event wins — LOSSY. For audit, query webhook_events." },
      { name: "recipient", type: "string", source: "emails.recipient", description: "To: address." },
      { name: "subject", type: "string", source: "emails.subject", description: "Subject line." },
      { name: "template_id", type: "ref", ref: "template", source: "emails.template_id", description: "Template stamped at send time. Enables per-template performance analytics." },
      { name: "created_at", type: "date", source: "emails.created_at", description: "When the email was sent (outbound) or received (inbound)." },
    ],
    relationships: [
      { name: "lead", target: "lead", kind: "scoped_by", via: "emails.lead_id", description: "Lead this email is for." },
      { name: "actor", target: "rep", kind: "actor", via: "emails.actor_rep_id", description: "Who sent it." },
      { name: "template_used", target: "template", kind: "scoped_by", via: "emails.template_id", description: "Template at send time." },
    ],
    actions: [
      // Email entity is mostly READ. The "send" action lives on Lead, not Email.
      { name: "list_recent_sends", description: "Pull recent outbound emails for a rep.", implementation: "GET /api/admin/team-overview/<rep_id> (recent_emails section)", effect: "read", needs_approval: "never" },
      { name: "list_replies", description: "Pull inbound replies for a rep.", implementation: "get_recent_inbound tool", effect: "read", needs_approval: "never" },
    ],
    supporting_tables: ["webhook_events", "email_contact_history", "outbound_send_log", "email_template_overrides_history"],
  },

  {
    key: "conversion",
    name_en: "WeChat Conversion",
    name_zh: "微信转化",
    description:
      "A successful WeChat add. The PRODUCT'S CORE SUCCESS METRIC. Created when a rep clicks '+Added on WeChat' on the /brief page. Attribution: marked_by_rep_id gets the credit (the closer), not the lead owner.",
    primary_table: "brief_lookups",
    key_properties: [
      { name: "id", type: "uuid", source: "brief_lookups.id", description: "Primary key." },
      { name: "lead_id", type: "ref", ref: "lead", source: "brief_lookups.lead_id", description: "Which lead converted." },
      { name: "marked_by_rep_id", type: "ref", ref: "rep", source: "brief_lookups.marked_by_rep_id", description: "WHO RECORDED THE CONVERSION = who gets credit. Not the lead owner." },
      { name: "added_wechat", type: "boolean", source: "brief_lookups.added_wechat", description: "True for actual conversion. False rows exist (rep searched a lead, didn't add). Filter to true for 'real' conversions." },
      { name: "wechat_at", type: "date", source: "brief_lookups.wechat_at", description: "When the rep marked it." },
      { name: "notes", type: "string", source: "brief_lookups.notes", description: "Optional rep note (context for follow-up)." },
    ],
    relationships: [
      { name: "lead", target: "lead", kind: "scoped_by", via: "brief_lookups.lead_id", description: "Lead that converted." },
      { name: "credited_rep", target: "rep", kind: "actor", via: "brief_lookups.marked_by_rep_id", description: "Rep who closed (gets credit)." },
    ],
    actions: [
      { name: "mark", description: "Mark a lead as WeChat-added. Creates the conversion event.", implementation: "mark_wechat_added tool / POST /api/brief/wechat-add", effect: "hard_write", needs_approval: "never", approval_note: "rep decides" },
      { name: "list_recent", description: "List recent conversions, optionally by rep.", implementation: "(via /brief page UI or get_admin_daily_report)", effect: "read", needs_approval: "never" },
    ],
  },

  {
    key: "mission",
    name_en: "Mission",
    name_zh: "任务",
    description:
      "A per-rep daily action target (e.g. 'send 10 emails today', 'reply to 3 inbound'). Set by congress / heuristic-seed cron at 23:00 the prior day, completed by the rep through the day. Progress auto-updates as the rep acts on Leads / Emails.",
    primary_table: "missions",
    key_properties: [
      { name: "id", type: "uuid", source: "missions.id", description: "Primary key." },
      { name: "rep_id", type: "ref", ref: "rep", source: "missions.rep_id", description: "Whose mission this is." },
      { name: "due_date", type: "date", source: "missions.due_date", description: "ISO date the mission is FOR (not when created). One day per mission." },
      { name: "kind", type: "enum", enum_values: ["send", "reply", "mark_wechat", "review_proposals", "review_template_edits", "custom"], source: "missions.kind", description: "What kind of action counts toward this mission." },
      { name: "target", type: "number", source: "missions.target", description: "How many of `kind` action are needed to complete." },
      { name: "scope", type: "json", source: "missions.scope", description: "Optional filter, e.g. {segment:'cn', school_tier:1}." },
      { name: "status", type: "enum", enum_values: ["active", "proposed", "completed", "skipped"], source: "missions.status", description: "Lifecycle. 'proposed' is admin-pending; 'active' is live; 'completed' = target met." },
    ],
    relationships: [
      { name: "owner", target: "rep", kind: "owns", via: "missions.rep_id", description: "Whose mission this is." },
    ],
    actions: [
      { name: "list_today", description: "Get today's missions for a rep.", implementation: "v_mission_today view via /api/missions", effect: "read", needs_approval: "never" },
      { name: "create", description: "Author a new mission for a rep.", implementation: "POST /api/admin/missions (admin) or congress weekly cron", effect: "hard_write", needs_approval: "if_destructive", approval_note: "admin-only route enforces" },
    ],
    supporting_tables: ["mission_progress", "v_mission_today (view)", "team_focus", "quarterly_goals", "daily_rep_brief"],
  },

  {
    key: "template",
    name_en: "Email Template",
    name_zh: "邮件模板",
    description:
      "A reusable email body with placeholders. Per-rep variants + global default + segment-conditional overrides (e.g. 'for cn + tier-1 schools use opening X'). Rendered to final HTML at send time, not import time.",
    primary_table: "email_templates",
    key_properties: [
      { name: "id", type: "uuid", source: "email_templates.id", description: "Primary key." },
      { name: "sender_email", type: "string", source: "email_templates.sender_email", description: "Which rep this template belongs to. Match by lookup at send time." },
      { name: "subject_template", type: "string", source: "email_templates.subject_template", description: "Subject with {{placeholders}}." },
      { name: "body_html", type: "string", source: "email_templates.body_html", description: "HTML body with {{placeholders}}." },
      { name: "is_active", type: "boolean", source: "email_templates.is_active", description: "Only active templates are used. Inactive = historical." },
      { name: "created_by_rep_id", type: "ref", ref: "rep", source: "email_templates.created_by_rep_id", description: "Who authored the template." },
    ],
    relationships: [
      { name: "owner_rep", target: "rep", kind: "owns", via: "email_templates.sender_email", description: "Rep this template is for (by sender_email match)." },
      { name: "emails_using", target: "email", kind: "joined", via: "emails.template_id", description: "Emails that used this template." },
    ],
    actions: [
      { name: "list", description: "List all active templates.", implementation: "GET /api/templates", effect: "read", needs_approval: "never" },
      { name: "create", description: "Build a per-rep template from a sample draft.", implementation: "build_rep_template tool / POST /api/admin/templates", effect: "hard_write", needs_approval: "always" },
      { name: "promote_candidate", description: "Promote a template_candidate to active.", implementation: "POST /api/admin/templates/candidates/promote", effect: "hard_write", needs_approval: "always" },
    ],
    supporting_tables: ["template_edits", "template_ratings", "email_ratings", "email_template_overrides_history", "patterns"],
  },

  {
    key: "learning",
    name_en: "Learning",
    name_zh: "经验记忆",
    description:
      "A durable, cross-session fact or rule the bot has captured. Three sub-types: 'skill' (activatable procedure — loaded every session if triggers match), 'tactic'/'self_critique'/'rep_pref' (memories — FTS-ranked retrieval). Created by Leon proactively or by admin promoting an admin_inbox item.",
    primary_table: "helper_learnings",
    key_properties: [
      { name: "id", type: "uuid", source: "helper_learnings.id", description: "Primary key." },
      { name: "kind", type: "enum", enum_values: ["skill", "tactic", "self_critique", "rep_pref", "other"], source: "helper_learnings.kind", description: "skill = activatable procedure. Others are recall-by-relevance memories." },
      { name: "body", type: "string", source: "helper_learnings.body", description: "The actual content. Indexed via tsvector for FTS." },
      { name: "triggers", type: "json", source: "helper_learnings.triggers", description: "Array of activation phrases (for skills). Empty = universal skill." },
      { name: "scope_rep_id", type: "ref", ref: "rep", source: "helper_learnings.scope_rep_id", description: "NULL = org-wide. Otherwise scoped to one rep." },
      { name: "confidence", type: "number", source: "helper_learnings.confidence", description: "0.0-1.0. Auto-classifier sets this; admin can override." },
      { name: "superseded_at", type: "date", source: "helper_learnings.superseded_at", description: "Soft-delete. Once set, this learning stops appearing in loads." },
    ],
    relationships: [
      { name: "scope_rep", target: "rep", kind: "scoped_by", via: "helper_learnings.scope_rep_id", description: "If non-NULL, learning only applies to this rep." },
    ],
    actions: [
      { name: "record", description: "Save a new learning. Auto-classifier picks kind + triggers.", implementation: "recordLearning() / suggest_learning tool / admin Yes-clicks", effect: "soft_write", needs_approval: "never" },
      { name: "supersede", description: "Mark a stale learning as no longer active.", implementation: "supersedeLearning()", effect: "soft_write", needs_approval: "if_destructive" },
      { name: "list_active", description: "Load relevant learnings for a query.", implementation: "loadRelevantLearnings() — used on every helper turn", effect: "read", needs_approval: "never" },
    ],
  },

  {
    key: "task",
    name_en: "Guided Task",
    name_zh: "多步任务",
    description:
      "A multi-step plan admin commissioned via /admin/intent. Each step has a risk_level — 'auto' steps run automatically, 'review' steps pause for admin ✓ before executing. Step results accumulate in step_results jsonb[].",
    primary_table: "guided_tasks",
    key_properties: [
      { name: "id", type: "uuid", source: "guided_tasks.id", description: "Primary key." },
      { name: "goal", type: "string", source: "guided_tasks.goal", description: "One-sentence description of the whole task." },
      { name: "steps", type: "json", source: "guided_tasks.steps", description: "Array of {intent, verification?, risk_level}." },
      { name: "step_results", type: "json", source: "guided_tasks.step_results", description: "Parallel array of outcomes — {ok, summary, evidence, ran_at, ack}." },
      { name: "current_step", type: "number", source: "guided_tasks.current_step", description: "0-indexed pointer into steps[]." },
      { name: "status", type: "enum", enum_values: ["planned", "running", "paused", "completed", "aborted", "failed"], source: "guided_tasks.status", description: "Lifecycle. 'paused' = waiting for admin ack on a review step." },
      { name: "awaiting_step_ack", type: "number", source: "guided_tasks.awaiting_step_ack", description: "Step index awaiting admin ✓ click, or NULL." },
    ],
    relationships: [
      { name: "proposed_by", target: "rep", kind: "actor", via: "guided_tasks.proposed_by_rep_id", description: "Who initiated (usually admin)." },
    ],
    actions: [
      { name: "propose", description: "Admin commissions a new task with a plan.", implementation: "start_guided_task tool / POST /api/admin/plan-intent", effect: "soft_write", needs_approval: "always", approval_note: "Yes/No on plan card" },
      { name: "record_step", description: "Bot records what a step did, triggers pause-or-continue.", implementation: "record_step_result tool", effect: "soft_write", needs_approval: "never" },
      { name: "ack", description: "Admin approves a paused step, or aborts the task.", implementation: "ack_guided_step tool / POST /api/admin/tasks/<id>/ack", effect: "soft_write", needs_approval: "never", approval_note: "admin IS the gate" },
      { name: "add_note", description: "Admin attaches correction notes between steps.", implementation: "POST /api/admin/tasks/<id>/note", effect: "soft_write", needs_approval: "never" },
    ],
  },

  {
    key: "document",
    name_en: "Lark Document",
    name_zh: "飞书文档",
    description:
      "A rich Lark/Feishu doc Leon authored. Block-aware (h1-h4, paragraph, bullet, callout, code, etc). Edits go through propose-approve loop: Leon proposes edits as a doc_edit_proposal, admin approves, edits land.",
    primary_table: "doc_edit_proposals",  // proposals queue — actual docs live in Lark
    key_properties: [
      { name: "id", type: "uuid", source: "doc_edit_proposals.id", description: "Primary key for the proposal (not the doc itself)." },
      { name: "document_id", type: "string", source: "doc_edit_proposals.document_id", description: "Lark doc id (token at /docx/{id})." },
      { name: "document_url", type: "string", source: "doc_edit_proposals.document_url", description: "Full https://...feishu.cn/docx/<id> URL." },
      { name: "summary", type: "string", source: "doc_edit_proposals.summary", description: "Admin-facing description of the edit." },
      { name: "edits", type: "json", source: "doc_edit_proposals.edits", description: "Array of {action: update|delete|insert_at|append, ...}." },
      { name: "status", type: "enum", enum_values: ["pending", "approved", "rejected", "dismissed", "applied"], source: "doc_edit_proposals.status", description: "Lifecycle. 'applied' = edits landed in Lark." },
    ],
    relationships: [
      { name: "proposed_by", target: "rep", kind: "actor", via: "doc_edit_proposals.proposed_by_rep_id", description: "Who initiated (usually Leon on admin's behalf)." },
    ],
    actions: [
      { name: "create_doc", description: "Create a new Lark doc.", implementation: "create_rich_lark_doc tool", effect: "soft_write", needs_approval: "never", approval_note: "admin initiated via chat" },
      { name: "propose_edit", description: "Queue structured edits awaiting admin approval.", implementation: "propose_doc_edit tool", effect: "soft_write", needs_approval: "always" },
      { name: "approve_edit", description: "Approve + apply a pending proposal.", implementation: "approve_doc_edit tool", effect: "hard_write", needs_approval: "never", approval_note: "this IS the approval action" },
    ],
  },
];

// ─── HELPERS ───────────────────────────────────────────────────────

/** Get an entity by key. */
export function getEntity(key: EntityKey): OntologyEntity | undefined {
  return ONTOLOGY.find((e) => e.key === key);
}

/** Find the entity (if any) whose primary_table OR supporting_tables includes `table`. */
export function entityForTable(table: string): OntologyEntity | undefined {
  return ONTOLOGY.find(
    (e) => e.primary_table === table || (e.supporting_tables ?? []).includes(table),
  );
}

/** List all entity keys + display names for a quick overview. */
export function listEntities(): Array<{ key: EntityKey; name_en: string; name_zh: string; description: string }> {
  return ONTOLOGY.map((e) => ({
    key: e.key,
    name_en: e.name_en,
    name_zh: e.name_zh,
    description: e.description,
  }));
}

/** Find all relationships pointing AT a target entity (inverse traversal). */
export function relationshipsTargeting(target: EntityKey): Array<{ from: EntityKey; rel: EntityRelationship }> {
  const out: Array<{ from: EntityKey; rel: EntityRelationship }> = [];
  for (const e of ONTOLOGY) {
    for (const r of e.relationships) {
      if (r.target === target) out.push({ from: e.key, rel: r });
    }
  }
  return out;
}
