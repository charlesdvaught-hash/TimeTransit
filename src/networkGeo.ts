import { decode } from "./core";
import type { ScanIndex } from "./scan";

// Preferred source: public/scan/network.json (real GTFS shape geometry,
// all agencies). Falls back to the OCTA scan index's stop sequences.
export async function loadNetwork(): Promise<GeoJSON.FeatureCollection | null> {
  try {
    const r = await fetch("scan/network.json");
    if (r.ok) {
      const { lines } = (await r.json()) as {
        lines: { c: string; e: string; n?: string; a?: string }[];
      };
      return {
        type: "FeatureCollection",
        features: lines.map((l) => ({
          type: "Feature",
          properties: { c: lift(l.c), n: l.n, a: l.a },
          geometry: { type: "LineString", coordinates: decode(l.e, 6) },
        })),
      };
    }
  } catch {}
  const { loadScanIndex } = await import("./scanData");
  const index = await loadScanIndex().catch(() => undefined);
  return index ? buildNetwork(index) : null;
}

const hex = (v: string) => {
  const n = parseInt(v.replace("#", ""), 16);
  return isNaN(n) ? [77, 163, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
// lift colors that are unreadable on dark basemaps (Metro's #0060a8,
// near-black #000000) toward a bright sibling of the same hue
const lift = (v: string) => {
  const [r, g, b] = hex(v);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum >= 105) return v.startsWith("#") ? v : `#${v}`;
  const t = Math.min(0.72, (105 - lum) / 105 + 0.25);
  const m = (c: number, hi: number) => Math.round(c + (hi - c) * t);
  const to = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to(m(r, 140))}${to(m(g, 200))}${to(m(b, 255))}`;
};
// soften a raw GTFS route color toward the ambient blue — subtle
// per-route tinting without a rainbow map
const soften = (v: string, t = 0.55) => {
  const [r, g, b] = hex(v || "4da3ff");
  const mix = (c: number, t2: number) => Math.round(c + (t2 - c) * t);
  const to = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to(mix(r, 96))}${to(mix(g, 200))}${to(mix(b, 255))}`;
};

// One LineString per unique directional stop-sequence — route-colored so
// providers tinge differently, directional so flow/arrows travel correctly.
export function buildNetwork(index: ScanIndex): GeoJSON.FeatureCollection {
  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const p of index.patterns) {
    const sig = p.stops.join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    const coords = p.stops
      .map((s) => index.stops[s])
      .filter(Boolean)
      .map((s) => [s.lo, s.la]);
    if (coords.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { c: soften(p.c) },
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  return { type: "FeatureCollection", features };
}

// Travelling arrow points for the satellite basemap — each creeps along
// its route line and wraps around. Bearing goes in `rot` for icon-rotate.
export type ArrowField = {
  coords: number[][];
  lens: number[]; // cumulative segment lengths (deg units, approx)
  total: number;
  t: number; // fraction along the line 0..1
  speed: number; // fraction of line per second
}[];

export function arrowField(fc: GeoJSON.FeatureCollection): ArrowField {
  const out: ArrowField = [];
  for (const f of fc.features) {
    const coords = (f.geometry as GeoJSON.LineString).coordinates;
    if (coords.length < 2) continue;
    const lens = [0];
    for (let i = 1; i < coords.length; i++)
      lens.push(
        lens[i - 1] +
          Math.hypot(
            coords[i][0] - coords[i - 1][0],
            coords[i][1] - coords[i - 1][1],
          ),
      );
    const total = lens[lens.length - 1] || 1;
    // roughly one arrow per ~2km of line (0.02deg), at least one
    const n = Math.max(1, Math.round(total / 0.02));
    for (let k = 0; k < n; k++)
      out.push({
        coords,
        lens,
        total,
        t: (k + Math.random() * 0.8) / n,
        speed: 0.022 + Math.random() * 0.008,
      });
  }
  return out;
}

export function advanceArrows(
  field: ArrowField,
  dt: number,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const a of field) {
    a.t = (a.t + a.speed * dt) % 1;
    const d = a.t * a.total;
    let i = 1;
    while (i < a.lens.length - 1 && a.lens[i] < d) i++;
    const seg = a.lens[i] - a.lens[i - 1] || 1;
    const f = (d - a.lens[i - 1]) / seg;
    const [x1, y1] = a.coords[i - 1],
      [x2, y2] = a.coords[i];
    // bearing clockwise from north; sprite points east so subtract 90
    const rot = (Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI - 90;
    features.push({
      type: "Feature",
      properties: { rot },
      geometry: {
        type: "Point",
        coordinates: [x1 + (x2 - x1) * f, y1 + (y2 - y1) * f],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

// Arrowhead sprite — drawn on canvas, no font dependency. Points east;
// MapLibre rotates it via the `rot` feature property.
export function arrowImage(size = 22): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#10161f";
  ctx.beginPath();
  const s = size;
  ctx.moveTo(s * 0.8, s * 0.5);
  ctx.lineTo(s * 0.2, s * 0.12);
  ctx.lineTo(s * 0.36, s * 0.5);
  ctx.lineTo(s * 0.2, s * 0.88);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}
