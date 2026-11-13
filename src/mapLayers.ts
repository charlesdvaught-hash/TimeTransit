// Imperative MapLibre layer management for MapLayer.tsx.
// Each function takes the live map plus plain data — no React, no
// controller state — so the component file stays props→wiring.

import * as maplibregl from "maplibre-gl";
import { decode, type Leg, type Place } from "./core";
import { advanceArrows, arrowImage, type ArrowField } from "./networkGeo";
import type { GpsFollowMode, UserPosition } from "./contracts";

// Every layer id the app itself draws on top of the basemap. The riding
// view hides anything NOT in this list (i.e. basemap chrome: roads,
// labels, imagery) so the route floats on a dark matte.
const MATTE_LAYER = "riding-matte";
const APP_LAYER_PREFIXES = [
  "ambient-",
  "network-",
  "route-",
  "user-",
  "vehicles-",
  MATTE_LAYER,
];
const isAppLayer = (id: string) =>
  APP_LAYER_PREFIXES.some((p) => id.startsWith(p) || id === p);
const USER_LAYERS = [
  "user-accuracy-circle",
  "user-heading-cone",
  "user-puck-dot",
];

// Ambient line ids a tap can hit — the fat glow layer makes a generous
// target for thin lines (and dash gaps).
export const AMBIENT_HIT_LAYERS = [
  "ambient-glow",
  "ambient-flow",
  "ambient-core",
  "ambient-line",
];

const AMBIENT_LAYER_IDS = [
  "ambient-glow",
  "ambient-core",
  "ambient-flow",
  "ambient-line",
  "ambient-arrows",
  "ambient-stops",
];

const ROUTE_LAYER_IDS = [
  "network-glow",
  "network-core",
  "route-casing",
  "route-casing-walk",
  "route-ride",
  "route-walk",
  "route-walk-chevrons",
];

// Dash cycle for the dark-basemap "current" animation — ambient-flow
// steps through these on the beat timer.
const FLOW_DASHES = [
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

const RIDE_POI_LAYER = "route-dest-pois";

const METERS_PER_DEG_LAT = 111320;
// destination point `meters` away along `bearing` (deg, 0 = north)
function destination(
  lon: number,
  lat: number,
  bearing: number,
  meters: number,
): [number, number] {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (Math.cos(rad) * meters) / METERS_PER_DEG_LAT;
  const dLon =
    (Math.sin(rad) * meters) /
    (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return [lon + dLon, lat + dLat];
}
function ring(
  lon: number,
  lat: number,
  meters: number,
  steps = 48,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++)
    pts.push(destination(lon, lat, (i / steps) * 360, meters));
  return pts;
}
// puck FeatureCollection: meter-sized accuracy ring + heading cone
// polygons + the dot point, so they scale correctly at every zoom.
export function userFeatures(p: UserPosition): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  if (p.accuracy && p.accuracy > 0)
    features.push({
      type: "Feature",
      properties: { part: "accuracy" },
      geometry: {
        type: "Polygon",
        coordinates: [ring(p.lon, p.lat, p.accuracy)],
      },
    });
  if (Number.isFinite(p.heading)) {
    const r = Math.max(26, (p.accuracy ?? 0) * 0.6);
    const coords: [number, number][] = [[p.lon, p.lat]];
    for (let a = -32; a <= 32; a += 8)
      coords.push(destination(p.lon, p.lat, p.heading! + a, r));
    coords.push([p.lon, p.lat]);
    features.push({
      type: "Feature",
      properties: { part: "cone" },
      geometry: { type: "Polygon", coordinates: [coords] },
    });
  }
  features.push({
    type: "Feature",
    properties: { part: "dot" },
    geometry: { type: "Point", coordinates: [p.lon, p.lat] },
  });
  return features;
}

// small white chevron for walk-leg direction ticks — icon (not text)
// because the satellite style ships no glyph PBFs.
export function chevronImage(size = 22): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const s = size;
  ctx.lineWidth = s * 0.16;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#eef7ff";
  ctx.beginPath();
  ctx.moveTo(s * 0.3, s * 0.18);
  ctx.lineTo(s * 0.72, s * 0.5);
  ctx.lineTo(s * 0.3, s * 0.82);
  ctx.stroke();
  return ctx.getImageData(0, 0, s, s);
}

// One feature per unique transit corridor across the given trips —
// deduped on mode + route name + geometry so alternatives sharing a
// trunk only glow once.
export function corridorFeatures(trips: { legs: Leg[] }[]): GeoJSON.Feature[] {
  const seen = new Set<string>();
  return trips
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
}

// One LineString per leg of the displayed trips. Walk legs get a
// lighter colour (brighter still on satellite) and carry `walk: true`
// so the dash/chevron filters can pick them out.
export function routeLineFeatures(
  trips: { legs: Leg[] }[],
  satellite: boolean,
): GeoJSON.Feature<GeoJSON.LineString>[] {
  return trips.flatMap((t) =>
    t.legs.map((l) => ({
      type: "Feature" as const,
      properties: {
        walk: l.mode === "WALK",
        color:
          l.mode === "WALK"
            ? satellite
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
}

// Ambient route network — one directional line per unique pattern,
// tinted by route color. Dark: flowing "current" dashes + glow.
// Satellite: arrows that physically creep along each line.
// May throw while the style is mid-swap — callers retry on style.load.
export function paintAmbient(
  map: maplibregl.Map,
  lines: GeoJSON.FeatureCollection,
  stops: GeoJSON.FeatureCollection | null,
  arrows: ArrowField,
): void {
  // getStyle() is enough — isStyleLoaded() stays false while tiles
  // stream in, which would drop every call.
  if (!map.getStyle()) return;
  for (const id of AMBIENT_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("ambient")) map.removeSource("ambient");
  if (map.getSource("ambient-arrows")) map.removeSource("ambient-arrows");
  if (map.getSource("ambient-stops")) map.removeSource("ambient-stops");
  map.addSource("ambient", { type: "geojson", data: lines });
  const sat = map.getContainer().classList.contains("satellite");
  if (stops) {
    map.addSource("ambient-stops", { type: "geojson", data: stops });
    map.addLayer({
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
    map.addLayer({
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
    map.addLayer({
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
    map.addSource("ambient-arrows", {
      type: "geojson",
      data: advanceArrows(arrows, 0),
    });
    if (!map.hasImage("net-arrow")) map.addImage("net-arrow", arrowImage());
    map.addLayer({
      id: "ambient-arrows",
      type: "symbol",
      source: "ambient-arrows",
      layout: {
        "icon-image": "net-arrow",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.3, 15, 0.7],
        "icon-rotate": ["get", "rot"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-opacity": 0.85 },
    });
  } else {
    map.addLayer({
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
    map.addLayer({
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
    map.addLayer({
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
        "line-dasharray": FLOW_DASHES[0],
      },
    });
  }
}

// One beat of the ambient animation: dash phase on dark, arrow creep
// on satellite. Returns the next FLOW_DASHES phase index.
export function tickAmbient(
  map: maplibregl.Map,
  arrows: ArrowField,
  dt: number,
  phase: number,
): number {
  if (map.getLayer("ambient-flow")) {
    phase = (phase + 1) % FLOW_DASHES.length;
    map.setPaintProperty("ambient-flow", "line-dasharray", FLOW_DASHES[phase]);
  }
  if (map.getLayer("ambient-arrows"))
    (
      map.getSource("ambient-arrows") as maplibregl.GeoJSONSource | undefined
    )?.setData(advanceArrows(arrows, dt));
  return phase;
}

// Redraw the route + corridor sources/layers from scratch, then frame
// the route. Callers must only invoke once a style is present (and
// re-invoke on style.load — setStyle wipes all of this).
export function paintRoute(
  map: maplibregl.Map,
  features: GeoJSON.Feature<GeoJSON.LineString>[],
  corridors: GeoJSON.Feature[],
): void {
  for (const id of ROUTE_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("network")) map.removeSource("network");
  if (map.getSource("route")) map.removeSource("route");
  if (corridors.length) {
    map.addSource("network", {
      type: "geojson",
      data: { type: "FeatureCollection", features: corridors },
    });
    map.addLayer({
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
    map.addLayer({
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
  map.addSource("route", {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });
  map.addLayer({
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
  map.addLayer({
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
  map.addLayer({
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
  map.addLayer({
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
  // direction chevrons along walk legs (transit legs stay bold
  // solids) — icon instead of text since the satellite style has
  // no glyph source.
  if (!map.hasImage("walk-chevron"))
    map.addImage("walk-chevron", chevronImage());
  map.addLayer({
    id: "route-walk-chevrons",
    type: "symbol",
    source: "route",
    filter: ["==", "walk", true],
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 90,
      "icon-image": "walk-chevron",
      "icon-size": 0.62,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
    paint: { "icon-opacity": 0.9 },
  });
  const coords = features.flatMap((f) => f.geometry.coordinates);
  if (coords.length) {
    const bounds = new maplibregl.LngLatBounds();
    coords.forEach((c) => bounds.extend(c as [number, number]));
    map.fitBounds(bounds, {
      padding: {
        left: window.innerWidth > 760 ? 460 : 40,
        right: 70,
        top: 100,
        bottom: window.innerWidth > 760 ? 120 : 360,
      },
      maxZoom: 15,
    });
  }
}

// One frame of the corridor glow pulse (skip entirely when the user
// prefers reduced motion — callers gate on matchMedia).
export function pulseNetworkGlow(map: maplibregl.Map, now: number): void {
  if (map.getLayer("network-glow")) {
    const amount = 0.5 + 0.5 * Math.sin(now / 900);
    map.setPaintProperty("network-glow", "line-opacity", 0.1 + 0.16 * amount);
    map.setPaintProperty("network-glow", "line-width", 7 + 4 * amount);
  }
}

// Subtle dots for "Near your stop" venues around the boarded leg's
// destination — the "route-" prefix keeps the layer inside the
// riding-view app-layer allowlist.
export function clearRidePois(map: maplibregl.Map): void {
  if (map.getLayer(RIDE_POI_LAYER)) map.removeLayer(RIDE_POI_LAYER);
  if (map.getSource(RIDE_POI_LAYER)) map.removeSource(RIDE_POI_LAYER);
}
export function paintRidePois(map: maplibregl.Map, pois: Place[]): void {
  clearRidePois(map);
  if (!pois.length || !map.getStyle()) return;
  try {
    map.addSource(RIDE_POI_LAYER, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: pois.map((p) => ({
          type: "Feature" as const,
          properties: {},
          geometry: {
            type: "Point" as const,
            coordinates: [p.lon, p.lat],
          },
        })),
      },
    });
    map.addLayer({
      id: RIDE_POI_LAYER,
      type: "circle",
      source: RIDE_POI_LAYER,
      paint: {
        "circle-radius": 4,
        "circle-color": "#ffd166",
        "circle-opacity": 0.55,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#04101c",
      },
    });
  } catch {
    /* style mid-load — retried on style.load */
  }
}

// Ambient live vehicles — one GeoJSON source re-set per poll. OCTA dots
// orange, Metro blue; a heading tick rides on the bearing when present.
export function paintVehicles(
  map: maplibregl.Map,
  dots: {
    lat: number;
    lon: number;
    bearing?: number;
    agency: string;
    route?: string;
  }[],
): void {
  if (!map.getStyle()) return;
  const fc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: dots.map((d) => ({
      type: "Feature" as const,
      properties: {
        agency: d.agency,
        bearing: d.bearing ?? 0,
        route: d.route ?? "",
      },
      geometry: { type: "Point" as const, coordinates: [d.lon, d.lat] },
    })),
  };
  try {
    const src = map.getSource("vehicles") as
      maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(fc);
      return;
    }
    map.addSource("vehicles", { type: "geojson", data: fc });
    map.addLayer({
      id: "vehicles-dots",
      type: "circle",
      source: "vehicles",
      minzoom: 11,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 15, 5],
        "circle-color": [
          "match",
          ["get", "agency"],
          "metro",
          "#3f8fd2",
          "#e8810c",
        ],
        "circle-opacity": 0.85,
        "circle-stroke-width": 1.2,
        "circle-stroke-color": "#f4f7fb",
      },
    });
    map.addLayer({
      id: "vehicles-dir",
      type: "symbol",
      source: "vehicles",
      minzoom: 13,
      filter: [">", ["get", "bearing"], 0],
      layout: {
        "text-field": "▲",
        "text-size": 8,
        "text-rotate": ["get", "bearing"],
        "text-rotation-alignment": "map",
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#f4f7fb" },
    });
  } catch {
    /* style mid-load — retried on style.load */
  }
}

// Live user puck — accuracy ring + heading cone + dot, fed by a
// single GeoJSON source updated on each fix. Meter-sized polygon
// features (not pixel radii) so they scale correctly with zoom.
// Safe to call repeatedly: refreshes the source when it already
// exists, creates source + layers otherwise (retry on style.load if
// the style isn't ready).
export function ensureUserLayers(map: maplibregl.Map, p: UserPosition): void {
  const data = (): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: userFeatures(p),
  });
  const src = map.getSource("user") as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data());
    return;
  }
  if (!map.isStyleLoaded()) return;
  try {
    map.addSource("user", { type: "geojson", data: data() });
    map.addLayer({
      id: "user-accuracy-circle",
      type: "fill",
      source: "user",
      filter: ["==", "part", "accuracy"],
      paint: { "fill-color": "#3b9dff", "fill-opacity": 0.14 },
    });
    map.addLayer({
      id: "user-heading-cone",
      type: "fill",
      source: "user",
      filter: ["==", "part", "cone"],
      paint: { "fill-color": "#7cc4ff", "fill-opacity": 0.4 },
    });
    map.addLayer({
      id: "user-puck-dot",
      type: "circle",
      source: "user",
      filter: ["==", "part", "dot"],
      paint: {
        "circle-radius": 7,
        "circle-color": "#2f9bff",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#ffffff",
      },
    });
  } catch {
    /* style mid-load — retried on style.load */
  }
}

// Drop the puck entirely when the fix stream stops.
export function removeUserLayers(map: maplibregl.Map): void {
  for (const id of USER_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource("user")) map.removeSource("user");
}

// Follow-mode camera step: recenter on each fix (callers throttle),
// plus bearing = heading in "heading" mode.
export function followUserCamera(
  map: maplibregl.Map,
  p: UserPosition,
  mode: GpsFollowMode,
): void {
  map.easeTo({
    center: [p.lon, p.lat],
    duration: 800,
    ...(mode === "heading" && Number.isFinite(p.heading)
      ? { bearing: p.heading! }
      : {}),
  });
}

// Minimized riding view — hide every non-app layer (basemap chrome)
// and paint a dark matte underneath so the route + puck float.
// `hidden` records which layers we turned off so restore only touches
// those (setStyle wipes layer state on basemap change; callers re-apply
// on style.load).
export function applyRidingView(
  map: maplibregl.Map,
  hidden: Set<string>,
): void {
  const style = map.getStyle();
  if (!style?.layers?.length) return;
  try {
    if (!map.getLayer(MATTE_LAYER))
      map.addLayer(
        {
          id: MATTE_LAYER,
          type: "background",
          paint: { "background-color": "#0B0F17" },
        },
        style.layers[0].id,
      );
    for (const layer of map.getStyle().layers) {
      if (isAppLayer(layer.id)) continue;
      if (map.getLayoutProperty(layer.id, "visibility") !== "none") {
        map.setLayoutProperty(layer.id, "visibility", "none");
        hidden.add(layer.id);
      }
    }
  } catch {
    /* style mid-load — retried on style.load */
  }
}

export function restoreRidingView(
  map: maplibregl.Map,
  hidden: Set<string>,
): void {
  for (const id of hidden) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
  }
  hidden.clear();
  if (map.getLayer(MATTE_LAYER)) map.removeLayer(MATTE_LAYER);
}

// Route-hunt radar ping dropped at the origin while a search runs.
export function attachScanRing(
  map: maplibregl.Map,
  lon: number,
  lat: number,
): maplibregl.Marker {
  const el = document.createElement("div");
  el.className = "scan-ring";
  el.appendChild(document.createElement("i"));
  return new maplibregl.Marker({ element: el })
    .setLngLat([lon, lat])
    .addTo(map);
}
