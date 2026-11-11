#!/usr/bin/env node
// Overture GeoJSON (overturemaps download --type=place) -> compact places index.
// Usage: node scripts/build-places-index.mjs <input.geojson> [out.json]
// Default out: public/places/oc.json. Rows: {n, a?, k?, la, lo} —
// name/address/coords plus k = venue kind (taxonomy.primary), spaces not _.
import { createReadStream, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

const [input, out = "public/places/oc.json"] = process.argv.slice(2);
if (!input) {
  console.error(
    "usage: node scripts/build-places-index.mjs <input.geojson> [out]",
  );
  process.exit(1);
}

const seen = new Set();
const rows = [];
const rl = createInterface({
  input: createReadStream(input, "utf8"),
  crlfDelay: Infinity,
});
for await (const line of rl) {
  const t = line.trim();
  if (!t.startsWith("{")) continue;
  let f;
  try {
    f = JSON.parse(t.replace(/,$/, ""));
  } catch {
    continue;
  }
  const p = f.properties || {};
  const name = p.names?.primary;
  const [lon, lat] = f.geometry?.coordinates || [];
  if (!name || lat === undefined) continue;
  const addr = p.addresses?.[0]?.freeform;
  const key = `${name.toLowerCase()}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const r = { n: name, la: +lat.toFixed(5), lo: +lon.toFixed(5) };
  if (addr) r.a = addr;
  const kind = (p.taxonomy?.primary || p.basic_category || "").replace(
    /_/g,
    " ",
  );
  if (kind) r.k = kind;
  rows.push(r);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(rows));
console.log(
  `places=${rows.length} json=${(JSON.stringify(rows).length / 1e6).toFixed(2)}MB -> ${out}`,
);
