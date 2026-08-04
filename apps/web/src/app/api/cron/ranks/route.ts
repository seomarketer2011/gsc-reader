import { NextRequest, NextResponse } from "next/server";
import { collectSerpResults, dataForSeoConfigured, getWatchedDomains } from "@/lib/engine/serp";
import { getServiceClient } from "@/lib/supabase/server";

export const maxDuration = 300;

// Rank-tracker collection tick (every 5 minutes, all day). It COLLECTS
// finished DataForSEO tasks and nothing else — it never starts a check, so
// it can never spend money on its own. Rank checks are started by hand from
// the campaign's "Check rankings now" button; this tick is what lets you
// close the tab straight afterwards and still get every result. When no
// organisation has tasks in flight it does nothing.
const PAGE = 1000;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });
  if (!dataForSeoConfigured()) return NextResponse.json({ skipped: "DataForSEO not configured" });

  // Only organisations with something actually in flight.
  const orgIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data } = await service
      .from("serp_task_queue")
      .select("organisation_id")
      .order("organisation_id")
      .range(from, from + PAGE - 1);
    for (const row of data ?? []) orgIds.add(row.organisation_id as string);
    if (!data || data.length < PAGE) break;
  }
  if (orgIds.size === 0) return NextResponse.json({ summary: {} });

  const summary: Record<string, string> = {};
  for (const orgId of orgIds) {
    try {
      const watched = await getWatchedDomains(service, orgId);
      // Keyword ids enable tag-based orphan recovery during collection.
      const keywordIdRows = await fetchAll<{ id: string }>(service, "tracked_keywords", "id", orgId);
      const { collected, failed, remaining } = await collectSerpResults(
        service,
        orgId,
        watched,
        250,
        new Set(keywordIdRows.map((r) => r.id)),
      );
      if (collected || failed || remaining) {
        summary[orgId.slice(0, 8)] = `collected ${collected}, failed ${failed}, in-flight ${remaining}`;
      }
    } catch (e) {
      summary[orgId.slice(0, 8)] = `ERROR: ${e instanceof Error ? e.message.slice(0, 150) : "failed"}`;
    }
  }
  // Surfaces in `wrangler tail` so cron behaviour is observable.
  console.log("cron ranks:", JSON.stringify(summary));
  return NextResponse.json({ summary });
}

async function fetchAll<T>(
  service: NonNullable<ReturnType<typeof getServiceClient>>,
  table: string,
  columns: string,
  orgId: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await service
      .from(table)
      .select(columns)
      .eq("organisation_id", orgId)
      .order("organisation_id")
      .range(from, from + PAGE - 1);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}
