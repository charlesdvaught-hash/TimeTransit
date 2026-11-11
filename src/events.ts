// Events via the relay's /events route — the worker fans out to SeatGeek
// (keyed, optional), LA + Santa Monica open data, and Mobilizon, then
// merges into the shared LocalEvent shape. Every failure path returns []
// so a dead relay or source degrades quietly.
import type { LocalEvent } from "./contracts";
import type { Place } from "./core";

export function eventsConfigured() {
  return !!import.meta.env.VITE_TRANSIT_RELAY;
}
let eventsEnabled = true; // flips off for the session if the relay 500s

export async function searchEvents(
  origin: Pick<Place, "lat" | "lon">,
  opts: {
    start?: string;
    end?: string;
    query?: string;
    signal?: AbortSignal;
  } = {},
): Promise<LocalEvent[]> {
  const relay = import.meta.env.VITE_TRANSIT_RELAY;
  if (!relay || !eventsEnabled) return [];
  const p = new URLSearchParams({
    lat: String(origin.lat),
    lon: String(origin.lon),
  });
  if (opts.start) p.set("start", opts.start);
  if (opts.end) p.set("end", opts.end);
  if (opts.query) p.set("q", opts.query);
  try {
    const r = await fetch(`${relay}/events?${p}`, {
      signal: opts.signal ?? AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      if (r.status >= 500) eventsEnabled = false;
      return [];
    }
    const j = await r.json();
    return Array.isArray(j.events) ? j.events : [];
  } catch {
    return [];
  }
}
