import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BACKFILL_DAYS, importNextChunk, importRecentDays } from "../google/import";

vi.mock("../google/oauth", () => ({
  decryptToken: vi.fn(async () => "refresh"),
  refreshAccessToken: vi.fn(async () => "access"),
}));

const property = { id: "property-1", organisation_id: "org-1", property_uri: "sc-domain:example.com", google_connection_id: "connection-1" };
const dateAt = (offset: number) => new Date(Date.UTC(2026, 9, 25 - offset)).toISOString().slice(0, 10);

function database(initialDates: string[] = []) {
  const checkpoints = new Set(initialDates);
  const writes: Array<Array<Record<string, unknown>>> = [];
  const state = { failWrite: false, failCheckpoint: false, failRead: false };
  const service = {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        lte: () => query,
        limit: async () => ({ data: [...checkpoints].map((date) => ({ date })), error: state.failRead ? { message: "read failed" } : null }),
        single: async () => ({ data: { refresh_token_encrypted: "encrypted" }, error: null }),
        upsert: async (payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
          if (table === "gsc_import_days") {
            if (state.failCheckpoint) return { error: { message: "checkpoint failed" } };
            checkpoints.add((payload as Record<string, unknown>).date as string);
          } else if (table === "gsc_performance_daily") {
            if (state.failWrite) return { error: { message: "write failed" } };
            writes.push(payload as Array<Record<string, unknown>>);
          } else throw new Error(`Unexpected table: ${table}`);
          return { error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { service, checkpoints, writes, state };
}

function requests() {
  return vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string) as { startDate: string; startRow: number; dataState: string });
}

describe("GSC imports", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ rows: [] })));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("starts at the newest final date for a migrated property with no checkpoints", async () => {
    const db = database();
    const progress = await importNextChunk(db.service, property);
    expect(requests().map((r) => r.startDate)).toEqual(Array.from({ length: 14 }, (_, i) => dateAt(i)));
    expect(requests().every((r) => r.dataState === "final")).toBe(true);
    expect(progress).toMatchObject({ done: false, importedDays: 14, rowsImported: 0, newestDate: "2026-10-25" });
  });

  it("resumes past empty days on the next request", async () => {
    const db = database();
    await importNextChunk(db.service, property);
    vi.mocked(fetch).mockClear();
    const progress = await importNextChunk(db.service, property, false);
    expect(requests()[0].startDate).toBe("2026-10-11");
    expect(progress.importedDays).toBe(28);
    expect(db.checkpoints.size).toBe(28);
  });

  it("refreshes five recent days on a new run, and fills an older gap", async () => {
    const dates = Array.from({ length: BACKFILL_DAYS }, (_, i) => dateAt(i));
    const db = database(dates.filter((date) => date !== dateAt(40)));
    const progress = await importNextChunk(db.service, property);
    expect(requests().map((r) => r.startDate)).toEqual([...dates.slice(0, 5), dateAt(40)]);
    expect(progress.done).toBe(true);
    expect(progress.importedDays).toBe(BACKFILL_DAYS);
    vi.mocked(fetch).mockClear();
    await importNextChunk(db.service, property, false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("finishes an entirely empty property in a bounded number of chunks", async () => {
    const db = database();
    let progress;
    let chunks = 0;
    do {
      progress = await importNextChunk(db.service, property, chunks === 0);
      chunks++;
      expect(chunks).toBeLessThanOrEqual(35);
    } while (!progress.done);
    expect(requests()).toHaveLength(BACKFILL_DAYS);
    expect(new Set(requests().map((r) => r.startDate)).size).toBe(BACKFILL_DAYS);
    expect(progress.oldestDate).toBe(dateAt(BACKFILL_DAYS - 1));
  });

  it("does not checkpoint a failed Google response or failed database write", async () => {
    const db = database();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("quota exceeded", { status: 429 }));
    await expect(importNextChunk(db.service, property)).rejects.toThrow("429");
    expect(db.checkpoints.size).toBe(0);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ rows: [{ keys: ["locksmith", "https://example.com/"], clicks: 1, impressions: 10, position: 3 }] }));
    db.state.failWrite = true;
    await expect(importNextChunk(db.service, property)).rejects.toThrow("write failed");
    expect(db.checkpoints.size).toBe(0);
  });

  it("surfaces checkpoint errors and retries the same date", async () => {
    const db = database();
    db.state.failCheckpoint = true;
    await expect(importNextChunk(db.service, property)).rejects.toThrow("checkpoint failed");
    expect(db.checkpoints.size).toBe(0);
    db.state.failCheckpoint = false;
    await importNextChunk(db.service, property, false);
    expect(requests()[0].startDate).toBe(requests()[1].startDate);
  });

  it("fails closed if checkpoint reads fail", async () => {
    const db = database();
    db.state.failRead = true;
    await expect(importNextChunk(db.service, property)).rejects.toThrow("read failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("paginates full Google responses and writes bounded database batches", async () => {
    const db = database();
    const row = { keys: ["locksmith", "https://example.com/"], clicks: 1, impressions: 10, position: 3.456 };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ rows: Array.from({ length: 25000 }, (_, i) => ({ ...row, keys: [`query ${i}`, row.keys[1]] })) }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ rows: [row] }));
    const count = await importRecentDays(db.service, property, 1);
    expect(requests().map((r) => r.startRow)).toEqual([0, 25000]);
    expect(count).toBe(25001);
    expect(db.writes).toHaveLength(26);
    expect(db.writes.every((batch) => batch.length <= 1000)).toBe(true);
    expect(db.writes[0][0]).toMatchObject({ date: "2026-10-25", position: 3.46, gsc_property_id: property.id });
    expect([...db.checkpoints]).toEqual(["2026-10-25"]);
  });

  it("does not complete a day if a subsequent Google page fails", async () => {
    const db = database();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ rows: Array.from({ length: 25000 }, (_, i) => ({ keys: [`q${i}`, "/"], clicks: 0, impressions: 1, position: 2 })) }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(importRecentDays(db.service, property, 1)).rejects.toThrow("503");
    expect(db.writes).toHaveLength(25);
    expect(db.checkpoints.size).toBe(0);
  });
});
