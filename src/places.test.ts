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

async function mod() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ROWS })),
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
