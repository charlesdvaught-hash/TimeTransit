import { describe, it, expect, vi } from "vitest";
import { searchParams, searchOrigin, plan } from "./api";
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
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
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
