import { describe, it, expect } from "vitest";
import {
  mergeObservations,
  observation,
  statistics,
  type Observation,
} from "./reliability";
import type { Leg } from "./core";
const base: Leg = {
  mode: "BUS",
  duration: 300,
  startTime: "2026-11-10T01:00:00Z",
  endTime: "2026-11-10T01:05:00Z",
  scheduledStartTime: "2026-11-10T01:00:00Z",
  scheduledEndTime: "2026-11-10T01:05:00Z",
  agencyId: "1",
  routeId: "octa-38",
  tripId: "trip",
  routeShortName: "38",
  from: { id: "from", stopId: "from", name: "Board", lat: 33, lon: -118 },
  to: { id: "to", stopId: "to", name: "Exit", lat: 33, lon: -118 },
};
function sample(
  delay: number,
  i = 0,
  source: "gps" | "feed" = "feed",
): Observation {
  return observation(
    { ...base, tripId: `trip-${i}` },
    source,
    "departure",
    new Date(Date.parse(base.startTime) + delay * 1000).toISOString(),
  )!;
}
describe("local reliability", () => {
  it("handles empty data and low sample sizes without flags", () => {
    expect(statistics([])).toMatchObject({
      n: 0,
      flag: "Learning",
      unreliable: false,
    });
    expect(statistics([sample(-200)])).toMatchObject({
      flag: "Learning",
      unreliable: false,
    });
  });
  it("distinguishes early, late, on time and boundary values", () => {
    expect(
      statistics([-61, -60, 0, 300, 301].map((d, i) => sample(d, i))),
    ).toMatchObject({
      n: 5,
      early: 20,
      late: 20,
      onTime: 60,
      median: 0,
      unreliable: true,
    });
    expect(
      statistics(Array.from({ length: 5 }, (_, i) => sample(-120, i))),
    ).toMatchObject({ flag: "Runs early", unreliable: true });
    expect(
      statistics(Array.from({ length: 5 }, (_, i) => sample(600, i))),
    ).toMatchObject({ flag: "Often late", unreliable: true });
    expect(
      statistics(Array.from({ length: 5 }, (_, i) => sample(240, i))),
    ).toMatchObject({ flag: "On time", unreliable: false });
  });
  it("dedupes feed updates and gives GPS precedence for the same trip and stop", () => {
    const items = mergeObservations([sample(0)], [sample(500)]);
    expect(items).toHaveLength(1);
    expect(items[0].delay).toBe(500);
    expect(statistics([...items, sample(-120, 0, "gps")])).toMatchObject({
      n: 1,
      median: -120,
      early: 100,
    });
  });
  it("weights independent GPS samples 3 times a feed sample", () => {
    expect(
      statistics([sample(0, 0), sample(0, 1), sample(600, 2, "gps")]),
    ).toMatchObject({ n: 3, late: 60, onTime: 40, median: 600 });
  });
  it("keeps arrival observations but does not mistake early arrival for early departure", () => {
    const arrival = observation(
      base,
      "gps",
      "arrival",
      "2026-11-10T01:02:00Z",
    )!;
    expect(arrival.delay).toBe(-180);
    expect(statistics([arrival]).n).toBe(0);
    expect(mergeObservations([sample(0)], [arrival])).toHaveLength(2);
  });
  it("rejects missing identities or scheduled times", () => {
    expect(
      observation(
        { ...base, tripId: undefined },
        "gps",
        "departure",
        base.startTime,
      ),
    ).toBeUndefined();
    expect(
      observation(
        { ...base, scheduledStartTime: undefined },
        "feed",
        "departure",
        base.startTime,
      ),
    ).toBeUndefined();
  });
  it("keeps simulations separate in the dedupe store", () => {
    expect(
      mergeObservations([sample(0)], [{ ...sample(0), simulated: true }]),
    ).toHaveLength(2);
  });
});
