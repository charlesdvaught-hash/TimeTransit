import { describe, it, expect } from "vitest";
import {
  chicago,
  distance,
  fastest,
  rank,
  decode,
  combinations,
  optimize,
  type Place,
  type Itinerary,
  type Stop,
} from "./core";
const place = (id: string, lat: number): Place => ({
  id,
  name: id,
  lat,
  lon: chicago.lon,
});
const itinerary = (
  duration: number,
  start = new Date("2026-11-09T15:00:00Z"),
): Itinerary => ({
  duration,
  startTime: start.toISOString(),
  endTime: new Date(+start + duration * 1000).toISOString(),
  transfers: 0,
  legs: [],
});
describe("routing primitives", () => {
  it("measures kilometers and zero distance", () => {
    expect(distance(chicago, chicago)).toBe(0);
    expect(distance(place("a", 41), place("b", 42))).toBeCloseTo(111.195, 2);
  });
  it("includes a faster direct walk", () =>
    expect(
      fastest({ itineraries: [itinerary(900)], direct: [itinerary(400)] })
        .duration,
    ).toBe(400));
  it("reports missing routes", () =>
    expect(() => fastest({})).toThrow("No route"));
  it("includes initial waiting from the requested departure", () => {
    const departure = new Date("2026-11-09T15:00:00Z");
    const transit = itinerary(300, new Date(+departure + 900000));
    const walk = itinerary(800, departure);
    expect(
      fastest({ itineraries: [transit], direct: [walk] }, departure).duration,
    ).toBe(800);
    expect(fastest({ itineraries: [transit] }, departure).duration).toBe(1200);
  });
  it("ranks by time rather than distance, without mutating input", () => {
    const a = {
        place: chicago,
        trip: itinerary(800),
        distance: 1,
        distanceRank: 1,
      },
      b = { ...a, trip: itinerary(400), distance: 2, distanceRank: 2 };
    const input = [a, b];
    expect(rank(input)).toEqual([b, a]);
    expect(input[0]).toBe(a);
    expect(rank([])).toEqual([]);
  });
  it("decodes geometry with supplied precision", () => {
    expect(decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
    expect(decode("_p~iF~ps|U", 7)[0]).toEqual([-1.202, 0.385]);
    expect(decode("", 7)).toEqual([]);
  });
});
describe("trip optimizer", () => {
  const stops: Stop[] = [
    {
      id: "a",
      label: "A",
      dwell: 15,
      candidates: [place("a", 41.89), place("a2", 41.9)],
    },
    { id: "b", label: "B", dwell: 5, candidates: [place("b", 41.91)] },
  ];
  it("enumerates orders and candidate choices", () => {
    expect(combinations(stops)).toHaveLength(4);
    expect(combinations([])).toEqual([[]]);
  });
  it("reserves specific places and keeps a fallback after the best any candidate is excluded", async () => {
    const shared = place("cafecito", 41.89);
    const fallback = place("another-cafe", 41.9);
    const grocery = place("grocery", 41.91);
    const scenario: Stop[] = [
      {
        id: "coffee",
        label: "Coffee",
        dwell: 15,
        candidates: [shared, fallback],
      },
      {
        id: "specific",
        label: "Cafecito",
        dwell: 15,
        candidates: [{ ...shared }],
      },
      { id: "grocery", label: "Grocery", dwell: 15, candidates: [grocery] },
    ];
    const choices = combinations(scenario);
    expect(choices).toHaveLength(6);
    for (const choice of choices) {
      expect(new Set(choice.map((v) => v.place.id)).size).toBe(3);
      expect(choice.find((v) => v.stop.id === "coffee")?.place.id).toBe(
        fallback.id,
      );
    }
    const trip = await optimize(
      chicago,
      scenario,
      new Date("2026-11-09T15:00:00Z"),
      true,
      async (_a, _b, t) => itinerary(60, t),
    );
    expect(new Set(trip.visits.map((v) => v.place.id)).size).toBe(3);
    expect(trip.visits.find((v) => v.stop.id === "coffee")?.place).toBe(
      fallback,
    );
  });
  it("excludes earlier any choices before applying the candidate cap", () => {
    const candidates = [
      place("a", 41.89),
      place("b", 41.9),
      place("c", 41.91),
      place("fallback", 41.92),
    ];
    const scenario = Array.from({ length: 4 }, (_, i) => ({
      id: String(i),
      label: "Any",
      dwell: 0,
      candidates,
    }));
    const choices = combinations(scenario);
    expect(choices.length).toBeGreaterThan(0);
    expect(
      choices.every(
        (choice) => new Set(choice.map((v) => v.place.id)).size === 4,
      ),
    ).toBe(true);
    expect(choices.some((choice) => choice[3].place.id === "fallback")).toBe(
      true,
    );
  });
  it("reports impossible distinct assignments without making route requests", async () => {
    let calls = 0;
    const shared = place("same", 41.89);
    await expect(
      optimize(
        chicago,
        stops.map((s) => ({ ...s, candidates: [shared] })),
        new Date(),
        false,
        async () => {
          calls++;
          return itinerary(60);
        },
      ),
    ).rejects.toThrow("distinct places");
    expect(calls).toBe(0);
  });
  it("chains actual arrivals plus dwell, and returns to origin", async () => {
    const calls: { a: Place; b: Place; t: Date }[] = [];
    const start = new Date("2026-11-09T15:00:00Z");
    const result = await optimize(
      chicago,
      stops,
      start,
      true,
      async (a, b, t) => {
        calls.push({ a, b, t });
        return itinerary(600, t);
      },
    );
    expect(result.duration).toBe(3000);
    expect(result.visits).toHaveLength(2);
    expect(result.returnTrip).toBeDefined();
    expect(+calls[1].t - +calls[0].t).toBe(1500000);
    expect(calls[2].b).toBe(chicago);
  });
  it("rejects empty and invalid inputs", async () => {
    await expect(
      optimize(chicago, [], new Date(), false, async () => itinerary(1)),
    ).rejects.toThrow("2–4");
    await expect(
      optimize(
        chicago,
        [{ ...stops[0], candidates: [] }, stops[1]],
        new Date(),
        false,
        async () => itinerary(1),
      ),
    ).rejects.toThrow("candidate");
  });
  it("surfaces API errors when every combination fails", async () => {
    await expect(
      optimize(chicago, stops, new Date(), false, async () => {
        throw new Error("Service down");
      }),
    ).rejects.toThrow("Service down");
  });
  it("continues after a failed combination", async () => {
    let calls = 0;
    const result = await optimize(
      chicago,
      stops,
      new Date("2026-11-09T15:00:00Z"),
      false,
      async (_a, _b, t) => {
        if (++calls === 1) throw new Error("No route");
        return itinerary(60, t);
      },
    );
    expect(result.duration).toBe(1320);
  });
});
