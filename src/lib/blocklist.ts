// Hard-block list. A recipient or whole domain on this list is never sent
// to and never imported into the pipeline. Populated by hard flags from
// senior/admin and by manual entries through the settings page.

import { supabase } from "@/lib/db";

export interface BlockEntry {
  id: string;
  email: string | null;
  domain: string | null;
  reason: string;
  blocked_by: string;
  blocked_at: string;
}

/** Returns the matching block entry if email or its domain is blocked. */
export async function checkBlocked(email: string): Promise<BlockEntry | null> {
  const em = email.toLowerCase().trim();
  if (!em.includes("@")) return null;
  const domain = em.split("@")[1];

  const { data } = await supabase
    .from("blocked_contacts")
    .select("*")
    .or(`email.ilike.${em},domain.ilike.${domain}`)
    .limit(1)
    .maybeSingle();

  return (data as BlockEntry | null) ?? null;
}

/** Add a single email to the blocklist (idempotent on email). */
export async function blockEmail(email: string, reason: string, blockedBy: string): Promise<boolean> {
  const em = email.toLowerCase().trim();
  if (!em.includes("@")) return false;
  // upsert behavior — unique index on lower(email) handles dedup.
  const { error } = await supabase
    .from("blocked_contacts")
    .insert({ email: em, reason, blocked_by: blockedBy });
  // 23505 = unique violation = already blocked, treat as success.
  if (error && !String(error.code).includes("23505") && !String(error.message).includes("duplicate")) {
    return false;
  }
  return true;
}

/** Add a whole domain to the blocklist. */
export async function blockDomain(domain: string, reason: string, blockedBy: string): Promise<boolean> {
  const d = domain.toLowerCase().trim();
  if (!d || d.includes("@")) return false;
  const { error } = await supabase
    .from("blocked_contacts")
    .insert({ domain: d, reason, blocked_by: blockedBy });
  if (error && !String(error.code).includes("23505") && !String(error.message).includes("duplicate")) {
    return false;
  }
  return true;
}

export async function listBlocks(): Promise<BlockEntry[]> {
  const { data } = await supabase
    .from("blocked_contacts")
    .select("*")
    .order("blocked_at", { ascending: false })
    .limit(500);
  return (data as BlockEntry[]) ?? [];
}

export async function unblock(id: string): Promise<boolean> {
  const { error } = await supabase.from("blocked_contacts").delete().eq("id", id);
  return !error;
}
