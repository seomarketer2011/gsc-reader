import { NextRequest, NextResponse } from "next/server";
import { getVolumes } from "@/lib/engine/volumes";
import { normaliseQuery } from "@/lib/engine/cluster";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

const MAX_KEYWORDS = 700;

// Standalone keyword research: volumes for a pasted list, plus which of the
// organisation's own sites already rank for each keyword.
export async function POST(request: NextRequest) {
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

  const body = (await request.json().catch(() => ({}))) as { keywords?: string[] };
  const keywords = [
    ...new Set((body.keywords ?? []).map((k) => k.toLowerCase().trim()).filter((k) => k.length > 1)),
  ];
  if (keywords.length === 0) return NextResponse.json({ error: "no keywords supplied" }, { status: 400 });
  if (keywords.length > MAX_KEYWORDS) {
    return NextResponse.json({ error: `too many keywords (max ${MAX_KEYWORDS})` }, { status: 400 });
  }

  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });

  // How many are cache misses (i.e. will cost money)? Reported for transparency.
  const { data: cached } = await service
    .from("keyword_volumes")
    .select("keyword")
    .eq("organisation_id", membership.organisation_id)
    .in("keyword", keywords);
  const cachedSet = new Set((cached ?? []).map((c) => c.keyword as string));

  let volumes;
  try {
    volumes = await getVolumes(service, membership.organisation_id, keywords);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 300) : "volume lookup failed" },
      { status: 502 },
    );
  }

  // Cross-reference: does any of the org's tracked sites already rank?
  const { data: ranking } = await service
    .from("gsc_performance_daily")
    .select("query, gsc_property_id, impressions, clicks, position, gsc_properties (property_uri)")
    .eq("organisation_id", membership.organisation_id)
    .in("query", keywords)
    .gte("date", new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10))
    .limit(20000);
  const bestBySite = new Map<string, { site: string; impressions: number; posSum: number; n: number }>();
  for (const r of ranking ?? []) {
    const prop = (Array.isArray(r.gsc_properties) ? r.gsc_properties[0] : r.gsc_properties) as { property_uri: string } | null;
    const site = (prop?.property_uri ?? "").replace(/^sc-domain:/, "");
    const key = r.query as string;
    const agg = bestBySite.get(key) ?? { site, impressions: 0, posSum: 0, n: 0 };
    agg.impressions += Number(r.impressions);
    agg.posSum += Number(r.position);
    agg.n++;
    if (site && !agg.site) agg.site = site;
    bestBySite.set(key, agg);
  }

  const rows = keywords.map((k) => {
    const v = volumes.get(k);
    const rank = bestBySite.get(k);
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
      yourPosition: rank && rank.n ? Math.round((rank.posSum / rank.n) * 10) / 10 : null,
    };
  });
  rows.sort((a, b) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1));

  return NextResponse.json({
    rows,
    total: rows.length,
    newlyFetched: keywords.length - cachedSet.size,
    fromCache: cachedSet.size,
  });
}
