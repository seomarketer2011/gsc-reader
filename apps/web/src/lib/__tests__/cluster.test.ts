import { describe, expect, it } from "vitest";
import { clusterQueries, locationsFromDomains, normaliseQuery } from "../engine/cluster";

describe("normaliseQuery", () => {
  it("merges word-order and plural variants into one key", () => {
    const variants = [
      "locksmith croydon",
      "croydon locksmith",
      "locksmiths croydon",
      "croydon locksmiths",
      "locksmith in croydon",
      "locksmiths in croydon",
    ];
    const keys = new Set(variants.map((v) => normaliseQuery(v).key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("locksmith [location]");
  });

  it("treats 'near me' as a location", () => {
    expect(normaliseQuery("locksmith near me").key).toBe("locksmith [location]");
  });

  it("recognises postcode districts as locations", () => {
    expect(normaliseQuery("electrician sw6").key).toBe("electrician [location]");
    expect(normaliseQuery("locksmith cr9").key).toBe("locksmith [location]");
  });

  it("keeps meaningfully different intents separate", () => {
    const a = normaliseQuery("emergency locksmith croydon").key;
    const b = normaliseQuery("locksmith croydon").key;
    const c = normaliseQuery("locksmith prices croydon").key;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("handles queries with no location", () => {
    const r = normaliseQuery("how to change a lock");
    expect(r.hadLocation).toBe(false);
    expect(r.key).toBe("change how lock");
  });

  it("is deterministic", () => {
    expect(normaliseQuery("locksmith croydon")).toEqual(normaliseQuery("locksmith croydon"));
  });
});

describe("locationsFromDomains", () => {
  it("extracts town tokens from network domains", () => {
    const locs = locationsFromDomains(["cr9locksmithcroydon.co.uk", "jdselectriciansfulham.co.uk"]);
    expect(locs.has("croydon")).toBe(true);
    expect(locs.has("fulham")).toBe(true);
  });
});

describe("clusterQueries", () => {
  it("aggregates variants with weighted position and picks the top member as name", () => {
    const clusters = clusterQueries([
      { query: "locksmith croydon", clicks: 10, impressions: 800, position: 4 },
      { query: "croydon locksmiths", clicks: 2, impressions: 200, position: 9 },
      { query: "emergency locksmith croydon", clicks: 1, impressions: 100, position: 12 },
    ]);
    expect(clusters).toHaveLength(2);
    const main = clusters[0];
    expect(main.name).toBe("locksmith croydon");
    expect(main.impressions).toBe(1000);
    expect(main.clicks).toBe(12);
    expect(main.position).toBe(5); // (4*800 + 9*200) / 1000
    expect(main.members).toHaveLength(2);
  });
});
