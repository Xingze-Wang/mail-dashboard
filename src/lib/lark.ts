// Lark (Feishu) bot client.
//
// What this provides:
//   - verifyEvent: validates the encryption / signature on an inbound event
//   - getTenantAccessToken: caches the short-lived auth token for outbound calls
//   - sendMessage: posts a text message to a chat
//   - extractText: pulls the user-typed text out of Lark's message envelope
//   - resolveRepFromOpenId: maps a Lark open_id to one of our sales_reps rows
//
// Env vars:
//   LARK_APP_ID              — App ID from the Lark Open Platform app
//   LARK_APP_SECRET          — App Secret
//   LARK_VERIFICATION_TOKEN  — only needed if the app uses the legacy v1 webhook
//   LARK_ENCRYPT_KEY         — only needed if Encrypt Key is enabled in the app
//
// We DO NOT validate the optional encrypt_key path here — most teams turn it
// off for v2 events. If you turn it on, add AES-CBC decrypt before parsing.

import { createHash, createHmac } from "node:crypto";
import { supabase } from "@/lib/db";

const LARK_BASE = "https://open.larksuite.com/open-apis"; // global
const LARK_BASE_CN = "https://open.feishu.cn/open-apis"; // cn

function pickBase(): string {
  // Default to global; opt into CN by setting LARK_REGION=cn
  return process.env.LARK_REGION === "cn" ? LARK_BASE_CN : LARK_BASE;
}

// ─── Tenant access token cache ──────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}
let tokenCache: TokenCache | null = null;

export async function getTenantAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  const appId = process.env.LARK_APP_ID;
  const secret = process.env.LARK_APP_SECRET;
  if (!appId || !secret) return null;

  // 3 attempts × exponential backoff × 25s timeout. Lark's auth endpoint
  // is occasionally slow from US networks (we've seen 15s+ timeouts);
  // this stops a single transient hiccup from dropping replies.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${pickBase()}/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: secret }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        lastErr = `http ${res.status}`;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      const j = await res.json();
      if (j.code !== 0) {
        console.error("[lark] tenant_access_token err", j);
        return null;
      }
      tokenCache = { token: j.tenant_access_token, expiresAt: now + (j.expire ?? 7200) * 1000 };
      return tokenCache.token;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  console.error("[lark] tenant_access_token failed after 3 attempts:", lastErr);
  return null;
}

// ─── Event verification ─────────────────────────────────────────────────

/**
 * Lark v2 events arrive with X-Lark-Signature and X-Lark-Request-Timestamp
 * headers ONLY when an Encrypt Key is configured in the Lark Open Platform
 * console. With Encrypt Key unactivated (our current state), Lark sends
 * plaintext events with no signature header at all — confirmed against
 * the official larksuite/node-sdk implementation, where checkIsEventValidated
 * returns true unconditionally when encryptKey is unset.
 *
 * The HMAC secret is the Encrypt Key, NOT the Verification Token. The
 * Verification Token is only checked as a plaintext `token` field on
 * url_verification challenges (which we already skip-verify in the route).
 */
export function verifyLarkEvent(args: {
  rawBody: string;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}): { ok: boolean; reason?: string } {
  const encryptKey = process.env.LARK_ENCRYPT_KEY;
  if (!encryptKey) {
    return { ok: true };
  }
  if (!args.timestamp || !args.nonce || !args.signature) {
    return { ok: false, reason: "missing signature headers" };
  }
  const h = createHash("sha256");
  h.update(args.timestamp + args.nonce + encryptKey + args.rawBody);
  const expected = h.digest("hex");
  if (expected !== args.signature) {
    return { ok: false, reason: `signature mismatch (got ${args.signature.slice(0, 8)}..., expected ${expected.slice(0, 8)}...)` };
  }
  return { ok: true };
}

// ─── Outbound: react to a message (emoji ack) ───────────────────────────
//
// Why: even when the LLM reply is slow or the outbound message API fails,
// we want the user to know the bot SAW their message. A single emoji
// reaction is instant feedback — much better UX than waiting 30s to see
// either a reply or silence. We fire-and-forget; if it fails, no big deal,
// the real reply is what matters.
//
// Lark API: POST /open-apis/im/v1/messages/{message_id}/reactions
// emoji_type accepted values: "OK", "THUMBSUP", "HEART", "EYES", "DONE", etc.
// Full list: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
export async function reactToMessage(args: {
  message_id: string;
  emoji_type: "EYES" | "OK" | "THUMBSUP" | "DONE" | "HEART";
}): Promise<{ ok: boolean; error?: string }> {
  const token = await getTenantAccessToken();
  if (!token) return { ok: false, error: "no access token" };
  const url = `${pickBase()}/im/v1/messages/${encodeURIComponent(args.message_id)}/reactions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reaction_type: { emoji_type: args.emoji_type } }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.code !== 0) return { ok: false, error: `${res.status} ${JSON.stringify(j).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Outbound: send a text message ──────────────────────────────────────

export async function sendMessage(args: {
  receive_id: string;       // a chat_id (oc_...) for group, or open_id (ou_...) for DM
  receive_id_type: "chat_id" | "open_id" | "user_id" | "email" | "union_id";
  text: string;
}): Promise<{ ok: boolean; message_id?: string; error?: string }> {
  const token = await getTenantAccessToken();
  if (!token) return { ok: false, error: "no access token" };

  // Lark expects msg_type='text' with content as a JSON-stringified
  // {"text": "..."} object. Yes, doubly-encoded — that's the API.
  const body = {
    receive_id: args.receive_id,
    msg_type: "text",
    content: JSON.stringify({ text: args.text }),
  };
  const url = `${pickBase()}/im/v1/messages?receive_id_type=${args.receive_id_type}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0) {
    return { ok: false, error: `${res.status} ${JSON.stringify(j).slice(0, 300)}` };
  }
  return { ok: true, message_id: j.data?.message_id };
}

// ─── Inbound: extract user text from Lark's envelope ────────────────────

/**
 * Lark's text-event payload shape (v2):
 *   event.message.content = '{"text":"@_user_1 hello"}'   (yes, JSON in a string)
 *   event.message.mentions = [{ key:"@_user_1", id:{open_id:"ou_..."} }, ...]
 *
 * We strip @_user_1 placeholders so the question we feed to /api/help/ask
 * is the actual user-typed text without bot-mention noise.
 */
export function extractText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const msg = (event as { message?: { content?: string } }).message;
  if (!msg?.content) return "";
  let parsed: { text?: string };
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return "";
  }
  const text = parsed.text ?? "";
  // Strip mention placeholders @_user_N (the bot's own mention in @-replies)
  return text.replace(/@_user_\d+/g, "").trim();
}

export function extractChatId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const msg = (event as { message?: { chat_id?: string } }).message;
  return msg?.chat_id ?? null;
}

export function extractMessageId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const msg = (event as { message?: { message_id?: string } }).message;
  return msg?.message_id ?? null;
}

export function extractSenderOpenId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const sender = (event as { sender?: { sender_id?: { open_id?: string } } }).sender;
  return sender?.sender_id?.open_id ?? null;
}

/** "p2p" for 1:1 DMs, "group" for group chats. Used to gate flows that
 *  must only fire in DMs (e.g., onboarding — passwords cannot be
 *  collected in a group). */
export function extractChatType(event: unknown): "p2p" | "group" | null {
  if (!event || typeof event !== "object") return null;
  const t = (event as { message?: { chat_type?: string } }).message?.chat_type;
  if (t === "p2p" || t === "group") return t;
  return null;
}

/** Resolve a Lark user's display name + bound email by open_id.
 *  Used by onboarding so the admin's approval card shows the actual
 *  human name and Lark-side email, not just the cryptographic open_id. */
export async function getLarkUserInfo(openId: string): Promise<{
  ok: boolean;
  name?: string;
  email?: string;
  error?: string;
}> {
  // Lark v3: GET /contact/v3/users/:user_id?user_id_type=open_id
  // Requires `contact:user.base:readonly` or `contact:user.email:readonly` scope.
  const token = await getTenantAccessToken();
  if (!token) return { ok: false, error: "no access token" };
  const url = `${pickBase()}/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as {
      code?: number;
      msg?: string;
      data?: { user?: { name?: string; email?: string; en_name?: string } };
    };
    if (!res.ok || j.code !== 0) {
      return { ok: false, error: `${res.status} ${j.msg ?? JSON.stringify(j).slice(0, 200)}` };
    }
    const u = j.data?.user;
    return { ok: true, name: u?.name ?? u?.en_name, email: u?.email };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/** Read recent messages from a Lark chat the bot is in. Used by the
 *  read_lark_chat_history helper-tool so admin can ask "what did Leo
 *  say in 销售群?" and Leon summarizes without the admin having to
 *  scroll back manually.
 *
 *  The bot must be a member of the chat. Lark returns a 'permission
 *  denied' error otherwise (we surface that as { ok: false, error }).
 *
 *  Pagination via page_token; we only ever fetch one page (last N
 *  messages) — for deeper history use the Lark UI directly. */
export async function readChatHistory(args: {
  chat_id: string;
  page_size?: number;
}): Promise<{
  ok: boolean;
  messages?: Array<{ message_id: string; sender_open_id?: string; created_at?: string; text: string; msg_type: string }>;
  error?: string;
}> {
  const token = await getTenantAccessToken();
  if (!token) return { ok: false, error: "no access token" };
  const pageSize = Math.max(1, Math.min(50, args.page_size ?? 20));
  const url = `${pickBase()}/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(args.chat_id)}&sort_type=ByCreateTimeDesc&page_size=${pageSize}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as {
      code?: number;
      msg?: string;
      data?: {
        items?: Array<{
          message_id?: string;
          create_time?: string;
          msg_type?: string;
          body?: { content?: string };
          sender?: { id?: string; sender_type?: string; id_type?: string };
        }>;
      };
    };
    if (!res.ok || j.code !== 0) {
      return { ok: false, error: `${res.status} ${j.msg ?? JSON.stringify(j).slice(0, 200)}` };
    }
    const items = j.data?.items ?? [];
    const messages = items.map((it) => {
      let text = "";
      if (it.msg_type === "text" && typeof it.body?.content === "string") {
        try {
          const parsed = JSON.parse(it.body.content) as { text?: string };
          text = (parsed.text ?? "").replace(/@_user_\d+/g, "").trim();
        } catch {
          text = "";
        }
      } else if (typeof it.body?.content === "string") {
        // For non-text msg types (image, post, file, etc.), surface a
        // placeholder so the LLM knows something happened without
        // having to render the binary blob.
        text = `[${it.msg_type ?? "non-text"} message]`;
      }
      return {
        message_id: it.message_id ?? "",
        sender_open_id: it.sender?.id_type === "open_id" ? it.sender?.id : undefined,
        created_at: it.create_time,
        text,
        msg_type: it.msg_type ?? "unknown",
      };
    });
    return { ok: true, messages };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// ─── Auth: open_id → sales_reps row ─────────────────────────────────────

export interface LarkRep {
  id: number;
  name: string;
  email: string;
  role: "admin" | "senior" | "sales";
}

/**
 * Find the sales_reps row that matches the Lark sender's open_id. If no
 * mapping exists yet, returns null — the caller should reply with an
 * onboarding message ("DM admin to bind your account").
 */
export async function resolveRepFromOpenId(openId: string): Promise<LarkRep | null> {
  const { data, error } = await supabase
    .from("sales_reps")
    .select("id, name, sender_email, role, active")
    .eq("lark_open_id", openId)
    .maybeSingle();
  if (error || !data) return null;
  if (!data.active) return null;
  return {
    id: data.id,
    name: data.name,
    email: data.sender_email,
    role: data.role === "admin" ? "admin" : data.role === "senior" ? "senior" : "sales",
  };
}

// ─── Outbound: docs + bases ──────────────────────────────────────────────
//
// All four functions below are thin wrappers around the public Lark
// open-apis. They share auth (getTenantAccessToken) and base URL with
// the IM helpers above. Each returns { ok, ... } so the helper-tools
// layer can format error messages consistently.

async function callLarkApi<T>(opts: {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;                // e.g. "/docx/v1/documents"
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const token = await getTenantAccessToken();
  if (!token) return { ok: false, error: "no access token" };
  const qs = opts.query
    ? "?" + new URLSearchParams(
        Object.entries(opts.query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)])
      ).toString()
    : "";
  const url = `${pickBase()}${opts.path}${qs}`;
  const init: RequestInit = {
    method: opts.method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const res = await fetch(url, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code !== 0) {
    const code = j.code ?? res.status;
    const msg = j.msg ?? "(no msg)";
    return { ok: false, error: `lark ${opts.method} ${opts.path} failed: code=${code} msg="${msg}"` };
  }
  return { ok: true, data: j.data as T };
}

/**
 * Create a new docx document and (optionally) write a body of plain text
 * paragraphs into it. The body string is split on blank lines; each
 * paragraph becomes one block. The returned `url` opens the doc in
 * Lark (or Feishu in CN region).
 */
export async function createLarkDoc(args: {
  title: string;
  body?: string;
}): Promise<{ ok: boolean; document_id?: string; url?: string; error?: string }> {
  // 1. Create the doc.
  const created = await callLarkApi<{ document: { document_id: string } }>({
    method: "POST",
    path: "/docx/v1/documents",
    body: { title: args.title },
  });
  if (!created.ok) return { ok: false, error: created.error };
  const documentId = created.data.document.document_id;

  // 2. If body given, append paragraph blocks. Lark requires a parent block id;
  //    the document's own id is the root block. Fetch its block id implicit:
  //    docx api uses document_id as the root parent for "block_id=document_id"
  //    on creation.
  if (args.body && args.body.trim().length > 0) {
    const paragraphs = args.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const children = paragraphs.map((p) => ({
      block_type: 2, // text block (paragraph)
      text: {
        elements: [{ text_run: { content: p } }],
      },
    }));
    const append = await callLarkApi<unknown>({
      method: "POST",
      path: `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      body: { children, index: 0 },
    });
    if (!append.ok) {
      // Doc was created; body insertion failed. Return success on the doc but
      // surface the body error so the caller can re-try the body write.
      return { ok: true, document_id: documentId, url: docxUrl(documentId), error: append.error };
    }
  }

  return { ok: true, document_id: documentId, url: docxUrl(documentId) };
}

function docxUrl(documentId: string): string {
  // CN region uses feishu.cn, global uses larksuite.com — pick by env.
  const region = process.env.LARK_REGION ?? "cn";
  const host = region === "cn" ? "feishu.cn" : "larksuite.com";
  return `https://${host}/docx/${documentId}`;
}

/**
 * Read a docx document's plain-text content given either the document_id
 * or a Feishu/Lark URL. We pull the raw content blob (not the structured
 * blocks) — this is enough for "summarize this doc" workflows.
 */
export async function getLarkDoc(args: {
  document_id?: string;
  url?: string;
}): Promise<{ ok: boolean; document_id?: string; title?: string; content?: string; error?: string }> {
  let docId = args.document_id ?? null;
  if (!docId && args.url) {
    // Match /docx/{id} or /docs/{id} from the URL.
    const m = args.url.match(/\/(?:docx|docs)\/([A-Za-z0-9_-]+)/);
    if (m) docId = m[1];
  }
  if (!docId) return { ok: false, error: "either document_id or url required" };

  const raw = await callLarkApi<{ content: string }>({
    method: "GET",
    path: `/docx/v1/documents/${docId}/raw_content`,
    query: { lang: 0 },
  });
  if (!raw.ok) return { ok: false, error: raw.error };

  // Title comes from /docx/v1/documents/{id} → document.title
  const meta = await callLarkApi<{ document: { title: string } }>({
    method: "GET",
    path: `/docx/v1/documents/${docId}`,
  });
  const title = meta.ok ? meta.data.document.title : undefined;

  return { ok: true, document_id: docId, title, content: raw.data.content };
}

/**
 * List Bases the bot has access to. Lark/Feishu doesn't expose a direct
 * "list every Base in the tenant" endpoint to apps — the app sees only
 * Bases that have been explicitly shared with it OR that the bot itself
 * created. We surface those via /drive/v1/files (filter type=bitable).
 */
export async function listLarkBases(args: {
  limit?: number;
} = {}): Promise<{ ok: boolean; bases?: Array<{ app_token: string; name: string; url: string }>; error?: string }> {
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const res = await callLarkApi<{
    files: Array<{ token: string; name: string; type: string; url: string }>;
  }>({
    method: "GET",
    path: "/drive/v1/files",
    query: { page_size: limit, order_by: "EditedTime", direction: "DESC" },
  });
  if (!res.ok) return { ok: false, error: res.error };
  const bases = (res.data.files ?? [])
    .filter((f) => f.type === "bitable")
    .map((f) => ({ app_token: f.token, name: f.name, url: f.url }));
  return { ok: true, bases };
}

/**
 * Append a row to a Lark Base table. `fields` is a key→value object
 * keyed by column name (not column id). Most field types accept the
 * obvious primitive: text→string, number→number, single-select→string,
 * date→ms timestamp, multi-select→array.
 */
export async function addToLarkBase(args: {
  app_token: string;
  table_id: string;
  fields: Record<string, unknown>;
}): Promise<{ ok: boolean; record_id?: string; error?: string }> {
  const res = await callLarkApi<{ record: { record_id: string } }>({
    method: "POST",
    path: `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records`,
    body: { fields: args.fields },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, record_id: res.data.record.record_id };
}

/**
 * Look up a Lark user by email. Returns their open_id so the bot can
 * DM them. Useful when a sales rep tells the bot "tell Yujie about X"
 * and Yujie's open_id isn't bound yet — we resolve via her email.
 */
export async function findLarkUserByEmail(email: string): Promise<{ ok: boolean; open_id?: string; name?: string; error?: string }> {
  const res = await callLarkApi<{ user_list: Array<{ user_id: string; name: string; user: { open_id: string; name: string } }> }>({
    method: "POST",
    path: "/contact/v3/users/batch_get_id",
    query: { user_id_type: "open_id" },
    body: { emails: [email] },
  });
  if (!res.ok) return { ok: false, error: res.error };
  const first = res.data.user_list?.[0];
  if (!first?.user_id) return { ok: false, error: "user not found" };
  return { ok: true, open_id: first.user_id, name: first.name };
}
