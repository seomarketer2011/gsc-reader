import { describe, expect, it } from "vitest";
import { scoreOpportunity, ScoringInput } from "../scoring";

const base: ScoringInput = {
  totalImpressions: 84_300,
  sitesWithImpressions: 61,
  eligibleSitesWithoutPage: 49,
  eligibleSites: 70,
  medianPositionWithPage: 5.8,
  medianPositionWithoutPage: 14.2,
  commercialValue: 3,
  monthsOfData: 12,
  contentEffort: 2,
  duplicationRisk: 1,
  cannibalisationRisk: 1,
};

describe("scoreOpportunity", () => {
  it("is deterministic", () => {
    expect(scoreOpportunity(base)).toBe(scoreOpportunity({ ...base }));
  });

  it("stays within 0–100", () => {
    expect(scoreOpportunity(base)).toBeGreaterThan(0);
    expect(scoreOpportunity(base)).toBeLessThanOrEqual(100);
    expect(
      scoreOpportunity({ ...base, totalImpressions: 10_000_000, sitesWithImpressions: 99 }),
    ).toBeLessThanOrEqual(100);
  });

  it("scores zero when there is no coverage gap", () => {
    expect(scoreOpportunity({ ...base, eligibleSitesWithoutPage: 0 })).toBe(0);
  });

  it("increases with demand", () => {
    const low = scoreOpportunity({ ...base, totalImpressions: 2_000 });
    expect(scoreOpportunity(base)).toBeGreaterThan(low);
  });

  it("increases with dedicated-page evidence", () => {
    const weakEvidence = scoreOpportunity({ ...base, medianPositionWithoutPage: 6.0 });
    expect(scoreOpportunity(base)).toBeGreaterThan(weakEvidence);
  });

  it("decreases with effort and risk", () => {
    expect(scoreOpportunity({ ...base, contentEffort: 3 })).toBeLessThan(scoreOpportunity(base));
    expect(scoreOpportunity({ ...base, duplicationRisk: 3, cannibalisationRisk: 3 })).toBeLessThan(
      scoreOpportunity(base),
    );
  });
});
