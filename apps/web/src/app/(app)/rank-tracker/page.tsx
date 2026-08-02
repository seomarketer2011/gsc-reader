import { revalidatePath } from "next/cache";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { PendingButton } from "@/components/PendingButton";
import { RankCheckButton } from "@/components/RankCheckButton";
import { getServerClient } from "@/lib/supabase/server";
import { normaliseDomain, TopResult } from "@/lib/engine/serp";

export const dynamic = "force-dynamic";

async function caller() {
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

async function addDomains(formData: FormData) {
  "use server";
  const c = await caller();
  if (!c) return;
  const lines = String(formData.get("domains") ?? "")
    .split(/[\n,]+/)
    .map((l) => normaliseDomain(l))
    .filter((d) => d.includes("."));
  if (lines.length === 0) return;
  await c.supabase.from("tracked_domains").upsert(
    [...new Set(lines)].map((domain) => ({ organisation_id: c.orgId, domain })),
    { onConflict: "organisation_id,domain", ignoreDuplicates: true },
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

export default async function RankTrackerPage() {
  const c = await caller();
  if (!c) {
    return (
      <EmptyState
        title="Sign in required"
        body="The rank tracker needs Supabase configured and a signed-in user."
      />
    );
  }

  const [{ data: keywords }, { data: watchDomains }, { data: sites }] = await Promise.all([
    c.supabase
      .from("tracked_keywords")
      .select("id, keyword, location_name")
      .eq("organisation_id", c.orgId)
      .order("keyword"),
    c.supabase
      .from("tracked_domains")
      .select("id, domain")
      .eq("organisation_id", c.orgId)
      .order("domain"),
    c.supabase.from("sites").select("id, domain").eq("organisation_id", c.orgId),
  ]);

  // Watched universe: GSC-connected sites + the plain watch-list, deduped.
  const watched = new Map<string, { gsc: boolean }>();
  for (const s of sites ?? []) watched.set(normaliseDomain(s.domain as string), { gsc: true });
  for (const w of watchDomains ?? []) {
    const d = normaliseDomain(w.domain as string);
    if (!watched.has(d)) watched.set(d, { gsc: false });
  }
  const watchedTotal = watched.size;

  // Latest check + that day's rankings per keyword.
  const keywordIds = (keywords ?? []).map((k) => k.id as string);
  const { data: checks } = keywordIds.length
    ? await c.supabase
        .from("serp_checks")
        .select("keyword_id, check_date, error, top_results")
        .eq("organisation_id", c.orgId)
        .order("check_date", { ascending: false })
        .limit(5000)
    : { data: [] };
  const latestCheck = new Map<string, { date: string; error: string | null; top: TopResult[] }>();
  for (const row of checks ?? []) {
    const id = row.keyword_id as string;
    if (!latestCheck.has(id)) {
      latestCheck.set(id, {
        date: row.check_date as string,
        error: (row.error as string) ?? null,
        top: (row.top_results as TopResult[]) ?? [],
      });
    }
  }
  const latestDates = [...new Set([...latestCheck.values()].map((v) => v.date))];
  const { data: rankings } = latestDates.length
    ? await c.supabase
        .from("serp_rankings")
        .select("keyword_id, domain, position, url, check_date")
        .eq("organisation_id", c.orgId)
        .in("check_date", latestDates)
    : { data: [] };
  const rankingsByKeyword = new Map<string, { domain: string; position: number; url: string }[]>();
  for (const r of rankings ?? []) {
    const id = r.keyword_id as string;
    if ((r.check_date as string) !== latestCheck.get(id)?.date) continue;
    const list = rankingsByKeyword.get(id) ?? [];
    list.push({ domain: r.domain as string, position: r.position as number, url: (r.url as string) ?? "" });
    rankingsByKeyword.set(id, list);
  }
  for (const list of rankingsByKeyword.values()) list.sort((a, b) => a.position - b.position);

  const input =
    "rounded-md border border-edge bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1";

  return (
    <div>
      <PageHeader
        title="Rank tracker"
        subtitle={`Organic Google positions for every watched domain — one SERP check per keyword covers all ${watchedTotal} domains at once.`}
      >
        <RankCheckButton keywordCount={(keywords ?? []).length} />
      </PageHeader>

      {/* ── Results ── */}
      {(keywords ?? []).length === 0 ? (
        <EmptyState
          title="No keywords tracked yet"
          body="Paste your keywords and domains below, then press “Check rankings now”. Each keyword is checked once per day; re-running a finished day is free (it skips already-checked keywords)."
        />
      ) : (
        <div className="space-y-3">
          {(keywords ?? []).map((k) => {
            const check = latestCheck.get(k.id as string);
            const ranked = rankingsByKeyword.get(k.id as string) ?? [];
            const rankedDomains = new Set(ranked.map((r) => r.domain));
            const notRanking = [...watched.keys()].filter((d) => !rankedDomains.has(d));
            return (
              <Card key={k.id as string} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-sm font-semibold text-ink">{k.keyword as string}</span>
                    <span className="ml-2 text-xs text-muted">{k.location_name as string}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-ink-2">
                    {check ? (
                      check.error ? (
                        <Badge tone="critical">check failed</Badge>
                      ) : (
                        <>
                          <span className="tnum">
                            {ranked.length} of {watchedTotal} rank
                          </span>
                          {ranked[0] && (
                            <span>
                              best <span className="font-semibold text-ink">#{ranked[0].position}</span>{" "}
                              ({ranked[0].domain})
                            </span>
                          )}
                          <span className="text-muted">checked {check.date}</span>
                        </>
                      )
                    ) : (
                      <Badge tone="neutral">not checked yet</Badge>
                    )}
                    <form action={deleteKeyword}>
                      <input type="hidden" name="id" value={k.id as string} />
                      <PendingButton pendingLabel="…" className="text-muted hover:text-critical">
                        remove
                      </PendingButton>
                    </form>
                  </div>
                </div>

                {check?.error && (
                  <p className="mt-2 text-xs text-critical">
                    {check.error} — check the location name matches a DataForSEO location (e.g.
                    “London,England,United Kingdom” or just “United Kingdom”).
                  </p>
                )}

                {ranked.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {ranked.map((r) => (
                      <span
                        key={r.domain}
                        title={r.url}
                        className="inline-flex items-center gap-1 rounded-md border border-edge px-1.5 py-0.5 text-xs"
                      >
                        <Badge tone={positionTone(r.position)}>#{r.position}</Badge>
                        <span className="text-ink-2">{r.domain}</span>
                      </span>
                    ))}
                  </div>
                )}

                {check && !check.error && (
                  <details className="mt-2.5 text-xs text-ink-2">
                    <summary className="cursor-pointer select-none text-muted hover:text-ink">
                      Top of the SERP · {notRanking.length} watched {notRanking.length === 1 ? "domain" : "domains"} not ranking
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
        </div>
      )}

      {/* ── Setup: keywords and domains ── */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-ink">Add keywords</div>
          <form action={addKeywords} className="space-y-2">
            <textarea
              name="keywords"
              required
              rows={5}
              placeholder={"one keyword per line, e.g.\nemergency locksmith bromley\nlocksmith near me bickley"}
              className={`${input} w-full`}
              aria-label="Keywords, one per line"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input
                name="location"
                defaultValue="United Kingdom"
                className={`${input} w-72`}
                aria-label="Search location"
                title="DataForSEO location name, e.g. London,England,United Kingdom"
              />
              <PendingButton
                pendingLabel="Adding…"
                className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Add keywords
              </PendingButton>
            </div>
            <p className="text-xs text-muted">
              The location applies to the lines you paste (add batches per town for local accuracy —
              “Bromley,England,United Kingdom” style). Keywords are deduplicated automatically.
            </p>
          </form>
        </Card>

        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-ink">
            Watch-list domains
            <span className="ml-2 text-xs font-normal text-muted">
              {(watchDomains ?? []).length} added · {(sites ?? []).length} more from GSC-connected sites
            </span>
          </div>
          <form action={addDomains} className="space-y-2">
            <textarea
              name="domains"
              required
              rows={5}
              placeholder={"one URL or domain per line — no Google connection needed, e.g.\nhttps://www.boltfix-locksmiths.co.uk\nshield-locksmiths.co.uk"}
              className={`${input} w-full`}
              aria-label="Domains, one per line"
            />
            <PendingButton
              pendingLabel="Adding…"
              className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Add domains
            </PendingButton>
            <p className="text-xs text-muted">
              Rankings are checked for these AND for every GSC-connected site — duplicates merge by
              domain. Paste all 300 in one go; protocols, www and paths are stripped automatically.
            </p>
          </form>
          {(watchDomains ?? []).length > 0 && (
            <details className="mt-3 text-xs text-ink-2">
              <summary className="cursor-pointer select-none text-muted hover:text-ink">
                Manage watch-list ({(watchDomains ?? []).length})
              </summary>
              <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {(watchDomains ?? []).map((w) => (
                  <form key={w.id as string} action={deleteDomain} className="flex items-center justify-between gap-2">
                    <span className="truncate">{w.domain as string}</span>
                    <input type="hidden" name="id" value={w.id as string} />
                    <PendingButton pendingLabel="…" className="text-muted hover:text-critical">
                      remove
                    </PendingButton>
                  </form>
                ))}
              </div>
            </details>
          )}
        </Card>
      </div>
    </div>
  );
}
