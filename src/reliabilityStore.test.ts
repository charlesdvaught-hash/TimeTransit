import { afterEach, expect, it, vi } from "vitest";
import type { Itinerary, Leg } from "./core";
import { logFeed, clearReliability, addObservations } from "./reliabilityStore";
import { observation } from "./reliability";
afterEach(() => vi.unstubAllGlobals());
it("persists realtime departures, dedupes updates, skips missing metadata, and clears data", () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  clearReliability();
  const leg: Leg = {
    mode: "BUS",
    duration: 60,
    agencyId: "1",
    routeId: "OCTA-38",
    tripId: "trip",
    realTime: true,
    startTime: "2026-11-10T01:04:00Z",
    scheduledStartTime: "2026-11-10T01:00:00Z",
    endTime: "2026-11-10T01:05:00Z",
    from: { id: "board", stopId: "board", name: "Board", lat: 33, lon: -118 },
    to: { id: "exit", stopId: "exit", name: "Exit", lat: 33, lon: -118 },
  };
  const trips = [
    {
      legs: [
        leg,
        { ...leg, tripId: "missing-schedule", scheduledStartTime: undefined },
        { ...leg, tripId: "non-realtime", realTime: false },
      ],
    },
  ] as Itinerary[];
  logFeed(trips);
  logFeed(trips);
  const read = () => JSON.parse(saved.get("timetransit.reliability.v2")!);
  expect(read()).toHaveLength(1);
  expect(read()[0]).toMatchObject({
    source: "feed",
    delay: 240,
    simulated: false,
  });
  addObservations([
    observation(leg, "gps", "departure", "2026-11-10T01:02:00Z"),
  ]);
  expect(read()).toHaveLength(2);
  clearReliability();
  expect(read()).toEqual([]);
});
it.each([
  ["timetransit.reliability", "2026-11-09", 1],
  ["timetransit.reliability.v2", undefined, 1],
  ["timetransit.reliability.v2", "2026-11-09", 2],
])(
  "loads only dated v2 observations: %s, %s",
  async (key, serviceDate, count) => {
    const record = {
      routeKey: "route",
      routeName: "38",
      agency: "OCTA",
      color: "00aff2",
      stopId: "stop",
      stopName: "Board",
      tripId: "trip",
      scheduledTime: "2026-11-10T01:00:00Z",
      actualTime: "2026-11-10T01:00:00Z",
      serviceDate: "2026-11-09",
      delay: 0,
      source: "feed" as const,
      event: "departure" as const,
      timestamp: 1,
      simulated: false,
    };
    const saved = new Map([
      [key, JSON.stringify([{ ...record, serviceDate }])],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) || null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
    vi.resetModules();
    const store = await import("./reliabilityStore");
    store.addObservations([{ ...record, tripId: "new-trip" }]);
    const loaded = JSON.parse(saved.get("timetransit.reliability.v2")!);
    expect(loaded).toHaveLength(count);
    expect(
      loaded.every(
        (o: { serviceDate?: string }) => o.serviceDate === "2026-11-09",
      ),
    ).toBe(true);
  },
);
