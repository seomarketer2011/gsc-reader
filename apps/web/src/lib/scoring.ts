// Network opportunity scoring — pure and deterministic (docs/OPPORTUNITY_RULES.md).
//
// network_opportunity_score =
//   demand_strength × site_coverage_gap × dedicated_page_evidence ×
//   commercial_value × applicability × confidence
//   ÷ content_effort ÷ duplication_risk ÷ cannibalisation_risk

export interface ScoringInput {
  totalImpressions: number;
  sitesWithImpressions: number;
  eligibleSitesWithoutPage: number;
  eligibleSites: number;
  medianPositionWithPage: number;
  medianPositionWithoutPage: number;
  commercialValue: 1 | 2 | 3;
  monthsOfData: number;
  contentEffort: 1 | 2 | 3;
  duplicationRisk: 1 | 2 | 3;
  cannibalisationRisk: 1 | 2 | 3;
}

/** Returns a score in roughly 0–100. Higher = act sooner. */
export function scoreOpportunity(input: ScoringInput): number {
  // Demand strength: log-scaled impressions × breadth of sites showing demand.
  const demand =
    Math.log10(Math.max(input.totalImpressions, 10)) *
    Math.sqrt(Math.max(input.sitesWithImpressions, 1));

  const coverageGap =
    input.eligibleSites === 0
      ? 0
      : input.eligibleSitesWithoutPage / input.eligibleSites;

  // Evidence: how much better dedicated-page sites rank (position delta, capped).
  const positionDelta = Math.max(
    0,
    input.medianPositionWithoutPage - input.medianPositionWithPage,
  );
  const evidence = 0.5 + Math.min(positionDelta, 12) / 12;

  const commercial = input.commercialValue / 2; // 0.5, 1, 1.5

  const confidence =
    Math.min(input.monthsOfData, 12) / 12 *
    Math.min(input.sitesWithImpressions / 10, 1);

  const raw =
    (demand * coverageGap * evidence * commercial * Math.max(confidence, 0.1)) /
    (input.contentEffort * ((input.duplicationRisk + input.cannibalisationRisk) / 2));

  return Math.round(Math.min(raw * 6, 100) * 10) / 10;
}

export function confidenceLevel(input: ScoringInput): "low" | "medium" | "high" {
  const c =
    Math.min(input.monthsOfData, 12) / 12 *
    Math.min(input.sitesWithImpressions / 10, 1);
  if (c >= 0.7) return "high";
  if (c >= 0.35) return "medium";
  return "low";
}
