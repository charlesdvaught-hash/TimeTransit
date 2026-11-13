import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  LocateFixed,
  Navigation,
  Search,
  Share2,
  Star,
  TriangleAlert,
  X,
} from "lucide-react";
import { alertsFor } from "./gtfsrt"; // WAVE-2
import { searchOrigin } from "./api";
import { shareJourney } from "./shareUtils";
import { SettingsPanel } from "./SettingsPanel";
import { delayText, minutes, time, transfers } from "./display";
import { ResultsList } from "./ResultsList";
import { AdventureAssistant } from "./AdventureAssistant"; // STAGE-6
import type { TransitController } from "./useTimeTransit";

// Touch-friendly departure/arrival picker: ‹ › steppers (15-min and 1-day)
// plus tap-the-value dropdowns for hour/minute/AM-PM and day jumps —
// replaces the native datetime-local input whose tiny icons were the
// mobile pain point.
function WhenPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState<"" | "time" | "date">("");
  const d = new Date(value);
  if (isNaN(+d)) return null;
  const toLocal = (x: Date) =>
    new Date(x.getTime() - x.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  const bump = (mins: number) =>
    onChange(toLocal(new Date(d.getTime() + mins * 60000)));
  const bumpDay = (days: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    onChange(toLocal(x));
  };
  const setPart = (patch: { h?: number; m?: number; day?: number }) => {
    const x = new Date(d);
    if (patch.day !== undefined) x.setDate(patch.day);
    if (patch.h !== undefined) x.setHours(patch.h);
    if (patch.m !== undefined) x.setMinutes(patch.m);
    onChange(toLocal(x));
  };
  const h12 = d.getHours() % 12 || 12;
  const pm = d.getHours() >= 12;
  const days = Array.from({ length: 62 }, (_, i) => {
    const x = new Date();
    x.setDate(x.getDate() + i);
    return x;
  });
  return (
    <span className="when">
      <span className="when-chip">
        <button aria-label="Earlier time" onClick={() => bump(-15)}>
          <ChevronLeft size={14} />
        </button>
        <button
          className="when-value"
          aria-expanded={open === "time"}
          onClick={() => setOpen(open === "time" ? "" : "time")}
        >
          {d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </button>
        <button aria-label="Later time" onClick={() => bump(15)}>
          <ChevronRight size={14} />
        </button>
        {open === "time" && (
          <span className="when-drop">
            <select
              aria-label="Hour"
              value={h12}
              onChange={(e) =>
                setPart({
                  h: (+e.target.value % 12) + (pm ? 12 : 0),
                })
              }
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
            <select
              aria-label="Minute"
              value={Math.floor(d.getMinutes() / 15) * 15}
              onChange={(e) => setPart({ m: +e.target.value })}
            >
              {[0, 15, 30, 45].map((m) => (
                <option key={m} value={m}>
                  :{String(m).padStart(2, "0")}
                </option>
              ))}
            </select>
            <select
              aria-label="AM or PM"
              value={pm ? "PM" : "AM"}
              onChange={(e) =>
                setPart({ h: (h12 % 12) + (e.target.value === "PM" ? 12 : 0) })
              }
            >
              <option>AM</option>
              <option>PM</option>
            </select>
          </span>
        )}
      </span>
      <span className="when-chip">
        <button aria-label="Previous day" onClick={() => bumpDay(-1)}>
          <ChevronLeft size={14} />
        </button>
        <button
          className="when-value"
          aria-expanded={open === "date"}
          onClick={() => setOpen(open === "date" ? "" : "date")}
        >
          {d.toLocaleDateString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </button>
        <button aria-label="Next day" onClick={() => bumpDay(1)}>
          <ChevronRight size={14} />
        </button>
        {open === "date" && (
          <span className="when-drop">
            <select
              aria-label="Day"
              value={days.findIndex(
                (x) =>
                  x.getDate() === d.getDate() && x.getMonth() === d.getMonth(),
              )}
              onChange={(e) => {
                const x = new Date(days[+e.target.value]);
                x.setHours(d.getHours(), d.getMinutes());
                onChange(toLocal(x));
              }}
            >
              {days.map((x, i) => (
                <option key={i} value={i}>
                  {i === 0
                    ? "Today"
                    : i === 1
                      ? "Tomorrow"
                      : x.toLocaleDateString([], {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                </option>
              ))}
            </select>
          </span>
        )}
      </span>
    </span>
  );
}

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
    isFavorite,
    toggleFavorite,
    alerts,
    ridePois,
    offlineCache,
  } = controller;
  type Snap = "peek" | "half" | "full";
  const SNAPS: Snap[] = ["peek", "half", "full"];
  const [snap, setSnap] = useState<Snap>("peek");
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const aside = useRef<HTMLElement>(null);
  // Collapsed by default — the map is the content. Expand only when there's
  // a journey or an error worth looking at; tap the grabber to peek back.
  useEffect(() => {
    if (selected || chain || error) setSnap("half");
  }, [selected, chain, error]);
  useEffect(() => {
    document.documentElement.dataset.sheet = snap;
  }, [snap]);
  const onGrabMove = (e: PointerEvent) => {
    if (!drag.current || !aside.current) return;
    const dy = e.clientY - drag.current.y;
    drag.current.dy = dy;
    aside.current.classList.add("dragging");
    aside.current.style.transform = `translateY(${Math.min(aside.current.offsetHeight - 88, Math.max(0, dy))}px)`;
  };
  const onGrabEnd = () => {
    const dy = drag.current?.dy ?? 0;
    drag.current = null;
    if (aside.current) {
      aside.current.classList.remove("dragging");
      aside.current.style.transform = "";
    }
    const i = SNAPS.indexOf(snap);
    if (dy < -60 && i < SNAPS.length - 1) setSnap(SNAPS[i + 1]);
    else if (dy > 60 && i > 0) setSnap(SNAPS[i - 1]);
    else if (Math.abs(dy) < 8) setSnap(snap === "peek" ? "half" : "peek");
  };
  const gps = origin.id === "gps";
  return (
    <aside ref={aside} className={`panel snap-${snap}`}>
      <button
        className="panel-grabber"
        aria-expanded={snap !== "peek"}
        aria-label={
          snap === "peek" ? "Expand trip panel" : "Collapse trip panel"
        }
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, dy: 0 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={onGrabMove}
        onPointerUp={onGrabEnd}
        onPointerCancel={onGrabEnd}
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
      <div className="panel-body">
        <details className="utility-panel origin-tools">
          <summary>Change start</summary>
          <button className="use-location" onClick={locate} disabled={locating}>
            <LocateFixed size={13} />
            {locating ? "Locating…" : gps ? "Re-locate me" : "Use my location"}
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
        </details>
        <div className="departure">
          <Clock3 size={14} />
          <span>
            {controller.timeMode === "arrive" ? "Arrival" : "Departure"}
          </span>
          <select
            aria-label="Departure mode"
            value={controller.timeMode}
            onChange={(e) => {
              const v = e.target.value as "now" | "depart" | "arrive";
              controller.setTimeMode(v);
              if (v !== "now" && !departure) {
                const seed = new Date(Math.ceil(Date.now() / 900000) * 900000);
                setDeparture(
                  new Date(seed.getTime() - seed.getTimezoneOffset() * 60000)
                    .toISOString()
                    .slice(0, 16),
                );
              }
            }}
          >
            <option value="now">Leave now</option>
            <option value="depart">Leave at</option>
            <option value="arrive">Arrive by</option>
          </select>
          {controller.timeMode !== "now" && (
            <WhenPicker value={departure} onChange={setDeparture} />
          )}
        </div>
        {offlineCache && (
          <p className="offline-pill" role="status">
            Offline — cached trip
          </p>
        )}
        {controller.preferences.aiMode === "full" && ( // STAGE-6
          <AdventureAssistant controller={controller} />
        )}
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
              <button
                className="share-btn"
                title="Share this journey"
                aria-label="Share this journey"
                onClick={async (e) => {
                  e.preventDefault();
                  const r = await shareJourney(
                    origin,
                    selected.place,
                    `${origin.name} → ${selected.place.name}, ${minutes(trip.duration)} min by transit`,
                  );
                  if (r === "copied") setError("Link copied to clipboard.");
                }}
              >
                <Share2 size={13} />
              </button>
            </summary>
            {trip.legs.map((l, i) => {
              const legAlerts =
                l.mode === "WALK"
                  ? []
                  : alertsFor(alerts, {
                      routeId: l.routeId,
                      routeName:
                        l.routeShortName || liveDepartures[i]?.routeName,
                      stopId: l.from.stopId,
                    });
              return (
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
                      {l.mode !== "WALK" && (
                        <button
                          className={isFavorite(l) ? "fav-star on" : "fav-star"}
                          title={
                            isFavorite(l)
                              ? "Remove favorite line"
                              : "Favorite this line"
                          }
                          aria-label={
                            isFavorite(l)
                              ? `Unfavorite line ${l.routeShortName || l.mode}`
                              : `Favorite line ${l.routeShortName || l.mode}`
                          }
                          aria-pressed={isFavorite(l)}
                          onClick={(e) => {
                            e.preventDefault();
                            toggleFavorite(l);
                          }}
                        >
                          <Star
                            size={12}
                            fill={isFavorite(l) ? "currentColor" : "none"}
                          />
                        </button>
                      )}
                    </strong>
                    <p>
                      {l.from.name} → {l.to.name}
                    </p>
                    <small>
                      {time(l.startTime)} – {time(l.endTime)} ·{" "}
                      {minutes(l.duration)} min{" "}
                      {l.headsign && `· ${l.headsign}`}
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
                    {!!legAlerts.length && (
                      <details className="leg-alert">
                        <summary>
                          <TriangleAlert size={11} /> Service alert ·{" "}
                          {legAlerts[0].header || "Details"}
                        </summary>
                        {legAlerts.map((a, j) => (
                          <p key={j}>
                            {a.header && <strong>{a.header}</strong>}
                            {a.description}
                          </p>
                        ))}
                      </details>
                    )}
                  </div>
                </div>
              );
            })}
          </details>
        )}
        {!!ridePois.length && (
          <div className="ride-pois">
            <small>NEAR YOUR STOP</small>
            <div className="ride-poi-strip">
              {ridePois.map((p) => (
                <span className="ride-poi" key={p.id}>
                  <strong>{p.name}</strong>
                  {p.kind && <em>{p.kind}</em>}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
