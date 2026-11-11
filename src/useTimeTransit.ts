import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import {
  distance,
  rank,
  optimize,
  rankByReachability,
  scanOrder,
  type Itinerary,
  type Pin,
  type Place,
  type ReachableStop,
  type Result,
  type Stop,
  type TripChain,
} from "./core";
import { search, plan, planOptions, nearby, reachable } from "./api";
import { inCoverage, scan } from "./scan";
import { loadScanIndex } from "./scanData";
import { fetchTripDelays } from "./gtfsrt";
import { loadPlaces, searchPlaces } from "./places";
import { observation } from "./reliability";
import { addObservations } from "./reliabilityStore";
import {
  liveDepartures as fetchLiveDepartures,
  type LiveDeparture,
} from "./transit";
import { departureSnapshot, resolveTripCandidates } from "./tripCandidates";
import {
  loadOrigin,
  loadPreferences,
  saveOrigin,
  savePreferences,
  validPreferences,
  type Preferences,
} from "./preferences";
let lastLiveCompare = 0;
type LiveOption = {
  trip: Itinerary;
  byIndex: Record<number, LiveDeparture>;
  delay: number;
  cancelled: boolean;
  realtime: boolean;
  end: number;
};
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
    [dwells, updateDwells] = useState<number[]>([]),
    [stopPins, updateStopPins] = useState<(Pin | undefined)[]>([]),
    [pinned, setPinned] = useState<Record<string, Place>>({}),
    [back, updateBack] = useState(true),
    [chain, setChain] = useState<TripChain | null>(null),
    [chainNote, setChainNote] = useState(""),
    [now, setNow] = useState(new Date()),
    [originSearch, setOriginSearch] = useState(""),
    [originOptions, setOriginOptions] = useState<Place[]>([]),
    [locating, setLocating] = useState(false),
    [liveDepartures, setLiveDepartures] = useState<
      Record<number, LiveDeparture>
    >({}),
    [liveChoice, setLiveChoice] = useState<{
      trip: Itinerary;
      delay: number;
      options: {
        trip: Itinerary;
        delay: number;
        cancelled: boolean;
        realtime: boolean;
      }[];
    } | null>(null);
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
  function setStopDwell(index: number, value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 240) return;
    invalidateTrip();
    updateDwells((previous) => {
      const next = [...previous];
      next[index] = value;
      return next;
    });
  }
  function pinPlace(place: Place) {
    const pins = { ...pinned, [place.name.toLowerCase()]: place };
    setPinned(pins);
    return pins;
  }
  function setBack(value: boolean) {
    invalidateTrip();
    updateBack(value);
  }
  function setStopPin(index: number, pin: Pin | undefined) {
    invalidateTrip();
    updateStopPins((previous) => {
      const next = [...previous];
      next[index] = pin;
      return next;
    });
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
    const timer = setInterval(() => setNow(new Date()), 15000);
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
    setLiveChoice(null);
    if (!selected) return;
    const c = new AbortController();
    const options = (
      selected.alternatives?.length ? selected.alternatives : [selected.trip]
    ).slice(0, 2);
    if (
      !options.some((trip) =>
        trip.legs.some((leg) => leg.mode !== "WALK" && leg.tripId),
      )
    )
      return;
    if (Date.now() - lastLiveCompare < 60000) return;
    lastLiveCompare = Date.now();
    const refs = options.flatMap((trip) => {
      const first = trip.legs.findIndex(
        (leg) => leg.mode !== "WALK" && leg.tripId,
      );
      return first < 0 ? [] : [{ trip, leg: trip.legs[first], index: first }];
    });
    fetchLiveDepartures(
      refs.map((x) => x.leg),
      c.signal,
    )
      .then((lives) => {
        if (c.signal.aborted) return;
        const checked = options.map((trip): LiveOption | null => {
          const mine = refs
            .map((x, i) => ({ ...x, live: lives[i] }))
            .filter((x) => x.trip === trip);
          const byIndex: Record<number, LiveDeparture> = {};
          for (const x of mine) {
            if (!x.live) continue;
            byIndex[x.index] = x.live;
            if (x.live.realtime && !x.live.cancelled)
              addObservations([
                observation(
                  { ...x.leg, scheduledStartTime: x.live.scheduledTime },
                  "feed",
                  "departure",
                  x.live.expectedTime,
                ),
              ]);
          }
          const known = mine
            .map((x) => x.live)
            .filter((l): l is LiveDeparture => !!l);
          const last = [...mine].reverse().find((x) => x.live)?.live;
          return {
            trip,
            byIndex,
            delay: last?.delay ?? 0,
            cancelled: known.some((l) => l.cancelled),
            realtime: known.some((l) => l.realtime),
            end: Date.parse(trip.endTime) + (last?.delay ?? 0) * 1000,
          };
        });
        const valid = checked.filter((x): x is LiveOption => !!x);
        if (!valid.length || !valid.some((x) => x.realtime || x.cancelled))
          return;
        const best =
          [...valid]
            .filter((x) => !x.cancelled)
            .sort((a, b) => a.end - b.end)[0] ?? valid[0];
        setLiveChoice({
          trip: best.trip,
          delay: best.delay,
          options: valid.map(({ trip, delay, cancelled, realtime }) => ({
            trip,
            delay,
            cancelled,
            realtime,
          })),
        });
        setLiveDepartures(best.byIndex);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") console.warn(e);
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
    return runExplore(term, pins);
  }
  async function runExplore(term: string, pins = pinned) {
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
      const reachPromise = reachable(origin, start, c.signal).catch(
        () => [] as ReachableStop[],
      );
      const scanPromise = loadScanIndex().catch(() => undefined);
      loadPlaces();
      const candidates = pins[term.trim().toLowerCase()]
        ? [pins[term.trim().toLowerCase()]]
        : [
            ...searchPlaces(term, origin),
            ...(await search(term, origin, c.signal)),
          ];
      if (c.signal.aborted) return;
      const stops = await Promise.race([
        reachPromise,
        new Promise<ReachableStop[]>((resolve) =>
          setTimeout(() => resolve([]), 2500),
        ),
      ]);
      if (c.signal.aborted) return;
      const scanIdx = await scanPromise;
      if (scanIdx && inCoverage(scanIdx, origin)) {
        const t0 = start.getTime();
        const delays =
          t0 - Date.now() < 2 * 3600 * 1000
            ? await fetchTripDelays(c.signal).catch(() => undefined)
            : undefined;
        if (c.signal.aborted) return;
        for (const [si, at] of scan(scanIdx, origin, t0, {
          walkSpeed: preferences.walkingSpeed,
          maxWalkM: preferences.walkDistance,
          delays,
        })) {
          const minutes = (at - t0) / 60000;
          if (minutes >= 0 && minutes < 600)
            stops.push({
              lat: scanIdx.stops[si].la,
              lon: scanIdx.stops[si].lo,
              minutes,
            });
        }
      }
      const planned = rankByReachability(
        origin,
        candidates,
        stops,
        preferences.walkingSpeed,
      ).slice(0, 20);
      const distanceRanks = new Map(
        [...candidates]
          .sort((a, b) => distance(origin, a) - distance(origin, b))
          .map((p, i) => [p.id, i + 1]),
      );
      setProgress([0, planned.length]);
      let done = 0;
      const found: Result[] = [];
      let index = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (!c.signal.aborted && index < planned.length) {
            const i = index++,
              p = planned[i];
            try {
              const alternatives = await planOptions(
                origin,
                p,
                start,
                c.signal,
                preferences,
                recordProviders,
              );
              const trip = alternatives[0];
              if (!trip)
                throw new Error("No route available for this destination.");
              found.push({
                place: p,
                trip,
                alternatives,
                distance: distance(origin, p),
                distanceRank: distanceRanks.get(p.id) ?? i + 1,
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
              if (!c.signal.aborted) setProgress([done, planned.length]);
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
          const m = /^([\\^$~])\s*(.+)$/.exec(label.trim());
          const text = m ? m[2].trim() : label.trim();
          const syntaxPin: Pin | undefined = m
            ? m[1] === "^"
              ? "first"
              : m[1] === "$"
                ? "last"
                : "middle"
            : undefined;
          const hit = pins[text.toLowerCase()];
          return {
            id: `seg-${i}`,
            label: hit?.name || text,
            candidates: hit ? [hit] : [],
            dwell: dwells[i] ?? dwell,
            pin: syntaxPin ?? stopPins[i],
          };
        }),
        (query) =>
          search(query, origin, c.signal).then((r) => [
            ...searchPlaces(query, origin),
            ...r,
          ]),
        (place) =>
          plan(origin, place, start, c.signal, preferences, recordProviders),
        c.signal,
      );
      const scanIdx = await loadScanIndex().catch(() => undefined);
      const delays =
        scanIdx &&
        inCoverage(scanIdx, origin) &&
        start.getTime() - Date.now() < 2 * 3600 * 1000
          ? await fetchTripDelays(c.signal).catch(() => undefined)
          : undefined;
      const order =
        scanIdx && inCoverage(scanIdx, origin)
          ? scanOrder(scanIdx, origin, resolved, start.getTime(), {
              back,
              walkSpeed: preferences.walkingSpeed,
              maxWalkM: preferences.walkDistance,
              delays,
            })
          : undefined;
      if (order && resolved.some((s) => s.pin)) {
        const free = scanOrder(
          scanIdx!,
          origin,
          resolved.map((s) => ({ ...s, pin: undefined })),
          start.getTime(),
          {
            back,
            walkSpeed: preferences.walkingSpeed,
            maxWalkM: preferences.walkDistance,
            delays,
          },
        );
        const saved = (order[0]?.total ?? 0) - (free[0]?.total ?? 0);
        if (saved > 120 && free[0]) {
          const seq = free[0].combo.map((v) => v.stop.label).join(" → ");
          setChainNote(
            `Reordering as ${seq} saves about ${Math.round(saved / 60)} min`,
          );
        } else setChainNote("");
      } else setChainNote("");
      const trip = await optimize(
        origin,
        resolved,
        start,
        back,
        (a, b, t) => plan(a, b, t, c.signal, preferences, recordProviders),
        speed,
        order,
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
  const trip = liveChoice?.trip ?? selected?.trip ?? null;
  const delay = liveChoice?.delay ?? 0;

  // mid-trip reroute: replace the selected journey with the best plan from
  // the rider's current position (watchdog "Switch route" action)
  async function reroute(from: { lat: number; lon: number }, at: number) {
    if (!selected || chain) return;
    const opts = await planOptions(
      { id: "reroute", name: "Current location", ...from },
      selected.place,
      new Date(at),
      undefined,
      preferences,
    ).catch(() => undefined);
    if (!opts?.length) return;
    setLiveChoice(null);
    setSelected({ ...selected, trip: opts[0], alternatives: opts.slice(1) });
  }
  const arrival = trip
    ? new Date(Date.parse(trip.endTime) + delay * 1000).toISOString()
    : null;
  const total = chain?.duration || (trip ? trip.duration + delay : undefined);

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
    dwells,
    setStopDwell,
    back,
    setBack,
    chain,
    setChain,
    chainNote,
    stopPins,
    setStopPin,
    now,
    setNow,
    originSearch,
    setOriginSearch,
    originOptions,
    setOriginOptions,
    liveDepartures,
    liveChoice,
    trip,
    arrival,
    locating,
    map,
    changeOrigin,
    locate,
    run,
    addToTrip,
    pinPlace,
    reroute,
    total,
  };
}
export type TransitController = ReturnType<typeof useTimeTransit>;
