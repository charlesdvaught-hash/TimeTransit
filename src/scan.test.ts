import { describe, expect, it } from "vitest";
import {
  arrivalAtPoint,
  inCoverage,
  localDay,
  scan,
  type ScanIndex,
} from "./scan";

// Tiny fixture: stops 0..6 spaced ~1.1km apart (0.01 lat each at lat 33),
// beyond the 800m origin-walk reach so only stop 0 is seeded.
// P1 "R1": 0-1-2-3, trips at 08:00 and 09:00.
// P2 "R2": 3-4-5, trip leaving 3 at 08:12.
// Walk link 1<->4 (300m) as an alternative transfer.
const S = (la: number, lo = -117) => ({ i: `s${la}`, n: `stop ${la}`, la, lo });
const base: ScanIndex = {
  v: 1,
  feed: { start: "20260101", end: "20261231" },
  bbox: [32.9, -117.1, 33.1, -116.9],
  stops: [S(33.0), S(33.01), S(33.02), S(33.03), S(33.04), S(33.05), S(33.09)],
  services: [
    { id: "DAILY", d: 0b1111111, s: "20260101", e: "20261231", x: [] },
    { id: "WKD", d: 0b0011111, s: "20260101", e: "20261231", x: [] },
  ],
  patterns: [
    {
      r: "R1",
      rid: "r1",
      dir: 0,
      h: "downtown",
      c: "",
      rt: 3,
      stops: [0, 1, 2, 3],
      trips: [
        { s: 0, t: [28800, 28860, 28920, 28980] },
        { s: 0, t: [32400, 32460, 32520, 32580] },
      ],
    },
    {
      r: "R2",
      rid: "r2",
      dir: 0,
      h: "uptown",
      c: "",
      rt: 3,
      stops: [3, 4, 5],
      trips: [{ s: 0, t: [29520, 29640, 29760] }],
    },
    {
      // overnight route: departs 25:10 service-day = next local day 01:10
      r: "N1",
      rid: "n1",
      dir: 0,
      h: "owl",
      c: "",
      rt: 3,
      stops: [0, 6],
      trips: [{ s: 1, t: [90600, 90900] }],
    },
  ],
  walks: [
    [1, 4, 300],
    [4, 1, 300],
  ],
};
const TZ = "America/Los_Angeles";
// LA epoch helpers: 2026-11-16 is a Monday.
const LA_MON_0730 = Date.UTC(2026, 10, 16, 15, 30); // 07:30 PST
const LA_TUE_0050 = Date.UTC(2026, 10, 17, 8, 50); // 00:50 PST Tuesday
const LA_SAT_0730 = Date.UTC(2026, 10, 21, 15, 30); // Saturday
const ORIGIN = { lat: 33.0, lon: -117 }; // on top of stop 0

describe("scan", () => {
  it("rides a direct pattern to a downstream stop", () => {
    const r = scan(base, ORIGIN, LA_MON_0730, { tz: TZ });
    const { midnightEpoch } = localDay(LA_MON_0730, TZ);
    expect(r.get(3)).toBe(midnightEpoch + 28980 * 1000);
  });
  it("transfers between patterns at a shared stop", () => {
    const r = scan(base, ORIGIN, LA_MON_0730, { tz: TZ });
    const { midnightEpoch } = localDay(LA_MON_0730, TZ);
    expect(r.get(5)).toBe(midnightEpoch + 29760 * 1000);
  });
  it("uses walk links as a transfer path", () => {
    const idx: ScanIndex = {
      ...base,
      patterns: [
        base.patterns[0],
        {
          ...base.patterns[1],
          stops: [4, 5],
          trips: [{ s: 0, t: [29200, 29300] }],
        },
      ],
    };
    const r = scan(idx, ORIGIN, LA_MON_0730, { tz: TZ });
    const { midnightEpoch } = localDay(LA_MON_0730, TZ);
    // arrive stop 1 at 28860, walk 300m / 1.33m/s, board at 4 by 29200
    expect(r.get(5)).toBe(midnightEpoch + 29300 * 1000);
  });
  it("catches overnight trips from the previous service day", () => {
    // WKD service runs Mon-Fri; Monday night's 25:10 trip lands 01:10 Tuesday
    const r = scan(base, ORIGIN, LA_TUE_0050, { tz: TZ });
    const tueMidnight = localDay(LA_TUE_0050, TZ).midnightEpoch;
    expect(r.get(6)).toBe(tueMidnight - 86400 * 1000 + 90900 * 1000);
  });
  it("does not run weekday trips on Saturday", () => {
    const r = scan(base, ORIGIN, LA_SAT_0730, { tz: TZ });
    expect(r.get(6)).toBeUndefined();
  });
  it("honors calendar exception removals", () => {
    const idx: ScanIndex = {
      ...base,
      services: [
        { ...base.services[0], x: [["20261116", 2]] },
        base.services[1],
      ],
    };
    const r = scan(idx, ORIGIN, LA_MON_0730, { tz: TZ });
    expect(r.get(3)).toBeUndefined();
  });
  it("honors calendar exception additions", () => {
    const idx: ScanIndex = {
      ...base,
      services: [
        { ...base.services[1], x: [["20261121", 1]] },
        { ...base.services[1], x: [["20261121", 1]] },
      ],
    };
    const r = scan(idx, ORIGIN, LA_SAT_0730, { tz: TZ });
    expect(r.get(6)).toBeDefined();
  });
  it("leaves unreachable stops unreachable", () => {
    const idx: ScanIndex = { ...base, patterns: [base.patterns[0]], walks: [] };
    const r = scan(idx, { lat: 33.0, lon: -117 }, LA_MON_0730, { tz: TZ });
    expect(r.get(5)).toBeUndefined();
  });
  it("respects the boarding-round cap", () => {
    const r = scan(base, ORIGIN, LA_MON_0730, { tz: TZ, rounds: 1 });
    expect(r.get(3)).toBeDefined();
    expect(r.get(5)).toBeUndefined(); // needs a second boarding
  });
});

describe("arrivalAtPoint", () => {
  it("adds a walk-off leg to the best reached stop", () => {
    const r = scan(base, ORIGIN, LA_MON_0730, { tz: TZ });
    const at = arrivalAtPoint(base, r, { lat: 33.0505, lon: -117 }, 1.33, 800);
    const { midnightEpoch } = localDay(LA_MON_0730, TZ);
    expect(at).toBeGreaterThan(midnightEpoch + 29760 * 1000);
  });
  it("returns undefined when nothing reachable is near", () => {
    const r = scan(base, ORIGIN, LA_MON_0730, { tz: TZ });
    expect(
      arrivalAtPoint(base, r, { lat: 34.0, lon: -118 }, 1.33, 800),
    ).toBeUndefined();
  });
});

describe("inCoverage", () => {
  it("bbox contains test area, excludes elsewhere", () => {
    expect(inCoverage(base, { lat: 33.0, lon: -117 })).toBe(true);
    expect(inCoverage(base, { lat: 34.1, lon: -118.3 })).toBe(false);
  });
});
