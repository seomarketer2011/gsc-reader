import { NextResponse } from "next/server";
import { getServerClient } from "@/lib/supabase/server";
import { normaliseDomain, TopResult } from "@/lib/engine/serp";

// CSV of the latest check per keyword: one row per ranked watched domain,
// plus a row for any home-town domain that is NOT ranking (that absence is
// the point of the tracker). Uses the caller's session, so RLS scopes it.
const PAGE = 1000;

function esc(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export async function GET() {
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
  const orgId = membership.organisation_id as string;

  async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>) {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data } = await build(from, from + PAGE - 1);
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) return out;
    }
  }

  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 30);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const [keywords, domains, checks] = await Promise.all([
    all<{ id: string; keyword: string; location_name: string }>((f, t) =>
      supabase!.from("tracked_keywords").select("id, keyword, location_name").eq("organisation_id", orgId).order("keyword").range(f, t),
    ),
    all<{ domain: string; location: string | null }>((f, t) =>
      supabase!.from("tracked_domains").select("domain, location").eq("organisation_id", orgId).order("domain").range(f, t),
    ),
    all<{ keyword_id: string; check_date: string; error: string | null; top_results: TopResult[] }>((f, t) =>
      supabase!
        .from("serp_checks")
        .select("keyword_id, check_date, error, top_results")
        .eq("organisation_id", orgId)
        .gte("check_date", cutoff)
        .order("check_date", { ascending: false })
        .range(f, t),
    ),
  ]);

  const latest = new Map<string, { date: string; error: string | null }>();
  for (const row of checks) {
    if (!latest.has(row.keyword_id)) latest.set(row.keyword_id, { date: row.check_date, error: row.error });
  }
  const latestDates = [...new Set([...latest.values()].map((v) => v.date))];
  const rankings = latestDates.length
    ? await all<{ keyword_id: string; domain: string; position: number; url: string | null; check_date: string }>((f, t) =>
        supabase!
          .from("serp_rankings")
          .select("keyword_id, domain, position, url, check_date")
          .eq("organisation_id", orgId)
          .in("check_date", latestDates)
          .order("id")
          .range(f, t),
      )
    : [];
  const rankedBy = new Map<string, { domain: string; position: number; url: string }[]>();
  for (const r of rankings) {
    if (r.check_date !== latest.get(r.keyword_id)?.date) continue;
    const list = rankedBy.get(r.keyword_id) ?? [];
    list.push({ domain: r.domain, position: r.position, url: r.url ?? "" });
    rankedBy.set(r.keyword_id, list);
  }

  const homeTown = new Map<string, string>();
  for (const d of domains) {
    if (d.location) homeTown.set(normaliseDomain(d.domain), d.location.trim().toLowerCase());
  }

  const lines = ["keyword,location,checked,status,domain,domain_home_town,is_home,position,url"];
  for (const k of keywords) {
    const check = latest.get(k.id);
    const town = k.location_name.split(",")[0].trim().toLowerCase();
    if (!check) {
      lines.push([esc(k.keyword), esc(k.location_name), "", "unchecked", "", "", "", "", ""].join(","));
      continue;
    }
    if (check.error) {
      lines.push([esc(k.keyword), esc(k.location_name), check.date, "failed", "", "", "", "", esc(check.error)].join(","));
      continue;
    }
    const ranked = (rankedBy.get(k.id) ?? []).sort((a, b) => a.position - b.position);
    const rankedSet = new Set(ranked.map((r) => r.domain));
    for (const r of ranked) {
      const home = homeTown.get(r.domain);
      lines.push(
        [
          esc(k.keyword), esc(k.location_name), check.date, "ranked",
          esc(r.domain), esc(home ? home : ""), home === town ? "yes" : "no",
          r.position, esc(r.url),
        ].join(","),
      );
    }
    // The town's own site(s) missing from the top 100.
    for (const [domain, home] of homeTown) {
      if (home === town && !rankedSet.has(domain)) {
        lines.push(
          [esc(k.keyword), esc(k.location_name), check.date, "not_ranking", esc(domain), esc(home), "yes", "", ""].join(","),
        );
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rankings-${today}.csv"`,
    },
  });
}
