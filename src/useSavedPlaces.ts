// Wave-1: saved places — home/work/gym/pin bookmarks persisted to
// localStorage (worker-synced when configured), the departures board
// (one fastest plan per bookmark), and "Nearby now" stop departures.
import { useEffect, useState } from "react";
import type { Itinerary, Place } from "./core";
import { plan } from "./api";
import { departureSnapshot } from "./tripCandidates";
import type { NearbyDeparture } from "./transit";
import { departuresNearChained } from "./fallbackEta";
import { readBookmarks, writeBookmarks } from "./storage";
import type { SavedPlace } from "./contracts";
import type { Preferences } from "./preferences";
import type { PushSync } from "./useSyncPush";
export function useSavedPlaces({
  origin,
  departure,
  timeMode,
  preferences,
  arriveBy,
  pinned,
  run,
  pushSync,
}: {
  origin: Place;
  departure: string;
  timeMode: "now" | "depart" | "arrive";
  preferences: Preferences;
  arriveBy: boolean;
  pinned: Record<string, Place>;
  run: (term: string, pins?: Record<string, Place>) => void;
  pushSync: PushSync;
}) {
  const [bookmarks, setBookmarks] = useState<SavedPlace[]>(readBookmarks),
    [board, setBoard] = useState<
      { place: SavedPlace; trip: Itinerary | null }[]
    >([]),
    [nearbyNow, setNearbyNow] = useState<NearbyDeparture[]>([]);
  function upsertBookmark(
    icon: SavedPlace["icon"],
    place: Place,
    label?: string,
  ) {
    setBookmarks((prev) => {
      const next = prev.filter((b) => b.icon !== icon);
      next.push({
        id: `bm-${icon}`,
        label:
          label?.trim() ||
          (icon === "pin" ? place.name : icon[0].toUpperCase() + icon.slice(1)),
        icon,
        lat: place.lat,
        lon: place.lon,
        address: place.address,
        updatedAt: Date.now(),
      });
      writeBookmarks(next);
      pushSync({ bookmarks: next });
      return next;
    });
  }
  function removeBookmark(id: string) {
    setBookmarks((prev) => {
      const next = prev.filter((b) => b.id !== id);
      writeBookmarks(next);
      pushSync({ bookmarks: next });
      return next;
    });
  }
  function renameBookmark(id: string, label: string) {
    setBookmarks((prev) => {
      const next = prev.map((b) =>
        b.id === id ? { ...b, label: label.trim() || b.label } : b,
      );
      writeBookmarks(next);
      pushSync({ bookmarks: next });
      return next;
    });
  }
  // exact coords — the pin mechanism skips place search entirely
  function planToBookmark(b: SavedPlace) {
    const place: Place = { id: b.id, name: b.label, lat: b.lat, lon: b.lon };
    run(b.label, { ...pinned, [b.label.toLowerCase()]: place });
  }
  // departures board: one fastest plan per bookmark, refreshed when the
  // origin or the bookmark list changes (debounced + abortable)
  useEffect(() => {
    if (!bookmarks.length) {
      setBoard([]);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      const at = departureSnapshot(departure);
      Promise.all(
        bookmarks.map(async (b) => {
          try {
            const trip = await plan(
              origin,
              { id: b.id, name: b.label, lat: b.lat, lon: b.lon },
              at,
              c.signal,
              preferences,
              undefined,
              arriveBy,
            );
            return { place: b, trip };
          } catch {
            return { place: b, trip: null };
          }
        }),
      ).then((rows) => {
        if (!c.signal.aborted) setBoard(rows);
      });
    }, 350);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [origin.lat, origin.lon, bookmarks, departure, timeMode]);
  // "Nearby now": next departures around the origin — Transit first, index
  // schedule + feed delays fill in when Transit is down or keyless
  useEffect(() => {
    const c = new AbortController();
    const timer = setTimeout(() => {
      departuresNearChained(origin, c.signal)
        .then((d) => {
          if (!c.signal.aborted) setNearbyNow(d);
        })
        .catch(() => {});
    }, 600);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [origin.lat, origin.lon]);
  return {
    bookmarks,
    setBookmarks,
    board,
    nearbyNow,
    upsertBookmark,
    removeBookmark,
    renameBookmark,
    planToBookmark,
  };
}
