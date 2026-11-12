import { afterEach, describe, expect, it, vi } from "vitest";

const ROWS = [
  {
    n: "Partners Federal Credit Union",
    a: "100 S Anaheim Blvd",
    la: 33.835,
    lo: -117.913,
  },
  {
    n: "Partners Federal Credit Union",
    a: "2401 E Katella Ave",
    la: 33.806,
    lo: -117.883,
  },
  { n: "Financial Partners Credit Union", la: 33.9, lo: -117.9 },
  { n: "Unrelated Tire Shop", la: 33.8, lo: -117.9 },
];
const ORIGIN = { lat: 33.8366, lon: -117.9143 };

async function mod(rows = ROWS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => rows })),
  );
  vi.resetModules();
  const m = await import("./places");
  await m.loadPlaces();
  return m;
}

afterEach(() => vi.unstubAllGlobals());

describe("searchPlaces", () => {
  it("finds POIs absent from providers", async () => {
    const { searchPlaces } = await mod();
    const hits = searchPlaces("partners credit union", ORIGIN);
    expect(hits[0]?.name).toBe("Partners Federal Credit Union");
    expect(hits[0]?.lat).toBeCloseTo(33.835);
  });
  it("ranks by name then distance and skips non-matches", async () => {
    const { searchPlaces } = await mod();
    const hits = searchPlaces("partners", ORIGIN);
    expect(hits.every((h) => h.name.includes("Partners"))).toBe(true);
    expect(hits[0]?.name).toBe("Partners Federal Credit Union");
    expect(hits.map((h) => h.name)).not.toContain("Unrelated Tire Shop");
  });
  it("returns [] before the index loads", async () => {
    vi.resetModules();
    const { searchPlaces } = await import("./places");
    expect(searchPlaces("partners", ORIGIN)).toEqual([]);
  });
});

// STAGE-4
const CORRIDOR = [
  { n: "Verified Cafe", k: "coffee shop", la: 33.836, lo: -117.914, c: 9 },
  { n: "Shaky Cafe", k: "coffee shop", la: 33.8365, lo: -117.9145, c: 4 },
  { n: "Coffee Corner", la: 33.837, lo: -117.9138 }, // name match, no c/k
  { n: "Far Coffee", k: "coffee shop", la: 33.95, lo: -117.8, c: 9 },
  { n: "Corner Tire", k: "tire shop", la: 33.8362, lo: -117.9142, c: 9 },
  { n: "Wobbly Mart", k: "convenience store", la: 33.8363, lo: -117.9143 },
];
const STOP = { lat: 33.8361, lon: -117.9141 };

describe("placesInCorridor", () => {
  it("keeps kind-matched places within the stop radius, nearest first", async () => {
    const { placesInCorridor } = await mod(CORRIDOR);
    const hits = placesInCorridor(["coffee"], [STOP], { radiusM: 500 });
    expect(hits.map((h) => h.name)).toEqual([
      "Verified Cafe",
      "Shaky Cafe",
      "Coffee Corner",
    ]);
    expect(hits[0]?.confidence).toBe(1);
  });
  it("treats the origin as a corridor anchor when stops are empty", async () => {
    const { placesInCorridor } = await mod(CORRIDOR);
    const hits = placesInCorridor(["coffee"], [], {
      radiusM: 500,
      origin: { lat: 33.8364, lon: -117.9142 },
    });
    expect(hits.map((h) => h.name)).toContain("Verified Cafe");
    expect(hits.map((h) => h.name)).not.toContain("Far Coffee");
  });
  it("verifiedOnly keeps only high-confidence rows", async () => {
    const { placesInCorridor } = await mod(CORRIDOR);
    const hits = placesInCorridor(["coffee"], [STOP], {
      radiusM: 500,
      verifiedOnly: true,
    });
    expect(hits.map((h) => h.name)).toEqual(["Verified Cafe"]);
  });
  it("falls back to the unfiltered pool when no row carries confidence", async () => {
    const { placesInCorridor } = await mod(CORRIDOR);
    const hits = placesInCorridor(["convenience"], [STOP], {
      radiusM: 500,
      verifiedOnly: true,
    });
    expect(hits.map((h) => h.name)).toEqual(["Wobbly Mart"]);
  });
  it("returns [] before the index loads", async () => {
    vi.resetModules();
    const { placesInCorridor } = await import("./places");
    expect(placesInCorridor(["coffee"], [STOP], { radiusM: 500 })).toEqual([]);
  });
});

// WAVE-2: boarded-ride "Near your stop" filter
describe("ridePoiKind", () => {
  it("keeps food/coffee/grocery/pharmacy kinds", async () => {
    const { ridePoiKind } = await mod();
    for (const k of [
      "coffee shop",
      "mexican restaurant",
      "grocery store",
      "pharmacy",
      "farmers market",
      "sports bar",
      "drugstore",
    ])
      expect(ridePoiKind(k)).toBe(true);
  });
  it("rejects look-alike kinds", async () => {
    const { ridePoiKind } = await mod();
    for (const k of ["marketing agency", "barber", "tire shop"])
      expect(ridePoiKind(k)).toBe(false);
    expect(ridePoiKind(undefined)).toBe(false);
  });
});

describe("placesNear", () => {
  it("returns kind-matched places inside the radius, nearest first", async () => {
    const { placesNear } = await mod(CORRIDOR);
    expect(placesNear(STOP, { radiusM: 250 }).map((h) => h.name)).toEqual([
      "Verified Cafe",
      "Wobbly Mart",
      "Shaky Cafe",
    ]);
  });
  it("honors a custom matcher and limit", async () => {
    const { placesNear } = await mod(CORRIDOR);
    const hits = placesNear(STOP, {
      radiusM: 500,
      match: (k) => k.includes("tire"),
    });
    expect(hits.map((h) => h.name)).toEqual(["Corner Tire"]);
  });
  it("returns [] before the index loads", async () => {
    vi.resetModules();
    const { placesNear } = await import("./places");
    expect(placesNear(STOP)).toEqual([]);
  });
});
