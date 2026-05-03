// /inbox is hidden — superseded by /emails (Sending + Receiving tabs).
// The original 688-line implementation lives at page.tsx.disabled in
// this directory; rename back to page.tsx if you want to restore it.
//
// We keep this file as a redirect so any old links / bookmarks /
// notifications that point at /inbox still land somewhere useful.

import { redirect } from "next/navigation";

export default function InboxRedirect() {
  redirect("/emails?tab=receiving");
}
