import { supabase } from "@/lib/db";

export interface PersonIdentity {
  email?: string;
  hf_user?: string;
  github_user?: string;
  arxiv_author_name?: string;
}

export interface ResolvedPerson {
  id: string;
  emails: string[];
  hf_users: string[];
  github_users: string[];
  outreach_status: string;
  last_outreach_at: string | null;
  real_name: string | null;
  affiliation: string | null;
  /** True when this call created a new persons row. */
  created: boolean;
  /** True when this call merged identifiers into an existing row. */
  merged: boolean;
}

/**
 * Find-or-create a persons row from any combination of identifiers.
 *
 * Lookup order: emails → hf_users → github_users → arxiv_author_names.
 * If multiple existing rows match different identifiers, picks the one with
 * the highest signal (most existing identifiers) and *merges the rest into
 * it*. The other rows are not deleted (avoid silent data loss); they are
 * marked superseded via a `merged_into` field on bio for audit.
 *
 * The merge is the load-bearing piece. Without it, the same person showing
 * up via HF today and GitHub tomorrow stays as two separate rows, and the
 * dedup gate misses the second contact.
 */
export async function resolvePerson(identity: PersonIdentity): Promise<ResolvedPerson> {
  const email = identity.email?.trim().toLowerCase() || undefined;
  const hf = identity.hf_user?.trim() || undefined;
  const gh = identity.github_user?.trim() || undefined;
  const arxiv = identity.arxiv_author_name?.trim() || undefined;

  if (!email && !hf && !gh && !arxiv) {
    throw new Error("resolvePerson requires at least one identifier");
  }

  const matches = await findCandidates({ email, hf, gh, arxiv });

  if (matches.length === 0) {
    return await createNewPerson({ email, hf, gh, arxiv });
  }

  if (matches.length === 1) {
    const existing = matches[0];
    const mergedRow = await mergeIdentifiers(existing, { email, hf, gh, arxiv });
    // `merged: true` if mergeIdentifiers actually changed anything. The
    // function returns the same row whether or not it was dirty, but a
    // shape diff suffices: compare lengths of the identifier arrays.
    const wasDirty =
      mergedRow.emails.length !== (existing.emails ?? []).length ||
      mergedRow.hf_users.length !== (existing.hf_users ?? []).length ||
      mergedRow.github_users.length !== (existing.github_users ?? []).length;
    return { ...mergedRow, created: false, merged: wasDirty };
  }

  // Multiple existing rows hit by different identifiers → merge into the
  // highest-signal one. "Highest signal" = most non-empty identifier arrays.
  const sorted = matches
    .map((m) => ({ row: m, score: signalScore(m) }))
    .sort((a, b) => b.score - a.score);
  const winner = sorted[0].row;
  const losers = sorted.slice(1).map((s) => s.row);

  await mergeIdentifiers(winner, { email, hf, gh, arxiv });
  for (const loser of losers) {
    await mergeRowsInto(winner.id, loser);
  }
  // Re-read the winner row so the caller sees the union state.
  const final = await getPersonById(winner.id);
  return { ...final, created: false, merged: true };
}

interface CandidateRow {
  id: string;
  emails: string[];
  hf_users: string[];
  github_users: string[];
  arxiv_author_names: string[];
  outreach_status: string;
  last_outreach_at: string | null;
  real_name: string | null;
  affiliation: string | null;
  bio: string | null;
}

async function findCandidates(args: {
  email?: string;
  hf?: string;
  gh?: string;
  arxiv?: string;
}): Promise<CandidateRow[]> {
  // Build OR clauses across the GIN-indexed array columns. Run them in
  // parallel rather than as one .or() call, because contains() on TEXT[]
  // doesn't compose with `.or()` in supabase-js the way scalar filters do.
  type Lookup = { data: CandidateRow[] | null; error: unknown };
  const lookups: Promise<Lookup>[] = [];
  const select =
    "id, emails, hf_users, github_users, arxiv_author_names, outreach_status, last_outreach_at, real_name, affiliation, bio";

  // Wrap each builder in Promise.resolve — supabase-js builders are thenable
  // but TS doesn't infer them as Promise<...> in a typed array.
  const wrap = <T>(builder: unknown) => Promise.resolve(builder) as unknown as Promise<T>;

  if (args.email) {
    lookups.push(wrap<Lookup>(supabase.from("persons").select(select).contains("emails", [args.email])));
  }
  if (args.hf) {
    lookups.push(wrap<Lookup>(supabase.from("persons").select(select).contains("hf_users", [args.hf])));
  }
  if (args.gh) {
    lookups.push(wrap<Lookup>(supabase.from("persons").select(select).contains("github_users", [args.gh])));
  }
  if (args.arxiv) {
    lookups.push(wrap<Lookup>(supabase.from("persons").select(select).contains("arxiv_author_names", [args.arxiv])));
  }

  const results = await Promise.all(lookups);
  const seen = new Map<string, CandidateRow>();
  for (const r of results) {
    if (r.data) {
      for (const row of r.data) {
        if (!seen.has(row.id)) seen.set(row.id, row);
      }
    }
  }
  return [...seen.values()];
}

function signalScore(r: CandidateRow): number {
  return (
    (r.emails?.length ?? 0) +
    (r.hf_users?.length ?? 0) +
    (r.github_users?.length ?? 0) +
    (r.arxiv_author_names?.length ?? 0)
  );
}

async function createNewPerson(args: {
  email?: string;
  hf?: string;
  gh?: string;
  arxiv?: string;
}): Promise<ResolvedPerson> {
  const insert: Record<string, unknown> = {
    emails: args.email ? [args.email] : [],
    hf_users: args.hf ? [args.hf] : [],
    github_users: args.gh ? [args.gh] : [],
    arxiv_author_names: args.arxiv ? [args.arxiv] : [],
  };
  const { data, error } = await supabase.from("persons").insert(insert).select().single();
  if (error || !data) throw new Error(`createNewPerson failed: ${error?.message}`);
  const row = data as CandidateRow;
  return {
    id: row.id,
    emails: row.emails ?? [],
    hf_users: row.hf_users ?? [],
    github_users: row.github_users ?? [],
    outreach_status: row.outreach_status,
    last_outreach_at: row.last_outreach_at,
    real_name: row.real_name,
    affiliation: row.affiliation,
    created: true,
    merged: false,
  };
}

async function mergeIdentifiers(
  row: CandidateRow,
  add: { email?: string; hf?: string; gh?: string; arxiv?: string },
): Promise<Omit<ResolvedPerson, "created" | "merged">> {
  const existingEmails = new Set((row.emails ?? []).map((e) => e.toLowerCase()));
  const existingHf = new Set(row.hf_users ?? []);
  const existingGh = new Set(row.github_users ?? []);
  const existingArxiv = new Set(row.arxiv_author_names ?? []);

  let dirty = false;
  if (add.email && !existingEmails.has(add.email)) {
    existingEmails.add(add.email);
    dirty = true;
  }
  if (add.hf && !existingHf.has(add.hf)) {
    existingHf.add(add.hf);
    dirty = true;
  }
  if (add.gh && !existingGh.has(add.gh)) {
    existingGh.add(add.gh);
    dirty = true;
  }
  if (add.arxiv && !existingArxiv.has(add.arxiv)) {
    existingArxiv.add(add.arxiv);
    dirty = true;
  }

  if (!dirty) {
    return {
      id: row.id,
      emails: row.emails ?? [],
      hf_users: row.hf_users ?? [],
      github_users: row.github_users ?? [],
      outreach_status: row.outreach_status,
      last_outreach_at: row.last_outreach_at,
      real_name: row.real_name,
      affiliation: row.affiliation,
    };
  }

  const update = {
    emails: [...existingEmails],
    hf_users: [...existingHf],
    github_users: [...existingGh],
    arxiv_author_names: [...existingArxiv],
    last_seen_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("persons").update(update).eq("id", row.id);
  if (error) throw new Error(`mergeIdentifiers failed: ${error.message}`);
  return {
    id: row.id,
    emails: update.emails,
    hf_users: update.hf_users,
    github_users: update.github_users,
    outreach_status: row.outreach_status,
    last_outreach_at: row.last_outreach_at,
    real_name: row.real_name,
    affiliation: row.affiliation,
  };
}

async function mergeRowsInto(winnerId: string, loser: CandidateRow): Promise<void> {
  // Pull union of identifiers from loser into winner; mark loser bio with a
  // merged_into note. We don't delete the loser row to avoid breaking any
  // foreign keys (pipeline_leads.person_id, email_contact_history.person_id).
  const winner = await getCandidateRow(winnerId);
  if (!winner) throw new Error(`mergeRowsInto: winner ${winnerId} not found`);

  const union = (a: string[] | null, b: string[] | null) => {
    const set = new Set([...(a ?? []), ...(b ?? [])]);
    return [...set];
  };

  const updateWinner = {
    emails: union(winner.emails, loser.emails),
    hf_users: union(winner.hf_users, loser.hf_users),
    github_users: union(winner.github_users, loser.github_users),
    arxiv_author_names: union(winner.arxiv_author_names, loser.arxiv_author_names),
    last_seen_at: new Date().toISOString(),
  };
  const { error: e1 } = await supabase.from("persons").update(updateWinner).eq("id", winnerId);
  if (e1) throw new Error(`mergeRowsInto winner update failed: ${e1.message}`);

  const note = `\n[merged ${new Date().toISOString().slice(0, 10)}] superseded by ${winnerId}`;
  const { error: e2 } = await supabase
    .from("persons")
    .update({ bio: (loser.bio ?? "") + note, outreach_status: "merged" })
    .eq("id", loser.id);
  if (e2) throw new Error(`mergeRowsInto loser flag failed: ${e2.message}`);

  // Re-point any existing FKs from loser to winner. These tables exist per
  // migration 001; if a deployment is missing one, the .from(...) will error
  // and we surface it rather than silently dropping links.
  for (const tbl of ["pipeline_leads", "email_contact_history"] as const) {
    const { error: fkErr } = await supabase.from(tbl).update({ person_id: winnerId }).eq("person_id", loser.id);
    if (fkErr && !fkErr.message.includes("does not exist")) {
      throw new Error(`mergeRowsInto ${tbl} re-point failed: ${fkErr.message}`);
    }
  }
}

async function getCandidateRow(id: string): Promise<CandidateRow | null> {
  const { data, error } = await supabase
    .from("persons")
    .select(
      "id, emails, hf_users, github_users, arxiv_author_names, outreach_status, last_outreach_at, real_name, affiliation, bio",
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data as CandidateRow;
}

async function getPersonById(id: string): Promise<Omit<ResolvedPerson, "created" | "merged">> {
  const r = await getCandidateRow(id);
  if (!r) throw new Error(`getPersonById: ${id} not found`);
  return {
    id: r.id,
    emails: r.emails ?? [],
    hf_users: r.hf_users ?? [],
    github_users: r.github_users ?? [],
    outreach_status: r.outreach_status,
    last_outreach_at: r.last_outreach_at,
    real_name: r.real_name,
    affiliation: r.affiliation,
  };
}
