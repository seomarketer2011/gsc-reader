"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Opportunity, Rollout, Site } from "@/lib/types";
import { formatInt } from "@/lib/format";
import { useLocalList } from "@/lib/useLocalList";
import { Badge, Card } from "./ui";

function buildRollout(
  opportunity: Opportunity,
  batches: { name: string; siteIds: string[] }[],
  excludedPlans: Opportunity["sitePlans"],
  reviewPlans: Opportunity["sitePlans"],
): Rollout {
  return {
    id: `rollout-${Date.now()}`,
    opportunityId: opportunity.id,
    blueprintTitle: opportunity.title.replace(/^Create “|” pages across the network$/g, ""),
    batches,
    excludedSiteIds: excludedPlans.map((p) => p.siteId),
    reviewSiteIds: reviewPlans.map((p) => p.siteId),
    createdAt: new Date().toISOString(),
    status: "draft",
  };
}

export function RolloutBuilderClient({
  opportunity,
  sitesById,
}: {
  opportunity: Opportunity;
  sitesById: Record<string, Pick<Site, "id" | "name" | "domain" | "location">>;
}) {
  const router = useRouter();
  const [rollouts, setRollouts] = useLocalList<Rollout[]>("rollouts", []);
  const [batchSize, setBatchSize] = useState(10);

  const createPlans = useMemo(
    () => opportunity.sitePlans.filter((p) => p.action === "create"),
    [opportunity],
  );
  const improvePlans = opportunity.sitePlans.filter((p) => p.action === "improve");
  const reviewPlans = opportunity.sitePlans.filter((p) => p.action === "review");
  const excludedPlans = opportunity.sitePlans.filter((p) => p.action === "exclude");

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(createPlans.map((p) => p.siteId)),
  );

  function toggle(siteId: string) {
    const next = new Set(selected);
    if (next.has(siteId)) next.delete(siteId);
    else next.add(siteId);
    setSelected(next);
  }

  const batches = useMemo(() => {
    const ids = createPlans.map((p) => p.siteId).filter((id) => selected.has(id));
    const out: { name: string; siteIds: string[] }[] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      out.push({
        name: `Batch ${out.length + 1}${out.length === 0 ? " — strongest opportunities" : out.length === 1 ? " — medium confidence" : " — dependent on earlier results"}`,
        siteIds: ids.slice(i, i + batchSize),
      });
    }
    return out;
  }, [createPlans, selected, batchSize]);

  function createRollout() {
    const rollout = buildRollout(opportunity, batches, excludedPlans, reviewPlans);
    setRollouts([...rollouts, rollout]);
    router.push("/rollouts");
  }

  const section = (
    title: string,
    tone: "good" | "blue" | "warning" | "neutral",
    plans: typeof createPlans,
    withCheckbox: boolean,
  ) => (
    <Card>
      <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
        <span className="text-sm font-medium text-ink">{title}</span>
        <Badge tone={tone}>{withCheckbox ? `${selected.size} selected` : `${plans.length} sites`}</Badge>
      </div>
      {plans.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-2">No sites in this group.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-edge overflow-y-auto">
          {plans.map((p) => (
            <li key={p.siteId} className="flex items-start gap-2.5 px-4 py-2 text-sm">
              {withCheckbox && (
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--series-1)]"
                  checked={selected.has(p.siteId)}
                  onChange={() => toggle(p.siteId)}
                  aria-label={`Include ${sitesById[p.siteId]?.name}`}
                />
              )}
              <div className="min-w-0">
                <Link
                  href={`/sites/${p.siteId}`}
                  className="font-medium text-ink hover:text-series-1"
                >
                  {sitesById[p.siteId]?.name ?? p.siteId}
                </Link>
                <div className="text-xs text-ink-2">{p.reason}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <div>
      <Card className="mb-4 p-4 text-sm">
        <div className="font-medium text-ink">Page blueprint</div>
        <p className="mt-1 text-ink-2">{opportunity.proposedChange}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge>Network impressions: {formatInt(opportunity.networkImpressions)}</Badge>
          <Badge>
            Est. clicks: {formatInt(opportunity.estimatedClicksLow)}–
            {formatInt(opportunity.estimatedClicksHigh)}
          </Badge>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {section("Create — recommended sites", "good", createPlans, true)}
        <div className="space-y-4">
          {section("Improve existing pages", "blue", improvePlans, false)}
          {section("Manual review", "warning", reviewPlans, false)}
        </div>
      </div>

      <Card className="mt-4 p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-ink">Batches</span>
          <label className="flex items-center gap-2 text-ink-2">
            Sites per batch
            <select
              className="rounded-md border border-edge bg-surface px-2 py-1 text-sm text-ink"
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value))}
            >
              {[5, 10, 12, 15].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="text-muted">
            {excludedPlans.length} sites excluded · {reviewPlans.length} for manual review
          </span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {batches.map((b) => (
            <div key={b.name} className="rounded-md border border-edge p-3 text-sm">
              <div className="font-medium text-ink">{b.name}</div>
              <div className="mt-1 text-xs text-ink-2">
                {b.siteIds.length} sites:{" "}
                {b.siteIds
                  .slice(0, 3)
                  .map((id) => sitesById[id]?.location ?? id)
                  .join(", ")}
                {b.siteIds.length > 3 && "…"}
              </div>
            </div>
          ))}
          {batches.length === 0 && (
            <p className="text-sm text-ink-2">Select at least one site to build batches.</p>
          )}
        </div>
        <button
          onClick={createRollout}
          disabled={batches.length === 0}
          className="mt-4 rounded-md bg-series-1 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          Create rollout ({selected.size} sites in {batches.length} batches)
        </button>
      </Card>
    </div>
  );
}
