import { NextRequest, NextResponse } from "next/server";
import { getServerClient } from "@/lib/supabase/server";
import { normaliseDomain, TopResult } from "@/lib/engine/serp";

// CSV of the latest check per keyword in ONE campaign (?campaign=): one row
// per ranked watched domain, plus a row for any home-town domain that is NOT
// ranking (that absence is the point of the tracker — "not ranking" means
// absent from the organic top 100). Honours the dashboard's current text
// filter (?q=), view (?view=missing|overlap|failed) and order (?sort=), so
// exports are custom slices. Uses the caller's session, so RLS scopes it.
const PAGE = 1000;

function esc(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  const view = request.nextUrl.searchParams.get("view") ?? "all";
  const sort = request.nextUrl.searchParams.get("sort") ?? "az";
  const supabase = await getServerClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { data: membership } = await supabase!
    .from("organisation_users")
    .select("organisation_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!membership) return NextResponse.json({ error: "no organisation" }, { status: 403 });
  // Only used to pick a default campaign; replaced by the campaign's own
  // organisation once one is chosen.
  let orgId = membership.organisation_id as string;

  async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>) {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data } = await build(from, from + PAGE - 1);
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) return out;
    }
  }

  // Export follows the dashboard's selected campaign; without one, the first
  // campaign, so a hand-typed URL still returns something sensible. The
  // campaign carries its own organisation — see the note in the run route
  // about why that beats matching against a looked-up "current" org.
  const requested = request.nextUrl.searchParams.get("campaign") ?? "";
  const { data: chosen } = requested
    ? await supabase!
        .from("campaigns")
        .select("id, name, organisation_id")
        .eq("id", requested)
        .maybeSingle()
    : { data: null };
  const { data: fallback } = chosen
    ? { data: null }
    : await supabase!
        .from("campaigns")
        .select("id, name, organisation_id")
        .eq("organisation_id", orgId)
        .order("name")
        .limit(1)
        .maybeSingle();
  const campaign = (chosen ?? fallback) as
    | { id: string; name: string; organisation_id: string }
    | null;
  if (!campaign) return NextResponse.json({ error: "no campaign" }, { status: 404 });
  const campaignId = campaign.id;
  orgId = campaign.organisation_id;

  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 30);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const [keywords, domains, checks] = await Promise.all([
    all<{ id: string; keyword: string; location_name: string }>((f, t) =>
      supabase!.from("tracked_keywords").select("id, keyword, location_name").eq("campaign_id", campaignId).order("keyword").range(f, t),
    ),
    all<{ domain: string; location: string | null; serp_location: string | null }>((f, t) =>
      supabase!.from("tracked_domains").select("domain, location, serp_location").eq("campaign_id", campaignId).order("domain").range(f, t),
    ),
    all<{ keyword_id: string; check_date: string; error: string | null; top_results: TopResult[] }>((f, t) =>
      supabase!
        .from("serp_checks")
        .select("keyword_id, check_date, error, top_results")
        .eq("organisation_id", orgId)
        .gte("check_date", cutoff)
        .order("check_date", { ascending: false })
        .range(f, t),
    ),
  ]);

  const keywordIds = new Set(keywords.map((k) => k.id));
  const latest = new Map<string, { date: string; error: string | null }>();
  for (const row of checks) {
    if (!keywordIds.has(row.keyword_id)) continue; // another campaign's check
    if (!latest.has(row.keyword_id)) latest.set(row.keyword_id, { date: row.check_date, error: row.error });
  }
  const latestDates = [...new Set([...latest.values()].map((v) => v.date))];
  const rankings = latestDates.length
    ? await all<{ keyword_id: string; domain: string; position: number; url: string | null; check_date: string }>((f, t) =>
        supabase!
          .from("serp_rankings")
          .select("keyword_id, domain, position, url, check_date")
          .eq("organisation_id", orgId)
          .in("check_date", latestDates)
          .order("id")
          .range(f, t),
      )
    : [];
  // Rankings are recorded for every domain the organisation watches, so rows
  // for other campaigns' domains are filtered out here.
  const campaignDomains = new Set(domains.map((d) => normaliseDomain(d.domain)));
  const rankedBy = new Map<string, { domain: string; position: number; url: string }[]>();
  for (const r of rankings) {
    if (!campaignDomains.has(r.domain)) continue;
    if (r.check_date !== latest.get(r.keyword_id)?.date) continue;
    const list = rankedBy.get(r.keyword_id) ?? [];
    list.push({ domain: r.domain, position: r.position, url: r.url ?? "" });
    rankedBy.set(r.keyword_id, list);
  }

  // homeKey matches domains to keywords checked from their checkpoint
  // (serp_location when set, town otherwise); label is for display.
  const homeKey = new Map<string, string>();
  const homeLabel = new Map<string, string>();
  const homeTownLower = new Map<string, string>();
  for (const d of domains) {
    const key = (d.serp_location ?? d.location)?.split(",")[0].trim().toLowerCase();
    if (!key) continue;
    const town = d.location?.trim();
    const checkpoint = d.serp_location?.split(",")[0].trim();
    homeKey.set(normaliseDomain(d.domain), key);
    if (town) homeTownLower.set(normaliseDomain(d.domain), town.toLowerCase());
    homeLabel.set(
      normaliseDomain(d.domain),
      town
        ? checkpoint && checkpoint.toLowerCase() !== town.toLowerCase()
          ? `${town} (${checkpoint})`
          : town
        : (checkpoint ?? ""),
    );
  }

  // Same per-keyword rollup as the dashboard, so view filters match exactly:
  // a keyword naming a specific town homes only that town's site; sister
  // sites sharing the checkpoint count as overlap.
  const summarised = keywords.map((k) => {
    const check = latest.get(k.id) ?? null;
    const town = k.location_name.split(",")[0].trim().toLowerCase();
    const ranked = (rankedBy.get(k.id) ?? []).sort((a, b) => a.position - b.position);
    const candidates = [...homeKey.entries()].filter(([, key]) => key === town).map(([d]) => d);
    const textMatches = candidates.filter((d) => {
      const t = homeTownLower.get(d);
      return t && k.keyword.includes(t);
    });
    const homeSet = new Set(textMatches.length > 0 ? textMatches : candidates);
    const home = ranked.find((r) => homeSet.has(r.domain)) ?? null;
    const overlap = ranked.filter((r) => !homeSet.has(r.domain) && homeKey.has(r.domain));
    return { k, check, town, ranked, hasHome: homeSet.size > 0, homeSet, home, overlap };
  });

  const filtered = summarised.filter((s) => {
    if (q && !s.k.keyword.includes(q) && !s.k.location_name.toLowerCase().includes(q)) return false;
    if (view === "missing") return s.hasHome && s.check && !s.check.error && !s.home;
    if (view === "overlap") return s.overlap.length > 0;
    if (view === "failed") return Boolean(s.check?.error);
    return true;
  });
  if (sort === "best") {
    filtered.sort((a, b) => (a.ranked[0]?.position ?? 999) - (b.ranked[0]?.position ?? 999));
  } else if (sort === "home") {
    filtered.sort((a, b) => (a.home?.position ?? 999) - (b.home?.position ?? 999));
  } else if (sort === "sites") {
    filtered.sort((a, b) => b.ranked.length - a.ranked.length);
  }

  const lines = ["keyword,location,checked,status,domain,domain_home_town,is_home,position,url"];
  for (const { k, check, ranked, homeSet } of filtered) {
    if (!check) {
      lines.push([esc(k.keyword), esc(k.location_name), "", "unchecked", "", "", "", "", ""].join(","));
      continue;
    }
    if (check.error) {
      lines.push([esc(k.keyword), esc(k.location_name), check.date, "failed", "", "", "", "", esc(check.error)].join(","));
      continue;
    }
    const rankedSet = new Set(ranked.map((r) => r.domain));
    for (const r of ranked) {
      lines.push(
        [
          esc(k.keyword), esc(k.location_name), check.date, "ranked",
          esc(r.domain), esc(homeLabel.get(r.domain) ?? ""), homeSet.has(r.domain) ? "yes" : "no",
          r.position, esc(r.url),
        ].join(","),
      );
    }
    // The keyword's own home site(s) missing from the organic top 100.
    for (const domain of homeSet) {
      if (!rankedSet.has(domain)) {
        lines.push(
          [esc(k.keyword), esc(k.location_name), check.date, "not_ranking", esc(domain), esc(homeLabel.get(domain) ?? ""), "yes", "", ""].join(","),
        );
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const slug = [
    campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40),
    view !== "all" ? view : "",
    q ? q.replace(/[^a-z0-9]+/g, "-").slice(0, 30) : "",
  ]
    .filter(Boolean)
    .join("-");
  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rankings-${today}${slug ? `-${slug}` : ""}.csv"`,
    },
  });
}
