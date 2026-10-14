import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase/server";
import { decryptToken, refreshAccessToken, listProperties } from "@/lib/google/oauth";

export const maxDuration = 300;

// Read-only analysis endpoint: pulls live daily clicks/impressions/position
// per Search Console property, for offline cross-site reviews (update
// impact, trend reads). Guarded by the ANALYSIS_SECRET Worker secret, which
// is only set for the duration of an analysis session and deleted after —
// without it every request gets 403, so the route is inert in normal
// operation and spends nothing.

interface Row {
  keys: string[];
  clicks: number;
  impressions: number;
  position: number;
}

export async function GET(request: NextRequest) {
  const secret = process.env.ANALYSIS_SECRET;
  if (!secret || request.headers.get("x-analysis-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const s = getServiceClient();
  if (!s) return NextResponse.json({ error: "service key missing" }, { status: 500 });

  const { data: connections, error: connErr } = await s
    .from("google_connections")
    .select("id, refresh_token_encrypted, status")
    .eq("status", "active")
    .order("created_at");
  if (connErr) return NextResponse.json({ error: connErr.message }, { status: 500 });
  const conn = (connections ?? []).find((c) => c.refresh_token_encrypted);
  if (!conn) return NextResponse.json({ error: "no active Google connection" }, { status: 400 });

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(await decryptToken(conn.refresh_token_encrypted as string));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 300) : "token refresh failed" },
      { status: 502 },
    );
  }

  const offset = Math.max(0, Number(request.nextUrl.searchParams.get("offset") ?? 0));
  const limit = Math.min(80, Math.max(1, Number(request.nextUrl.searchParams.get("limit") ?? 60)));
  const startDate = request.nextUrl.searchParams.get("start") ?? "2026-09-01";
  const endDate = request.nextUrl.searchParams.get("end") ?? new Date().toISOString().slice(0, 10);
  // ?match= narrows to matching properties; ?dims= sets the dimension set,
  // comma-separated, with "~" combining two dimensions in one request
  // (query~page). Defaults preserve the original behaviour: all properties,
  // daily series.
  const match = new RegExp(request.nextUrl.searchParams.get("match") ?? ".", "i");
  const dimSets = (request.nextUrl.searchParams.get("dims") ?? "date").split(",").slice(0, 4);
  const rowLimit = Math.min(5000, Number(request.nextUrl.searchParams.get("rows") ?? 1000));

  const all = (await listProperties(accessToken))
    .filter((p) => p.permissionLevel !== "siteUnverifiedUser" && match.test(p.siteUrl))
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
  const page = all.slice(offset, offset + limit);

  const results: { siteUrl: string; byDim?: Record<string, Row[]>; rows?: Row[]; error?: string }[] = [];
  for (const p of page) {
    const byDim: Record<string, Row[]> = {};
    let error: string | undefined;
    for (const dimSet of dimSets) {
      try {
        const res = await fetch(
          `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(p.siteUrl)}/searchAnalytics/query`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              startDate,
              endDate,
              dimensions: dimSet.split(/[~+ ]/).slice(0, 2),
              rowLimit,
              dataState: "all",
            }),
          },
        );
        if (!res.ok) {
          error = `${dimSet} ${res.status}: ${(await res.text()).slice(0, 120)}`;
          continue;
        }
        byDim[dimSet] = ((await res.json()) as { rows?: Row[] }).rows ?? [];
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 120) : "fetch failed";
      }
    }
    results.push({
      siteUrl: p.siteUrl,
      byDim,
      rows: byDim["date"],
      ...(error ? { error } : {}),
    });
  }

  return NextResponse.json({ total: all.length, offset, limit, startDate, endDate, dims: dimSets, results });
}
