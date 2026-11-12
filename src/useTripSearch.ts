// Search + trip orchestration extracted from useTimeTransit: run() splits
// the term on "+" — a single segment streams explore candidates pre-ranked
// by one-to-all reachability, 2–4 run the multi-stop optimizer (per-stop
// dwell, optional round trip, pinned places). Also owns the selected
// journey's live-departure compare and the watchdog mid-trip reroute.
// Trip inputs (origin/departure/dwell/pins) stay in the controller and
// arrive as args; the offline snapshot stays in useTripCache, reached
// through the tripCache bridge the controller fills once that hook mounts.
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  distance,
  optimize,
  rank,
  rankByReachability,
  scanOrder,
  type Itinerary,
  type Pin,
  type Place,
  type ReachableStop,
  type Result,
  type TripChain,
} from "./core";
import { plan, planOptions, reachable, search } from "./api";
import { parseQuery, shouldParse, toTerm } from "./semantic"; // STAGE-1
import { nameScore } from "./suggestions"; // STAGE-1
import type { CachedPlan, SemanticParseResult } from "./contracts"; // STAGE-1
import { inCoverage, reachableStops, scan } from "./scan";
import { loadScanIndex } from "./scanData";
import { fetchTripDelays } from "./gtfsrt"; // WAVE-2
import { loadPlaces, placesInCorridor, searchPlaces } from "./places";
import { observation } from "./reliability";
import { addObservations } from "./reliabilityStore";
import {
  liveDepartures as fetchLiveDepartures,
  transferViolations,
  type LiveDeparture,
} from "./transit";
import { departureSnapshot, resolveTripCandidates } from "./tripCandidates";
import { offline } from "./useTripCache"; // WAVE-2
import type { Preferences } from "./preferences";
let lastLiveCompare = 0;
type LiveOption = {
  trip: Itinerary;
  byIndex: Record<number, LiveDeparture>;
  delay: number;
  cancelled: boolean;
  realtime: boolean;
  end: number;
};
export type TripCacheBridge = {
  setOfflineCache: Dispatch<SetStateAction<CachedPlan | null>>;
  restoreCachedPlan: () => boolean;
};
export function useTripSearch({
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
}: {
  origin: Place;
  departure: string;
  arriveBy: boolean;
  preferences: Preferences;
  pinned: Record<string, Place>;
  dwell: number;
  dwells: number[];
  stopPins: (Pin | undefined)[];
  back: boolean;
  recordRecent: (term: string) => void;
  setError: Dispatch<SetStateAction<string>>;
  recordProviders: (names: string[]) => void;
  tripCache: { current: TripCacheBridge };
}) {
  const exploreAbort = useRef<AbortController | null>(null),
    tripAbort = useRef<AbortController | null>(null);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<Result[]>([]),
    [selected, setSelected] = useState<Result | null>(null),
    [exploreBusy, setExploreBusy] = useState(false),
    [tripBusy, setTripBusy] = useState(false),
    [progress, setProgress] = useState([0, 0]),
    [chain, setChain] = useState<TripChain | null>(null),
    [chainWarnings, setChainWarnings] = useState<string[]>([]), // STAGE-3
    [chainNote, setChainNote] = useState(""),
    [interpreted, setInterpreted] = useState<string | null>(null), // STAGE-1
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
    setChainWarnings([]); // STAGE-3
  }
  function abortExplore() {
    exploreAbort.current?.abort();
    setExploreBusy(false);
  }
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
    tripCache.current.setOfflineCache(null);
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
                recordProviders(
                  trip.legs.flatMap((l) =>
                    l.agencyName ? [l.agencyName] : [],
                  ),
                );
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
        tripCache.current.restoreCachedPlan();
    } catch (e) {
      if (!c.signal.aborted) {
        // WAVE-2: a fetch-level network failure (TypeError) restores the
        // cached plan even if the browser still thinks it's online
        if (e instanceof TypeError && tripCache.current.restoreCachedPlan())
          setError("");
        else setError((e as Error).message);
      }
    } finally {
      if (!c.signal.aborted) setExploreBusy(false);
    }
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
    abortExplore();
    const c = new AbortController();
    tripAbort.current = c;
    setQuery(term);
    setTripBusy(true);
    setError("");
    tripCache.current.setOfflineCache(null);
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
  return {
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
  };
}
