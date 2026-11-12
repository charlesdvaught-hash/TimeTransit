import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import {
  distance,
  rank,
  optimize,
  rankByReachability,
  scanOrder,
  type Itinerary,
  type Leg,
  type Pin,
  type Place,
  type ReachableStop,
  type Result,
  type Stop,
  type TripChain,
} from "./core";
import { search, plan, planOptions, nearby, reachable } from "./api";
import { parseQuery, shouldParse, toTerm } from "./semantic"; // STAGE-1
import { nameScore } from "./suggestions"; // STAGE-1
import type { SemanticParseResult } from "./contracts"; // STAGE-1
import { inCoverage, reachableStops, scan } from "./scan";
import { loadScanIndex } from "./scanData";
import { fetchAlerts, fetchTripDelays, type ServiceAlert } from "./gtfsrt"; // WAVE-2
import { loadBasemap, saveBasemap, type Basemap } from "./basemap";
import { loadPlaces, placesInCorridor, searchPlaces } from "./places";
import { observation } from "./reliability";
import { addObservations } from "./reliabilityStore";
import {
  departuresNear,
  liveDepartures as fetchLiveDepartures,
  transferViolations,
  type LiveDeparture,
  type NearbyDeparture,
} from "./transit";
import { departureSnapshot, resolveTripCandidates } from "./tripCandidates";
import { geolocationGranted, useUserPosition } from "./useUserPosition";
import {
  readBookmarks,
  readCachedPlan,
  readFavoriteLines,
  readRecentSearches,
  writeBookmarks,
  writeCachedPlan,
  writeFavoriteLines,
  writeRecentSearches,
} from "./storage";
import type {
  CachedPlan,
  FavoriteLine,
  RecentSearch,
  SavedPlace,
} from "./contracts";
import { syncConfigured, syncState, type SyncState } from "./syncClient"; // WAVE-2
import { parseShareLink } from "./shareUtils";
import {
  applyTheme,
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
    [basemap, setBasemap] = useState<Basemap>(loadBasemap),
    [preferences, updatePreferences] = useState(loadPreferences()),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<Result[]>([]),
    [selected, setSelected] = useState<Result | null>(null),
    [exploreBusy, setExploreBusy] = useState(false),
    [tripBusy, setTripBusy] = useState(false),
    [progress, setProgress] = useState([0, 0]),
    [error, setError] = useState(""),
    [liveBus, setLiveBus] = useState<{
      lat: number;
      lon: number;
      bearing?: number;
    } | null>(null),
    [providers, setProviders] = useState<string[]>([]),
    [picking, setPicking] = useState(false),
    [departure, updateDeparture] = useState(""),
    [dwell, updateDwell] = useState(15),
    [dwells, updateDwells] = useState<number[]>([]),
    [stopPins, updateStopPins] = useState<(Pin | undefined)[]>([]),
    [pinned, setPinned] = useState<Record<string, Place>>({}),
    [hover, setHover] = useState<Place[]>([]),
    [back, updateBack] = useState(true),
    [chain, setChain] = useState<TripChain | null>(null),
    [chainWarnings, setChainWarnings] = useState<string[]>([]), // STAGE-3
    [chainNote, setChainNote] = useState(""),
    [now, setNow] = useState(new Date()),
    [originSearch, setOriginSearch] = useState(""),
    [originOptions, setOriginOptions] = useState<Place[]>([]),
    [interpreted, setInterpreted] = useState<string | null>(null), // STAGE-1
    [locating, setLocating] = useState(false),
    [gpsOn, setGpsOn] = useState(false),
    [bookmarks, setBookmarks] = useState<SavedPlace[]>(readBookmarks),
    [recents, setRecents] = useState<RecentSearch[]>(readRecentSearches),
    [board, setBoard] = useState<
      { place: SavedPlace; trip: Itinerary | null }[]
    >([]),
    [nearbyNow, setNearbyNow] = useState<NearbyDeparture[]>([]),
    [timeMode, updateTimeMode] = useState<"now" | "depart" | "arrive">("now"),
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
    } | null>(null),
    // WAVE-2
    [favorites, setFavorites] = useState<FavoriteLine[]>(readFavoriteLines),
    [alerts, setAlerts] = useState<ServiceAlert[]>([]),
    [ridePois, setRidePois] = useState<Place[]>([]),
    [offlineCache, setOfflineCache] = useState<CachedPlan | null>(null);
  function invalidateTrip() {
    tripAbort.current?.abort();
    tripAbort.current = null;
    setTripBusy(false);
    setChain(null);
    setChainWarnings([]); // STAGE-3
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
  function setTimeMode(mode: "now" | "depart" | "arrive") {
    if (mode === timeMode) return;
    updateTimeMode(mode);
    setDeparture(mode === "now" ? "" : departure); // keep the picked time
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
  function chooseBasemap(b: Basemap) {
    setBasemap(b);
    saveBasemap(b);
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
        setGpsOn(true); // permission just granted — start the idle watch
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

  // Wave-1: saved places, departures board, recents, arrive-by mode.
  const arriveBy = timeMode === "arrive";
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
  function recordRecent(term: string) {
    const label = term.trim();
    if (!label || label.length > 40) return;
    const next = [
      { id: label.toLowerCase(), label, ts: Date.now() },
      ...readRecentSearches().filter((r) => r.id !== label.toLowerCase()),
    ].slice(0, 8);
    writeRecentSearches(next);
    setRecents(next);
    pushSync({ recentSearches: next });
  }
  // WAVE-2: favorite transit lines — a star badge on journey legs;
  // localStorage first, optional worker sync when configured
  const favKey = (l: Leg) => l.routeId || l.routeShortName || l.mode;
  function isFavorite(leg: Leg) {
    return favorites.some((f) => f.routeId === favKey(leg));
  }
  function toggleFavorite(leg: Leg) {
    const routeId = favKey(leg);
    setFavorites((prev) => {
      const next = prev.some((f) => f.routeId === routeId)
        ? prev.filter((f) => f.routeId !== routeId)
        : [
            ...prev,
            {
              routeId,
              agencyId: leg.agencyId,
              shortName: leg.routeShortName || leg.mode,
              color: leg.routeColor,
            },
          ].slice(0, 32);
      writeFavoriteLines(next);
      pushSync({ favoriteLines: next });
      return next;
    });
  }
  // WAVE-2: worker sync — last-write-wins on the whole blob. localStorage
  // is the source of truth; a newer remote blob is adopted wholesale.
  function pushSync(
    patch: Partial<
      Pick<SyncState, "bookmarks" | "favoriteLines" | "recentSearches">
    > = {},
  ) {
    if (!syncConfigured()) return;
    const local: SyncState = {
      bookmarks: patch.bookmarks ?? bookmarks,
      favoriteLines: patch.favoriteLines ?? favorites,
      recentSearches: patch.recentSearches ?? recents,
      updatedAt: Date.now(),
    };
    syncState(local).then((merged) => {
      if (!merged || merged.updatedAt <= local.updatedAt) return;
      setBookmarks(merged.bookmarks);
      writeBookmarks(merged.bookmarks);
      setFavorites(merged.favoriteLines);
      writeFavoriteLines(merged.favoriteLines);
      setRecents(merged.recentSearches);
      writeRecentSearches(merged.recentSearches);
    });
  }
  // WAVE-2: GTFS-RT service alerts — session-cached ~5 min, silent on any
  // failure, so rows just render without badges when the feed is absent
  useEffect(() => {
    if (!selected && !nearbyNow.length) return;
    let live = true;
    fetchAlerts()
      .then((a) => {
        if (live) setAlerts(a);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [selected, nearbyNow.length]);
  const offline = () =>
    typeof navigator === "undefined" || navigator.onLine === false;
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
  // "Nearby now": next departures around the origin — self-disables
  // without a Transit key/relay, so it just stays empty there
  useEffect(() => {
    const c = new AbortController();
    const timer = setTimeout(() => {
      departuresNear(origin, c.signal)
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
  // permission already granted (returning user)? start the idle watch
  // at boot without a tap; Safari lacks the query and just skips this.
  useEffect(() => {
    let live = true;
    geolocationGranted().then((ok) => {
      if (ok && live) setGpsOn(true);
    });
    return () => {
      live = false;
    };
  }, []);
  const userPosition = useUserPosition(gpsOn);
  // share-link hydration: ?to/&tolat/&tolon lands as a pinned place and
  // auto-runs once, then the URL is cleaned so a reload doesn't re-run
  useEffect(() => {
    const shared = parseShareLink();
    if (!shared) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (shared.origin) changeOrigin(shared.origin);
    if (shared.dest)
      run(shared.dest.name, {
        [shared.dest.name.toLowerCase()]: shared.dest,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot-only
  }, []);
  useEffect(() => applyTheme(preferences), [preferences]);
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
  // STAGE-1: pin parsed anchors to strong local name matches so the
  // optimizer can't drift to a different venue with a similar name
  async function anchorPins(
    result: SemanticParseResult,
    pins: Record<string, Place>,
  ) {
    await loadPlaces();
    const next = { ...pins };
    for (const anchor of result.high_priority_anchors) {
      const hit = searchPlaces(anchor.normalized_entity_name, origin).find(
        (p) => nameScore(anchor.normalized_entity_name, p.name) >= 500,
      );
      if (hit) next[anchor.normalized_entity_name.toLowerCase()] = hit;
    }
    return next;
  }
  async function run(term: string, pins = pinned, depth = 0) {
    if (!term.trim()) return;
    if (!depth) recordRecent(term); // depth>0 = internal semantic re-run
    // STAGE-1: offer free-form sentences to the semantic parser once per run
    if (!depth) {
      if (shouldParse(term, preferences.aiMode)) {
        const parsed = await parseQuery(term);
        if (parsed) {
          const next = toTerm(parsed);
          const found = await anchorPins(parsed, pins);
          if (next !== term.trim()) {
            setInterpreted(next);
            return run(next, found, 1);
          }
          pins = found;
        }
      }
      setInterpreted(null);
    }
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
    setOfflineCache(null);
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
        // STAGE-2
        stops.push(
          ...reachableStops(scanIdx, origin, t0, {
            walkSpeed: preferences.walkingSpeed,
            maxWalkM: preferences.walkDistance,
            delays,
          }),
        );
      }
      const planned = rankByReachability(
        origin,
        candidates,
        stops,
        preferences.walkingSpeed,
        { verifiedOnly: preferences.verifiedOnly }, // STAGE-4
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
                arriveBy,
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
      // WAVE-2: every fetch failed while offline → fall back to the
      // last displayed journey instead of an empty list
      else if (!c.signal.aborted && !found.length && offline())
        restoreCachedPlan();
    } catch (e) {
      if (!c.signal.aborted) {
        // WAVE-2: a fetch-level network failure (TypeError) restores the
        // cached plan even if the browser still thinks it's online
        if (e instanceof TypeError && restoreCachedPlan()) setError("");
        else setError((e as Error).message);
      }
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
    setOfflineCache(null);
    const speed = calibratedSpeed();
    setResults([]);
    setSelected(null);
    setChain(null);
    try {
      const start = departureSnapshot(departure);
      // STAGE-4: warm the scan + places indexes before resolving so segment
      // candidates can be filtered to the reachable-stop corridor
      const scanPromise = loadScanIndex().catch(() => undefined);
      loadPlaces();
      const corridor: { lat: number; lon: number }[] = [];
      const corridorReady = scanPromise
        .then((idx) => {
          if (idx && inCoverage(idx, origin))
            for (const si of scan(idx, origin, start.getTime(), {
              walkSpeed: preferences.walkingSpeed,
              maxWalkM: preferences.walkDistance,
            }).keys())
              corridor.push({ lat: idx.stops[si].la, lon: idx.stops[si].lo });
        })
        .catch(() => undefined);
      const dedupe = (list: Place[]) => [
        ...new Map(list.map((p) => [p.id, p])).values(),
      ]; // STAGE-4
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
          search(query, origin, c.signal).then(async (r) => {
            await corridorReady; // STAGE-4
            return dedupe([
              ...placesInCorridor([query], corridor, {
                radiusM: preferences.walkDistance,
                verifiedOnly: preferences.verifiedOnly ?? false,
                origin,
              }),
              ...searchPlaces(query, origin),
              ...r,
            ]);
          }),
        (place) =>
          plan(
            origin,
            place,
            start,
            c.signal,
            preferences,
            recordProviders,
            arriveBy,
          ),
        c.signal,
      );
      const scanIdx = await scanPromise; // settled alongside corridorReady
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
              verifiedOnly: preferences.verifiedOnly, // STAGE-4
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
            verifiedOnly: preferences.verifiedOnly, // STAGE-4
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
        (a, b, t) =>
          plan(a, b, t, c.signal, preferences, recordProviders, arriveBy),
        speed,
        order,
      );
      if (!c.signal.aborted) {
        setChain(trip);
        setSelected(null);
        // STAGE-3: live transfer check — first boarding leg per visit vs the
        // rider's planned arrival; shares the 60s live-compare throttle
        const refs = trip.visits
          .map((v, visit) => ({
            visit,
            leg: v.trip.legs.find((l) => l.mode !== "WALK" && l.tripId),
          }))
          .filter((r) => !!r.leg);
        if (
          refs.length &&
          refs.some(
            (r) =>
              Date.parse(r.leg!.scheduledStartTime || r.leg!.startTime) -
                Date.now() <
              2 * 3600 * 1000,
          ) &&
          Date.now() - lastLiveCompare >= 60000
        ) {
          lastLiveCompare = Date.now();
          fetchLiveDepartures(
            refs.map((r) => r.leg!),
            c.signal,
          )
            .then((lives) => {
              if (c.signal.aborted) return;
              const byVisit: (LiveDeparture | undefined)[] = [];
              refs.forEach((r, i) => (byVisit[r.visit] = lives[i]));
              setChainWarnings(
                transferViolations(trip, byVisit).map((x) => {
                  const live = byVisit[x.visit];
                  return `${live?.routeName || "Transit"} ${
                    x.cancelled ? "is cancelled" : "leaves before you arrive"
                  } · ${trip.visits[x.visit].place.name}`;
                }),
              );
            })
            .catch(() => {});
        }
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

  return {
    preferences,
    setPreferences,
    origin,
    setOrigin,
    userPosition,
    gpsOn,
    bookmarks,
    upsertBookmark,
    removeBookmark,
    renameBookmark,
    planToBookmark,
    board,
    recents,
    nearbyNow,
    timeMode,
    setTimeMode,
    arriveBy,
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
    chainWarnings, // STAGE-3
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
    liveBus,
    setLiveBus,
    trip,
    arrival,
    locating,
    map,
    basemap,
    chooseBasemap,
    changeOrigin,
    locate,
    run,
    addToTrip,
    pinPlace,
    interpreted,
    setInterpreted,
    reroute,
    total,
    hover,
    setHover,
    // WAVE-2
    favorites,
    isFavorite,
    toggleFavorite,
    alerts,
    ridePois,
    setRidePois,
    offlineCache,
  };
}
export type TransitController = ReturnType<typeof useTimeTransit>;
