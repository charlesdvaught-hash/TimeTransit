#!/usr/bin/env node
// Build a RAPTOR-ready scan index from an extracted GTFS directory.
// Usage: node scripts/build-scan-index.mjs <gtfsDir> <outJson>
// gtfsDir must contain stops.txt, trips.txt, stop_times.txt, routes.txt,
// calendar.txt, calendar_dates.txt (extracted from the agency GTFS zip).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: node scripts/build-scan-index.mjs <gtfsDir> <outJson>");
  process.exit(1);
}
const WALK_LINK_M = 350; // precomputed transfer radius between stops

function csv(name) {
  const text = readFileSync(join(dir, name), "utf8").replace(/^﻿/, "");
  const rows = [];
  let cur = [""],
    inQ = false;
  for (const ch of text) {
    if (inQ) {
      if (ch === '"') inQ = false;
      else cur[cur.length - 1] += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") cur.push("");
    else if (ch === "\n") {
      rows.push(cur);
      cur = [""];
    } else if (ch !== "\r") cur[cur.length - 1] += ch;
  }
  if (cur.length > 1 || cur[0]) rows.push(cur);
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const secs = (hms) => {
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s;
};
const hav = (a, b) => {
  const r = 6371000,
    dLa = ((b.la - a.la) * Math.PI) / 180,
    dLo = ((b.lo - a.lo) * Math.PI) / 180,
    s =
      Math.sin(dLa / 2) ** 2 +
      Math.cos((a.la * Math.PI) / 180) *
        Math.cos((b.la * Math.PI) / 180) *
        Math.sin(dLo / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(s));
};

// stops
const stopRows = csv("stops.txt").filter(
  (s) => (s.location_type || "0") === "0" || s.location_type === "",
);
const stopIdx = new Map();
const stops = stopRows.map((s, i) => {
  stopIdx.set(s.stop_id, i);
  return {
    i: s.stop_id,
    n: s.stop_name,
    la: +s.stop_lat,
    lo: +s.stop_lon,
  };
});

// services: weekday bitmask Mon..Sun + range + exceptions
const services = csv("calendar.txt").map((c) => ({
  id: c.service_id,
  d: [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ]
    .map((k) => +(c[k] === "1"))
    .reduce((m, v, i) => m | (v << i), 0),
  s: c.start_date,
  e: c.end_date,
  x: [],
}));
const svcIdx = new Map(services.map((s, i) => [s.id, i]));
try {
  for (const c of csv("calendar_dates.txt")) {
    const i = svcIdx.get(c.service_id);
    if (i !== undefined) services[i].x.push([c.date, +c.exception_type]);
  }
} catch {
  /* no calendar_dates */
}

// routes + trips
const routes = new Map(csv("routes.txt").map((r) => [r.route_id, r]));
const trips = new Map(
  csv("trips.txt").map((t) => [
    t.trip_id,
    {
      route: routes.get(t.route_id),
      svc: svcIdx.get(t.service_id),
      dir: +t.direction_id || 0,
      h: t.trip_headsign || "",
    },
  ]),
);

// stop_times grouped by trip
const byTrip = new Map();
for (const st of csv("stop_times.txt")) {
  const g = byTrip.get(st.trip_id) || [];
  g.push({
    seq: +st.stop_sequence,
    stop: stopIdx.get(st.stop_id),
    dep: secs(st.departure_time),
  });
  byTrip.set(st.trip_id, g);
}

// patterns: route + direction + identical stop sequence
const patterns = [];
const patKey = new Map();
for (const [tripId, list] of byTrip) {
  const t = trips.get(tripId);
  if (!t?.route || t.svc === undefined) continue;
  list.sort((a, b) => a.seq - b.seq);
  const stopIds = list.map((x) => x.stop);
  if (stopIds.some((s) => s === undefined)) continue;
  const key = `${t.route.route_id}|${t.dir}|${stopIds.join(",")}`;
  let p = patKey.get(key);
  if (!p) {
    p = {
      r: t.route.route_short_name || t.route.route_id,
      rid: t.route.route_id,
      dir: t.dir,
      h: t.h,
      c: t.route.route_color || "",
      rt: +t.route.route_type,
      stops: stopIds,
      trips: [],
    };
    patKey.set(key, p);
    patterns.push(p);
  }
  p.trips.push({ s: t.svc, i: tripId, t: list.map((x) => x.dep) });
}
for (const p of patterns) p.trips.sort((a, b) => a.t[0] - b.t[0]);

// walk links between stops within WALK_LINK_M
const walks = [];
for (let i = 0; i < stops.length; i++)
  for (let j = i + 1; j < stops.length; j++) {
    if (Math.abs(stops[i].la - stops[j].la) > 0.004) continue;
    const m = Math.round(hav(stops[i], stops[j]));
    if (m <= WALK_LINK_M) {
      walks.push([i, j, m]);
      walks.push([j, i, m]);
    }
  }

const lats = stops.map((s) => s.la),
  lons = stops.map((s) => s.lo);
const index = {
  v: 1,
  feed: {
    start: services.map((s) => s.s).sort()[0],
    end: services
      .map((s) => s.e)
      .sort()
      .at(-1),
  },
  bbox: [
    Math.min(...lats) - 0.02,
    Math.min(...lons) - 0.02,
    Math.max(...lats) + 0.02,
    Math.max(...lons) + 0.02,
  ],
  stops,
  services,
  patterns,
  walks,
};
writeFileSync(out, JSON.stringify(index));
const bytes = JSON.stringify(index).length;
console.log(
  `stops=${stops.length} services=${services.length} patterns=${patterns.length} trips=${patterns.reduce((n, p) => n + p.trips.length, 0)} walks=${walks.length / 2} json=${(bytes / 1048576).toFixed(2)}MB feed=${index.feed.start}-${index.feed.end}`,
);
