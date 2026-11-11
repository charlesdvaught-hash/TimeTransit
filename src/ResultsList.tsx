import {
  ArrowUpRight,
  Banknote,
  BookOpen,
  ChevronRight,
  Coffee,
  Dumbbell,
  Hammer,
  Layers,
  MapPin,
  Pill,
  Plus,
  Search,
  ShoppingBasket,
  Stethoscope,
  Trees,
  UtensilsCrossed,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { suggest } from "./api";
import { categories, suggestCategories, type Place } from "./core";
import { mergeSuggestions, nameScore, type Suggestion } from "./suggestions";
import { tomtomSuggest } from "./tomtom";
import { loadPlaces, searchPlaces } from "./places";
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
    stopPins,
    setStopPin,
    run,
    addToTrip,
    pinPlace,
  } = controller;
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [alts, setAlts] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
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
      return;
    }
    const c = new AbortController();
    loadPlaces(); // warm the local POI index while the user types
    const timer = setTimeout(() => {
      const types: Suggestion[] = suggestCategories(segment)
        .slice(0, 4)
        .map((label) => ({
          id: `type-${label}`,
          kind: "type",
          label,
          detail: "Type of place",
        }));
      setSuggestions(types);
      setActive(0);
      const photon: Place[] = [];
      const tomtom: Place[] = [];
      const publish = () => {
        if (c.signal.aborted) return;
        const places = mergeSuggestions(
          segment,
          photon,
          tomtom,
          searchPlaces(segment, origin),
        );
        const exact =
          places.length > 0 && nameScore(segment, places[0].label) >= 500;
        const list = (
          exact ? [...places, ...types] : [...types, ...places]
        ).slice(0, 10);
        setSuggestions(list);
        setActive((a) => Math.min(a, list.length - 1));
      };
      loadPlaces().then(() => publish()); // re-publish once the index lands
      suggest(segment, origin, c.signal)
        .then((places) => {
          photon.push(...places);
          publish();
        })
        .catch(() => {});
      tomtomSuggest(segment, origin, c.signal)
        .then((places) => {
          tomtom.push(...places);
          publish();
        })
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [segment, focused, origin]);
  function choose(s: Suggestion) {
    const parts = query.split("+");
    parts[current.index] = s.label;
    const next = parts.map((p) => p.trim()).join(" + ");
    setQuery(next);
    setFocused(false);
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
            aria-expanded={focused && suggestions.length > 0}
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
        {focused && suggestions.length > 0 && (
          <div
            className="suggestions"
            id="destination-suggestions"
            role="listbox"
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
                  onMouseEnter={() => setActive(i)}
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
            {suggestions.some((s) => s.place?.id.startsWith("tomtom-")) && (
              <small className="suggestions-credit">Places © TomTom</small>
            )}
          </div>
        )}
      </div>
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
            {slots.map((label, i) => (
              <label className="trip-stop" key={`${label}-${i}`}>
                <span className="trip-stop-index">{i + 1}</span>
                <button
                  type="button"
                  className={`trip-pin${stopPins[i] ? " set" : ""}`}
                  title={`Order pin: ${stopPins[i] || "free"} (click to cycle)`}
                  aria-label={`Pin stop ${i + 1} order: ${stopPins[i] || "free"}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const cycle = [
                      undefined,
                      "first",
                      "middle",
                      "last",
                    ] as const;
                    setStopPin(
                      i,
                      cycle[(cycle.indexOf(stopPins[i]) + 1) % cycle.length],
                    );
                  }}
                >
                  {stopPins[i] === "first"
                    ? "^"
                    : stopPins[i] === "last"
                      ? "$"
                      : stopPins[i] === "middle"
                        ? "~"
                        : "·"}
                </button>
                <span className="trip-stop-name">{label || "Next stop"}</span>
                <input
                  aria-label={`Stay minutes at ${label || `stop ${i + 1}`}`}
                  type="number"
                  min="0"
                  max="240"
                  value={dwells[i] ?? dwell}
                  onChange={(e) => setStopDwell(i, Number(e.target.value))}
                />
                <small>min</small>
              </label>
            ))}
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
      {busy && (
        <div className="progress">
          <i
            style={{
              width: `${progress[1] ? (progress[0] / progress[1]) * 100 : 10}%`,
            }}
          />
        </div>
      )}
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
      <div className="results">
        {results.map((r, i) => {
          const shown = selected === r && activeTrip ? activeTrip : r.trip;
          return (
            <div
              className={
                "result " + (selected === r && !chain ? "selected" : "")
              }
              key={r.place.id}
            >
              <button
                className="result-main"
                onClick={() => {
                  setSelected(r);
                  setChain(null);
                }}
              >
                <span className="rank">{String(i + 1).padStart(2, "0")}</span>
                <div className="result-info">
                  <h3>{r.place.name}</h3>
                  <p>
                    {r.distance.toFixed(1)} km away
                    {r.place.address ? ` · ${r.place.address}` : ""} · Arrive{" "}
                    {time(shown.endTime)}
                  </p>
                  <RouteChips
                    trip={shown}
                    preferences={controller.preferences}
                  />
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
