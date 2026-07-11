"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CoverageCell, CoverageState, Service, Site } from "@/lib/types";
import { COVERAGE_META, formatInt } from "@/lib/format";
import { Badge, Card, EmptyState } from "./ui";

// Cell fill + glyph per state. Color is never the only channel: every cell has
// a glyph, a tooltip, and the legend below; the detail panel spells it out.
const STATE_STYLE: Record<CoverageState, { bg: string; fg: string; glyph: string }> = {
  strong_dedicated_page: { bg: "var(--seq-600)", fg: "#fff", glyph: "●" },
  weak_dedicated_page: { bg: "var(--seq-300)", fg: "#0b0b0b", glyph: "◐" },
  poorly_targeted_page: { bg: "var(--seq-100)", fg: "#0b0b0b", glyph: "◔" },
  wrong_page_ranks: { bg: "var(--status-serious)", fg: "#0b0b0b", glyph: "✕" },
  missing_with_demand: { bg: "var(--status-warning)", fg: "#0b0b0b", glyph: "!" },
  network_evidence_only: { bg: "var(--grid)", fg: "var(--ink-2)", glyph: "·" },
  not_relevant: { bg: "transparent", fg: "var(--muted)", glyph: "" },
  recommended: { bg: "var(--series-2)", fg: "#0b0b0b", glyph: "R" },
  being_built: { bg: "var(--baseline)", fg: "#0b0b0b", glyph: "B" },
  experiment_in_progress: { bg: "var(--seq-400)", fg: "#fff", glyph: "E" },
};

export function CoverageMatrixClient({
  sites,
  services,
  coverage,
}: {
  sites: Site[];
  services: Service[];
  coverage: CoverageCell[];
}) {
  const [selected, setSelected] = useState<CoverageCell | null>(null);
  const [stateFilter, setStateFilter] = useState<CoverageState | "">("");

  const cellMap = useMemo(() => {
    const m = new Map<string, CoverageCell>();
    for (const c of coverage) m.set(`${c.siteId}|${c.serviceId}`, c);
    return m;
  }, [coverage]);

  const visibleSites = useMemo(
    () =>
      stateFilter
        ? sites.filter((s) =>
            services.some((svc) => cellMap.get(`${s.id}|${svc.id}`)?.state === stateFilter),
          )
        : sites,
    [sites, services, cellMap, stateFilter],
  );

  const selectedSite = selected ? sites.find((s) => s.id === selected.siteId) : null;
  const selectedService = selected ? services.find((s) => s.id === selected.serviceId) : null;

  if (sites.length === 0) {
    return (
      <EmptyState
        title="No sites in this scope"
        body="The selected campaign contains no sites. Choose another campaign or the full network."
      />
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2 text-ink-2">
          Highlight sites with
          <select
            className="rounded-md border border-edge bg-surface px-2 py-1.5 text-sm text-ink"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as CoverageState | "")}
          >
            <option value="">any state</option>
            {(Object.keys(COVERAGE_META) as CoverageState[]).map((s) => (
              <option key={s} value={s}>
                {COVERAGE_META[s].label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-muted tnum">
          {visibleSites.length} sites × {services.length} topics
        </span>
      </div>

      <div className="flex flex-col gap-4 xl:flex-row">
        <Card className="min-w-0 flex-1 overflow-auto">
          <div className="max-h-[70vh] overflow-auto">
            <table className="border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 border-b border-r border-edge bg-surface px-3 py-2 text-left font-medium text-ink">
                    Site
                  </th>
                  {services.map((svc) => (
                    <th
                      key={svc.id}
                      className="sticky top-0 z-10 h-28 border-b border-edge bg-surface px-1 align-bottom font-medium text-ink-2"
                    >
                      <div
                        className="mx-auto whitespace-nowrap"
                        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                      >
                        {svc.name}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleSites.map((site) => (
                  <tr key={site.id}>
                    <th className="sticky left-0 z-10 max-w-48 truncate border-b border-r border-edge bg-surface px-3 py-1 text-left font-normal">
                      <Link href={`/sites/${site.id}`} className="text-ink hover:text-series-1">
                        {site.name}
                      </Link>
                    </th>
                    {services.map((svc) => {
                      const cell = cellMap.get(`${site.id}|${svc.id}`)!;
                      const style = STATE_STYLE[cell.state];
                      const isSelected =
                        selected?.siteId === cell.siteId && selected?.serviceId === cell.serviceId;
                      return (
                        <td key={svc.id} className="border-b border-edge p-0.5">
                          <button
                            onClick={() => setSelected(cell)}
                            title={`${site.name} — ${svc.name}: ${COVERAGE_META[cell.state].label}`}
                            aria-label={`${site.name}, ${svc.name}: ${COVERAGE_META[cell.state].label}`}
                            className="flex h-6 w-8 items-center justify-center rounded-sm text-[10px] font-semibold"
                            style={{
                              background: style.bg,
                              color: style.fg,
                              outline: isSelected ? "2px solid var(--series-1)" : undefined,
                              outlineOffset: 1,
                            }}
                          >
                            {style.glyph}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="w-full shrink-0 space-y-4 xl:w-80">
          {selected && selectedSite && selectedService ? (
            <Card className="p-4 text-sm">
              <div className="font-semibold text-ink">{selectedSite.name}</div>
              <div className="text-xs text-ink-2">{selectedService.name}</div>
              <div className="mt-2">
                <Badge tone="blue">{COVERAGE_META[selected.state].label}</Badge>
              </div>
              <dl className="mt-3 space-y-1.5 text-ink-2">
                <div className="flex justify-between">
                  <dt>Impressions (28d)</dt>
                  <dd className="tnum text-ink">{formatInt(selected.impressions28d)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Clicks (28d)</dt>
                  <dd className="tnum text-ink">{formatInt(selected.clicks28d)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Median position</dt>
                  <dd className="tnum text-ink">{selected.medianPosition ?? "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Ranking page</dt>
                  <dd className="text-ink">{selected.rankingPage ?? "none"}</dd>
                </div>
              </dl>
              <Link
                href={`/sites/${selectedSite.id}`}
                className="mt-3 inline-block rounded-md border border-edge px-2.5 py-1 text-sm font-medium text-ink hover:bg-page"
              >
                Open site view
              </Link>
            </Card>
          ) : (
            <Card className="p-4 text-sm text-ink-2">
              Click any cell to see its evidence: impressions, position, the ranking page and the
              recommended action.
            </Card>
          )}

          <Card className="p-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Legend
            </div>
            <ul className="space-y-1.5 text-xs text-ink-2">
              {(Object.keys(COVERAGE_META) as CoverageState[]).map((s) => (
                <li key={s} className="flex items-center gap-2">
                  <span
                    className="flex h-4 w-6 items-center justify-center rounded-sm border border-edge text-[9px] font-semibold"
                    style={{ background: STATE_STYLE[s].bg, color: STATE_STYLE[s].fg }}
                  >
                    {STATE_STYLE[s].glyph}
                  </span>
                  {COVERAGE_META[s].label}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
