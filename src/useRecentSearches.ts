// Wave-1: recent searches — persisted to localStorage, mirrored to the
// worker via pushSync when configured.
import { useState } from "react";
import { readRecentSearches, writeRecentSearches } from "./storage";
import type { RecentSearch } from "./contracts";
import type { PushSync } from "./useSyncPush";
export function useRecentSearches({ pushSync }: { pushSync: PushSync }) {
  const [recents, setRecents] = useState<RecentSearch[]>(readRecentSearches);
  function recordRecent(term: string) {
    const label = term.trim();
    if (!label || label.length > 40) return;
    const next = [
      { id: label.toLowerCase(), label, ts: Date.now() },
      ...readRecentSearches().filter((r) => r.id !== label.toLowerCase()),
    ].slice(0, 8);
    writeRecentSearches(next);
    setRecents(next);
    pushSync({ recentSearches: next });
  }
  return { recents, setRecents, recordRecent };
}
