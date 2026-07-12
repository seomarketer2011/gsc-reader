"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Opportunity, OpportunityType, Site } from "@/lib/types";
import { OPPORTUNITY_TYPE_LABEL } from "@/lib/format";
import { newId, useDismissals, useSavedFilters } from "@/lib/collections";
import { EmptyState } from "./ui";
import { OpportunityCard } from "./OpportunityCard";

const TYPES = Object.keys(OPPORTUNITY_TYPE_LABEL) as OpportunityType[];

export function InboxClient({
  opportunities,
  sitesById,
}: {
  opportunities: Opportunity[];
  sitesById: Record<string, Pick<Site, "id" | "name" | "domain">>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const typeFilter = params.get("type") ?? "";
  const confidenceFilter = params.get("confidence") ?? "";
  const minImpressions = Number(params.get("minImpr") ?? "0");
  const query = params.get("q") ?? "";

  const dismissals = useDismissals();
  const saved = useSavedFilters();
  const [filterName, setFilterName] = useState("");
  const dismissedIds = useMemo(
    () => new Set(dismissals.items.map((d) => d.id)),
    [dismissals.items],
  );

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }

  const visible = useMemo(
    () =>
      opportunities.filter((o) => {
        if (dismissedIds.has(o.dismissKey ?? o.id)) return false;
        if (typeFilter && o.type !== typeFilter) return false;
        if (confidenceFilter && o.confidence !== confidenceFilter) return false;
        if (o.networkImpressions < minImpressions) return false;
        if (query && !o.title.toLowerCase().includes(query.toLowerCase())) return false;
        return true;
      }),
    [opportunities, dismissedIds, typeFilter, confidenceFilter, minImpressions, query],
  );

  function saveCurrentFilter() {
    const name = filterName.trim();
    if (!name) return;
    const kept = new URLSearchParams();
    for (const key of ["type", "confidence", "minImpr", "q", "scope"]) {
      const v = params.get(key);
      if (v) kept.set(key, v);
    }
    const existing = saved.items.find((f) => f.name === name);
    if (existing) saved.remove(existing.id);
    saved.add({ id: newId(), name, params: kept.toString() });
    setFilterName("");
  }

  const input =
    "rounded-md border border-edge bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className={`${input} w-44`}
          placeholder="Search opportunities…"
          value={query}
          onChange={(e) => setParam("q", e.target.value)}
          aria-label="Search opportunities"
        />
        <select
          className={input}
          value={typeFilter}
          onChange={(e) => setParam("type", e.target.value)}
          aria-label="Opportunity type"
        >
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {OPPORTUNITY_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select
          className={input}
          value={confidenceFilter}
          onChange={(e) => setParam("confidence", e.target.value)}
          aria-label="Minimum confidence"
        >
          <option value="">Any confidence</option>
          <option value="high">High confidence</option>
          <option value="medium">Medium confidence</option>
          <option value="low">Low confidence</option>
        </select>
        <select
          className={input}
          value={String(minImpressions)}
          onChange={(e) => setParam("minImpr", e.target.value === "0" ? "" : e.target.value)}
          aria-label="Minimum impressions"
        >
          <option value="0">Any impressions</option>
          <option value="1000">≥ 1,000 impressions</option>
          <option value="10000">≥ 10,000 impressions</option>
          <option value="50000">≥ 50,000 impressions</option>
        </select>
        <span className="text-sm text-muted tnum">
          {visible.length} of {opportunities.length}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          Saved filters
        </span>
        {saved.items.map((f) => (
          <span key={f.id} className="inline-flex items-center rounded-full border border-edge">
            <button
              onClick={() => router.push(`${pathname}?${f.params}`)}
              className="px-2.5 py-0.5 font-medium text-series-1 hover:underline"
            >
              {f.name}
            </button>
            <button
              onClick={() => saved.remove(f.id)}
              aria-label={`Delete saved filter ${f.name}`}
              className="pr-2 text-muted hover:text-critical"
            >
              ×
            </button>
          </span>
        ))}
        {saved.items.length === 0 && <span className="text-muted">none yet</span>}
        <input
          className={`${input} w-36`}
          placeholder="Filter name"
          value={filterName}
          onChange={(e) => setFilterName(e.target.value)}
          aria-label="New saved filter name"
        />
        <button
          onClick={saveCurrentFilter}
          disabled={!filterName.trim()}
          className="rounded-md border border-edge px-2.5 py-1 font-medium text-ink hover:bg-page disabled:opacity-40"
        >
          Save current
        </button>
      </div>

      {visible.length === 0 ? (
        opportunities.length === 0 ? (
          <EmptyState
            title="No opportunities in this scope"
            body="The selected campaign or site has no detected opportunities yet. Widen the scope to the full network, or wait for the next analysis run."
          />
        ) : (
          <EmptyState
            title="Nothing matches these filters"
            body={`All ${opportunities.length} opportunities are hidden by the current filters or have been dismissed. Clear the filters or restore dismissed items.`}
            action={{ href: pathname, label: "Clear filters" }}
          />
        )
      ) : (
        <div className="space-y-3">
          {visible.map((opp) => (
            <OpportunityCard
              key={opp.id}
              opportunity={opp}
              sitesById={sitesById}
              onDismiss={(id) => dismissals.add({ id })}
            />
          ))}
        </div>
      )}

      {dismissals.items.length > 0 && (
        <button
          onClick={() => dismissals.clear()}
          className="mt-4 text-sm font-medium text-muted hover:text-ink"
        >
          Restore {dismissals.items.length} dismissed{" "}
          {dismissals.items.length === 1 ? "opportunity" : "opportunities"}
        </button>
      )}
    </div>
  );
}
