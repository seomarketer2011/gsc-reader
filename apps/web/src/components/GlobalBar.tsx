"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Campaign, Network, Site } from "@/lib/types";

// The always-visible global selector bar:
// View: [Network ▼][Campaign ▼][Site ▼]  Date: [28d ▼]  Compare: [prev ▼]
export function GlobalBar({
  network,
  campaigns,
  sites,
}: {
  network: Network;
  campaigns: Campaign[];
  sites: Site[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const scope = params.get("scope") ?? "";
  const range = params.get("range") ?? "28";
  const compare = params.get("compare") ?? "prev";

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${pathname}?${next.toString()}`);
  }

  const select =
    "rounded-md border border-edge bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge bg-surface px-4 py-2.5">
      <label className="flex items-center gap-2 text-sm text-ink-2">
        View
        <select
          className={select}
          value={scope}
          onChange={(e) => update("scope", e.target.value)}
          aria-label="Analysis scope"
        >
          <option value="">{network.name}</option>
          <optgroup label="Groups">
            {campaigns.map((c) => (
              <option key={c.id} value={`campaign:${c.id}`}>
                {c.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Sites">
            {sites.map((s) => (
              <option key={s.id} value={`site:${s.id}`}>
                {s.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        Date
        <select
          className={select}
          value={range}
          onChange={(e) => update("range", e.target.value)}
          aria-label="Date range"
        >
          <option value="28">Last 28 days</option>
          <option value="90">Last 90 days</option>
          <option value="180">Last 180 days</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        Compare
        <select
          className={select}
          value={compare}
          onChange={(e) => update("compare", e.target.value)}
          aria-label="Comparison period"
        >
          <option value="prev">Previous period</option>
          <option value="none">No comparison</option>
        </select>
      </label>
      <span className="ml-auto hidden text-xs text-muted sm:block">
        Analysis screens show demo data until Phase 4
      </span>
    </div>
  );
}
