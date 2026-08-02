import Link from "next/link";
import { revalidatePath } from "next/cache";
import { Badge, Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { PendingButton } from "@/components/PendingButton";
import { RankCheckButton } from "@/components/RankCheckButton";
import { getServerClient } from "@/lib/supabase/server";
import { fetchUkTownIndex, normaliseDomain, TopResult } from "@/lib/engine/serp";
import { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const PAGE = 1000; // Supabase caps a single select at 1000 rows
const DISPLAY_CAP = 300;

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await build(from, from + PAGE - 1);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function caller(): Promise<{ supabase: SupabaseClient; orgId: string } | null> {
  const supabase = await getServerClient();
  if (!supabase) return null;
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  const { data: membership } = await supabase
    .from("organisation_users")
    .select("organisation_id")
    .eq("user_id", userData.user.id)
    .limit(1)
    .maybeSingle();
  return membership ? { supabase, orgId: membership.organisation_id as string } : null;
}

const titleCase = (s: string) =>
  s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");

/**
 * Lines of "domain", "domain <sep> town", or "domain <sep> town <sep>
 * check-from". The town feeds keyword wording; the optional check-from is
 * where DataForSEO simulates the searcher (postcode district like "BR1", or
 * any location it recognises). <sep> is a tab or comma; a plain space works
 * for the two-column form (towns may contain spaces).
 */
async function addDomains(formData: FormData) {
  "use server";
  const c = await caller();
  if (!c) return;
  const rows: { domain: string; location: string | null; serp: string | null }[] = [];
  for (const rawLine of String(formData.get("domains") ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let domainRaw: string, town: string, serp: string;
    if (/[\t,]/.test(line)) {
      const parts = line.split(/[\t,]/).map((p) => p.trim());
      [domainRaw, town = "", serp = ""] = parts;
    } else {
      const match = line.match(/^(\S+)\s*(.*)$/);
      domainRaw = match?.[1] ?? "";
      town = (match?.[2] ?? "").trim();
      serp = "";
    }
    const domain = normaliseDomain(domainRaw);
    if (!domain.includes(".")) continue;
    // Postcode districts ("br1" -> "BR1") uppercase; anything else title-case.
    const serpFormatted = !serp
      ? null
      : /^[a-z]{1,2}\d{1,2}[a-z]?$/i.test(serp)
        ? serp.toUpperCase()
        : titleCase(serp);
    rows.push({ domain, location: town ? titleCase(town) : null, serp: serpFormatted });
  }
  if (rows.length === 0) return;
  const byDomain = new Map(rows.map((r) => [r.domain, r]));
  // Validate checkpoints against DataForSEO's UK location list (free call) so
  // bad names surface at import time, not as failed paid checks later. Towns
  // that only exist as "London Borough of X" get resolved automatically.
  const townIndex = await fetchUkTownIndex();
  await c.supabase.from("tracked_domains").upsert(
    [...byDomain.values()].map((r) => {
      let serpLocation = r.serp;
      let valid: boolean | null = null;
      if (townIndex) {
        const checkpoint = (serpLocation ?? r.location ?? "").split(",")[0].trim().toLowerCase();
        if (checkpoint) {
          valid = townIndex.has(checkpoint);
          if (!valid && !serpLocation && r.location && townIndex.has(`london borough of ${checkpoint}`)) {
            serpLocation = `London Borough of ${r.location}`;
            valid = true;
          }
        }
      }
      return {
        organisation_id: c.orgId,
        domain: r.domain,
        location: r.location,
        serp_location: serpLocation,
        location_valid: valid,
      };
    }),
    { onConflict: "organisation_id,domain" },
  );
  revalidatePath("/rank-tracker");
}

/** Expands keyword patterns across every imported town. "{location}" in a
 * pattern becomes the town name; every generated keyword is checked FROM its
 * town. Patterns without the placeholder (e.g. "locksmith near me") are
 * generated once per town too — that's the point of local checking. */
async function generateKeywords(formData: FormData) {
  "use server";
  const c = await caller();
  if (!c) return;
  const patterns = String(formData.get("patterns") ?? "")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 30);
  const suffix = String(formData.get("suffix") ?? "").trim() || "England,United Kingdom";
  if (patterns.length === 0) return;

  const domains = await fetchAllRows<{ location: string | null; serp_location: string | null }>((from, to) =>
    c.supabase
      .from("tracked_domains")
      .select("location, serp_location")
      .eq("organisation_id", c.orgId)
      .not("location", "is", null)
      .order("id")
      .range(from, to),
  );
  // Keyword wording comes from the town; the SERP is fetched from the town's
  // checkpoint (serp_location — e.g. "BR1") when one was imported.
  const checkpointByTown = new Map<string, string>();
  for (const d of domains) {
    const town = (d.location as string).trim();
    if (!town) continue;
    if (!checkpointByTown.has(town)) checkpointByTown.set(town, d.serp_location?.trim() || town);
  }

  const rows: { organisation_id: string; keyword: string; location_name: string }[] = [];
  if (checkpointByTown.size === 0) {
    for (const p of patterns) {
      if (p.includes("{location}")) continue; // nothing to fill it with
      rows.push({ organisation_id: c.orgId, keyword: p, location_name: "United Kingdom" });
    }
  } else {
    for (const [town, checkpoint] of checkpointByTown) {
      const locationName = checkpoint.includes(",") ? checkpoint : `${checkpoint},${suffix}`;
      for (const p of patterns) {
        rows.push({
          organisation_id: c.orgId,
          keyword: p.replaceAll("{location}", town.toLowerCase()).replace(/\s+/g, " ").trim(),
          location_name: locationName,
        });
      }
    }
  }
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const key = `${r.keyword}|${r.location_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (let i = 0; i < unique.length; i += PAGE) {
    await c.supabase.from("tracked_keywords").upsert(unique.slice(i, i + PAGE), {
      onConflict: "organisation_id,keyword,location_name",
      ignoreDuplicates: true,
    });
  }
  revalidatePath("/rank-tracker");
}

async function addKeywords(formData: FormData) {
  "use server";
  const c = await caller();
  if (!c) return;
  const location = String(formData.get("location") ?? "").trim() || "United Kingdom";
  const lines = String(formData.get("keywords") ?? "")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  if (lines.length === 0) return;
  await c.supabase.from("tracked_keywords").upsert(
    [...new Set(lines)].map((keyword) => ({
      organisation_id: c.orgId,
      keyword,
      location_name: location,
    })),
    { onConflict: "organisation_id,keyword,location_name", ignoreDuplicates: true },
  );
  revalidatePath("/rank-tracker");
}

async function deleteKeyword(formData: FormData) {
  "use server";
  const c = await caller();
  const id = String(formData.get("id") ?? "");
  if (!c || !id) return;
  await c.supabase.from("tracked_keywords").delete().eq("id", id);
  revalidatePath("/rank-tracker");
}

async function deleteAllKeywords() {
  "use server";
  const c = await caller();
  if (!c) return;
  await c.supabase.from("tracked_keywords").delete().eq("organisation_id", c.orgId);
  revalidatePath("/rank-tracker");
}

async function deleteDomain(formData: FormData) {
  "use server";
  const c = await caller();
  const id = String(formData.get("id") ?? "");
  if (!c || !id) return;
  await c.supabase.from("tracked_domains").delete().eq("id", id);
  revalidatePath("/rank-tracker");
}

function positionTone(position: number): "good" | "blue" | "neutral" {
  if (position <= 3) return "good";
  if (position <= 10) return "blue";
  return "neutral";
}

export default async function RankTrackerPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim().toLowerCase() : "";
  const view = typeof params.view === "string" ? params.view : "all";

  const c = await caller();
  if (!c) {
    return (
      <EmptyState
        title="Sign in required"
        body="The rank tracker needs Supabase configured and a signed-in user."
      />
    );
  }

  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 30);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const [keywords, watchDomains, { data: sites }] = await Promise.all([
    fetchAllRows<{ id: string; keyword: string; location_name: string }>((from, to) =>
      c.supabase
        .from("tracked_keywords")
        .select("id, keyword, location_name")
        .eq("organisation_id", c.orgId)
        .order("keyword")
        .range(from, to),
    ),
    fetchAllRows<{ id: string; domain: string; location: string | null; serp_location: string | null; location_valid: boolean | null }>((from, to) =>
      c.supabase
        .from("tracked_domains")
        .select("id, domain, location, serp_location, location_valid")
        .eq("organisation_id", c.orgId)
        .order("domain")
        .range(from, to),
    ),
    c.supabase.from("sites").select("id, domain").eq("organisation_id", c.orgId),
  ]);

  // Watched universe: GSC-connected sites + watch-list, deduped by domain.
  // homeKey matches a domain to the keywords checked from its checkpoint
  // (serp_location when set, town otherwise); homeLabel is the display name.
  const watched = new Map<string, { gsc: boolean; homeKey: string | null; homeLabel: string | null }>();
  for (const s of sites ?? []) {
    watched.set(normaliseDomain(s.domain as string), { gsc: true, homeKey: null, homeLabel: null });
  }
  for (const w of watchDomains) {
    const d = normaliseDomain(w.domain);
    const homeKey = (w.serp_location ?? w.location)?.split(",")[0].trim().toLowerCase() || null;
    const homeLabel = w.location?.trim() || w.serp_location?.trim() || null;
    const existing = watched.get(d);
    if (existing) {
      existing.homeKey = homeKey ?? existing.homeKey;
      existing.homeLabel = homeLabel ?? existing.homeLabel;
    } else watched.set(d, { gsc: false, homeKey, homeLabel });
  }
  const watchedTotal = watched.size;

  // Latest check per keyword (last 30 days) + that day's rankings.
  const checks = keywords.length
    ? await fetchAllRows<{ keyword_id: string; check_date: string; error: string | null; top_results: TopResult[] }>(
        (from, to) =>
          c.supabase
            .from("serp_checks")
            .select("keyword_id, check_date, error, top_results")
            .eq("organisation_id", c.orgId)
            .gte("check_date", cutoff)
            .order("check_date", { ascending: false })
            .range(from, to),
      )
    : [];
  const latestCheck = new Map<string, { date: string; error: string | null; top: TopResult[] }>();
  const prevCheckDate = new Map<string, string>(); // keyword -> the check before the latest
  for (const row of checks) {
    if (!latestCheck.has(row.keyword_id)) {
      latestCheck.set(row.keyword_id, {
        date: row.check_date,
        error: row.error,
        top: row.top_results ?? [],
      });
    } else if (!prevCheckDate.has(row.keyword_id) && !row.error) {
      prevCheckDate.set(row.keyword_id, row.check_date);
    }
  }
  const latestDates = [
    ...new Set([...[...latestCheck.values()].map((v) => v.date), ...prevCheckDate.values()]),
  ];
  const rankings = latestDates.length
    ? await fetchAllRows<{ keyword_id: string; domain: string; position: number; url: string | null; check_date: string }>(
        (from, to) =>
          c.supabase
            .from("serp_rankings")
            .select("keyword_id, domain, position, url, check_date")
            .eq("organisation_id", c.orgId)
            .in("check_date", latestDates)
            .order("id")
            .range(from, to),
      )
    : [];
  const rankingsByKeyword = new Map<string, { domain: string; position: number; url: string }[]>();
  const prevPosition = new Map<string, number>(); // "keywordId|domain" -> previous position
  for (const r of rankings) {
    if (r.check_date === prevCheckDate.get(r.keyword_id)) {
      prevPosition.set(`${r.keyword_id}|${r.domain}`, r.position);
      continue;
    }
    if (r.check_date !== latestCheck.get(r.keyword_id)?.date) continue;
    const list = rankingsByKeyword.get(r.keyword_id) ?? [];
    list.push({ domain: r.domain, position: r.position, url: r.url ?? "" });
    rankingsByKeyword.set(r.keyword_id, list);
  }
  for (const list of rankingsByKeyword.values()) list.sort((a, b) => a.position - b.position);

  // Per-keyword rollup: the town's own site vs other network sites (overlap).
  const townOf = (locationName: string) => locationName.split(",")[0].trim().toLowerCase();
  const summarised = keywords.map((k) => {
    const check = latestCheck.get(k.id) ?? null;
    const ranked = rankingsByKeyword.get(k.id) ?? [];
    const town = townOf(k.location_name);
    const homeDomains = [...watched.entries()]
      .filter(([, w]) => w.homeKey === town)
      .map(([d]) => d);
    const homeSet = new Set(homeDomains);
    const home = ranked.find((r) => homeSet.has(r.domain)) ?? null;
    const overlap = ranked.filter((r) => !homeSet.has(r.domain) && watched.get(r.domain)?.homeKey);
    return { k, check, ranked, town, hasHome: homeDomains.length > 0, home, overlap };
  });

  const checkedRows = summarised.filter((s) => s.check && !s.check.error);
  const withHome = checkedRows.filter((s) => s.hasHome);
  const homeTop10 = withHome.filter((s) => s.home && s.home.position <= 10).length;
  const homeMissing = withHome.filter((s) => !s.home).length;
  const overlapRows = checkedRows.filter((s) => s.overlap.length > 0).length;

  const visible = summarised.filter((s) => {
    if (q && !s.k.keyword.includes(q) && !s.k.location_name.toLowerCase().includes(q)) return false;
    if (view === "missing") return s.hasHome && s.check && !s.check.error && !s.home;
    if (view === "overlap") return s.overlap.length > 0;
    if (view === "failed") return Boolean(s.check?.error);
    return true;
  });

  const viewLink = (v: string, label: string, count?: number) => (
    <Link
      href={`/rank-tracker?${new URLSearchParams({ ...(q ? { q } : {}), ...(v === "all" ? {} : { view: v }) })}`}
      className={`rounded-md px-2 py-1 ${view === v ? "bg-page font-medium text-series-1" : "text-ink-2 hover:text-ink"}`}
    >
      {label}
      {count !== undefined && <span className="ml-1 tnum text-muted">{count}</span>}
    </Link>
  );

  const input =
    "rounded-md border border-edge bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1";
  const primaryBtn =
    "rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90";

  return (
    <div>
      <PageHeader
        title="Rank tracker"
        subtitle={`Organic Google positions — one SERP check per keyword covers all ${watchedTotal} watched domains at once. Refreshes automatically overnight (02:00–06:00 UTC).`}
      >
        <span className="inline-flex items-center gap-2">
          {keywords.length > 0 && (
            <a
              href="/api/rank-tracker/export"
              className="rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-ink hover:bg-page"
            >
              Export CSV
            </a>
          )}
          <RankCheckButton keywordCount={keywords.length} />
        </span>
      </PageHeader>

      {keywords.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Keywords tracked" value={String(keywords.length)} detail={`${checkedRows.length} checked`} />
          <StatTile
            label="Home site in top 10"
            value={withHome.length ? `${homeTop10} / ${withHome.length}` : "—"}
            detail="town's own site ranking"
          />
          <StatTile label="Home site not ranking" value={String(homeMissing)} detail="not in the top 100" />
          <StatTile label="Keywords with overlap" value={String(overlapRows)} detail="other network sites in the SERP" />
        </div>
      )}

      {keywords.length === 0 ? (
        <EmptyState
          title="No keywords tracked yet"
          body="Import your domains with their towns below, add keyword patterns, and the full keyword list generates itself."
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {viewLink("all", "All", summarised.length)}
            {viewLink("missing", "Home site missing", homeMissing)}
            {viewLink("overlap", "Overlap", overlapRows)}
            {viewLink("failed", "Failed checks", summarised.filter((s) => s.check?.error).length)}
            <form className="ml-auto" method="GET">
              {view !== "all" && <input type="hidden" name="view" value={view} />}
              <input
                name="q"
                defaultValue={q}
                placeholder="Filter by keyword or town…"
                className={`${input} w-64`}
                aria-label="Filter keywords"
              />
            </form>
          </div>

          <div className="space-y-3">
            {visible.slice(0, DISPLAY_CAP).map(({ k, check, ranked, town, hasHome, home, overlap }) => {
              const rankedDomains = new Set(ranked.map((r) => r.domain));
              const notRanking = [...watched.keys()].filter((d) => !rankedDomains.has(d));
              const isHome = (domain: string) => watched.get(domain)?.homeKey === town;
              return (
                <Card key={k.id} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="text-sm font-semibold text-ink">{k.keyword}</span>
                      <span className="ml-2 text-xs text-muted">{k.location_name}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-ink-2">
                      {check ? (
                        check.error ? (
                          <Badge tone="critical">check failed</Badge>
                        ) : (
                          <>
                            {hasHome &&
                              (home ? (
                                <Badge tone={positionTone(home.position)}>home #{home.position}</Badge>
                              ) : (
                                <Badge tone="warning">home site not ranking</Badge>
                              ))}
                            <span className="tnum">
                              {ranked.length} of {watchedTotal} rank
                            </span>
                            <span className="text-muted">checked {check.date}</span>
                          </>
                        )
                      ) : (
                        <Badge tone="neutral">not checked yet</Badge>
                      )}
                      <form action={deleteKeyword}>
                        <input type="hidden" name="id" value={k.id} />
                        <PendingButton pendingLabel="…" className="text-muted hover:text-critical">
                          remove
                        </PendingButton>
                      </form>
                    </div>
                  </div>

                  {check?.error && (
                    <p className="mt-2 text-xs text-critical">
                      {check.error} — check the location matches a DataForSEO location name (e.g.
                      “Bromley,England,United Kingdom”).
                    </p>
                  )}

                  {ranked.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {ranked.map((r) => (
                        <span
                          key={r.domain}
                          title={r.url}
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs ${
                            isHome(r.domain) ? "border-series-1" : "border-edge"
                          }`}
                        >
                          <Badge tone={positionTone(r.position)}>#{r.position}</Badge>
                          {(() => {
                            const prev = prevPosition.get(`${k.id}|${r.domain}`);
                            if (prev !== undefined && prev !== r.position) {
                              return prev > r.position ? (
                                <span className="tnum font-medium text-delta-good">▲{prev - r.position}</span>
                              ) : (
                                <span className="tnum font-medium text-critical">▼{r.position - prev}</span>
                              );
                            }
                            if (prev === undefined && prevCheckDate.has(k.id)) {
                              return <span className="font-medium text-series-1">new</span>;
                            }
                            return null;
                          })()}
                          <span className="text-ink-2">{r.domain}</span>
                          {isHome(r.domain) && <span className="font-medium text-series-1">home</span>}
                          {!isHome(r.domain) && watched.get(r.domain)?.homeLabel && (
                            <span className="text-muted">
                              from {watched.get(r.domain)!.homeLabel}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {overlap.length > 0 && (
                    <p className="mt-1.5 text-xs text-ink-2">
                      Overlap: {overlap.length} other network {overlap.length === 1 ? "site ranks" : "sites rank"} in
                      this town&rsquo;s SERP.
                    </p>
                  )}

                  {check && !check.error && (
                    <details className="mt-2.5 text-xs text-ink-2">
                      <summary className="cursor-pointer select-none text-muted hover:text-ink">
                        Top of the SERP · {notRanking.length} watched domains not ranking
                      </summary>
                      {check.top.length > 0 && (
                        <ol className="mt-2 space-y-0.5">
                          {check.top.map((t) => (
                            <li key={t.position} className="truncate">
                              <span className="tnum font-medium text-ink">#{t.position}</span>{" "}
                              <span className={watched.has(t.domain) ? "font-semibold text-series-1" : ""}>
                                {t.domain}
                              </span>{" "}
                              <span className="text-muted">— {t.title}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                      {notRanking.length > 0 && (
                        <div className="mt-2">
                          <div className="mb-1 font-medium text-ink">Not in the top 100:</div>
                          <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-4">
                            {notRanking.map((d) => (
                              <span key={d} className="truncate text-muted">
                                {d}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </details>
                  )}
                </Card>
              );
            })}
            {visible.length > DISPLAY_CAP && (
              <p className="text-xs text-muted">
                Showing the first {DISPLAY_CAP} of {visible.length} — use the filter box to narrow down.
              </p>
            )}
          </div>
        </>
      )}

      {/* ── Setup ── */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-ink">
            1 · Import domains with their towns
            <span className="ml-2 text-xs font-normal text-muted">
              {watchDomains.length} imported · {(sites ?? []).length} from GSC
            </span>
          </div>
          <form action={addDomains} className="space-y-2">
            <textarea
              name="domains"
              required
              rows={6}
              placeholder={"domain, town — and optionally a third column for WHERE to check from\n(postcode district works best):\nbr1locksmithbickley.co.uk, Bickley, BR1\nboltfix-locksmiths.co.uk, Croydon\nshield-locksmiths.co.uk\tKingston upon Thames\tKT1"}
              className={`${input} w-full font-mono text-xs`}
              aria-label="Domains with towns, one per line"
            />
            <PendingButton pendingLabel="Importing…" className={primaryBtn}>
              Import domains
            </PendingButton>
            <p className="text-xs text-muted">
              The town words the keywords (&ldquo;locksmith bickley&rdquo;); the optional third
              column is where Google is queried from — a postcode district like BR1 is the most
              precise and covers small areas DataForSEO has no town entry for. London boroughs
              (Lewisham, Hackney…) resolve automatically. Tabs, commas or a space all separate
              columns; re-importing a domain updates it; everything is validated as you import.
            </p>
          </form>
          {watchDomains.some((w) => w.location_valid === false) && (
            <p className="mt-2 text-xs text-critical">
              {watchDomains.filter((w) => w.location_valid === false).length} imported{" "}
              {watchDomains.filter((w) => w.location_valid === false).length === 1
                ? "town isn't a"
                : "towns aren't"}{" "}
              recognised DataForSEO location (marked ⚠ below) — re-import those rows with a
              postcode district as a third column (e.g. &ldquo;domain, Bickley, BR1&rdquo;) before
              generating keywords. The keyword wording keeps the town; only the checkpoint changes.
            </p>
          )}
          {watchDomains.length > 0 && (
            <details className="mt-3 text-xs text-ink-2">
              <summary className="cursor-pointer select-none text-muted hover:text-ink">
                Manage imported domains ({watchDomains.length})
              </summary>
              <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {watchDomains.map((w) => (
                  <form key={w.id} action={deleteDomain} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {w.domain}
                      {(w.location || w.serp_location) && (
                        <span className={w.location_valid === false ? "text-critical" : "text-muted"}>
                          {" "}· {w.location ?? w.serp_location}
                          {w.serp_location && w.location && ` (from ${w.serp_location})`}
                          {w.location_valid === false && " ⚠"}
                        </span>
                      )}
                    </span>
                    <input type="hidden" name="id" value={w.id} />
                    <PendingButton pendingLabel="…" className="text-muted hover:text-critical">
                      remove
                    </PendingButton>
                  </form>
                ))}
              </div>
            </details>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-ink">2 · Generate keywords from patterns</div>
          <form action={generateKeywords} className="space-y-2">
            <textarea
              name="patterns"
              required
              rows={6}
              placeholder={"One pattern per line — {location} becomes each town:\nlocksmith {location}\nemergency locksmith {location}\nlock repairs {location}\nlocksmith near me\n24 hour locksmith"}
              className={`${input} w-full font-mono text-xs`}
              aria-label="Keyword patterns, one per line"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input
                name="suffix"
                defaultValue="England,United Kingdom"
                className={`${input} w-64`}
                aria-label="Location suffix"
                title="Appended to each town to form the DataForSEO location"
              />
              <PendingButton pendingLabel="Generating…" className={primaryBtn}>
                Generate keywords
              </PendingButton>
            </div>
            <p className="text-xs text-muted">
              Every pattern is generated for every imported town and checked FROM that town —
              “near me” style patterns too. 5 patterns × 292 towns = 1,460 keywords (~$3 per full
              run). Existing keywords are never duplicated.
            </p>
          </form>
          <details className="mt-3 text-xs text-ink-2">
            <summary className="cursor-pointer select-none text-muted hover:text-ink">
              Add one-off keywords manually / clear all
            </summary>
            <form action={addKeywords} className="mt-2 space-y-2">
              <textarea
                name="keywords"
                rows={3}
                placeholder={"one keyword per line"}
                className={`${input} w-full font-mono text-xs`}
                aria-label="Keywords, one per line"
              />
              <div className="flex flex-wrap items-center gap-2">
                <input name="location" defaultValue="United Kingdom" className={`${input} w-64`} aria-label="Search location" />
                <PendingButton pendingLabel="Adding…" className={primaryBtn}>
                  Add keywords
                </PendingButton>
              </div>
            </form>
            <form action={deleteAllKeywords} className="mt-2">
              <PendingButton pendingLabel="Deleting…" className="text-critical hover:underline">
                Delete ALL tracked keywords (their ranking history goes with them)
              </PendingButton>
            </form>
          </details>
        </Card>
      </div>
    </div>
  );
}
