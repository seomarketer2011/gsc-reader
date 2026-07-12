import { NextRequest, NextResponse } from "next/server";
import { importNextChunk } from "@/lib/google/import";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

// Imports the next chunk of Search Console history for a tracked property.
// The client calls this in a loop until { done: true }.
export async function POST(request: NextRequest) {
  const supabase = await getServerClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { propertyId } = (await request.json().catch(() => ({}))) as { propertyId?: string };
  if (!propertyId) return NextResponse.json({ error: "propertyId required" }, { status: 400 });

  // RLS proves membership: the row is only visible if the user is in its org.
  const { data: property } = await supabase!
    .from("gsc_properties")
    .select("id, organisation_id, property_uri, google_connection_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!property) return NextResponse.json({ error: "property not found" }, { status: 404 });

  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });

  try {
    const progress = await importNextChunk(service, property);
    await service.from("sync_runs").insert({
      organisation_id: property.organisation_id,
      gsc_property_id: property.id,
      sync_type: "backfill",
      status: "succeeded",
      rows_imported: progress.rowsImported,
      finished_at: new Date().toISOString(),
    });
    return NextResponse.json(progress);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 300) : "import failed" },
      { status: 502 },
    );
  }
}
