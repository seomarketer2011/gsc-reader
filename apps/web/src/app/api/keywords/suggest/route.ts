import { NextRequest, NextResponse } from "next/server";
import { cacheVolumes, fetchKeywordIdeas, KeywordVolume } from "@/lib/engine/volumes";
import { crossReferenceRankings, toResearchRows } from "@/lib/engine/research";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

const MAX_SEEDS = 20;
const MAX_RESULTS = 300;

// Expands seed keywords into new keyword ideas (with volumes) that the user
// hasn't thought of. One paid DataForSEO call per run; every returned idea is
// cached so future volume lookups are free.
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

  const body = (await request.json().catch(() => ({}))) as { seeds?: string[] };
  const seeds = [
    ...new Set((body.seeds ?? []).map((k) => k.toLowerCase().trim()).filter((k) => k.length > 1)),
  ].slice(0, MAX_SEEDS);
  if (seeds.length === 0) return NextResponse.json({ error: "no seed keywords supplied" }, { status: 400 });

  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });

  let ideas: KeywordVolume[];
  try {
    ideas = await fetchKeywordIdeas(seeds);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 300) : "suggestion fetch failed" },
      { status: 502 },
    );
  }

  // Keep ideas with real volume, drop the seeds themselves, cap the payload.
  const seedSet = new Set(seeds);
  const kept = ideas
    .filter((i) => (i.searchVolume ?? 0) > 0 && !seedSet.has(i.keyword))
    .sort((a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0))
    .slice(0, MAX_RESULTS);

  await cacheVolumes(service, membership.organisation_id, kept);

  const keywords = kept.map((i) => i.keyword);
  const rankings = await crossReferenceRankings(service, membership.organisation_id, keywords);
  const rows = toResearchRows(keywords, new Map(kept.map((i) => [i.keyword, i])), rankings);

  return NextResponse.json({
    rows,
    total: rows.length,
    discovered: ideas.length,
    seeds,
  });
}
