// Position history and check-to-check movement for the rank tracker.
//
// Nothing here talks to the network or the database: it all derives from rows
// already stored. serp_checks says WHEN a keyword was checked (and whether
// that check failed); serp_rankings says where each watched domain sat on
// that date. A domain with no serp_rankings row for a date did not appear in
// the organic top 100 that day — which is why "dropped out" has to be worked
// out by comparing two checks rather than read off a column.

export interface CheckRow {
  keyword_id: string;
  check_date: string;
  error: string | null;
  /** How far down the results this check looked. Null on rows written before
   * depth was configurable, when 100 was hard-coded — so null reads as 100. */
  depth?: number | null;
}

export interface RankingRow {
  keyword_id: string;
  domain: string;
  position: number;
  url: string | null;
  check_date: string;
}

export type MovementState =
  /** Nothing to compare against — this is the keyword's first check. */
  | "first"
  /** Ranked now, absent from the previous check. */
  | "new"
  /** Moved up the page (a lower position number). */
  | "improved"
  /** Moved down the page. */
  | "declined"
  /** Same position as last time. */
  | "held"
  /** Ranked last time, gone from the results now. */
  | "lost"
  /** Ranked last time at a position this check no longer reaches — the
   * campaign's depth was reduced, so this is a blind spot, not a fall. */
  | "out_of_range"
  /** Ranking now at a position the previous, shallower check could not have
   * seen. It may have been there all along; there is no way to tell. */
  | "unseen_before";

export interface Movement {
  domain: string;
  url: string;
  /** Position at the latest check; null when it no longer ranks. */
  position: number | null;
  /** Position at the check before it; null when it didn't rank then. */
  previous: number | null;
  /** previous − position. Positive = moved up. Null when there is nothing to
   * compare (first check, newly arrived, or dropped out). */
  change: number | null;
  state: MovementState;
}

/**
 * Check dates that actually produced positions, newest first, per keyword.
 *
 * Failed checks are deliberately not history: a DataForSEO error says nothing
 * about where a site ranked, so comparing against one would invent a drop.
 * Input may arrive in any order; (keyword_id, check_date) is unique in the
 * table, so no de-duplication is needed.
 */
export function successfulCheckDates(checks: CheckRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of checks) {
    if (row.error) continue;
    const list = out.get(row.keyword_id);
    if (list) list.push(row.check_date);
    else out.set(row.keyword_id, [row.check_date]);
  }
  // ISO dates sort lexicographically; newest first.
  for (const list of out.values()) list.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return out;
}

/**
 * Current vs previous positions for one keyword. Every domain in either check
 * gets a row, so a site that fell out of the results surfaces as "lost"
 * instead of quietly vanishing from the card.
 *
 * `previous` is null when the keyword has only ever been checked once — that
 * is different from "was absent last time", and the two must not look alike.
 *
 * `depths` matters whenever a campaign's depth setting has changed between
 * the two checks. Dropping from 100 to 20 would otherwise report every site
 * that sat at #21–100 as having crashed out overnight; those are reported as
 * blind spots instead. The reverse — a site appearing at #60 when the last
 * check only looked at 20 — is not treated as an arrival either.
 */
export function movement(
  current: Map<string, { position: number; url: string }>,
  previous: Map<string, number> | null,
  depths?: { current?: number | null; previous?: number | null },
): Movement[] {
  const nowDepth = depths?.current ?? null;
  const thenDepth = depths?.previous ?? null;
  const out: Movement[] = [];
  for (const [domain, now] of current) {
    if (!previous) {
      out.push({ domain, url: now.url, position: now.position, previous: null, change: null, state: "first" });
      continue;
    }
    const was = previous.get(domain) ?? null;
    // Absent last time, but beyond what last time could see: unknowable, so
    // it must not be sold as a new arrival.
    const beyondOldDepth = was === null && thenDepth !== null && now.position > thenDepth;
    out.push({
      domain,
      url: now.url,
      position: now.position,
      previous: was,
      change: was === null ? null : was - now.position,
      state:
        was === null
          ? beyondOldDepth
            ? "unseen_before"
            : "new"
          : was > now.position
            ? "improved"
            : was < now.position
              ? "declined"
              : "held",
    });
  }
  if (previous) {
    for (const [domain, was] of previous) {
      if (current.has(domain)) continue;
      // Was sitting deeper than this check bothered to look — a gap in what
      // we asked for, not a drop.
      const beyondNewDepth = nowDepth !== null && was > nowDepth;
      out.push({
        domain,
        url: "",
        position: null,
        previous: was,
        change: null,
        state: beyondNewDepth ? "out_of_range" : "lost",
      });
    }
  }
  // Best position first; dropped-out domains last, ordered by where they were.
  return out.sort(
    (a, b) =>
      (a.position ?? 1000) - (b.position ?? 1000) ||
      (a.previous ?? 1000) - (b.previous ?? 1000) ||
      a.domain.localeCompare(b.domain),
  );
}

/**
 * The best-placed of `domains` — the campaign's home site(s) for a keyword,
 * usually. A domain that still ranks always wins; when none do, the one that
 * ranked best last time is returned so the card can say "was #12, now
 * nowhere" rather than showing nothing at all.
 */
export function bestOf(movements: Movement[], domains: Set<string>): Movement | null {
  let ranked: Movement | null = null;
  let lost: Movement | null = null;
  for (const m of movements) {
    if (!domains.has(m.domain)) continue;
    if (m.position !== null) {
      if (!ranked || m.position < ranked.position!) ranked = m;
    } else if (m.previous !== null && (!lost || m.previous < lost.previous!)) {
      lost = m;
    }
  }
  return ranked ?? lost;
}

export interface HistoryPoint {
  date: string;
  /** null = checked that day, but not in the organic top 100. */
  position: number | null;
}

/**
 * One domain's position on each of `dates` (pass them newest first and that
 * is the order you get back). Dates with no ranking row become null — the
 * check ran, the domain simply wasn't there.
 */
export function series(rankings: RankingRow[], dates: string[], domain: string): HistoryPoint[] {
  const byDate = new Map<string, number>();
  for (const r of rankings) {
    if (r.domain !== domain) continue;
    const existing = byDate.get(r.check_date);
    if (existing === undefined || r.position < existing) byDate.set(r.check_date, r.position);
  }
  return dates.map((date) => ({ date, position: byDate.get(date) ?? null }));
}

/**
 * The depth each check was taken at, keyed "keywordId|date". `fallback` fills
 * in rows written before depth was recorded — the caller owns that value
 * because it is a property of the SERP engine, not of this arithmetic.
 */
export function depthByCheck(checks: CheckRow[], fallback: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of checks) {
    out.set(`${row.keyword_id}|${row.check_date}`, row.depth ?? fallback);
  }
  return out;
}

/** Rankings for one date, keyed by domain — the shape `movement` wants. */
export function positionsOn(
  rankings: RankingRow[],
  date: string | undefined,
  keep: (domain: string) => boolean,
): Map<string, { position: number; url: string }> {
  const out = new Map<string, { position: number; url: string }>();
  if (!date) return out;
  for (const r of rankings) {
    if (r.check_date !== date || !keep(r.domain)) continue;
    const existing = out.get(r.domain);
    if (!existing || r.position < existing.position) {
      out.set(r.domain, { position: r.position, url: r.url ?? "" });
    }
  }
  return out;
}
