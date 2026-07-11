"use client";

import { useRollouts } from "@/lib/collections";
import { Badge, Card, EmptyState, Skeleton } from "./ui";

export function RolloutListClient({
  sitesById,
}: {
  sitesById: Record<string, { name: string }>;
}) {
  const rollouts = useRollouts();

  if (!rollouts.ready) return <Skeleton className="h-48" />;

  if (rollouts.items.length === 0) {
    return (
      <EmptyState
        title="No rollouts yet"
        body="Build one from a network opportunity: open the Opportunity Inbox, pick a “Network page rollout” card and press “Create rollout”."
        action={{ href: "/", label: "Open the Opportunity Inbox" }}
      />
    );
  }

  return (
    <div className="space-y-3">
      {rollouts.items.map((r) => (
        <Card key={r.id} className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold text-ink">{r.blueprintTitle}</div>
              <div className="text-xs text-muted">
                Created {new Date(r.createdAt).toLocaleDateString("en-GB")} ·{" "}
                {r.batches.reduce((s, b) => s + b.siteIds.length, 0)} sites ·{" "}
                {r.excludedSiteIds.length} excluded · {r.reviewSiteIds.length} in manual review
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={r.status === "draft" ? "warning" : "good"}>{r.status}</Badge>
              <button
                onClick={() => {
                  if (window.confirm("Delete this rollout draft?")) {
                    rollouts.remove(r.id);
                  }
                }}
                className="text-sm font-medium text-muted hover:text-critical"
              >
                Delete
              </button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {r.batches.map((b) => (
              <div key={b.name} className="rounded-md border border-edge p-3 text-sm">
                <div className="font-medium text-ink">{b.name}</div>
                <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
                  {b.siteIds.slice(0, 5).map((id) => (
                    <li key={id}>{sitesById[id]?.name ?? id}</li>
                  ))}
                  {b.siteIds.length > 5 && <li>… and {b.siteIds.length - 5} more</li>}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
