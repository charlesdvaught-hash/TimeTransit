import { afterEach, describe, it, expect, vi } from "vitest";
import {
  normalizeName,
  nearestStop,
  pickDeparture,
  stopDepartures,
  transferViolations,
  type LiveDeparture,
} from "./transit";
import type { Leg, TripChain } from "./core";
const leg: Leg = {
  mode: "BUS",
  duration: 300,
  startTime: "2026-11-10T15:00:00Z",
  endTime: "2026-11-10T15:10:00Z",
  scheduledStartTime: "2026-11-10T15:00:00Z",
  routeShortName: "38",
  headsign: "Lakewood",
  from: { id: "from", stopId: "s1", name: "Board", lat: 33, lon: -118 },
  to: { id: "to", stopId: "s2", name: "Exit", lat: 33.01, lon: -118 },
};
const item = (scheduled: number, overrides: Record<string, unknown> = {}) => ({
  scheduled_departure_time: scheduled,
  departure_time: scheduled + 240,
  is_real_time: true,
  is_cancelled: false,
  ...overrides,
});
const route = (
  name: string,
  items: ReturnType<typeof item>[],
  headsign = "",
) => ({
  route_short_name: name,
  merged_itineraries: [
    {
      headsign,
      schedule_items: items,
    },
  ],
});
const target = Date.parse(leg.scheduledStartTime!) / 1000;
describe("transit api matching", () => {
  it("normalizes route names for comparison", () => {
    expect(normalizeName(" 38-A ")).toBe("38a");
    expect(normalizeName("Metro A Line")).toBe("metroaline");
    expect(normalizeName(undefined)).toBe("");
  });
  it("picks the departure closest to the scheduled leg time", () => {
    const routes = [
      route("55", [item(target)]),
      route("38", [item(target - 3600), item(target + 30)]),
    ];
    const match = pickDeparture(routes, leg)!;
    expect(match.route.route_short_name).toBe("38");
    expect(match.item.scheduled_departure_time).toBe(target + 30);
  });
  it("matches routes via display short name when GTFS short name differs", () => {
    const routes = [
      {
        route_short_name: undefined,
        route_display_short_name: { elements: [null, "38", null] },
        merged_itineraries: [{ schedule_items: [item(target)] }],
      },
    ];
    expect(pickDeparture(routes as any, leg)!.item).toBeDefined();
  });
  it("prefers itineraries matching the leg headsign", () => {
    const routes = [
      {
        route_short_name: "38",
        merged_itineraries: [
          { headsign: "Rancho", schedule_items: [item(target)] },
          { headsign: "Lakewood Blvd", schedule_items: [item(target + 120)] },
        ],
      },
    ];
    const match = pickDeparture(routes, leg)!;
    expect(match.item.scheduled_departure_time).toBe(target + 120);
  });
  it("rejects departures outside the tolerance window", () => {
    const routes = [route("38", [item(target + 3600)])];
    expect(pickDeparture(routes, leg)).toBeUndefined();
  });
  it("falls back to the only route serving the stop when names do not match", () => {
    const routes = [route("999", [item(target)])];
    expect(
      pickDeparture(routes, { ...leg, routeShortName: "38" }),
    ).toBeDefined();
    const ambiguous = [
      route("999", [item(target)]),
      route("998", [item(target)]),
    ];
    expect(
      pickDeparture(ambiguous, { ...leg, routeShortName: "38", headsign: "" }),
    ).toBeUndefined();
  });
  it("uses startTime when no scheduled time is present", () => {
    const unscheduled = { ...leg, scheduledStartTime: undefined };
    const routes = [route("38", [item(target + 60)])];
    expect(pickDeparture(routes, unscheduled)).toBeDefined();
  });
  it("finds the nearest stop within the radius only", () => {
    const stops = [
      {
        global_stop_id: "a",
        stop_name: "Far",
        stop_lat: 33.01,
        stop_lon: -118,
        distance: 900,
      },
      {
        global_stop_id: "b",
        stop_name: "Near",
        stop_lat: 33,
        stop_lon: -118,
        distance: 40,
      },
      {
        global_stop_id: "c",
        stop_name: "Edge",
        stop_lat: 33,
        stop_lon: -118,
        distance: 149,
      },
    ];
    expect(nearestStop(stops, { lat: 33, lon: -118 })!.global_stop_id).toBe(
      "b",
    );
    expect(nearestStop([stops[0]], { lat: 33, lon: -118 })).toBeUndefined();
  });
  it("computes distance when the API omits it", () => {
    const stops = [
      {
        global_stop_id: "a",
        stop_name: "Close",
        stop_lat: 33.0005,
        stop_lon: -118,
      },
    ];
    expect(nearestStop(stops, { lat: 33, lon: -118 })!.global_stop_id).toBe(
      "a",
    );
  });
});
// STAGE-3
describe("stopDepartures batching", () => {
  afterEach(() => vi.restoreAllMocks());
  it("sends one batched request with deduped ids capped at 100", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ route_departures: [] })),
      );
    const ids = Array.from({ length: 140 }, (_, i) => `NET:${i % 120}`);
    expect(await stopDepartures(ids, 1762807200)).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    const url = spy.mock.calls[0][0] as string;
    const sent = url
      .split("global_stop_ids=")[1]
      .split("&")[0]
      .split(",")
      .map(decodeURIComponent);
    expect(sent.length).toBe(100);
    expect(new Set(sent).size).toBe(sent.length);
    expect(url).toContain("time=1762807200");
  });
  it("does not request when there are no stop ids", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await stopDepartures([], 1762807200)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
describe("transferViolations", () => {
  const walkLeg = (end: string): Leg => ({
    mode: "WALK",
    duration: 60,
    startTime: "2026-11-10T14:58:00Z",
    endTime: end,
    from: { id: "o", name: "Origin", lat: 33, lon: -118 },
    to: { id: "f", name: "Board", lat: 33, lon: -118 },
  });
  const busLeg = (start: string): Leg => ({
    mode: "BUS",
    duration: 300,
    tripId: "t1",
    routeShortName: "43",
    startTime: start,
    endTime: "2026-11-10T15:10:00Z",
    from: { id: "f", name: "Board", lat: 33, lon: -118 },
    to: { id: "t", name: "Exit", lat: 33.01, lon: -118 },
  });
  const chain = (visits: Leg[][]): TripChain => ({
    visits: visits.map((legs, i) => ({
      stop: { id: `seg-${i}`, label: `Stop ${i}`, candidates: [], dwell: 15 },
      place: { id: `p${i}`, name: `Stop ${i}`, lat: 33, lon: -118 },
      trip: {
        duration: 360,
        startTime: legs[0].startTime,
        endTime: legs[legs.length - 1].endTime,
        transfers: 1,
        legs,
      },
    })),
    duration: 1800,
  });
  const live = (expectedTime: string, cancelled = false): LiveDeparture => ({
    routeName: "43",
    stopName: "Board",
    scheduledTime: "2026-11-10T15:00:00Z",
    expectedTime,
    delay: 0,
    realtime: true,
    cancelled,
  });
  it("flags a live departure that leaves before the rider arrives", () => {
    const out = transferViolations(
      chain([
        [walkLeg("2026-11-10T14:59:00Z"), busLeg("2026-11-10T15:00:00Z")],
        [walkLeg("2026-11-10T16:00:00Z"), busLeg("2026-11-10T16:05:00Z")],
      ]),
      [live("2026-11-10T14:55:00Z"), live("2026-11-10T16:10:00Z")],
    );
    expect(out).toEqual([{ visit: 0, leg: 1, missedBy: 240 }]);
  });
  it("flags cancelled departures even when the plan is on time", () => {
    const out = transferViolations(
      chain([
        [walkLeg("2026-11-10T14:59:00Z"), busLeg("2026-11-10T15:00:00Z")],
      ]),
      [live("2026-11-10T15:00:00Z", true)],
    );
    expect(out).toEqual([{ visit: 0, leg: 1, missedBy: 0, cancelled: true }]);
  });
});
