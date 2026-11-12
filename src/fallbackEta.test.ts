import { describe, expect, it } from "vitest";
import { indexDeparture, indexDeparturesNear } from "./fallbackEta";
import { localDay, type ScanIndex } from "./scan";
import type { TripDelays } from "./gtfsrt";
import type { Leg } from "./core";

const TZ = "America/Los_Angeles";
// trip departs stop 0 at local noon; `now` is 5 min before that
const ANCHOR = Date.parse("2026-06-15T17:00:00Z");
const MIDNIGHT = localDay(ANCHOR, TZ).midnightEpoch;
const DEP = MIDNIGHT + 43_200 * 1000;
const NOW = DEP - 5 * 60 * 1000;

const S1 = { i: "s1", n: "Main-1st", la: 33.7, lo: -117.9 };
const S2 = { i: "s2", n: "Main-2nd", la: 33.705, lo: -117.9 };

function idx(extraPattern = false): ScanIndex {
  const patterns = [
    {
      r: "55",
      rid: "55",
      dir: 0,
      h: "Downtown",
      c: "0055ff",
      rt: 3,
      stops: [0, 1],
      trips: [
        { s: 0, i: "gone", t: [100, 200] }, // long departed — filtered out
        { s: 0, i: "t1", t: [43_200, 43_500] },
      ],
    },
  ];
  if (extraPattern)
    // same route + direction serving the same stop, later trip — deduped
    patterns.push({
      ...patterns[0],
      trips: [{ s: 0, i: "t2", t: [45_000, 45_300] }],
    });
  return {
    v: 1,
    feed: { start: "20200101", end: "20300101" },
    bbox: [33.0, -118.5, 34.0, -117.0],
    stops: [S1, S2],
    services: [{ id: "w", d: 0b1111111, s: "20200101", e: "20300101", x: [] }],
    patterns,
    walks: [],
  };
}

const leg = (scheduledStartTime = new Date(DEP).toISOString()): Leg => ({
  mode: "BUS",
  duration: 300,
  routeShortName: "55",
  agencyName: "OCTA",
  scheduledStartTime,
  startTime: scheduledStartTime,
  endTime: new Date(Date.parse(scheduledStartTime) + 300_000).toISOString(),
  from: { lat: 33.7001, lon: -117.9001, name: "a", id: "a" },
  to: { lat: 33.7051, lon: -117.9001, name: "b", id: "b" },
});

const delays = (d: { s1?: { d?: number; t?: number } }): TripDelays =>
  new Map([
    ["t1", new Map(Object.entries(d).filter(([, v]) => v))],
  ]) as TripDelays;

describe("indexDeparture", () => {
  it("returns schedule + feed delay for a matched leg", () => {
    const live = indexDeparture(idx(), leg(), delays({ s1: { d: 120 } }), NOW);
    expect(live).toMatchObject({
      routeName: "55",
      stopName: "Main-1st",
      network: "OCTA",
      realtime: true,
      cancelled: false,
      source: "index",
      delay: 120,
    });
    expect(Date.parse(live!.scheduledTime)).toBe(DEP);
    expect(Date.parse(live!.expectedTime)).toBe(DEP + 120_000);
  });
  it("falls back to schedule when the feed has no update", () => {
    const live = indexDeparture(idx(), leg(), undefined, NOW);
    expect(live).toMatchObject({
      realtime: false,
      delay: 0,
      scheduledTime: new Date(DEP).toISOString(),
      expectedTime: new Date(DEP).toISOString(),
    });
  });
  it("uses absolute feed times when the update carries one", () => {
    const abs = Math.floor(DEP / 1000) + 90;
    const live = indexDeparture(idx(), leg(), delays({ s1: { t: abs } }), NOW);
    expect(live!.delay).toBe(90);
    expect(Date.parse(live!.expectedTime)).toBe(DEP + 90_000);
  });
  it("returns undefined outside index coverage", () => {
    const far = {
      ...leg(),
      from: { lat: 34.5, lon: -118.5, name: "far", id: "far" },
    };
    expect(indexDeparture(idx(), far, undefined, NOW)).toBeUndefined();
  });
});

describe("indexDeparturesNear", () => {
  it("lists the next departure per route+direction at nearby stops", () => {
    const rows = indexDeparturesNear(
      idx(),
      { lat: 33.7, lon: -117.9 },
      undefined,
      NOW,
    );
    expect(rows).toEqual([
      { route: "55", stopName: "Main-1st", time: DEP, realtime: false },
    ]);
  });
  it("applies feed delay and marks realtime", () => {
    const rows = indexDeparturesNear(
      idx(),
      { lat: 33.7, lon: -117.9 },
      delays({ s1: { d: 45 } }),
      NOW,
    );
    expect(rows[0]).toMatchObject({ time: DEP + 45_000, realtime: true });
  });
  it("dedupes same route+direction patterns at a stop", () => {
    const rows = indexDeparturesNear(
      idx(true),
      { lat: 33.7, lon: -117.9 },
      undefined,
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].time).toBe(DEP); // earliest wins
  });
  it("returns [] when no stop is nearby", () => {
    expect(
      indexDeparturesNear(idx(), { lat: 34.5, lon: -118.5 }, undefined, NOW),
    ).toEqual([]);
  });
});
