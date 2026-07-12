// Deterministic query clustering (Phase 5, docs/DATA_MODEL.md).
// "locksmith croydon", "croydon locksmiths" and "locksmiths in croydon" all
// normalise to the same cluster key: "locksmith [location]". No LLM involved.

const STOPWORDS = new Set(["in", "the", "a", "an", "for", "of", "and", "to", "my", "me", "near", "best", "local"]);

// UK towns/areas seen across the network's markets. Extended at call time
// with tokens derived from the organisation's own tracked domains.
const KNOWN_LOCATIONS = new Set([
  "croydon", "bromley", "orpington", "sutton", "kingston", "richmond", "wimbledon",
  "lewisham", "greenwich", "woolwich", "bexley", "bexleyheath", "dartford", "romford",
  "ilford", "barking", "enfield", "barnet", "harrow", "ealing", "hounslow", "uxbridge",
  "wembley", "camden", "islington", "hackney", "stratford", "walthamstow", "tottenham",
  "finchley", "hampstead", "fulham", "chelsea", "battersea", "clapham", "brixton",
  "peckham", "dulwich", "beckenham", "chislehurst", "sidcup", "welling", "belvedere",
  "crayford", "purley", "kenley", "coulsdon", "mitcham", "norbury", "addiscombe",
  "beddington", "guildford", "woking", "reigate", "crawley", "brighton", "eastbourne",
  "hastings", "maidstone", "canterbury", "ashford", "sevenoaks", "gravesend", "chatham",
  "basildon", "chelmsford", "southend", "colchester", "watford", "luton", "stevenage",
  "reading", "slough", "oxford", "portsmouth", "southampton", "winchester", "basingstoke",
  "london", "surrey", "kent", "essex", "sussex", "hayes", "plaistow", "bickley",
  "sundridge", "pettswood", "locksbottom", "eltham", "catford", "penge", "sydenham",
  "thamesmead", "erith", "swanley", "biggin", "hill", "westerham", "keston", "downe",
]);

// UK postcode district: sw6, cr9, br1, da15, e1, ec2a …
const POSTCODE = /^[a-z]{1,2}[0-9]{1,2}[a-z]?$/;

function singular(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export interface NormalisedQuery {
  key: string; // cluster key, e.g. "emergency locksmith [location]"
  hadLocation: boolean;
}

export function normaliseQuery(query: string, extraLocations?: Set<string>): NormalisedQuery {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let hadLocation = false;
  const kept: string[] = [];
  for (const raw of tokens) {
    if (STOPWORDS.has(raw)) {
      if (raw === "me" || raw === "near") hadLocation = true; // "near me"
      continue;
    }
    if (KNOWN_LOCATIONS.has(raw) || extraLocations?.has(raw) || POSTCODE.test(raw)) {
      hadLocation = true;
      continue;
    }
    kept.push(singular(raw));
  }
  kept.sort();
  const base = kept.join(" ") || query.toLowerCase().trim();
  return { key: hadLocation ? `${base} [location]` : base, hadLocation };
}

/** Location tokens implied by the org's own domains (cr9locksmithcroydon → croydon). */
export function locationsFromDomains(domains: string[]): Set<string> {
  const out = new Set<string>();
  for (const domain of domains) {
    const stem = domain.toLowerCase().replace(/\.(co\.uk|com|uk|net|org)$/g, "");
    for (const loc of KNOWN_LOCATIONS) {
      if (stem.includes(loc)) out.add(loc);
    }
  }
  return out;
}

export interface ClusterMember {
  query: string;
  clicks: number;
  impressions: number;
  position: number; // impression-weighted average
}

export interface QueryClusterAgg {
  key: string;
  name: string; // highest-impression member query
  members: ClusterMember[];
  clicks: number;
  impressions: number;
  position: number; // impression-weighted across members
}

export function clusterQueries(
  members: ClusterMember[],
  extraLocations?: Set<string>,
): QueryClusterAgg[] {
  const map = new Map<string, QueryClusterAgg>();
  for (const m of members) {
    const { key } = normaliseQuery(m.query, extraLocations);
    const cluster = map.get(key) ?? { key, name: m.query, members: [], clicks: 0, impressions: 0, position: 0 };
    cluster.members.push(m);
    cluster.clicks += m.clicks;
    cluster.impressions += m.impressions;
    map.set(key, cluster);
  }
  for (const c of map.values()) {
    c.members.sort((a, b) => b.impressions - a.impressions);
    c.name = c.members[0].query;
    const weight = c.members.reduce((s, m) => s + m.impressions, 0) || 1;
    c.position = Math.round((c.members.reduce((s, m) => s + m.position * m.impressions, 0) / weight) * 10) / 10;
  }
  return [...map.values()].sort((a, b) => b.impressions - a.impressions);
}
