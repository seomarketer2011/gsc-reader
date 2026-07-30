// Phase 6 network engine — pooled cross-site analysis (docs/PRODUCT_SPEC.md).
// Finds topics proven on one site and missing/weak on others, and builds the
// site × topic coverage matrix. Deterministic; evidence always shows the
// per-site numbers, never a bare network total.

import { SupabaseClient } from "@supabase/supabase-js";
import { clusterQueries, locationsFromDomains, QueryClusterAgg } from "./cluster";

export interface NetworkSite {
  siteId: string;
  propertyId: string;
  domain: string;
}

export type CoverageState = "strong" | "weak" | "some" | "none";

export interface NetworkCell {
  state: CoverageState;
  impressions: number;
  clicks: number;
  position: number | null;
}

export interface NetworkMatrix {
  sites: NetworkSite[];
  topics: { key: string; name: string; totalImpressions: number; siteCount: number }[];
  cells: Record<string, Record<string, NetworkCell>>; // siteId -> topic key -> cell
}

async function siteClusters(
  service: SupabaseClient,
  propertyId: string,
  extraLocations: Set<string>,
): Promise<QueryClusterAgg[]> {
  const cutoff = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  const { data } = await service
    .from("gsc_performance_daily")
    .select("query, clicks, impressions, position")
    .eq("gsc_property_id", propertyId)
    .gte("date", cutoff)
    .limit(50000);
  const byQuery = new Map<string, { clicks: number; impressions: number; posSum: number; n: number }>();
  for (const r of data ?? []) {
    const agg = byQuery.get(r.query as string) ?? { clicks: 0, impressions: 0, posSum: 0, n: 0 };
    agg.clicks += Number(r.clicks);
    agg.impressions += Number(r.impressions);
    agg.posSum += Number(r.position);
    agg.n++;
    byQuery.set(r.query as string, agg);
  }
  return clusterQueries(
    [...byQuery.entries()].map(([query, a]) => ({
      query,
      clicks: a.clicks,
      impressions: a.impressions,
      position: a.n ? a.posSum / a.n : 0,
    })),
    extraLocations,
  );
}

function cellState(c: QueryClusterAgg | undefined): NetworkCell {
  if (!c || c.impressions === 0) return { state: "none", impressions: 0, clicks: 0, position: null };
  const position = c.position;
  if (position <= 10 && c.impressions >= 30)
    return { state: "strong", impressions: c.impressions, clicks: c.clicks, position };
  if (c.impressions >= 15)
    return { state: "weak", impressions: c.impressions, clicks: c.clicks, position };
  return { state: "some", impressions: c.impressions, clicks: c.clicks, position };
}

export async function buildNetworkMatrix(
  service: SupabaseClient,
  orgId: string,
  topicLimit = 15,
  siteIds?: string[],
): Promise<NetworkMatrix> {
  const { data: props } = await service
    .from("gsc_properties")
    .select("id, property_uri, sites (id, domain)")
    .eq("organisation_id", orgId);
  const keep = siteIds ? new Set(siteIds) : null;
  const sites: NetworkSite[] = (props ?? [])
    .map((p) => {
      const site = (Array.isArray(p.sites) ? p.sites[0] : p.sites) as { id: string; domain: string } | null;
      return site ? { siteId: site.id, propertyId: p.id as string, domain: site.domain } : null;
    })
    .filter((s): s is NetworkSite => s !== null && (!keep || keep.has(s.siteId)));

  const extraLocations = locationsFromDomains(sites.map((s) => s.domain));
  const perSite = new Map<string, Map<string, QueryClusterAgg>>();
  for (const site of sites) {
    const clusters = await siteClusters(service, site.propertyId, extraLocations);
    perSite.set(site.siteId, new Map(clusters.map((c) => [c.key, c])));
  }

  // Topic universe: biggest clusters across the whole network.
  const topicTotals = new Map<string, { name: string; totalImpressions: number; siteCount: number }>();
  for (const clusters of perSite.values()) {
    for (const c of clusters.values()) {
      const t = topicTotals.get(c.key) ?? { name: c.name, totalImpressions: 0, siteCount: 0 };
      t.totalImpressions += c.impressions;
      t.siteCount++;
      if (c.impressions > 0) t.name = c.name;
      topicTotals.set(c.key, t);
    }
  }
  const topics = [...topicTotals.entries()]
    .map(([key, t]) => ({ key, ...t }))
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .slice(0, topicLimit);

  const cells: Record<string, Record<string, NetworkCell>> = {};
  for (const site of sites) {
    cells[site.siteId] = {};
    for (const topic of topics) {
      cells[site.siteId][topic.key] = cellState(perSite.get(site.siteId)?.get(topic.key));
    }
  }
  return { sites, topics, cells };
}

/**
 * Network rollout detector: a topic strong on ≥1 site and absent/weak on
 * another site that shows RELATED demand (same head term in its own queries).
 * Writes one org-level opportunity per qualifying topic (site_id null).
 *
 * `group` restricts the pooled analysis to one user-defined site group
 * (e.g. all locksmith sites) so unrelated industries never mix; the caller
 * is then responsible for clearing previous network opportunities once.
 */
export async function detectNetworkOpportunities(
  service: SupabaseClient,
  org: { id: string },
  group?: { name: string; siteIds: string[]; keepExisting?: boolean },
): Promise<number> {
  const matrix = await buildNetworkMatrix(service, org.id, 40, group?.siteIds);
  if (matrix.sites.length < 2) return 0;
  const groupLabel = group?.name ?? "network";

  const headTerm = (key: string) => key.replace(" [location]", "").split(" ")[0];
  const found: Array<{
    topic: { key: string; name: string };
    winners: { domain: string; cell: NetworkCell }[];
    plans: { siteId: string; action: string; reason: string }[];
    totalImpressions: number;
  }> = [];

  for (const topic of matrix.topics) {
    const winners: { domain: string; cell: NetworkCell }[] = [];
    const plans: { siteId: string; action: string; reason: string }[] = [];
    for (const site of matrix.sites) {
      const cell = matrix.cells[site.siteId][topic.key];
      if (cell.state === "strong") {
        winners.push({ domain: site.domain, cell });
        plans.push({ siteId: site.siteId, action: "exclude", reason: `Already strong (position ${cell.position?.toFixed(1)})` });
      } else if (cell.state === "weak" || cell.state === "some") {
        plans.push({
          siteId: site.siteId,
          action: "improve",
          reason: `Has ${cell.impressions} impressions at position ${cell.position?.toFixed(1) ?? "?"} — underperforming vs network winners`,
        });
      } else {
        // Absent: only eligible if the site shows demand for the same head term.
        const related = Object.entries(matrix.cells[site.siteId]).some(
          ([key, c]) => c.state !== "none" && headTerm(key) === headTerm(topic.key),
        );
        plans.push(
          related
            ? { siteId: site.siteId, action: "create", reason: "No coverage, but the site already earns impressions for related terms" }
            : { siteId: site.siteId, action: "review", reason: "No direct or related demand seen — confirm the service applies before building" },
        );
      }
    }
    const actionable = plans.filter((p) => p.action === "create" || p.action === "improve").length;
    if (winners.length >= 1 && actionable >= 1) {
      found.push({ topic, winners, plans, totalImpressions: topic.totalImpressions });
    }
  }

  // Replace previous org-level network opportunities (unless the caller
  // already cleared them, e.g. when running once per group).
  if (!group?.keepExisting) {
    await service
      .from("opportunities")
      .delete()
      .eq("organisation_id", org.id)
      .is("site_id", null)
      .eq("status", "open");
  }
  if (found.length === 0) return 0;

  const top = found.slice(0, 15);
  const { data: inserted, error } = await service
    .from("opportunities")
    .insert(
      top.map((f) => {
        const create = f.plans.filter((p) => p.action === "create").length;
        const improve = f.plans.filter((p) => p.action === "improve").length;
        const review = f.plans.filter((p) => p.action === "review").length;
        const best = f.winners[0];
        return {
          organisation_id: org.id,
          type: "missing_dedicated_page",
          status: "open",
          title: `Roll out “${f.topic.name}” across the ${groupLabel}`,
          site_id: null,
          score: Math.min(90, 30 + f.totalImpressions / 20 + (create + improve) * 8),
          network_impressions: f.totalImpressions,
          est_clicks_low: Math.round(f.totalImpressions * 0.02),
          est_clicks_high: Math.round(f.totalImpressions * 0.08),
          commercial_intent: "high",
          confidence: matrix.sites.length >= 5 ? "high" : "medium",
          effort: "medium",
          what_we_found: `“${f.topic.name}” is proven on ${f.winners.length} ${f.winners.length === 1 ? "site" : "sites"} (best: ${best.domain} at position ${best.cell.position?.toFixed(1)}) while other sites are weak or missing.`,
          why_it_matters: "A topic that already wins on one network site is the strongest possible evidence it can win on the others.",
          proposed_change: `Create dedicated pages on ${create} ${create === 1 ? "site" : "sites"}, improve existing coverage on ${improve}, and review ${review} for applicability.`,
          risks: ["Only roll out to sites that genuinely offer this service in their area"],
          site_plans: f.plans,
        };
      }),
    )
    .select("id");
  if (error) throw new Error(`network opportunity insert failed: ${error.message}`);
  if (inserted) {
    await service.from("opportunity_evidence").insert(
      inserted.map((row, i) => ({
        organisation_id: org.id,
        opportunity_id: row.id,
        kind: "network_coverage",
        payload: top[i].winners.map((w) => ({
          query: top[i].topic.name,
          site: w.domain,
          impressions: w.cell.impressions,
          clicks: w.cell.clicks,
          position: w.cell.position,
        })),
      })),
    );
  }
  return top.length;
}

/**
 * Runs the network detector once per user-defined site group (campaign), so
 * each industry is pooled only with its own kind. Sites in no group form a
 * final "network" pool of their own; with no groups at all, the whole org is
 * one pool (the original behaviour).
 */
export async function runNetworkAnalysis(service: SupabaseClient, orgId: string): Promise<number> {
  const { data: groups } = await service
    .from("campaigns")
    .select("id, name, campaign_sites (site_id)")
    .eq("organisation_id", orgId);
  if (!groups || groups.length === 0) return detectNetworkOpportunities(service, { id: orgId });

  // Clear previous network opportunities once, then accumulate per group.
  await service
    .from("opportunities")
    .delete()
    .eq("organisation_id", orgId)
    .is("site_id", null)
    .eq("status", "open");

  const grouped = new Set<string>();
  let total = 0;
  for (const g of groups) {
    const siteIds = ((g.campaign_sites ?? []) as { site_id: string }[]).map((cs) => cs.site_id);
    for (const id of siteIds) grouped.add(id);
    if (siteIds.length < 2) continue; // pooling needs at least two sites
    total += await detectNetworkOpportunities(service, { id: orgId }, {
      name: `${g.name as string} group`,
      siteIds,
      keepExisting: true,
    });
  }

  const { data: allSites } = await service.from("sites").select("id").eq("organisation_id", orgId);
  const ungrouped = (allSites ?? []).map((s) => s.id as string).filter((id) => !grouped.has(id));
  if (ungrouped.length >= 2) {
    total += await detectNetworkOpportunities(service, { id: orgId }, {
      name: "ungrouped sites",
      siteIds: ungrouped,
      keepExisting: true,
    });
  }
  return total;
}
