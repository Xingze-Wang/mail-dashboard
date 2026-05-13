import { supabase } from "@/lib/db";
import type { PoolKey, PerPool } from "@/lib/pool-types";

const POOL_LABEL: Record<PoolKey, string> = {
  strong: "强势 (strong)",
  normal_cn: "国内 (normal CN)",
  normal_overseas: "海外 (normal overseas)",
  normal_edu: ".edu",
};

export interface NotifyInput {
  rep_id: number;
  due_date: string;
  per_pool_actual: PerPool;
  underfilled: PoolKey[];
  total_allocated: number;
}

/**
 * Send a per-rep DM summarizing today's allocation, then update
 * allocation_log.notification_status for the rep's rows on this date.
 */
export async function notifyRepOfAllocation(input: NotifyInput): Promise<"sent" | "failed" | "skipped_no_lark"> {
  if (input.total_allocated === 0) return "skipped_no_lark";

  const rep = await supabase
    .from("sales_reps")
    .select("name, lark_open_id")
    .eq("id", input.rep_id)
    .maybeSingle();
  if (!rep.data) return "failed";

  if (!rep.data.lark_open_id) {
    await markNotificationStatus(input.rep_id, input.due_date, "skipped_no_lark");
    return "skipped_no_lark";
  }

  const lines: string[] = [];
  lines.push(`早上好 ${rep.data.name} 👋`);
  lines.push(``);
  lines.push(`今天给你分了 ${input.total_allocated} 条 lead, 都在 /pipeline 等着. AI 已经拟好草稿, 你看一眼 OK 就 Send.`);
  lines.push(``);
  lines.push(`分布:`);
  for (const [k, v] of Object.entries(input.per_pool_actual) as Array<[PoolKey, number]>) {
    if (v > 0) lines.push(`  • ${POOL_LABEL[k]}: ${v} 条`);
  }
  if (input.underfilled.length > 0) {
    lines.push(``);
    lines.push(`(${input.underfilled.map((k) => POOL_LABEL[k]).join(", ")} 池子今天不够, 我先给了你能给的. 其余明天再补.)`);
  }
  lines.push(``);
  lines.push(`开始: https://calistamind.com/pipeline`);
  lines.push(`今日任务: https://calistamind.com/missions`);

  try {
    const { sendMessage } = await import("@/lib/lark");
    const r = await sendMessage({
      receive_id: rep.data.lark_open_id,
      receive_id_type: "open_id",
      text: lines.join("\n"),
    });
    const ok = r && r.ok === true;
    await markNotificationStatus(input.rep_id, input.due_date, ok ? "sent" : "failed");
    return ok ? "sent" : "failed";
  } catch (err) {
    console.error(`[allocation-notifier] send failed for rep ${input.rep_id}:`, err);
    await markNotificationStatus(input.rep_id, input.due_date, "failed");
    return "failed";
  }
}

async function markNotificationStatus(
  repId: number,
  dueDate: string,
  status: "sent" | "failed" | "skipped_no_lark",
): Promise<void> {
  await supabase
    .from("allocation_log")
    .update({
      notification_status: status,
      notification_sent_at: status === "sent" ? new Date().toISOString() : null,
    })
    .eq("rep_id", repId)
    .eq("due_date", dueDate)
    .is("notification_status", null);
}
