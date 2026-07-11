import { describe, expect, it } from "vitest";
import { getWorld, siteDailySeries } from "../fixtures/generate";

describe("fixture world", () => {
  const world = getWorld();

  it("contains exactly 99 sites and 20 services in one network", () => {
    expect(world.sites).toHaveLength(99);
    expect(world.services).toHaveLength(20);
    expect(world.network.siteIds).toHaveLength(99);
  });

  it("has a coverage state for every site × service cell", () => {
    expect(world.coverage).toHaveLength(99 * 20);
    const seen = new Set(world.coverage.map((c) => `${c.siteId}|${c.serviceId}`));
    expect(seen.size).toBe(99 * 20);
  });

  it("marks services a site does not offer as not_relevant", () => {
    const sitesById = new Map(world.sites.map((s) => [s.id, s]));
    for (const cell of world.coverage) {
      const offers = sitesById.get(cell.siteId)!.serviceIds.includes(cell.serviceId);
      if (!offers) expect(cell.state).toBe("not_relevant");
      else expect(cell.state).not.toBe("not_relevant");
    }
  });

  it("gives every opportunity complete, renderable evidence", () => {
    expect(world.opportunities.length).toBeGreaterThan(20);
    for (const opp of world.opportunities) {
      expect(opp.whatWeFound.length).toBeGreaterThan(10);
      expect(opp.whyItMatters.length).toBeGreaterThan(10);
      expect(opp.proposedChange.length).toBeGreaterThan(10);
      expect(opp.score).toBeGreaterThanOrEqual(0);
      expect(opp.score).toBeLessThanOrEqual(100);
      expect(opp.estimatedClicksHigh).toBeGreaterThanOrEqual(opp.estimatedClicksLow);
    }
  });

  it("network rollouts recommend a subset of sites, never all 99", () => {
    const rollouts = world.opportunities.filter((o) => o.type === "missing_dedicated_page");
    expect(rollouts.length).toBeGreaterThan(5);
    for (const opp of rollouts) {
      expect(opp.sitePlans).toHaveLength(99);
      const create = opp.sitePlans.filter((p) => p.action === "create").length;
      expect(create).toBeGreaterThan(0);
      expect(create).toBeLessThan(99);
      for (const plan of opp.sitePlans) expect(plan.reason.length).toBeGreaterThan(5);
    }
  });

  it("is deterministic across generations", () => {
    // Module cache is warm; regenerate a per-site series instead, which is
    // seeded independently, and compare snapshots of the world itself.
    const a = JSON.stringify(siteDailySeries("site-42"));
    const b = JSON.stringify(siteDailySeries("site-42"));
    expect(a).toBe(b);
    expect(JSON.stringify(getWorld())).toBe(JSON.stringify(getWorld()));
  });

  it("produces 180 days of daily data per site", () => {
    const series = siteDailySeries("site-1");
    expect(series).toHaveLength(180);
    expect(series.at(-1)!.date).toBe("2026-07-10");
    for (const p of series) {
      expect(p.impressions).toBeGreaterThanOrEqual(p.clicks);
      expect(p.position).toBeGreaterThan(0);
    }
  });

  it("defines campaigns as subsets of the network", () => {
    expect(world.campaigns.length).toBeGreaterThanOrEqual(4);
    const networkSites = new Set(world.network.siteIds);
    for (const campaign of world.campaigns) {
      for (const id of campaign.siteIds) expect(networkSites.has(id)).toBe(true);
    }
  });
});
