// WAVE-2: favorite transit lines — a star badge on journey legs;
// localStorage first, optional worker sync when configured
import { useState } from "react";
import type { Leg } from "./core";
import { readFavoriteLines, writeFavoriteLines } from "./storage";
import type { FavoriteLine } from "./contracts";
import type { PushSync } from "./useSyncPush";
export function useFavorites({ pushSync }: { pushSync: PushSync }) {
  const [favorites, setFavorites] = useState<FavoriteLine[]>(readFavoriteLines);
  const favKey = (l: Leg) => l.routeId || l.routeShortName || l.mode;
  function isFavorite(leg: Leg) {
    return favorites.some((f) => f.routeId === favKey(leg));
  }
  function toggleFavorite(leg: Leg) {
    const routeId = favKey(leg);
    setFavorites((prev) => {
      const next = prev.some((f) => f.routeId === routeId)
        ? prev.filter((f) => f.routeId !== routeId)
        : [
            ...prev,
            {
              routeId,
              agencyId: leg.agencyId,
              shortName: leg.routeShortName || leg.mode,
              color: leg.routeColor,
            },
          ].slice(0, 32);
      writeFavoriteLines(next);
      pushSync({ favoriteLines: next });
      return next;
    });
  }
  return { favorites, setFavorites, isFavorite, toggleFavorite };
}
