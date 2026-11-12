import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "./core";

const origin: Place = { id: "o", name: "Origin", lat: 33.7, lon: -117.9 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
// fresh module per test — eventsEnabled is module state
async function load() {
  vi.resetModules();
  return await import("./events");
}

beforeEach(() => {
  vi.stubEnv("VITE_TRANSIT_RELAY", "https://relay.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchEvents", () => {
  it("passes origin, window and query, and returns the merged list", async () => {
    const { searchEvents } = await load();
    const event = {
      id: "e1",
      title: "Jazz in the Park",
      venue: "Hart Park",
      lat: 33.75,
      lon: -117.85,
      start: "2026-11-13T19:00",
      source: "seatgeek",
    };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ events: [event], sources: ["seatgeek"] }));
    const out = await searchEvents(origin, {
      start: "2026-11-13T00:00",
      end: "2026-11-14T00:00",
      query: "jazz",
    });
    expect(out).toEqual([event]);
    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://relay.test/events");
    expect(url.searchParams.get("lat")).toBe("33.7");
    expect(url.searchParams.get("lon")).toBe("-117.9");
    expect(url.searchParams.get("start")).toBe("2026-11-13T00:00");
    expect(url.searchParams.get("end")).toBe("2026-11-14T00:00");
    expect(url.searchParams.get("q")).toBe("jazz");
  });

  it("returns [] without a relay and never fetches", async () => {
    vi.stubEnv("VITE_TRANSIT_RELAY", "");
    const { searchEvents } = await load();
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await searchEvents(origin)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps working after a 4xx but disables for the session on a 5xx", async () => {
    const { searchEvents } = await load();
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockResolvedValueOnce(json({}, 429));
    expect(await searchEvents(origin)).toEqual([]);
    spy.mockResolvedValueOnce(json({ events: [] }));
    expect(await searchEvents(origin)).toEqual([]);
    spy.mockResolvedValueOnce(json({}, 500));
    expect(await searchEvents(origin)).toEqual([]);
    expect(await searchEvents(origin)).toEqual([]); // disabled — no fetch
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("returns [] on network errors and malformed bodies", async () => {
    const { searchEvents } = await load();
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockRejectedValueOnce(new Error("offline"));
    expect(await searchEvents(origin)).toEqual([]);
    spy.mockResolvedValueOnce(json({}));
    expect(await searchEvents(origin)).toEqual([]);
  });
});

describe("eventFromLink", () => {
  const event = {
    id: "eb-1994271930027",
    title: "Powwow 2026",
    venue: "Heritage Museum of OC",
    lat: 33.72,
    lon: -117.91,
    start: "2026-11-14T18:00:00Z",
    source: "eventbrite",
  };

  it("resolves an eventbrite link in free text", async () => {
    const { eventFromLink } = await load();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ event }));
    const out = await eventFromLink(
      "see https://www.eventbrite.com/e/powwow-2026-tickets-1994271930027 then tacos",
    );
    expect(out?.event).toEqual(event);
    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://relay.test/eb/event");
    expect(url.searchParams.get("id")).toBe("1994271930027");
  });

  it("detects other Eventbrite TLDs", async () => {
    const { eventFromLink } = await load();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ event }));
    const out = await eventFromLink(
      "https://www.eventbrite.ca/e/craft-night-tickets-2004407608113",
    );
    expect(out?.event.id).toBe("eb-1994271930027");
    expect(out?.link).toContain("eventbrite.ca");
  });

  it("returns undefined with no link and never fetches", async () => {
    const { eventFromLink } = await load();
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await eventFromLink("lunch then a museum")).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns undefined on relay errors", async () => {
    const { eventFromLink } = await load();
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockResolvedValueOnce(json({ error: "not found" }, 404));
    expect(
      await eventFromLink("eventbrite.com/e/x-tickets-123456789"),
    ).toBeUndefined();
    spy.mockRejectedValueOnce(new Error("offline"));
    expect(
      await eventFromLink("eventbrite.com/e/x-tickets-123456789"),
    ).toBeUndefined();
  });
});
