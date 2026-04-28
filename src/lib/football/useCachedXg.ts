import { useEffect, useRef, useState } from "react";
import { getCachedPreMatchXg } from "@/server/football.functions";

/**
 * Loads pre-match expected goals for a list of fixture IDs from the
 * `predictions_cache` table. Re-fetches only when the set of IDs changes —
 * so polling live scores every 30s does NOT re-query xG.
 *
 * Returns Map<fixtureId, { home, away }>.
 */
export function useCachedXg(matchIds: number[]): Map<number, { home: number; away: number }> {
  const [map, setMap] = useState<Map<number, { home: number; away: number }>>(new Map());
  const lastKeyRef = useRef<string>("");

  useEffect(() => {
    const sorted = [...new Set(matchIds)].sort((a, b) => a - b);
    const key = sorted.join(",");
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;

    if (sorted.length === 0) {
      setMap(new Map());
      return;
    }

    let cancelled = false;
    getCachedPreMatchXg({ data: { matchIds: sorted } })
      .then((res) => {
        if (cancelled) return;
        const next = new Map<number, { home: number; away: number }>();
        for (const [id, v] of Object.entries(res.xg)) next.set(Number(id), v);
        // Preserve previously known xG for IDs still present
        setMap((prev) => {
          for (const id of sorted) {
            if (!next.has(id) && prev.has(id)) next.set(id, prev.get(id)!);
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [matchIds]);

  return map;
}
