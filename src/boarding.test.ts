import { describe, expect, it } from "vitest";
import type { Leg } from "./core";
import {
  initialBoarding,
  simulationTrace,
  updateBoarding,
  type Fix,
} from "./boarding";
const start = Date.parse("2026-11-10T01:00:00Z");
function encode(points: [number, number][]) {
  let lat = 0,
    lon = 0,
    out = "";
  function part(delta: number) {
    let v = delta < 0 ? ~(delta << 1) : delta << 1;
    while (v >= 32) {
      out += String.fromCharCode((32 | (v & 31)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  }
  for (const [x, y] of points) {
    const a = Math.round(y * 1e6),
      b = Math.round(x * 1e6);
    part(a - lat);
    part(b - lon);
    lat = a;
    lon = b;
  }
  return out;
}
export const testLeg: Leg = {
  mode: "BUS",
  duration: 180,
  from: {
    id: "from",
    stopId: "from",
    name: "Board",
    lat: 33.8461,
    lon: -117.9981,
  },
  to: { id: "to", stopId: "to", name: "Exit", lat: 33.8461, lon: -117.9781 },
  agencyId: "1",
  routeId: "octa-38",
  agencyName: "OCTA",
  routeShortName: "38",
  tripId: "trip",
  scheduledStartTime: new Date(start).toISOString(),
  scheduledEndTime: new Date(start + 180000).toISOString(),
  startTime: new Date(start).toISOString(),
  endTime: new Date(start + 180000).toISOString(),
  legGeometry: {
    points: encode([
      [-117.9981, 33.8461],
      [-117.9781, 33.8461],
    ]),
    precision: 6,
  },
};
describe("boarding estimates", () => {
  it("does not board a future itinerary while riding the corridor today", () => {
    let state = initialBoarding();
    for (const fix of simulationTrace(testLeg, -86400))
      state = updateBoarding(state, fix, testLeg);
    expect(state.phase).toBe("waiting");
    expect(state.departure).toBeUndefined();
    expect(state.arrival).toBeUndefined();
  });
  it("rejects excessively early, late, or unscheduled boarding", () => {
    for (const delay of [-1200, 3601]) {
      let state = initialBoarding();
      for (const fix of simulationTrace(testLeg, delay).slice(0, 4))
        state = updateBoarding(state, fix, testLeg);
      expect(state.phase).toBe("waiting");
      expect(state.departure).toBeUndefined();
    }
    let state = initialBoarding();
    for (const fix of simulationTrace(testLeg, 0))
      state = updateBoarding(state, fix, {
        ...testLeg,
        scheduledStartTime: undefined,
      });
    expect(state.phase).toBe("waiting");
    expect(state.departure).toBeUndefined();
  });
  it("permits the early boundary and rejects arrival outside its scheduled window", () => {
    let state = initialBoarding();
    for (const fix of simulationTrace(testLeg, -900))
      state = updateBoarding(state, fix, testLeg);
    expect(state.phase).toBe("alighted");
    expect(state.departure).toBe(start - 900000);
    state = initialBoarding();
    for (const fix of simulationTrace(testLeg, 0).slice(0, 4))
      state = updateBoarding(state, fix, testLeg);
    expect(state.phase).toBe("boarded");
    for (const t of [start + 86400000, start + 86410000])
      state = updateBoarding(
        state,
        { ...testLeg.to, t, accuracy: 5, speed: 0 },
        testLeg,
      );
    expect(state.phase).toBe("boarded");
    expect(state.arrival).toBeUndefined();
    expect(state.stoppedSince).toBeUndefined();
  });
  for (const [label, delay] of [
    ["on time", 0],
    ["late", 240],
    ["early", -120],
  ] as const)
    it(`detects an ${label} ride, retaining actual departure and arrival`, () => {
      let state = initialBoarding();
      const phases = [];
      for (const fix of simulationTrace(testLeg, delay)) {
        state = updateBoarding(state, fix, testLeg);
        phases.push(state.phase);
      }
      expect(phases).toContain("waiting");
      expect(phases).toContain("boarded");
      expect(state.phase).toBe("alighted");
      expect(state.departure).toBe(start + delay * 1000);
      expect(state.arrival).toBe(start + (180 + delay) * 1000);
    });
  it("rejects jitter, inaccurate fixes, stale timestamps and spoofed stationary speed", () => {
    let state = initialBoarding();
    const base: Fix = { ...testLeg.from, t: start, accuracy: 5, speed: 0 };
    state = updateBoarding(state, base, testLeg);
    for (let i = 1; i < 20; i++)
      state = updateBoarding(
        state,
        {
          ...base,
          lat: base.lat + (i % 2) * 0.0001,
          t: start + i * 5000,
          speed: 12,
        },
        testLeg,
      );
    expect(state.phase).toBe("waiting");
    expect(
      updateBoarding(
        state,
        { ...base, lat: 34, t: start + 120000, accuracy: 100 },
        testLeg,
      ),
    ).toBe(state);
    expect(updateBoarding(state, base, testLeg)).toBe(state);
  });
  it("never boards a walking trace even on the route", () => {
    let state = initialBoarding();
    for (let i = 0; i < 80; i++)
      state = updateBoarding(
        state,
        {
          lat: testLeg.from.lat,
          lon: testLeg.from.lon + i * 0.0001,
          t: start + i * 10000,
          accuracy: 5,
          speed: 1,
        },
        testLeg,
      );
    expect(state.phase).toBe("waiting");
    expect(state.departure).toBeUndefined();
  });
  it("requires sustained motion on the selected polyline", () => {
    let state = initialBoarding();
    state = updateBoarding(
      state,
      { ...testLeg.from, t: start, accuracy: 5 },
      testLeg,
    );
    state = updateBoarding(
      state,
      {
        ...testLeg.from,
        lat: testLeg.from.lat + 0.003,
        t: start + 20000,
        accuracy: 5,
        speed: 10,
      },
      testLeg,
    );
    expect(state.phase).toBe("waiting");
    expect(state.movingSince).toBeUndefined();
  });
  it("does not board without geometry and rejects short simulations", () => {
    expect(() =>
      simulationTrace({ ...testLeg, legGeometry: undefined }, 0),
    ).toThrow("450 m");
    let state = initialBoarding();
    for (const fix of simulationTrace(testLeg, 0))
      state = updateBoarding(state, fix, {
        ...testLeg,
        legGeometry: undefined,
      });
    expect(state.phase).not.toBe("boarded");
  });
  it("detects walking off the polyline after boarding", () => {
    let state = initialBoarding();
    for (const fix of simulationTrace(testLeg, 0).slice(0, 4))
      state = updateBoarding(state, fix, testLeg);
    expect(state.phase).toBe("boarded");
    const fix = {
      lat: testLeg.from.lat + 0.002,
      lon: testLeg.from.lon + 0.006,
      t: start + 50000,
      accuracy: 5,
      speed: 1,
    };
    state = updateBoarding(state, fix, testLeg);
    state = updateBoarding(state, { ...fix, t: fix.t + 10000 }, testLeg);
    expect(state.phase).toBe("alighted");
  });
});
