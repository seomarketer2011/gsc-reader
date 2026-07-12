import { NextRequest, NextResponse } from "next/server";
import { getVolumes } from "@/lib/engine/volumes";
import { crossReferenceRankings, toResearchRows } from "@/lib/engine/research";
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

  const rankings = await crossReferenceRankings(service, membership.organisation_id, keywords);
  const rows = toResearchRows(keywords, volumes, rankings);

  return NextResponse.json({
    rows,
    total: rows.length,
    newlyFetched: keywords.length - cachedSet.size,
    fromCache: cachedSet.size,
  });
}
