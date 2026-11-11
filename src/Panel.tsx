import { useEffect, useState } from "react";
import { Clock3, LocateFixed, Navigation, Search, X } from "lucide-react";
import { searchOrigin } from "./api";
import { SettingsPanel } from "./SettingsPanel";
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
    trip,
    liveDepartures,
    liveChoice,
    locating,
    changeOrigin,
    locate,
  } = controller;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (selected) setCollapsed(false);
  }, [selected]);
  const gps = origin.id === "gps";
  return (
    <aside className={collapsed ? "panel collapsed" : "panel"}>
      <button
        className="panel-grabber"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand trip panel" : "Collapse trip panel"}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span />
      </button>
      <div className="origin-box">
        <span className="tiny-dot" />
        <div>
          <small>STARTING FROM</small>
          <strong>{origin.name}</strong>
        </div>
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
      {!gps && (
        <button className="use-location" onClick={locate} disabled={locating}>
          <LocateFixed size={13} />
          {locating ? "Locating…" : "Use my location"}
        </button>
      )}
      <details className="utility-panel origin-tools">
        <summary>{gps ? "Change start" : "Start options"}</summary>
        {gps && (
          <button className="use-location" onClick={locate} disabled={locating}>
            <LocateFixed size={13} />
            {locating ? "Locating…" : "Re-locate me"}
          </button>
        )}
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
      </details>
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
      <SettingsPanel controller={controller} />
      <ResultsList controller={controller} />
      {error && (
        <div role="alert" className="error">
          <span>{error}</span>
          <button title="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {selected &&
        trip &&
        !chain &&
        liveChoice &&
        liveChoice.options.length > 1 && (
          <p className="live-choice">
            Live check: {liveChoice.options.length} routes ·{" "}
            {liveChoice.trip === selected.trip
              ? "scheduled fastest still best"
              : "switched to the earliest live arrival"}
          </p>
        )}
      {selected && trip && !chain && (
        <details className="directions">
          <summary>
            Journey details <span>{transfers(trip.transfers)}</span>
          </summary>
          {trip.legs.map((l, i) => (
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
    </aside>
  );
}
