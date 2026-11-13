import { afterEach, describe, expect, it, vi } from "vitest";
import type { Place } from "./core";
import type { ScanIndex } from "./scan";
import { nameMatch, verifySuggestion, discoverPlaces } from "./discovery";
import { routeCorridors, validateSuggest } from "./semantic";

const origin: Place = {
  id: "o",
  name: "Home",
  lat: 33.78,
  lon: -117.86,
};

const feature = (name: string, lat: number, lon: number) => ({
  properties: {
    osm_type: "N",
    osm_id: 1,
    name,
    city: "Los Angeles",
  },
  geometry: { coordinates: [lon, lat] },
});

afterEach(() => vi.unstubAllGlobals());

describe("nameMatch", () => {
  it("accepts same-name results with extra suffixes", () => {
    expect(nameMatch("Angels Flight", "Angels Flight Railway")).toBe(true);
    expect(nameMatch("The Lab Anti-Mall", "Lab Anti Mall")).toBe(true);
    expect(nameMatch("Wurstküche", "Wurstkuche")).toBe(true); // accent-folded
  });
  it("rejects unrelated names", () => {
    expect(nameMatch("Angels Flight", "Starbucks")).toBe(false);
    expect(nameMatch("Wurstküche", "Kuche Bar")).toBe(false);
  });
});

describe("validateSuggest", () => {
  it("keeps valid suggestions, drops malformed entries, caps at 6", () => {
    const out = validateSuggest({
      suggestions: [
        { name: "Angels Flight", area: "DTLA" },
        { name: "  " },
        "oops",
        { name: "x".repeat(120) },
        { name: "Museum of Jurassic Technology", area: 5 },
        { name: "1" },
        { name: "2" },
        { name: "3" },
        { name: "4" },
        { name: "5" },
        { name: "6" },
        { name: "7" },
      ],
    });
    expect(out.map((s) => s.name)).toEqual([
      "Angels Flight",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(out[0].area).toBe("DTLA");
  });
  it("returns [] on non-object input", () => {
    expect(validateSuggest(null)).toEqual([]);
    expect(validateSuggest({})).toEqual([]);
    expect(validateSuggest({ suggestions: "nope" })).toEqual([]);
  });
});

describe("routeCorridors", () => {
  const index: ScanIndex = {
    v: 1,
    feed: { start: "2026-01-01", end: "2027-01-01" },
    bbox: [-118, 33.7, -117.7, 33.9],
    stops: [
      { i: "s1", n: "Harbor & 1st", la: 33.78, lo: -117.86 },
      { i: "s2", n: "Far Away", la: 34.3, lo: -118.3 },
    ],
    services: [],
    patterns: [
      {
        r: "43",
        rid: "43-1",
        dir: 0,
        h: "Fullerton",
        c: "",
        rt: 3,
        stops: [0],
        trips: [],
      },
      {
        r: "43",
        rid: "43-1",
        dir: 1,
        h: "Costa Mesa",
        c: "",
        rt: 3,
        stops: [0],
        trips: [],
      },
      {
        r: "55",
        rid: "55-1",
        dir: 0,
        h: "Santa Ana",
        c: "",
        rt: 3,
        stops: [1],
        trips: [],
      },
    ],
    walks: [],
  };
  it("lists deduped walk-distance corridors, nearest first", () => {
    const cs = routeCorridors(index, origin);
    expect(cs).toHaveLength(2); // both 43 directions, 55 too far
    expect(cs.map((c) => c.r)).toEqual(["43", "43"]);
    expect(new Set(cs.map((c) => c.h)).size).toBe(2);
  });
  it("returns [] when nothing is in walking range", () => {
    expect(
      routeCorridors(index, { ...origin, lat: 34.5, lon: -118.5 }),
    ).toEqual([]);
  });
});

describe("verifySuggestion", () => {
  it("accepts a geocoded name match within range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          features: [feature("Angels Flight Railway", 34.05, -118.25)],
        }),
      ),
    );
    const p = await verifySuggestion(
      { name: "Angels Flight", area: "DTLA" },
      origin,
    );
    expect(p?.name).toBe("Angels Flight Railway");
    expect(p?.lat).toBeCloseTo(34.05);
  });
  it("drops suggestions Photon can't match (hallucination gate)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ features: [feature("Starbucks", 33.8, -117.9)] }),
      ),
    );
    expect(
      await verifySuggestion({ name: "Made Up Museum" }, origin),
    ).toBeNull();
  });
  it("drops matches outside the range cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ features: [feature("Angels Flight", 37.8, -122.4)] }),
      ),
    );
    expect(
      await verifySuggestion({ name: "Angels Flight" }, origin, undefined, 120),
    ).toBeNull();
  });
});

describe("discoverPlaces", () => {
  it("returns [] when the relay isn't configured (dev proxy)", async () => {
    expect(await discoverPlaces("quiet coffee", "ctx", origin)).toEqual([]);
  });
});
