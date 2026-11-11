import {
  ArrowUpRight,
  ChevronRight,
  Layers,
  Plus,
  Search,
  Zap,
} from "lucide-react";
import { categories } from "./core";
import { minutes, time } from "./display";
import { RouteChips } from "./RouteChips";
import type { TransitController } from "./useTimeTransit";
export function ResultsList({ controller }: { controller: TransitController }) {
  const {
    query,
    setQuery,
    results,
    selected,
    setSelected,
    exploreBusy: busy,
    tripBusy,
    progress,
    chain,
    setChain,
    back,
    setBack,
    dwell,
    setDwell,
    run,
    addToTrip,
  } = controller;
  const destinations = query
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean).length;
  return (
    <>
      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
      >
        <Search size={19} />
        <input
          aria-label="Search destinations"
          placeholder="Where to? Separate stops with +"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button title="Search">
          <ArrowUpRight size={20} />
        </button>
      </form>
      <div className="categories">
        {Object.keys(categories).map((c, i) => (
          <button
            className={query === c ? "active" : ""}
            key={c}
            onClick={() => run(c)}
          >
            {["☕", "◈", "✚", "♨", "♧", "▤", "✚", "◇", "▣", "⚒"][i]} {c}
          </button>
        ))}
      </div>
      {destinations >= 2 && (
        <div className="trip-options">
          <label className="return">
            <input
              aria-label="Return to start"
              type="checkbox"
              checked={back}
              onChange={(e) => setBack(e.target.checked)}
            />
            Round trip
          </label>
          <label>
            Stay{" "}
            <input
              aria-label="Stay minutes at each stop"
              type="number"
              min="0"
              max="240"
              value={dwell}
              onChange={(e) => setDwell(Number(e.target.value))}
            />{" "}
            min each
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
      {chain && (
        <div className="timeline">
          {chain.visits.map((v, i) => (
            <div key={v.stop.id}>
              <small>
                {time(v.trip.endTime)} · STOP {i + 1}
              </small>
              <h3>{v.place.name}</h3>
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
        {results.map((r, i) => (
          <div
            className={"result " + (selected === r && !chain ? "selected" : "")}
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
                  {r.distance.toFixed(1)} km away · Arrive{" "}
                  {time(r.trip.endTime)}
                </p>
                <RouteChips
                  trip={r.trip}
                  preferences={controller.preferences}
                />
                {i + 1 !== r.distanceRank && (
                  <small className="ranking">
                    #{i + 1} by time · #{r.distanceRank} by distance
                  </small>
                )}
              </div>
              <div className="duration">
                <strong>{minutes(r.trip.duration)}</strong>
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
        ))}
        {!results.length && !busy && !tripBusy && !chain && (
          <div className="empty">
            <div className="empty-icon">
              <Layers size={26} />
            </div>
            <h3>
              {query ? "No places found yet" : "A better way to get there."}
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
