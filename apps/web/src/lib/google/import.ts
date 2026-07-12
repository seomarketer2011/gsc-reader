// Chunked Search Console backfill (server only). Imports day-by-day, newest
// first, in small chunks so each request stays within Worker subrequest
// limits; the client loops until done. Idempotent: re-imports upsert on the
// (property, date, query, page) primary key.

import { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, refreshAccessToken } from "./oauth";

export const BACKFILL_DAYS = 486; // ~16 months
export const CHUNK_DAYS = 14;
const FRESHNESS_LAG = 3; // GSC data is final ~2-3 days behind

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  position: number;
}

async function fetchDay(accessToken: string, propertyUri: string, date: string): Promise<GscRow[]> {
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(propertyUri)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: date,
        endDate: date,
        dimensions: ["query", "page"],
        rowLimit: 25000,
        dataState: "final",
      }),
    },
  );
  if (!res.ok) throw new Error(`searchAnalytics.query ${date} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { rows?: GscRow[] };
  return data.rows ?? [];
}

export interface ImportProgress {
  done: boolean;
  importedDays: number;
  totalDays: number;
  rowsImported: number;
  oldestDate: string | null;
}

/** Imports the next CHUNK_DAYS going backwards from the oldest imported date. */
export async function importNextChunk(
  service: SupabaseClient,
  property: { id: string; organisation_id: string; property_uri: string; google_connection_id: string },
): Promise<ImportProgress> {
  const { data: conn } = await service
    .from("google_connections")
    .select("refresh_token_encrypted")
    .eq("id", property.google_connection_id)
    .single();
  if (!conn?.refresh_token_encrypted) throw new Error("Connection has no stored token");
  const accessToken = await refreshAccessToken(await decryptToken(conn.refresh_token_encrypted));

  const newest = day(FRESHNESS_LAG);
  const oldestTarget = day(FRESHNESS_LAG + BACKFILL_DAYS);

  const { data: oldestRow } = await service
    .from("gsc_performance_daily")
    .select("date")
    .eq("gsc_property_id", property.id)
    .order("date", { ascending: true })
    .limit(1)
    .maybeSingle();

  // Resume from the day before the oldest imported date.
  let cursor: string;
  if (!oldestRow) cursor = newest;
  else {
    const d = new Date(`${oldestRow.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }

  let rowsImported = 0;
  let processed = 0;
  while (processed < CHUNK_DAYS && cursor >= oldestTarget) {
    const rows = await fetchDay(accessToken, property.property_uri, cursor);
    if (rows.length > 0) {
      const payload = rows.map((r) => ({
        organisation_id: property.organisation_id,
        gsc_property_id: property.id,
        date: cursor,
        query: r.keys[0],
        page: r.keys[1],
        clicks: r.clicks,
        impressions: r.impressions,
        position: Math.round(r.position * 100) / 100,
      }));
      const { error } = await service
        .from("gsc_performance_daily")
        .upsert(payload, { onConflict: "gsc_property_id,date,query,page" });
      if (error) throw new Error(`upsert ${cursor} failed: ${error.message}`);
      rowsImported += payload.length;
    }
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
    processed++;
  }

  const done = cursor < oldestTarget;
  const importedDays = Math.min(
    BACKFILL_DAYS,
    Math.round((new Date(newest).getTime() - new Date(cursor).getTime()) / 86400000),
  );
  return { done, importedDays, totalDays: BACKFILL_DAYS, rowsImported, oldestDate: cursor };
}

/** Nightly top-up: re-imports the last few days (GSC finalises data late). */
export async function importRecentDays(
  service: SupabaseClient,
  property: { id: string; organisation_id: string; property_uri: string; google_connection_id: string },
  days = 5,
): Promise<number> {
  const { data: conn } = await service
    .from("google_connections")
    .select("refresh_token_encrypted")
    .eq("id", property.google_connection_id)
    .single();
  if (!conn?.refresh_token_encrypted) throw new Error("Connection has no stored token");
  const accessToken = await refreshAccessToken(await decryptToken(conn.refresh_token_encrypted));
  let rowsImported = 0;
  for (let offset = FRESHNESS_LAG; offset < FRESHNESS_LAG + days; offset++) {
    const date = day(offset);
    const rows = await fetchDay(accessToken, property.property_uri, date);
    if (rows.length === 0) continue;
    const payload = rows.map((r) => ({
      organisation_id: property.organisation_id,
      gsc_property_id: property.id,
      date,
      query: r.keys[0],
      page: r.keys[1],
      clicks: r.clicks,
      impressions: r.impressions,
      position: Math.round(r.position * 100) / 100,
    }));
    const { error } = await service
      .from("gsc_performance_daily")
      .upsert(payload, { onConflict: "gsc_property_id,date,query,page" });
    if (error) throw new Error(`upsert ${date} failed: ${error.message}`);
    rowsImported += payload.length;
  }
  return rowsImported;
}
