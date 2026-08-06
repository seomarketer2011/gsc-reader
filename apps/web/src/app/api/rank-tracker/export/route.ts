import { NextRequest, NextResponse } from "next/server";
import { getServerClient } from "@/lib/supabase/server";
import { DEFAULT_DEPTH, normaliseDomain, TopResult } from "@/lib/engine/serp";
import {
  depthByCheck,
  movement,
  positionsOn,
  RankingRow,
  successfulCheckDates,
} from "@/lib/engine/rank-history";

// CSV of the latest check per keyword in ONE campaign (?campaign=): one row
// per ranked watched domain, plus a row for any home-town domain that is NOT
// ranking (that absence is the point of the tracker — "not ranking" means
// absent from the organic top 100). Every row also carries where the domain
// sat at the previous check and how far it has moved, so the file answers
// "what changed?" without a second export to diff against. Honours the
// dashboard's current text filter (?q=), view
// (?view=missing|overlap|failed|up|down|lost) and order (?sort=), so exports
// are custom slices. Uses the caller's session, so RLS scopes it.
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
    all<{ keyword_id: string; check_date: string; error: string | null; depth: number | null; top_results: TopResult[] }>((f, t) =>
      supabase!
        .from("serp_checks")
        .select("keyword_id, check_date, error, depth, top_results")
        .eq("organisation_id", orgId)
        .gte("check_date", cutoff)
        .order("check_date", { ascending: false })
        .range(f, t),
    ),
  ]);

  const keywordIds = new Set(keywords.map((k) => k.id));
  const mineChecks = checks.filter((row) => keywordIds.has(row.keyword_id));
  const latest = new Map<string, { date: string; error: string | null }>();
  for (const row of mineChecks) {
    if (!latest.has(row.keyword_id)) latest.set(row.keyword_id, { date: row.check_date, error: row.error });
  }
  // The two most recent checks that produced positions: one to report, one to
  // measure against. Failed checks are skipped — they say nothing about where
  // a site ranked, so comparing with one would invent a drop.
  const history = successfulCheckDates(mineChecks);
  const currentDate = (id: string) => history.get(id)?.[0];
  const previousDate = (id: string) => history.get(id)?.[1];
  // Depth per stored check, so reducing a campaign's depth exports "out of
  // range" blind spots rather than a wave of phantom drop-outs.
  const checkDepths = depthByCheck(mineChecks, DEFAULT_DEPTH);
  const depthAt = (id: string, date: string | undefined) =>
    date ? (checkDepths.get(`${id}|${date}`) ?? DEFAULT_DEPTH) : null;
  const comparedDates = [
    ...new Set(
      keywords.flatMap((k) => [currentDate(k.id), previousDate(k.id)]).filter(Boolean) as string[],
    ),
  ];
  const rankings = comparedDates.length
    ? await all<RankingRow>((f, t) =>
        supabase!
          .from("serp_rankings")
          .select("keyword_id, domain, position, url, check_date")
          .eq("organisation_id", orgId)
          .in("check_date", comparedDates)
          .order("id")
          .range(f, t),
      )
    : [];
  // Rankings are recorded for every domain the organisation watches, so rows
  // for other campaigns' domains are filtered out here.
  const campaignDomains = new Set(domains.map((d) => normaliseDomain(d.domain)));
  const rowsByKeyword = new Map<string, RankingRow[]>();
  for (const r of rankings) {
    if (!keywordIds.has(r.keyword_id) || !campaignDomains.has(r.domain)) continue;
    const list = rowsByKeyword.get(r.keyword_id);
    if (list) list.push(r);
    else rowsByKeyword.set(r.keyword_id, [r]);
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
    const own = rowsByKeyword.get(k.id) ?? [];
    const mine = (domain: string) => campaignDomains.has(domain);
    const prevDate = previousDate(k.id);
    const nowDate = currentDate(k.id);
    const movements = movement(
      positionsOn(own, nowDate, mine),
      prevDate
        ? new Map([...positionsOn(own, prevDate, mine)].map(([d, v]) => [d, v.position]))
        : null,
      { current: depthAt(k.id, nowDate), previous: depthAt(k.id, prevDate) },
    );
    const ranked = movements.filter((m) => m.position !== null);
    const lost = movements.filter((m) => m.state === "lost");
    const outOfRange = movements.filter((m) => m.state === "out_of_range");
    const candidates = [...homeKey.entries()].filter(([, key]) => key === town).map(([d]) => d);
    const textMatches = candidates.filter((d) => {
      const t = homeTownLower.get(d);
      return t && k.keyword.includes(t);
    });
    const homeSet = new Set(textMatches.length > 0 ? textMatches : candidates);
    const home = ranked.find((r) => homeSet.has(r.domain)) ?? null;
    const homeLost = lost.find((r) => homeSet.has(r.domain)) ?? null;
    const overlap = ranked.filter((r) => !homeSet.has(r.domain) && homeKey.has(r.domain));
    return {
      k,
      check,
      town,
      movements,
      ranked,
      lost,
      outOfRange,
      hasHome: homeSet.size > 0,
      homeSet,
      home,
      homeLost,
      overlap,
      comparedWith: prevDate ?? null,
    };
  });

  const homeChange = (s: (typeof summarised)[number]) => s.home?.change ?? 0;
  const filtered = summarised.filter((s) => {
    if (q && !s.k.keyword.includes(q) && !s.k.location_name.toLowerCase().includes(q)) return false;
    if (view === "missing") return s.hasHome && s.check && !s.check.error && !s.home;
    if (view === "overlap") return s.overlap.length > 0;
    if (view === "failed") return Boolean(s.check?.error);
    if (view === "up") return Boolean(s.comparedWith) && homeChange(s) > 0;
    if (view === "down") return Boolean(s.comparedWith) && homeChange(s) < 0;
    if (view === "lost") return Boolean(s.comparedWith) && s.lost.length > 0;
    return true;
  });
  if (sort === "best") {
    filtered.sort((a, b) => (a.ranked[0]?.position ?? 999) - (b.ranked[0]?.position ?? 999));
  } else if (sort === "home") {
    filtered.sort((a, b) => (a.home?.position ?? 999) - (b.home?.position ?? 999));
  } else if (sort === "sites") {
    filtered.sort((a, b) => b.ranked.length - a.ranked.length);
  } else if (sort === "moved" || sort === "dropped") {
    const score = (s: (typeof summarised)[number]) =>
      !s.comparedWith ? 0 : s.homeLost ? -1000 : homeChange(s);
    filtered.sort((a, b) =>
      sort === "moved" ? Math.abs(score(b)) - Math.abs(score(a)) : score(a) - score(b),
    );
  }

  // previous_position/change are blank when there is nothing to compare with
  // — a first check, or a domain that wasn't there last time. That is not the
  // same as a zero, so it is left empty rather than filled in.
  const lines = [
    "keyword,location,checked,previous_check,status,domain,domain_home_town,is_home,position,previous_position,change,url",
  ];
  for (const { k, check, ranked, lost, homeSet, comparedWith } of filtered) {
    const head = [esc(k.keyword), esc(k.location_name)];
    if (!check) {
      lines.push([...head, "", "", "unchecked", "", "", "", "", "", "", ""].join(","));
      continue;
    }
    if (check.error) {
      lines.push([...head, check.date, "", "failed", "", "", "", "", "", "", esc(check.error)].join(","));
      continue;
    }
    const stamp = [check.date, comparedWith ?? ""];
    const rankedSet = new Set(ranked.map((r) => r.domain));
    for (const r of ranked) {
      lines.push(
        [
          ...head, ...stamp, "ranked",
          esc(r.domain), esc(homeLabel.get(r.domain) ?? ""), homeSet.has(r.domain) ? "yes" : "no",
          r.position, r.previous ?? "", r.change ?? "", esc(r.url),
        ].join(","),
      );
    }
    // Domains that ranked at the previous check and have since fallen out of
    // the top 100 — the movement that matters most, and the one a
    // latest-check-only export cannot show at all.
    for (const r of lost) {
      lines.push(
        [
          ...head, ...stamp, "dropped_out",
          esc(r.domain), esc(homeLabel.get(r.domain) ?? ""), homeSet.has(r.domain) ? "yes" : "no",
          "", r.previous ?? "", "", "",
        ].join(","),
      );
    }
    // The keyword's own home site(s) missing from the organic top 100, and
    // not already reported above as a fresh drop-out.
    const droppedSet = new Set(lost.map((r) => r.domain));
    for (const domain of homeSet) {
      if (rankedSet.has(domain) || droppedSet.has(domain)) continue;
      lines.push(
        [...head, ...stamp, "not_ranking", esc(domain), esc(homeLabel.get(domain) ?? ""), "yes", "", "", "", ""].join(","),
      );
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
