import {
  Clock3,
  LocateFixed,
  Navigation,
  Route,
  Search,
  X,
} from "lucide-react";
import { search } from "./api";
import { minutes, time, transfers } from "./display";
import { MultiStopPlanner } from "./MultiStopPlanner";
import { ResultsList } from "./ResultsList";
import type { TransitController } from "./useTimeTransit";
export function Panel({ controller }: { controller: TransitController }) {
  const {
    origin,
    selected,
    error,
    setError,
    tab,
    setTab,
    picking,
    setPicking,
    departure,
    setDeparture,
    stops,
    chain,
    originSearch,
    setOriginSearch,
    originOptions,
    setOriginOptions,
    changeOrigin,
    locate,
  } = controller;
  return (
    <aside className="panel">
      <div className="panel-heading">
        <div className="eyebrow">LESS COMMUTE. MORE CITY.</div>
        <h1>
          Closer is a matter
          <br />
          of <span>time.</span>
        </h1>
        <p>Your city, ranked by the journey. Not the radius.</p>
      </div>
      <div className="origin-box">
        <span className="tiny-dot" />
        <div>
          <small>STARTING FROM</small>
          <strong>{origin.name}</strong>
        </div>
        <button title="Use my location" onClick={locate}>
          <LocateFixed size={17} />
        </button>
        <button
          className={picking ? "blue" : ""}
          title="Pick origin on map"
          onClick={() => setPicking(!picking)}
        >
          <Navigation size={16} />
        </button>
      </div>
      {picking && (
        <p className="notice">Click anywhere on the map to set your origin.</p>
      )}
      <form
        className="address-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setOriginOptions(await search(originSearch, origin));
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <input
          aria-label="Origin address"
          placeholder="Or search a starting address"
          value={originSearch}
          onChange={(e) => setOriginSearch(e.target.value)}
        />
        <button title="Find address">
          <Search size={14} />
        </button>
      </form>
      {originOptions.map((p) => (
        <button
          className="address-option"
          key={p.id}
          onClick={() => {
            changeOrigin(p);
            setOriginOptions([]);
            setOriginSearch("");
          }}
        >
          {p.name} <small>{p.address}</small>
        </button>
      ))}
      <div className="tabs">
        <button
          className={tab === "explore" ? "chosen" : ""}
          onClick={() => setTab("explore")}
        >
          <Search size={15} />
          Explore
        </button>
        <button
          className={tab === "trip" ? "chosen" : ""}
          onClick={() => setTab("trip")}
        >
          <Route size={15} />
          Multi-stop trip {stops.length > 0 && <b>{stops.length}</b>}
        </button>
      </div>
      <div className="departure">
        <Clock3 size={14} />
        <span>Departure</span>
        <select
          aria-label="Departure mode"
          value={departure ? "pick" : "now"}
          onChange={(e) =>
            setDeparture(
              e.target.value === "now"
                ? ""
                : new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16),
            )
          }
        >
          <option value="now">Leave now</option>
          <option value="pick">Pick a time</option>
        </select>
        {departure && (
          <input
            aria-label="Departure time"
            type="datetime-local"
            value={departure}
            onChange={(e) => setDeparture(e.target.value)}
          />
        )}
      </div>
      {tab === "explore" ? (
        <ResultsList controller={controller} />
      ) : (
        <MultiStopPlanner controller={controller} />
      )}
      {error && (
        <div role="alert" className="error">
          <span>{error}</span>
          <button title="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {selected && tab === "explore" && !chain && (
        <details className="directions">
          <summary>
            Journey details <span>{transfers(selected.trip.transfers)}</span>
          </summary>
          {selected.trip.legs.map((l, i) => (
            <div className="leg" key={i}>
              <span
                style={{
                  background:
                    l.mode === "WALK"
                      ? "#738a9e"
                      : `#${(l.routeColor || "339aff").replace("#", "")}`,
                }}
              />
              <div>
                <strong>
                  {l.mode === "WALK"
                    ? "Walk"
                    : `${l.mode} ${l.routeShortName || ""}`}
                </strong>
                <p>
                  {l.from.name} → {l.to.name}
                </p>
                <small>
                  {time(l.startTime)} – {time(l.endTime)} ·{" "}
                  {minutes(l.duration)} min {l.headsign && `· ${l.headsign}`}
                </small>
              </div>
            </div>
          ))}
        </details>
      )}
      <footer>
        <span className="live-dot" /> Powered by local transit · No car required
      </footer>
    </aside>
  );
}
