import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET  /api/help/chime-in  — read + clear the rep's pending chime-in,
 *                           if any. Returns { chimeIn: {...} | null }
 *                           and renders the prose message server-side
 *                           so the client just shows the text.
 * POST /api/help/chime-in  — rep "dismisses" without acting (explicit
 *                           no-thanks). Same clearing behavior as GET;
 *                           future analytics can distinguish on the
 *                           server-side log.
 *
 * We clear on read (pull-style): the signal already earned its one
 * chance to be heard. If the cron re-detects it tomorrow, it comes
 * back. Leaving it pending after render makes the same signal fire
 * on every chat open, which reads as nagging.
 */

interface VoiceCaptureOfferChimeIn {
  type: "voice_capture_offer";
  edit_count: number;
  window_days: number;
  detected_at: string;
}

// Pushed by /api/cron/congress-chime on Monday after weekly Tactical
// Congress fires. Asks each rep to weigh in on the new proposal —
// the rep's reply gets stored as evidence for next week's congress
// (closing the same loop as rejection_reason did for templates).
interface CongressProposalChimeIn {
  type: "congress_proposal_review";
  proposal_count: number;        // how many new proposals dropped this week
  top_title?: string;             // headline of the most prominent one
  proposal_kind?: string;         // 'template_phrase_swap' / 'subject_line' / etc.
  detected_at: string;
}

type ChimeIn = VoiceCaptureOfferChimeIn | CongressProposalChimeIn;

function renderMessage(chimeIn: ChimeIn, repName: string | null): string {
  const name = repName ?? "你";
  if (chimeIn.type === "voice_capture_offer") {
    return `${name}, 最近 ${chimeIn.window_days} 天改了 ${chimeIn.edit_count} 封草稿 (都是大改, 不是小修). 要不要我根据你改过的, 生成一份你自己的 intro 模板? 以后草稿就按你的风格来, 不用每次都重写.`;
  }
  if (chimeIn.type === "congress_proposal_review") {
    const headline = chimeIn.top_title ? `这周 Congress 提了 "${chimeIn.top_title}"` : `这周 Congress 提了 ${chimeIn.proposal_count} 条改动建议`;
    return `${name}, ${headline}. 你最近发邮件的时候, 这种问题有没有遇到过? 直接跟我说一句你的看法 — 不管同意不同意, 都会带到下周 Congress 当证据.`;
  }
  return "";
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: state } = await supabase
    .from("helper_rep_state")
    .select("pending_chime_in")
    .eq("rep_id", session.repId)
    .maybeSingle();

  const raw = state?.pending_chime_in as ChimeIn | null;
  if (!raw) return NextResponse.json({ chimeIn: null });

  // Build the response BEFORE clearing, so a DB failure on the clear
  // step doesn't leave the client empty-handed. If the clear fails
  // after the response goes out, the worst case is the chime-in
  // shows once more — noticeably better than it never showing at all.
  const payload = {
    chimeIn: {
      ...raw,
      message: renderMessage(raw, session.repName),
    },
  };

  await supabase
    .from("helper_rep_state")
    .update({ pending_chime_in: null, updated_at: new Date().toISOString() })
    .eq("rep_id", session.repId);

  return NextResponse.json(payload);
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Two POST shapes:
  //   { reply: "..." }       → rep is weighing in. Mark log row 'replied'
  //                            and store reply_text in payload so next
  //                            week's congress sees it as evidence.
  //   {} or { dismissed: true } → rep declined to engage. Mark 'dismissed'.
  // Both clear pending_chime_in (one-shot semantics).
  const body = (await req.json().catch(() => ({}))) as { reply?: string; dismissed?: boolean };
  const reply = (body.reply ?? "").trim();

  // Find the most recent un-outcomed row for this rep — that's the one
  // they're answering. If none, this is a no-op (chime already cleared).
  const { data: openRow } = await supabase
    .from("helper_chime_in_log")
    .select("id, payload")
    .eq("rep_id", session.repId)
    .is("outcome", null)
    .order("pushed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (openRow) {
    const updated = reply
      ? {
          outcome: "replied",
          outcome_at: new Date().toISOString(),
          payload: { ...(openRow.payload as object), reply_text: reply },
        }
      : { outcome: "dismissed", outcome_at: new Date().toISOString() };
    await supabase.from("helper_chime_in_log").update(updated).eq("id", openRow.id);
  }

  // Always clear pending_chime_in so the box doesn't re-fire.
  await supabase
    .from("helper_rep_state")
    .update({ pending_chime_in: null, updated_at: new Date().toISOString() })
    .eq("rep_id", session.repId);

  return NextResponse.json({ ok: true, captured: reply.length > 0 });
}
