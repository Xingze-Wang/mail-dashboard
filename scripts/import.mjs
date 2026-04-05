import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

const resend = new Resend("re_BDAhnsct_HGFVYVjeVYSi9ZCi1BwbpDhA");
const supabase = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM"
);

async function importEmails() {
  let imported = 0;
  let skipped = 0;
  let page = 0;

  while (true) {
    page++;
    console.log(`Fetching page ${page}...`);

    const result = await resend.emails.list({ limit: 100 });

    if (result.error || !result.data) {
      console.error("Error:", result.error?.message);
      break;
    }

    const emails = result.data.data;
    if (!emails || emails.length === 0) {
      console.log("No more emails.");
      break;
    }

    console.log(`  Got ${emails.length} emails`);

    // Batch insert
    const rows = [];
    for (const email of emails) {
      // Check if exists
      const { data: existing } = await supabase
        .from("emails")
        .select("id")
        .eq("resend_id", email.id)
        .maybeSingle();

      if (existing) {
        skipped++;
        continue;
      }

      let status = "sent";
      if (email.last_event === "delivered") status = "delivered";
      else if (email.last_event === "opened") status = "opened";
      else if (email.last_event === "clicked") status = "clicked";
      else if (email.last_event === "bounced") status = "bounced";
      else if (email.last_event === "complained") status = "complained";

      rows.push({
        from: email.from,
        to: Array.isArray(email.to) ? email.to.join(", ") : (email.to || ""),
        subject: email.subject || "(no subject)",
        html: "",
        text: null,
        resend_id: email.id,
        status,
        created_at: email.created_at,
        updated_at: email.created_at,
        thread_id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      });
    }

    if (rows.length > 0) {
      const { error } = await supabase.from("emails").insert(rows);
      if (error) {
        console.error("  Insert error:", error.message);
      } else {
        imported += rows.length;
        console.log(`  Inserted ${rows.length} (total: ${imported})`);
      }
    } else {
      console.log(`  All ${emails.length} already exist`);
    }

    // Resend list API doesn't support cursor pagination well, break after first page
    // The API returns most recent 100 by default
    if (emails.length < 100) break;

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone! Imported: ${imported}, Skipped: ${skipped}`);
}

importEmails().catch(console.error);
