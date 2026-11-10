import { describe, it, expect } from "vitest";
import { searchParams } from "./api";
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
