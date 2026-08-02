// Phase 4/5 detectors — deterministic rules over real Search Console data
// (docs/OPPORTUNITY_RULES.md), operating on query CLUSTERS so wording
// variants ("locksmith croydon" / "croydon locksmiths") yield one
// opportunity, not six. No LLM anywhere in the decision path.

import { SupabaseClient } from "@supabase/supabase-js";
import { ClusterMember, clusterQueries, locationsFromDomains, QueryClusterAgg } from "./cluster";
import { getVolumes } from "./volumes";
import { fetchPaged } from "@/lib/supabase/paged";

interface DetectedOpportunity {
  type: string;
  title: string;
  score: number;
  networkImpressions: number;
  estLow: number;
  estHigh: number;
  intent: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  effort: "low" | "medium" | "high";
  whatWeFound: string;
  whyItMatters: string;
  proposedChange: string;
  risks: string[];
  evidence: Array<Record<string, unknown>>;
}

function expectedCtr(position: number): number {
  if (position <= 1.5) return 0.28;
  if (position <= 3) return 0.12;
  if (position <= 5) return 0.06;
  if (position <= 10) return 0.025;
  return 0.01;
}

const memberEvidence = (c: QueryClusterAgg) =>
  c.members.slice(0, 8).map((m) => ({
    query: m.query,
    impressions: m.impressions,
    clicks: m.clicks,
    position: Math.round(m.position * 10) / 10,
  }));

const variantNote = (c: QueryClusterAgg) =>
  c.members.length > 1 ? ` (${c.members.length} query variants combined)` : "";

export async function runDetectors(
  service: SupabaseClient,
  org: { id: string },
  property: { id: string; property_uri: string; site_id: string | null },
): Promise<number> {
  const since = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };

  const rows = await fetchPaged<{
    date: string; query: string; page: string; clicks: number; impressions: number; position: number;
  }>((from, to) =>
    service
      .from("gsc_performance_daily")
      .select("date, query, page, clicks, impressions, position")
      .eq("gsc_property_id", property.id)
      .gte("date", since(28))
      .order("impressions", { ascending: false })
      .order("date")
      .order("query")
      .range(from, to),
  );
  if (rows.length === 0) return 0;

  // Aggregate per query (and track pages + recency alongside).
  interface PageAgg { impressions: number; clicks: number; posSum: number; days: number }
  interface Agg { clicks: number; impressions: number; posSum: number; days: number; recentClicks: number; prevClicks: number; pages: Map<string, PageAgg> }
  const byQuery = new Map<string, Agg>();
  const recent = { clicks: 0, prevClicks: 0 };
  const midpoint = since(14);
  for (const r of rows) {
    const agg = byQuery.get(r.query as string) ?? { clicks: 0, impressions: 0, posSum: 0, days: 0, recentClicks: 0, prevClicks: 0, pages: new Map() };
    agg.clicks += Number(r.clicks);
    agg.impressions += Number(r.impressions);
    agg.posSum += Number(r.position);
    agg.days++;
    const page = agg.pages.get(r.page as string) ?? { impressions: 0, clicks: 0, posSum: 0, days: 0 };
    page.impressions += Number(r.impressions);
    page.clicks += Number(r.clicks);
    page.posSum += Number(r.position);
    page.days++;
    agg.pages.set(r.page as string, page);
    byQuery.set(r.query as string, agg);
    if ((r.date as string) >= midpoint) {
      recent.clicks += Number(r.clicks);
      agg.recentClicks += Number(r.clicks);
    } else {
      recent.prevClicks += Number(r.clicks);
      agg.prevClicks += Number(r.clicks);
    }
  }

  // Cluster the queries (org domains supply extra location tokens).
  const { data: orgSites } = await service.from("sites").select("domain").eq("organisation_id", org.id);
  const extraLocations = locationsFromDomains((orgSites ?? []).map((s) => s.domain as string));
  const members: ClusterMember[] = [...byQuery.entries()].map(([query, a]) => ({
    query,
    clicks: a.clicks,
    impressions: a.impressions,
    position: a.days ? a.posSum / a.days : 0,
  }));
  const clusters = clusterQueries(members, extraLocations);

  const daysOfData = new Set(rows.map((r) => r.date as string)).size;
  const confidence = daysOfData >= 25 ? "high" : daysOfData >= 12 ? "medium" : "low";
  const domain = property.property_uri.replace(/^sc-domain:/, "");
  const topPageFor = (c: QueryClusterAgg) => {
    const pages = new Map<string, PageAgg>();
    for (const m of c.members) {
      const agg = byQuery.get(m.query);
      for (const [page, p] of agg?.pages ?? []) {
        const t = pages.get(page) ?? { impressions: 0, clicks: 0, posSum: 0, days: 0 };
        t.impressions += p.impressions;
        t.clicks += p.clicks;
        t.posSum += p.posSum;
        t.days += p.days;
        pages.set(page, t);
      }
    }
    return [...pages.entries()].sort((a, b) => b[1].impressions - a[1].impressions);
  };
  const found: DetectedOpportunity[] = [];

  for (const c of clusters) {
    const pages = topPageFor(c);

    // 1. Striking distance: cluster position 4–15 with meaningful impressions.
    if (c.position >= 4 && c.position <= 15 && c.impressions >= 20) {
      found.push({
        type: "striking_distance",
        title: `“${c.name}” is in striking distance on ${domain}`,
        score: Math.min(95, Math.round(c.impressions / 4 + (16 - c.position) * 3)),
        networkImpressions: c.impressions,
        estLow: Math.round(c.impressions * 0.03),
        estHigh: Math.round(c.impressions * 0.12),
        intent: "high",
        confidence,
        effort: "low",
        whatWeFound: `“${c.name}”${variantNote(c)} ranks at average position ${c.position.toFixed(1)} with ${c.impressions} impressions in 28 days.`,
        whyItMatters: "Positions 4–15 are the cheapest wins: small on-page improvements typically move these onto page one.",
        proposedChange: `Strengthen ${pages[0]?.[0] ?? "the ranking page"}: align the title and H1 with “${c.name}”, add internal links from related pages, and expand local proof content.`,
        risks: [],
        evidence: memberEvidence(c),
      });
    }

    // 2. CTR underperformance vs the position-expected curve.
    const ctr = c.impressions ? c.clicks / c.impressions : 0;
    const expected = expectedCtr(c.position);
    if (c.impressions >= 50 && c.position <= 10 && ctr < expected * 0.5) {
      const lost = Math.round(c.impressions * (expected - ctr));
      found.push({
        type: "ctr_underperformance",
        title: `“${c.name}” earns far fewer clicks than its position should`,
        score: Math.min(90, 20 + lost),
        networkImpressions: c.impressions,
        estLow: Math.round(lost * 0.4),
        estHigh: lost,
        intent: "medium",
        confidence,
        effort: "low",
        whatWeFound: `At position ${c.position.toFixed(1)}, “${c.name}”${variantNote(c)} gets ${(ctr * 100).toFixed(1)}% CTR vs ~${(expected * 100).toFixed(0)}% expected (${c.impressions} impressions).`,
        whyItMatters: "The ranking is already earned — only the snippet is losing the click.",
        proposedChange: `Rewrite the title and meta description of ${pages[0]?.[0] ?? "the ranking page"} to match the query intent and add a compelling local hook.`,
        risks: [],
        evidence: memberEvidence(c),
      });
    }

    // 3. Internal competition: impressions for one cluster split across pages.
    const significant = pages.filter(([, p]) => p.impressions >= 15);
    if (significant.length >= 2 && c.impressions >= 30) {
      found.push({
        type: "url_switching",
        title: `${significant.length} pages compete for “${c.name}”`,
        score: Math.min(80, 15 + c.impressions / 5),
        networkImpressions: c.impressions,
        estLow: Math.round(c.impressions * 0.02),
        estHigh: Math.round(c.impressions * 0.08),
        intent: "medium",
        confidence,
        effort: "medium",
        whatWeFound: `Impressions for “${c.name}”${variantNote(c)} are split across ${significant.length} URLs, which suppresses all of them.`,
        whyItMatters: "Internal competition splits ranking signals; consolidating usually lifts the winner several positions.",
        proposedChange: "Pick the canonical page, merge overlapping content, and de-optimise or redirect the competitor.",
        risks: ["Redirecting the wrong page can lose long-tail rankings — check each page's full query set first"],
        evidence: significant.map(([page, p]) => ({
          query: c.name,
          page,
          impressions: p.impressions,
          clicks: p.clicks,
          position: p.days ? Math.round((p.posSum / p.days) * 10) / 10 : 0,
        })),
      });
    }
  }

  // 4. Declining clicks (needs enough history; skipped for young properties).
  if (daysOfData >= 24 && recent.prevClicks >= 10) {
    const drop = (recent.prevClicks - recent.clicks) / recent.prevClicks;
    if (drop >= 0.3) {
      const decliners = [...byQuery.entries()]
        .filter(([, a]) => a.prevClicks > a.recentClicks)
        .sort((x, y) => (y[1].prevClicks - y[1].recentClicks) - (x[1].prevClicks - x[1].recentClicks))
        .slice(0, 8)
        .map(([query, a]) => ({
          query,
          impressions: a.impressions,
          clicks: a.clicks,
          position: a.days ? Math.round((a.posSum / a.days) * 10) / 10 : 0,
          clicksPrev14d: a.prevClicks,
          clicksLatest14d: a.recentClicks,
        }));
      found.push({
        type: "declining_clicks",
        title: `${domain} clicks are down ${(drop * 100).toFixed(0)}% fortnight-on-fortnight`,
        score: Math.min(85, 30 + drop * 60),
        networkImpressions: recent.clicks + recent.prevClicks,
        estLow: 0,
        estHigh: recent.prevClicks - recent.clicks,
        intent: "high",
        confidence,
        effort: "medium",
        whatWeFound: `Clicks fell from ${recent.prevClicks} to ${recent.clicks} across the last two 14-day windows.`,
        whyItMatters: "Decay usually precedes a larger ranking loss; early refresh is cheap.",
        proposedChange: "Refresh the pages behind the declining queries listed in the evidence and re-validate internal links.",
        risks: [],
        evidence: [{ previous14d: recent.prevClicks, latest14d: recent.clicks }, ...decliners],
      });
    }
  }

  // 5. Low visibility vs real search volume — per cluster, volume = MAX of
  // member volumes (variants share the same underlying demand).
  const topClusters = clusters.slice(0, 60);
  try {
    const keywords = topClusters.flatMap((c) => c.members.slice(0, 3).map((m) => m.query));
    const volumes = await getVolumes(service, org.id, keywords);
    for (const c of topClusters) {
      let volume = 0;
      let cpc: number | null = null;
      for (const m of c.members.slice(0, 3)) {
        const v = volumes.get(m.query.toLowerCase().trim());
        if (v?.searchVolume && v.searchVolume > volume) {
          volume = v.searchVolume;
          cpc = v.cpc;
        }
      }
      if (volume < 50 || c.impressions >= volume * 0.2) continue;
      found.push({
        type: "low_visibility",
        title: `“${c.name}” has ${volume}/mo searches but ${domain} is barely visible`,
        score: Math.min(92, 25 + volume / 20 + (cpc ?? 0) * 2),
        networkImpressions: c.impressions,
        estLow: Math.round(volume * 0.02),
        estHigh: Math.round(volume * 0.1),
        intent: (cpc ?? 0) >= 5 ? "high" : "medium",
        confidence,
        effort: "medium",
        whatWeFound: `Google reports ~${volume} monthly searches for this topic (CPC $${cpc ?? "?"}), but the site received only ${c.impressions} impressions across ${c.members.length} variant ${c.members.length === 1 ? "query" : "queries"} in 28 days (avg position ${c.position.toFixed(1)}).`,
        whyItMatters: "Real demand exists that the site is not yet eligible for — content depth or a dedicated page closes the gap.",
        proposedChange: `Build out dedicated, locally-detailed content targeting “${c.name}” and its variants.`,
        risks: ["Volume is market-wide; local share depends on service area"],
        evidence: [
          { query: c.name, searchVolume: volume, cpc, impressions28d: c.impressions, clicks: c.clicks, position: Math.round(c.position * 10) / 10 },
          ...memberEvidence(c),
        ],
      });
    }
  } catch {
    // Volume enrichment is best-effort — detectors 1-4 still stand without it.
  }

  // Replace previous open auto-detected opportunities for this property's site.
  found.sort((a, b) => b.score - a.score);
  const top = found.slice(0, 40);
  await service
    .from("opportunities")
    .delete()
    .eq("organisation_id", org.id)
    .eq("site_id", property.site_id)
    .eq("status", "open");
  if (top.length > 0) {
    const { data: inserted, error } = await service
      .from("opportunities")
      .insert(
        top.map((o) => ({
          organisation_id: org.id,
          type: o.type,
          status: "open",
          title: o.title,
          site_id: property.site_id,
          score: Math.round(o.score * 10) / 10,
          network_impressions: o.networkImpressions,
          est_clicks_low: o.estLow,
          est_clicks_high: o.estHigh,
          commercial_intent: o.intent,
          confidence: o.confidence,
          effort: o.effort,
          what_we_found: o.whatWeFound,
          why_it_matters: o.whyItMatters,
          proposed_change: o.proposedChange,
          risks: o.risks,
          site_plans: [],
        })),
      )
      .select("id");
    if (error) throw new Error(`opportunity insert failed: ${error.message}`);
    if (inserted) {
      await service.from("opportunity_evidence").insert(
        inserted.map((row, i) => ({
          organisation_id: org.id,
          opportunity_id: row.id,
          kind: "query_stats",
          payload: top[i].evidence,
        })),
      );
    }
  }
  return top.length;
}
