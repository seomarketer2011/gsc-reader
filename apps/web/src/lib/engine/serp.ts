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

/**
 * First segments ("Bromley", "Croydon", …) of every UK location DataForSEO
 * accepts, lowercased — used to validate imported towns before any paid
 * check runs. Returns null when the (free) lookup fails, so callers can
 * skip validation gracefully.
 */
export async function fetchUkTownIndex(): Promise<Set<string> | null> {
  try {
    const auth = Buffer.from(
      `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
    ).toString("base64");
    const res = await fetch("https://api.dataforseo.com/v3/serp/google/locations/GB", {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = new Set<string>();
    for (const l of data.tasks?.[0]?.result ?? []) {
      if (l.location_name) out.add(String(l.location_name).split(",")[0].trim().toLowerCase());
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

interface SerpItem {
  type: string;
  rank_group: number;
  domain?: string;
  url?: string;
  title?: string;
}

/** Transient DataForSEO hiccups (40100-range "internal SE error", 50000+
 * internal errors, HTTP 5xx, network drops) are retried with backoff —
 * they usually succeed on the next attempt and failed tasks aren't charged.
 * Permanent errors (bad location name, auth) throw immediately. */
async function fetchSerp(keyword: string, locationName: string): Promise<SerpItem[]> {
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString("base64");
  let lastTransient: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    let res: Response;
    try {
      res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/regular", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify([
          { keyword, location_name: locationName, language_name: "English", depth: 100 },
        ]),
      });
    } catch (e) {
      lastTransient = e instanceof Error ? e : new Error("network error");
      continue;
    }
    if (!res.ok) {
      const error = new Error(`DataForSEO HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status >= 500) {
        lastTransient = error;
        continue;
      }
      throw error;
    }
    const data = await res.json();
    const task = data.tasks?.[0];
    if (task?.status_code !== 20000) {
      const code = Number(task?.status_code ?? 0);
      const error = new Error(`DataForSEO task ${code}: ${task?.status_message}`);
      if ((code >= 40100 && code < 40200) || code >= 50000) {
        lastTransient = error;
        continue;
      }
      throw error;
    }
    return (task.result?.[0]?.items ?? []) as SerpItem[];
  }
  throw lastTransient ?? new Error("SERP fetch failed");
}

async function recordCheckError(
  service: SupabaseClient,
  orgId: string,
  keywordId: string,
  error: string,
): Promise<void> {
  await service
    .from("serp_checks")
    .upsert(
      { organisation_id: orgId, keyword_id: keywordId, error: error.slice(0, 300), top_results: [] },
      { onConflict: "keyword_id,check_date" },
    );
}

/** Stores one keyword's SERP: a serp_checks row (top-10 context) plus one
 * serp_rankings row per watched domain in the organic top 100 (best position
 * wins if a domain appears more than once). */
async function storeSerpResult(
  service: SupabaseClient,
  orgId: string,
  keywordId: string,
  items: SerpItem[],
  watched: WatchedDomain[],
): Promise<number> {
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
      { organisation_id: orgId, keyword_id: keywordId, error: null, top_results: topResults },
      { onConflict: "keyword_id,check_date" },
    );
  // Replace today's rankings for this keyword so re-runs stay consistent.
  await service
    .from("serp_rankings")
    .delete()
    .eq("keyword_id", keywordId)
    .eq("check_date", new Date().toISOString().slice(0, 10));
  if (best.size > 0) {
    await service.from("serp_rankings").insert(
      [...best.entries()].map(([domain, r]) => ({
        organisation_id: orgId,
        keyword_id: keywordId,
        domain,
        site_id: r.siteId,
        position: r.position,
        url: r.url,
      })),
    );
  }
  return best.size;
}

/** Live-mode check (premium endpoint). Kept as a fallback; the button and
 * cron use the ~3x cheaper task queue below. */
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
    await recordCheckError(service, orgId, keyword.id, error);
    return { ranked: 0, error };
  }
  const ranked = await storeSerpResult(service, orgId, keyword.id, items, watched);
  return { ranked, error: null };
}

// ── Standard task queue (post now, collect minutes later — ~3x cheaper) ───

const TASK_POST_BATCH = 100; // endpoint max per request
const QUEUE_PAGE = 1000;

function dfsAuth(): string {
  return Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString("base64");
}

/** Posts SERP tasks for the given keywords and records them in
 * serp_task_queue. Returns how many were accepted. */
export async function postSerpTasks(
  service: SupabaseClient,
  orgId: string,
  keywords: TrackedKeyword[],
): Promise<number> {
  let posted = 0;
  for (let i = 0; i < keywords.length; i += TASK_POST_BATCH) {
    const batch = keywords.slice(i, i + TASK_POST_BATCH);
    const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/task_post", {
      method: "POST",
      headers: { Authorization: `Basic ${dfsAuth()}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        batch.map((k) => ({
          keyword: k.keyword,
          location_name: k.location_name,
          language_name: "English",
          depth: 100,
          priority: 1,
          tag: k.id,
        })),
      ),
    });
    if (!res.ok) throw new Error(`DataForSEO task_post HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const rows: { organisation_id: string; keyword_id: string; task_id: string }[] = [];
    for (const t of data.tasks ?? []) {
      const keywordId = t.data?.tag as string | undefined;
      if (!keywordId) continue;
      if (t.status_code === 20100 && t.id) {
        rows.push({ organisation_id: orgId, keyword_id: keywordId, task_id: t.id as string });
      } else {
        await recordCheckError(service, orgId, keywordId, `task_post ${t.status_code}: ${t.status_message}`);
      }
    }
    if (rows.length > 0) {
      const { error } = await service
        .from("serp_task_queue")
        .upsert(rows, { onConflict: "keyword_id,check_date" });
      // A failed queue write orphans the tasks at DataForSEO — collection
      // recovers them by tag, but log it loudly.
      if (error) console.error("serp post: queue upsert failed:", error.message);
      posted += rows.length;
    }
  }
  return posted;
}

interface QueueRow {
  id: string;
  keyword_id: string;
  task_id: string;
  posted_at: string;
}

/**
 * Collects finished tasks for one organisation: asks DataForSEO which tasks
 * are ready, fetches those results, stores them, and clears the queue rows.
 * Rows older than 20 minutes are polled directly (covers tasks whose "ready"
 * notification was consumed by an earlier crashed run); rows older than 24h
 * are expired.
 *
 * `keywordIds` enables ORPHAN RECOVERY: every task is posted with the
 * keyword id as its tag, so finished tasks whose queue row was lost (e.g. a
 * failed queue write) are still claimed and stored. Returns progress counts.
 */
export async function collectSerpResults(
  service: SupabaseClient,
  orgId: string,
  watched: WatchedDomain[],
  maxTasks = 40,
  keywordIds?: Set<string>,
): Promise<{ collected: number; failed: number; remaining: number }> {
  const queue: QueueRow[] = [];
  for (let from = 0; ; from += QUEUE_PAGE) {
    const { data } = await service
      .from("serp_task_queue")
      .select("id, keyword_id, task_id, posted_at")
      .eq("organisation_id", orgId)
      .order("posted_at")
      .range(from, from + QUEUE_PAGE - 1);
    queue.push(...((data ?? []) as QueueRow[]));
    if (!data || data.length < QUEUE_PAGE) break;
  }
  if (queue.length === 0 && !keywordIds?.size) return { collected: 0, failed: 0, remaining: 0 };
  const byTaskId = new Map(queue.map((q) => [q.task_id, q]));

  // Which of our tasks are ready? Includes orphans recognised by tag.
  const readyRes = await fetch("https://api.dataforseo.com/v3/serp/google/organic/tasks_ready", {
    headers: { Authorization: `Basic ${dfsAuth()}` },
  });
  const readyIds: string[] = [];
  const nowIso = new Date().toISOString();
  if (readyRes.ok) {
    const readyData = await readyRes.json();
    for (const r of readyData.tasks?.[0]?.result ?? []) {
      const id = r.id as string | undefined;
      if (!id) continue;
      if (byTaskId.has(id)) {
        readyIds.push(id);
      } else if (r.tag && keywordIds?.has(r.tag as string)) {
        // Orphan: finished task tagged with one of our keywords but no queue
        // row — synthesise one in memory so it's collected and stored.
        byTaskId.set(id, { id: "", keyword_id: r.tag as string, task_id: id, posted_at: nowIso });
        readyIds.push(id);
      }
    }
  }
  // Stale rows: poll directly in case their "ready" entry was already consumed.
  const now = Date.now();
  const readySet = new Set(readyIds);
  const stale = queue.filter(
    (q) => !readySet.has(q.task_id) && now - new Date(q.posted_at).getTime() > 20 * 60000,
  );
  const toFetch = [...readyIds, ...stale.map((s) => s.task_id)].slice(0, maxTasks);

  // Fetch results in parallel, then write everything in a handful of BATCHED
  // database calls — this is what lets one pass swallow hundreds of results
  // without hitting Worker subrequest limits.
  const successes: { row: QueueRow; items: SerpItem[] }[] = [];
  const failures: { row: QueueRow; message: string }[] = [];
  const PARALLEL = 10;
  for (let i = 0; i < toFetch.length; i += PARALLEL) {
    await Promise.all(
      toFetch.slice(i, i + PARALLEL).map(async (taskId) => {
        const row = byTaskId.get(taskId)!;
        const res = await fetch(
          `https://api.dataforseo.com/v3/serp/google/organic/task_get/regular/${taskId}`,
          { headers: { Authorization: `Basic ${dfsAuth()}` } },
        );
        if (!res.ok) return; // transient — try again next collect
        const data = await res.json();
        const task = data.tasks?.[0];
        const code = Number(task?.status_code ?? 0);
        if (code === 20000) {
          successes.push({ row, items: (task.result?.[0]?.items ?? []) as SerpItem[] });
        } else if (code === 20100 || code === 40601 || code === 40602 || code === 40603) {
          // Still queued/processing (or briefly unfindable) — expire after 24h.
          if (now - new Date(row.posted_at).getTime() > 24 * 3600000) {
            failures.push({ row, message: `task expired (${code}: ${task?.status_message})` });
          }
        } else {
          failures.push({ row, message: `DataForSEO task ${code}: ${task?.status_message}` });
        }
      }),
    );
  }

  // One result per keyword (a double-posted keyword yields two tasks with
  // the same tag; the extra queue rows are still cleaned up below).
  const seenKeyword = new Set<string>();
  const uniqueSuccesses = successes.filter(
    (s) => !seenKeyword.has(s.row.keyword_id) && (seenKeyword.add(s.row.keyword_id), true),
  );
  const uniqueFailures = failures.filter(
    (f) => !seenKeyword.has(f.row.keyword_id) && (seenKeyword.add(f.row.keyword_id), true),
  );

  const byDomain = new Map(watched.map((w) => [w.domain, w]));
  const today = new Date().toISOString().slice(0, 10);
  const checkRows: Record<string, unknown>[] = [];
  const rankingRows: Record<string, unknown>[] = [];
  for (const { row, items } of uniqueSuccesses) {
    const organic = items.filter((i) => i.type === "organic" && i.domain);
    checkRows.push({
      organisation_id: orgId,
      keyword_id: row.keyword_id,
      error: null,
      top_results: organic.slice(0, 10).map((i) => ({
        position: i.rank_group,
        domain: normaliseDomain(i.domain!),
        url: i.url ?? "",
        title: i.title ?? "",
      })),
    });
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
    for (const [domain, r] of best) {
      rankingRows.push({
        organisation_id: orgId,
        keyword_id: row.keyword_id,
        domain,
        site_id: r.siteId,
        position: r.position,
        url: r.url,
      });
    }
  }
  for (const { row, message } of uniqueFailures) {
    checkRows.push({
      organisation_id: orgId,
      keyword_id: row.keyword_id,
      error: message.slice(0, 300),
      top_results: [],
    });
  }

  // If a checks write fails, keep those queue rows so the results are
  // re-fetched next pass instead of being lost between the two writes.
  const CHUNK = 100; // keep .in() URLs and payloads comfortable
  const unwritten = new Set<string>();
  for (let i = 0; i < checkRows.length; i += CHUNK) {
    const slice = checkRows.slice(i, i + CHUNK);
    const { error } = await service
      .from("serp_checks")
      .upsert(slice, { onConflict: "keyword_id,check_date" });
    if (error) {
      console.error("serp collect: checks upsert failed:", error.message);
      for (const r of slice) unwritten.add(r.keyword_id as string);
    }
  }
  const successIds = uniqueSuccesses
    .map((s) => s.row.keyword_id)
    .filter((id) => !unwritten.has(id));
  for (let i = 0; i < successIds.length; i += CHUNK) {
    await service
      .from("serp_rankings")
      .delete()
      .in("keyword_id", successIds.slice(i, i + CHUNK))
      .eq("check_date", today);
  }
  const writableRankings = rankingRows.filter((r) => !unwritten.has(r.keyword_id as string));
  for (let i = 0; i < writableRankings.length; i += CHUNK) {
    const { error } = await service.from("serp_rankings").insert(writableRankings.slice(i, i + CHUNK));
    if (error) console.error("serp collect: rankings insert failed:", error.message);
  }
  // Clear ALL processed queue rows (including a double-post's extra row);
  // synthetic orphan rows have no database id to delete.
  const doneRowIds = [...successes, ...failures]
    .filter((s) => s.row.id && !unwritten.has(s.row.keyword_id))
    .map((s) => s.row.id);
  for (let i = 0; i < doneRowIds.length; i += CHUNK) {
    await service.from("serp_task_queue").delete().in("id", doneRowIds.slice(i, i + CHUNK));
  }

  const collected = successIds.length;
  const failedWritten = uniqueFailures.filter((f) => !unwritten.has(f.row.keyword_id)).length;
  const remaining = Math.max(0, queue.length - doneRowIds.length);
  console.log(
    `serp collect: queue=${queue.length} ready=${readyIds.length} stale=${stale.length} fetched=${toFetch.length} collected=${collected} failed=${failedWritten} remaining=${remaining}`,
  );
  return { collected, failed: failedWritten, remaining };
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
