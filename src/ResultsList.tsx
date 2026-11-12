import {
  ArrowUpRight,
  Banknote,
  BookOpen,
  ChevronRight,
  Coffee,
  Dumbbell,
  GripVertical,
  Hammer,
  Home,
  Briefcase,
  Layers,
  LocateFixed,
  Lock,
  LockOpen,
  MapPin,
  Pill,
  Plus,
  Search,
  ShoppingBasket,
  Stethoscope,
  Trees,
  TriangleAlert,
  UtensilsCrossed,
  Zap,
} from "lucide-react";
import { alertsFor } from "./gtfsrt"; // WAVE-2
import { useEffect, useRef, useState } from "react";
import { suggest } from "./api";
import { categories, distance, suggestCategories, type Place } from "./core";
import { mergeSuggestions, nameScore, type Suggestion } from "./suggestions";
import { tomtomSuggest } from "./tomtom";
import { loadPlaces, searchPlaces } from "./places";
import type { GooglePlaceDetail } from "./contracts";
import { detailSummary, enrichPlace, gmapsEnabled } from "./gmaps";
import { GmapsLink } from "./GmapsLink";
const categoryIcons: Record<string, typeof Coffee> = {
  Coffee,
  Grocery: ShoppingBasket,
  Pharmacy: Pill,
  Restaurants: UtensilsCrossed,
  Parks: Trees,
  Library: BookOpen,
  "Hospital/Clinic": Stethoscope,
  Gym: Dumbbell,
  "Bank/ATM": Banknote,
  Hardware: Hammer,
};
import { minutes, time } from "./display";
import { RouteChips } from "./RouteChips";
import { RouteHunt } from "./RouteHunt";
import type { TransitController } from "./useTimeTransit";
function segmentAt(value: string, caret: number) {
  const parts = value.split("+");
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const end = offset + parts[i].length;
    if (caret <= end || i === parts.length - 1)
      return { index: i, text: parts[i].trim() };
    offset = end + 1;
  }
  return { index: 0, text: value.trim() };
}
const boardIcons = { home: Home, work: Briefcase, gym: Dumbbell, pin: MapPin };
function boardEta(trip: { startTime: string; duration: number } | null) {
  if (!trip) return "—";
  const leave = Math.max(
    0,
    Math.round((Date.parse(trip.startTime) - Date.now()) / 60000),
  );
  return `${leave ? `in ${leave}m` : "now"} · ${minutes(trip.duration)}m`;
}
export function ResultsList({ controller }: { controller: TransitController }) {
  const {
    origin,
    query,
    setQuery,
    results,
    selected,
    setSelected,
    trip: activeTrip,
    exploreBusy: busy,
    tripBusy,
    progress,
    chain,
    setChain,
    back,
    setBack,
    dwell,
    dwells,
    setStopDwell,
    chainNote,
    chainWarnings, // STAGE-3
    stopPins,
    setStopPin,
    run,
    addToTrip,
    pinPlace,
    setHover,
    bookmarks,
    board,
    recents,
    nearbyNow,
    planToBookmark,
  } = controller;
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [alts, setAlts] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [altOpen, setAltOpen] = useState(-1);
  const dragIdx = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const parts = query.split("+").map((s) => s.trim());
  const stops = parts.filter(Boolean);
  const pending = query.includes("+") && parts[parts.length - 1] === "";
  const slots = pending ? [...stops, ""] : stops;
  const destinations = stops.length;
  const current = segmentAt(query, caret);
  const segment = current.text;
  useEffect(() => {
    if (!focused || segment.length < 2) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    const c = new AbortController();
    loadPlaces(); // warm the local POI index while the user types
    let cap: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      const types: Suggestion[] = suggestCategories(segment)
        .slice(0, 4)
        .map((label) => ({
          id: `type-${label}`,
          kind: "type",
          label,
          detail: "Type of place",
        }));
      const photon: Place[] = [];
      const tomtom: Place[] = [];
      let local: Place[] = [];
      let pending = 3;
      let settled = false;
      // publish once — when every source has answered (or the cap hits) —
      // so the list never reshuffles under the cursor
      const settle = () => {
        if (settled || --pending > 0 || c.signal.aborted) return;
        settled = true;
        const places = mergeSuggestions(segment, photon, tomtom, local);
        // generic-term intent: when matches are kind-led (real comic shops,
        // not names containing 'comic'), offer a row that keeps the search
        // broad — the optimizer then weighs every venue combination
        const kindLed = local.filter(
          (p) =>
            p.kind &&
            nameScore(segment, p.kind) >= 300 &&
            nameScore(segment, p.kind) > nameScore(segment, p.name),
        );
        const covered = types.some((t) => nameScore(segment, t.label) >= 400);
        if (kindLed.length >= 2 && !covered)
          types.push({
            id: "type-any",
            kind: "type",
            label: segment,
            detail: `All ~${kindLed.length} nearby matches`,
          });
        const exact =
          places.length > 0 && nameScore(segment, places[0].label) >= 500;
        const list = (
          exact ? [...places, ...types] : [...types, ...places]
        ).slice(0, 10);
        setSuggestions(list);
        setActive(0);
        setSearching(false);
      };
      setSuggestions(types);
      setActive(0);
      setSearching(true);
      cap = setTimeout(() => {
        pending = 1;
        settle();
      }, 1400);
      loadPlaces()
        .then(() => {
          local = searchPlaces(segment, origin);
          settle();
        })
        .catch(settle);
      suggest(segment, origin, c.signal)
        .then((places) => {
          photon.push(...places);
          settle();
        })
        .catch(settle);
      tomtomSuggest(segment, origin, c.signal)
        .then((places) => {
          tomtom.push(...places);
          settle();
        })
        .catch(settle);
    }, 250);
    return () => {
      clearTimeout(timer);
      if (cap) clearTimeout(cap);
      c.abort();
      setSearching(false);
      setHover([]);
    };
  }, [segment, focused, origin]);
  // STAGE-5: Google detail enrichment — fetched per place on select; with
  // budgetOnly on, top rows are enriched too since priceLevel can't be known
  // (and thus can't pre-filter) before the fetch returns.
  const [gdetails, setGdetails] = useState<Record<string, GooglePlaceDetail>>(
    {},
  );
  const gpending = useRef(new Set<string>());
  useEffect(() => {
    if (!gmapsEnabled) return;
    const targets: Place[] = [];
    if (selected && !chain) targets.push(selected.place);
    if (controller.preferences.budgetOnly)
      for (const r of results.slice(0, 8)) targets.push(r.place);
    if (!targets.length) return;
    const c = new AbortController();
    for (const p of targets) {
      if (gdetails[p.id] || gpending.current.has(p.id)) continue;
      gpending.current.add(p.id);
      enrichPlace(p, origin, c.signal)
        .then(
          (d) => d && setGdetails((m) => (m[p.id] ? m : { ...m, [p.id]: d })),
        )
        .catch(() => {})
        .finally(() => gpending.current.delete(p.id));
    }
    return () => c.abort();
  }, [selected, results, chain, gdetails, controller.preferences.budgetOnly]);
  function choose(s: Suggestion) {
    const parts = query.split("+");
    parts[current.index] = s.label;
    const next = parts.map((p) => p.trim()).join(" + ");
    setQuery(next);
    setFocused(false);
    setHover([]);
    // keep same-family names reachable: fat-fingered picks get "did you mean"
    setAlts(
      suggestions
        .filter((o) => o.kind === "place" && o.label !== s.label)
        .slice(0, 3),
    );
    setSuggestions([]);
    if (s.place) run(next, pinPlace(s.place));
    else run(next);
  }
  // alternatives for a stop slot: the optimizer's candidate pool first,
  // then anything of the same kind clustered around the OTHER chosen
  // destinations — 'what else could this leg be?'
  function alternativesFor(i: number): Place[] {
    const label = slots[i];
    if (!label) return [];
    const resolved = chain?.visits.find((v) => v.stop.id === `seg-${i}`);
    const seen = new Set<string>();
    const pool: Place[] = [];
    const add = (p: Place) => {
      if (!seen.has(p.id) && p.id !== resolved?.place.id) {
        seen.add(p.id);
        pool.push(p);
      }
    };
    resolved?.stop.candidates.forEach(add);
    for (const v of chain?.visits ?? [])
      if (v !== resolved) searchPlaces(label, v.place, 4).forEach(add);
    if (!pool.length) searchPlaces(label, origin, 6).forEach(add);
    return pool.slice(0, 8);
  }
  function swap(i: number, p: Place) {
    const arr = [...slots];
    arr[i] = p.name;
    const next = arr.join(" + ");
    setAltOpen(-1);
    setQuery(next);
    run(next, pinPlace(p));
  }
  function dropTo(i: number) {
    const from = dragIdx.current;
    dragIdx.current = -1;
    if (from < 0 || from === i) return;
    const arr = [...slots];
    const [moved] = arr.splice(from, 1);
    arr.splice(i, 0, moved);
    setQuery(arr.join(" + "));
    setStopPin(i, i === 0 ? "first" : i === arr.length - 1 ? "last" : "middle");
  }
  return (
    <>
      <div className="search-wrap">
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            run(query);
          }}
        >
          <Search size={19} />
          <input
            ref={inputRef}
            aria-label="Search destinations"
            aria-autocomplete="list"
            aria-controls="destination-suggestions"
            aria-expanded={focused && (suggestions.length > 0 || searching)}
            aria-activedescendant={
              focused && suggestions.length ? `suggestion-${active}` : undefined
            }
            role="combobox"
            placeholder="Where to? Separate stops with +"
            value={query}
            onChange={(e) => {
              setAlts([]);
              setQuery(e.target.value);
              setFocused(true);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onPointerDown={() => setFocused(true)}
            onFocus={(e) => {
              setFocused(true);
              setCaret(e.target.selectionStart ?? query.length);
            }}
            onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onKeyDown={(e) => {
              if (!suggestions.length) {
                if (e.key === "Escape") setFocused(false);
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % suggestions.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(
                  (a) => (a - 1 + suggestions.length) % suggestions.length,
                );
              } else if (e.key === "Enter") {
                e.preventDefault();
                const picked = suggestions[active] ?? suggestions[0];
                if (picked) choose(picked);
              } else if (e.key === "Escape") {
                setFocused(false);
              }
            }}
          />
          <button title="Search" aria-label="Search">
            <ArrowUpRight size={20} />
          </button>
        </form>
        {focused && (suggestions.length > 0 || searching) && (
          <div
            className="suggestions"
            id="destination-suggestions"
            role="listbox"
            onMouseLeave={() => setHover([])}
          >
            {suggestions.map((s, i) => {
              const Icon =
                s.kind === "type" ? (categoryIcons[s.label] ?? Layers) : MapPin;
              return (
                <button
                  type="button"
                  key={s.id}
                  id={`suggestion-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "active" : ""}
                  onMouseEnter={() => {
                    setActive(i);
                    setHover(s.places ?? (s.place ? [s.place] : []));
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(s)}
                >
                  <Icon size={13} />
                  <span>
                    <strong>{s.label}</strong>
                    {s.detail && <small>{s.detail}</small>}
                  </span>
                </button>
              );
            })}
            {searching && (
              <div className="suggestions-loading" role="status">
                <i />
                <i />
                <i />
                Finding places…
              </div>
            )}
            {suggestions.some((s) => s.place?.id.startsWith("tomtom-")) && (
              <small className="suggestions-credit">Places © TomTom</small>
            )}
          </div>
        )}
      </div>
      {!query.trim() && !focused && recents.length > 0 && (
        <div className="recent-chips" aria-label="Recent searches">
          {recents.map((r) => (
            <button key={r.id} onClick={() => run(r.label)}>
              {r.label}
            </button>
          ))}
        </div>
      )}
      {alts.length > 0 && (
        <p className="did-you-mean">
          Did you mean:
          {alts.map((a) => (
            <button key={a.id} onClick={() => choose(a)}>
              {a.label}
            </button>
          ))}
        </p>
      )}
      {!busy &&
        !query.trim() &&
        !results.length &&
        !selected &&
        !chain &&
        (board.length > 0 || nearbyNow.length > 0) && (
          <div className="idle-board">
            {board.find((r) => r.place.icon === "home") && (
              <button
                className="get-home"
                onClick={() =>
                  planToBookmark(
                    board.find((r) => r.place.icon === "home")!.place,
                  )
                }
              >
                <Home size={15} />
                <strong>Get me home</strong>
                <span>
                  {boardEta(board.find((r) => r.place.icon === "home")!.trip)}
                </span>
              </button>
            )}
            {board
              .filter((r) => r.place.icon !== "home")
              .map((r) => {
                const Icon = boardIcons[r.place.icon];
                return (
                  <button
                    className="board-row"
                    key={r.place.id}
                    onClick={() => planToBookmark(r.place)}
                  >
                    <Icon size={14} />
                    <span className="board-label">{r.place.label}</span>
                    <span className="board-eta">{boardEta(r.trip)}</span>
                  </button>
                );
              })}
            {nearbyNow.length > 0 && (
              <div className="nearby-now">
                <small>NEARBY NOW</small>
                {nearbyNow.slice(0, 5).map((d, i) => {
                  const hit = alertsFor(controller.alerts, {
                    routeName: d.route,
                  });
                  return (
                    <p key={i}>
                      <strong>{d.route}</strong> {d.stopName}
                      {!!hit.length && (
                        <span
                          className="alert-flag"
                          title={hit[0].header || "Service alert"}
                          role="img"
                          aria-label={hit[0].header || "Service alert"}
                        >
                          <TriangleAlert size={11} />
                        </span>
                      )}
                      <span>
                        {Math.max(0, Math.round((d.time - Date.now()) / 60000))}
                        {" min"}
                        {d.realtime ? " · live" : ""}
                      </span>
                    </p>
                  );
                })}
              </div>
            )}
          </div>
        )}
      <div className="categories">
        {Object.keys(categories).map((c) => {
          const Icon = categoryIcons[c] ?? Layers;
          return (
            <button
              className={query === c ? "active" : ""}
              aria-pressed={query === c}
              key={c}
              onClick={() => run(c)}
            >
              <Icon size={12} /> {c}
            </button>
          );
        })}
      </div>
      {stops.length > 0 && slots.length >= 2 && (
        <div className="trip-options">
          <div className="trip-stops">
            {slots.map((label, i) => {
              const slotPin =
                i === 0 ? "first" : i === slots.length - 1 ? "last" : "middle";
              return (
                <div
                  className="trip-stop"
                  key={`${label}-${i}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => dropTo(i)}
                >
                  <button
                    type="button"
                    className="trip-grip"
                    title="Drag to reorder stops"
                    aria-label={`Drag to reorder stop ${i + 1}`}
                    draggable
                    onDragStart={() => (dragIdx.current = i)}
                  >
                    <GripVertical size={13} />
                  </button>
                  <button
                    type="button"
                    className={`trip-pin${stopPins[i] ? " set" : ""}`}
                    title={
                      stopPins[i]
                        ? `Locked ${stopPins[i]} — click to free`
                        : "Free order — click to lock this slot"
                    }
                    aria-label={`Stop ${i + 1} order: ${stopPins[i] ? `locked ${stopPins[i]}` : "free"}`}
                    onClick={(e) => {
                      e.preventDefault();
                      setStopPin(i, stopPins[i] ? undefined : slotPin);
                    }}
                  >
                    {stopPins[i] ? <Lock size={11} /> : <LockOpen size={11} />}
                  </button>
                  <span className="trip-stop-name">{label || "Next stop"}</span>
                  {label && (
                    <button
                      type="button"
                      className="trip-alt"
                      title="Other options nearby"
                      aria-label={`Alternatives for ${label}`}
                      onClick={(e) => {
                        e.preventDefault();
                        setAltOpen(altOpen === i ? -1 : i);
                      }}
                    >
                      <LocateFixed size={12} />
                      <b>?</b>
                    </button>
                  )}
                  <input
                    aria-label={`Stay minutes at ${label || `stop ${i + 1}`}`}
                    type="number"
                    min="0"
                    max="240"
                    value={dwells[i] ?? dwell}
                    onChange={(e) => setStopDwell(i, Number(e.target.value))}
                  />
                  <small>min</small>
                  {altOpen === i && (
                    <div className="alt-list">
                      {alternativesFor(i).length ? (
                        alternativesFor(i).map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => swap(i, p)}
                          >
                            <strong>{p.name}</strong>
                            <small>
                              {[p.kind, p.address].filter(Boolean).join(" · ")}
                            </small>
                          </button>
                        ))
                      ) : (
                        <small>No other candidates found nearby.</small>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <label className="return">
            <input
              aria-label="Return to start"
              type="checkbox"
              checked={back}
              onChange={(e) => setBack(e.target.checked)}
            />
            Round trip
          </label>
        </div>
      )}
      <div className="results-heading">
        <span>
          {tripBusy
            ? "COMPARING REAL JOURNEYS…"
            : busy
              ? "FINDING YOUR FASTEST WAY"
              : chain
                ? "SMARTEST ORDER"
                : results.length
                  ? `${results.length} PLACES · FASTEST FIRST`
                  : "DISCOVER YOUR NEIGHBORHOOD"}
        </span>
        {busy || tripBusy ? (
          <span>{tripBusy ? "…" : `${progress[0]}/${progress[1] || "…"}`}</span>
        ) : (
          <Zap size={14} />
        )}
      </div>
      {busy && <RouteHunt compare={tripBusy} progress={progress} />}
      {chain && chainNote && <p className="chain-note">{chainNote}</p>}
      {chain && (
        <div className="timeline">
          {chain.visits.map((v, i) => (
            <div key={v.stop.id}>
              <small>
                {time(v.trip.endTime)} · STOP {i + 1}
              </small>
              <h3>{v.place.name}</h3>
              {v.place.address && (
                <p className="chain-addr">{v.place.address}</p>
              )}
              <p>
                {minutes(v.trip.duration)} min travel · {v.stop.dwell} min stay
              </p>
              <RouteChips trip={v.trip} preferences={controller.preferences} />
            </div>
          ))}
          {chain.returnTrip && (
            <div>
              <small>{time(chain.returnTrip.endTime)}</small>
              <h3>Back at your start</h3>
              <RouteChips
                trip={chain.returnTrip}
                preferences={controller.preferences}
              />
            </div>
          )}
        </div>
      )}
      {/* STAGE-3: live departures that leave before a planned arrival */}
      {chain &&
        chainWarnings.map((w, i) => (
          <p className="chain-warning" key={i}>
            {w}
          </p>
        ))}
      <div className="results" onMouseLeave={() => setHover([])}>
        {results.map((r, i) => {
          const shown = selected === r && activeTrip ? activeTrip : r.trip;
          const gd = gdetails[r.place.id];
          const gline = gd ? detailSummary(gd) : "";
          return (
            <div
              className={
                "result " +
                (selected === r && !chain ? "selected" : "") +
                (controller.preferences.budgetOnly && (gd?.priceLevel ?? 0) > 2
                  ? " over-budget"
                  : "")
              }
              key={r.place.id}
            >
              <button
                className="result-main"
                onMouseEnter={() =>
                  setHover([
                    r.place,
                    ...results
                      .filter((o) => o !== r && distance(o.place, r.place) <= 1)
                      .map((o) => o.place),
                  ])
                }
                onClick={() => {
                  setSelected(r);
                  setChain(null);
                }}
              >
                <span className="rank">{String(i + 1).padStart(2, "0")}</span>
                <div className="result-info">
                  <h3>
                    {r.place.name}
                    {controller.preferences.verifiedOnly &&
                      (r.place.confidence ?? 0) >= 0.9 && (
                        <span className="verified-dot" title="Verified place" />
                      )}
                  </h3>
                  <p>
                    {r.distance.toFixed(1)} km away
                    {r.place.address ? ` · ${r.place.address}` : ""} · Arrive{" "}
                    {time(shown.endTime)}
                  </p>
                  <RouteChips
                    trip={shown}
                    preferences={controller.preferences}
                  />
                  {gline && (
                    <small className="gmaps-line">
                      {gline}
                      <b>Google</b>
                    </small>
                  )}
                  {i + 1 !== r.distanceRank && (
                    <small className="ranking">
                      #{i + 1} by time · #{r.distanceRank} by distance
                    </small>
                  )}
                </div>
                <div className="duration">
                  <strong>{minutes(shown.duration)}</strong>
                  <span>
                    min <ChevronRight size={12} />
                  </span>
                </div>
              </button>
              <button
                className="add-place"
                title="Add as another stop"
                onClick={() => addToTrip(r.place)}
                disabled={destinations >= 4}
              >
                <Plus size={12} /> Add to trip
              </button>
              <GmapsLink place={r.place} />
            </div>
          );
        })}
        {!results.length && !busy && !tripBusy && !chain && (
          <div className="empty">
            <div className="empty-icon">
              <Layers size={26} />
            </div>
            <h3>
              {query ? "No places found yet" : "Search to see journey times"}
            </h3>
            <p>
              {query
                ? "Try another category or search term."
                : "Choose a category or search a place. Separate stops with + for a multi-stop trip — we’ll find the smartest order."}
            </p>
            <div className="empty-facts">
              <span>20 km search area</span>
              <span>Live transit routing</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
