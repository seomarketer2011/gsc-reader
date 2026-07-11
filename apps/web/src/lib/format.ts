import { CoverageState, Level, OpportunityType, Scope } from "./types";

export function formatInt(n: number): string {
  return n.toLocaleString("en-GB");
}

export function formatPct(x: number, dp = 1): string {
  return `${(x * 100).toFixed(dp)}%`;
}

export function formatCompact(n: number): string {
  return Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export const COVERAGE_META: Record<CoverageState, { label: string; short: string }> = {
  strong_dedicated_page: { label: "Strong dedicated page", short: "Strong" },
  weak_dedicated_page: { label: "Weak dedicated page", short: "Weak" },
  poorly_targeted_page: { label: "Relevant page, poorly targeted", short: "Untargeted" },
  wrong_page_ranks: { label: "Wrong page receiving impressions", short: "Wrong page" },
  missing_with_demand: { label: "No page, but demand exists", short: "Missing" },
  network_evidence_only: { label: "Network evidence only", short: "Evidence" },
  not_relevant: { label: "Not relevant to this site", short: "—" },
  recommended: { label: "Already recommended", short: "Recommended" },
  being_built: { label: "Page being built", short: "Building" },
  experiment_in_progress: { label: "Experiment in progress", short: "Experiment" },
};

export const OPPORTUNITY_TYPE_LABEL: Record<OpportunityType, string> = {
  missing_dedicated_page: "Network page rollout",
  ctr_underperformance: "CTR underperformance",
  striking_distance: "Striking distance",
  title_mismatch: "Title mismatch",
  wrong_page_ranks: "Wrong page ranks",
  url_switching: "URL switching",
  declining_clicks: "Declining clicks",
};

export const LEVEL_LABEL: Record<Level, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function parseScope(raw: string | undefined): Scope {
  if (!raw) return { kind: "network", id: "net-1" };
  const [kind, id] = raw.split(":");
  if ((kind === "campaign" || kind === "site") && id) return { kind, id };
  return { kind: "network", id: "net-1" };
}

export function scopeParam(scope: Scope): string {
  return scope.kind === "network" ? "" : `${scope.kind}:${scope.id}`;
}
