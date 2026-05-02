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

  const res = await fetch(`${pickBase()}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: secret }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    console.error("[lark] tenant_access_token http", res.status);
    return null;
  }
  const j = await res.json();
  if (j.code !== 0) {
    console.error("[lark] tenant_access_token err", j);
    return null;
  }
  tokenCache = { token: j.tenant_access_token, expiresAt: now + (j.expire ?? 7200) * 1000 };
  return tokenCache.token;
}

// ─── Event verification ─────────────────────────────────────────────────

/**
 * Lark v2 events arrive with X-Lark-Signature and X-Lark-Request-Timestamp
 * headers. The signature is sha256(timestamp + nonce + verification_token + body).
 * If LARK_ENCRYPT_KEY is set the body is the still-encrypted blob — we'd
 * need to decrypt before parsing. We don't support that yet.
 *
 * If neither LARK_VERIFICATION_TOKEN nor LARK_ENCRYPT_KEY is set, we accept
 * the request without verification — fine for local dev, NOT prod.
 */
export function verifyLarkEvent(args: {
  rawBody: string;
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}): { ok: boolean; reason?: string } {
  const token = process.env.LARK_VERIFICATION_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "LARK_VERIFICATION_TOKEN not set in prod" };
    }
    return { ok: true };
  }
  if (!args.timestamp || !args.nonce || !args.signature) {
    return { ok: false, reason: "missing signature headers" };
  }
  // Lark's v2 webhook sig: sha256(timestamp + nonce + token + body)
  const h = createHash("sha256");
  h.update(args.timestamp + args.nonce + token + args.rawBody);
  const expected = h.digest("hex");
  if (expected !== args.signature) {
    return { ok: false, reason: `signature mismatch (got ${args.signature.slice(0, 8)}..., expected ${expected.slice(0, 8)}...)` };
  }
  return { ok: true };
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
