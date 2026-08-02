import { NextResponse } from "next/server";
import { checkKeyword, dataForSeoConfigured, getWatchedDomains } from "@/lib/engine/serp";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

// Checks the next few unchecked keywords for today. The client loops until
// done — same chunked pattern as the GSC import — so any number of keywords
// fits within Worker request limits. Each keyword costs one paid SERP call.
const CHUNK = 4;

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
  const [{ data: keywords }, { data: checkedToday }] = await Promise.all([
    service.from("tracked_keywords").select("id, keyword, location_name").eq("organisation_id", orgId),
    service.from("serp_checks").select("keyword_id").eq("organisation_id", orgId).eq("check_date", today),
  ]);
  const total = keywords?.length ?? 0;
  if (total === 0) return NextResponse.json({ done: true, checked: 0, total: 0 });

  const doneIds = new Set((checkedToday ?? []).map((c) => c.keyword_id as string));
  const pending = (keywords ?? []).filter((k) => !doneIds.has(k.id as string));
  if (pending.length === 0) {
    return NextResponse.json({ done: true, checked: total, total });
  }

  const watched = await getWatchedDomains(service, orgId);
  const errors: string[] = [];
  for (const k of pending.slice(0, CHUNK)) {
    const result = await checkKeyword(
      service,
      orgId,
      { id: k.id as string, keyword: k.keyword as string, location_name: k.location_name as string },
      watched,
    );
    if (result.error) errors.push(`${k.keyword}: ${result.error}`);
  }

  const checked = total - Math.max(0, pending.length - CHUNK);
  return NextResponse.json({
    done: pending.length <= CHUNK,
    checked,
    total,
    errors: errors.slice(0, 3),
  });
}
