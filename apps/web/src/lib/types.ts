// Domain types for Phase 1 (fixture data). Mirrors docs/DATA_MODEL.md so the
// fixture layer can later be swapped for Supabase/BigQuery without UI changes.

export interface Organisation {
  id: string;
  name: string;
}

export interface Service {
  id: string;
  name: string;
  commercialValue: 1 | 2 | 3; // low / medium / high lead value
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  location: string;
  region: string;
  launchedYear: number;
  serviceIds: string[];
  healthy: boolean; // indexable and healthy enough to benefit from new pages
}

export interface Network {
  id: string;
  name: string;
  siteIds: string[];
}

export interface Campaign {
  id: string;
  name: string;
  networkId: string;
  siteIds: string[];
}

export type CoverageState =
  | "strong_dedicated_page"
  | "weak_dedicated_page"
  | "poorly_targeted_page"
  | "wrong_page_ranks"
  | "missing_with_demand"
  | "network_evidence_only"
  | "not_relevant"
  | "recommended"
  | "being_built"
  | "experiment_in_progress";

export interface CoverageCell {
  siteId: string;
  serviceId: string;
  state: CoverageState;
  impressions28d: number;
  clicks28d: number;
  medianPosition: number | null;
  rankingPage: string | null;
}

export interface QueryVariation {
  query: string;
  impressions28d: number;
  clicks28d: number;
  position: number;
}

export interface QueryCluster {
  id: string;
  name: string;
  serviceId: string;
  audience: string | null; // e.g. "landlords", "schools"
  normalisedForm: string; // e.g. "fire door inspection [location]"
  intent: "commercial" | "informational" | "local";
  variations: QueryVariation[];
  evidence: NetworkEvidence;
}

export interface NetworkEvidence {
  totalImpressions: number;
  totalClicks: number;
  sitesWithImpressions: number;
  sitesWithDedicatedPage: number;
  sitesOnBroadPages: number;
  eligibleSitesWithoutPage: number;
  medianPositionWithPage: number;
  medianPositionWithoutPage: number;
  medianCtrWithPage: number;
  medianCtrWithoutPage: number;
  monthsOfData: number;
}

export type OpportunityType =
  | "missing_dedicated_page" // network rollout
  | "ctr_underperformance"
  | "striking_distance"
  | "title_mismatch"
  | "wrong_page_ranks"
  | "url_switching"
  | "declining_clicks"
  | "low_visibility";

export type Level = "low" | "medium" | "high";

export interface SitePlan {
  siteId: string;
  action: "create" | "improve" | "review" | "exclude";
  reason: string;
}

export interface Opportunity {
  id: string;
  /** Stable identity across analysis runs (real opportunities get new ids each run). */
  dismissKey?: string;
  type: OpportunityType;
  title: string;
  clusterId: string | null;
  serviceId: string | null;
  siteId: string | null; // set for single-site opportunities
  networkImpressions: number;
  estimatedClicksLow: number;
  estimatedClicksHigh: number;
  commercialIntent: Level;
  confidence: Level;
  effort: Level;
  score: number;
  whatWeFound: string;
  whyItMatters: string;
  proposedChange: string;
  risks: string[];
  sitePlans: SitePlan[]; // per-site create/improve/review/exclude decisions
  evidenceQueries: QueryVariation[]; // raw evidence for the drawer
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface PageStat {
  url: string;
  clicks28d: number;
  impressions28d: number;
  ctr: number;
  position: number;
  clicksChangePct: number;
}

export interface RolloutBatch {
  name: string;
  siteIds: string[];
}

export interface Rollout {
  id: string;
  opportunityId: string;
  blueprintTitle: string;
  batches: RolloutBatch[];
  excludedSiteIds: string[];
  reviewSiteIds: string[];
  createdAt: string;
  status: "draft" | "in_progress";
}

export interface SavedFilter {
  id: string;
  name: string;
  params: string; // serialized URLSearchParams
}

export interface Scope {
  kind: "network" | "campaign" | "site";
  id: string;
}
