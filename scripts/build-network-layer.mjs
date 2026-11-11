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
  const [dir, color, agency] = a.split(",");
  return { dir, color: color || "4da3ff", agency: agency || dir };
});

// RFC4180-ish: quoted fields may contain commas and doubled quotes
const splitRow = (r) => {
  const out = [];
  let cur = "",
    q = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (q) {
      if (c === '"' && r[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
};
const csv = (path) => {
  const rows = readFileSync(path, "utf8").trim().split("\n");
  const head = splitRow(rows[0]).map((h) => h.trim().replace(/^\uFEFF/, ""));
  return rows.slice(1).map((r) => {
    const cells = splitRow(r);
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
    if (Math.hypot((pts[i][0] - la) * 111000, (pts[i][1] - lo) * 90000) > 18)
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
const stops = new Map();
for (const { dir, color, agency } of dirs) {
  try {
    for (const s of csv(join(dir, "stops.txt"))) {
      if (s.location_type && s.location_type !== "0") continue;
      const la = +s.stop_lat,
        lo = +s.stop_lon;
      if (la && lo && !stops.has(`${la.toFixed(4)},${lo.toFixed(4)}`))
        stops.set(`${la.toFixed(4)},${lo.toFixed(4)}`, [
          +la.toFixed(5),
          +lo.toFixed(5),
          s.stop_name || "",
          agency,
        ]);
    }
  } catch {}
  const routes = new Map(
    csv(join(dir, "routes.txt")).map((r) => [
      r.route_id,
      {
        c: r.route_color || color,
        n: r.route_short_name || r.route_long_name || "?",
      },
    ]),
  );
  const shapeColor = new Map();
  for (const t of csv(join(dir, "trips.txt")))
    if (t.shape_id && !shapeColor.has(t.shape_id))
      shapeColor.set(
        t.shape_id,
        routes.get(t.route_id) || { c: color, n: "?" },
      );
  const shapes = new Map();
  for (const s of csv(join(dir, "shapes.txt"))) {
    const id = s.shape_id;
    if (!shapes.has(id)) shapes.set(id, []);
    shapes
      .get(id)
      .push([+s.shape_pt_lat, +s.shape_pt_lon, +s.shape_pt_sequence]);
  }
  for (const [id, pts] of shapes) {
    pts.sort((a, b) => a[2] - b[2]);
    const simple = simplify(pts.map(([la, lo]) => [la, lo]));
    const e = encode(simple);
    if (seen.has(e)) continue;
    seen.add(e);
    const r = shapeColor.get(id) || { c: color, n: "?" };
    lines.push({
      c: `#${r.c.replace("#", "")}`,
      e,
      n: r.n,
      a: agency,
    });
  }
}
writeFileSync(
  out,
  JSON.stringify({ v: 1, lines, stops: [...stops.values()] }),
);
console.log(
  `${dirs.length} feeds -> ${lines.length} unique shapes, ${stops.size} stops,`,
  (JSON.stringify({ lines }).length / 1e6).toFixed(1),
  "MB",
);
