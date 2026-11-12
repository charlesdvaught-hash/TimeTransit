// WAVE-2: offline journey snapshot — the displayed journey (results list
// + top pick) is written to localStorage so an offline relaunch can
// restore it instead of showing an empty list.
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Itinerary, Place, Result, TripChain } from "./core";
import { readCachedPlan, writeCachedPlan } from "./storage";
import type { CachedPlan } from "./contracts";
export const offline = () =>
  typeof navigator === "undefined" || navigator.onLine === false;
export function useTripCache({
  selected,
  liveChoice,
  chain,
  query,
  origin,
  arriveBy,
  departure,
  results,
  setResults,
  setSelected,
}: {
  selected: Result | null;
  liveChoice: { trip: Itinerary } | null;
  chain: TripChain | null;
  query: string;
  origin: Place;
  arriveBy: boolean;
  departure: string;
  results: Result[];
  setResults: Dispatch<SetStateAction<Result[]>>;
  setSelected: Dispatch<SetStateAction<Result | null>>;
}) {
  const [offlineCache, setOfflineCache] = useState<CachedPlan | null>(null);
  const trip = liveChoice?.trip ?? selected?.trip ?? null;
  function restoreCachedPlan() {
    const cached = readCachedPlan();
    const rows = (cached?.results ?? []) as Result[];
    if (!cached || !rows.length) return false;
    setResults(rows);
    setSelected(rows[0]);
    setOfflineCache(cached);
    return true;
  }
  useEffect(() => {
    if (offline()) restoreCachedPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot-only
  }, []);
  // WAVE-2: snapshot the displayed journey so an offline relaunch can
  // restore it (the last results list + its top pick)
  useEffect(() => {
    if (!selected || !trip || chain) return;
    writeCachedPlan({
      savedAt: Date.now(),
      query,
      origin: { lat: origin.lat, lon: origin.lon, name: origin.name },
      mode: arriveBy ? "arrive" : "depart",
      targetTime: departure ? Date.parse(departure) : undefined,
      results: results.length ? results : [{ place: selected.place, trip }],
    });
  }, [selected, trip]); // eslint-disable-line react-hooks/exhaustive-deps
  return { offlineCache, setOfflineCache, restoreCachedPlan };
}
