import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import {
  distance,
  rank,
  optimize,
  type Place,
  type Result,
  type Stop,
  type TripChain,
} from "./core";
import { search, plan, nearby } from "./api";
import { observation } from "./reliability";
import { addObservations } from "./reliabilityStore";
import { liveDeparture, type LiveDeparture } from "./transit";
import { departureSnapshot, resolveTripCandidates } from "./tripCandidates";
import {
  loadOrigin,
  loadPreferences,
  saveOrigin,
  savePreferences,
  validPreferences,
  type Preferences,
} from "./preferences";
export function useTimeTransit() {
  const map = useRef<maplibregl.Map | null>(null),
    exploreAbort = useRef<AbortController | null>(null),
    tripAbort = useRef<AbortController | null>(null);
  const [origin, setOrigin] = useState(loadOrigin()),
    [preferences, updatePreferences] = useState(loadPreferences()),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<Result[]>([]),
    [selected, setSelected] = useState<Result | null>(null),
    [exploreBusy, setExploreBusy] = useState(false),
    [tripBusy, setTripBusy] = useState(false),
    [progress, setProgress] = useState([0, 0]),
    [error, setError] = useState(""),
    [providers, setProviders] = useState<string[]>([]),
    [picking, setPicking] = useState(false),
    [departure, updateDeparture] = useState(""),
    [dwell, updateDwell] = useState(15),
    [pinned, setPinned] = useState<Record<string, Place>>({}),
    [back, updateBack] = useState(true),
    [chain, setChain] = useState<TripChain | null>(null),
    [now, setNow] = useState(new Date()),
    [originSearch, setOriginSearch] = useState(""),
    [originOptions, setOriginOptions] = useState<Place[]>([]),
    [locating, setLocating] = useState(false),
    [liveDepartures, setLiveDepartures] = useState<
      Record<number, LiveDeparture>
    >({});
  function invalidateTrip() {
    tripAbort.current?.abort();
    tripAbort.current = null;
    setTripBusy(false);
    setChain(null);
  }
  function setDwell(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 240) return;
    invalidateTrip();
    updateDwell(value);
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
    saveOrigin(p);
    setResults([]);
    setSelected(null);
    setChain(null);
    setProviders([]);
    setPicking(false);
    map.current?.flyTo({ center: [p.lon, p.lat], zoom: 13 });
  }
  function setPreferences(p: Preferences) {
    if (!validPreferences(p)) return;
    setDeparture(departure);
    updatePreferences(p);
    savePreferences(p);
  }
  function recordProviders(names: string[]) {
    setProviders((previous) => [...new Set([...previous, ...names])]);
  }
  function locate() {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported in this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        changeOrigin({
          id: "gps",
          name: "Your location",
          lat: p.coords.latitude,
          lon: p.coords.longitude,
        });
      },
      (e) => {
        setLocating(false);
        setError(
          e.code === e.PERMISSION_DENIED
            ? "Location permission denied. Allow location for this site in your browser's address-bar settings, or search an address instead."
            : e.code === e.TIMEOUT
              ? "Location request timed out. Try again or search an address instead."
              : "Location unavailable. Keeping the current origin — search an address or pick on the map.",
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
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
  useEffect(() => {
    setLiveDepartures({});
    if (!selected) return;
    const c = new AbortController();
    selected.trip.legs.forEach(async (leg, index) => {
      if (leg.mode === "WALK" || !leg.tripId) return;
      try {
        const live = await liveDeparture(leg, c.signal);
        if (!live || c.signal.aborted) return;
        setLiveDepartures((previous) => ({ ...previous, [index]: live }));
        if (live.realtime && !live.cancelled)
          addObservations([
            observation(
              { ...leg, scheduledStartTime: live.scheduledTime },
              "feed",
              "departure",
              live.expectedTime,
            ),
          ]);
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.warn(e);
      }
    });
    return () => c.abort();
  }, [selected]);
  async function run(term: string, pins = pinned) {
    if (!term.trim()) return;
    const segments = term
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length >= 2) return runTrip(term, segments, pins);
    return runExplore(term);
  }
  async function runExplore(term: string) {
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
              const trip = await plan(
                origin,
                p,
                start,
                c.signal,
                preferences,
                recordProviders,
              );
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
  function addToTrip(place: Place) {
    const pins = { ...pinned, [place.name.toLowerCase()]: place };
    setPinned(pins);
    run(query.trim() ? `${query.trim()} + ${place.name}` : place.name, pins);
  }
  function calibratedSpeed() {
    const samples = results.filter((r) => r.trip.duration > 0);
    return samples.length
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
  }
  async function runTrip(term: string, segments: string[], pins = pinned) {
    if (segments.length > 4) {
      setError(
        "Multi-stop trips take up to 4 destinations — separate them with +.",
      );
      return;
    }
    tripAbort.current?.abort();
    exploreAbort.current?.abort();
    setExploreBusy(false);
    const c = new AbortController();
    tripAbort.current = c;
    setQuery(term);
    setTripBusy(true);
    setError("");
    const speed = calibratedSpeed();
    setResults([]);
    setSelected(null);
    setChain(null);
    try {
      const start = departureSnapshot(departure);
      const resolved = await resolveTripCandidates(
        segments.map((label, i) => {
          const hit = pins[label.toLowerCase()];
          return {
            id: `seg-${i}`,
            label: hit?.name || label,
            candidates: hit ? [hit] : [],
            dwell,
          };
        }),
        (query) => search(query, origin, c.signal),
        (place) =>
          plan(origin, place, start, c.signal, preferences, recordProviders),
        c.signal,
      );
      const trip = await optimize(
        origin,
        resolved,
        start,
        back,
        (a, b, t) => plan(a, b, t, c.signal, preferences, recordProviders),
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
    preferences,
    setPreferences,
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
    picking,
    setPicking,
    departure,
    setDeparture,
    dwell,
    setDwell,
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
    liveDepartures,
    locating,
    map,
    changeOrigin,
    locate,
    run,
    addToTrip,
    total,
  };
}
export type TransitController = ReturnType<typeof useTimeTransit>;
