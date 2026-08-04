import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Badge, Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { PendingButton } from "@/components/PendingButton";
import { RankCheckButton } from "@/components/RankCheckButton";
import { getServerClient } from "@/lib/supabase/server";
import { fetchUkLocations, normaliseDomain, resolveLocation, TopResult } from "@/lib/engine/serp";
import { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const PAGE = 1000; // Supabase caps a single select at 1000 rows
// Cards rendered per page-load; more via the "Show more" link. Kept modest
// because every card is real DOM — hundreds froze the browser.
const DISPLAY_STEP = 100;
// Below this many keywords it is far cheaper to ask for exactly a campaign's
// keywords than to pull the organisation's whole history and filter it in
// memory. Kept low because the ids travel in the request URL — a small
// campaign (the common case) costs one tiny query instead of paging tens of
// thousands of rows; bigger ones fall back to the org-wide fetch.
const SCOPED_MAX = 100;

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

/** Campaign id from a form, verified to belong to the caller's org — every
 * write lands inside one campaign, so a stale or forged id must not slip
 * rows into someone else's list. */
async function callerCampaign(
  formData: FormData,
): Promise<{ supabase: SupabaseClient; orgId: string; campaignId: string } | null> {
  const c = await caller();
  const campaignId = String(formData.get("campaign") ?? "");
  if (!c || !campaignId) return null;
  const { data } = await c.supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("organisation_id", c.orgId)
    .maybeSingle();
  return data ? { ...c, campaignId } : null;
}

const titleCase = (s: string) =>
  s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");

/** Campaigns are the tracker's unit of work: each owns its own domains and
 * keywords, and a check runs one campaign only. Same table as the site
 * groups on /sites, so a group can double as a tracker campaign. */
async function createCampaign(formData: FormData) {
  "use server";
  const c = await caller();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!c || !name) return;
  // Idempotent by name, like site groups: a double submit selects the
  // existing campaign rather than failing on the unique index.
  const { data: existing } = await c.supabase
    .from("campaigns")
    .select("id")
    .eq("organisation_id", c.orgId)
    .eq("name", name)
    .maybeSingle();
  let id = existing?.id as string | undefined;
  if (!id) {
    const { data } = await c.supabase
      .from("campaigns")
      .insert({ organisation_id: c.orgId, name })
      .select("id")
      .single();
    id = data?.id as string | undefined;
  }
  revalidatePath("/", "layout"); // campaigns also feed the global View selector
  if (id) redirect(`/rank-tracker?campaign=${id}`);
}

async function renameCampaign(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!c || !name) return;
  await c.supabase.from("campaigns").update({ name }).eq("id", c.campaignId);
  revalidatePath("/", "layout");
}

/** Deletes the campaign and, by cascade, its domains, keywords and their
 * ranking history. The page falls back to the first remaining campaign. */
async function deleteCampaign(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  if (!c) return;
  await c.supabase.from("campaigns").delete().eq("id", c.campaignId);
  revalidatePath("/", "layout");
  redirect("/rank-tracker");
}

/**
 * Lines of "domain", "domain <sep> town", or "domain <sep> town <sep>
 * check-from". The town feeds keyword wording; the optional check-from is
 * where DataForSEO simulates the searcher (postcode district like "BR1", or
 * any location it recognises). <sep> is a tab or comma; a plain space works
 * for the two-column form (towns may contain spaces).
 */
async function addDomains(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
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
  // Resolve each checkpoint against DataForSEO's UK location list (free call)
  // and store the canonical full name it gave back — so what gets searched is
  // settled here, at import time, rather than guessed at when a paid check
  // runs. Towns that only exist as "London Borough of X" resolve themselves.
  const locations = await fetchUkLocations();
  await c.supabase.from("tracked_domains").upsert(
    [...byDomain.values()].map((r) => {
      const checkpoint = r.serp ?? r.location;
      const resolved = checkpoint ? resolveLocation(locations, checkpoint) : null;
      return {
        organisation_id: c.orgId,
        campaign_id: c.campaignId,
        domain: r.domain,
        location: r.location,
        // Canonical when it resolved, otherwise exactly what was typed, so
        // the row still shows what needs correcting.
        serp_location: resolved ? resolved.name : r.serp,
        location_valid: resolved ? resolved.valid : null,
      };
    }),
    { onConflict: "campaign_id,domain" },
  );
  revalidatePath("/rank-tracker");
}

/** Expands keyword patterns across every town in this campaign. "{location}"
 * in a pattern becomes the town name; every generated keyword is checked FROM
 * its town. Patterns without the placeholder (e.g. "locksmith near me") are
 * generated once per town too — that's the point of local checking. */
async function generateKeywords(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
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
      .eq("campaign_id", c.campaignId)
      .not("location", "is", null)
      .order("id")
      .range(from, to),
  );
  // Keyword wording comes from the town; the SERP is fetched from the town's
  // checkpoint (serp_location — e.g. "BR1") when one was imported. Keyed on
  // town+checkpoint so two places sharing a name (Plaistow BR1 vs Plaistow
  // E13) each get their own keyword set, checked from their own area.
  const pairs = new Map<string, { town: string; checkpoint: string }>();
  for (const d of domains) {
    const town = (d.location as string).trim();
    if (!town) continue;
    const checkpoint = d.serp_location?.trim() || town;
    pairs.set(`${town.toLowerCase()}|${checkpoint.toLowerCase()}`, { town, checkpoint });
  }

  const rows: {
    organisation_id: string;
    campaign_id: string;
    keyword: string;
    location_name: string;
    location_valid: boolean | null;
  }[] = [];
  const base = { organisation_id: c.orgId, campaign_id: c.campaignId };
  const locations = await fetchUkLocations();
  if (pairs.size === 0) {
    const resolved = resolveLocation(locations, "United Kingdom");
    for (const p of patterns) {
      if (p.includes("{location}")) continue; // nothing to fill it with
      rows.push({
        ...base,
        keyword: p,
        location_name: resolved.name,
        location_valid: resolved.valid,
      });
    }
  } else {
    for (const { town, checkpoint } of pairs.values()) {
      // Imported checkpoints are already canonical full names; anything else
      // gets the suffix and is resolved here, so every keyword is stored with
      // the exact location its SERP will be fetched from.
      const resolved = resolveLocation(
        locations,
        checkpoint.includes(",") ? checkpoint : `${checkpoint},${suffix}`,
      );
      for (const p of patterns) {
        rows.push({
          ...base,
          keyword: p.replaceAll("{location}", town.toLowerCase()).replace(/\s+/g, " ").trim(),
          location_name: resolved.name,
          location_valid: resolved.valid,
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
      onConflict: "campaign_id,keyword,location_name",
      ignoreDuplicates: true,
    });
  }
  revalidatePath("/rank-tracker");
}

async function addKeywords(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  if (!c) return;
  const location = String(formData.get("location") ?? "").trim() || "United Kingdom";
  const lines = String(formData.get("keywords") ?? "")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  if (lines.length === 0) return;
  // Hand-typed locations get the same resolution as imported ones — this is
  // the path a single-site campaign uses, and an unrecognised location here
  // would fail every check in it.
  const resolved = resolveLocation(await fetchUkLocations(), location);
  await c.supabase.from("tracked_keywords").upsert(
    [...new Set(lines)].map((keyword) => ({
      organisation_id: c.orgId,
      campaign_id: c.campaignId,
      keyword,
      location_name: resolved.name,
      location_valid: resolved.valid,
    })),
    { onConflict: "campaign_id,keyword,location_name", ignoreDuplicates: true },
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

async function deleteAllKeywords(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  if (!c) return;
  await c.supabase.from("tracked_keywords").delete().eq("campaign_id", c.campaignId);
  revalidatePath("/rank-tracker");
}

/** Unlocks this campaign's failed checks for today so "Check rankings now"
 * retries them. serp_checks hangs off keywords, so the campaign filter is a
 * keyword-id list — chunked to keep the request URL sane. */
async function retryFailedChecks(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  if (!c) return;
  const today = new Date().toISOString().slice(0, 10);
  const keywordIds = await fetchAllRows<{ id: string }>((from, to) =>
    c.supabase
      .from("tracked_keywords")
      .select("id")
      .eq("campaign_id", c.campaignId)
      .order("id")
      .range(from, to),
  );
  for (let i = 0; i < keywordIds.length; i += 100) {
    await c.supabase
      .from("serp_checks")
      .delete()
      .eq("check_date", today)
      .not("error", "is", null)
      .in(
        "keyword_id",
        keywordIds.slice(i, i + 100).map((k) => k.id),
      );
  }
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
  const sort = typeof params.sort === "string" ? params.sort : "az";
  const limit = Math.min(Math.max(Number(params.limit) || DISPLAY_STEP, DISPLAY_STEP), 1000);
  const openId = typeof params.open === "string" ? params.open : "";

  const c = await caller();
  if (!c) {
    return (
      <EmptyState
        title="Sign in required"
        body="The rank tracker needs Supabase configured and a signed-in user."
      />
    );
  }

  const input =
    "rounded-md border border-edge bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1";
  const primaryBtn =
    "rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90";

  const { data: campaignRows } = await c.supabase
    .from("campaigns")
    .select("id, name")
    .eq("organisation_id", c.orgId)
    .order("name");
  const campaigns = (campaignRows ?? []) as { id: string; name: string }[];
  const requested = typeof params.campaign === "string" ? params.campaign : "";
  const campaign = campaigns.find((x) => x.id === requested) ?? campaigns[0] ?? null;

  const newCampaignForm = (
    <form action={createCampaign} className="flex flex-wrap items-center gap-2">
      <input
        name="name"
        required
        maxLength={80}
        placeholder="Campaign name (e.g. Bickley Locksmiths)"
        className={`${input} w-72`}
        aria-label="New campaign name"
      />
      <PendingButton pendingLabel="Creating…" className={primaryBtn}>
        Create campaign
      </PendingButton>
    </form>
  );

  if (!campaign) {
    return (
      <div>
        <PageHeader
          title="Rank tracker"
          subtitle="Organic Google positions, one campaign at a time. A campaign holds its own domains and keywords, and a check only ever runs the campaign you're looking at — so tracking one client costs one client's worth of checks."
        />
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-ink">Create your first campaign</div>
          {newCampaignForm}
          <p className="mt-2 text-xs text-muted">
            One campaign per client, network or experiment. You can add as many as you like and
            switch between them here; each keeps its own domains, keywords and ranking history.
          </p>
        </Card>
      </div>
    );
  }
  const campaignId = campaign.id;

  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 30);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  const [keywords, watchDomains, { data: sites }] = await Promise.all([
    fetchAllRows<{ id: string; keyword: string; location_name: string; location_valid: boolean | null }>(
      (from, to) =>
        c.supabase
          .from("tracked_keywords")
          .select("id, keyword, location_name, location_valid")
          .eq("campaign_id", campaignId)
          .order("keyword")
          .range(from, to),
    ),
    fetchAllRows<{ id: string; domain: string; location: string | null; serp_location: string | null; location_valid: boolean | null }>((from, to) =>
      c.supabase
        .from("tracked_domains")
        .select("id, domain, location, serp_location, location_valid")
        .eq("campaign_id", campaignId)
        .order("domain")
        .range(from, to),
    ),
    c.supabase.from("sites").select("id, domain").eq("organisation_id", c.orgId),
  ]);
  const keywordIds = new Set(keywords.map((k) => k.id));

  // Watched universe: exactly this campaign's domains. gsc marks the ones
  // that are also GSC-connected sites. homeKey matches a domain to the
  // keywords checked from its checkpoint (serp_location when set, town
  // otherwise); homeLabel is the display name.
  const gscDomains = new Set((sites ?? []).map((s) => normaliseDomain(s.domain as string)));
  const watched = new Map<
    string,
    { gsc: boolean; homeKey: string | null; homeLabel: string | null; homeTownLower: string | null }
  >();
  for (const w of watchDomains) {
    const d = normaliseDomain(w.domain);
    const homeKey = (w.serp_location ?? w.location)?.split(",")[0].trim().toLowerCase() || null;
    // "Plaistow (E13)" when the checkpoint differs from the town, so two
    // same-named places stay tellable apart in overlap chips.
    const town = w.location?.trim();
    const checkpoint = w.serp_location?.split(",")[0].trim();
    const homeLabel = town
      ? checkpoint && checkpoint.toLowerCase() !== town.toLowerCase()
        ? `${town} (${checkpoint})`
        : town
      : checkpoint || null;
    watched.set(d, {
      gsc: gscDomains.has(d),
      homeKey,
      homeLabel,
      homeTownLower: town?.toLowerCase() ?? null,
    });
  }
  const watchedTotal = watched.size;
  const gscCount = [...watched.values()].filter((w) => w.gsc).length;
  // A single-site campaign has one checkpoint; offer it as the default for
  // hand-added keywords, so they're searched from the site's own area rather
  // than the whole UK by accident.
  const checkpoints = [...new Set(watchDomains.map((w) => w.serp_location?.trim()).filter(Boolean))];
  const defaultLocation = checkpoints.length === 1 ? (checkpoints[0] as string) : "United Kingdom";

  // Latest check per keyword (last 30 days) + that day's rankings. Small
  // campaigns ask for their own keywords only; big ones page the org's rows
  // and filter, which is cheaper than a very long `in` list.
  const checks = !keywords.length
    ? []
    : keywords.length <= SCOPED_MAX
      ? await fetchAllRows<{ keyword_id: string; check_date: string; error: string | null; top_results: TopResult[] }>(
          (from, to) =>
            c.supabase
              .from("serp_checks")
              .select("keyword_id, check_date, error, top_results")
              .in("keyword_id", [...keywordIds])
              .gte("check_date", cutoff)
              .order("check_date", { ascending: false })
              .range(from, to),
        )
      : (
          await fetchAllRows<{ keyword_id: string; check_date: string; error: string | null; top_results: TopResult[] }>(
            (from, to) =>
              c.supabase
                .from("serp_checks")
                .select("keyword_id, check_date, error, top_results")
                .eq("organisation_id", c.orgId)
                .gte("check_date", cutoff)
                .order("check_date", { ascending: false })
                .range(from, to),
          )
        ).filter((r) => keywordIds.has(r.keyword_id));

  // In-flight tasks for THIS campaign — drives the progress banner below.
  const queued = keywords.length
    ? await fetchAllRows<{ keyword_id: string }>((from, to) =>
        c.supabase
          .from("serp_task_queue")
          .select("keyword_id")
          .eq("organisation_id", c.orgId)
          .order("keyword_id")
          .range(from, to),
      )
    : [];
  const inFlight = queued.filter((r) => keywordIds.has(r.keyword_id)).length;
  const collectedToday = checks.filter((r) => r.check_date === todayStr).length;

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
    ? (
        await fetchAllRows<{ keyword_id: string; domain: string; position: number; url: string | null; check_date: string }>(
          (from, to) => {
            const query = c.supabase
              .from("serp_rankings")
              .select("keyword_id, domain, position, url, check_date");
            return (
              keywords.length <= SCOPED_MAX
                ? query.in("keyword_id", [...keywordIds])
                : query.eq("organisation_id", c.orgId)
            )
              .in("check_date", latestDates)
              .order("id")
              .range(from, to);
          },
        )
      ).filter((r) => keywordIds.has(r.keyword_id))
    : [];
  const rankingsByKeyword = new Map<string, { domain: string; position: number; url: string }[]>();
  const prevPosition = new Map<string, number>(); // "keywordId|domain" -> previous position
  for (const r of rankings) {
    // Rankings are recorded for every domain the organisation watches, so a
    // sister campaign's domains show up here — this campaign only cares
    // about its own.
    if (!watched.has(r.domain)) continue;
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

  // Per-keyword rollup: the town's own site vs other campaign sites (overlap).
  // Home = same checkpoint as the keyword AND, when the keyword names a
  // specific town ("lock change brownswood park"), that exact town — so a
  // sister site sharing the postcode (Finsbury Park, also N4) counts as
  // overlap there, while generic keywords ("locksmith near me") keep every
  // site at that checkpoint as home.
  const townOf = (locationName: string) => locationName.split(",")[0].trim().toLowerCase();
  const summarised = keywords.map((k) => {
    const check = latestCheck.get(k.id) ?? null;
    const ranked = rankingsByKeyword.get(k.id) ?? [];
    const town = townOf(k.location_name);
    const candidates = [...watched.entries()].filter(([, w]) => w.homeKey === town);
    const textMatches = candidates.filter(
      ([, w]) => w.homeTownLower && k.keyword.includes(w.homeTownLower),
    );
    const homeSet = new Set((textMatches.length > 0 ? textMatches : candidates).map(([d]) => d));
    const home = ranked.find((r) => homeSet.has(r.domain)) ?? null;
    const overlap = ranked.filter((r) => !homeSet.has(r.domain) && watched.get(r.domain)?.homeKey);
    return { k, check, ranked, town, hasHome: homeSet.size > 0, homeSet, home, overlap };
  });

  // The text filter narrows EVERYTHING — stat tiles and view counts included —
  // so filtering to e.g. "plaistow" turns the tiles into that slice's summary.
  const qFiltered = q
    ? summarised.filter(
        (s) => s.k.keyword.includes(q) || s.k.location_name.toLowerCase().includes(q),
      )
    : summarised;

  const checkedRows = qFiltered.filter((s) => s.check && !s.check.error);
  const withHome = checkedRows.filter((s) => s.hasHome);
  const homeTop10 = withHome.filter((s) => s.home && s.home.position <= 10).length;
  const homeMissing = withHome.filter((s) => !s.home).length;
  const overlapRows = checkedRows.filter((s) => s.overlap.length > 0).length;

  const visible = qFiltered.filter((s) => {
    if (view === "missing") return s.hasHome && s.check && !s.check.error && !s.home;
    if (view === "overlap") return s.overlap.length > 0;
    if (view === "failed") return Boolean(s.check?.error);
    return true;
  });
  // Order: keywords come A–Z from the query; position sorts put #1s first
  // and push unranked/unchecked rows to the bottom.
  if (sort === "best") {
    visible.sort(
      (a, b) =>
        (a.ranked[0]?.position ?? 999) - (b.ranked[0]?.position ?? 999) ||
        a.k.keyword.localeCompare(b.k.keyword),
    );
  } else if (sort === "home") {
    visible.sort(
      (a, b) =>
        (a.home?.position ?? 999) - (b.home?.position ?? 999) ||
        a.k.keyword.localeCompare(b.k.keyword),
    );
  } else if (sort === "sites") {
    visible.sort(
      (a, b) => b.ranked.length - a.ranked.length || a.k.keyword.localeCompare(b.k.keyword),
    );
  }

  // Every link keeps the selected campaign — it is the page's outermost scope.
  const linkParams = (overrides: Record<string, string>) => {
    const merged: Record<string, string> = {
      campaign: campaignId,
      ...(q ? { q } : {}),
      ...(view !== "all" ? { view } : {}),
      ...(sort !== "az" ? { sort } : {}),
      ...overrides,
    };
    for (const key of Object.keys(merged)) if (!merged[key]) delete merged[key];
    const qs = new URLSearchParams(merged).toString();
    return `/rank-tracker${qs ? `?${qs}` : ""}`;
  };
  const viewLink = (v: string, label: string, count?: number) => (
    <Link
      href={linkParams({ view: v === "all" ? "" : v })}
      className={`rounded-md px-2 py-1 ${view === v ? "bg-page font-medium text-series-1" : "text-ink-2 hover:text-ink"}`}
    >
      {label}
      {count !== undefined && <span className="ml-1 tnum text-muted">{count}</span>}
    </Link>
  );
  const sortLink = (s: string, label: string) => (
    <Link
      href={linkParams({ sort: s === "az" ? "" : s })}
      className={`rounded-md px-2 py-1 ${sort === s ? "bg-page font-medium text-series-1" : "text-ink-2 hover:text-ink"}`}
    >
      {label}
    </Link>
  );

  return (
    <div>
      <PageHeader
        title="Rank tracker"
        subtitle={`${campaign.name} — one SERP check per keyword covers all ${watchedTotal} domains in this campaign at once. Checks run this campaign only; the weekly overnight sweep refreshes every campaign.`}
      >
        <span className="inline-flex items-center gap-2">
          {keywords.length > 0 && (
            <a
              href={`/api/rank-tracker/export${(() => {
                const p = new URLSearchParams({
                  campaign: campaignId,
                  ...(q ? { q } : {}),
                  ...(view !== "all" ? { view } : {}),
                  ...(sort !== "az" ? { sort } : {}),
                }).toString();
                return p ? `?${p}` : "";
              })()}`}
              title="Exports exactly what you're viewing — campaign, filter, view and order included"
              className="rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-ink hover:bg-page"
            >
              Export CSV{q || view !== "all" ? " (filtered)" : ""}
            </a>
          )}
          <RankCheckButton keywordCount={keywords.length} campaignId={campaignId} />
        </span>
      </PageHeader>

      {/* ── Campaign switcher ── */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Campaign</span>
        {campaigns.map((x) => (
          <Link
            key={x.id}
            href={`/rank-tracker?campaign=${x.id}`}
            className={`rounded-md border px-2 py-1 ${
              x.id === campaignId
                ? "border-series-1 bg-page font-medium text-series-1"
                : "border-edge text-ink-2 hover:text-ink"
            }`}
          >
            {x.name}
          </Link>
        ))}
        <details className="relative">
          <summary className="cursor-pointer select-none rounded-md border border-edge px-2 py-1 text-muted hover:text-ink">
            + New
          </summary>
          <div className="absolute left-0 z-10 mt-1 w-max rounded-md border border-edge bg-surface p-3 shadow-lg">
            {newCampaignForm}
          </div>
        </details>
      </div>

      {inFlight > 0 && (
        <Card className="mb-4 border-series-1/40 p-3 text-sm text-ink">
          <span className="font-medium">Rank check in progress:</span>{" "}
          <span className="tnum">
            {collectedToday} of {keywords.length} keywords collected · {inFlight} still processing
            at DataForSEO.
          </span>{" "}
          <span className="text-ink-2">
            Results land here as they finish (refresh the page to see the latest) — collection
            continues automatically every few minutes even if you leave or close the tab.
          </span>
        </Card>
      )}

      {(() => {
        // Locations Google will never be asked from. Worth stopping for: the
        // checks fail rather than returning the wrong town, but a run spent
        // on them is a run wasted.
        const bad = keywords.filter((k) => k.location_valid === false);
        if (bad.length === 0) return null;
        const names = [...new Set(bad.map((k) => k.location_name))];
        return (
          <Card className="mb-4 border-critical/40 p-3 text-sm text-ink">
            <span className="font-medium text-critical">
              {bad.length} {bad.length === 1 ? "keyword is" : "keywords are"} set to search from a
              location DataForSEO doesn&rsquo;t recognise
            </span>{" "}
            <span className="text-ink-2">
              ({names.slice(0, 4).join(" · ")}
              {names.length > 4 ? ` · +${names.length - 4} more` : ""}) — those checks will fail.
              Re-import the domain with a postcode district as its third column (e.g.
              &ldquo;domain, Bickley, BR1&rdquo;) and generate again, or re-add the keywords with a
              location spelled the way DataForSEO lists it.
            </span>
          </Card>
        );
      })()}

      {keywords.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label={q ? `Keywords matching “${q}”` : "Keywords tracked"}
            value={String(qFiltered.length)}
            detail={q ? `${checkedRows.length} checked · of ${keywords.length} total` : `${checkedRows.length} checked`}
          />
          <StatTile
            label="Home site in top 10"
            value={withHome.length ? `${homeTop10} / ${withHome.length}` : "—"}
            detail="town's own site ranking"
          />
          <StatTile label="Home site not ranking" value={String(homeMissing)} detail="not in the top 100" />
          <StatTile label="Keywords with overlap" value={String(overlapRows)} detail="other campaign sites in the SERP" />
        </div>
      )}

      {keywords.length === 0 ? (
        <EmptyState
          title={`No keywords in “${campaign.name}” yet`}
          body="Import this campaign's domains with their towns below, add keyword patterns, and the full keyword list generates itself. For a single site, import the one domain and add your handful of keywords by hand."
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {viewLink("all", "All", summarised.length)}
            {viewLink("missing", "Home site missing", homeMissing)}
            {viewLink("overlap", "Overlap", overlapRows)}
            {viewLink("failed", "Failed checks", summarised.filter((s) => s.check?.error).length)}
            {(() => {
              const failedToday = checks.filter((r) => r.error && r.check_date === todayStr).length;
              return failedToday > 0 ? (
                <form action={retryFailedChecks}>
                  <input type="hidden" name="campaign" value={campaignId} />
                  <PendingButton
                    pendingLabel="Unlocking…"
                    className="rounded-md border border-edge px-2 py-1 text-sm font-medium text-series-1 hover:bg-page"
                  >
                    Retry {failedToday} failed (then press Check rankings now)
                  </PendingButton>
                </form>
              ) : null;
            })()}
            <span className="ml-auto flex items-center gap-2">
              <form method="GET" className="flex items-center gap-2">
                <input type="hidden" name="campaign" value={campaignId} />
                {view !== "all" && <input type="hidden" name="view" value={view} />}
                {sort !== "az" && <input type="hidden" name="sort" value={sort} />}
                <input
                  name="q"
                  defaultValue={q}
                  placeholder="Filter by keyword or town… (Enter to apply)"
                  className={`${input} w-64`}
                  aria-label="Filter keywords"
                />
              </form>
              {q && (
                <Link
                  href={linkParams({ q: "" })}
                  className="whitespace-nowrap rounded-md border border-edge px-2 py-1 text-sm font-medium text-ink-2 hover:text-ink"
                >
                  Clear “{q.length > 14 ? `${q.slice(0, 14)}…` : q}” ✕
                </Link>
              )}
            </span>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Order by</span>
            {sortLink("az", "A–Z")}
            {sortLink("best", "Best position")}
            {sortLink("home", "Home position")}
            {sortLink("sites", "Sites ranking")}
          </div>

          <div className="space-y-3">
            {visible.slice(0, limit).map(({ k, check, ranked, hasHome, homeSet, home, overlap }) => {
              const rankedDomains = new Set(ranked.map((r) => r.domain));
              const notRankingCount = watchedTotal - rankedDomains.size;
              const isOpen = openId === k.id;
              const isHome = (domain: string) => homeSet.has(domain);
              return (
                <div key={k.id} id={`kw-${k.id}`}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="text-sm font-semibold text-ink">{k.keyword}</span>
                      <span
                        className={`ml-2 text-xs ${k.location_valid === false ? "text-critical" : "text-muted"}`}
                        title={`Google searched from ${k.location_name}`}
                      >
                        from {k.location_name}
                        {k.location_valid === false && " ⚠ not a DataForSEO location"}
                      </span>
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
                      {(isOpen ? ranked : ranked.slice(0, 20)).map((r) => (
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
                      {!isOpen && ranked.length > 20 && (
                        <span className="self-center text-xs text-muted">
                          +{ranked.length - 20} more in details ↓
                        </span>
                      )}
                    </div>
                  )}
                  {overlap.length > 0 && (
                    <p className="mt-1.5 text-xs text-ink-2">
                      Overlap: {overlap.length} other campaign {overlap.length === 1 ? "site ranks" : "sites rank"} in
                      this town&rsquo;s SERP.
                    </p>
                  )}

                  {check &&
                    !check.error &&
                    (isOpen ? (
                      <div className="mt-2.5 text-xs text-ink-2">
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
                        <div className="mt-2">
                          <div className="mb-1 font-medium text-ink">
                            Not in the top 100 ({notRankingCount}):
                          </div>
                          <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-4">
                            {[...watched.keys()]
                              .filter((d) => !rankedDomains.has(d))
                              .map((d) => (
                                <span key={d} className="truncate text-muted">
                                  {d}
                                </span>
                              ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <Link
                        href={`/rank-tracker?${new URLSearchParams({
                          campaign: campaignId,
                          ...(q ? { q } : {}),
                          ...(view !== "all" ? { view } : {}),
                          ...(sort !== "az" ? { sort } : {}),
                          ...(limit !== DISPLAY_STEP ? { limit: String(limit) } : {}),
                          open: k.id,
                        })}#kw-${k.id}`}
                        className="mt-2.5 block text-xs text-muted hover:text-ink"
                      >
                        Top of the SERP · {notRankingCount} watched domains not ranking →
                      </Link>
                    ))}
                </Card>
                </div>
              );
            })}
            {visible.length > limit && (
              <p className="text-xs text-muted">
                Showing {limit} of {visible.length} —{" "}
                <Link
                  href={`/rank-tracker?${new URLSearchParams({
                    campaign: campaignId,
                    ...(q ? { q } : {}),
                    ...(view !== "all" ? { view } : {}),
                    ...(sort !== "az" ? { sort } : {}),
                    limit: String(limit + DISPLAY_STEP),
                  })}`}
                  className="font-medium text-series-1 hover:underline"
                >
                  show {Math.min(DISPLAY_STEP, visible.length - limit)} more
                </Link>{" "}
                or use the filter box to narrow down.
              </p>
            )}
          </div>
        </>
      )}

      {/* ── Setup (everything here applies to the selected campaign) ── */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-ink">
            1 · Import domains with their towns
            <span className="ml-2 text-xs font-normal text-muted">
              {watchDomains.length} in {campaign.name}
              {gscCount > 0 && ` · ${gscCount} GSC-connected`}
            </span>
          </div>
          <form action={addDomains} className="space-y-2">
            <input type="hidden" name="campaign" value={campaignId} />
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
          <details className="mt-3 text-xs text-ink-2">
            <summary className="cursor-pointer select-none text-muted hover:text-ink">
              How the search location is decided
            </summary>
            <div className="mt-2 space-y-1.5">
              <p>
                DataForSEO accepts about 7,700 UK locations and matches the name{" "}
                <em>exactly</em>. Whatever you type is resolved against that list when you import,
                and the canonical name it comes back with is what gets stored and searched from —
                so the location is settled before any check is paid for, not guessed at during one.
              </p>
              <p>
                <span className="font-medium text-ink">Postcode districts are the safest.</span>{" "}
                BR1, E13, KT1 are all listed and unambiguous. Plenty of real places aren&rsquo;t on
                the list at all — Bickley, Plaistow and Kingston upon Thames have no entry — so a
                postcode district is the only way to search from them.
              </p>
              <p>
                <span className="font-medium text-ink">Boroughs resolve themselves.</span>{" "}
                &ldquo;Lewisham&rdquo; becomes &ldquo;London Borough of Lewisham&rdquo;, and
                &ldquo;Kensington and Chelsea&rdquo; the Royal Borough — you don&rsquo;t need the
                long form.
              </p>
              <p>
                <span className="font-medium text-ink">Shared names need spelling out.</span>{" "}
                Around 785 names cover more than one place (Richmond, Sheffield, Wakefield). Rather
                than pick one for you, those are flagged as unresolved — give the full form
                (&ldquo;Richmond,Greater London,England,United Kingdom&rdquo;) or a postcode
                district instead.
              </p>
            </div>
          </details>
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
                      {(() => {
                        // serp_location holds the canonical DataForSEO name;
                        // only its first segment is worth showing, and only
                        // when it differs from the town.
                        const checkpoint = w.serp_location?.split(",")[0].trim();
                        const town = w.location?.trim();
                        if (!town && !checkpoint) return null;
                        const differs = checkpoint && checkpoint.toLowerCase() !== town?.toLowerCase();
                        return (
                          <span
                            className={w.location_valid === false ? "text-critical" : "text-muted"}
                            title={w.serp_location ? `Searched from ${w.serp_location}` : undefined}
                          >
                            {" "}· {town ?? checkpoint}
                            {town && differs && ` (from ${checkpoint})`}
                            {w.location_valid === false && " ⚠"}
                          </span>
                        );
                      })()}
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
            <input type="hidden" name="campaign" value={campaignId} />
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
              Every pattern is generated for every town in this campaign and checked FROM that town
              — “near me” style patterns too. 5 patterns × 292 towns = 1,460 keywords (~$3 per full
              run); 5 patterns × 1 town = 5 keywords (a penny or two). Existing keywords are never
              duplicated.
            </p>
          </form>
          <details className="mt-3 text-xs text-ink-2">
            <summary className="cursor-pointer select-none text-muted hover:text-ink">
              Add one-off keywords manually / clear all
            </summary>
            <form action={addKeywords} className="mt-2 space-y-2">
              <input type="hidden" name="campaign" value={campaignId} />
              <textarea
                name="keywords"
                rows={3}
                placeholder={"one keyword per line"}
                className={`${input} w-full font-mono text-xs`}
                aria-label="Keywords, one per line"
              />
              <div className="flex flex-wrap items-center gap-2">
                <input
                  name="location"
                  defaultValue={defaultLocation}
                  className={`${input} w-80`}
                  aria-label="Search location"
                  title="Where Google is queried from — resolved against DataForSEO's location list when you add the keywords"
                />
                <PendingButton pendingLabel="Adding…" className={primaryBtn}>
                  Add keywords
                </PendingButton>
              </div>
              <p className="text-muted">
                Searched from{" "}
                <span className="font-medium text-ink">{defaultLocation}</span> unless you change
                it. A postcode district (BR1) or a borough name works; anything unrecognised is
                flagged above rather than checked.
              </p>
            </form>
            <form action={deleteAllKeywords} className="mt-2">
              <input type="hidden" name="campaign" value={campaignId} />
              <PendingButton pendingLabel="Deleting…" className="text-critical hover:underline">
                Delete every keyword in {campaign.name} (its ranking history goes with them)
              </PendingButton>
            </form>
          </details>
        </Card>
      </div>

      <details className="mt-4 text-xs text-ink-2">
        <summary className="cursor-pointer select-none text-muted hover:text-ink">
          Campaign settings — rename or delete “{campaign.name}”
        </summary>
        <div className="mt-2 flex flex-wrap items-center gap-6">
          <form action={renameCampaign} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="campaign" value={campaignId} />
            <input
              name="name"
              required
              maxLength={80}
              defaultValue={campaign.name}
              className={`${input} w-64`}
              aria-label="Campaign name"
            />
            <PendingButton pendingLabel="Saving…" className="font-medium text-series-1 hover:underline">
              Rename
            </PendingButton>
          </form>
          <form action={deleteCampaign}>
            <input type="hidden" name="campaign" value={campaignId} />
            <PendingButton pendingLabel="Deleting…" className="text-critical hover:underline">
              Delete this campaign — {watchDomains.length} domains, {keywords.length} keywords and
              all of their ranking history
            </PendingButton>
          </form>
        </div>
      </details>
    </div>
  );
}
