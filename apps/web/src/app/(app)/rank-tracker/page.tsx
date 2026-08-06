import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Badge, Card, EmptyState, PageHeader, StatTile } from "@/components/ui";
import { PendingButton } from "@/components/PendingButton";
import { RankCheckButton } from "@/components/RankCheckButton";
import { getServerClient } from "@/lib/supabase/server";
import {
  costAtDepth,
  COST_PER_PAGE,
  DEFAULT_DEPTH,
  DEPTH_CHOICES,
  normalisePriority,
  fetchUkLocations,
  normaliseDepth,
  normaliseDomain,
  resolveLocation,
  TopResult,
} from "@/lib/engine/serp";
import {
  bestOf,
  depthByCheck,
  Movement,
  movement,
  positionsOn,
  RankingRow,
  series,
  successfulCheckDates,
} from "@/lib/engine/rank-history";
import { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const PAGE = 1000; // Supabase caps a single select at 1000 rows
// How far back the movement comparison looks. Two checks a month apart are
// still worth comparing; older than this and "since last check" stops meaning
// anything useful.
const HISTORY_DAYS = 30;
// The expanded card shows one keyword's full run of checks, which is a single
// cheap query — so it reaches back further than the summary does.
const KEYWORD_HISTORY_DAYS = 180;
/** "$2.86" for a run of this many keywords at this depth and priority. */
const runCost = (keywords: number, depth: number, priority = 1) =>
  `$${(keywords * costAtDepth(depth, priority)).toFixed(2)}`;
const COST_PER_PAGE_LABEL = COST_PER_PAGE.toFixed(4);
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

/**
 * Campaign id from a form, resolved to the campaign's OWN organisation.
 *
 * Deliberately not matched against a separately-looked-up "current" org:
 * organisation_users is read with limit(1) and no ordering, so a user who
 * belongs to more than one organisation can get a different answer on two
 * requests — and every campaign write would then silently do nothing. The
 * campaign row carries the organisation, and RLS only returns campaigns in
 * organisations the caller belongs to, so reading it is both simpler and
 * the stricter check.
 */
async function callerCampaign(
  formData: FormData,
): Promise<{ supabase: SupabaseClient; orgId: string; campaignId: string } | null> {
  const supabase = await getServerClient();
  const campaignId = String(formData.get("campaign") ?? "");
  if (!supabase || !campaignId) return null;
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  const { data } = await supabase
    .from("campaigns")
    .select("id, organisation_id")
    .eq("id", campaignId)
    .maybeSingle();
  return data
    ? { supabase, orgId: data.organisation_id as string, campaignId }
    : null;
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

/**
 * How far down the results this campaign's checks look — the one setting that
 * changes what a run costs, because DataForSEO bills by the page of ten it
 * had to fetch. Stored per campaign, and stamped onto every check from here
 * on, so reducing it later can be told apart from sites actually falling out.
 */
async function setCampaignDepth(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  if (!c) return;
  const depth = normaliseDepth(Number(formData.get("depth")));
  await c.supabase.from("campaigns").update({ serp_depth: depth }).eq("id", c.campaignId);
  revalidatePath("/rank-tracker");
}

/** Standard queue (1) or high-priority queue (2, exactly double the cost).
 * Separate DataForSEO crawler pools that fail independently — the escape
 * hatch for the nights the standard pool sits on tasks for hours. */
async function setCampaignPriority(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  if (!c) return;
  const priority = normalisePriority(Number(formData.get("priority")));
  await c.supabase.from("campaigns").update({ serp_priority: priority }).eq("id", c.campaignId);
  revalidatePath("/rank-tracker");
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

/**
 * Re-resolves every location already in this campaign against DataForSEO's
 * current list — the answer to "are my existing keywords searching from the
 * right place?" without re-importing anything. Domains go first because
 * keyword locations are derived from their checkpoints, so both end up on
 * the same canonical spelling and home-site matching stays intact.
 */
async function revalidateLocations(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  if (!c) return;
  const locations = await fetchUkLocations();
  if (!locations) return; // lookup unavailable — leave everything untouched

  const domains = await fetchAllRows<{ location: string | null; serp_location: string | null }>(
    (from, to) =>
      c.supabase
        .from("tracked_domains")
        .select("location, serp_location")
        .eq("campaign_id", c.campaignId)
        .order("id")
        .range(from, to),
  );
  // Rows carrying a checkpoint, grouped by it; then rows that have only a
  // town, which resolve into a checkpoint for the first time.
  const withCheckpoint = new Set(
    domains.map((d) => d.serp_location?.trim()).filter((v): v is string => Boolean(v)),
  );
  for (const checkpoint of withCheckpoint) {
    const r = resolveLocation(locations, checkpoint);
    await c.supabase
      .from("tracked_domains")
      .update({ serp_location: r.name, location_valid: r.valid })
      .eq("campaign_id", c.campaignId)
      .eq("serp_location", checkpoint);
  }
  const townOnly = new Set(
    domains
      .filter((d) => !d.serp_location?.trim())
      .map((d) => d.location?.trim())
      .filter((v): v is string => Boolean(v)),
  );
  for (const town of townOnly) {
    const r = resolveLocation(locations, town);
    await c.supabase
      .from("tracked_domains")
      .update({ serp_location: r.name, location_valid: r.valid })
      .eq("campaign_id", c.campaignId)
      .is("serp_location", null)
      .eq("location", town);
  }

  const keywords = await fetchAllRows<{ location_name: string }>((from, to) =>
    c.supabase
      .from("tracked_keywords")
      .select("location_name")
      .eq("campaign_id", c.campaignId)
      .order("id")
      .range(from, to),
  );
  for (const location of new Set(keywords.map((k) => k.location_name))) {
    const r = resolveLocation(locations, location);
    const { error } = await c.supabase
      .from("tracked_keywords")
      .update({ location_name: r.name, location_valid: r.valid })
      .eq("campaign_id", c.campaignId)
      .eq("location_name", location);
    // Two spellings can resolve to the same canonical name, which collides
    // with (campaign_id, keyword, location_name). Record the verdict without
    // the rename and leave the duplicates for the operator to remove.
    if (error) {
      await c.supabase
        .from("tracked_keywords")
        .update({ location_valid: r.valid })
        .eq("campaign_id", c.campaignId)
        .eq("location_name", location);
    }
  }
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

/**
 * Forgets this campaign's in-flight DataForSEO tasks so a new check can be
 * started. Only for tasks that are genuinely stuck: a queue row makes its
 * keyword ineligible for re-posting (that is what stops a double-charge), so
 * a row whose task never comes back would otherwise block the keyword until
 * collection expires it 24 hours later. Nothing already collected is touched.
 */
async function clearStuckChecks(formData: FormData) {
  "use server";
  const c = await callerCampaign(formData);
  if (!c) return;
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
      .from("serp_task_queue")
      .delete()
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

/**
 * How one domain moved since the keyword's previous check. Renders nothing
 * when there is genuinely nothing to say — a first check, or a position that
 * held — so an unchanged SERP stays quiet instead of filling with noise.
 */
function MovementMark({ m, verbose = false }: { m: Movement; verbose?: boolean }) {
  const from = m.previous === null ? "" : ` from #${m.previous}`;
  if (m.state === "improved") {
    return (
      <span className="tnum font-medium text-delta-good" title={`Was #${m.previous} at the previous check`}>
        ▲{m.change}
        {verbose && from}
      </span>
    );
  }
  if (m.state === "declined") {
    return (
      <span className="tnum font-medium text-critical" title={`Was #${m.previous} at the previous check`}>
        ▼{Math.abs(m.change ?? 0)}
        {verbose && from}
      </span>
    );
  }
  if (m.state === "new") {
    return (
      <span className="font-medium text-series-1" title="Not in the results at the previous check">
        new
      </span>
    );
  }
  if (m.state === "lost") {
    return (
      <span className="tnum font-medium text-critical" title={`Was #${m.previous}, now outside the checked results`}>
        dropped{verbose ? from : ` ${from.trim()}`}
      </span>
    );
  }
  // The two states that exist only because the campaign's depth changed. They
  // are deliberately not coloured as good or bad: nothing is known to have
  // happened, we simply stopped (or started) looking that far.
  if (m.state === "out_of_range") {
    return (
      <span
        className="tnum text-muted"
        title={`Was #${m.previous}, which is deeper than this check looked — not a drop`}
      >
        out of range{verbose ? from : ""}
      </span>
    );
  }
  if (m.state === "unseen_before") {
    return (
      <span className="text-muted" title="Deeper than the previous check looked, so there is no way to tell whether it moved">
        first seen
      </span>
    );
  }
  return verbose ? <span className="text-muted">no change</span> : null;
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

  // Campaigns are listed through RLS with no organisation filter, and every
  // org-scoped query below uses the SELECTED CAMPAIGN's organisation. Do not
  // reintroduce a filter on caller()'s organisation: organisation_users is
  // read with limit(1) and no ordering, so a user in more than one
  // organisation gets a different answer on different requests — which
  // showed up as this page randomly forgetting every campaign and offering
  // "create your first campaign" instead. (Same trap as the run route; see
  // the note on callerCampaign.)
  const { data: campaignRows } = await c.supabase
    .from("campaigns")
    .select("id, name, serp_depth, serp_priority, organisation_id")
    .order("name");
  const campaigns = (campaignRows ?? []) as {
    id: string;
    name: string;
    serp_depth: number | null;
    serp_priority: number | null;
    organisation_id: string;
  }[];
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
  // The campaign's own organisation scopes everything below — not caller()'s,
  // which is unstable for multi-organisation users (see above).
  const orgId = campaign.organisation_id;
  // What the NEXT check will look at. Results already stored keep whatever
  // depth they were taken at.
  const depth = normaliseDepth(campaign.serp_depth);
  const priority = normalisePriority(campaign.serp_priority);

  // One clock reading for the whole render, so the cutoffs, "today" and the
  // in-flight age all agree with each other.
  const now = new Date();
  const dayBefore = (days: number) => {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };
  const cutoff = dayBefore(HISTORY_DAYS);
  const todayStr = now.toISOString().slice(0, 10);

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
    c.supabase.from("sites").select("id, domain").eq("organisation_id", orgId),
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

  // What "Generate keywords" will actually produce, worked out the same way
  // the action does. Two domains in the same town share one keyword set, and
  // two towns sharing a search location share any pattern that doesn't name
  // the town — which is why the keyword count is normally BELOW
  // patterns × domains, and why it is spelled out on the card.
  const townPairs = new Set<string>();
  const searchLocations = new Set<string>();
  for (const w of watchDomains) {
    const town = w.location?.trim();
    if (!town) continue;
    const checkpoint = w.serp_location?.trim() || town;
    townPairs.add(`${town.toLowerCase()}|${checkpoint.toLowerCase()}`);
    searchLocations.add(checkpoint.toLowerCase());
  }
  const domainsWithTown = watchDomains.filter((w) => w.location?.trim()).length;

  // Latest check per keyword (last 30 days) + that day's rankings. Small
  // campaigns ask for their own keywords only; big ones page the org's rows
  // and filter, which is cheaper than a very long `in` list.
  type CheckRecord = {
    keyword_id: string;
    check_date: string;
    error: string | null;
    depth: number | null;
    top_results: TopResult[];
  };
  const CHECK_COLUMNS = "keyword_id, check_date, error, depth, top_results";
  const checks = !keywords.length
    ? []
    : keywords.length <= SCOPED_MAX
      ? await fetchAllRows<CheckRecord>((from, to) =>
          c.supabase
            .from("serp_checks")
            .select(CHECK_COLUMNS)
            .in("keyword_id", [...keywordIds])
            .gte("check_date", cutoff)
            .order("check_date", { ascending: false })
            .range(from, to),
        )
      : (
          await fetchAllRows<CheckRecord>((from, to) =>
            c.supabase
              .from("serp_checks")
              .select(CHECK_COLUMNS)
              .eq("organisation_id", orgId)
              .gte("check_date", cutoff)
              .order("check_date", { ascending: false })
              .range(from, to),
          )
        ).filter((r) => keywordIds.has(r.keyword_id));

  // In-flight tasks for THIS campaign — drives the progress banner below.
  // posted_at comes back so the banner can say how long they have been out
  // there, which is the difference between "wait a bit" and "something stuck".
  const queued = keywords.length
    ? await fetchAllRows<{ keyword_id: string; posted_at: string }>((from, to) =>
        c.supabase
          .from("serp_task_queue")
          .select("keyword_id, posted_at")
          .eq("organisation_id", orgId)
          .order("keyword_id")
          .range(from, to),
      )
    : [];
  const mineInFlight = queued.filter((r) => keywordIds.has(r.keyword_id));
  const inFlight = mineInFlight.length;
  const oldestInFlight = mineInFlight.reduce<number | null>((oldest, r) => {
    const at = new Date(r.posted_at).getTime();
    return Number.isNaN(at) ? oldest : oldest === null || at < oldest ? at : oldest;
  }, null);
  const inFlightMinutes =
    oldestInFlight === null ? 0 : Math.floor((now.getTime() - oldestInFlight) / 60000);
  const collectedToday = checks.filter((r) => r.check_date === todayStr).length;

  const latestCheck = new Map<string, { date: string; error: string | null; top: TopResult[] }>();
  for (const row of checks) {
    if (latestCheck.has(row.keyword_id)) continue;
    latestCheck.set(row.keyword_id, {
      date: row.check_date,
      error: row.error,
      top: row.top_results ?? [],
    });
  }
  // History = the checks that actually produced positions, newest first. The
  // most recent two are what "since the last check" compares; the rest give
  // the expanded card something to plot.
  const history = successfulCheckDates(checks);
  const currentDate = (id: string) => history.get(id)?.[0];
  const previousDate = (id: string) => history.get(id)?.[1];
  // Depth per stored check, so a campaign that has been made shallower does
  // not report every site below the new depth as having crashed out.
  const checkDepths = depthByCheck(checks, DEFAULT_DEPTH);
  const depthAt = (id: string, date: string | undefined) =>
    date ? (checkDepths.get(`${id}|${date}`) ?? DEFAULT_DEPTH) : null;

  // Both dates are fetched in one go: comparing needs the previous check's
  // rows, and there is no cheaper way to know a domain dropped out than to
  // see where it was.
  const comparedDates = [
    ...new Set(
      keywords.flatMap((k) => [currentDate(k.id), previousDate(k.id)]).filter(Boolean) as string[],
    ),
  ];
  const rankings = comparedDates.length
    ? (
        await fetchAllRows<RankingRow>((from, to) => {
          const query = c.supabase
            .from("serp_rankings")
            .select("keyword_id, domain, position, url, check_date");
          return (
            keywords.length <= SCOPED_MAX
              ? query.in("keyword_id", [...keywordIds])
              : query.eq("organisation_id", orgId)
          )
            .in("check_date", comparedDates)
            .order("id")
            .range(from, to);
        })
      ).filter((r) => keywordIds.has(r.keyword_id))
    : [];
  // Rankings are recorded for every domain the organisation watches, so a
  // sister campaign's domains show up here — this campaign only cares about
  // its own.
  const rankingsByKeyword = new Map<string, RankingRow[]>();
  for (const r of rankings) {
    if (!watched.has(r.domain)) continue;
    const list = rankingsByKeyword.get(r.keyword_id);
    if (list) list.push(r);
    else rankingsByKeyword.set(r.keyword_id, [r]);
  }

  // Per-keyword rollup: the town's own site vs other campaign sites (overlap).
  // Home = same checkpoint as the keyword AND, when the keyword names a
  // specific town ("lock change brownswood park"), that exact town — so a
  // sister site sharing the postcode (Finsbury Park, also N4) counts as
  // overlap there, while generic keywords ("locksmith near me") keep every
  // site at that checkpoint as home.
  const townOf = (locationName: string) => locationName.split(",")[0].trim().toLowerCase();
  const summarised = keywords.map((k) => {
    const check = latestCheck.get(k.id) ?? null;
    const own = rankingsByKeyword.get(k.id) ?? [];
    const mine = (domain: string) => watched.has(domain);
    const current = positionsOn(own, currentDate(k.id), mine);
    const prevDate = previousDate(k.id);
    const previous = prevDate
      ? new Map([...positionsOn(own, prevDate, mine)].map(([d, v]) => [d, v.position]))
      : null;
    const checkDepth = depthAt(k.id, currentDate(k.id));
    const movements = movement(current, previous, {
      current: checkDepth,
      previous: depthAt(k.id, prevDate),
    });
    const ranked = movements.filter((m) => m.position !== null);
    const lost = movements.filter((m) => m.state === "lost");
    const outOfRange = movements.filter((m) => m.state === "out_of_range");

    const town = townOf(k.location_name);
    const candidates = [...watched.entries()].filter(([, w]) => w.homeKey === town);
    const textMatches = candidates.filter(
      ([, w]) => w.homeTownLower && k.keyword.includes(w.homeTownLower),
    );
    const homeSet = new Set((textMatches.length > 0 ? textMatches : candidates).map(([d]) => d));
    // The home site's own row, which carries both its position now and where
    // it was — including when "now" is nowhere at all.
    const homeMove = bestOf(movements, homeSet);
    const home =
      homeMove !== null && homeMove.position !== null
        ? { ...homeMove, position: homeMove.position }
        : null;
    const overlap = ranked.filter((r) => !homeSet.has(r.domain) && watched.get(r.domain)?.homeKey);
    return {
      k,
      check,
      movements,
      ranked,
      lost,
      outOfRange,
      checkDepth: checkDepth ?? depth,
      town,
      hasHome: homeSet.size > 0,
      homeSet,
      home,
      homeMove,
      overlap,
      comparedWith: prevDate ?? null,
    };
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

  // Movement is measured on the home site only: "did the site we run for this
  // town go up or down since its last check". Keywords with no earlier check
  // have nothing to say and are excluded from every count here.
  const compared = withHome.filter((s) => s.comparedWith && s.homeMove);
  const homeUp = compared.filter((s) => (s.homeMove!.change ?? 0) > 0);
  const homeDown = compared.filter((s) => (s.homeMove!.change ?? 0) < 0);
  const homeLost = compared.filter((s) => s.homeMove!.state === "lost");
  const homeNew = compared.filter((s) => s.homeMove!.state === "new");
  const movedRows = qFiltered.filter(
    (s) => s.comparedWith && (s.movements.some((m) => (m.change ?? 0) !== 0) || s.lost.length > 0),
  ).length;
  const netHomeChange = compared.reduce((sum, s) => sum + (s.homeMove!.change ?? 0), 0);

  const visible = qFiltered.filter((s) => {
    if (view === "missing") return s.hasHome && s.check && !s.check.error && !s.home;
    if (view === "overlap") return s.overlap.length > 0;
    if (view === "failed") return Boolean(s.check?.error);
    if (view === "up") return Boolean(s.comparedWith) && (s.homeMove?.change ?? 0) > 0;
    if (view === "down") return Boolean(s.comparedWith) && (s.homeMove?.change ?? 0) < 0;
    if (view === "lost") return Boolean(s.comparedWith) && s.lost.length > 0;
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
  } else if (sort === "moved" || sort === "dropped") {
    // "Biggest move" reads the home site's change; a drop out of the top 100
    // has no number, so it is ranked as the worst possible fall. "dropped"
    // is the same order reversed — worst news first.
    const score = (s: (typeof summarised)[number]) =>
      !s.comparedWith || !s.homeMove ? 0 : s.homeMove.state === "lost" ? -1000 : (s.homeMove.change ?? 0);
    visible.sort((a, b) =>
      sort === "moved"
        ? Math.abs(score(b)) - Math.abs(score(a)) || a.k.keyword.localeCompare(b.k.keyword)
        : score(a) - score(b) || a.k.keyword.localeCompare(b.k.keyword),
    );
  }

  // Full history for the one expanded keyword. Scoped to a single keyword, so
  // it reaches back much further than the summary comparison can afford to.
  const openKeyword = openId && keywordIds.has(openId) ? openId : "";
  const [openChecks, openRankings] = openKeyword
    ? await Promise.all([
        fetchAllRows<{ keyword_id: string; check_date: string; error: string | null }>((from, to) =>
          c.supabase
            .from("serp_checks")
            .select("keyword_id, check_date, error")
            .eq("keyword_id", openKeyword)
            .gte("check_date", dayBefore(KEYWORD_HISTORY_DAYS))
            .order("check_date", { ascending: false })
            .range(from, to),
        ),
        fetchAllRows<RankingRow>((from, to) =>
          c.supabase
            .from("serp_rankings")
            .select("keyword_id, domain, position, url, check_date")
            .eq("keyword_id", openKeyword)
            .gte("check_date", dayBefore(KEYWORD_HISTORY_DAYS))
            .order("check_date", { ascending: false })
            .range(from, to),
        ),
      ])
    : [[], []];
  const openDates = (successfulCheckDates(openChecks).get(openKeyword) ?? []).slice(0, 20);
  const openFailed = openChecks.filter((r) => r.error).length;

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
          <RankCheckButton
            keywordCount={keywords.length}
            campaignId={campaignId}
            estimatedCost={keywords.length ? runCost(keywords.length, depth, priority) : ""}
            depth={depth}
          />
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

      {inFlight > 0 &&
        (() => {
          // DataForSEO's standard queue normally returns everything inside 20
          // minutes. Past an hour a task is not slow, it is stuck — and
          // because a queued keyword is skipped by the next check (that is
          // what stops it being paid for twice), a stuck row blocks its
          // keyword until collection expires it. Hence the escape hatch.
          const stuck = inFlightMinutes >= 60;
          return (
            <Card
              className={`mb-4 p-3 text-sm text-ink ${stuck ? "border-warning/60" : "border-series-1/40"}`}
            >
              <span className="font-medium">
                {stuck ? "Rank check stalled:" : "Rank check in progress:"}
              </span>{" "}
              <span className="tnum">
                {collectedToday} of {keywords.length} keywords collected · {inFlight} still
                processing at DataForSEO
                {inFlightMinutes > 0 && `, oldest queued ${inFlightMinutes} min ago`}.
              </span>{" "}
              <span className="text-ink-2">
                {stuck
                  ? "Results usually land within 20 minutes, so this run has been out there far longer than it should. Collection is still retrying every few minutes and costs nothing; if it never lands, forget the in-flight tasks below and start a fresh check."
                  : "Results land here as they finish — refresh the page to see the latest. Collection continues automatically every few minutes even if you close the tab, so nothing is lost by leaving. Nothing is charged twice: a keyword already in flight is skipped by the next check."}
              </span>
              {stuck && (
                <form action={clearStuckChecks} className="mt-2">
                  <input type="hidden" name="campaign" value={campaignId} />
                  <PendingButton
                    pendingLabel="Clearing…"
                    className="rounded-md border border-edge px-2 py-1 text-sm font-medium text-series-1 hover:bg-page"
                  >
                    Forget {inFlight} in-flight {inFlight === 1 ? "task" : "tasks"} (then press
                    Check rankings now)
                  </PendingButton>
                </form>
              )}
            </Card>
          );
        })()}

      {(() => {
        const bad = keywords.filter((k) => k.location_valid === false);
        const unchecked = keywords.filter((k) => k.location_valid === null);
        if (bad.length === 0 && unchecked.length === 0) return null;
        const recheck = (
          <form action={revalidateLocations} className="mt-2">
            <input type="hidden" name="campaign" value={campaignId} />
            <PendingButton
              pendingLabel="Checking locations…"
              className="rounded-md border border-edge px-2 py-1 text-sm font-medium text-series-1 hover:bg-page"
            >
              Check every location against DataForSEO
            </PendingButton>
          </form>
        );
        // Nothing has been verified yet — keywords added before locations
        // were resolved on the way in. Free to check, and it settles whether
        // the campaign is pointed at the right places.
        if (bad.length === 0) {
          return (
            <Card className="mb-4 p-3 text-sm text-ink">
              <span className="font-medium">
                {unchecked.length} {unchecked.length === 1 ? "keyword hasn't" : "keywords haven't"}{" "}
                had their search location verified.
              </span>{" "}
              <span className="text-ink-2">
                They were added before locations were resolved on import. Checking is free and
                takes a second — it rewrites each one to the exact name DataForSEO uses and flags
                any it doesn&rsquo;t recognise.
              </span>
              {recheck}
            </Card>
          );
        }
        // Locations Google will never be asked from. Worth stopping for: the
        // checks fail rather than returning the wrong town, but a run spent
        // on them is a run wasted.
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
              {unchecked.length > 0 &&
                ` ${unchecked.length} more haven't been checked at all yet.`}
            </span>
            {recheck}
          </Card>
        );
      })()}

      {keywords.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
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
          <StatTile label="Home site not ranking" value={String(homeMissing)} detail={`not in the top ${depth}`} />
          <StatTile
            label="Keywords ranking higher"
            value={compared.length ? String(homeUp.length) : "—"}
            detail={
              compared.length
                ? `town's own site climbed since the last check${homeNew.length ? ` · ${homeNew.length} newly ranking` : ""}`
                : "needs a second check to compare"
            }
          />
          <StatTile
            label="Keywords ranking lower"
            value={compared.length ? String(homeDown.length) : "—"}
            detail={
              compared.length
                ? `town's own site slipped since the last check${homeLost.length ? ` · ${homeLost.length} dropped out entirely` : ""}`
                : "needs a second check to compare"
            }
          />
          <StatTile
            label="Net movement"
            value={
              compared.length
                ? `${netHomeChange > 0 ? "▲" : netHomeChange < 0 ? "▼" : ""}${Math.abs(netHomeChange)}`
                : "—"
            }
            detail={
              compared.length
                ? `positions gained minus lost, across ${compared.length} keywords with two checks`
                : `${overlapRows} keywords with overlap`
            }
          />
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
            {viewLink("up", "Moved up", homeUp.length)}
            {viewLink("down", "Moved down", homeDown.length)}
            {viewLink("lost", "Dropped out", qFiltered.filter((s) => s.comparedWith && s.lost.length > 0).length)}
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
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-muted">Order by</span>
              {sortLink("az", "A–Z")}
              {sortLink("best", "Best position")}
              {sortLink("home", "Home position")}
              {sortLink("sites", "Sites ranking")}
              {sortLink("moved", "Biggest move")}
              {sortLink("dropped", "Worst move")}
            </span>
            {movedRows > 0 && (
              <span className="text-xs text-muted">
                {movedRows} {movedRows === 1 ? "keyword" : "keywords"} changed since the previous
                check
              </span>
            )}
          </div>

          <div className="space-y-3">
            {visible
              .slice(0, limit)
              .map(({ k, check, ranked, lost, outOfRange, checkDepth, hasHome, homeSet, home, homeMove, overlap, comparedWith }) => {
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
                                <span className="inline-flex items-center gap-1.5">
                                  <Badge tone={positionTone(home.position)}>home #{home.position}</Badge>
                                  {comparedWith && <MovementMark m={home} verbose />}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5">
                                  <Badge tone="warning">home site not ranking</Badge>
                                  {homeMove?.state === "lost" && <MovementMark m={homeMove} verbose />}
                                </span>
                              ))}
                            <span className="tnum">
                              {ranked.length} of {watchedTotal} rank
                            </span>
                            <span className="text-muted" title={comparedWith ? `Previous check ${comparedWith}` : undefined}>
                              checked {check.date}
                              {comparedWith ? ` · vs ${comparedWith}` : " · first check"}
                            </span>
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
                          <Badge tone={positionTone(r.position!)}>#{r.position}</Badge>
                          <MovementMark m={r} verbose />
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
                  {lost.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-muted">Gone since {comparedWith}:</span>
                      {(isOpen ? lost : lost.slice(0, 8)).map((m) => (
                        <span
                          key={m.domain}
                          className={`inline-flex items-center gap-1 rounded-md border border-critical/40 px-1.5 py-0.5 ${
                            isHome(m.domain) ? "font-medium" : ""
                          }`}
                          title={`Was #${m.previous} on ${comparedWith}, not in the checked results now`}
                        >
                          <span className="tnum text-critical">was #{m.previous}</span>
                          <span className="text-ink-2">{m.domain}</span>
                          {isHome(m.domain) && <span className="text-series-1">home</span>}
                        </span>
                      ))}
                      {!isOpen && lost.length > 8 && (
                        <span className="text-muted">+{lost.length - 8} more</span>
                      )}
                    </div>
                  )}
                  {outOfRange.length > 0 && (
                    <p className="mt-1.5 text-xs text-muted">
                      {outOfRange.length}{" "}
                      {outOfRange.length === 1 ? "domain was" : "domains were"} ranked below #
                      {checkDepth} at the previous check, which this one didn&rsquo;t look at — not
                      counted as dropped ({outOfRange
                        .slice(0, 4)
                        .map((m) => `${m.domain} #${m.previous}`)
                        .join(" · ")}
                      {outOfRange.length > 4 ? ` · +${outOfRange.length - 4} more` : ""}).
                    </p>
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
                        {/* Every check this keyword has ever had, newest first.
                            One row per date, one column per domain that ranks
                            now or ranked at any point in the window — so a
                            site's whole run is readable left to right, and a
                            blank cell means "checked, but not that far up". */}
                        <div className="mt-1">
                          <div className="mb-1 font-medium text-ink">
                            Position history
                            <span className="ml-2 font-normal text-muted">
                              {openDates.length === 0
                                ? "no completed checks yet"
                                : `${openDates.length} ${openDates.length === 1 ? "check" : "checks"} in the last ${KEYWORD_HISTORY_DAYS} days`}
                              {openFailed > 0 && ` · ${openFailed} failed (not shown)`}
                            </span>
                          </div>
                          {openDates.length === 0 ? (
                            <p className="text-muted">
                              Nothing to plot yet — history builds up one check at a time.
                            </p>
                          ) : (
                            (() => {
                              // Columns: home sites first, then anything else
                              // that has ranked in the window. Capped so a
                              // 292-site campaign stays readable.
                              const seen = new Set(openRankings.map((r) => r.domain));
                              const columns = [...watched.keys()]
                                .filter((d) => seen.has(d))
                                .sort((a, b) =>
                                  isHome(a) === isHome(b) ? a.localeCompare(b) : isHome(a) ? -1 : 1,
                                )
                                .slice(0, 12);
                              const rows = columns.map((domain) => ({
                                domain,
                                points: series(openRankings, openDates, domain),
                              }));
                              return (
                                <div className="overflow-x-auto">
                                  <table className="min-w-full border-separate border-spacing-0 text-xs">
                                    <thead>
                                      <tr>
                                        <th className="sticky left-0 bg-surface py-1 pr-3 text-left font-medium text-ink">
                                          Domain
                                        </th>
                                        {openDates.map((d) => (
                                          <th key={d} className="px-2 py-1 text-right font-medium text-muted">
                                            {d.slice(5)}
                                          </th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {rows.map(({ domain, points }) => (
                                        <tr key={domain}>
                                          <td
                                            className={`sticky left-0 bg-surface py-0.5 pr-3 ${
                                              isHome(domain) ? "font-medium text-series-1" : "text-ink-2"
                                            }`}
                                          >
                                            {domain}
                                            {isHome(domain) && " (home)"}
                                          </td>
                                          {points.map((p, i) => {
                                            // Compare with the next column
                                            // along — the dates run newest
                                            // first, so that is the check
                                            // before this one.
                                            const before = points[i + 1]?.position ?? null;
                                            const delta =
                                              p.position !== null && before !== null
                                                ? before - p.position
                                                : null;
                                            return (
                                              <td
                                                key={p.date}
                                                className="tnum px-2 py-0.5 text-right"
                                                title={`${domain} on ${p.date}`}
                                              >
                                                {p.position === null ? (
                                                  <span className="text-muted">—</span>
                                                ) : (
                                                  <>
                                                    <span className="text-ink">#{p.position}</span>
                                                    {delta !== null && delta !== 0 && (
                                                      <span
                                                        className={
                                                          delta > 0 ? "text-delta-good" : "text-critical"
                                                        }
                                                      >
                                                        {delta > 0 ? " ▲" : " ▼"}
                                                        {Math.abs(delta)}
                                                      </span>
                                                    )}
                                                  </>
                                                )}
                                              </td>
                                            );
                                          })}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  <p className="mt-1 text-muted">
                                    &ldquo;—&rdquo; means the check ran that day but the domain was
                                    not in the organic results as far down as that check looked.
                                    {seen.size > columns.length &&
                                      ` Showing the first ${columns.length} of ${seen.size} domains that have ranked here.`}
                                  </p>
                                </div>
                              );
                            })()
                          )}
                        </div>
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
                            Not in the top {checkDepth} ({notRankingCount}):
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
          <div className="mb-2 text-sm font-medium text-ink">
            2 · Generate keywords from patterns
            <span className="ml-2 text-xs font-normal text-muted">
              {keywords.length} keywords in {campaign.name}
            </span>
          </div>
          {domainsWithTown > 0 && (
            <p className="mb-2 rounded-md border border-edge bg-page px-2 py-1.5 text-xs text-ink-2">
              <span className="font-medium text-ink">
                {domainsWithTown} domains with a town → {townPairs.size} town/search-location{" "}
                {townPairs.size === 1 ? "pair" : "pairs"} → {searchLocations.size} distinct search{" "}
                {searchLocations.size === 1 ? "location" : "locations"}.
              </span>{" "}
              Keywords are generated per pair, not per domain, and identical keywords searched from
              the same place are never duplicated. So a pattern containing{" "}
              <span className="font-mono">{"{location}"}</span> adds up to {townPairs.size} keywords,
              while one without it (&ldquo;locksmith near me&rdquo;) adds up to{" "}
              {searchLocations.size} — one per place Google is actually queried from.
              {domainsWithTown > townPairs.size &&
                ` ${domainsWithTown - townPairs.size} of your domains share a town with another domain, so they share its keywords.`}
            </p>
          )}
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
              — “near me” style patterns too. A check costs about $
              {costAtDepth(depth, priority).toFixed(4)} per keyword at this campaign&rsquo;s
              top-{depth} depth, so 5 patterns × 292 towns = 1,460 keywords ≈{" "}
              {runCost(1460, depth, priority)} per full run, while 5 patterns × 1 town = 5 keywords
              is a couple of pennies. Existing keywords are never duplicated.
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

      <Card className="mt-6 p-4">
        <div className="mb-2 text-sm font-medium text-ink">
          How deep to look
          <span className="ml-2 text-xs font-normal text-muted">
            currently top {depth}
            {priority === 2 && " · high-priority queue (2× cost)"}
            {keywords.length > 0 && ` · ${runCost(keywords.length, depth, priority)} per run`}
          </span>
        </div>
        <form action={setCampaignDepth} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="campaign" value={campaignId} />
          {DEPTH_CHOICES.map((d) => (
            <button
              key={d}
              name="depth"
              value={d}
              type="submit"
              className={`rounded-md border px-2.5 py-1.5 text-sm ${
                d === depth
                  ? "border-series-1 bg-page font-medium text-series-1"
                  : "border-edge text-ink-2 hover:text-ink"
              }`}
            >
              Top {d}
              <span className="ml-1.5 text-xs text-muted">
                {keywords.length > 0
                  ? runCost(keywords.length, d, priority)
                  : `$${costAtDepth(d, priority).toFixed(4)}/kw`}
              </span>
            </button>
          ))}
        </form>
        <p className="mt-2 text-xs text-muted">
          DataForSEO charges per page of ten results it has to fetch — ${COST_PER_PAGE_LABEL} a
          page — so this is the only setting that changes what a run costs, and it scales exactly
          in line: top 50 is half the price of top 100, top 20 is a fifth.
          {keywords.length > 0 && (
            <>
              {" "}
              For {campaign.name}&rsquo;s {keywords.length} keywords that is{" "}
              {runCost(keywords.length, 100, priority)} at top 100,{" "}
              {runCost(keywords.length, 50, priority)} at top 50 and{" "}
              {runCost(keywords.length, 20, priority)} at top 20.
            </>
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Queue</span>
          <form action={setCampaignPriority} className="flex items-center gap-2">
            <input type="hidden" name="campaign" value={campaignId} />
            {[
              { value: 1, label: "Standard", note: "cheapest · usually minutes" },
              { value: 2, label: "High priority", note: "2× cost · under a minute" },
            ].map((opt) => (
              <button
                key={opt.value}
                name="priority"
                value={opt.value}
                type="submit"
                className={`rounded-md border px-2.5 py-1.5 text-sm ${
                  opt.value === priority
                    ? "border-series-1 bg-page font-medium text-series-1"
                    : "border-edge text-ink-2 hover:text-ink"
                }`}
              >
                {opt.label}
                <span className="ml-1.5 text-xs text-muted">{opt.note}</span>
              </button>
            ))}
          </form>
          <span className="text-xs text-muted">
            Standard and high priority are separate DataForSEO crawler pools that fail
            independently — switch to high priority when a standard run sits for hours with
            nothing back, and switch back once their standard queue recovers.
          </span>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          <span className="font-medium text-ink">What you give up.</span> A site below the depth you
          pick is indistinguishable from one that doesn&rsquo;t rank at all, so &ldquo;home site not
          ranking&rdquo; comes to mean &ldquo;not in the top {depth}&rdquo;. Striking-distance work
          lives at #11–30, so top 20 is a poor fit for a site you are actively trying to move, and a
          reasonable one for watching a large network&rsquo;s winners.
        </p>
        <p className="mt-1.5 text-xs text-muted">
          <span className="font-medium text-ink">Changing it is safe.</span> Every result records
          the depth it was taken at, so results already collected keep their meaning. Reduce the
          depth and sites that sat below the new limit are marked{" "}
          <span className="font-medium text-ink">out of range</span> — a blind spot — instead of
          being reported as having dropped out.
        </p>
      </Card>

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
