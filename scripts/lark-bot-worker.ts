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
import { processInboundLarkMessage } from "../src/lib/lark-agent.ts";

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
});

// Track WS health by hooking the SDK's logger output. The SDK emits
// 'ws client ready' on connect and 'unable to connect' / 'system busy'
// on failure. We watch console.log/error for these strings — gross but
// the SDK doesn't expose state hooks.
let wsHealthy = false;
let lastReconnectAt = 0;
const RECONNECT_COOLDOWN_MS = 30_000;

const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
console.log = (...args: unknown[]) => {
  const s = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (s.includes("ws client ready")) wsHealthy = true;
  origLog(...args);
};
console.error = (...args: unknown[]) => {
  const s = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (s.includes("unable to connect") || s.includes("ws connect failed")) wsHealthy = false;
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
  if (now - lastReconnectAt < RECONNECT_COOLDOWN_MS) return;
  lastReconnectAt = now;
  console.log("[worker] WATCHDOG: ws unhealthy, restarting...");
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
