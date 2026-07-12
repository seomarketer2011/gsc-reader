import { NextResponse } from "next/server";
import { runDetectors } from "@/lib/engine/detect";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

// Runs the Phase 4 detectors for every tracked property in the caller's org.
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

  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });

  const { data: properties } = await service
    .from("gsc_properties")
    .select("id, property_uri, sites (id)")
    .eq("organisation_id", membership.organisation_id);

  let total = 0;
  const perProperty: Record<string, number | string> = {};
  for (const p of properties ?? []) {
    const site = (Array.isArray(p.sites) ? p.sites[0] : p.sites) as { id: string } | null;
    try {
      const n = await runDetectors(
        service,
        { id: membership.organisation_id },
        { id: p.id as string, property_uri: p.property_uri as string, site_id: site?.id ?? null },
      );
      perProperty[p.property_uri as string] = n;
      total += n;
    } catch (e) {
      perProperty[p.property_uri as string] = e instanceof Error ? e.message.slice(0, 120) : "failed";
    }
  }
  return NextResponse.json({ opportunities: total, perProperty });
}
