#!/usr/bin/env node
// Overture GeoJSON (overturemaps download --type=place) -> compact places index.
// Usage: node scripts/build-places-index.mjs <input.geojson> [out.json]
//        node scripts/build-places-index.mjs --check [index.json]
// --check reports field coverage of an existing index without rebuilding —
// indexes built before c existed will show c=0/N, which is fine (places.ts
// treats a missing c as unknown confidence).
// Default out: public/places/oc.json. Rows: {n, a?, k?, c?, la, lo} —
// name/address/coords plus k = venue kind (taxonomy.primary), spaces not _,
// and c = Overture confidence as a 0-9 digit (Math.round(confidence*9)).
import {
  createReadStream,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

const [input, out = "public/places/oc.json"] = process.argv.slice(2);
if (input === "--check") {
  const rows = JSON.parse(readFileSync(out, "utf8"));
  const has = (k) => rows.filter((r) => r[k] !== undefined).length;
  console.log(
    `rows=${rows.length} a=${has("a")} k=${has("k")} c=${has("c")} -> ${out}`,
  );
  process.exit(0);
}
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
  if (p.operating_status === "permanently_closed") continue;
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
  if (typeof p.confidence === "number" && Number.isFinite(p.confidence))
    r.c = Math.round(p.confidence * 9); // confidence digit 0-9
  rows.push(r);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(rows));
console.log(
  `places=${rows.length} json=${(JSON.stringify(rows).length / 1e6).toFixed(2)}MB -> ${out}`,
);
