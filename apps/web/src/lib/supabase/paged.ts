// Supabase/PostgREST silently caps any single select at 1000 rows — a bare
// .limit(50000) returns exactly 1000 with no error. Every read that expects
// more than a page must range-paginate. maxPages bounds Worker subrequests;
// order the query by impressions (descending) so if the cap ever truncates,
// it drops the long tail rather than an arbitrary slice.

export async function fetchPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
  maxPages = 10,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data } = await build(from, from + pageSize - 1);
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) return out;
  }
  return out;
}
