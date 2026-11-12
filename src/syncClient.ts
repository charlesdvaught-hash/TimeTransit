// W1: thin client for the relay's /api/* routes — KV state sync, bookmark
// boarding times, and nearby departures. Every failure path returns null/[]
// so an unreachable or unconfigured worker degrades quietly (same pattern as
// events.ts). Config lives in localStorage via readWorkerSync/writeWorkerSync.
import { readWorkerSync, writeWorkerSync } from "./storage";
import type { FavoriteLine, RecentSearch, SavedPlace } from "./contracts";

export type SyncState = {
  bookmarks: SavedPlace[];
  favoriteLines: FavoriteLine[];
  recentSearches: RecentSearch[];
  updatedAt: number;
};
export type BoardBookmark = Pick<SavedPlace, "id" | "label" | "lat" | "lon">;
export type BoardEntry = {
  id: string;
  label: string;
  departISO: string;
  arriveISO: string;
  durationMin: number;
  summary: string;
};
export type NearbyDeparture = {
  routeName: string;
  headsign: string;
  departISO: string;
  realtime: boolean;
};
export type NearbyStop = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  departures: NearbyDeparture[];
};

// Flips false for the session on any 5xx from the configured worker —
// mirrors events.ts' eventsEnabled so a dead relay stops being polled.
export let syncEnabled = true;

export const loadSync = () => readWorkerSync();
export const saveSync = (v: { url: string; token: string }) =>
  writeWorkerSync(v);

function config() {
  const { url, token } = readWorkerSync();
  if (url && token) return { url: url.replace(/\/+$/, ""), token };
  // On the gated Cloudflare site, same-origin /api/state is keyed by the
  // Access-verified email — sync auto-configures, no manual setup.
  if (location.hostname === "timetransit-site.charlesdvaught-34c.workers.dev")
    return { url: location.origin, token: "" };
  return null;
}
export const syncConfigured = () => !!config();

async function req(path: string, init: RequestInit): Promise<Response | null> {
  const c = config();
  if (!c || !syncEnabled) return null;
  try {
    const r = await fetch(`${c.url}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(10000),
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${c.token}`,
      },
    });
    if (r.status >= 500) syncEnabled = false;
    return r.ok ? r : null;
  } catch {
    return null;
  }
}

function validState(v: unknown): v is SyncState {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as SyncState;
  return (
    Array.isArray(s.bookmarks) &&
    Array.isArray(s.favoriteLines) &&
    Array.isArray(s.recentSearches) &&
    typeof s.updatedAt === "number" &&
    Number.isFinite(s.updatedAt)
  );
}

// GET /api/state, merge last-write-wins on updatedAt, PUT the winner back.
// Returns the merged state, or null if the worker can't be reached or the
// write-back fails.
export async function syncState(local: SyncState): Promise<SyncState | null> {
  const r = await req("/api/state", { method: "GET" });
  if (!r) return null;
  let remote: SyncState;
  try {
    const j: unknown = await r.json();
    if (!validState(j)) return null;
    remote = j;
  } catch {
    return null;
  }
  const merged = remote.updatedAt >= local.updatedAt ? remote : local;
  const put = await req("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(merged),
  });
  if (!put) return null;
  try {
    const j: unknown = await put.json();
    return validState(j) ? j : merged;
  } catch {
    return merged;
  }
}

// POST /api/board → earliest-arriving option per bookmark, or null on any
// failure. Per-bookmark holes are null entries in the board array.
export async function boardFetch(
  origin: { lat: number; lon: number },
  bookmarks: BoardBookmark[],
): Promise<{ board: (BoardEntry | null)[]; sources: string[] } | null> {
  const r = await req("/api/board", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, bookmarks: bookmarks.slice(0, 4) }),
  });
  if (!r) return null;
  try {
    const j = await r.json();
    return j && Array.isArray(j.board) ? j : null;
  } catch {
    return null;
  }
}

// GET /api/nearby → nearest stops + departures, [] on any failure.
export async function nearbyFetch(
  lat: number,
  lon: number,
): Promise<NearbyStop[]> {
  const p = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    radius: "450",
  });
  const r = await req(`/api/nearby?${p}`, { method: "GET" });
  if (!r) return [];
  try {
    const j = await r.json();
    return j && Array.isArray(j.stops) ? (j.stops as NearbyStop[]) : [];
  } catch {
    return [];
  }
}
