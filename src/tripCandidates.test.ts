import { describe, expect, it, vi } from "vitest";
import { departureSnapshot, resolveTripCandidates } from "./tripCandidates";
import { chicago, type Itinerary, type Place, type Stop } from "./core";

const place = (id: string): Place => ({ ...chicago, id, name: id });
const trip = (duration: number): Itinerary => ({
  duration,
  startTime: "2026-11-09T15:00:00Z",
  endTime: "2026-11-09T15:01:00Z",
  transfers: 0,
  legs: [],
});
const stop: Stop = { id: "coffee", label: "Coffee", candidates: [], dwell: 15 };
describe("candidate preparation", () => {
  it("skips failed routes, keeps fallbacks, ranks survivors and reserves specific places", async () => {
    const find = vi.fn(async () => [
      place("fixed"),
      place("bad"),
      place("slow"),
      place("fast"),
    ]);
    const route = vi.fn(async (p: Place) => {
      if (p.id === "bad") throw new Error("No route");
      return trip(p.id === "fast" ? 60 : 120);
    });
    const fixed = { ...stop, id: "fixed", candidates: [place("fixed")] };
    const resolved = await resolveTripCandidates([stop, fixed], find, route);
    expect(resolved[0].candidates.map((p) => p.id)).toEqual(["fast", "slow"]);
    expect(resolved[1]).toBe(fixed);
    expect(route.mock.calls.map(([p]) => p.id)).not.toContain("fixed");
  });
  it("reports the stop and service error if every candidate fails", async () => {
    await expect(
      resolveTripCandidates(
        [stop],
        async () => [place("bad")],
        async () => {
          throw new Error("No route");
        },
      ),
    ).rejects.toThrow("No routable candidates for “Coffee”. No route");
  });
  it("reports empty searches and handles an empty stop list", async () => {
    await expect(
      resolveTripCandidates(
        [stop],
        async () => [],
        async () => trip(60),
      ),
    ).rejects.toThrow("No routable candidates");
    expect(
      await resolveTripCandidates(
        [],
        async () => [],
        async () => trip(60),
      ),
    ).toEqual([]);
  });
  it("keeps unrouted candidates as alternates without paying plan calls", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p-${i}`);
    const find = vi.fn(async () => ids.map(place));
    const route = vi.fn(async () => trip(60));
    const [resolved] = await resolveTripCandidates([stop], find, route);
    expect(route).toHaveBeenCalledTimes(6); // only the routed cap
    expect(resolved.candidates).toHaveLength(6);
    expect(resolved.alternates?.map((p) => p.id)).toEqual(ids.slice(6));
    expect(resolved.pool).toBe(12);
  });
  it("propagates abort errors rather than treating them as failed candidates", async () => {
    const error = new DOMException("Cancelled", "AbortError");
    const route = vi.fn(async () => {
      throw error;
    });
    await expect(
      resolveTripCandidates(
        [stop],
        async () => [place("a"), place("b")],
        route,
      ),
    ).rejects.toBe(error);
    // candidates time in parallel — both calls launch before either rejects
    expect(route).toHaveBeenCalledTimes(2);
  });
  it("propagates an aborted signal even if the router returns an ordinary error", async () => {
    const controller = new AbortController();
    await expect(
      resolveTripCandidates(
        [stop],
        async () => [place("a")],
        async () => {
          controller.abort();
          throw new Error("Failed");
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
describe("departure snapshot", () => {
  it("captures now once and accepts a scheduled departure", () => {
    const now = new Date("2026-11-09T15:00:00Z");
    expect(departureSnapshot("", now)).toBe(now);
    expect(departureSnapshot("2026-11-10T16:00:00Z", now).toISOString()).toBe(
      "2026-11-10T16:00:00.000Z",
    );
  });
});
