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
  const [meta, setMeta] = useState<{ newlyFetched?: number; fromCache?: number; discovered?: number; mode: "lookup" | "suggest" } | null>(null);
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

  const [busyAction, setBusyAction] = useState<"lookup" | "suggest" | null>(null);

  async function run(mode: "lookup" | "suggest") {
    setBusy(true);
    setBusyAction(mode);
    setError(null);
    try {
      const res = await fetch(mode === "lookup" ? "/api/keywords/lookup" : "/api/keywords/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "lookup" ? { keywords } : { seeds: keywords.slice(0, 20) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRows(data.rows);
      setMeta({ newlyFetched: data.newlyFetched, fromCache: data.fromCache, discovered: data.discovered, mode });
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
      setBusyAction(null);
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

  type SortKey = "keyword" | "volume" | "trend" | "cpc" | "competition" | "yours";
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "volume", dir: -1 });
  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === -1 ? 1 : -1 } : { key, dir: -1 }));
  }
  const sortedRows = useMemo(() => {
    if (!rows) return null;
    const value = (r: Row): number | string => {
      switch (sort.key) {
        case "keyword": return r.keyword;
        case "volume": return r.searchVolume ?? -1;
        case "trend": return trendPct(r.monthly) ?? -9999;
        case "cpc": return r.cpc ?? -1;
        case "competition": return r.competitionIndex ?? -1;
        case "yours": return r.yourPosition === null ? 9999 : r.yourPosition;
      }
    };
    return [...rows].sort((a, b) => {
      const va = value(a), vb = value(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * sort.dir;
    });
  }, [rows, sort]);

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
            onClick={() => run("lookup")}
            disabled={busy || keywords.length === 0}
            className="rounded-md bg-series-1 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busyAction === "lookup" ? "Fetching volumes…" : `Get volumes for ${keywords.length} keywords`}
          </button>
          <button
            onClick={() => run("suggest")}
            disabled={busy || keywords.length === 0}
            className="rounded-md border border-edge px-4 py-2 text-sm font-medium text-series-1 hover:bg-page disabled:opacity-50"
          >
            {busyAction === "suggest"
              ? "Finding ideas…"
              : `Find new keyword ideas from ${Math.min(keywords.length, 20)} seeds`}
          </button>
          <span className="text-xs text-muted">
            Volumes: max 700/run · Ideas: max 20 seeds, returns up to 300 suggestions · United
            Kingdom · everything cached for 30 days
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
              {meta?.mode === "lookup" && (
                <span className="text-muted">
                  {" "}
                  · {meta.newlyFetched} fetched, {meta.fromCache} from cache
                </span>
              )}
              {meta?.mode === "suggest" && (
                <span className="text-muted"> · {meta.discovered} ideas discovered, top shown</span>
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
                {(
                  [
                    ["keyword", "Keyword", "left"],
                    ["volume", "Volume/mo", "right"],
                    ["trend", "12-month trend", "left"],
                    ["cpc", "CPC", "right"],
                    ["competition", "Competition", "left"],
                    ["yours", "Your best site", "left"],
                  ] as const
                ).map(([key, label, align]) => (
                  <th key={key} className={`px-4 py-2 font-medium ${align === "right" ? "text-right" : ""}`}>
                    <button
                      onClick={() => toggleSort(key)}
                      className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink"
                      title={`Sort by ${label}`}
                    >
                      {label}
                      <span className="tnum">{sort.key === key ? (sort.dir === -1 ? "▼" : "▲") : ""}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(sortedRows ?? rows).map((r) => {
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
