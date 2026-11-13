import {
  Compass,
  Crosshair,
  Locate,
  Minus,
  MoonStar,
  Navigation,
  Plus,
  Satellite,
} from "lucide-react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import { basemapStyles } from "./basemap";
import { arrowField, loadNetwork, type ArrowField } from "./networkGeo";
import {
  AMBIENT_HIT_LAYERS,
  applyRidingView,
  attachScanRing,
  clearRidePois,
  corridorFeatures,
  ensureUserLayers,
  followUserCamera,
  paintAmbient,
  paintRidePois,
  paintVehicles,
  paintRoute,
  pulseNetworkGlow,
  removeUserLayers,
  restoreRidingView,
  routeLineFeatures,
  tickAmbient,
} from "./mapLayers";
import { nearestPlaces } from "./places";
import { routeInfoAt, type NearbyDeparture, type RouteInfo } from "./transit";
import { departuresNearChained } from "./fallbackEta";
import { hasSavedOrigin } from "./preferences";
import { GmapsLink } from "./GmapsLink";
import type { Place } from "./core";
import type { GpsFollowMode, UserPosition } from "./contracts";
import type { TransitController } from "./useTimeTransit";
maplibregl.setWorkerUrl(workerUrl);

export function MapLayer({
  controller,
  userPosition = null,
  ridingView = false,
}: {
  controller: TransitController;
  userPosition?: UserPosition | null;
  ridingView?: boolean;
}) {
  const {
    origin,
    results,
    selected,
    trip,
    setSelected,
    setError,
    picking,
    chain,
    setChain,
    map,
    changeOrigin,
    locate,
    liveBus,
    hover,
    busy,
    basemap,
    chooseBasemap,
    ridePois,
    vehicles,
  } = controller;
  const mapNode = useRef<HTMLDivElement>(null);
  const pickRef = useRef(picking);
  const styled = useRef(false);
  const [followMode, setFollowMode] = useState<GpsFollowMode>("free");
  const [peekMap, setPeekMap] = useState(false);
  const hiddenLayers = useRef<Set<string>>(new Set());
  const lastFollowAt = useRef(0);
  const [routeCard, setRouteCard] = useState<
    | (Partial<RouteInfo> & {
        name: string;
        agency?: string;
        color?: string;
        loading?: boolean;
      })
    | null
  >(null);
  const [placeCard, setPlaceCard] = useState<{
    places: Place[];
    deps?: NearbyDeparture[];
    at: { lat: number; lon: number };
  } | null>(null);
  pickRef.current = picking;
  useEffect(() => {
    const m = new maplibregl.Map({
      container: mapNode.current!,
      style: basemapStyles[basemap],
      center: [origin.lon, origin.lat],
      zoom: 12.8,
      pitch: 20,
      attributionControl: { compact: true },
    });
    map.current = m;
    m.on("click", (e) => {
      if (pickRef.current) {
        changeOrigin({
          id: "pin",
          name: "Pinned location",
          lat: e.lngLat.lat,
          lon: e.lngLat.lng,
        });
        return;
      }
      // tapped a route line? show its stops + next departures.
      // query a 12px box — thin lines (and dash gaps) are hard to hit,
      // and the fat glow layer makes a generous target.
      const ambientLayers = AMBIENT_HIT_LAYERS.filter((l) => m.getLayer(l));
      const hit = ambientLayers.length
        ? m.queryRenderedFeatures(
            [
              [e.point.x - 12, e.point.y - 12],
              [e.point.x + 12, e.point.y + 12],
            ],
            { layers: ambientLayers },
          )[0]
        : undefined;
      if (hit?.properties?.n && hit.properties.n !== "?") {
        const p = hit.properties;
        setRouteCard({
          name: p.n,
          agency: p.a,
          color: p.c,
          loading: true,
        });
        routeInfoAt(p.n, p.a, {
          lat: e.lngLat.lat,
          lon: e.lngLat.lng,
        })
          .then((info) =>
            setRouteCard((c) =>
              c?.name === p.n ? { ...c, ...info, loading: false } : c,
            ),
          )
          .catch(() =>
            setRouteCard((c) =>
              c?.name === p.n ? { ...c, loading: false } : c,
            ),
          );
        setPlaceCard(null);
        return;
      }
      // otherwise: what's here? nearest places + stops/departures
      const at = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      const places = nearestPlaces(at);
      setPlaceCard({ places, at });
      setRouteCard(null);
      departuresNearChained(at, undefined, { mode: "planning" })
        .then((deps) =>
          setPlaceCard((c) => (c?.at === at ? { ...c, deps } : c)),
        )
        .catch(() => {});
    });
    m.on("error", (e) => {
      if (e.error?.message) setError(`Map: ${e.error.message}`);
    });
    // any manual pan drops follow mode back to free
    m.on("dragstart", () => setFollowMode("free"));
    if (!hasSavedOrigin()) locate();

    // Ambient route network — one directional line per unique pattern,
    // tinted by route color. Dark: flowing "current" dashes + glow.
    // Satellite: arrows that physically creep along each line.
    let ambientFC: GeoJSON.FeatureCollection | null = null;
    let stopsFC: GeoJSON.FeatureCollection | null = null;
    let arrows: ArrowField = [];
    const drawAmbient = () => {
      if (!ambientFC) return;
      try {
        paintAmbient(m, ambientFC, stopsFC, arrows);
      } catch (e) {
        setError(
          `Ambient layer: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };
    loadNetwork()
      .then((net) => {
        if (!net) return;
        ambientFC = net.lines;
        stopsFC = net.stops;
        arrows = arrowField(ambientFC);
        drawAmbient();
      })
      .catch((e) =>
        setError(
          `Network layer: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    m.on("style.load", drawAmbient);
    // One loop drives both modes: dash phase on dark, arrow creep on sat.
    // Skipped entirely when the user prefers reduced motion — static
    // lines/arrows still draw, they just don't animate.
    const still = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let phase = 0,
      last = performance.now();
    const beat = still
      ? 0
      : setInterval(() => {
          const now = performance.now(),
            dt = (now - last) / 1000;
          last = now;
          phase = tickAmbient(m, arrows, dt, phase);
        }, 90);
    return () => {
      clearInterval(beat);
      m.remove();
    };
  }, []);
  useEffect(() => {
    map.current
      ?.getContainer()
      .classList.toggle("satellite", basemap === "satellite");
    if (!styled.current) {
      styled.current = true;
      return;
    }
    map.current?.setStyle(basemapStyles[basemap]);
  }, [basemap]);
  const trips = chain
    ? [
        ...chain.visits.map((v) => v.trip),
        ...(chain.returnTrip ? [chain.returnTrip] : []),
      ]
    : trip
      ? [trip]
      : [];
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const markers: maplibregl.Marker[] = [];
    const corridors = corridorFeatures(
      chain ? trips : results.map((r) => r.trip),
    );
    const features = routeLineFeatures(trips, basemap === "satellite");
    const draw = () => paintRoute(m, features, corridors);
    if (m.isStyleLoaded()) draw();
    m.on("style.load", draw);
    let frame = 0;
    if (
      corridors.length &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      let last = 0;
      const pulse = (now: number) => {
        if (now - last > 45) {
          last = now;
          pulseNetworkGlow(m, now);
        }
        frame = requestAnimationFrame(pulse);
      };
      frame = requestAnimationFrame(pulse);
    }
    const dot = document.createElement("div");
    dot.className = "origin-dot";
    markers.push(
      new maplibregl.Marker({ element: dot })
        .setLngLat([origin.lon, origin.lat])
        .addTo(m),
    );
    (chain
      ? chain.visits.map((v) => v.place)
      : results.map((r) => r.place)
    ).forEach((p, i) => {
      const el = document.createElement(chain ? "span" : "button");
      el.className =
        "map-pin" +
        (chain ? " trip-pin" : selected?.place.id === p.id ? " active" : "");
      el.textContent = String(i + 1);
      el.title = p.name;
      el.setAttribute("aria-label", `${i + 1}. ${p.name}`);
      if (!chain)
        el.onclick = () => {
          const r = results.find((r) => r.place.id === p.id);
          if (r) {
            setSelected(r);
            setChain(null);
          }
        };
      markers.push(
        new maplibregl.Marker({ element: el })
          .setLngLat([p.lon, p.lat])
          .addTo(m),
      );
    });
    if (liveBus) {
      const el = document.createElement("div");
      el.className = "bus-dot";
      el.title = "Live vehicle position";
      markers.push(
        new maplibregl.Marker({ element: el })
          .setLngLat([liveBus.lon, liveBus.lat])
          .addTo(m),
      );
    }
    return () => {
      m.off("style.load", draw);
      cancelAnimationFrame(frame);
      markers.forEach((x) => x.remove());
    };
  }, [origin, results, selected, trip, chain, basemap, liveBus]);
  // route-hunt radar ping at origin while a search is running
  useEffect(() => {
    const m = map.current;
    if (!m || !busy) return;
    const marker = attachScanRing(m, origin.lon, origin.lat);
    return () => {
      marker.remove();
    };
  }, [busy, origin, basemap]);
  // hover preview — suggestion branches or a result + its nearby neighbors
  useEffect(() => {
    const m = map.current;
    if (!m || !hover.length) return;
    const markers: maplibregl.Marker[] = [];
    hover.slice(0, 14).forEach((p, i) => {
      const el = document.createElement("div");
      el.className = i === 0 ? "hover-pin primary" : "hover-pin";
      el.title = p.name;
      markers.push(
        new maplibregl.Marker({ element: el })
          .setLngLat([p.lon, p.lat])
          .addTo(m),
      );
    });
    return () => markers.forEach((x) => x.remove());
  }, [hover]);
  // Wave-2: subtle pins for "Near your stop" venues around the boarded
  // leg's destination.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = () => paintRidePois(m, ridePois);
    if (m.isStyleLoaded()) draw();
    m.on("style.load", draw);
    return () => {
      m.off("style.load", draw);
      clearRidePois(m);
    };
  }, [ridePois]);
  // ambient live vehicles — OCTA fleet + Metro rail/trip-route buses
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = () => paintVehicles(m, vehicles);
    if (m.isStyleLoaded()) draw();
    m.on("style.load", draw);
    return () => {
      m.off("style.load", draw);
    };
  }, [vehicles]);
  // live user puck — accuracy ring + heading cone + dot, fed by a
  // single GeoJSON source updated on each fix. Meter-sized polygon
  // features (not pixel radii) so they scale correctly with zoom.
  useEffect(() => {
    const m = map.current;
    if (!m || !userPosition) return;
    const ensure = () => ensureUserLayers(m, userPosition);
    ensure();
    m.on("style.load", ensure);
    return () => {
      m.off("style.load", ensure);
    };
  }, [userPosition]);
  // drop the puck entirely when the fix stream stops
  useEffect(() => {
    const m = map.current;
    if (!m || userPosition) return;
    removeUserLayers(m);
  }, [userPosition]);
  // follow FAB behaviour: recenter on each fix (throttled), plus
  // bearing = heading in "heading" mode.
  useEffect(() => {
    const m = map.current;
    if (!m || followMode === "free" || !userPosition) return;
    const now = performance.now();
    if (now - lastFollowAt.current < 1000) return;
    lastFollowAt.current = now;
    followUserCamera(m, userPosition, followMode);
  }, [userPosition, followMode]);
  // Minimized riding view — hide every non-app layer (basemap chrome)
  // and paint a dark matte underneath so the route + puck float.
  // setStyle wipes layer state on basemap change, so re-apply on
  // style.load; restoring only touches layers we actually hid.
  const ridingActive = ridingView && !peekMap;
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const onStyleLoad = () => {
      if (ridingActive) applyRidingView(m, hiddenLayers.current);
    };
    if (ridingActive) applyRidingView(m, hiddenLayers.current);
    else restoreRidingView(m, hiddenLayers.current);
    m.on("style.load", onStyleLoad);
    return () => {
      m.off("style.load", onStyleLoad);
    };
  }, [ridingActive, basemap]);
  // reset peek when the riding view goes away
  useEffect(() => {
    if (!ridingView) setPeekMap(false);
  }, [ridingView]);
  const choose = chooseBasemap;
  const followIcon =
    followMode === "heading" ? (
      <Compass size={17} />
    ) : followMode === "center" ? (
      <Navigation size={17} />
    ) : (
      <Locate size={17} />
    );
  const followTitle =
    followMode === "heading"
      ? "Following your heading — tap for free pan"
      : followMode === "center"
        ? "Following you — tap for heading mode"
        : "Tap to follow your location";
  return (
    <>
      <div ref={mapNode} className="map" />
      {liveBus && (
        <div className="live-badge" title="Live vehicle position">
          <img src="transit-api-badge.svg" alt="Powered by Transit" />
        </div>
      )}
      {routeCard && (
        <div className="map-card">
          <div className="map-card-head">
            <span
              className="route-chip"
              style={{ background: routeCard.color || "#4da3ff" }}
            >
              {routeCard.name}
            </span>
            {routeCard.agency && (
              <span className="map-card-sub">{routeCard.agency}</span>
            )}
            <button aria-label="Close" onClick={() => setRouteCard(null)}>
              ×
            </button>
          </div>
          {routeCard.headsigns?.length ? (
            <p className="map-card-sub">{routeCard.headsigns.join(" ↔ ")}</p>
          ) : null}
          {routeCard.departures?.length ? (
            <p className="map-card-eta">
              Next at {routeCard.stopName}:{" "}
              {routeCard.departures
                .map((d) =>
                  new Date(d.time).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                )
                .join(" · ")}
              {routeCard.departures.some((d) => d.realtime) ? " (live)" : ""}
            </p>
          ) : routeCard.loading ? (
            <p className="map-card-sub">Loading departures…</p>
          ) : null}
          {routeCard.stops && routeCard.stops.length > 0 && (
            <ol className="map-card-stops">
              {routeCard.stops.slice(0, 14).map((s) => (
                <li key={s.id}>{s.name}</li>
              ))}
              {routeCard.stops.length > 14 && (
                <li>… {routeCard.stops.length - 14} more</li>
              )}
            </ol>
          )}
          {!!routeCard.departures?.length && (
            <img
              className="map-card-badge"
              src="transit-api-badge.svg"
              alt="Powered by Transit"
            />
          )}
        </div>
      )}
      {placeCard && (
        <div className="map-card">
          <div className="map-card-head">
            <strong>What's here</strong>
            <button aria-label="Close" onClick={() => setPlaceCard(null)}>
              ×
            </button>
          </div>
          {placeCard.deps && placeCard.deps.length > 0 && (
            <div className="map-card-deps">
              <span className="map-card-sub">Nearby departures</span>
              {placeCard.deps.map((d, i) => (
                <div key={i} className="map-card-dep">
                  <strong>{d.route}</strong>
                  <span>
                    {new Date(d.time).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                    {d.realtime ? " ●" : ""}
                  </span>
                  <span className="map-card-sub">{d.stopName}</span>
                </div>
              ))}
            </div>
          )}
          {placeCard.places.map((p) => (
            <div key={p.id} className="map-card-place">
              <strong>{p.name}</strong>
              {(p.kind || p.address) && (
                <span className="map-card-sub">
                  {[p.kind, p.address].filter(Boolean).join(" · ")}
                </span>
              )}
              <div className="map-card-actions">
                <button onClick={() => controller.run(p.name)}>
                  Route here
                </button>
                <GmapsLink place={p} />
              </div>
            </div>
          ))}
          <a
            className="map-card-link"
            href={`https://www.google.com/maps/search/?api=1&query=${placeCard.at.lat},${placeCard.at.lon}`}
            target="_blank"
            rel="noreferrer"
          >
            Open area in Google Maps
          </a>
          {!!placeCard.deps?.length && (
            <img
              className="map-card-badge"
              src="transit-api-badge.svg"
              alt="Powered by Transit"
            />
          )}
        </div>
      )}
      <div className="basemap-switch" role="group" aria-label="Basemap">
        <button
          className={basemap === "dark" ? "active" : ""}
          aria-pressed={basemap === "dark"}
          onClick={() => choose("dark")}
        >
          <MoonStar size={13} /> Dark
        </button>
        <button
          className={basemap === "satellite" ? "active" : ""}
          aria-pressed={basemap === "satellite"}
          onClick={() => choose("satellite")}
        >
          <Satellite size={13} /> Satellite
        </button>
      </div>
      <div className="map-controls">
        <button
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => map.current?.zoomIn()}
        >
          <Plus size={16} />
        </button>
        <button
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => map.current?.zoomOut()}
        >
          <Minus size={16} />
        </button>
        <button
          title="Use my location"
          aria-label="Use my location"
          onClick={locate}
        >
          <Crosshair size={16} />
        </button>
      </div>
      {userPosition && (
        <button
          className={`follow-fab ${followMode}`}
          title={followTitle}
          aria-label={followTitle}
          aria-pressed={followMode !== "free"}
          onClick={() =>
            setFollowMode((m) =>
              m === "free" ? "center" : m === "center" ? "heading" : "free",
            )
          }
        >
          {followIcon}
        </button>
      )}
      {ridingView && (
        <div
          className="riding-toggle"
          role="group"
          aria-label="Riding map view"
        >
          <button
            className={peekMap ? "active" : ""}
            aria-pressed={peekMap}
            onClick={() => setPeekMap(true)}
          >
            Full map
          </button>
          <button
            className={!peekMap ? "active" : ""}
            aria-pressed={!peekMap}
            onClick={() => setPeekMap(false)}
          >
            Route only
          </button>
        </div>
      )}
    </>
  );
}
