import { NextRequest, NextResponse } from "next/server";
import { checkKeyword, dataForSeoConfigured, getWatchedDomains } from "@/lib/engine/serp";
import { getServiceClient } from "@/lib/supabase/server";

export const maxDuration = 300;

// Overnight rank refresh (invoked by the */5 cron trigger between 02:00 and
// 05:55 UTC). Each tick checks up to BATCH keywords that have no SERP for
// today, so the fleet of ticks works through any keyword count and later
// ticks exit instantly once everything is done. Protected by CRON_SECRET.
const BATCH = 40;
const PARALLEL = 5;
const PAGE = 1000;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });
  if (!dataForSeoConfigured()) return NextResponse.json({ skipped: "DataForSEO not configured" });

  const today = new Date().toISOString().slice(0, 10);
  const keywords: { id: string; keyword: string; location_name: string; organisation_id: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await service
      .from("tracked_keywords")
      .select("id, keyword, location_name, organisation_id")
      .order("id")
      .range(from, from + PAGE - 1);
    keywords.push(...((data ?? []) as typeof keywords));
    if (!data || data.length < PAGE) break;
  }
  if (keywords.length === 0) return NextResponse.json({ checked: 0, remaining: 0 });

  const doneIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data } = await service
      .from("serp_checks")
      .select("keyword_id")
      .eq("check_date", today)
      .order("keyword_id")
      .range(from, from + PAGE - 1);
    for (const row of data ?? []) doneIds.add(row.keyword_id as string);
    if (!data || data.length < PAGE) break;
  }

  const pending = keywords.filter((k) => !doneIds.has(k.id)).slice(0, BATCH);
  if (pending.length === 0) {
    return NextResponse.json({ checked: 0, remaining: 0 });
  }

  const watchedByOrg = new Map<string, Awaited<ReturnType<typeof getWatchedDomains>>>();
  let checked = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += PARALLEL) {
    await Promise.all(
      pending.slice(i, i + PARALLEL).map(async (k) => {
        let watched = watchedByOrg.get(k.organisation_id);
        if (!watched) {
          watched = await getWatchedDomains(service, k.organisation_id);
          watchedByOrg.set(k.organisation_id, watched);
        }
        const result = await checkKeyword(service, k.organisation_id, k, watched);
        if (result.error) failed++;
        else checked++;
      }),
    );
  }

  return NextResponse.json({
    checked,
    failed,
    remaining: keywords.length - doneIds.size - pending.length,
  });
}
