import { describe, expect, it } from "vitest";
import { resolveLocation, UkLocationIndex } from "../engine/serp";

// A slice of the real DataForSEO GB list, keeping the shapes that matter:
// a country, postcode districts, a borough only listed under its formal
// name, a royal borough, and two names that cover more than one place.
const NAMES = [
  "United Kingdom",
  "BR1,England,United Kingdom",
  "E13,England,United Kingdom",
  "Croydon,England,United Kingdom",
  "London Borough of Lewisham,England,United Kingdom",
  "Royal Borough of Kensington and Chelsea,England,United Kingdom",
  "Richmond,England,United Kingdom",
  "Richmond,Greater London,England,United Kingdom",
];

const index: UkLocationIndex = (() => {
  const byName = new Map<string, string>();
  const byTown = new Map<string, string[]>();
  for (const name of NAMES) {
    byName.set(name.toLowerCase(), name);
    const town = name.split(",")[0].trim().toLowerCase();
    const list = byTown.get(town);
    if (list) list.push(name);
    else byTown.set(town, [name]);
  }
  return { byName, byTown };
})();

describe("resolveLocation", () => {
  it("accepts an exact location name and returns its canonical spelling", () => {
    expect(resolveLocation(index, "br1,england,united kingdom")).toMatchObject({
      name: "BR1,England,United Kingdom",
      valid: true,
    });
  });

  it("resolves a bare name that is unambiguous", () => {
    expect(resolveLocation(index, "E13")).toMatchObject({
      name: "E13,England,United Kingdom",
      valid: true,
    });
  });

  it("finds boroughs listed only under their formal name", () => {
    expect(resolveLocation(index, "Lewisham").name).toBe(
      "London Borough of Lewisham,England,United Kingdom",
    );
    expect(resolveLocation(index, "Kensington and Chelsea").name).toBe(
      "Royal Borough of Kensington and Chelsea,England,United Kingdom",
    );
  });

  it("rescues a name given with the wrong region suffix", () => {
    // "Lewisham,England,United Kingdom" is not a location DataForSEO knows,
    // but the place is unambiguous, so the check still runs from Lewisham.
    expect(resolveLocation(index, "Lewisham,England,United Kingdom")).toMatchObject({
      name: "London Borough of Lewisham,England,United Kingdom",
      valid: true,
    });
  });

  it("refuses to guess between places that share a name", () => {
    const r = resolveLocation(index, "Richmond");
    expect(r.valid).toBe(false);
    expect(r.name).toBe("Richmond"); // unchanged, so the UI can show what needs fixing
    expect(r.alternatives).toEqual([
      "Richmond,England,United Kingdom",
      "Richmond,Greater London,England,United Kingdom",
    ]);
  });

  it("spelling out an ambiguous name resolves it", () => {
    expect(resolveLocation(index, "Richmond,Greater London,England,United Kingdom").valid).toBe(
      true,
    );
  });

  it("marks places DataForSEO has no entry for as invalid", () => {
    // Bickley is a real town with no location of its own — it has to be
    // searched from its postcode district instead.
    expect(resolveLocation(index, "Bickley,England,United Kingdom")).toMatchObject({
      valid: false,
      alternatives: [],
    });
  });

  it("leaves everything unchecked when the location list is unavailable", () => {
    // Never block an import because DataForSEO was briefly unreachable.
    expect(resolveLocation(null, "Bickley")).toEqual({
      name: "Bickley",
      valid: null,
      alternatives: [],
    });
  });
});
