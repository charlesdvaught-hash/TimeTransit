import { Crosshair, Minus, MoonStar, Plus, Satellite } from "lucide-react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import { basemapStyles } from "./basemap";
import { decode } from "./core";
import {
  advanceArrows,
  arrowField,
  arrowImage,
  loadNetwork,
  type ArrowField,
} from "./networkGeo";
import { nearestPlaces } from "./places";
import {
  departuresNear,
  routeInfoAt,
  type NearbyDeparture,
  type RouteInfo,
} from "./transit";
import { hasSavedOrigin } from "./preferences";
import { GmapsLink } from "./GmapsLink";
import type { Place } from "./core";
import type { TransitController } from "./useTimeTransit";
maplibregl.setWorkerUrl(workerUrl);
export function MapLayer({ controller }: { controller: TransitController }) {
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
  } = controller;
  const mapNode = useRef<HTMLDivElement>(null);
  const pickRef = useRef(picking);
  const styled = useRef(false);
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
      const ambientLayers = [
        "ambient-glow",
        "ambient-flow",
        "ambient-core",
        "ambient-line",
      ].filter((l) => m.getLayer(l));
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
      departuresNear(at)
        .then((deps) =>
          setPlaceCard((c) => (c?.at === at ? { ...c, deps } : c)),
        )
        .catch(() => {});
    });
    m.on("error", (e) => {
      if (e.error?.message) setError(`Map: ${e.error.message}`);
    });
    if (!hasSavedOrigin()) locate();

    // Ambient route network — one directional line per unique pattern,
    // tinted by route color. Dark: flowing "current" dashes + glow.
    // Satellite: arrows that physically creep along each line.
    let ambientFC: GeoJSON.FeatureCollection | null = null;
    let stopsFC: GeoJSON.FeatureCollection | null = null;
    let arrows: ArrowField = [];
    const FLOW = [
      [0, 4, 3],
      [0.5, 4, 2.5],
      [1, 4, 2],
      [1.5, 4, 1.5],
      [2, 4, 1],
      [2.5, 4, 0.5],
      [3, 4, 0],
      [0, 0.5, 3, 3.5],
      [0, 1, 3, 3],
      [0, 1.5, 3, 2.5],
      [0, 2, 3, 2],
      [0, 2.5, 3, 1.5],
      [0, 3, 3, 1],
      [0, 3.5, 3, 0.5],
    ];
    const ambientIds = [
      "ambient-glow",
      "ambient-core",
      "ambient-flow",
      "ambient-line",
      "ambient-arrows",
      "ambient-stops",
    ];
    const drawAmbient = () => {
      // getStyle() is enough — isStyleLoaded() stays false while tiles
      // stream in, which would drop every call.
      if (!ambientFC || !m.getStyle()) return;
      try {
        for (const id of ambientIds) if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource("ambient")) m.removeSource("ambient");
        if (m.getSource("ambient-arrows")) m.removeSource("ambient-arrows");
        if (m.getSource("ambient-stops")) m.removeSource("ambient-stops");
        m.addSource("ambient", { type: "geojson", data: ambientFC });
        const sat = m.getContainer().classList.contains("satellite");
        if (stopsFC) {
          m.addSource("ambient-stops", { type: "geojson", data: stopsFC });
          m.addLayer({
            id: "ambient-stops",
            type: "circle",
            source: "ambient-stops",
            minzoom: 12.5,
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                12.5,
                1.5,
                16,
                4.5,
              ],
              "circle-color": sat ? "#ffd98a" : "#8fd0ff",
              "circle-opacity": 0.9,
              "circle-stroke-width": 1.4,
              "circle-stroke-color": sat ? "#10161f" : "#0a1420",
            },
          });
        }
        if (sat) {
          m.addLayer({
            id: "ambient-line",
            type: "line",
            source: "ambient",
            layout: { "line-cap": "round" },
            paint: {
              "line-color": "#0a0f16",
              "line-width": [
                "interpolate",
                ["exponential", 1.5],
                ["zoom"],
                10,
                3,
                15,
                11,
              ],
              "line-opacity": 0.7,
            },
          });
          m.addLayer({
            id: "ambient-core",
            type: "line",
            source: "ambient",
            layout: { "line-cap": "round" },
            paint: {
              "line-color": "#ffdf94",
              "line-width": [
                "interpolate",
                ["exponential", 1.5],
                ["zoom"],
                10,
                1.4,
                15,
                5,
              ],
              "line-opacity": 0.95,
            },
          });
          m.addSource("ambient-arrows", {
            type: "geojson",
            data: advanceArrows(arrows, 0),
          });
          if (!m.hasImage("net-arrow")) m.addImage("net-arrow", arrowImage());
          m.addLayer({
            id: "ambient-arrows",
            type: "symbol",
            source: "ambient-arrows",
            layout: {
              "icon-image": "net-arrow",
              "icon-size": [
                "interpolate",
                ["linear"],
                ["zoom"],
                10,
                0.3,
                15,
                0.7,
              ],
              "icon-rotate": ["get", "rot"],
              "icon-rotation-alignment": "map",
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
            paint: { "icon-opacity": 0.85 },
          });
        } else {
          m.addLayer({
            id: "ambient-glow",
            type: "line",
            source: "ambient",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ["get", "c"],
              "line-width": [
                "interpolate",
                ["exponential", 1.5],
                ["zoom"],
                10,
                4,
                15,
                20,
              ],
              "line-blur": 10,
              "line-opacity": 0.55,
            },
          });
          m.addLayer({
            id: "ambient-core",
            type: "line",
            source: "ambient",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": ["get", "c"],
              "line-width": [
                "interpolate",
                ["exponential", 1.5],
                ["zoom"],
                10,
                1.6,
                15,
                6,
              ],
              "line-opacity": 0.85,
            },
          });
          m.addLayer({
            id: "ambient-flow",
            type: "line",
            source: "ambient",
            layout: { "line-cap": "round" },
            paint: {
              "line-color": "#ffffff",
              "line-width": [
                "interpolate",
                ["exponential", 1.5],
                ["zoom"],
                10,
                1.6,
                15,
                5,
              ],
              "line-opacity": 0.95,
              "line-dasharray": FLOW[0],
            },
          });
        }
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
          if (m.getLayer("ambient-flow")) {
            phase = (phase + 1) % FLOW.length;
            m.setPaintProperty("ambient-flow", "line-dasharray", FLOW[phase]);
          }
          if (m.getLayer("ambient-arrows"))
            (
              m.getSource("ambient-arrows") as maplibregl.GeoJSONSource
            )?.setData(advanceArrows(arrows, dt));
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
    const seen = new Set<string>();
    const corridors = (chain ? trips : results.map((r) => r.trip))
      .flatMap((t) => t.legs)
      .filter((l) => l.mode !== "WALK" && l.legGeometry)
      .flatMap((l) => {
        const key = `${l.mode}|${l.routeShortName}|${l.legGeometry!.points}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [
          {
            type: "Feature" as const,
            properties: {
              color: `#${(l.routeColor || "4d9eff").replace("#", "")}`,
            },
            geometry: {
              type: "LineString" as const,
              coordinates: decode(
                l.legGeometry!.points,
                l.legGeometry!.precision,
              ),
            },
          },
        ];
      });
    const draw = () => {
      for (const id of [
        "network-glow",
        "network-core",
        "route-casing",
        "route-casing-walk",
        "route-ride",
        "route-walk",
      ])
        if (m.getLayer(id)) m.removeLayer(id);
      if (m.getSource("network")) m.removeSource("network");
      if (m.getSource("route")) m.removeSource("route");
      const features = trips.flatMap((t) =>
        t.legs.map((l) => ({
          type: "Feature" as const,
          properties: {
            walk: l.mode === "WALK",
            color:
              l.mode === "WALK"
                ? basemap === "satellite"
                  ? "#e8f4ff"
                  : "#a8c7da"
                : `#${(l.routeColor || "339aff").replace("#", "")}`,
          },
          geometry: {
            type: "LineString" as const,
            coordinates: l.legGeometry
              ? decode(l.legGeometry.points, l.legGeometry.precision)
              : [
                  [l.from.lon, l.from.lat],
                  [l.to.lon, l.to.lat],
                ],
          },
        })),
      );
      if (corridors.length) {
        m.addSource("network", {
          type: "geojson",
          data: { type: "FeatureCollection", features: corridors },
        });
        m.addLayer({
          id: "network-glow",
          type: "line",
          source: "network",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": 8,
            "line-blur": 6,
            "line-opacity": 0.22,
          },
        });
        m.addLayer({
          id: "network-core",
          type: "line",
          source: "network",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": 2,
            "line-opacity": 0.5,
          },
        });
      }
      m.addSource("route", {
        type: "geojson",
        data: { type: "FeatureCollection", features },
      });
      m.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        filter: ["==", "walk", false],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#04101c",
          "line-width": 13,
          "line-opacity": 0.6,
        },
      });
      m.addLayer({
        id: "route-casing-walk",
        type: "line",
        source: "route",
        filter: ["==", "walk", true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#04101c",
          "line-width": 9,
          "line-opacity": 0.45,
        },
      });
      m.addLayer({
        id: "route-ride",
        type: "line",
        source: "route",
        filter: ["==", "walk", false],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 7.5,
          "line-opacity": 1,
        },
      });
      m.addLayer({
        id: "route-walk",
        type: "line",
        source: "route",
        filter: ["==", "walk", true],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 4,
          "line-dasharray": [1, 2],
        },
      });
      const coords = features.flatMap((f) => f.geometry.coordinates);
      if (coords.length) {
        const bounds = new maplibregl.LngLatBounds();
        coords.forEach((c) => bounds.extend(c as [number, number]));
        m.fitBounds(bounds, {
          padding: {
            left: window.innerWidth > 760 ? 460 : 40,
            right: 70,
            top: 100,
            bottom: window.innerWidth > 760 ? 120 : 360,
          },
          maxZoom: 15,
        });
      }
    };
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
          if (m.getLayer("network-glow")) {
            const amount = 0.5 + 0.5 * Math.sin(now / 900);
            m.setPaintProperty(
              "network-glow",
              "line-opacity",
              0.1 + 0.16 * amount,
            );
            m.setPaintProperty("network-glow", "line-width", 7 + 4 * amount);
          }
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
    const el = document.createElement("div");
    el.className = "scan-ring";
    el.appendChild(document.createElement("i"));
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([origin.lon, origin.lat])
      .addTo(m);
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
  const choose = chooseBasemap;
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
    </>
  );
}
