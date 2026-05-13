import { supabase } from "@/integrations/supabase/client";

export interface BankrollSettings {
  id: string;
  user_id: string;
  starting_bankroll: number;
  current_bankroll: number;
  unit_size: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

export type BetStatus = "pending" | "won" | "lost" | "void" | "half_won" | "half_lost";

export interface BetLogRow {
  id: string;
  user_id: string;
  match_id: number | null;
  home_team: string | null;
  away_team: string | null;
  competition: string | null;
  utc_date: string | null;
  market: string;
  selection: string;
  decimal_odds: number;
  stake: number;
  units: number;
  model_probability: number | null;
  status: BetStatus;
  profit: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  closing_odds?: number | null;
  closing_odds_captured_at?: string | null;
  clv_pct?: number | null;
}

/**
 * Confidence-tier flat units recommendation.
 * < 50% : 0 units (skip)
 * 50–60%: 0.5 u
 * 60–70%: 1 u
 * 70–80%: 2 u
 * >= 80%: 3 u
 */
export function unitsForProbability(prob: number): number {
  // prob is 0..1
  if (prob < 0.5) return 0;
  if (prob < 0.6) return 0.5;
  if (prob < 0.7) return 1;
  if (prob < 0.8) return 2;
  return 3;
}

export function tierLabel(prob: number): { label: string; tone: "muted" | "low" | "mid" | "high" | "elite" } {
  if (prob < 0.5) return { label: "Skip", tone: "muted" };
  if (prob < 0.6) return { label: "Low", tone: "low" };
  if (prob < 0.7) return { label: "Standard", tone: "mid" };
  if (prob < 0.8) return { label: "Strong", tone: "high" };
  return { label: "Elite", tone: "elite" };
}

export async function getBankroll(userId: string): Promise<BankrollSettings | null> {
  const { data, error } = await supabase
    .from("bankroll_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as BankrollSettings | null) ?? null;
}

export async function upsertBankroll(input: {
  userId: string;
  startingBankroll: number;
  currentBankroll: number;
  unitSize: number;
  currency: string;
}): Promise<BankrollSettings> {
  const { data, error } = await supabase
    .from("bankroll_settings")
    .upsert(
      {
        user_id: input.userId,
        starting_bankroll: input.startingBankroll,
        current_bankroll: input.currentBankroll,
        unit_size: input.unitSize,
        currency: input.currency,
      },
      { onConflict: "user_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return data as BankrollSettings;
}

export async function listBets(userId: string): Promise<BetLogRow[]> {
  const { data, error } = await supabase
    .from("bet_log")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as BetLogRow[];
}

export async function addBet(input: {
  userId: string;
  matchId?: number | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  competition?: string | null;
  utcDate?: string | null;
  market: string;
  selection: string;
  decimalOdds: number;
  stake: number;
  units: number;
  modelProbability?: number | null;
  notes?: string | null;
}): Promise<BetLogRow> {
  const { data, error } = await supabase
    .from("bet_log")
    .insert({
      user_id: input.userId,
      match_id: input.matchId ?? null,
      home_team: input.homeTeam ?? null,
      away_team: input.awayTeam ?? null,
      competition: input.competition ?? null,
      utc_date: input.utcDate ?? null,
      market: input.market,
      selection: input.selection,
      decimal_odds: input.decimalOdds,
      stake: input.stake,
      units: input.units,
      model_probability: input.modelProbability ?? null,
      notes: input.notes ?? null,
      status: "pending",
      profit: 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as BetLogRow;
}

export function profitForStatus(status: BetStatus, stake: number, decimalOdds: number): number {
  switch (status) {
    case "won":
      return +(stake * (decimalOdds - 1)).toFixed(2);
    case "lost":
      return -stake;
    case "void":
      return 0;
    case "half_won":
      return +((stake / 2) * (decimalOdds - 1)).toFixed(2);
    case "half_lost":
      return +(-stake / 2).toFixed(2);
    case "pending":
    default:
      return 0;
  }
}

export async function settleBet(input: {
  betId: string;
  status: BetStatus;
  stake: number;
  decimalOdds: number;
  userId: string;
}): Promise<{ profit: number; bankrollDelta: number }> {
  // 1. compute new profit
  const newProfit = profitForStatus(input.status, input.stake, input.decimalOdds);

  // 2. read existing bet to compute delta
  const { data: existing, error: readErr } = await supabase
    .from("bet_log")
    .select("profit, status")
    .eq("id", input.betId)
    .single();
  if (readErr) throw readErr;
  const prevProfit = Number(existing?.profit ?? 0);

  // 3. update bet
  const { error: updErr } = await supabase
    .from("bet_log")
    .update({ status: input.status, profit: newProfit })
    .eq("id", input.betId);
  if (updErr) throw updErr;

  // 4. apply delta to bankroll
  const delta = newProfit - prevProfit;
  if (delta !== 0) {
    const current = await getBankroll(input.userId);
    if (current) {
      const next = +(Number(current.current_bankroll) + delta).toFixed(2);
      const { error: brErr } = await supabase
        .from("bankroll_settings")
        .update({ current_bankroll: next })
        .eq("user_id", input.userId);
      if (brErr) throw brErr;
    }
  }

  return { profit: newProfit, bankrollDelta: delta };
}

export async function deleteBet(betId: string, userId: string): Promise<void> {
  // Reverse profit from bankroll first
  const { data: existing } = await supabase
    .from("bet_log")
    .select("profit")
    .eq("id", betId)
    .single();
  const prevProfit = Number(existing?.profit ?? 0);

  const { error } = await supabase.from("bet_log").delete().eq("id", betId);
  if (error) throw error;

  if (prevProfit !== 0) {
    const current = await getBankroll(userId);
    if (current) {
      const next = +(Number(current.current_bankroll) - prevProfit).toFixed(2);
      await supabase
        .from("bankroll_settings")
        .update({ current_bankroll: next })
        .eq("user_id", userId);
    }
  }
}

export interface BankrollStats {
  totalBets: number;
  settled: number;
  pending: number;
  wins: number;
  losses: number;
  voids: number;
  winRate: number; // 0..1, of settled (excluding voids)
  totalStaked: number;
  totalProfit: number;
  unitsStaked: number;
  unitsProfit: number;
  roi: number; // profit / staked, 0..1
  yieldPct: number; // same as roi *100
  avgOdds: number;
  /** Average CLV percentage across bets that have a closing odds capture. */
  avgClvPct: number;
  /** Number of bets with CLV data. */
  clvSample: number;
  /** Share of CLV-tracked bets that beat the close (clv > 0). */
  beatCloseRate: number;
}

export function computeStats(bets: BetLogRow[], unitSize: number): BankrollStats {
  const settled = bets.filter((b) => b.status !== "pending");
  const decided = settled.filter((b) => b.status !== "void");
  const wins = bets.filter((b) => b.status === "won" || b.status === "half_won").length;
  const losses = bets.filter((b) => b.status === "lost" || b.status === "half_lost").length;
  const voids = bets.filter((b) => b.status === "void").length;
  const totalStaked = settled.reduce((s, b) => s + Number(b.stake), 0);
  const totalProfit = settled.reduce((s, b) => s + Number(b.profit), 0);
  const unitsStaked = settled.reduce((s, b) => s + Number(b.units), 0);
  const unitsProfit = unitSize > 0 ? totalProfit / unitSize : 0;
  const avgOdds =
    settled.length > 0
      ? settled.reduce((s, b) => s + Number(b.decimal_odds), 0) / settled.length
      : 0;
  const roi = totalStaked > 0 ? totalProfit / totalStaked : 0;
  const withClv = bets.filter(
    (b) => b.clv_pct != null && Number.isFinite(Number(b.clv_pct)),
  );
  const avgClvPct =
    withClv.length > 0
      ? withClv.reduce((s, b) => s + Number(b.clv_pct), 0) / withClv.length
      : 0;
  const beatCount = withClv.filter((b) => Number(b.clv_pct) > 0).length;
  const beatCloseRate = withClv.length > 0 ? beatCount / withClv.length : 0;
  return {
    totalBets: bets.length,
    settled: settled.length,
    pending: bets.length - settled.length,
    wins,
    losses,
    voids,
    winRate: decided.length > 0 ? wins / decided.length : 0,
    totalStaked,
    totalProfit,
    unitsStaked,
    unitsProfit,
    roi,
    yieldPct: roi * 100,
    avgOdds,
    avgClvPct,
    clvSample: withClv.length,
    beatCloseRate,
  };
}

export function bankrollGrowthSeries(
  bets: BetLogRow[],
  startingBankroll: number,
): { date: string; bankroll: number; profit: number }[] {
  const settled = bets
    .filter((b) => b.status !== "pending")
    .slice()
    .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
  let running = startingBankroll;
  const points = [{ date: "Start", bankroll: running, profit: 0 }];
  for (const b of settled) {
    running += Number(b.profit);
    points.push({
      date: new Date(b.updated_at).toLocaleDateString(),
      bankroll: +running.toFixed(2),
      profit: Number(b.profit),
    });
  }
  return points;
}

/**
 * Rolling CLV time-series. Walks bets that have a captured `clv_pct` in
 * chronological order and emits, for each point, the running average CLV
 * (over the last `window` bets) and beat-close rate.
 */
export function clvSeries(
  bets: BetLogRow[],
  window = 10,
): { date: string; rollingClv: number; beatRate: number; clv: number }[] {
  const withClv = bets
    .filter((b) => b.clv_pct != null && Number.isFinite(Number(b.clv_pct)))
    .slice()
    .sort(
      (a, b) =>
        new Date(a.closing_odds_captured_at ?? a.updated_at).getTime() -
        new Date(b.closing_odds_captured_at ?? b.updated_at).getTime(),
    );
  const out: { date: string; rollingClv: number; beatRate: number; clv: number }[] = [];
  for (let i = 0; i < withClv.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = withClv.slice(start, i + 1);
    const avg = slice.reduce((s, b) => s + Number(b.clv_pct), 0) / slice.length;
    const beat = slice.filter((b) => Number(b.clv_pct) > 0).length / slice.length;
    const ts = withClv[i].closing_odds_captured_at ?? withClv[i].updated_at;
    out.push({
      date: new Date(ts).toLocaleDateString(),
      rollingClv: +avg.toFixed(2),
      beatRate: +(beat * 100).toFixed(0),
      clv: +Number(withClv[i].clv_pct).toFixed(2),
    });
  }
  return out;
}