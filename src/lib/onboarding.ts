/**
 * Lark-driven rep onboarding.
 *
 * Two state machines, both running over `pending_onboarding` and
 * `onboarding_config`:
 *
 *   1. Admin config flow — first time anyone tries to onboard, Leon
 *      DMs the admin and asks for the team's onboarding fundamentals
 *      (sales group chat_id, doc URLs, day-one notes). Stored in
 *      onboarding_config. Reused for every future onboarding.
 *
 *   2. Rep candidate flow — a brand-new Lark user DMs the bot. Leon
 *      walks them through name → email prefix → password → wechat,
 *      then notifies the admin via interactive card. On admin approval
 *      Leon inserts a sales_reps row and posts a walkthrough message.
 *
 * Entry points (called from src/lib/lark-agent.ts):
 *   - tryHandleOnboardingMessage(openId, name, text) → returns
 *     { handled: true } if the message belonged to either flow,
 *     so the agent should NOT fall through to client-agent or rep
 *     paths. Otherwise { handled: false }.
 *   - processOnboardingCardAction(event) → admin button click.
 */
import bcrypt from "bcryptjs";
import { supabase } from "@/lib/db";
import { sendMessage, getLarkUserInfo } from "@/lib/lark";

const ADMIN_REP_ID = 5; // Xingze. Same constant as JITR card flow.

// Keys used in onboarding_config. Adding a new key here is the only
// place to extend what Leon asks the admin during config setup.
const CONFIG_KEYS = {
  sales_group_chat_id: {
    question:
      "1️⃣ 算力组群 (Lark group) 的 chat_id 是什么? 我会自动把新同学拉进去.\n直接发我 chat_id (oc_... 开头), 或者把我加进群我自己抓.",
    label: "算力组群 chat_id",
  },
  welcome_doc_url: {
    question:
      "2️⃣ 新人手册 / SOP 文档放哪? (飞书 wiki / 云文档链接都行)",
    label: "新人手册 URL",
  },
  team_intro: {
    question:
      "3️⃣ 团队介绍 — 谁是谁, 怎么联系, 工时什么的. 直接发我一段, 或者贴文档链接.",
    label: "团队介绍",
  },
  day_one_notes: {
    question:
      "4️⃣ 新 rep 第一天必须知道的事? (随便写, 我会原话转给他. 没有就回 'skip'.)",
    label: "Day-one notes",
  },
} as const;

type ConfigKey = keyof typeof CONFIG_KEYS;
const CONFIG_KEY_ORDER: ConfigKey[] = [
  "sales_group_chat_id",
  "welcome_doc_url",
  "team_intro",
  "day_one_notes",
];

// ─── public API ────────────────────────────────────────────────────────

/**
 * Called from lark-agent.ts BEFORE the rep / client-agent dispatch.
 * Returns { handled: true } if the message belonged to an onboarding
 * flow (either admin-config or rep-candidate or triage), false
 * otherwise.
 *
 * Flow priority for an unknown Lark user:
 *   1. Mid-onboarding? → continue the candidate state machine.
 *   2. Already triaged "not_qiji" / "qiji_other_team"? → don't ask
 *      again, let client-agent handle.
 *   3. Brand new + DM (chat_type='p2p')? → ask the triage question
 *      first ("are you 算力组 sales?"). Onboarding only starts after
 *      they say yes.
 *   4. Brand new + group chat? → don't start onboarding (we never
 *      collect passwords in a group). Let client-agent handle if it
 *      wants to.
 */
export async function tryHandleOnboardingMessage(
  senderOpenId: string,
  senderName: string | null,
  text: string,
  chatType: "p2p" | "group" | null,
): Promise<{ handled: boolean; reason?: string }> {
  const trimmed = text.trim();

  // 1. Is this the admin in the middle of answering the config setup?
  //    We track this with a sentinel pending_onboarding row whose
  //    lark_open_id is the admin's open_id and step starts with 'config_'.
  if (await senderIsAdmin(senderOpenId)) {
    const handled = await maybeHandleAdminConfigStep(senderOpenId, trimmed);
    if (handled) return { handled: true, reason: "admin-config-step" };

    // Admin command: `/onboarding setup` resets / restarts config flow.
    if (/^\/onboarding\s+setup\b/i.test(trimmed)) {
      await startAdminConfigFlow(senderOpenId);
      return { handled: true, reason: "admin-config-reset" };
    }
  }

  // 2. Is this open_id mid-onboarding as a candidate?
  const pending = await getPendingByOpenId(senderOpenId);
  if (pending && pending.status === "in_progress") {
    await handleCandidateStep(pending, trimmed);
    return { handled: true, reason: `candidate-step:${pending.step}` };
  }

  // Existing reps never onboard.
  const rep = await findRepByOpenId(senderOpenId);
  if (rep) return { handled: false };

  // 3. Have we already triaged this Lark user?
  const { data: triage } = await supabase
    .from("lark_triage_decisions")
    .select("decision")
    .eq("lark_open_id", senderOpenId)
    .maybeSingle();
  if (triage?.decision === "not_qiji" || triage?.decision === "qiji_other_team") {
    // Already decided not-our-rep. Let client-agent handle as customer.
    return { handled: false, reason: `prior-triage:${triage.decision}` };
  }
  // (decision === 'is_sales' but no pending row means they triaged YES
  // but the row was deleted somehow. Fall through to startTriage which
  // will re-ask, since the candidate flow data is gone.)

  // 4. Group chats never start onboarding (passwords + private info
  //    cannot be collected there). Silently no-op so client-agent or
  //    other handlers can decide what to do.
  if (chatType !== "p2p") {
    return { handled: false, reason: "non-p2p-chat" };
  }

  // 5. Brand new Lark user in a 1:1 DM. Ask the triage question.
  await startTriage(senderOpenId, senderName);
  return { handled: true, reason: "started-triage" };
}

/**
 * Admin clicked Approve / Deny on the onboarding interactive card.
 * Wired from /api/lark/card-action (or wherever JITR cards are dispatched).
 */
export async function processOnboardingCardAction(rawEvent: unknown): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const env = rawEvent as { event?: unknown };
  const event = (env.event ?? rawEvent) as {
    operator?: { open_id?: string };
    action?: {
      value?: {
        onboarding_action?: "approve_sales" | "approve_senior" | "deny";
        pending_id?: string;
      };
    };
  };
  const operatorOpenId = event.operator?.open_id;
  const action = event.action?.value?.onboarding_action;
  const pendingId = event.action?.value?.pending_id;
  if (!operatorOpenId || !action || !pendingId) {
    return { ok: true, reason: "incomplete card action" };
  }

  // Only admins can act on these cards.
  if (!(await senderIsAdmin(operatorOpenId))) {
    return { ok: true, reason: "non-admin card click" };
  }

  const { data: pending } = await supabase
    .from("pending_onboarding")
    .select("*")
    .eq("id", pendingId)
    .maybeSingle();
  if (!pending) return { ok: true, reason: "pending row gone" };
  if (pending.status !== "in_progress" && pending.status !== "awaiting_admin") {
    return { ok: true, reason: `already decided: ${pending.status}` };
  }

  const adminRep = await findRepByOpenId(operatorOpenId);

  if (action === "deny") {
    await supabase
      .from("pending_onboarding")
      .update({
        status: "denied",
        decided_by_rep: adminRep?.id ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq("id", pending.id);
    await sendMessage({
      receive_id: pending.lark_open_id,
      receive_id_type: "open_id",
      text:
        "抱歉, 目前无法为你创建账号. 如有疑问请联系 admin (Xingze).",
    });
    return { ok: true, reason: "denied" };
  }

  // Approve. Map the button to a role.
  const role = action === "approve_senior" ? "senior" : "sales";
  const result = await provisionRep(pending, role);
  if (!result.ok) {
    await sendMessage({
      receive_id: operatorOpenId,
      receive_id_type: "open_id",
      text: `❌ 创建 ${pending.claimed_name} 失败: ${result.error}`,
    });
    return { ok: false, reason: result.error };
  }

  await supabase
    .from("pending_onboarding")
    .update({
      status: "approved",
      decided_by_rep: adminRep?.id ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", pending.id);

  // Walkthrough DM to the new rep
  await sendWalkthrough(pending, result.repId, result.senderEmail);

  // Confirm to admin
  await sendMessage({
    receive_id: operatorOpenId,
    receive_id_type: "open_id",
    text: `✅ ${pending.claimed_name} (${result.senderEmail}) 已通过 — 角色 ${role}, rep_id=${result.repId}.`,
  });
  return { ok: true, reason: "approved" };
}

// ─── triage flow ───────────────────────────────────────────────────────

/** First contact with an unknown Lark user. Resolve their actual Lark
 *  identity (name + email) and ask the triage question. */
async function startTriage(openId: string, fallbackName: string | null): Promise<void> {
  // Look up the real Lark name + email so we have something better than
  // the open_id when this person eventually shows up on the admin card.
  const info = await getLarkUserInfo(openId);
  const larkName = info.ok ? info.name ?? fallbackName : fallbackName;
  const larkEmail = info.ok ? info.email ?? null : null;

  await supabase.from("pending_onboarding").upsert(
    {
      lark_open_id: openId,
      lark_name: larkName,
      lark_email: larkEmail,
      step: "triage",
      status: "in_progress",
    },
    { onConflict: "lark_open_id" },
  );

  await sendMessage({
    receive_id: openId,
    receive_id_type: "open_id",
    text:
      `你好${larkName ? ` ${larkName}` : ""}! 我是 Leon, 奇绩算力的助手 🤖\n\n` +
      "我们可能没正式认识过, 我先确认一下身份再聊后续:\n\n" +
      "**你是奇绩 算力组 的同学吗?** 直接回:\n" +
      "  • `是` (或 `yes`) — 算力组同学, 我帮你接入系统\n" +
      "  • `奇绩其他组` — 不是算力组, 但是奇绩同事\n" +
      "  • `不是` (或 `no`) — 都不是 (那我大概是把你当客户/申请者来对话了)",
  });
}

async function handleTriageStep(pending: PendingRow, text: string): Promise<void> {
  const t = text.toLowerCase().trim();

  // Affirmative — they're 算力组 sales. Proceed to the role question.
  const isYes =
    /^(是|对|yes|y|ok|嗯|是的|算力组|是算力组|算力)$/i.test(t) ||
    /(算力组|算力 组).*(销售|sales)/i.test(text) ||
    /^(?:i'?m|我是)\s+(?:a\s+)?(?:sales|销售|new\s+sales)/i.test(text);

  // Other-team Qiji — log + ping admin.
  const isOtherTeam =
    /(奇绩.*(?:其他|别的)|other\s+(?:team|qiji))/i.test(text) ||
    /^奇绩其他组$/.test(text.trim());

  // Negative — let client-agent handle going forward.
  const isNo = /^(不是|否|no|n|不|nope|not\s+(?:qiji|sales))$/i.test(t);

  if (isOtherTeam) {
    await supabase.from("lark_triage_decisions").upsert(
      { lark_open_id: pending.lark_open_id, decision: "qiji_other_team" },
      { onConflict: "lark_open_id" },
    );
    await supabase.from("pending_onboarding").delete().eq("id", pending.id);
    await sendMessage({
      receive_id: pending.lark_open_id,
      receive_id_type: "open_id",
      text:
        "了解 — 我目前只负责算力组的事 (邮件外联 / lead 管理). " +
        "如果你需要算力组的人帮忙, 我可以转告 admin (Xingze).",
    });
    // Notify admin so they know someone from another Qiji team is poking around.
    const adminOpenId = await getAdminOpenId();
    if (adminOpenId) {
      await sendMessage({
        receive_id: adminOpenId,
        receive_id_type: "open_id",
        text:
          `📨 ${pending.lark_name ?? "(unknown Lark user)"} (${pending.lark_open_id}) ` +
          `说自己是奇绩其他组的人在跟我对话. 没自动 onboard. ` +
          `如要联系: ${pending.lark_email ?? "(no email)"}`,
      });
    }
    return;
  }

  if (isNo) {
    await supabase.from("lark_triage_decisions").upsert(
      { lark_open_id: pending.lark_open_id, decision: "not_qiji" },
      { onConflict: "lark_open_id" },
    );
    await supabase.from("pending_onboarding").delete().eq("id", pending.id);
    await sendMessage({
      receive_id: pending.lark_open_id,
      receive_id_type: "open_id",
      text:
        "好, 那我作为客户对话助手陪你聊. 如果之前问的问题还没回, 直接发就行.",
    });
    return;
  }

  if (!isYes) {
    // Couldn't classify — re-ask once.
    await sendMessage({
      receive_id: pending.lark_open_id,
      receive_id_type: "open_id",
      text:
        "没看懂, 再确认一下:\n\n" +
        "  • `是` — 算力组同学\n" +
        "  • `奇绩其他组` — 奇绩别的组\n" +
        "  • `不是` — 不是奇绩",
    });
    return;
  }

  // YES — they're 算力组. Skip the role question (they're all "growth"
  // by default; admin can promote to senior/admin manually after) and
  // jump straight to the candidate name step. Record the triage
  // decision so we don't re-ask if they DM later.
  await supabase.from("lark_triage_decisions").upsert(
    {
      lark_open_id: pending.lark_open_id,
      decision: "is_sales",
      claimed_role: "growth",
    },
    { onConflict: "lark_open_id" },
  );
  await supabase
    .from("pending_onboarding")
    .update({ claimed_role: "growth", step: "ask_name" })
    .eq("id", pending.id);
  // Admin config gating + the actual ask_name prompt live in
  // maybeStartCandidateAfterRole so we share that path with any
  // future flow that lands at ask_name.
  const refreshed = await getPendingByOpenId(pending.lark_open_id);
  if (refreshed) await maybeStartCandidateAfterRole(refreshed);
}

// ─── candidate flow ────────────────────────────────────────────────────

async function maybeStartCandidateAfterRole(pending: PendingRow): Promise<void> {
  // Before talking to the candidate, make sure admin config is filled.
  // If not, kick off the admin flow in parallel and tell the rep to wait.
  const cfgComplete = await isAdminConfigComplete();
  if (!cfgComplete) {
    await sendMessage({
      receive_id: pending.lark_open_id,
      receive_id_type: "open_id",
      text:
        "稍等几分钟, 我先跟 admin 把入职资料对齐一下, 完事我接着问你.",
    });
    await startAdminConfigFlow(null); // null = autonomous trigger
    return;
  }
  await sendMessage({
    receive_id: pending.lark_open_id,
    receive_id_type: "open_id",
    text:
      "好的 ✅ 那我帮你接入. 几个简单的问题:\n\n" +
      "**你叫什么名字?** (中英文都行, 比如 'Yujie' 或 '余杰')",
  });
}

async function handleCandidateStep(
  pending: PendingRow,
  text: string,
): Promise<void> {
  switch (pending.step) {
    case "triage": {
      await handleTriageStep(pending, text);
      return;
    }
    case "ask_role": {
      const t = text.trim();
      let role: "sales" | "senior" | "admin" | null = null;
      if (/^1$|^sales$/i.test(t)) role = "sales";
      else if (/^2$|^senior$/i.test(t)) role = "senior";
      else if (/^3$|^admin$/i.test(t)) role = "admin";
      if (!role) {
        await sendMessage({
          receive_id: pending.lark_open_id,
          receive_id_type: "open_id",
          text: "没看懂, 直接回 `1` (sales) / `2` (senior) / `3` (admin):",
        });
        return;
      }
      await supabase.from("lark_triage_decisions").upsert(
        {
          lark_open_id: pending.lark_open_id,
          decision: "is_sales",
          claimed_role: role,
        },
        { onConflict: "lark_open_id" },
      );
      await supabase
        .from("pending_onboarding")
        .update({ claimed_role: role, step: "ask_name" })
        .eq("id", pending.id);
      await sendMessage({
        receive_id: pending.lark_open_id,
        receive_id_type: "open_id",
        text: `收到, role=${role}. (admin 会再确认一次再正式给你权限.)`,
      });
      // Pull the freshly-updated pending row so subsequent flow has claimed_role
      const refreshed = await getPendingByOpenId(pending.lark_open_id);
      if (refreshed) await maybeStartCandidateAfterRole(refreshed);
      return;
    }
    case "ask_name": {
      const name = text.slice(0, 80).trim();
      if (!name) {
        await sendMessage({
          receive_id: pending.lark_open_id,
          receive_id_type: "open_id",
          text: "名字是空的 — 再发一遍?",
        });
        return;
      }
      await supabase
        .from("pending_onboarding")
        .update({ claimed_name: name, step: "ask_email" })
        .eq("id", pending.id);
      await sendMessage({
        receive_id: pending.lark_open_id,
        receive_id_type: "open_id",
        text:
          `收到, ${name}.\n\n` +
          "**你想用哪个邮箱发件?** 我们一般用 `firstname@compute.miracleplus.com` 格式.\n" +
          "告诉我前缀就行, 比如 `yujie`. (我会自动补上 @compute.miracleplus.com)",
      });
      return;
    }
    case "ask_email": {
      const prefix = text.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
      if (!prefix) {
        await sendMessage({
          receive_id: pending.lark_open_id,
          receive_id_type: "open_id",
          text:
            "邮箱前缀只能是字母 / 数字 / `.`-`_`. 再发一遍, 比如 `yujie`:",
        });
        return;
      }
      const email = `${prefix}@compute.miracleplus.com`;
      // Uniqueness check against sales_reps
      const { data: clash } = await supabase
        .from("sales_reps")
        .select("id, name")
        .ilike("sender_email", email)
        .maybeSingle();
      if (clash) {
        await sendMessage({
          receive_id: pending.lark_open_id,
          receive_id_type: "open_id",
          text:
            `${email} 已经被 ${clash.name} 用了. 换一个前缀:`,
        });
        return;
      }
      await supabase
        .from("pending_onboarding")
        .update({ claimed_email: email, step: "ask_password" })
        .eq("id", pending.id);
      await sendMessage({
        receive_id: pending.lark_open_id,
        receive_id_type: "open_id",
        text:
          `好, 邮箱定为 \`${email}\`.\n\n` +
          "**接下来设个密码.** 8 位以上, 至少含一个数字. 直接发给我:\n\n" +
          "(我会用 bcrypt 加密保存, 我自己也看不到原文.)",
      });
      return;
    }
    case "ask_password": {
      const pw = text;
      if (pw.length < 8 || !/\d/.test(pw)) {
        await sendMessage({
          receive_id: pending.lark_open_id,
          receive_id_type: "open_id",
          text: "密码不够强 — 至少 8 位且要带数字. 再来一次:",
        });
        return;
      }
      const hash = await bcrypt.hash(pw, 10);
      await supabase
        .from("pending_onboarding")
        .update({ password_hash: hash, step: "ask_wechat" })
        .eq("id", pending.id);
      await sendMessage({
        receive_id: pending.lark_open_id,
        receive_id_type: "open_id",
        text:
          "密码已加密保存 ✅\n\n" +
          "**最后一个: 你的微信号?** (用来加客户)",
      });
      return;
    }
    case "ask_wechat": {
      const wechat = text.trim().slice(0, 60);
      if (!wechat) {
        await sendMessage({
          receive_id: pending.lark_open_id,
          receive_id_type: "open_id",
          text: "微信号是空的 — 再发一遍?",
        });
        return;
      }
      await supabase
        .from("pending_onboarding")
        .update({
          claimed_wechat: wechat,
          step: "awaiting_admin",
        })
        .eq("id", pending.id);
      await sendMessage({
        receive_id: pending.lark_open_id,
        receive_id_type: "open_id",
        text:
          `好, 信息齐全:\n` +
          `- 名字: ${pending.claimed_name}\n` +
          `- 邮箱: ${pending.claimed_email}\n` +
          `- 微信: ${wechat}\n\n` +
          "已发给 admin 审核, 通常几分钟. 通过后我会再 DM 你.",
      });
      // Send admin card
      await sendOnboardingCard({
        ...pending,
        claimed_wechat: wechat,
      });
      return;
    }
    case "awaiting_admin": {
      await sendMessage({
        receive_id: pending.lark_open_id,
        receive_id_type: "open_id",
        text: "你的申请正在审核中, 请稍候. 通过我会立刻 DM 你.",
      });
      return;
    }
  }
}

async function provisionRep(
  pending: PendingRow,
  role: "sales" | "senior",
): Promise<{ ok: true; repId: number; senderEmail: string } | { ok: false; error: string }> {
  if (!pending.claimed_name || !pending.claimed_email || !pending.password_hash) {
    return { ok: false, error: "pending row missing required fields" };
  }

  // Lark-resolved name wins over the typed claim. lark_name was captured
  // at triage time from /contact/v3/users — that's what their colleagues
  // see in Lark, so it's the canonical display name. claimed_name is a
  // fallback for the rare case where the Lark API failed during triage.
  // Without this preference we get drift: someone types "Yujie" in DM
  // but Lark knows them as "杜雨洁", and then every email signature
  // and AI prompt uses the pinyin variant they don't actually go by.
  const canonicalName = (pending.lark_name?.trim() || pending.claimed_name).trim();

  // First-name as username (lowercase, alpha-num only). We derive this
  // from the typed claim, not the Lark name — Chinese chars don't survive
  // the [^a-z0-9] filter, and login usernames need to be ASCII anyway.
  const username = pending.claimed_name
    .toLowerCase()
    .split(/\s+/)[0]
    .replace(/[^a-z0-9]/g, "");

  const { data: inserted, error } = await supabase
    .from("sales_reps")
    .insert({
      name: canonicalName,
      sender_name: canonicalName,
      sender_email: pending.claimed_email,
      login_email: pending.claimed_email,
      username: username || null,
      password_hash: pending.password_hash,
      wechat_id: pending.claimed_wechat ?? null,
      role,
      active: true,
      lark_open_id: pending.lark_open_id,
      lark_email: pending.lark_email ?? null,
      // Explicitly stamp onboarded_at — even though migration 057 set
      // a column default, depending on default semantics across clients
      // (Supabase JS, drizzle, raw SQL) is fragile. This is the rep's
      // tenure anchor for trust-level computation; it must not be NULL.
      onboarded_at: new Date().toISOString(),
    })
    .select("id, sender_email")
    .single();
  if (error || !inserted) {
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  return { ok: true, repId: inserted.id, senderEmail: inserted.sender_email };
}

// Hardcoded intro to 奇绩算力 itself. Always shown to new joiners
// regardless of admin config — this is the first thing they should
// learn about the team. Admin can layer extra context via
// onboarding_config.team_intro (e.g., who's who).
const QIJI_INTRO_TEXT =
  "**奇绩算力 (Qiji Compute) 在做什么:**\n\n" +
  "我们给做 AI 研究的研究员提供**免费 GPU 算力**, 帮他们的研究跑出来.\n\n" +
  "工作流大概是:\n" +
  "  • 每天 cron 扫 arXiv 上发的新论文 (cs.LG / cs.AI / cs.CL / cs.CV / cs.RO 等方向)\n" +
  "  • AI 自动判断哪些论文需要算力 + 作者是不是中国研究员\n" +
  "  • 路由到对应同学 (按 lead 强度 + 国内/海外邮箱)\n" +
  "  • AI 拟好邮件草稿, 你确认后发出去\n" +
  "  • 客户回信加微信 → 你跟客户聊 → 客户申请 → 拿到算力\n\n" +
  "你这边的工作是**判断这条 lead 值不值得发** + **跟回信的人接上**. " +
  "重复劳动 (拟稿 / 跟踪 / 提醒 / 统计) 我帮你做.";

async function sendWalkthrough(
  pending: PendingRow,
  repId: number,
  senderEmail: string,
): Promise<void> {
  const cfg = await loadAdminConfig();

  // Message 1: welcome + what 算力组 is + dashboard login.
  // We split into two messages so the new rep has time to breathe and
  // open the dashboard link before the system tour arrives.
  const msg1Lines: string[] = [
    `🎉 你已通过审核, 欢迎加入团队!`,
    ``,
    QIJI_INTRO_TEXT,
    ``,
    `**Dashboard**: https://calistamind.com`,
    `登录: \`${senderEmail}\` + 你刚才设的密码.`,
    `(想换密码就跟我说一句, 我让 admin 帮你重置 — 暂时还没有 self-serve 改密码的页面.)`,
    ``,
    `**重要**: 我 (Leon) 不只在 Lark 里. 你登进 dashboard 也会看到我 — 右下角有个 ✨ helper 按钮, 那是同一个我, 上下文也是通的. 你在这里跟我聊的, 那边也记得.`,
  ];
  if (cfg.team_intro) {
    msg1Lines.push(``, `👥 **团队介绍**:`, cfg.team_intro);
  }
  if (cfg.welcome_doc_url) {
    msg1Lines.push(``, `📚 **新人手册**: ${cfg.welcome_doc_url}`);
  }
  if (cfg.day_one_notes) {
    msg1Lines.push(``, `📝 **第一天提醒**:`, cfg.day_one_notes);
  }
  await sendMessage({
    receive_id: pending.lark_open_id,
    receive_id_type: "open_id",
    text: msg1Lines.join("\n"),
  });

  // Message 2: short system tour + how to use Leon.
  // Sent right after msg1 (no artificial delay — Lark will display them
  // in order). Keeps each message scrollable rather than a wall.
  const msg2Lines: string[] = [
    `登进去之后看这几个页面就够了:`,
    ``,
    `**/pipeline** — 你的 lead 在这. 每天早上 cron 塞新 lead 进来, AI 已经帮你拟好邮件了, 看一眼觉得 OK 就点 Send.`,
    ``,
    `**/emails** — 邮件追踪. 谁打开了 / 谁回了 / 谁退订, 全在这.`,
    ``,
    `**/inbox** — 客户回信都在这. (我也会在收到新回复时主动 DM 你提醒.)`,
    ``,
    `**加微信流程**: 客户回邮件之后, 你跟他要微信. 加上之后回 dashboard 点 "Added on WeChat" 标记一下 — **或者直接 Lark 里跟我说一句 "加了 X 微信" 我帮你标**. 这是算转化的关键一步, 别忘.`,
    ``,
    `**怎么使唤我**: 直接 DM. 例子:`,
    `  • "我今天还有几条 ready?"`,
    `  • "把张三的 lead 给 Leo"`,
    `  • "刚加了 wang@xxx 的微信"`,
    `  • "有新回复吗?"`,
    `  • "发了那条 Yujie 的"  → 我会真的把那封发出去`,
  ];
  if (cfg.sales_group_chat_id) {
    const added = await addToSalesGroup(cfg.sales_group_chat_id, pending.lark_open_id);
    if (added) {
      msg2Lines.push(``, `已经把你拉进算力组群了 👋`);
    } else {
      msg2Lines.push(``, `(算力组群我没拉成功, admin 待会手动加你.)`);
    }
  }
  msg2Lines.push(``, `第一封邮件慢慢看, 不急. 有问题随时 DM 我.`);
  void repId;
  await sendMessage({
    receive_id: pending.lark_open_id,
    receive_id_type: "open_id",
    text: msg2Lines.join("\n"),
  });
}

async function addToSalesGroup(chatId: string, openId: string): Promise<boolean> {
  // Lark: POST /im/v1/chats/:chat_id/members?member_id_type=open_id
  // body: { id_list: [openId] }
  try {
    const { getTenantAccessToken, pickBase } = await loadLarkPrimitives();
    const token = await getTenantAccessToken();
    if (!token) return false;
    const res = await fetch(
      `${pickBase()}/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=open_id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id_list: [openId] }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const j = (await res.json().catch(() => ({}))) as { code?: number };
    return res.ok && j.code === 0;
  } catch {
    return false;
  }
}

// ─── admin config flow ─────────────────────────────────────────────────

async function startAdminConfigFlow(triggeredByOpenId: string | null): Promise<void> {
  const adminOpenId = await getAdminOpenId();
  if (!adminOpenId) return;
  // Mark admin as "in config mode" via a sentinel pending row.
  // step is encoded as `config_<key>` so the same dispatcher can pick
  // up whatever question is next.
  const next = await firstUnsetConfigKey();
  if (!next) {
    await sendMessage({
      receive_id: adminOpenId,
      receive_id_type: "open_id",
      text: "Onboarding config 已经齐了, 没东西要问.",
    });
    return;
  }
  await supabase.from("pending_onboarding").upsert(
    {
      lark_open_id: adminOpenId,
      lark_name: "(admin config sentinel)",
      step: `config_${next}`,
      status: "in_progress",
    },
    { onConflict: "lark_open_id" },
  );
  await sendMessage({
    receive_id: adminOpenId,
    receive_id_type: "open_id",
    text:
      (triggeredByOpenId
        ? "新 rep 想加入 — 但我还没你给的 onboarding 资料. 一次性填一下, 之后所有新 rep 都用这一份.\n\n"
        : "Onboarding config 还有空的 — 我问几个问题, 答完就齐.\n\n") +
      CONFIG_KEYS[next].question,
  });
}

/** If sender is admin AND has a 'config_*' sentinel row, treat the message
 *  as their answer to that config question. Returns true if handled. */
async function maybeHandleAdminConfigStep(
  adminOpenId: string,
  text: string,
): Promise<boolean> {
  const sentinel = await getPendingByOpenId(adminOpenId);
  if (!sentinel) return false;
  const m = sentinel.step.match(/^config_(.+)$/);
  if (!m) return false;
  const key = m[1] as ConfigKey;
  if (!(key in CONFIG_KEYS)) return false;

  // 'skip' lets admin skip optional questions (day_one_notes mostly).
  const value = text.trim();
  if (value.toLowerCase() !== "skip" && value !== "") {
    const adminRep = await findRepByOpenId(adminOpenId);
    await supabase.from("onboarding_config").upsert(
      {
        key,
        value,
        updated_at: new Date().toISOString(),
        updated_by_rep: adminRep?.id ?? null,
      },
      { onConflict: "key" },
    );
  }

  // Move to the next unset key, or complete.
  const next = await firstUnsetConfigKey();
  if (next) {
    await supabase
      .from("pending_onboarding")
      .update({ step: `config_${next}` })
      .eq("id", sentinel.id);
    await sendMessage({
      receive_id: adminOpenId,
      receive_id_type: "open_id",
      text:
        (value.toLowerCase() === "skip"
          ? "OK, 跳过.\n\n"
          : `✅ 收到 (${CONFIG_KEYS[key].label}).\n\n`) +
        CONFIG_KEYS[next].question,
    });
  } else {
    // All filled — clear the sentinel and confirm.
    await supabase.from("pending_onboarding").delete().eq("id", sentinel.id);
    await sendMessage({
      receive_id: adminOpenId,
      receive_id_type: "open_id",
      text:
        `✅ 收到 (${CONFIG_KEYS[key].label}). Onboarding config 齐了.\n\n` +
        "如果有候选 rep 卡在等我, 我现在去接他.",
    });
    // If a candidate is waiting, kick their flow.
    const { data: waiting } = await supabase
      .from("pending_onboarding")
      .select("*")
      .eq("step", "ask_name")
      .eq("status", "in_progress")
      .limit(1)
      .maybeSingle();
    if (waiting) {
      await sendMessage({
        receive_id: waiting.lark_open_id,
        receive_id_type: "open_id",
        text:
          "Admin 给齐资料了, 接着上面的来 — **你叫什么名字?** (中英文都行)",
      });
    }
  }
  return true;
}

// ─── helpers ───────────────────────────────────────────────────────────

interface PendingRow {
  id: string;
  lark_open_id: string;
  lark_name: string | null;
  lark_email: string | null;
  step: string;
  status: string;
  claimed_name: string | null;
  claimed_email: string | null;
  claimed_wechat: string | null;
  password_hash: string | null;
  claimed_role: string | null;
  lark_chat_id: string | null;
}

async function getPendingByOpenId(openId: string): Promise<PendingRow | null> {
  const { data } = await supabase
    .from("pending_onboarding")
    .select("*")
    .eq("lark_open_id", openId)
    .maybeSingle();
  return (data as PendingRow | null) ?? null;
}

async function findRepByOpenId(openId: string): Promise<{ id: number; role: string; name: string } | null> {
  const { data } = await supabase
    .from("sales_reps")
    .select("id, role, name")
    .eq("lark_open_id", openId)
    .eq("active", true)
    .maybeSingle();
  return data as { id: number; role: string; name: string } | null;
}

async function senderIsAdmin(openId: string): Promise<boolean> {
  const rep = await findRepByOpenId(openId);
  return rep?.role === "admin";
}

async function getAdminOpenId(): Promise<string | null> {
  const { data } = await supabase
    .from("sales_reps")
    .select("lark_open_id")
    .eq("id", ADMIN_REP_ID)
    .maybeSingle();
  return (data?.lark_open_id as string | null) ?? null;
}

async function loadAdminConfig(): Promise<Record<ConfigKey, string | null>> {
  const { data } = await supabase
    .from("onboarding_config")
    .select("key, value");
  const out: Record<ConfigKey, string | null> = {
    sales_group_chat_id: null,
    welcome_doc_url: null,
    team_intro: null,
    day_one_notes: null,
  };
  for (const row of data ?? []) {
    if (row.key in out) out[row.key as ConfigKey] = row.value;
  }
  return out;
}

async function isAdminConfigComplete(): Promise<boolean> {
  const cfg = await loadAdminConfig();
  // sales_group + welcome_doc are the load-bearing ones.
  // team_intro and day_one_notes are optional (skippable).
  return Boolean(cfg.sales_group_chat_id && cfg.welcome_doc_url);
}

async function firstUnsetConfigKey(): Promise<ConfigKey | null> {
  const cfg = await loadAdminConfig();
  for (const k of CONFIG_KEY_ORDER) {
    if (!cfg[k]) return k;
  }
  return null;
}

async function sendOnboardingCard(pending: PendingRow): Promise<void> {
  const adminOpenId = await getAdminOpenId();
  if (!adminOpenId) {
    console.error("[onboarding] cannot send admin card — admin has no lark_open_id");
    return;
  }
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🆕 New rep onboarding request" },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            `**Lark identity** (from Lark, can't be spoofed):\n` +
            `- Name: ${pending.lark_name ?? "(no name)"}\n` +
            `- Email: ${pending.lark_email ?? "(no email)"}\n` +
            `- open_id: \`${pending.lark_open_id}\`\n\n` +
            `**Self-claimed** (from chat, verify these match the person):\n` +
            `- Name: ${pending.claimed_name}\n` +
            `- Email: \`${pending.claimed_email}\`\n` +
            `- WeChat: ${pending.claimed_wechat}\n` +
            `- Role: ${pending.claimed_role ?? "(not claimed)"}`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Approve as sales" },
            type: "primary",
            value: { onboarding_action: "approve_sales", pending_id: pending.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Approve as senior" },
            type: "default",
            value: { onboarding_action: "approve_senior", pending_id: pending.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Deny" },
            type: "danger",
            value: { onboarding_action: "deny", pending_id: pending.id },
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content:
              "Lark name + open_id are from Lark auth (cannot be spoofed). Self-claimed fields are user input — verify the name + email match the person you expect.",
          },
        ],
      },
    ],
  };
  try {
    const { getTenantAccessToken, pickBase } = await loadLarkPrimitives();
    const token = await getTenantAccessToken();
    if (!token) return;
    const res = await fetch(
      `${pickBase()}/im/v1/messages?receive_id_type=open_id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: adminOpenId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const j = (await res.json().catch(() => ({}))) as {
      code?: number;
      data?: { message_id?: string };
    };
    if (res.ok && j.code === 0 && j.data?.message_id) {
      await supabase
        .from("pending_onboarding")
        .update({ admin_card_message_id: j.data.message_id })
        .eq("id", pending.id);
    } else {
      console.error("[onboarding] sendOnboardingCard failed:", res.status, j);
    }
  } catch (e) {
    console.error("[onboarding] sendOnboardingCard exception:", e);
  }
}

// pickBase is not exported from lark.ts; we re-derive it here so we don't
// have to widen the lark.ts public surface. Falls back to the default
// Feishu (China) host which matches what congress-runners uses.
async function loadLarkPrimitives(): Promise<{
  getTenantAccessToken: () => Promise<string | null>;
  pickBase: () => string;
}> {
  const mod = await import("@/lib/lark");
  const region = (process.env.LARK_REGION ?? "cn").toLowerCase();
  return {
    getTenantAccessToken: mod.getTenantAccessToken,
    pickBase: () =>
      region === "global" || region === "intl"
        ? "https://open.larksuite.com/open-apis"
        : "https://open.feishu.cn/open-apis",
  };
}
