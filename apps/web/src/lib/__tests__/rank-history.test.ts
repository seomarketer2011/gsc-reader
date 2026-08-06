import { describe, expect, it } from "vitest";
import {
  bestOf,
  movement,
  positionsOn,
  RankingRow,
  series,
  successfulCheckDates,
} from "../engine/rank-history";

const rank = (
  keyword_id: string,
  check_date: string,
  domain: string,
  position: number,
): RankingRow => ({ keyword_id, check_date, domain, position, url: `https://${domain}/` });

describe("successfulCheckDates", () => {
  it("orders dates newest first and drops failed checks", () => {
    const dates = successfulCheckDates([
      { keyword_id: "k1", check_date: "2026-08-01", error: null },
      { keyword_id: "k1", check_date: "2026-08-06", error: null },
      { keyword_id: "k1", check_date: "2026-08-04", error: "DataForSEO task 40501" },
      { keyword_id: "k1", check_date: "2026-08-03", error: null },
      { keyword_id: "k2", check_date: "2026-08-06", error: null },
    ]);
    expect(dates.get("k1")).toEqual(["2026-08-06", "2026-08-03", "2026-08-01"]);
    expect(dates.get("k2")).toEqual(["2026-08-06"]);
  });

  it("gives a keyword whose only check failed no history at all", () => {
    const dates = successfulCheckDates([
      { keyword_id: "k1", check_date: "2026-08-06", error: "boom" },
    ]);
    expect(dates.has("k1")).toBe(false);
  });
});

describe("positionsOn", () => {
  const rows = [
    rank("k1", "2026-08-06", "a.co.uk", 4),
    rank("k1", "2026-08-06", "b.co.uk", 9),
    rank("k1", "2026-08-06", "other.co.uk", 2),
    rank("k1", "2026-08-03", "a.co.uk", 11),
  ];
  const mine = (d: string) => d !== "other.co.uk";

  it("keeps only the requested date and the watched domains", () => {
    const now = positionsOn(rows, "2026-08-06", mine);
    expect([...now.keys()].sort()).toEqual(["a.co.uk", "b.co.uk"]);
    expect(now.get("a.co.uk")).toEqual({ position: 4, url: "https://a.co.uk/" });
  });

  it("is empty when there is no date to read", () => {
    expect(positionsOn(rows, undefined, mine).size).toBe(0);
  });
});

describe("movement", () => {
  const now = new Map([
    ["up.co.uk", { position: 4, url: "https://up.co.uk/" }],
    ["down.co.uk", { position: 30, url: "https://down.co.uk/" }],
    ["same.co.uk", { position: 7, url: "https://same.co.uk/" }],
    ["fresh.co.uk", { position: 12, url: "https://fresh.co.uk/" }],
  ]);
  const before = new Map([
    ["up.co.uk", 11],
    ["down.co.uk", 18],
    ["same.co.uk", 7],
    ["gone.co.uk", 42],
  ]);

  it("classifies each domain against the previous check", () => {
    const byDomain = new Map(movement(now, before).map((m) => [m.domain, m]));
    expect(byDomain.get("up.co.uk")).toMatchObject({ state: "improved", change: 7, previous: 11 });
    expect(byDomain.get("down.co.uk")).toMatchObject({ state: "declined", change: -12 });
    expect(byDomain.get("same.co.uk")).toMatchObject({ state: "held", change: 0 });
    expect(byDomain.get("fresh.co.uk")).toMatchObject({ state: "new", change: null, previous: null });
  });

  it("surfaces a domain that dropped out of the top 100", () => {
    const gone = movement(now, before).find((m) => m.domain === "gone.co.uk");
    expect(gone).toMatchObject({ state: "lost", position: null, previous: 42, change: null });
  });

  it("orders by current position, dropped-out domains last", () => {
    expect(movement(now, before).map((m) => m.domain)).toEqual([
      "up.co.uk",
      "same.co.uk",
      "fresh.co.uk",
      "down.co.uk",
      "gone.co.uk",
    ]);
  });

  it("reports no movement at all on a first check", () => {
    const first = movement(now, null);
    expect(first).toHaveLength(4);
    expect(first.every((m) => m.state === "first" && m.change === null)).toBe(true);
  });
});

describe("bestOf", () => {
  const movements = movement(
    new Map([
      ["home.co.uk", { position: 8, url: "" }],
      ["rival.co.uk", { position: 2, url: "" }],
    ]),
    new Map([
      ["home.co.uk", 12],
      ["sister.co.uk", 30],
    ]),
  );

  it("picks the best-placed of the given domains, ignoring the rest", () => {
    expect(bestOf(movements, new Set(["home.co.uk"]))).toMatchObject({
      domain: "home.co.uk",
      position: 8,
      change: 4,
    });
  });

  it("falls back to a domain that dropped out, so the loss is still shown", () => {
    expect(bestOf(movements, new Set(["sister.co.uk"]))).toMatchObject({
      domain: "sister.co.uk",
      state: "lost",
      previous: 30,
    });
  });

  it("returns null when none of the domains feature in either check", () => {
    expect(bestOf(movements, new Set(["absent.co.uk"]))).toBeNull();
  });
});

describe("series", () => {
  const rows = [
    rank("k1", "2026-08-06", "a.co.uk", 4),
    rank("k1", "2026-08-03", "a.co.uk", 11),
    rank("k1", "2026-08-03", "b.co.uk", 5),
  ];

  it("returns one point per requested date, in the order given", () => {
    expect(series(rows, ["2026-08-06", "2026-08-03", "2026-08-01"], "a.co.uk")).toEqual([
      { date: "2026-08-06", position: 4 },
      { date: "2026-08-03", position: 11 },
      { date: "2026-08-01", position: null },
    ]);
  });

  it("marks a date the domain was checked on but absent from as null", () => {
    expect(series(rows, ["2026-08-06"], "b.co.uk")).toEqual([
      { date: "2026-08-06", position: null },
    ]);
  });
});
