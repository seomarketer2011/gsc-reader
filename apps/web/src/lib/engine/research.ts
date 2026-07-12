// Shared helpers for the keyword research screen (server only).

import { SupabaseClient } from "@supabase/supabase-js";
import { normaliseQuery } from "./cluster";
import { KeywordVolume } from "./volumes";

export interface ResearchRow {
  keyword: string;
  cluster: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: string | null;
  competitionIndex: number | null;
  monthly: KeywordVolume["monthly"];
  yourSite: string | null;
  yourImpressions28d: number;
  yourPosition: number | null;
}

/** Which of the org's tracked sites already rank for each keyword (28 days). */
export async function crossReferenceRankings(
  service: SupabaseClient,
  orgId: string,
  keywords: string[],
): Promise<Map<string, { site: string; impressions: number; position: number }>> {
  const out = new Map<string, { site: string; impressions: number; position: number }>();
  if (keywords.length === 0) return out;
  const { data } = await service
    .from("gsc_performance_daily")
    .select("query, impressions, position, gsc_properties (property_uri)")
    .eq("organisation_id", orgId)
    .in("query", keywords)
    .gte("date", new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10))
    .limit(20000);
  const agg = new Map<string, { site: string; impressions: number; posSum: number; n: number }>();
  for (const r of data ?? []) {
    const prop = (Array.isArray(r.gsc_properties) ? r.gsc_properties[0] : r.gsc_properties) as {
      property_uri: string;
    } | null;
    const site = (prop?.property_uri ?? "").replace(/^sc-domain:/, "");
    const key = r.query as string;
    const a = agg.get(key) ?? { site, impressions: 0, posSum: 0, n: 0 };
    a.impressions += Number(r.impressions);
    a.posSum += Number(r.position);
    a.n++;
    agg.set(key, a);
  }
  for (const [key, a] of agg) {
    out.set(key, {
      site: a.site,
      impressions: a.impressions,
      position: a.n ? Math.round((a.posSum / a.n) * 10) / 10 : 0,
    });
  }
  return out;
}

export function toResearchRows(
  keywords: string[],
  volumes: Map<string, KeywordVolume>,
  rankings: Map<string, { site: string; impressions: number; position: number }>,
): ResearchRow[] {
  const rows = keywords.map((k) => {
    const v = volumes.get(k);
    const rank = rankings.get(k);
    return {
      keyword: k,
      cluster: normaliseQuery(k).key,
      searchVolume: v?.searchVolume ?? null,
      cpc: v?.cpc ?? null,
      competition: v?.competition ?? null,
      competitionIndex: v?.competitionIndex ?? null,
      monthly: v?.monthly ?? null,
      yourSite: rank?.site ?? null,
      yourImpressions28d: rank?.impressions ?? 0,
      yourPosition: rank?.position ?? null,
    };
  });
  rows.sort((a, b) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1));
  return rows;
}
