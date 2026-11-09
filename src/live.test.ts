import { it, expect } from "vitest";
import { search, plan } from "./api";
import { chicago, distance, rank, type Result } from "./core";
it.skipIf(!("process" in globalThis) || !(globalThis as any).process.env.LIVE)(
  "live Chicago coffee ranked by real door-to-door time",
  async () => {
    const candidates = await search("Coffee", chicago);
    const found: Result[] = [];
    let index = 0;
    const departure = new Date();
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (index < candidates.length) {
          const i = index++,
            p = candidates[i];
          found.push({
            place: p,
            trip: await plan(chicago, p, departure),
            distance: distance(chicago, p),
            distanceRank: i + 1,
          });
        }
      }),
    );
    const ordered = rank(found);
    console.log("Chicago Coffee — " + departure.toISOString());
    ordered
      .slice(0, 5)
      .forEach((r) =>
        console.log(
          `${r.place.name} | ${Math.ceil(r.trip.duration / 60)} min | ${r.distance.toFixed(2)} km`,
        ),
      );
    expect(ordered.length).toBeGreaterThanOrEqual(5);
    expect(
      ordered.every(
        (r, i) => i === 0 || r.trip.duration >= ordered[i - 1].trip.duration,
      ),
    ).toBe(true);
  },
  180000,
);
