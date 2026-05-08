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
//
// Order matters — Leon asks them in CONFIG_KEY_ORDER. Required ones
// (anything used in isAdminConfigComplete) are first; optional ones
// (skippable) trail. Any key with a value is shown to the new rep
// during the doc-bundle message in sendWalkthrough.
const CONFIG_KEYS = {
  sales_group_chat_id: {
    question:
      "1️⃣ 算力组群 (Lark group) 的 chat_id 是什么? 我会自动把新同学拉进去.\n直接发我 chat_id (oc_... 开头), 或者把我加进群我自己抓.",
    label: "算力组群 chat_id",
  },
  welcome_doc_url: {
    question:
      "2️⃣ 新人手册 (overview / 公司基本介绍) 放哪? (飞书 wiki / 云文档链接都行)",
    label: "新人手册 URL",
  },
  sop_doc_url: {
    question:
      "3️⃣ Sales SOP / playbook 放哪? — 怎么处理回信、什么时候要微信、客户消失怎么办之类的. 链接发我就行, 没有回 'skip'.",
    label: "Sales SOP URL",
  },
  faq_doc_url: {
    question:
      "4️⃣ FAQ / 常见反对意见文档? (定价 / 资格 / GPU 规格 / 申请流程) 链接发我, 没有回 'skip'.",
    label: "FAQ URL",
  },
  first_week_checklist: {
    question:
      "5️⃣ 第一周 checklist — 周一到周五具体该做什么. 直接发我一段, 或者贴文档链接. 没有回 'skip'.",
    label: "第一周 checklist",
  },
  who_does_what: {
    question:
      "6️⃣ 谁负责什么 (cheat sheet) — '算法问题问 Leo / billing 问 admin / infra 问 Ethan' 这种. 直接发一段或贴链接, 没有回 'skip'.",
    label: "Who-does-what",
  },
  team_intro: {
    question:
      "7️⃣ 团队介绍 — 谁是谁, 怎么联系, 工时什么的. 直接发我一段, 或者贴文档链接.",
    label: "团队介绍",
  },
  day_one_notes: {
    question:
      "8️⃣ 新 rep 第一天必须知道的事? (随便写, 我会原话转给他. 没有就回 'skip'.)",
    label: "Day-one notes",
  },
} as const;

type ConfigKey = keyof typeof CONFIG_KEYS;
const CONFIG_KEY_ORDER: ConfigKey[] = [
  "sales_group_chat_id",
  "welcome_doc_url",
  "sop_doc_url",
  "faq_doc_url",
  "first_week_checklist",
  "who_does_what",
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

    // Admin command: `bind <rep_id>` — executes the open_id binding
    // proposed by escalateToAdmin during an existing-rep collision.
    // This is the ONLY path that auto-mutates lark_open_id on an
    // existing sales_reps row from a DM, kept narrow on purpose.
    const bindMatch = trimmed.match(/^bind\s+(\d+)$/i);
    if (bindMatch) {
      const handled = await handleAdminBindCommand(senderOpenId, Number(bindMatch[1]));
      if (handled) return { handled: true, reason: "admin-bind" };
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
  // Admin note used to come from event.action.form_value.admin_note when
  // the card was wrapped in a Lark form, but that broke buttons on real
  // Lark clients (see comment in sendOnboardingCard). To set a note now,
  // admin DMs Leon "for rep_id=N, trust_notes: ..." after approving.
  const adminNote = "";
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

  // Persist the admin's free-text note onto the new rep's row BEFORE
  // sending the walkthrough — sendWalkthrough re-reads trust_notes
  // to fold the note into the closing message. Order matters: if the
  // walkthrough fires first, we'd send the welcome WITHOUT the note.
  if (adminNote) {
    await supabase
      .from("sales_reps")
      .update({ trust_notes: adminNote })
      .eq("id", result.repId);
  }

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
        await noteValidationFailure(
          pending,
          "没看懂, 直接回 `1` (sales) / `2` (senior) / `3` (admin):",
        );
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
        .update({ claimed_role: role, step: "ask_name", ...clearFailures() })
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
        await noteValidationFailure(pending, "名字是空的 — 再发一遍?");
        return;
      }
      await supabase
        .from("pending_onboarding")
        .update({ claimed_name: name, step: "ask_email", ...clearFailures() })
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
        await noteValidationFailure(
          pending,
          "邮箱前缀只能是字母 / 数字 / `.`-`_`. 再发一遍, 比如 `yujie`:",
        );
        return;
      }
      const email = `${prefix}@compute.miracleplus.com`;
      // Uniqueness check against sales_reps. Pull lark_open_id too —
      // we use it to detect "the candidate IS that existing rep, they
      // just never bound their Lark account." (Yujie hit this exact
      // case: her row existed from a manual SQL migration with
      // lark_open_id=NULL, then she DMed Leon and got told her own
      // email was 'taken by Yujie' — a deadlock.)
      const { data: clash } = await supabase
        .from("sales_reps")
        .select("id, name, lark_open_id")
        .ilike("sender_email", email)
        .maybeSingle();
      if (clash) {
        const existingHasNoOpenId = !clash.lark_open_id;
        const candidateName = pending.lark_name?.trim() || pending.claimed_name?.trim() || "";
        const namesLookLikeSamePerson =
          existingHasNoOpenId && namesProbablyMatch(candidateName, clash.name);

        if (namesLookLikeSamePerson) {
          // High-likelihood case: this is the same person, their row
          // just predates Lark binding. Don't auto-bind — that's a
          // foot-gun if names happen to collide. Escalate to admin
          // and pause this candidate's flow.
          await escalateToAdmin(pending, {
            kind: "existing_rep_match",
            summary:
              `候选 ${candidateName} 想用 ${email}, 但这邮箱已经是 rep_id=${clash.id} (${clash.name}) — 而那个 row 没绑 Lark. ` +
              `名字看起来对得上, 很可能 ${candidateName} 就是 ${clash.name}, 只是从没 DM 过 Leon. ` +
              `如果确认是同一个人, 我可以把他的 lark_open_id (${pending.lark_open_id}) 绑到 rep_id=${clash.id} 上, 不开新 row. 你回 'bind ${clash.id}' 我就执行.`,
          });
          await sendMessage({
            receive_id: pending.lark_open_id,
            receive_id_type: "open_id",
            text:
              `这邮箱看起来已经是你之前的账号了 (${clash.name}). ` +
              `我已经发给 admin 确认了, 不用重新走一遍 onboarding — 等他回复我会再 DM 你.`,
          });
          // Pause the candidate. Admin's bind action will close it out.
          await supabase
            .from("pending_onboarding")
            .update({ status: "paused_existing_rep" })
            .eq("id", pending.id);
          return;
        }

        await noteValidationFailure(
          pending,
          `${email} 已经被 ${clash.name} 用了. 换一个前缀:`,
        );
        return;
      }
      await supabase
        .from("pending_onboarding")
        .update({ claimed_email: email, step: "ask_password", ...clearFailures() })
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
        await noteValidationFailure(pending, "密码不够强 — 至少 8 位且要带数字. 再来一次:");
        return;
      }
      const hash = await bcrypt.hash(pw, 10);
      await supabase
        .from("pending_onboarding")
        .update({ password_hash: hash, step: "ask_wechat", ...clearFailures() })
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
        await noteValidationFailure(pending, "微信号是空的 — 再发一遍?");
        return;
      }
      await supabase
        .from("pending_onboarding")
        .update({
          claimed_wechat: wechat,
          step: "awaiting_admin",
          ...clearFailures(),
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

/**
 * For greetings: pull the given (first) name out of a Chinese full name.
 * "杜雨洁" → "雨洁". Single-char surname assumption — covers ~99% of
 * Han names. For 2-char surnames (欧阳, 上官 …) we'd misfire by 1
 * char, but that's still a friendly form. Pure-latin / mixed names
 * are returned as-is.
 *
 * Why we bother: addressing a new joiner by their full name feels
 * formal/HR-like; using just the given name feels warm and personal.
 * Leon's whole pitch is "I'm your teammate, not a system" — small
 * touches like this carry that.
 */
function firstNameForGreeting(fullName: string): string {
  const s = fullName.trim();
  if (!s) return s;
  // Pure CJK (no spaces, no latin) and length ≥ 2 → strip surname char
  const allCjk = /^[一-鿿]+$/.test(s);
  if (allCjk && s.length >= 2) return s.slice(1);
  return s;
}

async function sendWalkthrough(
  pending: PendingRow,
  repId: number,
  senderEmail: string,
): Promise<void> {
  const cfg = await loadAdminConfig();
  // Pull trust_notes (the per-rep admin note set at approval time) +
  // canonical name. We use the row Leon just inserted, not pending,
  // because provisionRep already chose lark_name vs claimed_name for us.
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("name, trust_notes")
    .eq("id", repId)
    .maybeSingle();
  const fullName = rep?.name ?? pending.lark_name ?? pending.claimed_name ?? "你";
  const given = firstNameForGreeting(fullName);
  const adminNote = (rep?.trust_notes ?? "").trim();

  // ─── Message 1: warm welcome + 算力组 intro ────────────────────────
  // The first thing they see should feel personal, not bureaucratic.
  // Address by given name. Acknowledge them by their actual identity.
  const msg1Lines: string[] = [
    `${given}, 欢迎 🎉`,
    ``,
    `Admin 已经通过你的申请了 — 你正式是 算力组 的人了.`,
    ``,
    QIJI_INTRO_TEXT,
  ];
  if (cfg.team_intro) {
    msg1Lines.push(``, `👥 **团队**:`, cfg.team_intro);
  }
  await sendMessage({
    receive_id: pending.lark_open_id,
    receive_id_type: "open_id",
    text: msg1Lines.join("\n"),
  });

  // ─── Message 2: dashboard login + how Leon works across surfaces ──
  // Login + the "I'm the same Leon on the dashboard" framing. Kept
  // separate so they can copy the email cleanly without scrolling past
  // a wall of intro text.
  const msg2Lines: string[] = [
    `**Dashboard**: https://calistamind.com`,
    `登录邮箱: \`${senderEmail}\``,
    `密码: 就是你刚才在这跟我设的那个.`,
    ``,
    `登进去之后看这几个页面就够了:`,
    `  • **/pipeline** — 你的 lead 在这. 每天早上 cron 塞新 lead, AI 已经帮你拟好邮件草稿, 你看一眼 OK 就点 Send.`,
    `  • **/emails** — 邮件追踪. 谁打开了 / 谁回了 / 谁退订.`,
    `  • **/inbox** — 客户回信. (我会在收到新回复时主动 DM 你提醒.)`,
    ``,
    `**重要**: 我 (Leon) 不只在 Lark. 你登进 dashboard, 右下角有个 ✨ helper 按钮 — 那是同一个我, 上下文也是通的. 你在 Lark 跟我聊的, 那边也记得.`,
  ];
  await sendMessage({
    receive_id: pending.lark_open_id,
    receive_id_type: "open_id",
    text: msg2Lines.join("\n"),
  });

  // ─── Message 3: doc bundle ─────────────────────────────────────────
  // All the URLs / playbooks / cheat sheets in one scrollable place,
  // so they have a single message to bookmark / pin. Each line only
  // shows if the admin actually filled in that config — no empty
  // bullets, no "TODO" placeholders.
  const docLines: string[] = [];
  if (cfg.welcome_doc_url) {
    docLines.push(`📚 **新人手册 (overview)**: ${cfg.welcome_doc_url}`);
  }
  if (cfg.sop_doc_url) {
    docLines.push(`📘 **Sales SOP / playbook**: ${cfg.sop_doc_url}`);
  }
  if (cfg.faq_doc_url) {
    docLines.push(`❓ **FAQ / 常见反对意见**: ${cfg.faq_doc_url}`);
  }
  if (cfg.first_week_checklist) {
    // first_week_checklist is content OR a URL — we display either way.
    docLines.push(`✅ **第一周 checklist**:`, cfg.first_week_checklist);
  }
  if (cfg.who_does_what) {
    docLines.push(`🧭 **谁负责什么 (cheat sheet)**:`, cfg.who_does_what);
  }
  if (cfg.day_one_notes) {
    docLines.push(`📝 **第一天提醒** (admin 写给你的)`, cfg.day_one_notes);
  }
  // Only send the doc message if there's actually something to show —
  // otherwise we'd send an awkward "(空)" message.
  if (docLines.length > 0) {
    const msg3Lines = [
      `**📂 资料合集** — 我把所有重要的链接 / playbook 放这一条里, 方便你回头来翻:`,
      ``,
      ...docLines.flatMap((line) => [line, ``]),
      `这一条值得 pin 一下 (长按消息 → Pin to chat).`,
    ];
    await sendMessage({
      receive_id: pending.lark_open_id,
      receive_id_type: "open_id",
      text: msg3Lines.join("\n"),
    });
  }

  // ─── Message 4: how to use Leon + group invite + first-week beat ──
  // Closing message: tonally warmer, sets expectations for the first
  // week. If admin left a note about THIS specific rep, we surface it
  // here as the most personal touch — it's specifically from a human
  // who saw their card.
  const msg4Lines: string[] = [
    `**怎么使唤我** (直接 DM 就行):`,
    `  • "今天我还有几条 ready?"`,
    `  • "把张三的 lead 给 Leo"`,
    `  • "刚加了 wang@xxx 的微信"  → 我会自动标这条转化`,
    `  • "有新回复吗?"`,
    `  • "发了那条给张三的邮件"  → 我会真的把那封发出去`,
    ``,
    `**加微信流程**: 客户回邮件 → 你跟他要微信 → 加上 → Lark 里跟我说一句 "加了 X 微信" 我帮你标. 这是算转化的关键一步, 别忘.`,
  ];
  if (cfg.sales_group_chat_id) {
    const added = await addToSalesGroup(cfg.sales_group_chat_id, pending.lark_open_id);
    if (added) {
      msg4Lines.push(``, `✅ 已经把你拉进算力组群了 👋`);
    } else {
      msg4Lines.push(``, `(算力组群我没拉成功, admin 待会儿手动加你.)`);
    }
  }
  if (adminNote) {
    msg4Lines.push(
      ``,
      `💬 **Admin 想让我转告你**:`,
      adminNote,
    );
  }
  msg4Lines.push(
    ``,
    `第一封邮件慢慢看, 不急. 第一周不用追求量 — 把节奏感建立起来就行.`,
    `我明早 (北京时间 9 点左右) 会再 DM 你一下, 看看第一天有没有卡住的地方. 任何时候直接 DM 我都行.`,
  );
  void repId;
  await sendMessage({
    receive_id: pending.lark_open_id,
    receive_id_type: "open_id",
    text: msg4Lines.join("\n"),
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
  step_failures: number; // migration 059
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
    sop_doc_url: null,
    faq_doc_url: null,
    first_week_checklist: null,
    who_does_what: null,
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
  // FLAT card schema — buttons live in a top-level `tag: "action"` element
  // whose clicks Lark sends to our webhook with action.value populated.
  // Earlier (Task 21 / commit 3549ce2) this was wrapped in a `tag: "form"`
  // to capture an inline admin-note input alongside the button click. That
  // broke approval entirely on the user's Lark client — the buttons either
  // didn't render or didn't dispatch the action event. Symptom: the user
  // tried to "approve" via DM and Leon had nothing to act on.
  //
  // Trade-off accepted: we lose the inline admin-note capture (Task 21).
  // If admin wants to add a note for the new rep, they can DM Leon
  // afterwards: "for rep_id=N, trust_notes: ..." — and Leon's tool path
  // already supports that. Approve buttons working is more important
  // than the inline note shortcut.
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
            `- open_id: \`${pending.lark_open_id || "(missing)"}\`\n\n` +
            `**Self-claimed** (from chat, verify these match the person):\n` +
            `- Name: ${pending.claimed_name ?? "(not claimed)"}\n` +
            `- Email: \`${pending.claimed_email ?? "(not claimed)"}\`\n` +
            `- WeChat: ${pending.claimed_wechat ?? "(not claimed)"}\n` +
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
              "Lark name + open_id are from Lark auth. Self-claimed fields are user input — verify they match the person. To add a personal note for the new rep, DM Leon after approving: 'for rep_id=N, trust_notes: ...'.",
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

// ─── stuck-candidate detection ─────────────────────────────────────────
//
// Threshold: 2 consecutive failed validations on the same step trigger
// an admin escalation. We don't pause the candidate — they can keep
// trying — but admin gets pinged so they can intervene if it's a real
// problem (e.g., their pre-filled email got rejected by a typo they
// can't see). Counter is reset to 0 every time the step transitions.
const STUCK_THRESHOLD = 2;

/**
 * Record a validation failure on the candidate's current step. Sends
 * them the corrective hint message AND, if this is their Nth failure
 * in a row on this step (N >= STUCK_THRESHOLD), pings admin via
 * escalateToAdmin so a human can step in.
 *
 * Callers should use this in place of the previous pattern of
 * `sendMessage(...corrective hint...)` at every validation-fail branch.
 * It returns nothing — caller continues to early-return after.
 */
async function noteValidationFailure(
  pending: PendingRow,
  hintToCandidate: string,
): Promise<void> {
  const newFailures = (pending.step_failures ?? 0) + 1;
  await supabase
    .from("pending_onboarding")
    .update({ step_failures: newFailures })
    .eq("id", pending.id);

  await sendMessage({
    receive_id: pending.lark_open_id,
    receive_id_type: "open_id",
    text: hintToCandidate,
  });

  if (newFailures >= STUCK_THRESHOLD) {
    // Idempotent: dedup_hash on admin_inbox keys on (kind, open_id, step)
    // so a single stuck step only generates one inbox entry. The Lark
    // DM still re-fires each time — a stuck rep should reach admin's
    // attention even if they ignored the first ping.
    await escalateToAdmin(pending, {
      kind: `stuck_step_${pending.step}`,
      summary:
        `${pending.lark_name ?? pending.lark_open_id} 在 onboarding 第 \`${pending.step}\` 步连续失败 ${newFailures} 次. ` +
        `最后一次提示: "${hintToCandidate.slice(0, 120).replace(/\n+/g, " ")}". ` +
        `要不要我帮他 / 直接 DM 他?`,
    });
  }
}

/**
 * Reset the failure counter when the step transitions. Call this from
 * any UPDATE that advances `step` to a new value. Cheap to also call
 * defensively — it's just a `step_failures: 0` column write.
 *
 * (We can't put this inside noteValidationFailure because that helper
 * runs on FAILURE; this one runs on SUCCESS. They're complementary.)
 */
function clearFailures(): { step_failures: 0 } {
  return { step_failures: 0 };
}

// ─── name similarity (conservative) ────────────────────────────────────
// CJK = Han ideographs range. Pinyin / latin alone is never a confirm
// signal per project memory (feedback_chinese_name_matching) — surnames
// must match exactly when both sides are CJK; otherwise we escalate.
const CJK_RANGE = /[一-鿿]/;

function isCJK(s: string): boolean {
  return CJK_RANGE.test(s);
}

/**
 * Returns true ONLY when the two names are very likely the same person.
 * False positives here cost an incorrect lark_open_id binding — we are
 * deliberately strict.
 *
 * Cases handled:
 *  - Both CJK: surname (first char) must match exactly. Then at least
 *    one additional Han char from the typed name must appear in the DB
 *    name (substring match, either direction).
 *  - Both pure latin: case-insensitive exact match, OR one is a prefix
 *    of the other AND the shorter is ≥3 chars (to avoid "yu" matching
 *    "yujie").
 *  - Mixed (one CJK, one latin / pinyin): never auto-confirm. Pinyin
 *    alone is never a signal, so we return false and let admin decide.
 */
function namesProbablyMatch(typed: string, dbName: string | null | undefined): boolean {
  const a = (typed ?? "").trim();
  const b = (dbName ?? "").trim();
  if (!a || !b) return false;

  const aHasCjk = isCJK(a);
  const bHasCjk = isCJK(b);

  if (aHasCjk && bHasCjk) {
    if (a[0] !== b[0]) return false; // surname must match
    // At least one additional CJK char in common
    for (const ch of a.slice(1)) {
      if (CJK_RANGE.test(ch) && b.includes(ch)) return true;
    }
    return false;
  }

  if (!aHasCjk && !bHasCjk) {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al === bl) return true;
    const [shorter, longer] = al.length <= bl.length ? [al, bl] : [bl, al];
    if (shorter.length >= 3 && longer.startsWith(shorter)) return true;
    return false;
  }

  // Mixed scripts — pinyin/latin alone never confirms a CJK name.
  return false;
}

/**
 * Send the admin a DM about a stuck/ambiguous candidate. Used by the
 * existing-rep detector and by stuck-candidate auto-escalation.
 *
 * The summary is the only field shown — it MUST contain everything
 * admin needs (candidate name, what they're trying to do, the proposed
 * fix command). Keep it self-contained; the admin won't have the
 * pending_onboarding row open in front of them.
 */
async function escalateToAdmin(
  pending: PendingRow,
  payload: { kind: string; summary: string },
): Promise<void> {
  const adminOpenId = await getAdminOpenId();
  if (!adminOpenId) {
    console.error("[onboarding] escalateToAdmin: no admin open_id configured");
    return;
  }

  // Best-effort: upsert into admin_inbox. Per migration 058 the design
  // is "same dedup_hash → update body, keep status" so re-escalating
  // the same candidate doesn't spam the inbox. We don't fail the
  // escalation if this errors — the Lark DM is the authoritative path.
  try {
    await supabase.from("admin_inbox").upsert(
      {
        kind: "request",
        headline: `Onboarding 卡住: ${pending.lark_name ?? pending.lark_open_id}`,
        body: payload.summary,
        evidence: { onboarding_kind: payload.kind, pending_id: pending.id },
        dedup_hash: `onboarding:${payload.kind}:${pending.lark_open_id}`,
        updated_at: new Date().toISOString(),
        // status: omitted on update so an already-acknowledged row stays acked.
      },
      { onConflict: "dedup_hash" },
    );
  } catch (e) {
    console.error("[onboarding] admin_inbox upsert failed:", e);
  }

  await sendMessage({
    receive_id: adminOpenId,
    receive_id_type: "open_id",
    text: `🔔 ${payload.summary}`,
  });
}

/**
 * Admin types `bind <rep_id>` after seeing an existing-rep escalation.
 * Effect: take the candidate that's `paused_existing_rep`, copy their
 * lark_open_id (and lark_email if any) onto sales_reps[rep_id], delete
 * the pending row, and DM the candidate that they're set up.
 *
 * Returns false if no paused candidate was found — admin gets a friendly
 * "no candidate to bind" message either way.
 */
async function handleAdminBindCommand(adminOpenId: string, repId: number): Promise<boolean> {
  // Find a paused candidate. There SHOULD be at most one at a time;
  // if multiple, we take the most recent and warn.
  const { data: paused } = await supabase
    .from("pending_onboarding")
    .select("*")
    .eq("status", "paused_existing_rep")
    .order("created_at", { ascending: false })
    .limit(2);
  const candidate = (paused?.[0] as PendingRow | undefined) ?? null;
  if (!candidate) {
    await sendMessage({
      receive_id: adminOpenId,
      receive_id_type: "open_id",
      text: `没有 paused 的候选要 bind. (rep_id=${repId} 没动.)`,
    });
    return true;
  }
  if ((paused?.length ?? 0) > 1) {
    await sendMessage({
      receive_id: adminOpenId,
      receive_id_type: "open_id",
      text:
        `⚠️ 有多个 paused 候选, 我先 bind 最新那个 (${candidate.lark_name ?? candidate.lark_open_id}). ` +
        `如果错了, 等会儿再 bind 另一个.`,
    });
  }

  // Verify the rep exists and isn't already bound.
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id, sender_email")
    .eq("id", repId)
    .maybeSingle();
  if (!rep) {
    await sendMessage({
      receive_id: adminOpenId,
      receive_id_type: "open_id",
      text: `rep_id=${repId} 不存在.`,
    });
    return true;
  }
  if (rep.lark_open_id && rep.lark_open_id !== candidate.lark_open_id) {
    await sendMessage({
      receive_id: adminOpenId,
      receive_id_type: "open_id",
      text:
        `rep_id=${repId} (${rep.name}) 已经绑了另一个 open_id (${rep.lark_open_id}). ` +
        `不会覆盖. 如果要换, 你直接改 DB.`,
    });
    return true;
  }

  // Bind. We DON'T touch password_hash — they should reset via admin if
  // they forgot; we DON'T touch sender_email. This op is purely about
  // pairing the Lark identity to an existing row.
  const { error: updateErr } = await supabase
    .from("sales_reps")
    .update({
      lark_open_id: candidate.lark_open_id,
      lark_email: candidate.lark_email ?? null,
    })
    .eq("id", repId);
  if (updateErr) {
    await sendMessage({
      receive_id: adminOpenId,
      receive_id_type: "open_id",
      text: `bind 失败: ${updateErr.message}`,
    });
    return true;
  }

  // Clean up the pending row.
  await supabase.from("pending_onboarding").delete().eq("id", candidate.id);

  await sendMessage({
    receive_id: adminOpenId,
    receive_id_type: "open_id",
    text: `✅ 已绑定: ${rep.name} (rep_id=${repId}) ↔ open_id ${candidate.lark_open_id}.`,
  });
  // Tell the candidate.
  await sendMessage({
    receive_id: candidate.lark_open_id,
    receive_id_type: "open_id",
    text:
      `Admin 确认了, 你之前的账号已经绑到这个 Lark 上. ` +
      `登录: \`${rep.sender_email}\` + 你之前的密码. ` +
      `如果忘了密码, 跟我说一句, 我让 admin 重置.`,
  });
  return true;
}
