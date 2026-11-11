import { describe, expect, it } from "vitest";
import { pinAllows, pinError, pinsHold, scanOrder, type Stop } from "./core";
import type { ScanIndex } from "./scan";

const P = (id: string, la = 33.0) => ({
  id,
  name: id,
  lat: la,
  lon: -117,
});
const ST = (id: string, pin?: Stop["pin"], cands = [P(id)]): Stop => ({
  id,
  label: id,
  candidates: cands,
  dwell: 15,
  pin,
});

describe("pinError", () => {
  it("rejects two firsts, two lasts", () => {
    expect(pinError([ST("a", "first"), ST("b", "first")])).toMatch(/one stop/i);
    expect(pinError([ST("a", "last"), ST("b", "last")])).toMatch(/one stop/i);
  });
  it("rejects all-middle and middle on 2 stops", () => {
    expect(
      pinError([ST("a", "middle"), ST("b", "middle"), ST("c", "middle")]),
    ).toMatch(/unpinned/i);
    expect(pinError([ST("a", "middle"), ST("b")])).toMatch(/3 destinations/i);
  });
  it("accepts sane pins", () => {
    expect(
      pinError([ST("a", "first"), ST("b"), ST("c", "last")]),
    ).toBeUndefined();
  });
});
describe("pinAllows / pinsHold", () => {
  it("positions", () => {
    expect(pinAllows("first", 0, 3)).toBe(true);
    expect(pinAllows("first", 1, 3)).toBe(false);
    expect(pinAllows("last", 2, 3)).toBe(true);
    expect(pinAllows("middle", 0, 3)).toBe(false);
    expect(pinAllows("middle", 1, 3)).toBe(true);
    expect(pinAllows(undefined, 2, 3)).toBe(true);
  });
  it("holds across a whole combo", () => {
    const combo = [ST("a", "first"), ST("b"), ST("c", "last")].map((stop) => ({
      stop,
    }));
    expect(pinsHold(combo, 3)).toBe(true);
    expect(pinsHold([combo[1], combo[0], combo[2]], 3)).toBe(false);
  });
});

// Scan fixture: linear stops s0..s4 ~1.1km apart; one pattern 0-1-2-3-4 with a
// single 08:00 trip (20s/stop). Destinations sit on top of chosen stops.
const index: ScanIndex = {
  v: 1,
  feed: { start: "20260101", end: "20261231" },
  bbox: [32, -118, 34, -116],
  stops: [0, 1, 2, 3, 4].map((k) => ({
    i: `s${k}`,
    n: `stop ${k}`,
    la: 33 + k * 0.01,
    lo: -117,
  })),
  services: [{ id: "D", d: 0b1111111, s: "20260101", e: "20261231", x: [] }],
  patterns: [
    {
      r: "R",
      rid: "r",
      dir: 0,
      h: "",
      c: "",
      rt: 3,
      stops: [0, 1, 2, 3, 4],
      trips: [{ s: 0, t: [28800, 28820, 28840, 28860, 28880] }],
    },
    {
      // reverse direction so out-and-back orders are reachable
      r: "R",
      rid: "r",
      dir: 1,
      h: "",
      c: "",
      rt: 3,
      stops: [4, 3, 2, 1, 0],
      trips: [{ s: 0, t: [29000, 29100, 29200, 29300, 29400] }],
    },
  ],
  walks: [],
};
const AT = Date.UTC(2026, 10, 16, 15, 30); // Mon 07:30 PST
const opt = { walkSpeed: 1.4, maxWalkM: 400, tz: "America/Los_Angeles" };

describe("scanOrder", () => {
  const near = (k: number, name: string): Stop => ({
    id: name,
    label: name,
    candidates: [P(name, 33 + k * 0.01)],
    dwell: 0,
  });
  it("orders destinations along the route naturally", () => {
    const out = scanOrder(
      index,
      P("home"),
      [near(4, "far"), near(1, "close")],
      AT,
      opt,
    );
    expect(out[0].combo.map((v) => v.stop.label)).toEqual(["close", "far"]);
  });
  it("first pin forces the worse-natural stop up front", () => {
    const out = scanOrder(
      index,
      P("home"),
      [near(4, "far"), { ...near(1, "close"), pin: "first" as const }],
      AT,
      opt,
    );
    expect(out[0].combo[0].stop.label).toBe("close");
    const pinnedFar = scanOrder(
      index,
      P("home"),
      [{ ...near(4, "far"), pin: "first" as const }, near(1, "close")],
      AT,
      opt,
    );
    expect(pinnedFar[0].combo[0].stop.label).toBe("far");
  });
  it("last pin defers a stop to the end", () => {
    const out = scanOrder(
      index,
      P("home"),
      [{ ...near(1, "close"), pin: "last" as const }, near(4, "far")],
      AT,
      opt,
    );
    expect(out[0].combo.map((v) => v.stop.label)).toEqual(["far", "close"]);
  });
  it("drops combos that violate pins rather than ranking them", () => {
    const out = scanOrder(
      index,
      P("home"),
      [
        { ...near(1, "a"), pin: "first" as const },
        { ...near(2, "b"), pin: "last" as const },
      ],
      AT,
      opt,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(
      out.every(
        (o) =>
          o.combo[0].stop.label === "a" &&
          o.combo[o.combo.length - 1].stop.label === "b",
      ),
    ).toBe(true);
  });
});
