import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getClusters, getServices } from "@/lib/data";
import { getRealClusters } from "@/lib/data/real";
import { formatPct } from "@/lib/format";
import { formatInt } from "@/lib/format";

export default async function ClustersPage() {
  const real = await getRealClusters();
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
                <th className="px-4 py-2.5 font-medium">Cluster</th>
                <th className="px-4 py-2.5 font-medium">Site</th>
                <th className="px-4 py-2.5 text-right font-medium">Variants</th>
                <th className="px-4 py-2.5 text-right font-medium">Impr. (28d)</th>
                <th className="px-4 py-2.5 text-right font-medium">Clicks</th>
                <th className="px-4 py-2.5 text-right font-medium">CTR</th>
                <th className="px-4 py-2.5 text-right font-medium">Avg pos.</th>
                <th className="px-4 py-2.5 text-right font-medium">Volume/mo</th>
                <th className="px-4 py-2.5 text-right font-medium">CPC</th>
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
