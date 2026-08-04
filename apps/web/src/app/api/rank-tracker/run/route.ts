import { NextResponse } from "next/server";
import {
  collectSerpResults,
  dataForSeoConfigured,
  getWatchedDomains,
  postSerpTasks,
} from "@/lib/engine/serp";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

export const maxDuration = 300;

// Queue-based run for ONE campaign: the first call posts that campaign's
// unchecked keywords to DataForSEO's task queue (seconds, ~3x cheaper than
// live mode); subsequent calls collect finished results until the queue
// drains. Only the campaign's keywords are ever posted, so checking a
// five-keyword client never pays for the rest of the organisation.
// Collection stays organisation-wide — anything already in flight from
// another campaign is banked too rather than left to the cron.
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

export async function POST(request: Request) {
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

  // The campaign is the unit of work; checked against the caller's own
  // client so a forged id can't reach another organisation's keywords.
  const body = (await request.json().catch(() => ({}))) as { campaignId?: string };
  const campaignId = String(body.campaignId ?? "");
  if (!campaignId) return NextResponse.json({ error: "campaign required" }, { status: 400 });
  const { data: campaign } = await supabase!
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("organisation_id", orgId)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: "campaign not found" }, { status: 404 });

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
        .eq("campaign_id", campaignId)
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

  const mine = new Set(keywords.map((k) => k.id));
  const watched = await getWatchedDomains(service, orgId);
  await collectSerpResults(service, orgId, watched, 150, mine);

  // Progress is this campaign's, not the organisation's: a sweep running for
  // another campaign must not keep this button spinning (or, worse, make it
  // report "done" off someone else's numbers).
  const [checkedNow, stillQueued] = await Promise.all([
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
  const checkedCount = checkedNow.filter((r) => mine.has(r.keyword_id)).length;
  const processing = stillQueued.filter((r) => mine.has(r.keyword_id)).length;

  return NextResponse.json({
    done: processing === 0 && toPost.length - posted === 0 && checkedCount >= total,
    checked: checkedCount,
    total,
    posted,
    processing,
  });
}
