import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader, StatTile } from "@/components/ui";
import { TrendChart } from "@/components/charts";
import {
  getCoverage,
  getOpportunities,
  getServices,
  getSite,
  getSiteDailySeries,
  getSitePages,
  NotFoundError,
} from "@/lib/data";
import { COVERAGE_META, formatInt, formatPct, OPPORTUNITY_TYPE_LABEL } from "@/lib/format";

export default async function SitePage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { siteId } = await params;
  const sp = await searchParams;
  const rangeDays = Math.min(Number(sp.range ?? 28) || 28, 90);
  const compareOn = sp.compare !== "none";

  let site;
  try {
    site = await getSite(siteId);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  const [series, pages, services, coverage, allOpportunities] = await Promise.all([
    getSiteDailySeries(siteId),
    getSitePages(siteId),
    getServices(),
    getCoverage([siteId]),
    getOpportunities(),
  ]);

  const current = series.slice(-rangeDays);
  const previous = series.slice(-rangeDays * 2, -rangeDays);
  const sum = (points: typeof series, key: "clicks" | "impressions") =>
    points.reduce((s, p) => s + p[key], 0);
  const clicks = sum(current, "clicks");
  const prevClicks = sum(previous, "clicks");
  const impressions = sum(current, "impressions");
  const prevImpressions = sum(previous, "impressions");
  const pct = (now: number, before: number) => (before ? ((now - before) / before) * 100 : 0);

  const siteOpps = allOpportunities.filter(
    (o) =>
      o.siteId === siteId ||
      (o.siteId === null && o.sitePlans.some((p) => p.siteId === siteId && p.action !== "exclude")),
  );
  const servicesById = new Map(services.map((s) => [s.id, s]));
  const gaps = coverage.filter(
    (c) => c.state === "missing_with_demand" || c.state === "wrong_page_ranks",
  );

  return (
    <div>
      <PageHeader title={site.name} subtitle={`${site.domain} · ${site.location}, ${site.region} · launched ${site.launchedYear}`}>
        {!site.healthy && <Badge tone="critical">Health issues — indexability review needed</Badge>}
      </PageHeader>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={`Clicks (${rangeDays}d)`} value={formatInt(clicks)} delta={pct(clicks, prevClicks)} />
        <StatTile
          label={`Impressions (${rangeDays}d)`}
          value={formatInt(impressions)}
          delta={pct(impressions, prevImpressions)}
        />
        <StatTile label="CTR" value={impressions ? formatPct(clicks / impressions) : "—"} />
        <StatTile label="Open opportunities" value={String(siteOpps.length)} />
      </div>

      <Card className="mb-5 p-4">
        <div className="mb-2 text-sm font-medium text-ink">Daily clicks</div>
        <TrendChart series={current} compare={compareOn ? previous : null} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-x-auto">
          <div className="border-b border-edge px-4 py-2.5 text-sm font-medium text-ink">
            Top pages (28d)
          </div>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="px-4 py-2 font-medium">Page</th>
                <th className="px-4 py-2 text-right font-medium">Clicks</th>
                <th className="px-4 py-2 text-right font-medium">Impr.</th>
                <th className="px-4 py-2 text-right font-medium">Pos.</th>
                <th className="px-4 py-2 text-right font-medium">Δ clicks</th>
              </tr>
            </thead>
            <tbody>
              {pages.slice(0, 12).map((p) => (
                <tr key={p.url} className="border-b border-edge last:border-0">
                  <td className="max-w-56 truncate px-4 py-1.5 text-ink">{p.url}</td>
                  <td className="px-4 py-1.5 text-right text-ink tnum">{formatInt(p.clicks28d)}</td>
                  <td className="px-4 py-1.5 text-right text-ink-2 tnum">{formatInt(p.impressions28d)}</td>
                  <td className="px-4 py-1.5 text-right text-ink-2 tnum">{p.position.toFixed(1)}</td>
                  <td
                    className={`px-4 py-1.5 text-right font-medium tnum ${
                      p.clicksChangePct >= 0 ? "text-delta-good" : "text-critical"
                    }`}
                  >
                    {p.clicksChangePct >= 0 ? "▲" : "▼"} {Math.abs(p.clicksChangePct)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-4">
          <Card>
            <div className="border-b border-edge px-4 py-2.5 text-sm font-medium text-ink">
              Opportunities affecting this site
            </div>
            {siteOpps.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-2">
                No open opportunities for this site — it will reappear here after the next
                analysis run finds something actionable.
              </p>
            ) : (
              <ul className="divide-y divide-edge">
                {siteOpps.slice(0, 8).map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{o.title}</div>
                      <div className="text-xs text-muted">{OPPORTUNITY_TYPE_LABEL[o.type]}</div>
                    </div>
                    <span className="shrink-0 text-xs text-muted tnum">Score {o.score}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <div className="border-b border-edge px-4 py-2.5 text-sm font-medium text-ink">
              Coverage gaps on this site
            </div>
            {gaps.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-2">No missing or misrouted topics detected.</p>
            ) : (
              <ul className="divide-y divide-edge">
                {gaps.slice(0, 8).map((c) => (
                  <li key={c.serviceId} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="text-ink">{servicesById.get(c.serviceId)?.name}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={c.state === "missing_with_demand" ? "warning" : "critical"}>
                        {COVERAGE_META[c.state].short}
                      </Badge>
                      <span className="text-xs text-muted tnum">
                        {formatInt(c.impressions28d)} impr.
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-edge px-4 py-2">
              <Link href="/coverage" className="text-sm font-medium text-series-1 hover:underline">
                Open the full coverage matrix →
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
