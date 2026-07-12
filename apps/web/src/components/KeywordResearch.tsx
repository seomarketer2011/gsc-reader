"use client";

import { useMemo, useState } from "react";
import { Card, EmptyState } from "./ui";
import { Sparkline } from "./charts";
import { formatInt } from "@/lib/format";

interface Row {
  keyword: string;
  cluster: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: string | null;
  competitionIndex: number | null;
  monthly: { year: number; month: number; search_volume: number }[] | null;
  yourSite: string | null;
  yourImpressions28d: number;
  yourPosition: number | null;
}

function trendPct(monthly: Row["monthly"]): number | null {
  if (!monthly || monthly.length < 6) return null;
  const sorted = [...monthly].sort((a, b) => a.year - b.year || a.month - b.month);
  const first3 = sorted.slice(0, 3).reduce((s, m) => s + m.search_volume, 0) / 3;
  const last3 = sorted.slice(-3).reduce((s, m) => s + m.search_volume, 0) / 3;
  if (!first3) return null;
  return Math.round(((last3 - first3) / first3) * 100);
}

export function KeywordResearch() {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [meta, setMeta] = useState<{ newlyFetched: number; fromCache: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keywords = useMemo(
    () =>
      [...new Set(
        input
          .split(/[\n,;]+/)
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 1),
      )],
    [input],
  );

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/keywords/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.rows);
      setMeta({ newlyFetched: data.newlyFetched, fromCache: data.fromCache });
    } catch (e) {
      setError(e instanceof Error ? e.message : "lookup failed");
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!rows) return;
    const header = "keyword,cluster,search_volume,cpc,competition,trend_pct,your_site,your_position,your_impressions_28d";
    const lines = rows.map((r) =>
      [
        JSON.stringify(r.keyword),
        JSON.stringify(r.cluster),
        r.searchVolume ?? "",
        r.cpc ?? "",
        r.competition ?? "",
        trendPct(r.monthly) ?? "",
        r.yourSite ?? "",
        r.yourPosition ?? "",
        r.yourImpressions28d || "",
      ].join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "keyword-volumes.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const clusters = useMemo(() => {
    if (!rows) return 0;
    return new Set(rows.map((r) => r.cluster)).size;
  }, [rows]);
  const totalVolume = rows?.reduce((s, r) => s + (r.searchVolume ?? 0), 0) ?? 0;

  return (
    <div>
      <Card className="mb-4 p-4">
        <label className="block text-sm font-medium text-ink">
          Paste keywords — one per line (or comma-separated)
          <textarea
            className="mt-2 h-40 w-full rounded-md border border-edge bg-surface p-3 font-mono text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1"
            placeholder={"locksmith bromley\nemergency locksmith bromley\nlock repair near me"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={run}
            disabled={busy || keywords.length === 0}
            className="rounded-md bg-series-1 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Fetching volumes…" : `Get volumes for ${keywords.length} keywords`}
          </button>
          <span className="text-xs text-muted">
            Max 700 per run · United Kingdom · results cached for 30 days, repeat lookups are free
          </span>
        </div>
        {error && <p className="mt-2 text-sm text-critical">⚠ {error}</p>}
      </Card>

      {rows && rows.length === 0 && (
        <EmptyState title="No results" body="None of the supplied keywords returned data." />
      )}

      {rows && rows.length > 0 && (
        <Card className="overflow-x-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-2.5 text-sm">
            <span className="text-ink-2">
              <span className="font-medium text-ink tnum">{rows.length}</span> keywords ·{" "}
              <span className="font-medium text-ink tnum">{clusters}</span> topics ·{" "}
              <span className="font-medium text-ink tnum">{formatInt(totalVolume)}</span> combined
              monthly searches
              {meta && (
                <span className="text-muted">
                  {" "}
                  · {meta.newlyFetched} fetched, {meta.fromCache} from cache
                </span>
              )}
            </span>
            <button
              onClick={exportCsv}
              className="rounded-md border border-edge px-2.5 py-1 font-medium text-ink hover:bg-page"
            >
              Export CSV
            </button>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="px-4 py-2 font-medium">Keyword</th>
                <th className="px-4 py-2 text-right font-medium">Volume/mo</th>
                <th className="px-4 py-2 font-medium">12-month trend</th>
                <th className="px-4 py-2 text-right font-medium">CPC</th>
                <th className="px-4 py-2 font-medium">Competition</th>
                <th className="px-4 py-2 font-medium">Your best site</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const trend = trendPct(r.monthly);
                const spark = r.monthly
                  ? [...r.monthly]
                      .sort((a, b) => a.year - b.year || a.month - b.month)
                      .map((m) => m.search_volume)
                  : [];
                return (
                  <tr key={r.keyword} className="border-b border-edge last:border-0">
                    <td className="px-4 py-2">
                      <div className="text-ink">{r.keyword}</div>
                      {r.cluster !== r.keyword && (
                        <div className="text-xs text-muted">topic: {r.cluster}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-medium text-ink tnum">
                      {r.searchVolume === null ? "—" : formatInt(r.searchVolume)}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        {spark.length > 1 && (
                          <Sparkline values={spark} width={90} height={24} label={`${r.keyword} 12-month search volume`} />
                        )}
                        {trend !== null && (
                          <span
                            className={`text-xs font-medium tnum ${trend >= 0 ? "text-delta-good" : "text-critical"}`}
                          >
                            {trend >= 0 ? "▲" : "▼"} {Math.abs(trend)}%
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-ink-2 tnum">
                      {r.cpc === null ? "—" : `$${r.cpc.toFixed(2)}`}
                    </td>
                    <td className="px-4 py-2 text-ink-2">
                      {r.competition ?? "—"}
                      {r.competitionIndex !== null && (
                        <span className="text-xs text-muted tnum"> ({r.competitionIndex})</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-ink-2">
                      {r.yourSite ? (
                        <span>
                          {r.yourSite}
                          {r.yourPosition !== null && (
                            <span className="text-xs text-muted tnum"> · pos {r.yourPosition}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted">not ranking</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
