// Organic rank checking via DataForSEO Google SERPs (server only; costs
// real money — roughly $2 per 1,000 keyword checks). One SERP fetch per
// keyword+location covers EVERY watched domain at once: the top-100 result
// list is matched against all of them, so cost scales with keywords, not
// with the number of sites.

import { SupabaseClient } from "@supabase/supabase-js";
import { dataForSeoConfigured } from "./volumes";

export { dataForSeoConfigured };

export interface TrackedKeyword {
  id: string;
  keyword: string;
  location_name: string;
}

export interface WatchedDomain {
  domain: string; // normalised: lowercase, no protocol/www/path
  siteId: string | null; // sites.id when GSC-connected
}

export interface TopResult {
  position: number;
  domain: string;
  url: string;
  title: string;
}

/** "https://www.Example.co.uk/page" -> "example.co.uk" */
export function normaliseDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];
}

interface SerpItem {
  type: string;
  rank_group: number;
  domain?: string;
  url?: string;
  title?: string;
}

async function fetchSerp(keyword: string, locationName: string): Promise<SerpItem[]> {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString("base64");
  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      { keyword, location_name: locationName, language_name: "English", depth: 100 },
    ]),
  });
  if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const task = data.tasks?.[0];
  if (task?.status_code !== 20000) {
    throw new Error(`DataForSEO task ${task?.status_code}: ${task?.status_message}`);
  }
  return (task.result?.[0]?.items ?? []) as SerpItem[];
}

/**
 * Checks one keyword's SERP and stores the day's results: a serp_checks row
 * (top-10 context, or the error) plus one serp_rankings row per watched
 * domain found in the organic top 100 (best position wins if a domain
 * appears more than once).
 */
export async function checkKeyword(
  service: SupabaseClient,
  orgId: string,
  keyword: TrackedKeyword,
  watched: WatchedDomain[],
): Promise<{ ranked: number; error: string | null }> {
  let items: SerpItem[];
  try {
    items = await fetchSerp(keyword.keyword, keyword.location_name);
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : "SERP fetch failed";
    await service
      .from("serp_checks")
      .upsert(
        { organisation_id: orgId, keyword_id: keyword.id, error, top_results: [] },
        { onConflict: "keyword_id,check_date" },
      );
    return { ranked: 0, error };
  }

  const organic = items.filter((i) => i.type === "organic" && i.domain);
  const topResults: TopResult[] = organic.slice(0, 10).map((i) => ({
    position: i.rank_group,
    domain: normaliseDomain(i.domain!),
    url: i.url ?? "",
    title: i.title ?? "",
  }));

  const byDomain = new Map(watched.map((w) => [w.domain, w]));
  const best = new Map<string, { position: number; url: string; siteId: string | null }>();
  for (const item of organic) {
    const domain = normaliseDomain(item.domain!);
    const watch = byDomain.get(domain);
    if (!watch) continue;
    const existing = best.get(domain);
    if (!existing || item.rank_group < existing.position) {
      best.set(domain, { position: item.rank_group, url: item.url ?? "", siteId: watch.siteId });
    }
  }

  await service
    .from("serp_checks")
    .upsert(
      { organisation_id: orgId, keyword_id: keyword.id, error: null, top_results: topResults },
      { onConflict: "keyword_id,check_date" },
    );
  // Replace today's rankings for this keyword so re-runs stay consistent.
  await service
    .from("serp_rankings")
    .delete()
    .eq("keyword_id", keyword.id)
    .eq("check_date", new Date().toISOString().slice(0, 10));
  if (best.size > 0) {
    await service.from("serp_rankings").insert(
      [...best.entries()].map(([domain, r]) => ({
        organisation_id: orgId,
        keyword_id: keyword.id,
        domain,
        site_id: r.siteId,
        position: r.position,
        url: r.url,
      })),
    );
  }
  return { ranked: best.size, error: null };
}

/** Union of GSC-connected sites and the plain watch-list, deduped by domain. */
export async function getWatchedDomains(
  service: SupabaseClient,
  orgId: string,
): Promise<WatchedDomain[]> {
  const [{ data: sites }, { data: watch }] = await Promise.all([
    service.from("sites").select("id, domain").eq("organisation_id", orgId),
    service.from("tracked_domains").select("domain").eq("organisation_id", orgId),
  ]);
  const out = new Map<string, WatchedDomain>();
  for (const s of sites ?? []) {
    out.set(normaliseDomain(s.domain as string), {
      domain: normaliseDomain(s.domain as string),
      siteId: s.id as string,
    });
  }
  for (const w of watch ?? []) {
    const domain = normaliseDomain(w.domain as string);
    if (!out.has(domain)) out.set(domain, { domain, siteId: null });
  }
  return [...out.values()];
}
