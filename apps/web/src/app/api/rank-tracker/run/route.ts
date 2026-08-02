import { NextResponse } from "next/server";
import {
  collectSerpResults,
  dataForSeoConfigured,
  getWatchedDomains,
  postSerpTasks,
} from "@/lib/engine/serp";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

export const maxDuration = 300;

// Queue-based run: the first call posts every unchecked keyword to
// DataForSEO's task queue (seconds, ~3x cheaper than live mode); subsequent
// calls collect finished results until the queue drains. The client loops
// with a short delay — and even if the tab closes, the */5 cron collects
// whatever is still in flight.
const PAGE = 1000;

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await build(from, from + PAGE - 1);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export async function POST() {
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
  const orgId = membership.organisation_id as string;

  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });
  if (!dataForSeoConfigured()) {
    return NextResponse.json({ error: "DataForSEO credentials are not configured" }, { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const [keywords, checkedToday, queuedToday] = await Promise.all([
    fetchAllRows<{ id: string; keyword: string; location_name: string }>((from, to) =>
      service
        .from("tracked_keywords")
        .select("id, keyword, location_name")
        .eq("organisation_id", orgId)
        .order("id")
        .range(from, to),
    ),
    fetchAllRows<{ keyword_id: string }>((from, to) =>
      service
        .from("serp_checks")
        .select("keyword_id")
        .eq("organisation_id", orgId)
        .eq("check_date", today)
        .order("keyword_id")
        .range(from, to),
    ),
    fetchAllRows<{ keyword_id: string }>((from, to) =>
      service
        .from("serp_task_queue")
        .select("keyword_id")
        .eq("organisation_id", orgId)
        .order("keyword_id")
        .range(from, to),
    ),
  ]);
  const total = keywords.length;
  if (total === 0) return NextResponse.json({ done: true, checked: 0, total: 0, processing: 0 });

  const excluded = new Set([
    ...checkedToday.map((c) => c.keyword_id),
    ...queuedToday.map((q) => q.keyword_id),
  ]);
  const toPost = keywords.filter((k) => !excluded.has(k.id));
  const posted = toPost.length > 0 ? await postSerpTasks(service, orgId, toPost) : 0;

  const watched = await getWatchedDomains(service, orgId);
  const { remaining } = await collectSerpResults(
    service,
    orgId,
    watched,
    150,
    new Set(keywords.map((k) => k.id)),
  );

  const { count: checkedCount } = await service
    .from("serp_checks")
    .select("id", { count: "exact", head: true })
    .eq("organisation_id", orgId)
    .eq("check_date", today);

  return NextResponse.json({
    done: remaining === 0 && toPost.length - posted === 0 && (checkedCount ?? 0) >= total,
    checked: checkedCount ?? 0,
    total,
    posted,
    processing: remaining,
  });
}
