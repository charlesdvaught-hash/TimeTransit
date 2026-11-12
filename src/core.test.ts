import { describe, it, expect } from "vitest";
import {
  chicago,
  distance,
  fastest,
  itineraries,
  suggestCategories,
  rank,
  decode,
  combinations,
  optimize,
  optimizeKeystones,
  keystoneIndex,
  editDistance,
  matchCategory,
  rankByReachability,
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
describe("category suggestions", () => {
  it("maps typed fragments to place types", () => {
    expect(suggestCategories("cof")).toContain("Coffee");
    expect(suggestCategories("groceries")).toContain("Grocery");
    expect(suggestCategories("urgent")).toContain("Hospital/Clinic");
    expect(suggestCategories("zzz")).toEqual([]);
  });
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
  it("keeps alternatives sorted by time", () =>
    expect(
      itineraries({ itineraries: [itinerary(900), itinerary(400)] }).map(
        (t) => t.duration,
      ),
    ).toEqual([400, 900]));
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
describe("fuzzy category matching", () => {
  it("measures edit distance for typo tolerance", () => {
    expect(editDistance("groery", "grocery")).toBe(1);
    expect(editDistance("pharmacy", "pharmacy")).toBe(0);
    expect(editDistance("walmart", "market")).toBeGreaterThan(2);
  });
  it("resolves typos and natural phrasing to OSM tags", () => {
    expect(matchCategory("groery store")).toEqual([
      "shop:supermarket",
      "shop:convenience",
    ]);
    expect(matchCategory("grocery store")).toEqual([
      "shop:supermarket",
      "shop:convenience",
    ]);
    expect(matchCategory("urgent care")).toEqual(["amenity:clinic"]);
    expect(matchCategory("pharmcy")).toEqual(["amenity:pharmacy"]);
  });
  it("keeps exact category labels on their existing tag", () => {
    expect(matchCategory("Grocery")).toEqual(["shop:supermarket"]);
    expect(matchCategory("Coffee")).toEqual(["amenity:cafe"]);
  });
  it("leaves brand names and noise to text search", () => {
    expect(matchCategory("Walmart")).toEqual([]);
    expect(matchCategory("Jewel-Osco")).toEqual([]);
    expect(matchCategory("bank of america")).toEqual([]);
    expect(matchCategory("")).toEqual([]);
    expect(matchCategory("store")).toEqual([]);
  });
  it("rejects queries with conflicting category intents", () => {
    expect(matchCategory("coffee grocery")).toEqual([]);
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
it("prefers a farther place served by a reachable stop over a nearer unserved one", () => {
  const near = {
    ...chicago,
    id: "near",
    name: "Near",
    lat: chicago.lat + 0.02,
  };
  const far = { ...chicago, id: "far", name: "Far", lat: chicago.lat + 0.05 };
  const ranked = rankByReachability(
    chicago,
    [near, far],
    [{ lat: far.lat, lon: far.lon, minutes: 8 }],
    1.4,
  );
  expect(ranked.map((p) => p.id)).toEqual(["far", "near"]);
  expect(rankByReachability(chicago, [near, far], [], 1.4)[0].id).toBe("near");
});
// STAGE-4: verifiedOnly penalizes low-confidence places without excluding them
it("penalizes low-confidence places when verifiedOnly is on", () => {
  const weak = {
    ...chicago,
    id: "weak",
    name: "Weak",
    lat: chicago.lat + 0.025,
    confidence: 0.5,
  };
  const solid = {
    ...chicago,
    id: "solid",
    name: "Solid",
    lat: chicago.lat + 0.03,
    confidence: 1,
  };
  expect(rankByReachability(chicago, [weak, solid], [], 1.4)[0].id).toBe(
    "weak",
  );
  expect(
    rankByReachability(chicago, [weak, solid], [], 1.4, {
      verifiedOnly: true,
    })[0].id,
  ).toBe("solid");
  // unknown confidence is never penalized — old indexes carry no c
  const mystery = {
    ...chicago,
    id: "mystery",
    name: "Mystery",
    lat: chicago.lat + 0.01,
  };
  expect(
    rankByReachability(chicago, [mystery, solid], [], 1.4, {
      verifiedOnly: true,
    })[0].id,
  ).toBe("mystery");
});

describe("keystone routes", () => {
  const m1 = place("museum-a", 41.9);
  const m2 = place("museum-b", 41.95);
  const lunches = [
    place("lunch-1", 41.91),
    place("lunch-2", 41.92),
    place("lunch-3", 41.93),
  ];
  const stops: Stop[] = [
    { id: "s-lunch", label: "Lunch", dwell: 30, candidates: lunches },
    { id: "s-museum", label: "Museum", dwell: 60, candidates: [m1, m2] },
  ];
  it("anchors on the rarest stop — fewest candidates wins", () => {
    expect(keystoneIndex(stops)).toBe(1);
    expect(keystoneIndex([stops[1], stops[0]])).toBe(0); // keystone travels with its stop
  });
  it("raw pool size beats the capped candidate count", () => {
    // resolution caps every stop at 6 routable candidates — the pre-cap
    // pool is what reveals "craft store (12 hits) rarer than lunch (50)"
    const tied: Stop[] = [
      { ...stops[0], candidates: lunches.slice(0, 2), pool: 50 },
      { ...stops[1], pool: 12 },
    ];
    expect(keystoneIndex(tied)).toBe(1);
  });
  it("returns one route per keystone pick, best duration first", async () => {
    const routes = await optimizeKeystones(
      chicago,
      stops,
      new Date("2026-11-09T15:00:00Z"),
      false,
      async (_a, b, t) => itinerary(b === m1 ? 300 : 900, t),
    );
    expect(routes).toHaveLength(2);
    expect(routes[0].keystone.place).toBe(m1); // shorter leg wins
    expect(routes[1].keystone.place).toBe(m2);
    for (const r of routes)
      expect(r.chain.visits.map((v) => v.stop.id)).toEqual(
        expect.arrayContaining(["s-lunch", "s-museum"]),
      );
  });
  it("collapses to a single route when the keystone has one candidate", async () => {
    const one = await optimizeKeystones(
      chicago,
      [stops[0], { ...stops[1], candidates: [m1] }],
      new Date("2026-11-09T15:00:00Z"),
      false,
      async (_a, _b, t) => itinerary(300, t),
    );
    expect(one).toHaveLength(1);
    expect(one[0].keystone.place).toBe(m1);
  });
  it("skips a keystone whose only combos fail to plan", async () => {
    const routes = await optimizeKeystones(
      chicago,
      stops,
      new Date("2026-11-09T15:00:00Z"),
      false,
      async (_a, b, t) => {
        if (b === m2) throw new Error("unreachable");
        return itinerary(300, t);
      },
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].keystone.place).toBe(m1);
  });
  it("a slower route wins when it has no transfers and dense options", async () => {
    // lunch-4/5 sit next to museum-b: alternates within walking distance of
    // that route, useless to museum-a's route.
    const richStops: Stop[] = [
      {
        ...stops[0],
        candidates: [
          ...lunches,
          place("lunch-4", 41.951),
          place("lunch-5", 41.952),
        ],
      },
      stops[1],
    ];
    const routes = await optimizeKeystones(
      chicago,
      richStops,
      new Date("2026-11-09T15:00:00Z"),
      false,
      async (_a, b, t) => ({
        ...itinerary(b === m2 ? 500 : 150, t),
        transfers: b === m1 ? 3 : 0, // museum-a route: 3 transfers inbound
      }),
    );
    expect(routes[0].keystone.place).toBe(m2); // convenient beats faster
    expect(routes[0].options).toBeGreaterThan(0);
    expect(routes[1].keystone.place).toBe(m1);
  });
  it("unrouted alternates count toward nearby options", async () => {
    const withAlts: Stop[] = [
      {
        ...stops[0],
        candidates: lunches.slice(0, 1),
        alternates: [place("alt-lunch", 41.901)], // walks to museum-a's area
        pool: 40,
      },
      { ...stops[1], candidates: [m1], pool: 10 },
    ];
    const routes = await optimizeKeystones(
      chicago,
      withAlts,
      new Date("2026-11-09T15:00:00Z"),
      false,
      async (_a, _b, t) => itinerary(200, t),
    );
    expect(routes[0].options).toBe(1);
  });
});
