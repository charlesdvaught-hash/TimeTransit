import { Clock3, LocateFixed, Navigation, Search, X } from "lucide-react";
import { searchOrigin } from "./api";
import { PreferencesPanel } from "./PreferencesPanel";
import { ReliabilityPanel } from "./ReliabilityPanel";
import { delayText, minutes, time, transfers } from "./display";
import { ResultsList } from "./ResultsList";
import type { TransitController } from "./useTimeTransit";
export function Panel({ controller }: { controller: TransitController }) {
  const {
    origin,
    selected,
    error,
    setError,
    picking,
    setPicking,
    departure,
    setDeparture,
    chain,
    originSearch,
    setOriginSearch,
    originOptions,
    setOriginOptions,
    liveDepartures,
    locating,
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
        <button title="Use my location" onClick={locate} disabled={locating}>
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
      <button className="use-location" onClick={locate} disabled={locating}>
        <LocateFixed size={13} />
        {locating ? "Locating…" : "Use my location"}
      </button>
      <form
        className="address-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setOriginOptions(await searchOrigin(originSearch, origin));
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
      <PreferencesPanel controller={controller} />
      <ReliabilityPanel />
      <ResultsList controller={controller} />
      {error && (
        <div role="alert" className="error">
          <span>{error}</span>
          <button title="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {selected && !chain && (
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
                {liveDepartures[i] && (
                  <small className="live-departure">
                    {liveDepartures[i].cancelled
                      ? `Cancelled${liveDepartures[i].network ? ` · ${liveDepartures[i].network}` : ""}`
                      : liveDepartures[i].realtime
                        ? `Live: departs ${time(liveDepartures[i].expectedTime)} · ${delayText(liveDepartures[i].delay)}${liveDepartures[i].network ? ` · ${liveDepartures[i].network}` : ""}`
                        : `Scheduled only · no realtime${liveDepartures[i].network ? ` · ${liveDepartures[i].network}` : ""}`}
                  </small>
                )}
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
