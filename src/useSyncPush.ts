// WAVE-2: worker sync — last-write-wins on the whole blob. localStorage
// is the source of truth; a newer remote blob is adopted wholesale.
// The three mirrored slices live in their owner hooks; the orchestrator
// re-links them here every render so pushSync always reads the latest.
import { useRef } from "react";
import {
  writeBookmarks,
  writeFavoriteLines,
  writeRecentSearches,
} from "./storage";
import { syncConfigured, syncState, type SyncState } from "./syncClient";
import type { FavoriteLine, RecentSearch, SavedPlace } from "./contracts";
export type SyncPatch = Partial<
  Pick<SyncState, "bookmarks" | "favoriteLines" | "recentSearches">
>;
export type PushSync = (patch?: SyncPatch) => void;
export type SyncLink = {
  bookmarks: SavedPlace[];
  favorites: FavoriteLine[];
  recents: RecentSearch[];
  setBookmarks: (value: SavedPlace[]) => void;
  setFavorites: (value: FavoriteLine[]) => void;
  setRecents: (value: RecentSearch[]) => void;
};
export function useSyncPush() {
  const linked = useRef<SyncLink | null>(null);
  function pushSync(patch: SyncPatch = {}) {
    const state = linked.current;
    if (!state || !syncConfigured()) return;
    const local: SyncState = {
      bookmarks: patch.bookmarks ?? state.bookmarks,
      favoriteLines: patch.favoriteLines ?? state.favorites,
      recentSearches: patch.recentSearches ?? state.recents,
      updatedAt: Date.now(),
    };
    syncState(local).then((merged) => {
      if (!merged || merged.updatedAt <= local.updatedAt) return;
      const current = linked.current;
      if (!current) return;
      current.setBookmarks(merged.bookmarks);
      writeBookmarks(merged.bookmarks);
      current.setFavorites(merged.favoriteLines);
      writeFavoriteLines(merged.favoriteLines);
      current.setRecents(merged.recentSearches);
      writeRecentSearches(merged.recentSearches);
    });
  }
  function link(state: SyncLink) {
    linked.current = state;
  }
  return { pushSync, link };
}
