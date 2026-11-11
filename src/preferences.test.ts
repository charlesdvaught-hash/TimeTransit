import { expect, it, vi, afterEach } from "vitest";
import {
  defaults,
  excessWalks,
  loadPreferences,
  savePreferences,
  loadOrigin,
  saveOrigin,
  walkParams,
} from "./preferences";
import { chicago, type Itinerary } from "./core";
afterEach(() => vi.unstubAllGlobals());
it("uses MOTIS seconds and meters-per-second parameters", () => {
  expect(walkParams(defaults)).toMatchObject({
    maxPreTransitTime: "571",
    maxPostTransitTime: "571",
    maxDirectTime: "571",
    pedestrianSpeed: "1.4",
    withDistance: "true",
  });
  expect(walkParams({ ...defaults, walkDistance: 400 }).maxPreTransitTime).toBe(
    "285",
  );
});
it("flags transfer walks including estimated distance when distance is missing", () => {
  const trip = {
    legs: [
      { mode: "WALK", distance: 700, duration: 500 },
      { mode: "WALK", duration: 600 },
    ],
  } as Itinerary;
  expect(excessWalks(trip, defaults)).toHaveLength(1);
  expect(excessWalks(trip, { ...defaults, walkDistance: 400 })).toHaveLength(2);
});
it("persists preferences and the last origin, tolerating corrupt and disabled storage", () => {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) || null,
    setItem: (k: string, v: string) => map.set(k, v),
  });
  savePreferences({ ...defaults, walkDistance: 400 });
  expect(loadPreferences().walkDistance).toBe(400);
  saveOrigin(chicago);
  expect(loadOrigin()).toEqual(chicago);
  map.set("timetransit.preferences", '{"walkDistance":-10}');
  expect(loadPreferences()).toEqual(defaults);
  // STAGE-0 migration: pre-AI saves carry only walk prefs — coerce to defaults
  map.set("timetransit.preferences", '{"walkDistance":400,"walkingSpeed":1.1}');
  expect(loadPreferences()).toEqual({
    ...defaults,
    walkDistance: 400,
    walkingSpeed: 1.1,
  });
  map.set(
    "timetransit.preferences",
    '{"walkDistance":400,"walkingSpeed":1.1,"aiMode":"bogus","verifiedOnly":"yes"}',
  );
  expect(loadPreferences()).toEqual({
    ...defaults,
    walkDistance: 400,
    walkingSpeed: 1.1,
  });
  map.set("timetransit.origin", "invalid");
  expect(loadOrigin()).toEqual(chicago);
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Disabled");
    },
    setItem: () => {
      throw new Error("Disabled");
    },
  });
  expect(loadPreferences()).toEqual(defaults);
  expect(() => savePreferences(defaults)).not.toThrow();
});
