let warning = "";
export function storageWarning() {
  return warning;
}
export function readStored<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): T {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    warning =
      "Browser storage unavailable or damaged. Changes may not survive a reload.";
    return fallback;
  }
}
export function writeStored(key: string, value: unknown) {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(key, JSON.stringify(value));
  } catch {
    warning =
      "Browser storage is full or disabled. Data is kept only for this session.";
  }
}

// Wave-0: typed helpers over readStored/writeStored for the new
// persisted collections. Keys match the shared contract so the Worker
// sync layer (W1) mirrors the same shapes.
import type {
  CachedPlan,
  FavoriteLine,
  RecentSearch,
  SavedPlace,
} from "./contracts";

const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string" && !!v;
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

function isSavedPlace(v: unknown): v is SavedPlace {
  return (
    obj(v) &&
    str(v.id) &&
    str(v.label) &&
    ["home", "work", "gym", "pin"].includes(v.icon as string) &&
    num(v.lat) &&
    num(v.lon) &&
    num(v.updatedAt)
  );
}
function isRecentSearch(v: unknown): v is RecentSearch {
  return obj(v) && str(v.id) && str(v.label) && num(v.ts);
}
function isFavoriteLine(v: unknown): v is FavoriteLine {
  return obj(v) && str(v.routeId) && str(v.shortName);
}
function isCachedPlan(v: unknown): v is CachedPlan {
  return (
    obj(v) &&
    num(v.savedAt) &&
    str(v.query) &&
    obj(v.origin) &&
    num(v.origin.lat) &&
    num(v.origin.lon) &&
    (v.mode === "depart" || v.mode === "arrive") &&
    Array.isArray(v.results)
  );
}

const list =
  <T>(key: string, item: (v: unknown) => v is T, max: number) =>
  () =>
    readStored<T[]>(key, [], (v): v is T[] =>
      Array.isArray(v) ? v.every(item) : false,
    ).slice(0, max);

export const readBookmarks = list<SavedPlace>(
  "tt_bookmarks_v1",
  isSavedPlace,
  4,
);
export const writeBookmarks = (v: SavedPlace[]) =>
  writeStored("tt_bookmarks_v1", v.slice(0, 4));
export const readRecentSearches = list<RecentSearch>(
  "tt_recent_searches_v1",
  isRecentSearch,
  8,
);
export const writeRecentSearches = (v: RecentSearch[]) =>
  writeStored("tt_recent_searches_v1", v.slice(0, 8));
export const readFavoriteLines = list<FavoriteLine>(
  "tt_favorite_lines_v1",
  isFavoriteLine,
  32,
);
export const writeFavoriteLines = (v: FavoriteLine[]) =>
  writeStored("tt_favorite_lines_v1", v.slice(0, 32));
export const readCachedPlan = () =>
  readStored<CachedPlan | null>("tt_last_plan_cache_v1", null, isCachedPlan);
export const writeCachedPlan = (v: CachedPlan) =>
  writeStored("tt_last_plan_cache_v1", v);
export const readWorkerSync = () =>
  readStored<{ url: string; token: string }>(
    "tt_worker_sync_v1",
    { url: "", token: "" },
    (v): v is { url: string; token: string } =>
      obj(v) && typeof v.url === "string" && typeof v.token === "string",
  );
export const writeWorkerSync = (v: { url: string; token: string }) =>
  writeStored("tt_worker_sync_v1", v);
