import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { Sparkline } from "@/components/charts";
import { getScopedSiteIds, getSiteDailySeries, getSites } from "@/lib/data";
import { getRealDailySeries, getRealSites } from "@/lib/data/real";
import { formatInt, parseScope } from "@/lib/format";

export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  // Real Search Console data takes over as soon as a property is tracked.
  let realSites = await getRealSites();
  const scopeRaw = typeof params.scope === "string" ? params.scope : "";
  if (scopeRaw.startsWith("site:")) {
    realSites = realSites.filter((s) => s.id === scopeRaw.slice(5));
  }
  const rangeDays = Math.min(Number(params.range ?? 28) || 28, 180);
  if (realSites.length > 0) {
    const rows = await Promise.all(
      realSites.map(async (site) => {
        const series = await getRealDailySeries(site.propertyId, rangeDays * 2);
        const last28 = series.slice(-rangeDays);
        const prev28 = series.slice(0, rangeDays);
        const clicks = last28.reduce((sum, p) => sum + p.clicks, 0);
        const prevClicks = prev28.reduce((sum, p) => sum + p.clicks, 0);
        return {
          site,
          clicks,
          impressions: last28.reduce((sum, p) => sum + p.impressions, 0),
          changePct: prevClicks ? ((clicks - prevClicks) / prevClicks) * 100 : 0,
          spark: last28.map((p) => p.clicks),
        };
      }),
    );
    const sortKey = typeof params.sort === "string" ? params.sort : "clicks";
    const sortDir = params.dir === "asc" ? 1 : -1;
    const rowValue = (r: (typeof rows)[number]): number | string => {
      switch (sortKey) {
        case "name": return r.site.name;
        case "impressions": return r.impressions;
        case "change": return r.changePct;
        default: return r.clicks;
      }
    };
    rows.sort((a, b) => {
      const va = rowValue(a), vb = rowValue(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * sortDir;
    });
    const sortHref = (key: string) =>
      `/sites?${new URLSearchParams({
        ...(scopeRaw ? { scope: scopeRaw } : {}),
        ...(typeof params.range === "string" ? { range: params.range } : {}),
        sort: key,
        dir: sortKey === key && sortDir === -1 ? "asc" : "desc",
      }).toString()}`;
    const arrow = (key: string) => (sortKey === key ? (sortDir === -1 ? " ▼" : " ▲") : "");
    return (
      <div>
        <PageHeader
          title="Sites"
          subtitle={`${rows.length} tracked ${rows.length === 1 ? "property" : "properties"} · real Search Console data · last ${rangeDays} days`}
        />
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="px-4 py-2.5 font-medium"><Link href={sortHref("name")} className="hover:text-ink">Site{arrow("name")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("clicks")} className="hover:text-ink">Clicks{arrow("clicks")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("impressions")} className="hover:text-ink">Impressions{arrow("impressions")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("change")} className="hover:text-ink">Δ vs prev{arrow("change")}</Link></th>
                <th className="px-4 py-2.5 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ site, clicks, impressions, changePct, spark }) => (
                <tr key={site.id} className="border-b border-edge last:border-0 hover:bg-page">
                  <td className="px-4 py-2">
                    <Link href={`/sites/${site.id}`} className="font-medium text-ink hover:text-series-1">
                      {site.name}
                    </Link>
                    <div className="text-xs text-muted">{site.propertyUri}</div>
                  </td>
                  <td className="px-4 py-2 text-right text-ink tnum">{formatInt(clicks)}</td>
                  <td className="px-4 py-2 text-right text-ink-2 tnum">{formatInt(impressions)}</td>
                  <td className={`px-4 py-2 text-right font-medium tnum ${changePct >= 0 ? "text-delta-good" : "text-critical"}`}>
                    {changePct >= 0 ? "▲" : "▼"} {Math.abs(changePct).toFixed(1)}%
                  </td>
                  <td className="px-4 py-2">
                    <Sparkline values={spark} label={`${site.name} daily clicks, last 28 days`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <p className="mt-3 text-xs text-muted">
          Data imports nightly once scheduling lands (Phase 6); use “Resume / update import” on the
          Connections page to refresh manually until then.
        </p>
      </div>
    );
  }

  const scope = parseScope(typeof params.scope === "string" ? params.scope : undefined);
  const sort = typeof params.sort === "string" ? params.sort : "clicks";
  const [siteIds, allSites] = await Promise.all([getScopedSiteIds(scope), getSites()]);
  const idSet = new Set(siteIds);
  const sites = allSites.filter((s) => idSet.has(s.id));

  const rows = await Promise.all(
    sites.map(async (site) => {
      const series = await getSiteDailySeries(site.id);
      const last28 = series.slice(-28);
      const prev28 = series.slice(-56, -28);
      const clicks = last28.reduce((s, p) => s + p.clicks, 0);
      const prevClicks = prev28.reduce((s, p) => s + p.clicks, 0);
      return {
        site,
        clicks,
        impressions: last28.reduce((s, p) => s + p.impressions, 0),
        changePct: prevClicks ? ((clicks - prevClicks) / prevClicks) * 100 : 0,
        spark: last28.map((p) => p.clicks),
      };
    }),
  );

  rows.sort((a, b) =>
    sort === "change"
      ? b.changePct - a.changePct
      : sort === "name"
        ? a.site.name.localeCompare(b.site.name)
        : b.clicks - a.clicks,
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No sites in this scope"
        body="The selected campaign contains no sites. Choose another campaign or the full network."
      />
    );
  }

  const sortLink = (key: string, label: string) => (
    <Link
      href={`/sites?${new URLSearchParams({ ...(typeof params.scope === "string" ? { scope: params.scope } : {}), sort: key }).toString()}`}
      className={sort === key ? "text-series-1" : "text-ink-2 hover:text-ink"}
    >
      {label}
    </Link>
  );

  return (
    <div>
      <PageHeader title="Sites" subtitle={`${rows.length} sites in scope · last 28 days`} />
      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-edge">
              <th className="px-4 py-2.5 font-medium">{sortLink("name", "Site")}</th>
              <th className="px-4 py-2.5 font-medium">Location</th>
              <th className="px-4 py-2.5 text-right font-medium">{sortLink("clicks", "Clicks")}</th>
              <th className="px-4 py-2.5 text-right font-medium">Impressions</th>
              <th className="px-4 py-2.5 text-right font-medium">{sortLink("change", "Δ vs prev")}</th>
              <th className="px-4 py-2.5 font-medium">Trend (28d)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ site, clicks, impressions, changePct, spark }) => (
              <tr key={site.id} className="border-b border-edge last:border-0 hover:bg-page">
                <td className="px-4 py-2">
                  <Link href={`/sites/${site.id}`} className="font-medium text-ink hover:text-series-1">
                    {site.name}
                  </Link>
                  <div className="text-xs text-muted">{site.domain}</div>
                </td>
                <td className="px-4 py-2 text-ink-2">
                  {site.location} · {site.region}
                </td>
                <td className="px-4 py-2 text-right text-ink tnum">{formatInt(clicks)}</td>
                <td className="px-4 py-2 text-right text-ink-2 tnum">{formatInt(impressions)}</td>
                <td
                  className={`px-4 py-2 text-right font-medium tnum ${
                    changePct >= 0 ? "text-delta-good" : "text-critical"
                  }`}
                >
                  {changePct >= 0 ? "▲" : "▼"} {Math.abs(changePct).toFixed(1)}%
                </td>
                <td className="px-4 py-2">
                  <Sparkline values={spark} label={`${site.name} daily clicks, last 28 days`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
