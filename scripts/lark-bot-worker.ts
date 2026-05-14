// Long-connection (WebSocket) worker for the Lark bot.
//
// Why: avoids the public-webhook + signature-verify dance. Lark's
// "Subscription mode: persistent connection" pushes events to this
// client over a WS tunnel — SDK handles auth, reconnect, heartbeat —
// we just register a handler. Same agent logic as the HTTP webhook
// (src/lib/lark-agent.ts) so behavior is identical across transports.
//
// Run:
//   npx tsx scripts/lark-bot-worker.ts
//
// Required env (loaded from .env.local):
//   LARK_APP_ID, LARK_APP_SECRET, LARK_REGION (cn|global)
//
// Production: launchd / pm2 / Railway. plist template at the bottom
// of this file (commented out — copy to ~/Library/LaunchAgents/).

import * as Lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { processInboundLarkMessage, processJitrCardAction } from "../src/lib/lark-agent.ts";

// ── env loader (no dotenv dep) ──────────────────────────────────────────
function loadDotenv(p: string) {
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch { /* missing file ok */ }
}
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv(resolve(here, "..", ".env.local"));
loadDotenv(resolve(here, "..", ".env"));

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const REGION = process.env.LARK_REGION === "cn" ? "cn" : "global";

if (!APP_ID || !APP_SECRET) {
  console.error("LARK_APP_ID and LARK_APP_SECRET must be set in .env.local");
  process.exit(1);
}

// ── Idempotency: event_id LRU (concern #2) ──────────────────────────────
//
// Lark redelivers events when ack >3s OR when the WS tunnel reconnects
// mid-flight. Without dedup the same message processes twice, the LLM
// runs twice, and the user sees two identical replies.
//
// We dedup on event_id (header.event_id), not message_id — Lark guarantees
// event_id is stable per-redelivery, while message_id is the message itself
// (which can legitimately have multiple events: receive, edit, etc.).
// 5-minute TTL because Lark's redeliver window is shorter than that.
const seenEventIds = new Map<string, number>();
const SEEN_TTL_MS = 5 * 60 * 1000;
function isDuplicate(eventId: string | undefined): boolean {
  if (!eventId) return false;
  const now = Date.now();
  // Periodic cleanup
  if (seenEventIds.size > 1000) {
    for (const [k, ts] of seenEventIds) {
      if (now - ts > SEEN_TTL_MS) seenEventIds.delete(k);
    }
  }
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.set(eventId, now);
  return false;
}

// ── Domain selection (concern #1) ───────────────────────────────────────
//
// SDK defaults to Lark international (open.larksuite.com). The app
// `cli_a9282e82c963dbd3` is registered on Feishu (open.feishu.cn), so we
// must explicitly pass Domain.Feishu. Wrong domain = "Auth failed" with
// no obvious error message.
const baseConfig = {
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: REGION === "cn" ? Lark.Domain.Feishu : Lark.Domain.Lark,
};

console.log(`[worker] starting (region=${REGION}, domain=${baseConfig.domain}, app=${APP_ID.slice(0, 12)}...)`);

let firstEnvelopeLogged = false;
let firstCardEnvelopeLogged = false;

let wsClient = new Lark.WSClient({
  ...baseConfig,
  loggerLevel: Lark.LoggerLevel.info,
});

const dispatcher = new Lark.EventDispatcher({}).register({
  // The SDK passes the inner `event` object (not the full envelope).
  // The header (with event_id) is on data, not on a separate envelope —
  // SDK quirk; we extract it carefully.
  "im.message.receive_v1": async (data: unknown) => {
    const env = data as {
      schema?: string;
      header?: { event_id?: string; event_type?: string };
      event?: unknown;
      message?: unknown; // some payload shapes hoist message to the top
    };

    // event_id may be on env.header (envelope shape) or absent (some SDK
    // versions strip it). Fall back to message_id if missing — better than
    // no dedup at all.
    // SDK passes envelope shapes inconsistently across versions. Probe
    // the top-level keys once on first receipt so we can see where the
    // Lark fields actually live in this SDK build.
    if (!firstEnvelopeLogged) {
      console.log(`[worker] FIRST EVENT envelope keys: ${Object.keys(env).join(",")}`);
      firstEnvelopeLogged = true;
    }
    // event_id can be at: env.header.event_id (envelope), env.event_id
    // (flattened), env.schema-only payloads have no header at all.
    const eventId =
      env.header?.event_id ??
      (env as { event_id?: string }).event_id ??
      undefined;
    const innerEvent = env.event ?? data;
    const msg = (innerEvent as { message?: { message_id?: string; chat_id?: string } }).message;
    const messageId = msg?.message_id;
    const chatId = msg?.chat_id;
    const dedupKey = eventId || messageId;

    if (isDuplicate(dedupKey)) {
      console.log(`[worker] skip duplicate event_id=${eventId} message_id=${messageId}`);
      return "";
    }

    const t0 = Date.now();
    console.log(`[worker] receive event_id=${eventId} message_id=${messageId} chat=${chatId}`);
    try {
      const result = await processInboundLarkMessage({ event: innerEvent }, "ws");
      console.log(`[worker] processed in ${Date.now() - t0}ms ok=${result.ok} reason=${result.reason ?? ""}`);
    } catch (err) {
      console.error(`[worker] processInboundLarkMessage threw:`, err);
    }
    return "";
  },
  // Card-action callback. Two card types share this trigger:
  //   - JITR offer cards (jitr_action in payload) → processJitrCardAction
  //   - Onboarding admin cards (onboarding_action) → processOnboardingCardAction
  // Discriminate by which key sits in event.action.value.
  //
  // SDK envelope quirk: like im.message.receive_v1 above, the SDK may
  // pass either {header, event: {action: ...}} OR {action: ...} as
  // `data`. The previous version only handled the latter, which is
  // why card clicks reported "code: 200340" — the dispatcher saw the
  // envelope, couldn't find action.value, fell through to the JITR
  // path, JITR couldn't find jitr_action, and the result was nothing.
  // Now we mirror the message-handler unwrap pattern.
  "card.action.trigger": async (data: unknown) => {
    const t0 = Date.now();
    const env = data as {
      header?: { event_id?: string };
      event?: unknown;
      action?: { value?: Record<string, unknown> };
    };
    // Probe-log the FIRST card action's envelope so we can spot any
    // future SDK shape changes. Only logs once per worker process.
    if (!firstCardEnvelopeLogged) {
      console.log(`[worker] FIRST CARD envelope keys: ${Object.keys(env).join(",")}`);
      firstCardEnvelopeLogged = true;
    }
    const innerEvent = env.event ?? data;
    const value =
      ((innerEvent as { action?: { value?: Record<string, unknown> } })?.action?.value) ?? {};
    console.log(`[worker] card action received, value keys: ${Object.keys(value).join(",")}`);

    // ─── DEFERRED EXECUTION ──────────────────────────────────────────
    //
    // Lark's card-action contract gives us 3s to return the toast or
    // it shows a red "target callback service has timed out" banner to
    // the user. Supabase + LLM calls easily blow that budget. Move
    // the actual work off the response path: fire-and-forget here,
    // return the toast immediately below.
    //
    // Tradeoff: the user sees "✓ Approved" instantly even if the DB
    // write fails seconds later. We catch and log errors, but the
    // user does not see them. Acceptable because: (a) the operations
    // are idempotent, (b) failed writes are visible in the trace +
    // admin_inbox, (c) staying inside 3s is what makes the UX feel
    // working at all. The HTTP webhook handles this exact pattern
    // via `after()` from next/server.
    void (async () => {
      try {
        if ("onboarding_action" in value) {
          const onboarding = await import("../src/lib/onboarding.ts");
          const result = await onboarding.processOnboardingCardAction({ event: innerEvent });
          console.log(`[worker] onboarding card action in ${Date.now() - t0}ms ok=${result.ok} reason=${result.reason ?? ""}`);
        } else if ("admin_inbox_action" in value) {
          const card = await import("../src/lib/admin-inbox-card.ts");
          const result = await card.processAdminInboxCardAction({ event: innerEvent });
          console.log(`[worker] admin_inbox card action in ${Date.now() - t0}ms ok=${result.ok} reason=${result.reason ?? ""}`);
        } else if ("template_action" in value) {
          const card = await import("../src/lib/admin-approval-cards.ts");
          const result = await card.processTemplateCardAction({ event: innerEvent });
          console.log(`[worker] template card action in ${Date.now() - t0}ms ok=${result.ok} reason=${result.reason ?? ""}`);
        } else if ("quota_action" in value) {
          const card = await import("../src/lib/admin-approval-cards.ts");
          const result = await card.processQuotaCardAction({ event: innerEvent });
          console.log(`[worker] quota card action in ${Date.now() - t0}ms ok=${result.ok} reason=${result.reason ?? ""}`);
        } else if ("congress_action" in value) {
          const card = await import("../src/lib/admin-approval-cards.ts");
          const result = await card.processCongressCardAction({ event: innerEvent });
          console.log(`[worker] congress card action in ${Date.now() - t0}ms ok=${result.ok} reason=${result.reason ?? ""}`);
        } else if ("jitr_action" in value) {
          const result = await processJitrCardAction({ event: innerEvent }, "ws");
          console.log(`[worker] jitr card action in ${Date.now() - t0}ms ok=${result.ok} reason=${result.reason ?? ""}`);
        } else {
          console.error(`[worker] card action with unknown value keys: ${JSON.stringify(value).slice(0, 200)}`);
        }
      } catch (err) {
        console.error(`[worker] deferred card action threw:`, err);
      }
    })();
    // Card-action handler MUST return a Lark-shaped object.
    // - "" → SDK couldn't parse → code 200345
    // - {} → some Lark clients render code 200340 (unreachable)
    // - {toast: {...}} → client shows the toast, ack is unambiguous
    const env2 = data as { event?: { action?: { value?: Record<string, unknown> } } };
    const v2 = env2.event?.action?.value ?? {};
    const oAction = (v2.onboarding_action as string | undefined) ?? "";
    const aInbox = (v2.admin_inbox_action as string | undefined) ?? "";
    const tplAction = (v2.template_action as string | undefined) ?? "";
    const quotaAction = (v2.quota_action as string | undefined) ?? "";
    const congressAction = (v2.congress_action as string | undefined) ?? "";
    let toastContent = "Received";
    if (oAction === "deny") toastContent = "Denied — sending notification…";
    else if (oAction === "approve_sales" || oAction === "approve_senior") toastContent = "Approved — provisioning + sending welcome email…";
    else if (aInbox === "acknowledge") toastContent = "✓ Acknowledged";
    else if (aInbox === "save_as_memory") toastContent = "💾 Saving to long-term memory…";
    else if (aInbox === "dismiss") toastContent = "🗑 Dismissed";
    else if (tplAction === "approve_draft") toastContent = "✓ Approved as draft";
    else if (tplAction === "activate") toastContent = "🚀 Activating template…";
    else if (tplAction === "reject") toastContent = "❌ Rejected — reply with reason";
    else if (quotaAction === "apply") toastContent = "✓ Applying quota…";
    else if (quotaAction === "dismiss") toastContent = "🗑 Dismissed";
    else if (congressAction === "accept") toastContent = "✓ Accepted proposal";
    else if (congressAction === "reject") toastContent = "❌ Rejected proposal";
    return { toast: { type: "success", content: toastContent } };
  },
});

// Track WS health by hooking the SDK's logger output. The SDK emits
// 'ws client ready' on connect and 'unable to connect' / 'system busy'
// on failure. We watch console.log/error for these strings — gross but
// the SDK doesn't expose state hooks.
let wsHealthy = false;
let lastReconnectAt = 0;
let lastHealthyAt = 0;
const RECONNECT_COOLDOWN_MS = 30_000;
// If we've been unhealthy for > UNHEALTHY_MAX_MS, hard-exit so launchd
// (or whatever supervises us) restarts a fresh process. The SDK
// occasionally enters a state where reconnect attempts log
// "PingInterval undefined" without ever flipping wsHealthy back to
// true; we observed this on 2026-05-14 (worker process alive but
// WS dead, Leon silent for hours). Catching it by hard-exiting after
// 5min unhealthy + watchdog cooldowns failed.
const UNHEALTHY_MAX_MS = 5 * 60_000;

const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
console.log = (...args: unknown[]) => {
  const s = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (s.includes("ws client ready")) {
    wsHealthy = true;
    lastHealthyAt = Date.now();
  }
  origLog(...args);
};
console.error = (...args: unknown[]) => {
  const s = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  // Broaden the unhealthy signals: SDK has multiple ways to log a dead
  // WS depending on which retry path it's in. Catch all of them.
  const unhealthy =
    s.includes("unable to connect") ||
    s.includes("ws connect failed") ||
    s.includes("system busy") ||
    s.includes("PingInterval") ||
    s.includes("ws read error") ||
    s.includes("ws closed");
  if (unhealthy) wsHealthy = false;
  origErr(...args);
};

function startWS() {
  try {
    wsClient.start({ eventDispatcher: dispatcher });
    console.log("[worker] WS started, listening for im.message.receive_v1");
  } catch (err) {
    console.error("[worker] WS start failed", err);
  }
}
startWS();

// Watchdog: every 60s, if the SDK reported "unable to connect" and we
// haven't reconnected in the cooldown window, tear down and start fresh.
// This is the failure mode that ate every test message: SDK hits "system
// busy", logs "unable to connect to the server after trying 1 times",
// and silently stops trying. Without this watchdog the bot is dead until
// the operator notices.
setInterval(() => {
  if (wsHealthy) return;
  const now = Date.now();
  // Last-resort: if we've been unhealthy for > UNHEALTHY_MAX_MS, hard
  // exit so the supervisor (launchd/pm2/manual nohup loop) restarts a
  // fresh process. SDK soft-reconnect can deadlock in ways even our
  // recreate-WSClient watchdog doesn't recover from.
  if (lastHealthyAt > 0 && now - lastHealthyAt > UNHEALTHY_MAX_MS) {
    console.error(`[worker] WATCHDOG: ws unhealthy for >${UNHEALTHY_MAX_MS/1000}s — hard exit so supervisor restarts`);
    process.exit(2);
  }
  if (now - lastReconnectAt < RECONNECT_COOLDOWN_MS) return;
  lastReconnectAt = now;
  console.log("[worker] WATCHDOG: ws unhealthy, soft-restart attempt...");
  try {
    const ws = wsClient as unknown as { stop?: () => void };
    ws.stop?.();
  } catch (err) {
    console.error("[worker] watchdog stop failed", err);
  }
  // Recreate the client — some SDK versions don't support .start() after
  // .stop() on the same instance.
  wsClient = new Lark.WSClient({ ...baseConfig, loggerLevel: Lark.LoggerLevel.info });
  startWS();
}, 60_000);

// ── Heartbeat + stuck-connection watchdog (concern #3) ──────────────────
//
// SDK has internal reconnect, but in practice we've seen tunnels stuck
// for hours after a network blip without auto-recovery. Track time of
// last received event; if no events AND no heartbeats in N minutes,
// tear down and reconnect from scratch.
//
// We *don't* use absence-of-events alone as a signal (the bot can
// legitimately be idle for hours); we'd need an active probe. As a
// minimum: just print a heartbeat so the operator can see the worker
// is alive in logs.
let lastEventAt = Date.now();
const HEARTBEAT_MS = 60_000;
setInterval(() => {
  const idleMin = Math.round((Date.now() - lastEventAt) / 60000);
  console.log(`[worker] heartbeat ${new Date().toISOString()} (idle ${idleMin}m)`);
}, HEARTBEAT_MS);

// Hook event reception to update lastEventAt
const originalDispatch = dispatcher.invoke?.bind(dispatcher);
if (originalDispatch) {
  dispatcher.invoke = (...args: Parameters<typeof originalDispatch>) => {
    lastEventAt = Date.now();
    return originalDispatch(...args);
  };
}

// ── Graceful shutdown (concern #5) ──────────────────────────────────────
//
// On SIGTERM/SIGINT (launchd restart, Ctrl-C, container stop), close the
// WS cleanly so Lark doesn't have a zombie tunnel. Without this, Lark
// keeps thinking we're connected and won't open a new one for ~30s.
function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, stopping WS...`);
  try {
    // SDK exposes .stop() on WSClient (1.50+); fall back gracefully.
    const ws = wsClient as unknown as { stop?: () => void };
    ws.stop?.();
  } catch (err) {
    console.error("[worker] stop failed (non-blocking)", err);
  }
  setTimeout(() => process.exit(0), 250);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Surface uncaught — last-resort logging so launchd's StandardErrorPath
// captures crashes that would otherwise be silent
process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandledRejection:", err);
});

// ── launchd plist template (concern #4: absolute paths) ─────────────────
//
// Save this to ~/Library/LaunchAgents/com.qiji.lark-bot.plist, then:
//   launchctl load ~/Library/LaunchAgents/com.qiji.lark-bot.plist
//   launchctl start com.qiji.lark-bot
//   tail -f /tmp/lark-bot.log
//
// To stop:
//   launchctl unload ~/Library/LaunchAgents/com.qiji.lark-bot.plist
//
// See generate-launchd-plist below for an auto-generated version with
// your real paths.
//
// (Plist template inline as comment to keep this single-file.)
//
//   <?xml version="1.0" encoding="UTF-8"?>
//   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
//     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
//   <plist version="1.0">
//   <dict>
//     <key>Label</key><string>com.qiji.lark-bot</string>
//     <key>ProgramArguments</key>
//     <array>
//       <string>/Users/xingzewang/Desktop/mail/node_modules/.bin/tsx</string>
//       <string>/Users/xingzewang/Desktop/mail/scripts/lark-bot-worker.ts</string>
//     </array>
//     <key>WorkingDirectory</key>
//     <string>/Users/xingzewang/Desktop/mail</string>
//     <key>RunAtLoad</key><true/>
//     <key>KeepAlive</key><true/>
//     <key>StandardOutPath</key><string>/tmp/lark-bot.log</string>
//     <key>StandardErrorPath</key><string>/tmp/lark-bot.err.log</string>
//     <key>ThrottleInterval</key><integer>10</integer>
//   </dict>
//   </plist>
