import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef } from "react";
import { chicago, decode } from "./core";
import type { TransitController } from "./useTimeTransit";
maplibregl.setWorkerUrl(workerUrl);
export function MapLayer({ controller }: { controller: TransitController }) {
  const {
    origin,
    results,
    selected,
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
  pickRef.current = picking;
  useEffect(() => {
    const m = new maplibregl.Map({
      container: mapNode.current!,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [chicago.lon, chicago.lat],
      zoom: 12.8,
      pitch: 20,
      attributionControl: { compact: true },
    });
    map.current = m;
    m.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
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
    locate();
    return () => m.remove();
  }, []);
  const trips = chain
    ? [
        ...chain.visits.map((v) => v.trip),
        ...(chain.returnTrip ? [chain.returnTrip] : []),
      ]
    : selected
      ? [selected.trip]
      : [];
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const markers: maplibregl.Marker[] = [];
    const draw = () => {
      for (const id of ["route-walk", "route-ride"])
        if (m.getLayer(id)) m.removeLayer(id);
      if (m.getSource("route")) m.removeSource("route");
      const features = trips.flatMap((t) =>
        t.legs.map((l) => ({
          type: "Feature" as const,
          properties: {
            walk: l.mode === "WALK",
            color:
              l.mode === "WALK"
                ? "#a8c7da"
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
      m.addSource("route", {
        type: "geojson",
        data: { type: "FeatureCollection", features },
      });
      m.addLayer({
        id: "route-ride",
        type: "line",
        source: "route",
        filter: ["==", "walk", false],
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
    else m.once("load", draw);
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
      m.off("load", draw);
      markers.forEach((x) => x.remove());
    };
  }, [origin, results, selected, chain]);

  return <div ref={mapNode} className="map" />;
}
