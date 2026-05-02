---
name: lark-bot
description: How to set up + operate the Lark (Feishu) bot that lets reps talk to the Helper agent from inside Lark instead of the web /pipeline panel. Covers Lark Open Platform app config, env vars, rep binding, and the conversation persistence model.
---

# Lark bot — setup and operation

## What it does

Reps DM (or @-mention) the Lark bot. Each message is routed to the same Helper agent that powers `/pipeline` chat (same tools, same Sales Guide, same Qiji Compute Facts, same memory). Replies appear back in the same Lark thread.

Action tools (batch_send / skip_lead / reassign_lead etc.) are **stripped** in Lark — they require confirm cards which Lark doesn't render. The bot tells the rep to go to the web app for those.

## Architecture

```
Lark client (mobile / desktop)
    │
    │  DM or @mention
    ▼
Lark Open Platform Event Subscription
    │
    │  HTTP POST (signed)
    ▼
/api/lark/webhook (this app)
    │
    ├─► verify signature (HMAC-SHA256 over timestamp + nonce + token + body)
    ├─► resolve sender open_id → sales_reps row
    ├─► persist user message → lark_messages
    ├─► run agent loop (same code as /api/help/ask, just inlined)
    ├─► strip ```tool``` blocks (action proposals)
    ├─► sendMessage(chat_id, reply)  ◄── outbound to Lark Open API
    └─► persist assistant message → lark_messages
```

## One-time setup

### 1. Create a Lark app

Go to <https://open.feishu.cn> (CN region) or <https://open.larksuite.com> (global) → 自建应用 (Custom App).

Required scopes (权限管理 → 添加权限):
- `im:message`  — send messages
- `im:message:send_as_bot`  — send as the bot user
- `im:resource`  — (optional) attach files later
- `im:message.group_at_msg`  — receive group @-mentions
- `im:message.p2p_msg`  — receive direct messages

### 2. Configure event subscription

事件订阅 (Event Subscription) → 请求地址 (Request URL):
```
https://<your-domain>/api/lark/webhook
```

Subscribe to:
- `im.message.receive_v1`  — fires when the bot is @-mentioned in a group OR receives a DM

When you save the URL, Lark sends a `url_verification` challenge — our route echoes it back, so this should succeed without manual steps.

### 3. Set env vars

```
LARK_APP_ID=cli_a1b2c3d4...
LARK_APP_SECRET=<from app credentials>
LARK_VERIFICATION_TOKEN=<from event subscription page>
LARK_REGION=cn          # or "global", default global

# DON'T enable Encrypt Key in the app config — we don't decrypt yet.
```

In Vercel: project → Settings → Environment Variables → add the 4. Redeploy.

### 4. Apply DB migration

```
node scripts/apply-037.mjs
```

Adds `sales_reps.lark_open_id`, `lark_union_id`, `lark_email` + creates `lark_messages` table.

### 5. Bind each colleague to their sales_reps row

Two ways:

**Easy way: have them DM the bot once.**
The first message creates a `lark_messages` row with the raw event including `sender.sender_id.open_id`. The bot will reply "I don't know you" with their open_id printed. Admin reads it from the reply or queries:

```bash
curl -H "cookie: <admin-session>" \
  https://<your-domain>/api/lark/bind?orphans=1
```

Returns:
```json
{ "orphans": [{ "open_id": "ou_abc...", "sample_text": "hi", "first_seen": "2026-05-02T03:14:00Z" }] }
```

Then bind:
```bash
curl -X POST -H "cookie: <admin-session>" -H "content-type: application/json" \
  -d '{"rep_id": 2, "lark_open_id": "ou_abc..."}' \
  https://<your-domain>/api/lark/bind
```

**Pre-bind (if you know the open_id from the Lark contact API):**
Same POST. The colleague can DM the bot and it will work first time.

## Operational notes

### Conversation history

`lark_messages` keeps every message + reply, keyed by `chat_id` (the Lark thread). The agent feeds the last 8 turns back as context. This is **separate** from the web app's `helper_conversations` table — same agent brain, different storage. We don't merge the two; web sessions and Lark sessions stay independent.

### Action tools

Action tools (`batch_send`, `skip_lead`, `reassign_lead`, etc.) require a confirm UI we don't render in Lark. The route strips the ```tool``` block from the reply and appends "— 这步要在网页 /pipeline 里点 confirm 才会执行".

If you want Lark cards (interactive buttons) later, switch from `msg_type:"text"` to `msg_type:"interactive"` and serve confirm callbacks at `/api/lark/callback`. Out of scope for v1.

### Read tools

Lookups (`list_leads`, `get_my_stats`, etc.) work the same as web — they hit the DB through `helper-read-tools.runReadTool` with the resolved `LarkSession`. Per-rep visibility is preserved (sales sees only their leads; admin sees all).

### DNC + dedup safety

The bot consults the same `contact-guard` and `person-resolver`, so every action proposal it makes (even if Lark can't execute it) respects DNC + already-contacted rules. The advice never violates the guarantee.

### Rate limits

Lark allows 100 outbound messages per minute per app. We don't currently throttle — at typical helper traffic this isn't close. If a rep spams the bot, the `runAgent` loop is bounded to 3 LLM iterations + ~15s, so no runaway calls.

### Failure mode

If `LARK_APP_ID` / `LARK_APP_SECRET` aren't set, `sendMessage` returns `{ ok: false }` and we log a warning. The user message is still persisted; only the reply fails. Symptom: rep messages disappear into the void. Check:

```bash
curl https://<your-domain>/api/lark/webhook
# returns { config: { app_id_set, app_secret_set, verification_token_set, region } }
```

## Testing locally

```bash
# Tunnel localhost:3000 to a public URL (Lark requires HTTPS)
ngrok http 3000

# In Lark Open Platform: set Request URL to https://<ngrok>.ngrok-free.app/api/lark/webhook
# Save → Lark sends url_verification → check it succeeds

# DM the bot from your Lark client.
```

## Future extensions

- Interactive cards for action confirms (so Lark becomes a fully equivalent surface to the web app).
- Per-chat memory (so a sales chat with multiple reps can be its own thread context).
- Lark slash commands (`/lead Yanye`, `/stats`) for power users who hate typing full sentences.
- Outbound notifications (helper proactively pings the rep in Lark when something happens — e.g. "your wechat followup with X is now 5 days stale").
