import { it, expect, vi } from "vitest";
import { search } from "./api";
import { categories, chicago } from "./core";
it.skipIf(!(globalThis as any).process?.env.LIVE_CATEGORIES)(
  "returns tagged places for every Chicago chip",
  async () => {
    const nativeFetch = globalThis.fetch;
    const observed = new Map<string, any[]>();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const response = await nativeFetch(input, init);
        const data = await response.clone().json();
        observed.set(String(input), data.features || []);
        return response;
      });
    try {
      for (const [label, tag] of Object.entries(categories)) {
        const results = await search(label, chicago);
        const [key, value] = tag.split(":");
        const features = [...observed.values()].at(-1)!;
        expect(
          features.every(
            (f) =>
              f.properties.osm_key === key && f.properties.osm_value === value,
          ),
        ).toBe(true);
        expect(results.length).toBeGreaterThan(0);
        console.log(
          `${label}: ${results.length} results within 20 km (${tag}); sample: ${results[0].name}`,
        );
      }
    } finally {
      spy.mockRestore();
    }
  },
  120000,
);
