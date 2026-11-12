import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readBookmarks,
  readCachedPlan,
  readFavoriteLines,
  readRecentSearches,
  readWorkerSync,
  writeBookmarks,
  writeCachedPlan,
  writeFavoriteLines,
  writeRecentSearches,
  writeWorkerSync,
} from "./storage";
import type { SavedPlace } from "./contracts";

const home: SavedPlace = {
  id: "p1",
  label: "Home",
  icon: "home",
  lat: 33.78,
  lon: -118.1,
  updatedAt: 1,
};

function store() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  });
  return map;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("bookmarks", () => {
  it("round-trips and caps at 4", () => {
    const s = store();
    writeBookmarks([home, { ...home, id: "p2", icon: "work" }]);
    expect(readBookmarks()).toHaveLength(2);
    writeBookmarks(
      Array.from({ length: 6 }, (_, i) => ({ ...home, id: `p${i}` })),
    );
    expect(readBookmarks()).toHaveLength(4);
    expect(JSON.parse(s.get("tt_bookmarks_v1")!)).toHaveLength(4);
  });
  it("drops malformed rows to the fallback", () => {
    const s = store();
    s.set("tt_bookmarks_v1", JSON.stringify([{ bogus: true }]));
    expect(readBookmarks()).toEqual([]);
    s.set("tt_bookmarks_v1", "not json");
    expect(readBookmarks()).toEqual([]);
  });
});

describe("recent searches / favorite lines", () => {
  it("round-trips capped lists", () => {
    store();
    writeRecentSearches(
      Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`,
        label: `coffee ${i}`,
        ts: i,
      })),
    );
    expect(readRecentSearches()).toHaveLength(8);
    writeFavoriteLines([{ routeId: "1", shortName: "1" }]);
    expect(readFavoriteLines()[0].shortName).toBe("1");
  });
});

describe("cached plan", () => {
  it("round-trips a minimal plan and rejects junk", () => {
    const s = store();
    writeCachedPlan({
      savedAt: 1,
      query: "coffee",
      origin: { lat: 33.7, lon: -118.1, name: "Here" },
      mode: "depart",
      results: [{ id: "x" }],
    });
    expect(readCachedPlan()?.query).toBe("coffee");
    s.set("tt_last_plan_cache_v1", JSON.stringify({ savedAt: "soon" }));
    expect(readCachedPlan()).toBeNull();
  });
});

describe("worker sync", () => {
  it("defaults to empty and round-trips", () => {
    store();
    expect(readWorkerSync()).toEqual({ url: "", token: "" });
    writeWorkerSync({ url: "https://w.example", token: "t" });
    expect(readWorkerSync().url).toBe("https://w.example");
  });
});
