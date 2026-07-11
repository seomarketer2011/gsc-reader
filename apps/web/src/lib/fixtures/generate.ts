// Deterministic fixture world: a 99-site fire-protection network with services,
// campaigns, coverage states, query clusters, network evidence and scored
// opportunities. Same seed → byte-identical output (unit-tested).

import {
  Campaign,
  CoverageCell,
  CoverageState,
  DailyPoint,
  Level,
  NetworkEvidence,
  Opportunity,
  OpportunityType,
  Organisation,
  PageStat,
  QueryCluster,
  QueryVariation,
  Service,
  Site,
  SitePlan,
  Network,
} from "../types";
import { hashSeed, intBetween, mulberry32, pick, Rng, shuffled } from "../rng";
import { confidenceLevel, scoreOpportunity, ScoringInput } from "../scoring";

export const FIXTURE_SEED = 20260711;
// Fixture "today": series are generated relative to a fixed date so output is
// stable across runs (determinism requirement).
export const FIXTURE_TODAY = "2026-07-10";

const SERVICES: Array<{ name: string; value: 1 | 2 | 3 }> = [
  { name: "Fire door installation", value: 3 },
  { name: "Fire door inspection", value: 3 },
  { name: "Fire door repair", value: 2 },
  { name: "Fire door maintenance", value: 2 },
  { name: "Fire risk assessment", value: 3 },
  { name: "Fire alarm installation", value: 3 },
  { name: "Fire alarm servicing", value: 2 },
  { name: "Emergency lighting", value: 2 },
  { name: "Fire extinguisher servicing", value: 1 },
  { name: "Fire stopping", value: 2 },
  { name: "Compartmentation surveys", value: 2 },
  { name: "Landlord compliance", value: 3 },
  { name: "Housing association compliance", value: 3 },
  { name: "School fire safety", value: 2 },
  { name: "Care home fire safety", value: 3 },
  { name: "Fire safety training", value: 1 },
  { name: "Fire warden training", value: 1 },
  { name: "Sprinkler installation", value: 3 },
  { name: "Dry riser testing", value: 2 },
  { name: "Fire curtain installation", value: 2 },
];

const LOCATIONS: Array<{ town: string; region: string }> = [
  ...[
    "Croydon", "Bromley", "Orpington", "Sutton", "Kingston", "Richmond",
    "Wimbledon", "Lewisham", "Greenwich", "Woolwich", "Bexley", "Dartford",
    "Romford", "Ilford", "Barking", "Enfield", "Barnet", "Harrow", "Ealing",
    "Hounslow", "Uxbridge", "Wembley", "Camden", "Islington", "Hackney",
    "Stratford", "Walthamstow", "Tottenham", "Finchley", "Hampstead",
  ].map((town) => ({ town, region: "London" })),
  ...[
    "Guildford", "Woking", "Reigate", "Crawley", "Brighton", "Eastbourne",
    "Hastings", "Maidstone", "Canterbury", "Ashford", "Tunbridge Wells",
    "Sevenoaks", "Gravesend", "Chatham", "Basildon", "Chelmsford", "Southend",
    "Colchester", "Watford", "St Albans", "Luton", "Stevenage", "Reading",
    "Slough", "Oxford", "Milton Keynes", "Portsmouth", "Southampton",
    "Winchester", "Basingstoke",
  ].map((town) => ({ town, region: "South East" })),
];

const AUDIENCES = ["landlords", "schools", "care homes", "housing associations", "offices"];

export interface FixtureWorld {
  organisation: Organisation;
  services: Service[];
  sites: Site[];
  network: Network;
  campaigns: Campaign[];
  coverage: CoverageCell[];
  clusters: QueryCluster[];
  opportunities: Opportunity[];
}

function makeSites(rng: Rng): Site[] {
  const prefixes = ["", "Pro", "First", "Safe", "Total", "Prime", "Apex", "Guard"];
  const suffixes = ["Fire Protection", "Fire Safety", "Fire Doors", "Fire Compliance", "Fire Services"];
  const sites: Site[] = [];
  const usedDomains = new Set<string>();
  const locs = shuffled(rng, LOCATIONS);
  for (let i = 0; i < 99; i++) {
    const loc = locs[i % locs.length];
    const prefix = pick(rng, prefixes);
    const suffix = pick(rng, suffixes);
    const name = `${prefix ? prefix + " " : ""}${suffix} ${loc.town}`;
    let domain = `${(prefix + suffix).toLowerCase().replace(/\s+/g, "")}${loc.town.toLowerCase().replace(/\s+/g, "")}.co.uk`;
    while (usedDomains.has(domain)) domain = `the${domain}`;
    usedDomains.add(domain);
    // Each site offers 8–16 of the 20 services.
    const offered = shuffled(rng, SERVICES.map((_, idx) => `svc-${idx + 1}`)).slice(
      0,
      intBetween(rng, 8, 16),
    );
    sites.push({
      id: `site-${i + 1}`,
      name,
      domain,
      location: loc.town,
      region: loc.region,
      launchedYear: intBetween(rng, 2015, 2026),
      serviceIds: offered.sort(),
      healthy: rng() > 0.08,
    });
  }
  return sites;
}

function coverageStateFor(rng: Rng, offersService: boolean): CoverageState {
  if (!offersService) return "not_relevant";
  const r = rng();
  if (r < 0.14) return "strong_dedicated_page";
  if (r < 0.24) return "weak_dedicated_page";
  if (r < 0.32) return "poorly_targeted_page";
  if (r < 0.44) return "wrong_page_ranks";
  if (r < 0.68) return "missing_with_demand";
  if (r < 0.86) return "network_evidence_only";
  if (r < 0.9) return "recommended";
  if (r < 0.94) return "being_built";
  return "experiment_in_progress";
}

const HAS_PAGE: CoverageState[] = ["strong_dedicated_page", "weak_dedicated_page"];
const NO_PAGE: CoverageState[] = ["missing_with_demand", "network_evidence_only"];

function makeCoverage(rng: Rng, sites: Site[], services: Service[]): CoverageCell[] {
  const cells: CoverageCell[] = [];
  for (const site of sites) {
    for (const service of services) {
      const state = coverageStateFor(rng, site.serviceIds.includes(service.id));
      const hasDemand = state !== "not_relevant" && state !== "network_evidence_only";
      const impressions = hasDemand ? intBetween(rng, 40, 4200) : 0;
      const goodPage = HAS_PAGE.includes(state);
      const position = hasDemand
        ? Math.round((goodPage ? 2 + rng() * 8 : 8 + rng() * 22) * 10) / 10
        : null;
      const ctr = position ? Math.max(0.01, 0.32 / position) : 0;
      cells.push({
        siteId: site.id,
        serviceId: service.id,
        state,
        impressions28d: impressions,
        clicks28d: Math.round(impressions * ctr),
        medianPosition: position,
        rankingPage:
          state === "not_relevant" || state === "network_evidence_only"
            ? null
            : goodPage
              ? `/${service.name.toLowerCase().replace(/\s+/g, "-")}`
              : state === "wrong_page_ranks" || state === "poorly_targeted_page"
                ? "/services"
                : null,
      });
    }
  }
  return cells;
}

function queryVariations(
  rng: Rng,
  service: Service,
  audience: string | null,
  town: string,
): QueryVariation[] {
  const base = service.name.toLowerCase();
  const forms = audience
    ? [
        `${base} for ${audience} ${town}`,
        `${base} ${audience} ${town}`,
        `${audience} ${base} ${town}`,
        `${base} for ${audience} near me`,
      ]
    : [
        `${base} ${town}`,
        `${base} in ${town}`,
        `${base} near me`,
        `${base} cost ${town}`,
        `emergency ${base} ${town}`,
        `${base} company ${town}`,
      ];
  return forms.slice(0, intBetween(rng, 3, forms.length)).map((query) => {
    const impressions = intBetween(rng, 120, 9000);
    const position = Math.round((2 + rng() * 20) * 10) / 10;
    return {
      query,
      impressions28d: impressions,
      clicks28d: Math.round((impressions * Math.max(0.008, 0.3 / position)) as number),
      position,
    };
  });
}

function makeClusters(rng: Rng, services: Service[], sites: Site[], coverage: CoverageCell[]): QueryCluster[] {
  const clusters: QueryCluster[] = [];
  const byService = new Map<string, CoverageCell[]>();
  for (const cell of coverage) {
    const list = byService.get(cell.serviceId) ?? [];
    list.push(cell);
    byService.set(cell.serviceId, list);
  }
  let n = 0;
  for (const service of services) {
    const audiences: Array<string | null> = [null];
    if (rng() < 0.55) audiences.push(pick(rng, AUDIENCES));
    for (const audience of audiences) {
      n++;
      const cells = byService.get(service.id) ?? [];
      const withPage = cells.filter((c) => HAS_PAGE.includes(c.state));
      const withoutPage = cells.filter((c) => NO_PAGE.includes(c.state));
      const withImpr = cells.filter((c) => c.impressions28d > 0);
      const median = (xs: number[]) =>
        xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const posWith = median(withPage.map((c) => c.medianPosition ?? 0)) || 5.5 + rng() * 3;
      const posWithout = median(
        cells.filter((c) => c.medianPosition !== null && !HAS_PAGE.includes(c.state)).map((c) => c.medianPosition!),
      ) || 13 + rng() * 6;
      const evidence: NetworkEvidence = {
        totalImpressions: cells.reduce((s, c) => s + c.impressions28d, 0),
        totalClicks: cells.reduce((s, c) => s + c.clicks28d, 0),
        sitesWithImpressions: withImpr.length,
        sitesWithDedicatedPage: withPage.length,
        sitesOnBroadPages: cells.filter((c) => c.state === "poorly_targeted_page" || c.state === "wrong_page_ranks").length,
        eligibleSitesWithoutPage: withoutPage.length,
        medianPositionWithPage: Math.round(posWith * 10) / 10,
        medianPositionWithoutPage: Math.round(posWithout * 10) / 10,
        medianCtrWithPage: Math.round((0.3 / posWith) * 1000) / 1000,
        medianCtrWithoutPage: Math.round((0.3 / posWithout) * 1000) / 1000,
        monthsOfData: intBetween(rng, 4, 16),
      };
      const town = pick(rng, sites).location;
      clusters.push({
        id: `cluster-${n}`,
        name: audience
          ? `${service.name} for ${audience}`
          : service.name,
        serviceId: service.id,
        audience,
        normalisedForm: `${service.name.toLowerCase()}${audience ? ` for ${audience}` : ""} [location]`,
        intent: audience ? "commercial" : rng() < 0.8 ? "local" : "informational",
        variations: queryVariations(rng, service, audience, town),
        evidence,
      });
    }
  }
  return clusters;
}

function levelFromValue(v: 1 | 2 | 3): Level {
  return v === 3 ? "high" : v === 2 ? "medium" : "low";
}

function rolloutPlans(rng: Rng, sites: Site[], serviceId: string, coverage: CoverageCell[]): SitePlan[] {
  const cellFor = new Map(coverage.filter((c) => c.serviceId === serviceId).map((c) => [c.siteId, c]));
  return sites.map((site): SitePlan => {
    const cell = cellFor.get(site.id)!;
    if (!site.serviceIds.includes(serviceId))
      return { siteId: site.id, action: "exclude", reason: "Service not offered by this business" };
    if (!site.healthy)
      return { siteId: site.id, action: "review", reason: "Site health issues — resolve indexability first" };
    switch (cell.state) {
      case "strong_dedicated_page":
        return { siteId: site.id, action: "exclude", reason: "Strong dedicated page already exists" };
      case "weak_dedicated_page":
      case "poorly_targeted_page":
        return { siteId: site.id, action: "improve", reason: "Existing page underperforms — improve rather than duplicate" };
      case "wrong_page_ranks":
        return { siteId: site.id, action: "review", reason: "An overlapping page already ranks — manual review for cannibalisation" };
      case "missing_with_demand":
        return { siteId: site.id, action: "create", reason: `Search Console shows ${cell.impressions28d.toLocaleString("en-GB")} impressions with no dedicated page` };
      case "network_evidence_only":
        return rng() < 0.5
          ? { siteId: site.id, action: "create", reason: "No direct demand yet, but strong analogous network evidence" }
          : { siteId: site.id, action: "review", reason: "Network evidence only — confirm local demand before building" };
      default:
        return { siteId: site.id, action: "exclude", reason: "Work already recommended or in progress" };
    }
  });
}

function makeOpportunities(
  rng: Rng,
  services: Service[],
  sites: Site[],
  clusters: QueryCluster[],
  coverage: CoverageCell[],
): Opportunity[] {
  const opportunities: Opportunity[] = [];
  let n = 0;

  // Network rollout opportunities from clusters with a real coverage gap.
  for (const cluster of clusters) {
    const e = cluster.evidence;
    if (e.eligibleSitesWithoutPage < 8) continue;
    const service = services.find((s) => s.id === cluster.serviceId)!;
    const input: ScoringInput = {
      totalImpressions: e.totalImpressions,
      sitesWithImpressions: e.sitesWithImpressions,
      eligibleSitesWithoutPage: e.eligibleSitesWithoutPage,
      eligibleSites: e.eligibleSitesWithoutPage + e.sitesWithDedicatedPage + e.sitesOnBroadPages,
      medianPositionWithPage: e.medianPositionWithPage,
      medianPositionWithoutPage: e.medianPositionWithoutPage,
      commercialValue: service.commercialValue,
      monthsOfData: e.monthsOfData,
      contentEffort: pick(rng, [1, 2, 2, 3] as const),
      duplicationRisk: pick(rng, [1, 1, 2, 3] as const),
      cannibalisationRisk: pick(rng, [1, 1, 2] as const),
    };
    const plans = rolloutPlans(rng, sites, cluster.serviceId, coverage);
    const create = plans.filter((p) => p.action === "create").length;
    const improve = plans.filter((p) => p.action === "improve").length;
    const review = plans.filter((p) => p.action === "review").length;
    n++;
    opportunities.push({
      id: `opp-${n}`,
      type: "missing_dedicated_page",
      title: `Create “${cluster.name}” pages across the network`,
      clusterId: cluster.id,
      serviceId: cluster.serviceId,
      siteId: null,
      networkImpressions: e.totalImpressions,
      estimatedClicksLow: Math.round(e.totalImpressions * 0.03),
      estimatedClicksHigh: Math.round(e.totalImpressions * 0.055),
      commercialIntent: levelFromValue(service.commercialValue),
      confidence: confidenceLevel(input),
      effort: input.contentEffort === 3 ? "high" : input.contentEffort === 2 ? "medium" : "low",
      score: scoreOpportunity(input),
      whatWeFound: `${e.sitesWithImpressions} of 99 sites receive impressions for “${cluster.name}” queries, but only ${e.sitesWithDedicatedPage} have a dedicated page.`,
      whyItMatters: `Sites with a dedicated page have a median position of ${e.medianPositionWithPage} versus ${e.medianPositionWithoutPage} without one — a repeatable, network-proven gap.`,
      proposedChange: `Create the page on ${create} sites, improve existing pages on ${improve} sites, manually review ${review} sites for overlap, and skip the remainder.`,
      risks: [
        "Thin or near-duplicate content if local detail is insufficient",
        "Internal cannibalisation on sites with overlapping pages",
      ],
      sitePlans: plans,
      evidenceQueries: cluster.variations,
    });
  }

  // Single-site opportunities from coverage cells.
  const singleTypes: Array<{ type: OpportunityType; states: CoverageState[] }> = [
    { type: "ctr_underperformance", states: ["strong_dedicated_page", "weak_dedicated_page"] },
    { type: "striking_distance", states: ["weak_dedicated_page", "poorly_targeted_page"] },
    { type: "title_mismatch", states: ["weak_dedicated_page"] },
    { type: "wrong_page_ranks", states: ["wrong_page_ranks"] },
    { type: "url_switching", states: ["wrong_page_ranks", "poorly_targeted_page"] },
    { type: "declining_clicks", states: ["strong_dedicated_page", "weak_dedicated_page"] },
  ];
  const describe: Record<string, (site: Site, svc: Service, cell: CoverageCell) => [string, string, string]> = {
    ctr_underperformance: (site, svc, cell) => [
      `${cell.impressions28d.toLocaleString("en-GB")} impressions at position ${cell.medianPosition} but CTR is well below the expected curve.`,
      "Clicks are being left on the table at an already-achieved ranking.",
      `Rewrite the title and meta description of ${cell.rankingPage} on ${site.domain} to match the dominant query intent.`,
    ],
    striking_distance: (site, svc, cell) => [
      `“${svc.name.toLowerCase()} ${site.location.toLowerCase()}” ranks at position ${cell.medianPosition} — inside striking distance (4–15).`,
      "Small on-page improvements typically move striking-distance terms onto page one.",
      `Strengthen ${cell.rankingPage}: heading alignment, internal links from related pages, and local proof content.`,
    ],
    title_mismatch: (site, svc, cell) => [
      `The highest-impression query for ${cell.rankingPage} does not appear in the page title or H1.`,
      "Title/query alignment is one of the most reliable CTR and relevance wins.",
      `Add “${svc.name}” and the location to the title and H1 of ${cell.rankingPage}.`,
    ],
    wrong_page_ranks: (site, svc, cell) => [
      `Queries for “${svc.name.toLowerCase()}” land on ${cell.rankingPage} instead of a dedicated service page.`,
      "The broad page cannot satisfy the intent, so position and CTR are capped.",
      `Create a dedicated ${svc.name} page on ${site.domain} and re-point internal links.`,
    ],
    url_switching: (site, svc) => [
      `The ranking URL for “${svc.name.toLowerCase()}” queries has switched between two pages repeatedly over the last 90 days.`,
      "URL switching signals unresolved internal competition and suppresses rankings.",
      "Consolidate: pick the canonical page, merge content, and redirect or de-optimise the competitor.",
    ],
    declining_clicks: (site, svc, cell) => [
      `Clicks to ${cell.rankingPage} are down materially versus the previous period despite stable impressions.`,
      "Decay usually precedes a larger ranking loss; early refresh is cheap.",
      "Refresh the page content, update proof points and re-validate internal links.",
    ],
  };
  for (const { type, states } of singleTypes) {
    const candidates = shuffled(
      rng,
      coverage.filter((c) => states.includes(c.state) && c.impressions28d > 400),
    ).slice(0, intBetween(rng, 4, 7));
    for (const cell of candidates) {
      const site = sites.find((s) => s.id === cell.siteId)!;
      const service = services.find((s) => s.id === cell.serviceId)!;
      const [what, why, change] = describe[type](site, service, cell);
      const cluster = clusters.find((cl) => cl.serviceId === cell.serviceId && !cl.audience);
      n++;
      opportunities.push({
        id: `opp-${n}`,
        type,
        title: `${service.name} — ${site.name}`,
        clusterId: cluster?.id ?? null,
        serviceId: service.id,
        siteId: site.id,
        networkImpressions: cell.impressions28d,
        estimatedClicksLow: Math.round(cell.impressions28d * 0.02),
        estimatedClicksHigh: Math.round(cell.impressions28d * 0.06),
        commercialIntent: levelFromValue(service.commercialValue),
        confidence: pick(rng, ["medium", "high", "high"] as const),
        effort: pick(rng, ["low", "low", "medium"] as const),
        score: Math.round((20 + rng() * 45) * 10) / 10,
        whatWeFound: what,
        whyItMatters: why,
        proposedChange: change,
        risks: type === "wrong_page_ranks" ? ["New page may compete with the currently ranking page"] : [],
        sitePlans: [],
        evidenceQueries: cluster?.variations.slice(0, 4) ?? [],
      });
    }
  }

  return opportunities.sort((a, b) => b.score - a.score);
}

let cached: FixtureWorld | null = null;

export function getWorld(): FixtureWorld {
  if (cached) return cached;
  const rng = mulberry32(FIXTURE_SEED);
  const services: Service[] = SERVICES.map((s, i) => ({
    id: `svc-${i + 1}`,
    name: s.name,
    commercialValue: s.value,
  }));
  const sites = makeSites(rng);
  const network: Network = {
    id: "net-1",
    name: "Fire Protection Network",
    siteIds: sites.map((s) => s.id),
  };
  const coverage = makeCoverage(rng, sites, services);
  const clusters = makeClusters(rng, services, sites, coverage);
  const opportunities = makeOpportunities(rng, services, sites, clusters, coverage);
  const london = sites.filter((s) => s.region === "London").map((s) => s.id);
  const missingInspection = coverage
    .filter((c) => c.serviceId === "svc-2" && c.state === "missing_with_demand")
    .map((c) => c.siteId);
  const campaigns: Campaign[] = [
    { id: "camp-1", name: "99-site total opportunity analysis", networkId: network.id, siteIds: network.siteIds },
    { id: "camp-2", name: `London sites (${london.length})`, networkId: network.id, siteIds: london },
    { id: "camp-3", name: "Sites missing inspection pages", networkId: network.id, siteIds: missingInspection },
    { id: "camp-4", name: "Sites launched before 2025", networkId: network.id, siteIds: sites.filter((s) => s.launchedYear < 2025).map((s) => s.id) },
  ];
  cached = {
    organisation: { id: "org-1", name: "Demo Fire Safety Group" },
    services,
    sites,
    network,
    campaigns,
    coverage,
    clusters,
    opportunities,
  };
  return cached;
}

/** Deterministic 180-day daily series for a site, relative to FIXTURE_TODAY. */
export function siteDailySeries(siteId: string): DailyPoint[] {
  const rng = mulberry32(hashSeed(`daily:${siteId}:${FIXTURE_SEED}`));
  const base = 20 + rng() * 260;
  const trend = (rng() - 0.35) * 0.4; // most sites grow slightly
  const points: DailyPoint[] = [];
  const end = new Date(`${FIXTURE_TODAY}T00:00:00Z`);
  for (let i = 179; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const dow = d.getUTCDay();
    const weekday = dow === 0 || dow === 6 ? 0.62 : 1;
    const noise = 0.75 + rng() * 0.5;
    const clicks = Math.max(0, Math.round((base + trend * (179 - i)) * weekday * noise));
    const position = Math.round((6 + rng() * 6) * 10) / 10;
    const ctr = Math.max(0.01, Math.round((0.3 / position) * 1000) / 1000);
    points.push({
      date: d.toISOString().slice(0, 10),
      clicks,
      impressions: Math.round(clicks / ctr),
      ctr,
      position,
    });
  }
  return points;
}

/** Deterministic top pages for a site, derived from its coverage cells. */
export function sitePages(siteId: string): PageStat[] {
  const world = getWorld();
  const rng = mulberry32(hashSeed(`pages:${siteId}:${FIXTURE_SEED}`));
  const cells = world.coverage.filter(
    (c) => c.siteId === siteId && c.rankingPage && c.impressions28d > 0,
  );
  const pages = cells.map((c) => ({
    url: c.rankingPage!,
    clicks28d: c.clicks28d,
    impressions28d: c.impressions28d,
    ctr: c.impressions28d ? Math.round((c.clicks28d / c.impressions28d) * 1000) / 1000 : 0,
    position: c.medianPosition ?? 0,
    clicksChangePct: Math.round((rng() - 0.4) * 60),
  }));
  const home: PageStat = {
    url: "/",
    clicks28d: Math.round(pages.reduce((s, p) => s + p.clicks28d, 0) * 0.35) + 25,
    impressions28d: Math.round(pages.reduce((s, p) => s + p.impressions28d, 0) * 0.3) + 400,
    ctr: 0.041,
    position: 4.2,
    clicksChangePct: Math.round((rng() - 0.4) * 40),
  };
  // Merge duplicate URLs (several services can rank the same broad page).
  const merged = new Map<string, PageStat>();
  for (const p of [home, ...pages]) {
    const prev = merged.get(p.url);
    if (!prev) merged.set(p.url, { ...p });
    else {
      prev.clicks28d += p.clicks28d;
      prev.impressions28d += p.impressions28d;
      prev.ctr = prev.impressions28d ? Math.round((prev.clicks28d / prev.impressions28d) * 1000) / 1000 : 0;
      prev.position = Math.min(prev.position, p.position);
    }
  }
  return [...merged.values()].sort((a, b) => b.clicks28d - a.clicks28d);
}
