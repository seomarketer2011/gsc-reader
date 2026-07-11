// Data-access layer. Phase 1 serves deterministic fixtures behind async
// functions shaped like the future API, so Phase 2+ can swap in Supabase and
// BigQuery-backed endpoints without touching the UI.

import {
  Campaign,
  CoverageCell,
  DailyPoint,
  Opportunity,
  PageStat,
  QueryCluster,
  Scope,
  Site,
} from "../types";
import { getWorld, siteDailySeries, sitePages, FixtureWorld } from "../fixtures/generate";

export class NotFoundError extends Error {}

async function world(): Promise<FixtureWorld> {
  return getWorld();
}

export async function getOrganisation() {
  return (await world()).organisation;
}

export async function getNetwork() {
  return (await world()).network;
}

export async function getServices() {
  return (await world()).services;
}

export async function getCampaigns(): Promise<Campaign[]> {
  return (await world()).campaigns;
}

export async function getSites(): Promise<Site[]> {
  return (await world()).sites;
}

export async function getSite(siteId: string): Promise<Site> {
  const site = (await world()).sites.find((s) => s.id === siteId);
  if (!site) throw new NotFoundError(`Unknown site: ${siteId}`);
  return site;
}

/** Site ids in scope for the current global selection. */
export async function getScopedSiteIds(scope: Scope): Promise<string[]> {
  const w = await world();
  if (scope.kind === "network") return w.network.siteIds;
  if (scope.kind === "campaign") {
    const campaign = w.campaigns.find((c) => c.id === scope.id);
    if (!campaign) throw new NotFoundError(`Unknown campaign: ${scope.id}`);
    return campaign.siteIds;
  }
  const site = w.sites.find((s) => s.id === scope.id);
  if (!site) throw new NotFoundError(`Unknown site: ${scope.id}`);
  return [site.id];
}

export async function getCoverage(siteIds?: string[]): Promise<CoverageCell[]> {
  const w = await world();
  if (!siteIds) return w.coverage;
  const set = new Set(siteIds);
  return w.coverage.filter((c) => set.has(c.siteId));
}

export async function getClusters(): Promise<QueryCluster[]> {
  return (await world()).clusters;
}

export async function getCluster(clusterId: string): Promise<QueryCluster> {
  const cluster = (await world()).clusters.find((c) => c.id === clusterId);
  if (!cluster) throw new NotFoundError(`Unknown cluster: ${clusterId}`);
  return cluster;
}

export async function getOpportunities(scope?: Scope): Promise<Opportunity[]> {
  const w = await world();
  if (!scope || scope.kind === "network") return w.opportunities;
  const siteIds = new Set(await getScopedSiteIds(scope));
  return w.opportunities.filter((o) => {
    if (o.siteId) return siteIds.has(o.siteId);
    // Network opportunities stay visible if any in-scope site is affected.
    return o.sitePlans.some((p) => p.action !== "exclude" && siteIds.has(p.siteId));
  });
}

export async function getOpportunity(id: string): Promise<Opportunity> {
  const opp = (await world()).opportunities.find((o) => o.id === id);
  if (!opp) throw new NotFoundError(`Unknown opportunity: ${id}`);
  return opp;
}

export async function getSiteDailySeries(siteId: string): Promise<DailyPoint[]> {
  await getSite(siteId); // 404 behaviour matches the future API
  return siteDailySeries(siteId);
}

export async function getSitePages(siteId: string): Promise<PageStat[]> {
  await getSite(siteId);
  return sitePages(siteId);
}
