import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runBacktest, BACKTEST_LEAGUES } from "./backtest.server";

const RunInput = z.object({
  name: z.string().min(1).max(120).default("Untitled backtest"),
  leagueId: z.number().int().positive(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  maxMatches: z.number().int().min(1).max(200).default(50),
  // model config — defaults match production constants
  temperature: z.number().min(0.5).max(3).default(1.289),
  homeAdvantage: z.number().min(1.0).max(1.5).default(1.15),
  dcRho: z.number().min(-0.2).max(0.2).default(0.08),
  xgWeight: z.number().min(0).max(1).default(0.7),
});

export const runBacktestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RunInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const league = BACKTEST_LEAGUES.find((l) => l.id === data.leagueId);
    const competitionName = league
      ? `${league.name} (${league.country})`
      : `League ${data.leagueId}`;

    // 1. Insert pending row so the user has something to look at if it fails.
    const { data: inserted, error: insErr } = await supabase
      .from("backtest_runs")
      .insert({
        user_id: userId,
        name: data.name,
        competition_id: String(data.leagueId),
        competition_name: competitionName,
        date_from: data.from,
        date_to: data.to,
        status: "running",
        temperature: data.temperature,
        home_advantage: data.homeAdvantage,
        dc_rho: data.dcRho,
        xg_weight: data.xgWeight,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      throw new Error(`Failed to create backtest run: ${insErr?.message}`);
    }
    const runId = inserted.id;

    try {
      const summary = await runBacktest({
        leagueId: data.leagueId,
        from: data.from,
        to: data.to,
        maxMatches: data.maxMatches,
        cfg: {
          temperature: data.temperature,
          homeAdvantage: data.homeAdvantage,
          dcRho: data.dcRho,
          xgWeight: data.xgWeight,
        },
      });

      const { error: updErr } = await supabase
        .from("backtest_runs")
        .update({
          status: "completed",
          matches_total: summary.matchesTotal,
          matches_scored: summary.matchesScored,
          brier_1x2: summary.brier_1x2,
          logloss_1x2: summary.logloss_1x2,
          hitrate_1x2: summary.hitrate_1x2,
          brier_btts: summary.brier_btts,
          brier_ou25: summary.brier_ou25,
          roi_flat: summary.roi_flat,
          bets_placed: summary.bets_placed,
          results: summary.predictions as unknown,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runId);
      if (updErr) throw new Error(updErr.message);

      return { runId, summary };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Backtest failed";
      await supabase
        .from("backtest_runs")
        .update({ status: "failed", error_message: msg.slice(0, 500) })
        .eq("id", runId);
      throw e;
    }
  });

export const listBacktestRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("backtest_runs")
      .select(
        "id, name, competition_name, date_from, date_to, status, error_message, matches_total, matches_scored, brier_1x2, logloss_1x2, hitrate_1x2, brier_btts, brier_ou25, roi_flat, bets_placed, temperature, home_advantage, dc_rho, xg_weight, created_at, completed_at",
      )
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { runs: data ?? [] };
  });

export const getBacktestRun = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from("backtest_runs")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { run: row };
  });

export const deleteBacktestRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("backtest_runs")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getBacktestLeagues = createServerFn({ method: "GET" }).handler(async () => {
  return { leagues: BACKTEST_LEAGUES };
});