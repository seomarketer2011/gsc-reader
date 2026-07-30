import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getClusters, getServices } from "@/lib/data";
import { getRealClusters, getRealScopeSiteIds } from "@/lib/data/real";
import { formatPct } from "@/lib/format";
import { formatInt } from "@/lib/format";

export default async function ClustersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const scopeRaw = typeof params.scope === "string" ? params.scope : "";
  let real = await getRealClusters();
  const realMode = real.length > 0;
  // Honour the global site/group selector.
  const scopedIds = await getRealScopeSiteIds(scopeRaw || undefined);
  if (scopedIds) {
    const idSet = new Set(scopedIds);
    real = real.filter((c) => idSet.has(c.siteId));
  }
  const sortKey = typeof params.sort === "string" ? params.sort : "volume";
  const sortDir = params.dir === "asc" ? 1 : -1;
  const clusterValue = (c: (typeof real)[number]): number | string => {
    switch (sortKey) {
      case "cluster": return c.name;
      case "variants": return c.members.length;
      case "impressions": return c.impressions;
      case "clicks": return c.clicks;
      case "ctr": return c.impressions ? c.clicks / c.impressions : 0;
      case "position": return c.position;
      case "cpc": return c.cpc ?? -1;
      default: return c.searchVolume ?? -1;
    }
  };
  real = [...real].sort((a, b) => {
    const va = clusterValue(a), vb = clusterValue(b);
    const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
    return cmp * sortDir;
  });
  const sortHref = (key: string) =>
    `/clusters?${new URLSearchParams({
      ...(scopeRaw ? { scope: scopeRaw } : {}),
      sort: key,
      dir: sortKey === key && sortDir === -1 ? "asc" : "desc",
    }).toString()}`;
  const arrow = (key: string) => (sortKey === key ? (sortDir === -1 ? " ▼" : " ▲") : "");
  if (realMode && real.length === 0) {
    return (
      <div>
        <PageHeader
          title="Query clusters"
          subtitle="Wording variants merged into topics — real Search Console data with cached DataForSEO volumes."
        />
        <Card className="p-4 text-sm text-ink-2">
          No clusters in this scope yet — the selected group has no sites with imported data.
        </Card>
      </div>
    );
  }
  if (real.length > 0) {
    return (
      <div>
        <PageHeader
          title="Query clusters"
          subtitle="Wording variants merged into topics — real Search Console data with cached DataForSEO volumes."
        />
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="px-4 py-2.5 font-medium"><Link href={sortHref("cluster")} className="hover:text-ink">Cluster{arrow("cluster")}</Link></th>
                <th className="px-4 py-2.5 font-medium">Site</th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("variants")} className="hover:text-ink">Variants{arrow("variants")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("impressions")} className="hover:text-ink">Impr. (28d){arrow("impressions")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("clicks")} className="hover:text-ink">Clicks{arrow("clicks")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("ctr")} className="hover:text-ink">CTR{arrow("ctr")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("position")} className="hover:text-ink">Avg pos.{arrow("position")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("volume")} className="hover:text-ink">Volume/mo{arrow("volume")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("cpc")} className="hover:text-ink">CPC{arrow("cpc")}</Link></th>
              </tr>
            </thead>
            <tbody>
              {real.slice(0, 100).map((c) => (
                <tr key={c.siteId + c.key} className="border-b border-edge last:border-0 hover:bg-page">
                  <td className="px-4 py-2">
                    <div className="font-medium text-ink">{c.name}</div>
                    {c.members.length > 1 && (
                      <div className="max-w-96 truncate text-xs text-muted">
                        + {c.members.slice(1, 4).map((m) => m.query).join(" · ")}
                        {c.members.length > 4 && " …"}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-ink-2">{c.siteName}</td>
                  <td className="px-4 py-2 text-right text-ink-2 tnum">{c.members.length}</td>
                  <td className="px-4 py-2 text-right text-ink tnum">{formatInt(c.impressions)}</td>
                  <td className="px-4 py-2 text-right text-ink-2 tnum">{formatInt(c.clicks)}</td>
                  <td className="px-4 py-2 text-right text-ink-2 tnum">
                    {c.impressions ? formatPct(c.clicks / c.impressions) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-ink-2 tnum">{c.position.toFixed(1)}</td>
                  <td className="px-4 py-2 text-right font-medium text-ink tnum">
                    {c.searchVolume === null ? "—" : formatInt(c.searchVolume)}
                  </td>
                  <td className="px-4 py-2 text-right text-ink-2 tnum">
                    {c.cpc === null ? "—" : "$" + c.cpc.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-3 text-xs text-muted">
          Volume and CPC come from the DataForSEO cache filled during analysis runs — “—” means the
          keyword hasn’t been priced yet.
        </p>
      </div>
    );
  }

  const [clusters, services] = await Promise.all([getClusters(), getServices()]);
  const servicesById = new Map(services.map((s) => [s.id, s]));
  const sorted = [...clusters].sort(
    (a, b) => b.evidence.totalImpressions - a.evidence.totalImpressions,
  );

  return (
    <div>
      <PageHeader
        title="Query clusters"
        subtitle="Normalised cross-site demand — the same opportunity recognised across different local sites."
      />
      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-edge">
              <th className="px-4 py-2.5 font-medium">Cluster</th>
              <th className="px-4 py-2.5 font-medium">Intent</th>
              <th className="px-4 py-2.5 text-right font-medium">Network impr. (28d)</th>
              <th className="px-4 py-2.5 text-right font-medium">Sites w/ impressions</th>
              <th className="px-4 py-2.5 text-right font-medium">Dedicated pages</th>
              <th className="px-4 py-2.5 text-right font-medium">Eligible w/o page</th>
              <th className="px-4 py-2.5 text-right font-medium">Median pos. with / without</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((cluster) => (
              <tr key={cluster.id} className="border-b border-edge last:border-0 hover:bg-page">
                <td className="px-4 py-2">
                  <Link
                    href={`/clusters/${cluster.id}`}
                    className="font-medium text-ink hover:text-series-1"
                  >
                    {cluster.name}
                  </Link>
                  <div className="text-xs text-muted">
                    {servicesById.get(cluster.serviceId)?.name} · {cluster.normalisedForm}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <Badge tone={cluster.intent === "commercial" ? "good" : "neutral"}>
                    {cluster.intent}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-right text-ink tnum">
                  {formatInt(cluster.evidence.totalImpressions)}
                </td>
                <td className="px-4 py-2 text-right text-ink-2 tnum">
                  {cluster.evidence.sitesWithImpressions} / 99
                </td>
                <td className="px-4 py-2 text-right text-ink-2 tnum">
                  {cluster.evidence.sitesWithDedicatedPage}
                </td>
                <td className="px-4 py-2 text-right text-ink-2 tnum">
                  {cluster.evidence.eligibleSitesWithoutPage}
                </td>
                <td className="px-4 py-2 text-right text-ink-2 tnum">
                  {cluster.evidence.medianPositionWithPage} / {cluster.evidence.medianPositionWithoutPage}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
