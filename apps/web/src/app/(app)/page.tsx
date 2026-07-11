import { PageHeader, StatTile } from "@/components/ui";
import { InboxClient } from "@/components/InboxClient";
import { getOpportunities, getSites } from "@/lib/data";
import { formatCompact, parseScope } from "@/lib/format";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const scope = parseScope(typeof params.scope === "string" ? params.scope : undefined);
  const [opportunities, sites] = await Promise.all([getOpportunities(scope), getSites()]);

  const sitesById = Object.fromEntries(
    sites.map((s) => [s.id, { id: s.id, name: s.name, domain: s.domain }]),
  );
  const networkOpps = opportunities.filter((o) => o.type === "missing_dedicated_page");
  const totalUpside = opportunities.reduce((s, o) => s + o.estimatedClicksHigh, 0);

  return (
    <div>
      <PageHeader
        title="Opportunity Inbox"
        subtitle="Detected by deterministic rules, scored by network evidence — every card is fully explainable."
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open opportunities" value={String(opportunities.length)} />
        <StatTile
          label="Network rollouts"
          value={String(networkOpps.length)}
          detail="multi-site page opportunities"
        />
        <StatTile
          label="Estimated upside"
          value={`${formatCompact(totalUpside)} clicks`}
          detail="upper bound across all cards"
        />
        <StatTile
          label="High confidence"
          value={String(opportunities.filter((o) => o.confidence === "high").length)}
          detail="backed by ≥10 sites of evidence"
        />
      </div>
      <InboxClient opportunities={opportunities} sitesById={sitesById} />
    </div>
  );
}
