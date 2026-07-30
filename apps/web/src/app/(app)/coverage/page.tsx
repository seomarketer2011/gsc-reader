import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { CoverageMatrixClient } from "@/components/CoverageMatrixClient";
import { getCoverage, getScopedSiteIds, getServices, getSites } from "@/lib/data";
import { getRealScopeSiteIds, getRealSites } from "@/lib/data/real";
import { getServerClient } from "@/lib/supabase/server";
import {
  buildNetworkMatrix,
  CoverageState as NetworkState,
  NetworkMatrix,
} from "@/lib/engine/network";
import { formatInt, parseScope } from "@/lib/format";

// Same visual language as the fixture matrix: colour is never the only
// channel — every cell has a glyph, a tooltip and the legend below.
const REAL_STATE: Record<NetworkState, { bg: string; fg: string; glyph: string; label: string }> = {
  strong: { bg: "var(--seq-600)", fg: "#fff", glyph: "●", label: "Strong — top-10 position with solid impressions" },
  weak: { bg: "var(--seq-300)", fg: "#0b0b0b", glyph: "◐", label: "Weak — earning impressions but underperforming" },
  some: { bg: "var(--seq-100)", fg: "#0b0b0b", glyph: "·", label: "Some — only a handful of impressions" },
  none: { bg: "var(--grid)", fg: "var(--ink-2)", glyph: "", label: "None — no impressions for this topic" },
};

function RealMatrix({ matrix }: { matrix: NetworkMatrix }) {
  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      <Card className="min-w-0 flex-1 overflow-auto">
        <div className="max-h-[70vh] overflow-auto">
          <table className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 border-b border-r border-edge bg-surface px-3 py-2 text-left font-medium text-ink">
                  Site
                </th>
                {matrix.topics.map((topic) => (
                  <th
                    key={topic.key}
                    className="sticky top-0 z-10 h-28 border-b border-edge bg-surface px-1 align-bottom font-medium text-ink-2"
                  >
                    <div
                      className="mx-auto whitespace-nowrap"
                      style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                    >
                      {topic.name}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.sites.map((site) => (
                <tr key={site.siteId}>
                  <th className="sticky left-0 z-10 max-w-48 truncate border-b border-r border-edge bg-surface px-3 py-1 text-left font-normal">
                    <Link href={`/sites/${site.siteId}`} className="text-ink hover:text-series-1">
                      {site.domain}
                    </Link>
                  </th>
                  {matrix.topics.map((topic) => {
                    const cell = matrix.cells[site.siteId][topic.key];
                    const style = REAL_STATE[cell.state];
                    const detail =
                      cell.state === "none"
                        ? "no impressions"
                        : `${formatInt(cell.impressions)} impressions, ${formatInt(cell.clicks)} clicks, position ${cell.position?.toFixed(1) ?? "—"}`;
                    return (
                      <td key={topic.key} className="border-b border-edge p-0.5">
                        <div
                          title={`${site.domain} — ${topic.name}: ${style.label} (${detail})`}
                          className="flex h-6 w-8 items-center justify-center rounded-sm text-[10px] font-semibold"
                          style={{ background: style.bg, color: style.fg }}
                        >
                          {style.glyph}
                        </div>
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
        <Card className="p-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Legend</div>
          <ul className="space-y-1.5 text-xs text-ink-2">
            {(Object.keys(REAL_STATE) as NetworkState[]).map((s) => (
              <li key={s} className="flex items-center gap-2">
                <span
                  className="flex h-4 w-6 shrink-0 items-center justify-center rounded-sm border border-edge text-[9px] font-semibold"
                  style={{ background: REAL_STATE[s].bg, color: REAL_STATE[s].fg }}
                >
                  {REAL_STATE[s].glyph}
                </span>
                {REAL_STATE[s].label}
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-4 text-sm text-ink-2">
          Topics are the biggest query clusters across your network over the last 28 days of
          imported Search Console data. Hover any cell for its impressions, clicks and position.
        </Card>
      </div>
    </div>
  );
}

export default async function CoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const scopeRaw = typeof params.scope === "string" ? params.scope : undefined;

  const realSites = await getRealSites();
  if (realSites.length > 0) {
    const supabase = await getServerClient();
    const { data: userData } = await supabase!.auth.getUser();
    const { data: membership } = userData.user
      ? await supabase!
          .from("organisation_users")
          .select("organisation_id")
          .eq("user_id", userData.user.id)
          .limit(1)
          .maybeSingle()
      : { data: null };
    if (!membership) {
      return <EmptyState title="No organisation" body="Your user is not a member of an organisation yet." />;
    }

    // Scope the matrix to the selected group/site BEFORE building it, so the
    // topic universe reflects only that industry's queries.
    const scopedIds = await getRealScopeSiteIds(scopeRaw);
    const matrix = await buildNetworkMatrix(
      supabase!,
      membership.organisation_id,
      15,
      scopedIds ?? undefined,
    );

    return (
      <div>
        <PageHeader
          title="Coverage matrix"
          subtitle="Site × topic coverage from your real Search Console data — where each site is strong, weak or absent."
        />
        {matrix.topics.length === 0 || matrix.sites.length === 0 ? (
          <EmptyState
            title="No imported data to map yet"
            body="Import Search Console data for your tracked properties on the Google connections page — the matrix builds itself from the last 28 days of queries."
          />
        ) : (
          <RealMatrix matrix={matrix} />
        )}
      </div>
    );
  }

  const scope = parseScope(scopeRaw);
  const siteIds = await getScopedSiteIds(scope);
  const idSet = new Set(siteIds);
  const [sites, services, coverage] = await Promise.all([
    getSites(),
    getServices(),
    getCoverage(siteIds),
  ]);

  return (
    <div>
      <PageHeader
        title="Coverage matrix"
        subtitle="Site × service coverage across the network — every cell is a page that exists, is missing, or is underperforming."
      />
      <CoverageMatrixClient
        sites={sites.filter((s) => idSet.has(s.id))}
        services={services}
        coverage={coverage}
      />
    </div>
  );
}
