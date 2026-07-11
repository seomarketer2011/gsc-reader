import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader, StatTile } from "@/components/ui";
import { getCluster, getOpportunities, getServices, getSites, NotFoundError } from "@/lib/data";
import { formatInt, formatPct } from "@/lib/format";

export default async function ClusterPage({
  params,
}: {
  params: Promise<{ clusterId: string }>;
}) {
  const { clusterId } = await params;
  let cluster;
  try {
    cluster = await getCluster(clusterId);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  const [services, sites, opportunities] = await Promise.all([
    getServices(),
    getSites(),
    getOpportunities(),
  ]);
  const service = services.find((s) => s.id === cluster.serviceId);
  const sitesById = new Map(sites.map((s) => [s.id, s]));
  const rollout = opportunities.find(
    (o) => o.clusterId === cluster.id && o.type === "missing_dedicated_page",
  );
  const e = cluster.evidence;

  return (
    <div>
      <PageHeader
        title={cluster.name}
        subtitle={`${service?.name} · ${cluster.normalisedForm} · ${e.monthsOfData} months of data`}
      >
        <div className="flex gap-2">
          <Badge tone={cluster.intent === "commercial" ? "good" : "neutral"}>{cluster.intent}</Badge>
          {rollout && (
            <Link
              href={`/rollouts/new?opportunity=${rollout.id}`}
              className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Create rollout
            </Link>
          )}
        </div>
      </PageHeader>

      {/* Network total, median site and coverage count — never a bare sum. */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Network impressions (28d)"
          value={formatInt(e.totalImpressions)}
          detail={`${formatInt(e.totalClicks)} clicks`}
        />
        <StatTile
          label="Site coverage"
          value={`${e.sitesWithImpressions} / 99`}
          detail="sites receiving impressions"
        />
        <StatTile
          label="Median position"
          value={`${e.medianPositionWithPage} vs ${e.medianPositionWithoutPage}`}
          detail="with dedicated page vs without"
        />
        <StatTile
          label="Median CTR"
          value={`${formatPct(e.medianCtrWithPage)} vs ${formatPct(e.medianCtrWithoutPage)}`}
          detail="with dedicated page vs without"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-x-auto">
          <div className="border-b border-edge px-4 py-2.5 text-sm font-medium text-ink">
            Query variations
          </div>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="px-4 py-2 font-medium">Query</th>
                <th className="px-4 py-2 text-right font-medium">Impressions</th>
                <th className="px-4 py-2 text-right font-medium">Clicks</th>
                <th className="px-4 py-2 text-right font-medium">Position</th>
              </tr>
            </thead>
            <tbody>
              {cluster.variations.map((v) => (
                <tr key={v.query} className="border-b border-edge last:border-0">
                  <td className="px-4 py-1.5 text-ink">{v.query}</td>
                  <td className="px-4 py-1.5 text-right text-ink-2 tnum">{formatInt(v.impressions28d)}</td>
                  <td className="px-4 py-1.5 text-right text-ink-2 tnum">{formatInt(v.clicks28d)}</td>
                  <td className="px-4 py-1.5 text-right text-ink-2 tnum">{v.position}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-edge px-4 py-2 text-xs text-muted">
            One local example per form — the cluster matches the same pattern in every site’s
            location.
          </p>
        </Card>

        <div className="space-y-4">
          <Card className="p-4 text-sm">
            <div className="mb-2 font-medium text-ink">Network evidence</div>
            <dl className="space-y-1.5 text-ink-2">
              {(
                [
                  ["Sites with a dedicated page", e.sitesWithDedicatedPage],
                  ["Sites relying on broad pages", e.sitesOnBroadPages],
                  ["Eligible sites without a page", e.eligibleSitesWithoutPage],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between">
                  <dt>{label}</dt>
                  <dd className="tnum font-medium text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted">
              Dedicated pages rank {(e.medianPositionWithoutPage - e.medianPositionWithPage).toFixed(1)}{" "}
              positions better at the median — pooled across the network, one site’s data alone
              would be too thin to support this conclusion.
            </p>
          </Card>

          {rollout ? (
            <Card className="p-4 text-sm">
              <div className="mb-2 font-medium text-ink">Recommended rollout</div>
              <p className="text-ink-2">{rollout.proposedChange}</p>
              <ul className="mt-3 space-y-1">
                {rollout.sitePlans
                  .filter((p) => p.action === "create")
                  .slice(0, 6)
                  .map((p) => (
                    <li key={p.siteId} className="flex items-center gap-2">
                      <Badge tone="good">create</Badge>
                      <Link href={`/sites/${p.siteId}`} className="text-ink hover:text-series-1">
                        {sitesById.get(p.siteId)?.name}
                      </Link>
                    </li>
                  ))}
              </ul>
              <Link
                href={`/rollouts/new?opportunity=${rollout.id}`}
                className="mt-3 inline-block rounded-md border border-edge px-2.5 py-1 font-medium text-ink hover:bg-page"
              >
                Open the rollout builder →
              </Link>
            </Card>
          ) : (
            <Card className="p-4 text-sm text-ink-2">
              No rollout is recommended for this cluster right now — the coverage gap is below the
              detection threshold.
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
