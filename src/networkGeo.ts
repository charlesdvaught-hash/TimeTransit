import type { ScanIndex } from "./scan";

// Unique stop-to-stop edges across every pattern — the ambient "where do
// the buses run" layer. Undirected dedupe so routes serving a street in
// both directions don't stack glow.
export function buildNetwork(index: ScanIndex): GeoJSON.FeatureCollection {
  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const p of index.patterns) {
    for (let i = 0; i + 1 < p.stops.length; i++) {
      const a = index.stops[p.stops[i]],
        b = index.stops[p.stops[i + 1]];
      if (!a || !b) continue;
      const key = a.i < b.i ? `${a.i}|${b.i}` : `${b.i}|${a.i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [a.lo, a.la],
            [b.lo, b.la],
          ],
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

// Arrowhead sprite for the satellite basemap — drawn on a canvas so no
// font/glyph dependency. Tip points east; MapLibre rotates it along the line.
export function arrowImage(size = 24): ImageData {
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
