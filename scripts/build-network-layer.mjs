#!/usr/bin/env node
// Build the ambient route-network layer from GTFS shapes.
// Usage: node scripts/build-network-layer.mjs <gtfsDir>[,defaultColor] ... <outJson>
// Each dir needs shapes.txt, trips.txt, routes.txt. Output: { lines: [{c, e}] }
// where e is a Google-encoded polyline (precision 6).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const out = args.pop();
const dirs = args.map((a) => {
  const [dir, color] = a.split(",");
  return { dir, color: color || "4da3ff" };
});

const csv = (path) => {
  const rows = readFileSync(path, "utf8").trim().split("\n");
  const head = rows[0].split(",").map((h) => h.trim().replace(/^\uFEFF/, ""));
  return rows.slice(1).map((r) => {
    const cells = r.split(",");
    const o = {};
    head.forEach((h, i) => (o[h] = cells[i]));
    return o;
  });
};

// simplify: drop points closer than ~18m to the last kept point
const simplify = (pts) => {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [la, lo] = out[out.length - 1];
    if (
      Math.hypot((pts[i][0] - la) * 111000, (pts[i][1] - lo) * 90000) > 18
    )
      out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
};

const encode = (pts) => {
  let out = "",
    pla = 0,
    plo = 0;
  const chunk = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [la, lo] of pts) {
    const a = Math.round(la * 1e6),
      o = Math.round(lo * 1e6);
    chunk(a - pla);
    chunk(o - plo);
    pla = a;
    plo = o;
  }
  return out;
};

const lines = [];
const seen = new Set();
for (const { dir, color } of dirs) {
  const routes = new Map(
    csv(join(dir, "routes.txt")).map((r) => [
      r.route_id,
      r.route_color || color,
    ]),
  );
  const shapeColor = new Map();
  for (const t of csv(join(dir, "trips.txt")))
    if (t.shape_id && !shapeColor.has(t.shape_id))
      shapeColor.set(t.shape_id, routes.get(t.route_id) || color);
  const shapes = new Map();
  for (const s of csv(join(dir, "shapes.txt"))) {
    const id = s.shape_id;
    if (!shapes.has(id)) shapes.set(id, []);
    shapes.get(id).push([
      +s.shape_pt_lat,
      +s.shape_pt_lon,
      +s.shape_pt_sequence,
    ]);
  }
  for (const [id, pts] of shapes) {
    pts.sort((a, b) => a[2] - b[2]);
    const simple = simplify(pts.map(([la, lo]) => [la, lo]));
    const e = encode(simple);
    if (seen.has(e)) continue;
    seen.add(e);
    lines.push({
      c: `#${(shapeColor.get(id) || color).replace("#", "")}`,
      e,
    });
  }
}
writeFileSync(out, JSON.stringify({ v: 1, lines }));
console.log(
  `${dirs.length} feeds -> ${lines.length} unique shapes,`,
  (JSON.stringify({ lines }).length / 1e6).toFixed(1),
  "MB",
);
