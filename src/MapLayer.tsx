import { Crosshair, Minus, MoonStar, Plus, Satellite } from "lucide-react";
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import {
  basemapStyles,
  loadBasemap,
  saveBasemap,
  type Basemap,
} from "./basemap";
import { decode } from "./core";
import { hasSavedOrigin } from "./preferences";
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
  } = controller;
  const mapNode = useRef<HTMLDivElement>(null);
  const pickRef = useRef(picking);
  const styled = useRef(false);
  const [basemap, setBasemap] = useState<Basemap>(loadBasemap);
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
      if (pickRef.current)
        changeOrigin({
          id: "pin",
          name: "Pinned location",
          lat: e.lngLat.lat,
          lon: e.lngLat.lng,
        });
    });
    m.on("error", (e) => {
      if (e.error?.message) setError(`Map: ${e.error.message}`);
    });
    if (!hasSavedOrigin()) locate();
    return () => m.remove();
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
          "line-width": 9,
          "line-opacity": 0.5,
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
          "line-width": 6,
          "line-opacity": 0.35,
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
          "line-width": 5,
          "line-opacity": 0.95,
        },
      });
      m.addLayer({
        id: "route-walk",
        type: "line",
        source: "route",
        filter: ["==", "walk", true],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 3,
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
    return () => {
      m.off("style.load", draw);
      cancelAnimationFrame(frame);
      markers.forEach((x) => x.remove());
    };
  }, [origin, results, selected, trip, chain, basemap]);
  const choose = (b: Basemap) => {
    setBasemap(b);
    saveBasemap(b);
  };
  return (
    <>
      <div ref={mapNode} className="map" />
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
