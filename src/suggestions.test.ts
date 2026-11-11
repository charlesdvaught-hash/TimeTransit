import { describe, expect, it } from "vitest";
import type { Place } from "./core";
import { mergeSuggestions, nameScore } from "./suggestions";

const place = (
  name: string,
  lat: number,
  lon: number,
  address?: string,
): Place => ({
  id: `${name}|${lat}|${lon}`.toLowerCase().replace(/[^a-z0-9|.-]+/g, "-"),
  name,
  lat,
  lon,
  ...(address ? { address } : {}),
});

describe("nameScore", () => {
  it("prefers a name that starts with the query", () => {
    const query = "partners credit union";
    expect(nameScore(query, "Partners Federal Credit Union")).toBeGreaterThan(
      nameScore(query, "Financial Partners Credit Union"),
    );
  });

  it("scores an exact name above a partial one", () => {
    expect(
      nameScore(
        "partners federal credit union",
        "Partners Federal Credit Union",
      ),
    ).toBeGreaterThan(1000);
    expect(
      nameScore(
        "partners federal credit union",
        "Partners Federal Credit Union",
      ),
    ).toBeGreaterThan(nameScore("partners federal credit union", "Partners"));
  });

  it("matches on prefixes and small typos", () => {
    expect(
      nameScore("partners fed credit", "Partners Federal Credit Union"),
    ).toBeGreaterThan(0);
    expect(
      nameScore(
        "partners fedral credit union",
        "Partners Federal Credit Union",
      ),
    ).toBeGreaterThan(nameScore("partners fedral credit union", "Taco Bell"));
    expect(
      nameScore("partnrs", "Partners Federal Credit Union"),
    ).toBeGreaterThan(0);
  });

  it("ignores filler words and punctuation", () => {
    expect(
      nameScore("the coffee bean", "Coffee Bean & Tea Leaf"),
    ).toBeGreaterThan(0);
  });

  it("returns zero when no word matches", () => {
    expect(nameScore("partners credit union", "Walmart Supercenter")).toBe(0);
  });
});

describe("mergeSuggestions", () => {
  it("ranks a TomTom business above a similarly named OSM one", () => {
    const photon = [
      place("Financial Partners Credit Union", 33.77, -118.19, "Long Beach"),
    ];
    const tomtom = [
      {
        ...place(
          "Partners Federal Credit Union",
          33.836,
          -117.914,
          "100 S Anaheim Blvd",
        ),
        id: "tomtom-abc123",
      },
    ];
    const merged = mergeSuggestions("partners credit union", photon, tomtom);
    expect(merged[0].label).toBe("Partners Federal Credit Union");
    expect(merged[0].place?.id).toContain("tomtom");
    expect(merged).toHaveLength(2);
  });

  it("drops the same place returned by both providers", () => {
    const a = place("Partners Federal Credit Union", 33.836, -117.914);
    const b = place("Partners Federal Credit Union", 33.8361, -117.9141);
    expect(mergeSuggestions("partners", [a], [b])).toHaveLength(1);
  });

  it("groups same-name branches into one unpinned suggestion", () => {
    const a = place("Partners Federal Credit Union", 33.836, -117.914);
    const b = place("Partners Federal Credit Union", 33.9, -118.2);
    const merged = mergeSuggestions("partners", [a], [b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].detail).toBe("2 locations");
    expect(merged[0].place).toBeUndefined(); // no early pin — optimizer picks
    expect(merged[0].places).toHaveLength(2);
  });

  it("ranks a venue of the asked type above a same-name non-match", () => {
    const photon = [
      {
        ...place("Arcade Theatre", 33.9, -118.1, "534 S Broadway"),
        kind: "theatre",
      },
    ];
    const tomtom = [
      {
        ...place("Round1", 33.85, -117.95, "1600 S Azusa Ave"),
        id: "tomtom-1",
        kind: "amusement arcade",
      },
    ];
    const merged = mergeSuggestions("arcade", photon, tomtom);
    expect(merged[0].label).toBe("Round1");
    expect(merged[0].detail).toContain("amusement arcade");
  });

  it("keeps provider order when nothing matches the query", () => {
    const merged = mergeSuggestions("zzz", [
      place("Alpha", 33.8, -117.9),
      place("Beta", 33.81, -117.91),
    ]);
    expect(merged.map((s) => s.label)).toEqual(["Alpha", "Beta"]);
    expect(merged[0].detail).toBe("33.800, -117.900");
  });
});
