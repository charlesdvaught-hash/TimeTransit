import { describe, expect, it } from "vitest";
import { localDay, type ScanIndex } from "./scan";
import { watchJourney } from "./watchdog";
import type { Leg, Place } from "./core";

// Fixture: R1 0-1-2-3 dep 08:00; R2 3-4-5 dep 08:12 & 08:37; express R3 2-5 dep 08:05.
const S = (la: number, lo = -117) => ({ i: `s${la}`, n: `stop ${la}`, la, lo });
const idx: ScanIndex = {
  v: 1,
  feed: { start: "20260101", end: "20261231" },
  bbox: [32.9, -117.1, 33.1, -116.9],
  stops: [S(33.0), S(33.01), S(33.02), S(33.03), S(33.04), S(33.05)],
  services: [
    { id: "DAILY", d: 0b1111111, s: "20260101", e: "20261231", x: [] },
  ],
  patterns: [
    {
      r: "R1",
      rid: "r1",
      dir: 0,
      h: "",
      c: "",
      rt: 3,
      stops: [0, 1, 2, 3],
      trips: [{ s: 0, i: "R1T1", t: [28800, 28860, 28920, 28980] }],
    },
    {
      r: "R2",
      rid: "r2",
      dir: 0,
      h: "",
      c: "",
      rt: 3,
      stops: [3, 4, 5],
      trips: [
        { s: 0, i: "R2T1", t: [29520, 29640, 29760] },
        { s: 0, i: "R2T2", t: [31020, 31140, 31260] },
      ],
    },
    {
      r: "R3",
      rid: "r3",
      dir: 0,
      h: "",
      c: "",
      rt: 3,
      stops: [2, 5],
      trips: [{ s: 0, i: "R3T1", t: [29100, 29200] }],
    },
  ],
  walks: [],
};
const TZ = "America/Los_Angeles";
const NOW = Date.UTC(2026, 10, 16, 15, 30); // Mon 07:30 PST
const MID = localDay(NOW, TZ).midnightEpoch;
const iso = (sec: number) => new Date(MID + sec * 1000).toISOString();
const bus = (
  from: Place,
  to: Place,
  s: number,
  e: number,
  route: string,
): Leg => ({
  mode: "BUS",
  duration: e - s,
  routeShortName: route,
  agencyName: "TEST",
  scheduledStartTime: iso(s),
  scheduledEndTime: iso(e),
  startTime: iso(s),
  endTime: iso(e),
  from,
  to,
});
const P = (la: number) => ({
  id: `p${la}`,
  lat: la,
  lon: -117,
  name: `stop ${la}`,
});
// plan: ride R1 s0->s3, transfer to R2 s3->s5, arrive 29760
const legs: Leg[] = [
  bus(P(33.0), P(33.03), 28800, 28980, "R1"),
  bus(P(33.03), P(33.05), 29520, 29760, "R2"),
];

describe("watchJourney", () => {
  it("spots a faster option while aboard", () => {
    const r = watchJourney({
      index: idx,
      legs,
      transitIndex: 0,
      phase: "boarded",
      position: { lat: 33.01, lon: -117 },
      now: MID + 28860 * 1000, // just arrived at stop 1
      tz: TZ,
    });
    expect(r?.kind).toBe("better");
    if (r?.kind === "better") {
      expect(r.hint).toContain("33.02"); // hop off at stop 2 for the express
      expect(r.eta).toBe(MID + 29200 * 1000);
      expect(r.savesMin).toBeGreaterThanOrEqual(9);
    }
  });
  it("stays quiet when nothing beats the plan", () => {
    const r = watchJourney({
      index: idx,
      legs: [legs[0]],
      transitIndex: 0,
      phase: "boarded",
      position: { lat: 33.02, lon: -117 },
      now: MID + 28920 * 1000,
      tz: TZ,
    });
    expect(r).toBeNull();
  });
  it("warns when a delay breaks the connection", () => {
    const r = watchJourney({
      index: idx,
      legs,
      transitIndex: 0,
      phase: "boarded",
      position: { lat: 33.02, lon: -117 },
      now: MID + 28920 * 1000,
      tz: TZ,
      delays: new Map([["R1T1", new Map([["s33.03", { d: 600 }]])]]),
    });
    expect(r?.kind).toBe("missed");
    if (r?.kind === "missed") {
      expect(r.hint).toContain("R2");
      expect(r.eta).toBe(MID + 31260 * 1000); // next R2 at stop 5
    }
  });
  it("warns while waiting if the planned bus already left", () => {
    const r = watchJourney({
      index: idx,
      legs,
      transitIndex: 0,
      phase: "waiting",
      position: { lat: 33.0, lon: -117 },
      now: MID + 28860 * 1000, // the 08:00 R1 already departed
      tz: TZ,
    });
    expect(r?.kind).toBe("missed");
  });
});
