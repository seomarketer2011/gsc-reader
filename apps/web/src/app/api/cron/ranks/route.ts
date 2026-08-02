import { NextRequest, NextResponse } from "next/server";
import {
  collectSerpResults,
  dataForSeoConfigured,
  getWatchedDomains,
  postSerpTasks,
} from "@/lib/engine/serp";
import { getServiceClient } from "@/lib/supabase/server";

export const maxDuration = 300;

// Rank-tracker queue tick (every 5 minutes, all day):
// - always COLLECT any finished DataForSEO tasks, so results land within
//   minutes whether the run was started by the button or the sweep window,
//   and even if the user's tab is long closed;
// - POST an automatic sweep only in the overnight window, and only when the
//   last check is at least SWEEP_INTERVAL_DAYS old (weekly refresh — a
//   manual button run resets the clock). Idle ticks exit immediately.
const PAGE = 1000;
const POST_WINDOW = [2, 3, 4, 5]; // UTC hours
const SWEEP_INTERVAL_DAYS = 7;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });
  if (!dataForSeoConfigured()) return NextResponse.json({ skipped: "DataForSEO not configured" });

  // Organisations with tracker activity (keywords or in-flight tasks).
  const orgIds = new Set<string>();
  for (const table of ["tracked_keywords", "serp_task_queue"] as const) {
    for (let from = 0; ; from += PAGE) {
      const { data } = await service
        .from(table)
        .select("organisation_id")
        .order("organisation_id")
        .range(from, from + PAGE - 1);
      for (const row of data ?? []) orgIds.add(row.organisation_id as string);
      if (!data || data.length < PAGE) break;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const inPostWindow = POST_WINDOW.includes(new Date().getUTCHours());
  const summary: Record<string, string> = {};

  for (const orgId of orgIds) {
    try {
      let posted = 0;
      // Sweep is due when the newest check (manual or automatic) is old enough.
      let sweepDue = false;
      if (inPostWindow) {
        const { data: newest } = await service
          .from("serp_checks")
          .select("check_date")
          .eq("organisation_id", orgId)
          .order("check_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        sweepDue =
          !newest ||
          (Date.now() - new Date(`${newest.check_date}T00:00:00Z`).getTime()) / 86400000 >=
            SWEEP_INTERVAL_DAYS;
      }
      if (inPostWindow && sweepDue) {
        const [keywords, checkedToday, queued] = await Promise.all([
          fetchAll<{ id: string; keyword: string; location_name: string }>(
            service, "tracked_keywords", "id, keyword, location_name", orgId,
          ),
          fetchAll<{ keyword_id: string }>(service, "serp_checks", "keyword_id", orgId, today),
          fetchAll<{ keyword_id: string }>(service, "serp_task_queue", "keyword_id", orgId),
        ]);
        const excluded = new Set([
          ...checkedToday.map((c) => c.keyword_id),
          ...queued.map((q) => q.keyword_id),
        ]);
        const toPost = keywords.filter((k) => !excluded.has(k.id));
        if (toPost.length > 0) posted = await postSerpTasks(service, orgId, toPost);
      }
      const watched = await getWatchedDomains(service, orgId);
      const { collected, failed, remaining } = await collectSerpResults(service, orgId, watched, 250);
      if (posted || collected || failed || remaining) {
        summary[orgId.slice(0, 8)] = `posted ${posted}, collected ${collected}, failed ${failed}, in-flight ${remaining}`;
      }
    } catch (e) {
      summary[orgId.slice(0, 8)] = `ERROR: ${e instanceof Error ? e.message.slice(0, 150) : "failed"}`;
    }
  }
  return NextResponse.json({ summary });
}

async function fetchAll<T>(
  service: NonNullable<ReturnType<typeof getServiceClient>>,
  table: string,
  columns: string,
  orgId: string,
  checkDate?: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = service.from(table).select(columns).eq("organisation_id", orgId);
    if (checkDate) query = query.eq("check_date", checkDate);
    const { data } = await query.order("organisation_id").range(from, from + PAGE - 1);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}
