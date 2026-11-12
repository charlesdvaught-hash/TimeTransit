// STAGE-5: Google Places via the relay's /gmaps routes.
// Google terms: place data renders in the panel only — never on the MapLibre
// canvas — rating/price stay in session memory (place_id may persist), and a
// visible "Google" label accompanies Google-sourced fields.
import type { GooglePlaceDetail } from "./contracts";
import type { Place } from "./core";
import { readStored, writeStored } from "./storage";

// Flips false on a 500 — the relay 500s when it has no Google key, so we stop
// trying for the session.
export let gmapsEnabled = true;
export function gmapsConfigured() {
  return !!import.meta.env.VITE_TRANSIT_RELAY;
}
function relay() {
  return import.meta.env.VITE_TRANSIT_RELAY as string;
}

const ID_KEY = "timetransit.gmaps-ids"; // place_id persistence is allowed
const ids = readStored<Record<string, string>>(
  ID_KEY,
  {},
  (v): v is Record<string, string> =>
    !!v && typeof v === "object" && !Array.isArray(v),
);
// rating/price are transient — session Map only, never written to storage
const details = new Map<string, GooglePlaceDetail>();

function saveIds() {
  const keys = Object.keys(ids);
  if (keys.length > 500) delete ids[keys[0]];
  writeStored(ID_KEY, ids);
}

export async function placeIdFor(
  place: Place,
  origin?: Place,
): Promise<string | undefined> {
  const cached = ids[place.id];
  if (cached) return cached;
  if (!gmapsConfigured() || !gmapsEnabled) return;
  const at = origin ?? place;
  try {
    const r = await fetch(
      `${relay()}/gmaps/text?query=${encodeURIComponent(
        place.name + (place.address ? `, ${place.address}` : ""),
      )}&lat=${at.lat}&lon=${at.lon}`,
    );
    if (r.status === 500) {
      gmapsEnabled = false;
      return;
    }
    if (!r.ok) return;
    // IDs-only response carries no coords — take the first (biased) result
    const id = ((await r.json()).places?.[0]?.id as string) || undefined;
    if (id) {
      ids[place.id] = id;
      saveIds();
    }
    return id;
  } catch {
    return;
  }
}

const PRICE_LEVELS = [
  "PRICE_LEVEL_FREE",
  "PRICE_LEVEL_INEXPENSIVE",
  "PRICE_LEVEL_MODERATE",
  "PRICE_LEVEL_EXPENSIVE",
  "PRICE_LEVEL_VERY_EXPENSIVE",
];
function priceLevel(v: unknown): GooglePlaceDetail["priceLevel"] {
  if (typeof v === "number" && v >= 0 && v <= 4)
    return v as GooglePlaceDetail["priceLevel"];
  const i = PRICE_LEVELS.indexOf(String(v));
  return i < 0 ? undefined : (i as GooglePlaceDetail["priceLevel"]);
}

export async function detailsFor(
  placeId: string,
  signal?: AbortSignal,
): Promise<GooglePlaceDetail | undefined> {
  const hit = details.get(placeId);
  if (hit) return hit;
  if (!gmapsConfigured() || !gmapsEnabled) return;
  try {
    const r = await fetch(
      `${relay()}/gmaps/details?place_id=${encodeURIComponent(placeId)}`,
      { signal },
    );
    if (r.status === 500) {
      gmapsEnabled = false;
      return;
    }
    if (!r.ok) return;
    const d = await r.json();
    const detail: GooglePlaceDetail = {};
    if (typeof d.rating === "number") detail.rating = d.rating;
    if (typeof d.userRatingCount === "number")
      detail.userRatingCount = d.userRatingCount;
    const pl = priceLevel(d.priceLevel ?? d.price_level);
    if (pl !== undefined) detail.priceLevel = pl;
    const open = d.currentOpeningHours ?? d.current_opening_hours;
    const openNow = open?.openNow ?? open?.open_now;
    if (typeof openNow === "boolean") detail.openNow = openNow;
    details.set(placeId, detail);
    return detail;
  } catch {
    return;
  }
}

export type GmapsCandidate = { place: Place; detail: GooglePlaceDetail };
// PHASE-B: text search for parsed/vibe queries — returns directly-plannable
// candidates (coords + rating + price in the widened field mask, one request).
// Google fields are session-cached; display stays panel-only per terms.
export async function searchPlaces(
  query: string,
  at: { lat: number; lon: number },
  signal?: AbortSignal,
): Promise<GmapsCandidate[]> {
  if (!gmapsConfigured() || !gmapsEnabled) return [];
  try {
    const r = await fetch(
      `${relay()}/gmaps/text?query=${encodeURIComponent(query)}&lat=${at.lat}&lon=${at.lon}`,
      { signal },
    );
    if (r.status === 500) {
      gmapsEnabled = false;
      return [];
    }
    if (!r.ok) return [];
    const places = ((await r.json()).places ?? []) as Record<string, unknown>[];
    const out: GmapsCandidate[] = [];
    for (const p of places.slice(0, 8)) {
      const pid = p.id as string;
      const loc = p.location as { latitude?: number; longitude?: number };
      if (!pid || typeof loc?.latitude !== "number") continue;
      const name = (p.displayName as { text?: string })?.text || "Google place";
      const place: Place = {
        id: `gmaps-${pid}`,
        name,
        lat: loc.latitude,
        lon: loc.longitude!,
        address: p.formattedAddress as string | undefined,
        kind: "google place",
      };
      const detail: GooglePlaceDetail = {};
      if (typeof p.rating === "number") detail.rating = p.rating;
      if (typeof p.userRatingCount === "number")
        detail.userRatingCount = p.userRatingCount;
      const pl = priceLevel(p.priceLevel);
      if (pl !== undefined) detail.priceLevel = pl;
      const open = p.currentOpeningHours as { openNow?: boolean };
      if (typeof open?.openNow === "boolean") detail.openNow = open.openNow;
      ids[place.id] = pid;
      details.set(pid, detail);
      out.push({ place, detail });
    }
    saveIds();
    return out;
  } catch {
    return [];
  }
}

export async function enrichPlace(
  place: Place,
  origin?: Place,
  signal?: AbortSignal,
): Promise<GooglePlaceDetail | undefined> {
  const id = await placeIdFor(place, origin).catch(() => undefined);
  if (!id) return;
  return detailsFor(id, signal);
}

export function gmapsUrl(p: { name: string; address?: string }) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    [p.name, p.address].filter(Boolean).join(", "),
  )}`;
}
export function gmapsEmbedUrl(p: { name: string; address?: string }) {
  const key = import.meta.env.VITE_GOOGLE_EMBED_KEY;
  return key
    ? `https://www.google.com/maps/embed/v1/place?key=${key}&q=${encodeURIComponent(
        [p.name, p.address].filter(Boolean).join(", "),
      )}`
    : undefined;
}
export function detailSummary(d: GooglePlaceDetail) {
  return [
    d.rating !== undefined &&
      `★ ${d.rating}${
        d.userRatingCount !== undefined
          ? ` (${
              d.userRatingCount >= 1000
                ? `${(d.userRatingCount / 1000).toFixed(1)}k`
                : d.userRatingCount
            })`
          : ""
      }`,
    d.priceLevel !== undefined &&
      (d.priceLevel ? "$".repeat(d.priceLevel) : "Free"),
    d.openNow !== undefined && (d.openNow ? "Open now" : "Closed"),
  ]
    .filter(Boolean)
    .join(" · ");
}
