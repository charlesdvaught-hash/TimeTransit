import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import {
  chicago,
  distance,
  rank,
  optimize,
  type Place,
  type Result,
  type Stop,
  type TripChain,
} from "./core";
import { search, plan, nearby } from "./api";
import { departureSnapshot, resolveTripCandidates } from "./tripCandidates";
export function useTimeTransit() {
  const map = useRef<maplibregl.Map | null>(null),
    exploreAbort = useRef<AbortController | null>(null),
    tripAbort = useRef<AbortController | null>(null);
  const [origin, setOrigin] = useState(chicago),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<Result[]>([]),
    [selected, setSelected] = useState<Result | null>(null),
    [exploreBusy, setExploreBusy] = useState(false),
    [tripBusy, setTripBusy] = useState(false),
    [progress, setProgress] = useState([0, 0]),
    [error, setError] = useState(""),
    [providers, setProviders] = useState<string[]>([]),
    [tab, setTab] = useState("explore"),
    [picking, setPicking] = useState(false),
    [departure, updateDeparture] = useState(""),
    [stops, updateStops] = useState<Stop[]>([]),
    [back, updateBack] = useState(true),
    [chain, setChain] = useState<TripChain | null>(null),
    [now, setNow] = useState(new Date()),
    [originSearch, setOriginSearch] = useState(""),
    [originOptions, setOriginOptions] = useState<Place[]>([]);
  function invalidateTrip() {
    tripAbort.current?.abort();
    tripAbort.current = null;
    setTripBusy(false);
    setChain(null);
  }
  function setStops(value: Stop[]) {
    invalidateTrip();
    updateStops(value);
  }
  function setBack(value: boolean) {
    invalidateTrip();
    updateBack(value);
  }
  function setDeparture(value: string) {
    invalidateTrip();
    exploreAbort.current?.abort();
    setExploreBusy(false);
    setResults([]);
    setSelected(null);
    setProgress([0, 0]);
    updateDeparture(value);
  }
  function changeOrigin(p: Place) {
    invalidateTrip();
    exploreAbort.current?.abort();
    setExploreBusy(false);
    setOrigin(p);
    setResults([]);
    setSelected(null);
    setChain(null);
    setProviders([]);
    setPicking(false);
    map.current?.flyTo({ center: [p.lon, p.lat], zoom: 13 });
  }
  function locate() {
    navigator.geolocation
      ? navigator.geolocation.getCurrentPosition(
          (p) =>
            changeOrigin({
              id: "gps",
              name: "Your location",
              lat: p.coords.latitude,
              lon: p.coords.longitude,
            }),
          () =>
            setError(
              "Location unavailable. Using Chicago — search an address or pick on the map.",
            ),
        )
      : setError("Geolocation is not supported.");
  }
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const c = new AbortController();
    nearby(origin, c.signal)
      .then((p) => {
        if (p.length) setProviders(p);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(`Nearby stops: ${e.message}`);
      });
    return () => c.abort();
  }, [origin]);
  async function run(term: string) {
    if (!term.trim()) return;
    const start = departureSnapshot(departure);
    exploreAbort.current?.abort();
    invalidateTrip();
    const c = new AbortController();
    exploreAbort.current = c;
    setQuery(term);
    setExploreBusy(true);
    setError("");
    setResults([]);
    setSelected(null);
    setChain(null);
    setProgress([0, 0]);
    try {
      const candidates = await search(term, origin, c.signal);
      if (c.signal.aborted) return;
      setProgress([0, candidates.length]);
      let done = 0;
      const found: Result[] = [];
      let index = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (!c.signal.aborted && index < candidates.length) {
            const i = index++,
              p = candidates[i];
            try {
              const trip = await plan(origin, p, start, c.signal);
              found.push({
                place: p,
                trip,
                distance: distance(origin, p),
                distanceRank: i + 1,
              });
              if (!c.signal.aborted) {
                setResults(rank(found));
                setProviders((prev) => [
                  ...new Set([
                    ...prev,
                    ...trip.legs.flatMap((l) =>
                      l.agencyName ? [l.agencyName] : [],
                    ),
                  ]),
                ]);
              }
            } catch (e) {
              if (!c.signal.aborted)
                setError(
                  `Some routes could not be loaded: ${(e as Error).message}`,
                );
            } finally {
              done++;
              if (!c.signal.aborted) setProgress([done, candidates.length]);
            }
          }
        }),
      );
      if (!c.signal.aborted && !tripAbort.current && found.length)
        setSelected(rank(found)[0]);
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (!c.signal.aborted) setExploreBusy(false);
    }
  }
  function addStop(place?: Place) {
    if (stops.length >= 4) return;
    setStops([
      ...stops,
      {
        id: crypto.randomUUID(),
        label: place?.name || "Coffee",
        candidates: place ? [place] : [],
        dwell: 15,
      },
    ]);
    setTab("trip");
  }
  async function optimizeTrip() {
    tripAbort.current?.abort();
    const c = new AbortController();
    tripAbort.current = c;
    setTripBusy(true);
    setError("");
    setChain(null);
    try {
      const start = departureSnapshot(departure);
      const resolved = await resolveTripCandidates(
        stops,
        (query) => search(query, origin, c.signal),
        (place) => plan(origin, place, start, c.signal),
        c.signal,
      );
      const samples = results.filter((r) => r.trip.duration > 0);
      const speed = samples.length
        ? Math.max(
            5,
            Math.min(
              45,
              samples.reduce(
                (s, r) => s + (r.distance / r.trip.duration) * 3600,
                0,
              ) / samples.length,
            ),
          )
        : 18;
      const trip = await optimize(
        origin,
        resolved,
        start,
        back,
        (a, b, t) => plan(a, b, t, c.signal),
        speed,
      );
      if (!c.signal.aborted) {
        setChain(trip);
        setSelected(null);
      }
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (!c.signal.aborted) setTripBusy(false);
    }
  }
  const total = chain?.duration || selected?.trip.duration;

  return {
    origin,
    setOrigin,
    query,
    setQuery,
    results,
    setResults,
    selected,
    setSelected,
    busy: exploreBusy || tripBusy,
    exploreBusy,
    tripBusy,
    progress,
    setProgress,
    error,
    setError,
    providers,
    setProviders,
    tab,
    setTab,
    picking,
    setPicking,
    departure,
    setDeparture,
    stops,
    setStops,
    back,
    setBack,
    chain,
    setChain,
    now,
    setNow,
    originSearch,
    setOriginSearch,
    originOptions,
    setOriginOptions,
    map,
    changeOrigin,
    locate,
    run,
    addStop,
    optimizeTrip,
    total,
  };
}
export type TransitController = ReturnType<typeof useTimeTransit>;
