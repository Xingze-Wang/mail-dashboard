/**
 * paginateAll — drains a Supabase query past the silent 1000-row cap.
 *
 * THE BUG THIS SOLVES
 * Supabase REST defaults responses to 1000 rows max, regardless of
 * what the query asks for. There's no error, no warning. Every
 * .select() without explicit .range() pagination returns at most
 * 1000 rows. With 1443 leads in pipeline_leads (Q2 2026 scale),
 * that's a 30% silent under-count on every analytics surface.
 *
 * Symptom we hit: /insights H-index slice showed 148 emails when the
 * real number was 1000+. Cause: pipeline_leads load capped at 1000,
 * so the email→lead join Map was missing 443 leads, and emails to
 * those recipients fell into "(no lead data)" instead of their h_index
 * bucket. (See segment-funnels.ts.)
 *
 * USAGE
 *   const all = await paginateAll((from, to) =>
 *     supabase.from("pipeline_leads").select("id, author_email").range(from, to),
 *   );
 *
 * Caller passes a "build the query for THIS page" function. We
 * thread `from`/`to` indices through and accumulate rows. Stops when:
 *   - a page comes back smaller than pageSize (last page)
 *   - the supabase response errors
 *   - we hit MAX_ROWS (sanity stop)
 *
 * pageSize defaults to 1000 because that's the Supabase cap; smaller
 * doesn't help (you'd just do more round-trips for the same data).
 */

interface PaginateOpts {
  pageSize?: number;
  maxRows?: number;
}

const DEFAULT_PAGE = 1000;
const DEFAULT_MAX = 100_000;

/**
 * Caller's per-page builder returns whatever Supabase's chained
 * .select(...).range(...).eq(...) etc resolves to. We only care about
 * { data, error } at runtime — the structural type captures that
 * without forcing callers to assert PostgrestSingleResponse explicitly.
 */
type PageResult<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;

export async function paginateAll<T>(
  buildPage: (from: number, to: number) => PageResult<T>,
  opts: PaginateOpts = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE;
  const max = opts.maxRows ?? DEFAULT_MAX;
  const out: T[] = [];
  let cursor = 0;
  while (cursor < max) {
    const { data, error } = await buildPage(cursor, cursor + pageSize - 1);
    if (error) {
      console.error("[paginateAll] page error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    cursor += pageSize;
  }
  return out;
}
