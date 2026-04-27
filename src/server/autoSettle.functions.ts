import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchMatch } from "./footballData.server";
import type { MatchSummary } from "@/lib/football/types";
import { fetchClosingOdds } from "./oddsData.server";

function adminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

// API-SPORTS short status codes that indicate the match is fully finished.
// FT = Full Time, AET = After Extra Time, PEN = Penalties, AWD = Awarded.
const FINAL_STATUSES = new Set(["FT", "AET", "PEN", "AWD"]);
// Statuses that should void all bets on the match.
const CANCELLED_STATUSES = new Set(["CANC", "ABD", "WO", "PST"]);

type Outcome = "won" | "lost" | "void" | "pending";

function profitForOutcome(outcome: Outcome, stake: number, decimalOdds: number): number {
  if (outcome === "won") return +(stake * (decimalOdds - 1)).toFixed(2);
  if (outcome === "lost") return -stake;
  return 0;
}

/** Decide outcome of a single bet given the final score / status of the match. */
function gradeBet(
  market: string,
  selection: string,
  match: MatchSummary,
): Outcome {
  if (CANCELLED_STATUSES.has(match.status)) return "void";
  if (!FINAL_STATUSES.has(match.status)) return "pending";

  const home = match.score.fullTime.home;
  const away = match.score.fullTime.away;
  if (home == null || away == null) return "pending";

  const total = home + away;
  const sel = selection.trim();

  switch (market) {
    case "1x2": {
      const winner = home > away ? "1" : home < away ? "2" : "X";
      // Accept "1"/"X"/"2", or words like "Home"/"Draw"/"Away".
      const norm = sel.toUpperCase();
      if (["1", "HOME", "H"].includes(norm)) return winner === "1" ? "won" : "lost";
      if (["X", "DRAW", "D"].includes(norm)) return winner === "X" ? "won" : "lost";
      if (["2", "AWAY", "A"].includes(norm)) return winner === "2" ? "won" : "lost";
      return "pending";
    }
    case "ou_25": {
      if (/^over/i.test(sel)) return total > 2.5 ? "won" : "lost";
      if (/^under/i.test(sel)) return total < 2.5 ? "won" : "lost";
      return "pending";
    }
    case "ou_15": {
      if (/^over/i.test(sel)) return total > 1.5 ? "won" : "lost";
      if (/^under/i.test(sel)) return total < 1.5 ? "won" : "lost";
      return "pending";
    }
    case "btts": {
      const yes = home > 0 && away > 0;
      if (/^yes/i.test(sel)) return yes ? "won" : "lost";
      if (/^no/i.test(sel)) return yes ? "lost" : "won";
      return "pending";
    }
    default:
      // Unknown / bookmaker-specific market — leave for manual settlement.
      return "pending";
  }
}

export interface AutoSettleResult {
  settled: number;
  voided: number;
  stillPending: number;
  bankrollDelta: number;
  errors: string[];
}

/**
 * Walk all pending bets for a user, look up final scores, and settle the ones
 * we can grade. Updates bankroll in a single delta at the end.
 */
export const autoSettleBets = createServerFn({ method: "POST" })
  .inputValidator((input: { userId: string }) => input)
  .handler(async ({ data }): Promise<AutoSettleResult> => {
    const supabase = adminClient();
    const userId = data.userId;
    const errors: string[] = [];

    const { data: pending, error: pErr } = await supabase
      .from("bet_log")
      .select("id, match_id, market, selection, stake, decimal_odds, status, profit")
      .eq("user_id", userId)
      .eq("status", "pending");
    if (pErr) {
      return {
        settled: 0,
        voided: 0,
        stillPending: 0,
        bankrollDelta: 0,
        errors: [pErr.message],
      };
    }

    const rows = pending ?? [];
    if (rows.length === 0) {
      return { settled: 0, voided: 0, stillPending: 0, bankrollDelta: 0, errors: [] };
    }

    // Group by match_id to avoid duplicate API calls when one user has
    // multiple bets on the same fixture.
    const matchIds = Array.from(
      new Set(rows.map((r) => r.match_id).filter((x): x is number => x != null)),
    );
    const matchById = new Map<number, MatchSummary>();
    await Promise.all(
      matchIds.map(async (id) => {
        try {
          const m = await fetchMatch(id);
          matchById.set(id, m);
        } catch (e) {
          errors.push(`match ${id}: ${e instanceof Error ? e.message : "lookup failed"}`);
        }
      }),
    );

    let settled = 0;
    let voided = 0;
    let stillPending = 0;
    let bankrollDelta = 0;

    for (const bet of rows) {
      if (bet.match_id == null) {
        stillPending++;
        continue;
      }
      const match = matchById.get(bet.match_id);
      if (!match) {
        stillPending++;
        continue;
      }
      const outcome = gradeBet(bet.market, bet.selection, match);
      if (outcome === "pending") {
        stillPending++;
        continue;
      }
      const stake = Number(bet.stake);
      const odds = Number(bet.decimal_odds);
      const newProfit = profitForOutcome(outcome, stake, odds);
      const prevProfit = Number(bet.profit ?? 0);
      const delta = newProfit - prevProfit;

      // CLV capture (best-effort): pull the closing decimal odds for this
      // match+market+selection from The Odds API and compute CLV.
      // Fields we update:
      //   closing_odds            — bookmaker closing decimal odds
      //   closing_odds_captured_at — timestamp of capture
      //   clv_pct                 — (taken / closing - 1) * 100
      const update: Record<string, unknown> = { status: outcome, profit: newProfit };
      try {
        const closing = await fetchClosingOdds({
          match,
          market: bet.market,
          selection: bet.selection,
        });
        if (closing && closing > 1) {
          update.closing_odds = +closing.toFixed(3);
          update.closing_odds_captured_at = new Date().toISOString();
          update.clv_pct = +(((odds / closing) - 1) * 100).toFixed(2);
        }
      } catch (e) {
        // CLV is optional metadata — never block settlement on it.
        console.warn("CLV capture failed for bet", bet.id, e);
      }
      const { error: updErr } = await supabase
        .from("bet_log")
        .update(update)
        .eq("id", bet.id);
      if (updErr) {
        errors.push(`bet ${bet.id}: ${updErr.message}`);
        continue;
      }
      if (outcome === "void") voided++;
      else settled++;
      bankrollDelta += delta;
    }

    if (bankrollDelta !== 0) {
      const { data: br } = await supabase
        .from("bankroll_settings")
        .select("current_bankroll")
        .eq("user_id", userId)
        .maybeSingle();
      if (br) {
        const next = +(Number(br.current_bankroll) + bankrollDelta).toFixed(2);
        const { error: brErr } = await supabase
          .from("bankroll_settings")
          .update({ current_bankroll: next })
          .eq("user_id", userId);
        if (brErr) errors.push(`bankroll: ${brErr.message}`);
      }
    }

    return {
      settled,
      voided,
      stillPending,
      bankrollDelta: +bankrollDelta.toFixed(2),
      errors,
    };
  });