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

type ChimeIn = VoiceCaptureOfferChimeIn;

function renderMessage(chimeIn: ChimeIn, repName: string | null): string {
  const name = repName ?? "你";
  if (chimeIn.type === "voice_capture_offer") {
    return `${name}, 最近 ${chimeIn.window_days} 天改了 ${chimeIn.edit_count} 封草稿 (都是大改, 不是小修). 要不要我根据你改过的, 生成一份你自己的 intro 模板? 以后草稿就按你的风格来, 不用每次都重写.`;
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
  // Same as GET for v1 — rep dismissed without acting. Kept as a
  // distinct method so future analytics can tell "saw and ignored"
  // from "saw and engaged".
  return GET(req);
}
