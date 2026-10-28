// Server-only, resumable GSC imports. Checkpoints represent successful API
// reads, including empty days; performance rows cannot serve as a cursor.
import { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, refreshAccessToken } from "./oauth";

export const BACKFILL_DAYS = 486;
export const CHUNK_DAYS = 14;
const FRESHNESS_LAG = 3;
const REFRESH_DAYS = 5;
const PAGE_SIZE = 25000;
const WRITE_BATCH_SIZE = 1000;

type Property = { id: string; organisation_id: string; property_uri: string; google_connection_id: string };

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

async function getAccessToken(service: SupabaseClient, property: Property) {
  const { data: conn, error } = await service.from("google_connections")
    .select("refresh_token_encrypted").eq("id", property.google_connection_id).single();
  if (error) throw new Error(`Connection lookup failed: ${error.message}`);
  if (!conn?.refresh_token_encrypted) throw new Error("Connection has no stored token");
  return refreshAccessToken(await decryptToken(conn.refresh_token_encrypted));
}

async function importDay(service: SupabaseClient, property: Property, accessToken: string, date: string) {
  let rowsImported = 0;
  // GSC returns at most 25,000 rows per response. Request subsequent pages
  // before marking the day complete. Google may still omit anonymised queries.
  for (let startRow = 0; ; startRow += PAGE_SIZE) {
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property.property_uri)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: date, endDate: date, dimensions: ["query", "page"],
          rowLimit: PAGE_SIZE, startRow, dataState: "final",
        }),
      },
    );
    if (!res.ok) throw new Error(`searchAnalytics.query ${date} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const { rows = [] } = (await res.json()) as { rows?: GscRow[] };
    for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
      const payload = rows.slice(offset, offset + WRITE_BATCH_SIZE).map((r) => ({
        organisation_id: property.organisation_id, gsc_property_id: property.id,
        date, query: r.keys[0], page: r.keys[1], clicks: r.clicks, impressions: r.impressions,
        position: Math.round(r.position * 100) / 100,
      }));
      const { error } = await service.from("gsc_performance_daily")
        .upsert(payload, { onConflict: "gsc_property_id,date,query,page" });
      if (error) throw new Error(`upsert ${date} failed: ${error.message}`);
      rowsImported += payload.length;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  // Persist only after every page and write succeeds. A failed date is retried;
  // already-written rows are safe to upsert again. Empty dates also advance.
  const { error } = await service.from("gsc_import_days").upsert({
    gsc_property_id: property.id, date, rows_imported: rowsImported,
    completed_at: new Date().toISOString(),
  }, { onConflict: "gsc_property_id,date" });
  if (error) throw new Error(`checkpoint ${date} failed: ${error.message}`);
  return rowsImported;
}

export interface ImportProgress {
  done: boolean;
  importedDays: number;
  totalDays: number;
  rowsImported: number;
  oldestDate: string | null;
  newestDate: string;
}

/** Fill unchecked dates newest first; refresh the most recent final days only
 * on the first request of a user-started run, not on every chunk. */
export async function importNextChunk(
  service: SupabaseClient,
  property: Property,
  refreshRecent = true,
): Promise<ImportProgress> {
  const dates = Array.from({ length: BACKFILL_DAYS }, (_, i) => day(FRESHNESS_LAG + i));
  const { data, error } = await service.from("gsc_import_days").select("date")
    .eq("gsc_property_id", property.id).gte("date", dates[dates.length - 1])
    .lte("date", dates[0]).limit(BACKFILL_DAYS);
  if (error) throw new Error(`Import progress lookup failed: ${error.message}`);
  const completed = new Set<string>((data ?? []).map((row) => row.date));
  const pending = dates.filter((date, index) => !completed.has(date) || (refreshRecent && index < REFRESH_DAYS));
  const chunk = pending.slice(0, CHUNK_DAYS);
  let rowsImported = 0;
  if (chunk.length) {
    const accessToken = await getAccessToken(service, property);
    for (const date of chunk) {
      rowsImported += await importDay(service, property, accessToken, date);
      completed.add(date);
    }
  }
  const checked = dates.filter((date) => completed.has(date));
  return {
    done: pending.length <= CHUNK_DAYS,
    importedDays: checked.length, totalDays: BACKFILL_DAYS, rowsImported,
    oldestDate: checked.at(-1) ?? null, newestDate: dates[0],
  };
}

/** Explicit top-up used by the existing manual cron endpoint. */
export async function importRecentDays(service: SupabaseClient, property: Property, days = REFRESH_DAYS): Promise<number> {
  const accessToken = await getAccessToken(service, property);
  let rowsImported = 0;
  for (let offset = FRESHNESS_LAG; offset < FRESHNESS_LAG + days; offset++) {
    rowsImported += await importDay(service, property, accessToken, day(offset));
  }
  return rowsImported;
}
