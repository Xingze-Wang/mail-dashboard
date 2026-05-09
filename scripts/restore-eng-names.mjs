import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// The mapping. english_handle is the customer-facing + UI name; the
// canonical Han name stays accessible via lark_open_id → Lark API and
// is cached in lark_name (which we don't currently populate but will).
const REPS = [
  { id: 1, english_handle: "Leo" },
  { id: 2, english_handle: "Yujie" },
  { id: 3, english_handle: "Ethan" },
  { id: 5, english_handle: "Xingze" },
  { id: 7, english_handle: "Xuwen" },
];

for (const r of REPS) {
  const { error } = await sb
    .from("sales_reps")
    .update({
      name: r.english_handle,
      sender_name: r.english_handle,
      english_handle: r.english_handle,
    })
    .eq("id", r.id);
  if (error) {
    console.error(`rep_id=${r.id} update failed:`, error.message);
  } else {
    console.log(`✓ rep_id=${r.id} → name=${r.english_handle}`);
  }
}

// Verify
const { data: after } = await sb
  .from("sales_reps")
  .select("id, name, sender_name, english_handle, lark_open_id")
  .in("id", REPS.map(r => r.id))
  .order("id");
console.log("\n=== After ===");
for (const r of after ?? []) {
  console.log(`  rep_id=${r.id} name=${r.name} sender_name=${r.sender_name} english_handle=${r.english_handle} lark_bound=${!!r.lark_open_id}`);
}
