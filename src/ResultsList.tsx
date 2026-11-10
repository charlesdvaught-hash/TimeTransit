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
    progress,
    stops,
    chain,
    setChain,
    run,
    addStop,
  } = controller;
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
          placeholder="Where do you want to go?"
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
      <div className="results-heading">
        <span>
          {busy
            ? "FINDING YOUR FASTEST WAY"
            : results.length
              ? `${results.length} PLACES · FASTEST FIRST`
              : "DISCOVER YOUR NEIGHBORHOOD"}
        </span>
        {busy ? (
          <span>
            {progress[0]}/{progress[1] || "…"}
          </span>
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
              onClick={() => addStop(r.place)}
              disabled={stops.length >= 4}
            >
              <Plus size={12} /> Add to trip
            </button>
          </div>
        ))}
        {!results.length && !busy && (
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
                : "Choose a category or search a place. We’ll find what’s actually quickest to reach."}
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
