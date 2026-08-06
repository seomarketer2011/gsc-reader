import { NextResponse } from "next/server";
import {
  collectSerpResults,
  dataForSeoConfigured,
  getWatchedDomains,
  normaliseDepth,
  normalisePriority,
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

  // The campaign is the unit of work, and it carries its own organisation.
  // Read through the caller's client so RLS does the authorisation: a
  // campaign in an organisation they don't belong to simply isn't returned.
  //
  // Do NOT cross-check against a separately-looked-up "current" org.
  // organisation_users is read with limit(1) and no ordering, so a user in
  // more than one organisation can get a different row here than the page
  // did — which showed up as "campaign not found" on a campaign plainly
  // visible on screen.
  const body = (await request.json().catch(() => ({}))) as { campaignId?: string };
  const campaignId = String(body.campaignId ?? "");
  if (!campaignId) return NextResponse.json({ error: "campaign required" }, { status: 400 });
  const { data: campaign } = await supabase!
    .from("campaigns")
    .select("id, organisation_id, serp_depth, serp_priority")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) return NextResponse.json({ error: "campaign not found" }, { status: 404 });
  const orgId = campaign.organisation_id as string;
  // How deep this campaign looks and which queue it uses — together, what
  // the run costs.
  const depth = normaliseDepth(campaign.serp_depth as number | null);
  const priority = normalisePriority(campaign.serp_priority as number | null);

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
    // Today's in-flight tasks only. A queue row is what stops a keyword being
    // posted (and paid for) twice, but a row left over from an earlier day is
    // a task that never came back — counting it would exclude its keyword
    // from every future check and leave `done` permanently out of reach.
    // Collection still expires those rows separately.
    fetchAllRows<{ keyword_id: string }>((from, to) =>
      service
        .from("serp_task_queue")
        .select("keyword_id")
        .eq("organisation_id", orgId)
        .eq("check_date", today)
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
  // Claim before posting. Two tabs — or one impatient double press — can hit
  // this route in the same second; both would see an empty queue and both
  // would pay to post the same keywords. The queue's (keyword_id,
  // check_date) uniqueness makes claiming atomic: ignoreDuplicates hands
  // each keyword to exactly one caller, and only the winner posts it.
  let posted = 0;
  if (toPost.length > 0) {
    const { data: claimedRows } = await service
      .from("serp_task_queue")
      .upsert(
        toPost.map((k) => ({
          organisation_id: orgId,
          keyword_id: k.id,
          task_id: `claim-${k.id}`,
          depth,
        })),
        { onConflict: "keyword_id,check_date", ignoreDuplicates: true },
      )
      .select("keyword_id");
    const won = new Set((claimedRows ?? []).map((r) => r.keyword_id as string));
    const mineToPost = toPost.filter((k) => won.has(k.id));
    if (mineToPost.length > 0) {
      try {
        posted = await postSerpTasks(service, orgId, mineToPost, depth, priority);
      } finally {
        // Release claims that never became real tasks (post failed or was
        // rejected), so those keywords aren't blocked until expiry. Scoped
        // to OUR claim ids — another caller's fresh claims must survive.
        for (let i = 0; i < mineToPost.length; i += 100) {
          await service
            .from("serp_task_queue")
            .delete()
            .eq("organisation_id", orgId)
            .in(
              "task_id",
              mineToPost.slice(i, i + 100).map((k) => `claim-${k.id}`),
            );
        }
      }
    }
  }

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
        .eq("check_date", today)
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
    depth,
  });
}
