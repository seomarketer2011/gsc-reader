"use client";

import { useState } from "react";
import Link from "next/link";
import { Opportunity, Site } from "@/lib/types";
import { formatInt, OPPORTUNITY_TYPE_LABEL } from "@/lib/format";
import { Badge, Card, LevelBadge } from "./ui";

export function OpportunityCard({
  opportunity: opp,
  sitesById,
  onDismiss,
}: {
  opportunity: Opportunity;
  sitesById: Record<string, Pick<Site, "id" | "name" | "domain">>;
  onDismiss: (id: string) => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [showSites, setShowSites] = useState(false);
  const isNetwork = opp.type === "missing_dedicated_page";
  const affected = opp.sitePlans.filter((p) => p.action !== "exclude");
  const site = opp.siteId ? sitesById[opp.siteId] : null;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={isNetwork ? "blue" : "neutral"}>
              {OPPORTUNITY_TYPE_LABEL[opp.type]}
            </Badge>
            <span className="text-xs text-muted tnum">Score {opp.score}</span>
          </div>
          <h3 className="mt-1.5 text-base font-semibold text-ink">{opp.title}</h3>
          {site && <div className="text-xs text-ink-2">{site.domain}</div>}
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold text-ink tnum">
            {formatInt(opp.networkImpressions)}
          </div>
          <div className="text-xs text-muted">impressions / 28d</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {isNetwork && <Badge>Affected sites: {affected.length}</Badge>}
        <Badge>
          Est. clicks: {formatInt(opp.estimatedClicksLow)}–{formatInt(opp.estimatedClicksHigh)}
        </Badge>
        <LevelBadge label="Intent" level={opp.commercialIntent} />
        <LevelBadge label="Confidence" level={opp.confidence} />
        <LevelBadge label="Effort" level={opp.effort} />
      </div>

      <div className="mt-3 space-y-1.5 text-sm text-ink-2">
        <p>
          <span className="font-medium text-ink">What we found: </span>
          {opp.whatWeFound}
        </p>
        <p>
          <span className="font-medium text-ink">Why it matters: </span>
          {opp.whyItMatters}
        </p>
        <p>
          <span className="font-medium text-ink">Proposed change: </span>
          {opp.proposedChange}
        </p>
        {opp.risks.length > 0 && (
          <p>
            <span className="font-medium text-ink">What could go wrong: </span>
            {opp.risks.join("; ")}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <button
          onClick={() => setShowEvidence((v) => !v)}
          className="rounded-md border border-edge px-2.5 py-1 font-medium text-ink hover:bg-page"
        >
          {showEvidence ? "Hide raw evidence" : "Show raw evidence"}
        </button>
        {isNetwork && (
          <>
            <button
              onClick={() => setShowSites((v) => !v)}
              className="rounded-md border border-edge px-2.5 py-1 font-medium text-ink hover:bg-page"
            >
              {showSites ? "Hide affected sites" : "View affected sites"}
            </button>
            <Link
              href={`/rollouts/new?opportunity=${opp.id}`}
              className="rounded-md bg-series-1 px-2.5 py-1 font-medium text-white hover:opacity-90"
            >
              Create rollout
            </Link>
          </>
        )}
        {opp.clusterId && (
          <Link
            href={`/clusters/${opp.clusterId}`}
            className="rounded-md border border-edge px-2.5 py-1 font-medium text-ink hover:bg-page"
          >
            View cluster
          </Link>
        )}
        {site && (
          <Link
            href={`/sites/${site.id}`}
            className="rounded-md border border-edge px-2.5 py-1 font-medium text-ink hover:bg-page"
          >
            View site
          </Link>
        )}
        <button
          onClick={() => onDismiss(opp.id)}
          className="ml-auto rounded-md px-2.5 py-1 font-medium text-muted hover:bg-page hover:text-ink"
        >
          Dismiss
        </button>
      </div>

      {showEvidence && (
        <div className="mt-3 overflow-x-auto rounded-md border border-edge">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="px-3 py-2 font-medium">Query</th>
                <th className="px-3 py-2 text-right font-medium">Impressions</th>
                <th className="px-3 py-2 text-right font-medium">Clicks</th>
                <th className="px-3 py-2 text-right font-medium">Position</th>
              </tr>
            </thead>
            <tbody>
              {opp.evidenceQueries.map((q) => (
                <tr key={q.query} className="border-b border-edge last:border-0">
                  <td className="px-3 py-1.5 text-ink">{q.query}</td>
                  <td className="px-3 py-1.5 text-right text-ink-2 tnum">
                    {formatInt(q.impressions28d)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-ink-2 tnum">
                    {formatInt(q.clicks28d)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-ink-2 tnum">{q.position}</td>
                </tr>
              ))}
              {opp.evidenceQueries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-2 text-ink-2">
                    Evidence for this detector lives on the site screen.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showSites && isNetwork && (
        <ul className="mt-3 grid gap-1 rounded-md border border-edge p-3 text-sm sm:grid-cols-2">
          {opp.sitePlans
            .filter((p) => p.action !== "exclude")
            .map((p) => (
              <li key={p.siteId} className="flex items-baseline gap-2">
                <Badge
                  tone={p.action === "create" ? "good" : p.action === "improve" ? "blue" : "warning"}
                >
                  {p.action}
                </Badge>
                <Link href={`/sites/${p.siteId}`} className="text-ink hover:text-series-1">
                  {sitesById[p.siteId]?.name ?? p.siteId}
                </Link>
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}
