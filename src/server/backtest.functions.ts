import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { predictMarkets } from "@/lib/football/predictor";
import type { MatchSummary, TeamForm } from "@/lib/football/types";

const BASE = "https://v3.football.api-sports.io";

function adminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

function apiKey(): string {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("FOOTBALL_DATA_API_KEY is not configured");
  return key;
}

interface ApiSportsFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { name: string; id?: number };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
  goals: { home: number | null; away: number | null };
  score: { fulltime?: { home: number | null; away: number | null } };
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": apiKey() },
  });
  if (!res.ok) throw new Error(`API-SPORTS ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Build a TeamForm snapshot from a list of FT fixtures BEFORE a cutoff date,
 * applying the same time-decay logic as the live pipeline.
 * This is the key to a fair backtest: we never let the model "see the future".
 */
function buildHistoricalForm(
  fixtures: ApiSportsFixture[],
  teamId: number,
  cutoffMs: number,
  limit = 8,
): TeamForm | null {
  const HALF_LIFE_DAYS = 90;
  const decayLambda = Math.LN2 / HALF_LIFE_DAYS;
  const past = fixtures
    .filter((f) => new Date(f.fixture.date).getTime() < cutoffMs)
    .filter((f) => f.fixture.status.short === "FT")
    .filter(
      (f) => f.goals.home != null && f.goals.away != null,
    )
    .sort(
      (a, b) =>
        new Date(b.fixture.date).getTime() - new Date(a.fixture.date).getTime(),
    )
    .slice(0, limit);

  if (past.length === 0) return null;

  let played = 0,
    wins = 0,
    draws = 0,
    losses = 0,
    goalsFor = 0,
    goalsAgainst = 0;
  let wAttack = 0,
    wDefense = 0,
    wSum = 0;
  const last5: ("W" | "D" | "L")[] = [];

  for (const f of past.reverse()) {
    const isHome = f.teams.home.id === teamId;
    const gf = (isHome ? f.goals.home : f.goals.away) ?? 0;
    const ga = (isHome ? f.goals.away : f.goals.home) ?? 0;
    played++;
    goalsFor += gf;
    goalsAgainst += ga;
    let r: "W" | "D" | "L";
    if (gf > ga) { wins++; r = "W"; }
    else if (gf < ga) { losses++; r = "L"; }
    else { draws++; r = "D"; }
    last5.push(r);
    const ageDays =
      (cutoffMs - new Date(f.fixture.date).getTime()) / (1000 * 60 * 60 * 24);
    const w = Math.exp(-decayLambda * Math.max(0, ageDays));
    wAttack += gf * w;
    wDefense += ga * w;
    wSum += w;
  }

  return {
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    last5: last5.slice(-5),
    weightedAttackPerGame: wSum > 0 ? wAttack / wSum : undefined,
    weightedDefensePerGame: wSum > 0 ? wDefense / wSum : undefined,
    effectiveSample: wSum > 0 ? wSum : undefined,
  };
}

interface MarketStat {
  market: string;
  predictions: number;
  correct: number;
  brier: number;
  logLoss: number;
  roi: number;
  staked: number;
}

function newStat(market: string): MarketStat {
  return { market, predictions: 0, correct: 0, brier: 0, logLoss: 0, roi: 0, staked: 0 };
}

export interface BacktestResult {
  matchesTested: number;
  windowDays: number;
  accuracy: number;
  brierScore: number;
  logLoss: number;
  roiPct: number;
  marketBreakdown: Record<string, {
    accuracy: number;
    brier: number;
    logLoss: number;
    roi: number;
    n: number;
  }>;
  error: string | null;
}

/**
 * Run a walk-forward backtest:
 *  1. Pull all FT fixtures from the chosen league for the last N days.
 *  2. For each fixture, rebuild each team's form using ONLY earlier FT matches.
 *  3. Run predictMarkets() and grade the prediction against the actual score.
 *  4. Aggregate Brier, log-loss, accuracy, and flat-stake ROI vs fair odds.
 *
 * Default league: Premier League (39). Default window: 60 days.
 * Bounded to <= 25 fixtures per call so we don't burn API quota.
 */
export const runBacktest = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { leagueId?: number; days?: number; maxMatches?: number } | undefined) =>
      input ?? {},
  )
  .handler(async ({ data }): Promise<BacktestResult> => {
    const leagueId = data.leagueId ?? 39; // Premier League
    const windowDays = Math.min(120, Math.max(7, data.days ?? 60));
    const maxMatches = Math.min(40, Math.max(5, data.maxMatches ?? 25));

    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - windowDays);
      const season = to.getMonth() >= 6 ? to.getFullYear() : to.getFullYear() - 1;

      // 1. Pull every league fixture in a wider window so we have history for each team
      const lookback = new Date();
      lookback.setDate(lookback.getDate() - windowDays - 180);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const all = await apiFetch<{ response: ApiSportsFixture[] }>(
        `/fixtures?league=${leagueId}&season=${season}&from=${fmt(lookback)}&to=${fmt(to)}`,
      );
      const fixtures = (all.response ?? [])
        .filter((f) => f.fixture.status.short === "FT")
        .sort(
          (a, b) =>
            new Date(a.fixture.date).getTime() -
            new Date(b.fixture.date).getTime(),
        );

      // 2. Pick the most recent N matches inside the testing window as the eval set
      const evalSet = fixtures
        .filter((f) => new Date(f.fixture.date).getTime() >= from.getTime())
        .slice(-maxMatches);

      if (evalSet.length === 0) {
        return {
          matchesTested: 0,
          windowDays,
          accuracy: 0,
          brierScore: 0,
          logLoss: 0,
          roiPct: 0,
          marketBreakdown: {},
          error: "No finished matches found in window",
        };
      }

      // Pre-bucket fixtures by team for fast historical lookups
      const byTeam = new Map<number, ApiSportsFixture[]>();
      for (const f of fixtures) {
        for (const tid of [f.teams.home.id, f.teams.away.id]) {
          const arr = byTeam.get(tid) ?? [];
          arr.push(f);
          byTeam.set(tid, arr);
        }
      }

      const stats = new Map<string, MarketStat>();
      const ensure = (k: string) => {
        let s = stats.get(k);
        if (!s) { s = newStat(k); stats.set(k, s); }
        return s;
      };

      let totalPreds = 0;
      let totalCorrect = 0;
      let totalBrier = 0;
      let totalLogLoss = 0;
      let totalStaked = 0;
      let totalProfit = 0;

      for (const f of evalSet) {
        const cutoffMs = new Date(f.fixture.date).getTime();
        const homeForm = buildHistoricalForm(byTeam.get(f.teams.home.id) ?? [], f.teams.home.id, cutoffMs);
        const awayForm = buildHistoricalForm(byTeam.get(f.teams.away.id) ?? [], f.teams.away.id, cutoffMs);
        if (!homeForm || !awayForm) continue;

        const { markets } = predictMarkets(homeForm, awayForm);
        const home = f.goals.home ?? 0;
        const away = f.goals.away ?? 0;
        const total = home + away;
        const winner: "1" | "X" | "2" = home > away ? "1" : home < away ? "2" : "X";
        const bttsYes = home > 0 && away > 0;

        // Grade three primary markets: 1x2, ou_25, btts.
        // For each: probability of the actual outcome → Brier + log-loss;
        // model's pick correct? → accuracy; flat 1u stake at fair odds → ROI.
        const grade = (
          marketKey: string,
          probOfActual: number,
          modelPickWon: boolean,
        ) => {
          const s = ensure(marketKey);
          const p = Math.max(0.001, Math.min(0.999, probOfActual));
          s.predictions++;
          s.brier += (1 - p) * (1 - p);
          s.logLoss += -Math.log(p);
          if (modelPickWon) s.correct++;
          // Flat-stake ROI: bet 1 unit on the model's pick at fair odds.
          // Fair odds = 1 / (pickProb/100). Profit if pick won = odds - 1, else -1.
          // We use the pick's own probability separately from probOfActual.
        };

        const m1x2 = markets.find((m) => m.market === "1x2");
        if (m1x2) {
          const probActual = (m1x2.probabilities[winner] ?? 0) / 100;
          const pick = m1x2.pick.startsWith("1") ? "1" : m1x2.pick.startsWith("2") ? "2" : "X";
          const pickProb = (m1x2.probabilities[pick] ?? 0) / 100;
          const won = pick === winner;
          grade("1x2", probActual, won);
          if (pickProb > 0) {
            const odds = 1 / pickProb;
            const stat = ensure("1x2");
            stat.staked += 1;
            stat.roi += won ? odds - 1 : -1;
          }
        }

        const mou = markets.find((m) => m.market === "ou_25");
        if (mou) {
          const overActual = total > 2.5;
          const probActual = ((overActual ? mou.probabilities["Over"] : mou.probabilities["Under"]) ?? 0) / 100;
          const pickIsOver = /^over/i.test(mou.pick);
          const pickProb = ((pickIsOver ? mou.probabilities["Over"] : mou.probabilities["Under"]) ?? 0) / 100;
          const won = pickIsOver === overActual;
          grade("ou_25", probActual, won);
          if (pickProb > 0) {
            const odds = 1 / pickProb;
            const s = ensure("ou_25");
            s.staked += 1;
            s.roi += won ? odds - 1 : -1;
          }
        }

        const mb = markets.find((m) => m.market === "btts");
        if (mb) {
          const probActual = ((bttsYes ? mb.probabilities["Yes"] : mb.probabilities["No"]) ?? 0) / 100;
          const pickIsYes = /^yes/i.test(mb.pick);
          const pickProb = ((pickIsYes ? mb.probabilities["Yes"] : mb.probabilities["No"]) ?? 0) / 100;
          const won = pickIsYes === bttsYes;
          grade("btts", probActual, won);
          if (pickProb > 0) {
            const odds = 1 / pickProb;
            const s = ensure("btts");
            s.staked += 1;
            s.roi += won ? odds - 1 : -1;
          }
        }
      }

      // Aggregate
      const marketBreakdown: BacktestResult["marketBreakdown"] = {};
      for (const s of stats.values()) {
        if (s.predictions === 0) continue;
        const acc = s.correct / s.predictions;
        const brier = s.brier / s.predictions;
        const ll = s.logLoss / s.predictions;
        const roiPct = s.staked > 0 ? (s.roi / s.staked) * 100 : 0;
        marketBreakdown[s.market] = {
          accuracy: +(acc * 100).toFixed(1),
          brier: +brier.toFixed(4),
          logLoss: +ll.toFixed(4),
          roi: +roiPct.toFixed(1),
          n: s.predictions,
        };
        totalPreds += s.predictions;
        totalCorrect += s.correct;
        totalBrier += s.brier;
        totalLogLoss += s.logLoss;
        totalStaked += s.staked;
        totalProfit += s.roi;
      }

      if (totalPreds === 0) {
        return {
          matchesTested: evalSet.length,
          windowDays,
          accuracy: 0,
          brierScore: 0,
          logLoss: 0,
          roiPct: 0,
          marketBreakdown: {},
          error: "Not enough historical data to build forms",
        };
      }

      const result: BacktestResult = {
        matchesTested: evalSet.length,
        windowDays,
        accuracy: +((totalCorrect / totalPreds) * 100).toFixed(1),
        brierScore: +(totalBrier / totalPreds).toFixed(4),
        logLoss: +(totalLogLoss / totalPreds).toFixed(4),
        roiPct: totalStaked > 0 ? +((totalProfit / totalStaked) * 100).toFixed(1) : 0,
        marketBreakdown,
        error: null,
      };

      // Persist run (best-effort)
      try {
        const supabase = adminClient();
        await supabase.from("backtest_runs").insert({
          matches_tested: result.matchesTested,
          window_days: result.windowDays,
          accuracy: result.accuracy,
          brier_score: result.brierScore,
          log_loss: result.logLoss,
          roi_pct: result.roiPct,
          market_breakdown: result.marketBreakdown,
          notes: `League ${leagueId}, season ${season}`,
        });
      } catch (e) {
        console.warn("backtest persist failed", e);
      }

      return result;
    } catch (e) {
      console.error("runBacktest failed", e);
      const msg = e instanceof Error ? e.message : "Backtest failed";
      return {
        matchesTested: 0,
        windowDays,
        accuracy: 0,
        brierScore: 0,
        logLoss: 0,
        roiPct: 0,
        marketBreakdown: {},
        error: msg,
      };
    }
  });

/** Read the most recent backtest result without recomputing. */
export const getLatestBacktest = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ run: BacktestResult | null; createdAt: string | null }> => {
    try {
      const supabase = adminClient();
      const { data } = await supabase
        .from("backtest_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return { run: null, createdAt: null };
      return {
        run: {
          matchesTested: data.matches_tested,
          windowDays: data.window_days,
          accuracy: Number(data.accuracy),
          brierScore: Number(data.brier_score),
          logLoss: Number(data.log_loss),
          roiPct: Number(data.roi_pct),
          marketBreakdown: (data.market_breakdown as BacktestResult["marketBreakdown"]) ?? {},
          error: null,
        },
        createdAt: data.created_at,
      };
    } catch (e) {
      console.warn("getLatestBacktest failed", e);
      return { run: null, createdAt: null };
    }
  },
);