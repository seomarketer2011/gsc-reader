import { NextResponse } from "next/server";
import { checkKeyword, dataForSeoConfigured, getWatchedDomains } from "@/lib/engine/serp";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";
import { SupabaseClient } from "@supabase/supabase-js";

// Checks the next few unchecked keywords for today, in parallel. The client
// loops until done — same chunked pattern as the GSC import — so any number
// of keywords fits within Worker limits. Each keyword costs one paid SERP.
const CHUNK = 5;
const PAGE = 1000; // Supabase caps a single select at 1000 rows

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

  const service: SupabaseClient | null = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });
  if (!dataForSeoConfigured()) {
    return NextResponse.json({ error: "DataForSEO credentials are not configured" }, { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const [keywords, checkedToday] = await Promise.all([
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
  ]);
  const total = keywords.length;
  if (total === 0) return NextResponse.json({ done: true, checked: 0, total: 0 });

  const doneIds = new Set(checkedToday.map((c) => c.keyword_id));
  const pending = keywords.filter((k) => !doneIds.has(k.id));
  if (pending.length === 0) {
    return NextResponse.json({ done: true, checked: total, total });
  }

  const watched = await getWatchedDomains(service, orgId);
  const results = await Promise.all(
    pending.slice(0, CHUNK).map((k) =>
      checkKeyword(service, orgId, k, watched).then((r) =>
        r.error ? `${k.keyword}: ${r.error}` : null,
      ),
    ),
  );
  const errors = results.filter((e): e is string => e !== null);

  const checked = total - Math.max(0, pending.length - CHUNK);
  return NextResponse.json({
    done: pending.length <= CHUNK,
    checked,
    total,
    errors: errors.slice(0, 3),
  });
}
