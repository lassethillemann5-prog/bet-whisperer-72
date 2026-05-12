import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  calibrateLeague,
  recomputeLeagueElo,
  getLeagueCalibration,
} from "@/server/leagueCalibration.server";
import { BACKTEST_LEAGUES } from "@/server/backtest.server";

export const listCalibratableLeagues = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const all = await Promise.all(
      BACKTEST_LEAGUES.map(async (l) => ({
        ...l,
        calibration: await getLeagueCalibration(l.id),
      })),
    );
    return all;
  });

export const runLeagueCalibration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        leagueId: z.number().int().positive(),
        from: z.string().min(8),
        to: z.string().min(8),
        maxMatches: z.number().int().min(10).max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    return calibrateLeague(data);
  });

export const runLeagueEloRecompute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        leagueId: z.number().int().positive(),
        from: z.string().min(8),
        to: z.string().min(8),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    return recomputeLeagueElo(data);
  });
