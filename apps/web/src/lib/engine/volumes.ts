// DataForSEO search volumes with a Postgres cache — a keyword is fetched at
// most once every 30 days per organisation (server only; costs real money).

import { SupabaseClient } from "@supabase/supabase-js";

export interface KeywordVolume {
  keyword: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: string | null;
}

const LOCATION = "United Kingdom";
const REFRESH_DAYS = 30;
const BATCH = 700; // endpoint max is 1000; stay comfortably under

export function dataForSeoConfigured(): boolean {
  return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

async function fetchFromApi(keywords: string[]): Promise<Map<string, KeywordVolume>> {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString("base64");
  const out = new Map<string, KeywordVolume>();
  for (let i = 0; i < keywords.length; i += BATCH) {
    const res = await fetch("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        { keywords: keywords.slice(i, i + BATCH), location_name: LOCATION, language_name: "English" },
      ]),
    });
    if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const task = data.tasks?.[0];
    if (task?.status_code !== 20000) throw new Error(`DataForSEO task ${task?.status_code}: ${task?.status_message}`);
    for (const r of task.result ?? []) {
      out.set(String(r.keyword), {
        keyword: String(r.keyword),
        searchVolume: r.search_volume ?? null,
        cpc: r.cpc ?? null,
        competition: r.competition ?? null,
      });
    }
  }
  return out;
}

/** Cached volumes for a set of keywords; fetches and stores only stale/missing ones. */
export async function getVolumes(
  service: SupabaseClient,
  orgId: string,
  keywords: string[],
): Promise<Map<string, KeywordVolume>> {
  const unique = [...new Set(keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))];
  const out = new Map<string, KeywordVolume>();
  if (unique.length === 0) return out;

  const { data: cached } = await service
    .from("keyword_volumes")
    .select("keyword, search_volume, cpc, competition, fetched_at")
    .eq("organisation_id", orgId)
    .in("keyword", unique);
  const cutoff = Date.now() - REFRESH_DAYS * 86400000;
  for (const row of cached ?? []) {
    if (new Date(row.fetched_at as string).getTime() >= cutoff) {
      out.set(row.keyword as string, {
        keyword: row.keyword as string,
        searchVolume: (row.search_volume as number) ?? null,
        cpc: row.cpc === null ? null : Number(row.cpc),
        competition: (row.competition as string) ?? null,
      });
    }
  }

  const missing = unique.filter((k) => !out.has(k));
  if (missing.length > 0 && dataForSeoConfigured()) {
    const fetched = await fetchFromApi(missing);
    const rows = missing.map((k) => {
      const v = fetched.get(k) ?? { keyword: k, searchVolume: null, cpc: null, competition: null };
      out.set(k, v);
      return {
        organisation_id: orgId,
        keyword: k,
        location_name: LOCATION,
        search_volume: v.searchVolume,
        cpc: v.cpc,
        competition: v.competition,
        fetched_at: new Date().toISOString(),
      };
    });
    await service.from("keyword_volumes").upsert(rows, {
      onConflict: "organisation_id,keyword,location_name",
    });
  }
  return out;
}
