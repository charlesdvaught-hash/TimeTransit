import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { type Pin, type Place } from "./core";
import { nearby } from "./api";
import { fetchAlerts, type ServiceAlert } from "./gtfsrt"; // WAVE-2
import { trySource } from "./liveSource";
import { loadBasemap, saveBasemap, type Basemap } from "./basemap";
import { geolocationGranted, useUserPosition } from "./useUserPosition";
import { useSavedPlaces } from "./useSavedPlaces"; // WAVE-1
import { useRecentSearches } from "./useRecentSearches"; // WAVE-1
import { useFavorites } from "./useFavorites"; // WAVE-2
import { useSyncPush } from "./useSyncPush"; // WAVE-2
import { useTripCache } from "./useTripCache"; // WAVE-2
import { useTripSearch, type TripCacheBridge } from "./useTripSearch";
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
export function useTimeTransit() {
  const map = useRef<maplibregl.Map | null>(null);
  const [origin, setOrigin] = useState(loadOrigin()),
    [basemap, setBasemap] = useState<Basemap>(loadBasemap),
    [preferences, updatePreferences] = useState(loadPreferences()),
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
    [now, setNow] = useState(new Date()),
    [originSearch, setOriginSearch] = useState(""),
    [originOptions, setOriginOptions] = useState<Place[]>([]),
    [locating, setLocating] = useState(false),
    [gpsOn, setGpsOn] = useState(false),
    [timeMode, updateTimeMode] = useState<"now" | "depart" | "arrive">("now"),
    // WAVE-2
    [alerts, setAlerts] = useState<ServiceAlert[]>([]),
    [ridePois, setRidePois] = useState<Place[]>([]);
  // useTripCache mounts below (it consumes the search state); the search
  // hook clears/restores the offline snapshot through this bridge, filled
  // in during the same render so it's ready before any run() can fire
  const tripCache = useRef<TripCacheBridge>({
    setOfflineCache: () => {},
    restoreCachedPlan: () => false,
  });
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
    abortExplore();
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
    abortExplore();
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
  const sync = useSyncPush();
  const { recents, setRecents, recordRecent } = useRecentSearches({
    pushSync: sync.pushSync,
  });
  const { favorites, setFavorites, isFavorite, toggleFavorite } = useFavorites({
    pushSync: sync.pushSync,
  });
  const {
    query,
    setQuery,
    results,
    setResults,
    selected,
    setSelected,
    exploreBusy,
    tripBusy,
    progress,
    setProgress,
    chain,
    setChain,
    chainWarnings, // STAGE-3
    chainNote,
    interpreted,
    setInterpreted,
    liveDepartures,
    liveChoice,
    run,
    reroute,
    invalidateTrip,
    abortExplore,
  } = useTripSearch({
    origin,
    departure,
    arriveBy,
    preferences,
    pinned,
    dwell,
    dwells,
    stopPins,
    back,
    recordRecent,
    setError,
    recordProviders,
    tripCache,
  });
  const {
    bookmarks,
    setBookmarks,
    board,
    nearbyNow,
    upsertBookmark,
    removeBookmark,
    renameBookmark,
    planToBookmark,
  } = useSavedPlaces({
    origin,
    departure,
    timeMode,
    preferences,
    arriveBy,
    pinned,
    run,
    pushSync: sync.pushSync,
  });
  // link() re-binds every render so pushSync merges patches over (and
  // adopts remote blobs into) the latest committed slices
  sync.link({
    bookmarks,
    setBookmarks,
    favorites,
    setFavorites,
    recents,
    setRecents,
  });
  // WAVE-2: GTFS-RT service alerts — session-cached ~5 min, silent on any
  // failure, so rows just render without badges when the feed is absent
  useEffect(() => {
    if (!selected && !nearbyNow.length) return;
    let live = true;
    trySource("octa-rt", () => fetchAlerts(), { timeoutMs: 6_000 }).then(
      (a) => {
        if (live && a) setAlerts(a);
      },
    );
    return () => {
      live = false;
    };
  }, [selected, nearbyNow.length]);
  const { offlineCache, setOfflineCache, restoreCachedPlan } = useTripCache({
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
  });
  tripCache.current = { setOfflineCache, restoreCachedPlan };
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
  function addToTrip(place: Place) {
    const pins = { ...pinned, [place.name.toLowerCase()]: place };
    setPinned(pins);
    run(query.trim() ? `${query.trim()} + ${place.name}` : place.name, pins);
  }
  const trip = liveChoice?.trip ?? selected?.trip ?? null;
  const delay = liveChoice?.delay ?? 0;
  const arrival = trip
    ? new Date(Date.parse(trip.endTime) + delay * 1000).toISOString()
    : null;
  const total = chain?.duration || (trip ? trip.duration + delay : undefined);

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
