import { NextRequest, NextResponse } from "next/server";
import { importRecentDays } from "@/lib/google/import";
import { runDetectors } from "@/lib/engine/detect";
import { detectNetworkOpportunities } from "@/lib/engine/network";
import { getServiceClient } from "@/lib/supabase/server";

export const maxDuration = 300;

// Nightly job (invoked by the Worker cron trigger): top up the last few days
// of every tracked property, then re-run all detectors. Protected by
// CRON_SECRET so it cannot be triggered by outsiders.
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const service = getServiceClient();
  if (!service) return NextResponse.json({ error: "service key missing" }, { status: 500 });

  const { data: properties } = await service
    .from("gsc_properties")
    .select("id, organisation_id, property_uri, google_connection_id, sites (id)");

  const summary: Record<string, string> = {};
  const orgIds = new Set<string>();
  for (const p of properties ?? []) {
    const site = (Array.isArray(p.sites) ? p.sites[0] : p.sites) as { id: string } | null;
    const property = {
      id: p.id as string,
      organisation_id: p.organisation_id as string,
      property_uri: p.property_uri as string,
      google_connection_id: p.google_connection_id as string,
    };
    orgIds.add(property.organisation_id);
    try {
      const rows = await importRecentDays(service, property, 5);
      const opportunities = await runDetectors(
        service,
        { id: property.organisation_id },
        { id: property.id, property_uri: property.property_uri, site_id: site?.id ?? null },
      );
      summary[property.property_uri] = `${rows} rows, ${opportunities} opportunities`;
      await service.from("sync_runs").insert({
        organisation_id: property.organisation_id,
        gsc_property_id: property.id,
        sync_type: "incremental",
        status: "succeeded",
        rows_imported: rows,
        finished_at: new Date().toISOString(),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 200) : "failed";
      summary[property.property_uri] = `ERROR: ${message}`;
      await service.from("sync_runs").insert({
        organisation_id: property.organisation_id,
        gsc_property_id: property.id,
        sync_type: "incremental",
        status: "failed",
        error: message,
        finished_at: new Date().toISOString(),
      });
    }
  }
  for (const orgId of orgIds) {
    try {
      summary[`network:${orgId.slice(0, 8)}`] = `${await detectNetworkOpportunities(service, { id: orgId })} rollouts`;
    } catch (e) {
      summary[`network:${orgId.slice(0, 8)}`] = e instanceof Error ? e.message.slice(0, 120) : "failed";
    }
  }
  return NextResponse.json({ ok: true, summary });
}
