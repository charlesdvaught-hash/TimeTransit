import type { StyleSpecification } from "maplibre-gl";
import { readStored, writeStored } from "./storage";
export type Basemap = "dark" | "satellite";
const dark = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const satellite: StyleSpecification = {
  version: 8,
  sources: {
    imagery: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
    },
    places: {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: "imagery",
      type: "raster",
      source: "imagery",
      paint: {
        "raster-brightness-max": 0.94,
        "raster-saturation": -0.1,
        "raster-contrast": 0.04,
      },
    },
    {
      id: "tone",
      type: "background",
      paint: { "background-color": "#050d16", "background-opacity": 0.26 },
    },
    {
      id: "places",
      type: "raster",
      source: "places",
      paint: {
        "raster-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          7,
          0.9,
          11,
          0.62,
          14,
          0.36,
          17,
          0.3,
        ],
      },
    },
  ],
};
export const basemapStyles: Record<Basemap, string | StyleSpecification> = {
  dark,
  satellite,
};
export function loadBasemap() {
  return readStored<Basemap>(
    "timetransit.basemap",
    "dark",
    (b): b is Basemap => b === "dark" || b === "satellite",
  );
}
export function saveBasemap(b: Basemap) {
  writeStored("timetransit.basemap", b);
}
