import { describe, it, expect, vi } from "vitest";
import { searchParams, searchOrigin, plan, search } from "./api";
import { categories, chicago } from "./core";
describe("Photon category queries", () => {
  for (const [label, tag] of Object.entries(categories)) {
    it(`searches ${label} by tag without restricting its name`, () => {
      const params = searchParams(label, chicago);
      expect(params.get("include")).toBe("osm." + tag.replace(":", "."));
      expect(params.has("q")).toBe(false);
      expect(params.get("bbox")).toBeTruthy();
    });
  }
  it("preserves free-text business searches", () => {
    const params = searchParams("Jewel-Osco", chicago);
    expect(params.get("q")).toBe("Jewel-Osco");
    expect(params.has("include")).toBe(false);
  });
});
describe("fuzzy free-text search", () => {
  const feature = (osmId: number, name: string) => ({
    properties: { osm_type: "N", osm_id: osmId, name },
    geometry: { coordinates: [chicago.lon, chicago.lat] },
  });
  it("queries tags AND names, merging and deduplicating results", async () => {
    const urls: string[] = [];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        urls.push(url);
        const features = url.includes("include=osm.shop.supermarket")
          ? [feature(1, "Walmart Supercenter"), feature(2, "Mariano's")]
          : url.includes("include=")
            ? [feature(3, "7-Eleven")]
            : [feature(2, "Mariano's"), feature(4, "Groery Store")];
        return new Response(JSON.stringify({ features }));
      });
    try {
      const places = await search("groery store", chicago);
      const queried = urls.map((u) => new URL(u).searchParams);
      expect(
        queried.filter((p) => p.get("include") === "osm.shop.supermarket"),
      ).toHaveLength(1);
      expect(
        queried.filter((p) => p.get("include") === "osm.shop.convenience"),
      ).toHaveLength(1);
      expect(queried.filter((p) => p.get("q") === "groery store")).toHaveLength(
        1,
      );
      expect(places.map((p) => p.name)).toEqual([
        "Walmart Supercenter",
        "Mariano's",
        "7-Eleven",
        "Groery Store",
      ]);
    } finally {
      spy.mockRestore();
    }
  });
  it("keeps exact category labels tag-only", async () => {
    const urls: string[] = [];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ features: [] }));
      });
    try {
      await search("Coffee", chicago);
      expect(urls).toHaveLength(1);
      const params = new URL(urls[0]).searchParams;
      expect(params.get("include")).toBe("osm.amenity.cafe");
      expect(params.has("q")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
it("resolves a bare ZIP with US bias, without a local bounding box", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        features: [
          {
            properties: {
              osm_value: "postcode",
              name: "90620",
              city: "Buena Park",
              countrycode: "US",
            },
            geometry: { coordinates: [-118.0125, 33.842] },
          },
          {
            properties: {
              osm_value: "street",
              name: "Alley 90620",
              countrycode: "US",
            },
            geometry: { coordinates: [-118.4, 34.2] },
          },
        ],
      }),
    ),
  );
  try {
    const places = await searchOrigin("90620", chicago);
    expect(places).toHaveLength(1);
    expect(places[0].name).toContain("Buena Park");
    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe("90620 United States");
    expect(url.searchParams.has("bbox")).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
it("surfaces an empty origin search", async () => {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ features: [] })));
  try {
    await expect(searchOrigin("unknown-empty-origin", chicago)).rejects.toThrow(
      "No matching origin",
    );
  } finally {
    spy.mockRestore();
  }
});
it("sends walking budgets and collects agencies from every plan alternative", async () => {
  const leg = {
    mode: "BUS",
    agencyName: "Metro - Los Angeles",
    duration: 60,
    startTime: "2026-11-10T01:00:00Z",
    endTime: "2026-11-10T01:01:00Z",
  };
  const itinerary = {
    duration: 60,
    startTime: leg.startTime,
    endTime: leg.endTime,
    legs: [leg],
  };
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        itineraries: [
          itinerary,
          {
            ...itinerary,
            duration: 120,
            legs: [
              {
                ...leg,
                agencyName: "Orange County Transportation Authority",
              },
            ],
          },
        ],
      }),
    ),
  );
  const agencies = vi.fn();
  try {
    await plan(
      chicago,
      { ...chicago, lat: 41.9 },
      new Date("2026-11-10T01:00:00Z"),
      undefined,
      { walkDistance: 400, walkingSpeed: 1.4 },
      agencies,
    );
    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v2/plan");
    expect(url.searchParams.get("maxPreTransitTime")).toBe("285");
    expect(agencies).toHaveBeenCalledWith([
      "Metro - Los Angeles",
      "Orange County Transportation Authority",
    ]);
  } finally {
    spy.mockRestore();
  }
});
