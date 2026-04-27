import { useEffect, useRef, useState } from "react";
import { getLiveScores } from "@/server/football.functions";

export interface LiveScoreLite {
  id: number;
  status: string;
  minute: number | null;
  home: number | null;
  away: number | null;
}

const POLL_MS = 30_000;
const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);

/** Returns true when a status string indicates a match is currently in progress. */
export function isLiveStatus(status: string | undefined | null): boolean {
  return !!status && LIVE_STATUSES.has(status);
}

/**
 * Polls the server every 30 seconds for in-play scores.
 * Returns a Map<fixtureId, LiveScoreLite> covering every match currently live.
 *
 * The hook is "always on" for the page that mounts it — but the underlying
 * server function dedupes calls via a 25s in-memory cache, so concurrent
 * users share API budget.
 */
export function useLiveScores(): Map<number, LiveScoreLite> {
  const [map, setMap] = useState<Map<number, LiveScoreLite>>(new Map());
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function tick() {
      try {
        const res = await getLiveScores();
        if (cancelledRef.current) return;
        const next = new Map<number, LiveScoreLite>();
        for (const s of res.scores) next.set(s.id, s);
        setMap(next);
      } catch {
        // silently ignore — keep last known state
      }
    }

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, []);

  return map;
}
