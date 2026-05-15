// Revert h_index/citation_count/paper_count writes from shard-26 for the 4 leads
// where pickAuthor returned partial(0.50) — the name tokens overlapped only on the
// surname, which is not enough disambiguation (Zichao ≠ Zi-yi, Lingjie ≠ Lin, etc).
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const TO_REVERT = [
  { id: "c25c8f84-83ee-48d1-a9a2-4a22fb165c0a", name: "Zichao Wei", reason: "matched Zi-yi Wei (different person)" },
  { id: "7789d685-538d-4606-ae36-85287c701e7f", name: "Lingjie Zeng", reason: "matched Lin Zeng (different person)" },
  { id: "b19aa643-9c41-46ab-9132-af8e5d753c71", name: "Jienan Lyu", reason: "matched Jie Lyu (different person)" },
  { id: "f8c7e4bf-fb1d-493f-94f7-679b66ccce30", name: "Kan Yang", reason: "matched Kang Yang (different person)" },
];

for (const r of TO_REVERT) {
  const { error } = await sb
    .from("pipeline_leads")
    .update({ h_index: null, citation_count: null, paper_count: null })
    .eq("id", r.id);
  console.log(JSON.stringify({ id: r.id.slice(0, 8), name: r.name, status: error ? `err:${error.message}` : "reverted", reason: r.reason }));
}
