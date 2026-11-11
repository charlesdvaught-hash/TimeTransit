import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "./core";

const origin: Place = { id: "o", name: "Origin", lat: 33.7, lon: -117.9 };
const place: Place = {
  id: "osm-1",
  name: "Taco Mesa",
  lat: 33.71,
  lon: -117.91,
  address: "123 Main St",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  return store;
}
// fresh module per test — gmapsEnabled and both caches are module state
async function load() {
  vi.resetModules();
  return await import("./gmaps");
}

beforeEach(() => {
  vi.stubEnv("VITE_TRANSIT_RELAY", "https://relay.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("placeIdFor", () => {
  it("takes the first id, hits the biased text route, and persists it", async () => {
    const store = stubStorage();
    const g = await load();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ places: [{ id: "g1" }, { id: "g2" }] }));
    expect(await g.placeIdFor(place, origin)).toBe("g1");
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/gmaps/text?query=Taco%20Mesa%2C%20123%20Main%20St");
    expect(url).toContain("lat=33.7&lon=-117.9");
    expect(JSON.parse(store.get("timetransit.gmaps-ids")!)).toEqual({
      "osm-1": "g1",
    });
    expect(await g.placeIdFor(place, origin)).toBe("g1");
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("stays silent without a relay and never fetches", async () => {
    vi.stubEnv("VITE_TRANSIT_RELAY", "");
    const g = await load();
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await g.placeIdFor(place, origin)).toBeUndefined();
    expect(await g.detailsFor("g1")).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
  it("returns undefined when Google finds no place", async () => {
    const g = await load();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ places: [] }));
    expect(await g.placeIdFor(place, origin)).toBeUndefined();
  });
});

describe("detailsFor", () => {
  it("maps rating, count, price and openNow", async () => {
    const g = await load();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        rating: 4.6,
        userRatingCount: 1234,
        priceLevel: "PRICE_LEVEL_EXPENSIVE",
        currentOpeningHours: { openNow: true },
      }),
    );
    expect(await g.detailsFor("g1")).toEqual({
      rating: 4.6,
      userRatingCount: 1234,
      priceLevel: 3,
      openNow: true,
    });
  });
  it("accepts snake_case and numeric price levels", async () => {
    const g = await load();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        rating: 4,
        price_level: 1,
        current_opening_hours: { open_now: false },
      }),
    );
    expect(await g.detailsFor("g2")).toEqual({
      rating: 4,
      priceLevel: 1,
      openNow: false,
    });
  });
  it("serves repeat lookups from the session cache", async () => {
    const g = await load();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ rating: 4.1 }));
    expect(await g.detailsFor("g3")).toEqual({ rating: 4.1 });
    expect(await g.detailsFor("g3")).toEqual({ rating: 4.1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("silent failure", () => {
  it("flips gmapsEnabled off on 500 and stops calling", async () => {
    const g = await load();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ error: "no key" }, 500));
    expect(await g.placeIdFor(place, origin)).toBeUndefined();
    expect(g.gmapsEnabled).toBe(false);
    expect(await g.detailsFor("g1")).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("returns undefined on other errors and rejections", async () => {
    const g = await load();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ error: "quota" }, 429));
    expect(await g.placeIdFor(place, origin)).toBeUndefined();
    expect(g.gmapsEnabled).toBe(true);
    spy.mockReset().mockRejectedValue(new TypeError("offline"));
    expect(await g.detailsFor("g4")).toBeUndefined();
  });
});

describe("enrichPlace", () => {
  it("chains text search to details", async () => {
    const g = await load();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ places: [{ id: "g9" }] }))
      .mockResolvedValueOnce(
        json({ rating: 4.2, currentOpeningHours: { openNow: false } }),
      );
    expect(await g.enrichPlace(place, origin)).toEqual({
      rating: 4.2,
      openNow: false,
    });
    expect(String(spy.mock.calls[1][0])).toContain(
      "/gmaps/details?place_id=g9",
    );
  });
});

describe("detailSummary", () => {
  it("formats the compact line", async () => {
    const g = await load();
    expect(
      g.detailSummary({
        rating: 4.6,
        userRatingCount: 1200,
        priceLevel: 2,
        openNow: true,
      }),
    ).toBe("★ 4.6 (1.2k) · $$ · Open now");
    expect(g.detailSummary({ priceLevel: 0, openNow: false })).toBe(
      "Free · Closed",
    );
    expect(g.detailSummary({})).toBe("");
  });
});
