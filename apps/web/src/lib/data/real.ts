// Real Search Console data (Phase 3b). Server-only reads via the user's
// session (RLS scopes everything to their organisation). Screens fall back
// to fixtures when no real site exists yet.

import { getServerClient } from "@/lib/supabase/server";
import { DailyPoint, Opportunity, PageStat, QueryVariation } from "@/lib/types";

export interface RealSite {
  id: string;
  name: string;
  domain: string;
  propertyId: string;
  propertyUri: string;
}

export async function getRealSites(): Promise<RealSite[]> {
  const supabase = await getServerClient();
  if (!supabase) return [];
  const { data } = await supabase
    .from("sites")
    .select("id, name, domain, gsc_property_id, gsc_properties (property_uri)")
    .not("gsc_property_id", "is", null);
  return (data ?? []).map((row) => {
    const property = row.gsc_properties as unknown as { property_uri: string } | null;
    return {
      id: row.id as string,
      name: row.name as string,
      domain: row.domain as string,
      propertyId: row.gsc_property_id as string,
      propertyUri: property?.property_uri ?? "",
    };
  });
}

export async function getRealSite(siteId: string): Promise<RealSite | null> {
  return (await getRealSites()).find((s) => s.id === siteId) ?? null;
}

/** Daily totals from the gsc_site_daily view, oldest→newest, gaps filled. */
export async function getRealDailySeries(propertyId: string, days: number): Promise<DailyPoint[]> {
  const supabase = await getServerClient();
  if (!supabase) return [];
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const { data } = await supabase
    .from("gsc_site_daily")
    .select("date, clicks, impressions, position")
    .eq("gsc_property_id", propertyId)
    .gte("date", cutoff.toISOString().slice(0, 10))
    .order("date", { ascending: true });
  const byDate = new Map((data ?? []).map((r) => [r.date as string, r]));
  const points: DailyPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = byDate.get(key);
    const clicks = Number(row?.clicks ?? 0);
    const impressions = Number(row?.impressions ?? 0);
    points.push({
      date: key,
      clicks,
      impressions,
      ctr: impressions ? Math.round((clicks / impressions) * 1000) / 1000 : 0,
      position: Number(row?.position ?? 0),
    });
  }
  return points;
}

async function aggregate(
  propertyId: string,
  dimension: "page" | "query",
  days: number,
): Promise<PageStat[]> {
  const supabase = await getServerClient();
  if (!supabase) return [];
  const since = (offset: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  const fetchWindow = async (from: string, to: string) => {
    const { data } = await supabase
      .from("gsc_performance_daily")
      .select(`${dimension}, clicks, impressions, position`)
      .eq("gsc_property_id", propertyId)
      .gte("date", from)
      .lt("date", to)
      .limit(50000);
    return (data ?? []) as unknown as Array<Record<string, unknown>>;
  };
  const [current, previous] = await Promise.all([
    fetchWindow(since(days), since(0)),
    fetchWindow(since(days * 2), since(days)),
  ]);

  const fold = (rows: Array<Record<string, unknown>>) => {
    const m = new Map<string, { clicks: number; impressions: number; posSum: number; n: number }>();
    for (const r of rows) {
      const key = String(r[dimension]);
      const agg = m.get(key) ?? { clicks: 0, impressions: 0, posSum: 0, n: 0 };
      agg.clicks += Number(r.clicks);
      agg.impressions += Number(r.impressions);
      agg.posSum += Number(r.position);
      agg.n++;
      m.set(key, agg);
    }
    return m;
  };
  const now = fold(current);
  const before = fold(previous);

  return [...now.entries()]
    .map(([key, agg]) => {
      const prevClicks = before.get(key)?.clicks ?? 0;
      return {
        url: key,
        clicks28d: agg.clicks,
        impressions28d: agg.impressions,
        ctr: agg.impressions ? Math.round((agg.clicks / agg.impressions) * 1000) / 1000 : 0,
        position: agg.n ? Math.round((agg.posSum / agg.n) * 10) / 10 : 0,
        clicksChangePct: prevClicks ? Math.round(((agg.clicks - prevClicks) / prevClicks) * 100) : 0,
      };
    })
    .sort((a, b) => b.clicks28d - a.clicks28d || b.impressions28d - a.impressions28d);
}

export async function getRealTopPages(propertyId: string, days = 28): Promise<PageStat[]> {
  return aggregate(propertyId, "page", days);
}

export async function getRealTopQueries(propertyId: string, days = 28): Promise<PageStat[]> {
  return aggregate(propertyId, "query", days);
}

export async function hasImportedData(propertyId: string): Promise<boolean> {
  const supabase = await getServerClient();
  if (!supabase) return false;
  const { count } = await supabase
    .from("gsc_performance_daily")
    .select("date", { count: "exact", head: true })
    .eq("gsc_property_id", propertyId);
  return (count ?? 0) > 0;
}

/** Real detected opportunities for the caller's organisation (RLS-scoped). */
export async function getRealOpportunities(): Promise<Opportunity[]> {
  const supabase = await getServerClient();
  if (!supabase) return [];
  const { data } = await supabase
    .from("opportunities")
    .select("*, opportunity_evidence (payload)")
    .eq("status", "open")
    .order("score", { ascending: false });
  return (data ?? []).map((r) => {
    const evidence = (r.opportunity_evidence ?? []).flatMap(
      (e: { payload: Array<Record<string, unknown>> }) => e.payload ?? [],
    );
    const evidenceQueries: QueryVariation[] = evidence
      .filter((p: Record<string, unknown>) => p.query)
      .map((p: Record<string, unknown>) => ({
        query: String(p.query),
        impressions28d: Number(p.impressions ?? p.impressions28d ?? 0),
        clicks28d: Number(p.clicks ?? 0),
        position: Number(p.position ?? 0),
      }));
    return {
      id: r.id as string,
      type: r.type,
      title: r.title as string,
      clusterId: null,
      serviceId: null,
      siteId: (r.site_id as string) ?? null,
      networkImpressions: Number(r.network_impressions),
      estimatedClicksLow: Number(r.est_clicks_low),
      estimatedClicksHigh: Number(r.est_clicks_high),
      commercialIntent: r.commercial_intent,
      confidence: r.confidence,
      effort: r.effort,
      score: Number(r.score),
      whatWeFound: r.what_we_found as string,
      whyItMatters: r.why_it_matters as string,
      proposedChange: r.proposed_change as string,
      risks: (r.risks as string[]) ?? [],
      sitePlans: [],
      evidenceQueries,
    } as Opportunity;
  });
}
