"use client";

import { useMemo, useState } from "react";
import { GscProperty } from "@/lib/google/oauth";
import { Badge } from "./ui";
import { ImportButton } from "./ImportButton";

// Searchable property picker — accounts with hundreds of Search Console
// properties need filtering before anything else.
export function PropertyTable({
  properties,
  tracked,
  imported,
  orgId,
  connectionId,
  trackAction,
}: {
  properties: GscProperty[];
  tracked: Record<string, string>; // property_uri -> property id
  imported: Record<string, boolean>; // property id -> has data
  orgId: string;
  connectionId: string;
  trackAction: (formData: FormData) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [onlyTracked, setOnlyTracked] = useState(false);

  const sorted = useMemo(
    () => [...properties].sort((a, b) => a.siteUrl.localeCompare(b.siteUrl)),
    [properties],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((p) => {
      if (onlyTracked && !tracked[p.siteUrl]) return false;
      return !q || p.siteUrl.toLowerCase().includes(q);
    });
  }, [sorted, query, onlyTracked, tracked]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-2.5">
        <input
          className="w-72 rounded-md border border-edge bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1"
          placeholder="Search properties… e.g. locksmith bromley"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search properties"
        />
        <label className="flex items-center gap-1.5 text-sm text-ink-2">
          <input
            type="checkbox"
            className="accent-[var(--series-1)]"
            checked={onlyTracked}
            onChange={(e) => setOnlyTracked(e.target.checked)}
          />
          Tracked only
        </label>
        <span className="text-xs text-muted tnum">
          {visible.length} of {properties.length} properties
        </span>
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-edge">
              <th className="px-4 py-2 font-medium">Property</th>
              <th className="px-4 py-2 font-medium">Permission</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const propertyId = tracked[p.siteUrl];
              return (
                <tr key={p.siteUrl} className="border-b border-edge last:border-0">
                  <td className="px-4 py-2 text-ink">{p.siteUrl}</td>
                  <td className="px-4 py-2 text-ink-2">{p.permissionLevel}</td>
                  <td className="px-4 py-2 text-right">
                    {propertyId ? (
                      <span className="inline-flex items-center gap-2">
                        <Badge tone="good">tracked</Badge>
                        <ImportButton
                          propertyId={propertyId}
                          alreadyImported={imported[propertyId] ?? false}
                        />
                      </span>
                    ) : (
                      <form action={trackAction} className="inline">
                        <input type="hidden" name="orgId" value={orgId} />
                        <input type="hidden" name="connectionId" value={connectionId} />
                        <input type="hidden" name="siteUrl" value={p.siteUrl} />
                        <input type="hidden" name="permission" value={p.permissionLevel} />
                        <button className="rounded-md border border-edge px-2.5 py-1 font-medium text-series-1 hover:bg-page">
                          Track this property
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-ink-2">
                  No properties match “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
