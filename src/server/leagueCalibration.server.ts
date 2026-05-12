import { createClient } from "@supabase/supabase-js";
import { runBacktest, BACKTEST_LEAGUES, fetchFinishedFixturesInRange } from "./backtest.server";
import { eloUpdate, ELO_DEFAULT } from "@/lib/football/elo";

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface LeagueCalibration {
  league_id: number;
  league_name: string;
  temperature: number;
  home_advantage: number;
  dc_rho: number;
  xg_weight: number;
  elo_weight: number;
  brier_1x2: number | null;
  logloss_1x2: number | null;
  hitrate_1x2: number | null;
  matches_scored: number | null;
  updated_at: string;
}

/** Fetch calibration for a league. Returns null when none stored yet. */
export async function getLeagueCalibration(leagueId: number): Promise<LeagueCalibration | null> {
  const sb = admin();
  const { data } = await sb
    .from("league_calibration")
    .select("*")
    .eq("league_id", leagueId)
    .maybeSingle();
  return (data as LeagueCalibration) ?? null;
}

/** Bulk fetch ELO ratings for two teams (in a given league). Missing teams
 *  default to 1500. */
export async function getTeamEloPair(
  leagueId: number,
  homeId: number,
  awayId: number,
): Promise<{ home: number; away: number }> {
  const sb = admin();
  const { data } = await sb
    .from("team_elo")
    .select("team_id, rating")
    .eq("league_id", leagueId)
    .in("team_id", [homeId, awayId]);
  const map = new Map<number, number>();
  for (const r of (data as { team_id: number; rating: number }[]) ?? []) {
    map.set(r.team_id, Number(r.rating));
  }
  return {
    home: map.get(homeId) ?? ELO_DEFAULT,
    away: map.get(awayId) ?? ELO_DEFAULT,
  };
}

/**
 * Run grid-search calibration for a league over the given date range. Picks
 * the (T, HA, rho, xgW) combo with lowest Brier_1x2, persists to
 * `league_calibration`. Returns the chosen row.
 */
export async function calibrateLeague(opts: {
  leagueId: number;
  from: string;
  to: string;
  maxMatches?: number;
}): Promise<LeagueCalibration> {
  const meta = BACKTEST_LEAGUES.find((l) => l.id === opts.leagueId);
  if (!meta) throw new Error(`Unknown league ${opts.leagueId}`);

  // Small but meaningful grid (~12 combos × 1 backtest each is too costly).
  // Single backtest produces enough data; we re-grade analytically below by
  // re-running predictForBacktest? For MVP: 4 quick backtests with key sweep.
  const grid: { temperature: number; homeAdvantage: number; dcRho: number; xgWeight: number }[] = [
    { temperature: 1.20, homeAdvantage: 1.15, dcRho: 0.08, xgWeight: 0.7 },
    { temperature: 1.30, homeAdvantage: 1.20, dcRho: 0.08, xgWeight: 0.7 },
    { temperature: 1.40, homeAdvantage: 1.25, dcRho: 0.10, xgWeight: 0.6 },
    { temperature: 1.10, homeAdvantage: 1.10, dcRho: 0.06, xgWeight: 0.8 },
  ];

  let best: {
    cfg: typeof grid[number];
    brier: number;
    logloss: number;
    hitrate: number;
    matches: number;
  } | null = null;

  for (const cfg of grid) {
    const r = await runBacktest({
      leagueId: opts.leagueId,
      from: opts.from,
      to: opts.to,
      cfg,
      maxMatches: opts.maxMatches ?? 60,
    });
    if (r.brier_1x2 == null) continue;
    if (!best || r.brier_1x2 < best.brier) {
      best = {
        cfg,
        brier: r.brier_1x2,
        logloss: r.logloss_1x2 ?? 0,
        hitrate: r.hitrate_1x2 ?? 0,
        matches: r.matchesScored,
      };
    }
  }

  if (!best) throw new Error("Calibration failed — no scored matches");

  const sb = admin();
  const row = {
    league_id: opts.leagueId,
    league_name: meta.name,
    temperature: best.cfg.temperature,
    home_advantage: best.cfg.homeAdvantage,
    dc_rho: best.cfg.dcRho,
    xg_weight: best.cfg.xgWeight,
    elo_weight: 0.3,
    brier_1x2: best.brier,
    logloss_1x2: best.logloss,
    hitrate_1x2: best.hitrate,
    matches_scored: best.matches,
    date_from: opts.from,
    date_to: opts.to,
    updated_at: new Date().toISOString(),
  };
  await sb.from("league_calibration").upsert(row, { onConflict: "league_id" });
  return row as LeagueCalibration;
}

/**
 * Recompute ELO for every team in a league across the given date range from
 * cold-start (1500). Idempotent: replaces existing ratings.
 */
export async function recomputeLeagueElo(opts: {
  leagueId: number;
  from: string;
  to: string;
}): Promise<{ teams: number; matches: number }> {
  const fixtures = await fetchFinishedFixturesInRange(opts.leagueId, opts.from, opts.to);
  const ratings = new Map<number, { name: string; rating: number; played: number; lastAt: string }>();

  for (const fx of fixtures) {
    const ft = fx.score.fulltime ?? fx.goals;
    if (ft.home == null || ft.away == null) continue;
    const hId = fx.teams.home.id;
    const aId = fx.teams.away.id;
    const home = ratings.get(hId) ?? {
      name: fx.teams.home.name, rating: ELO_DEFAULT, played: 0, lastAt: fx.fixture.date,
    };
    const away = ratings.get(aId) ?? {
      name: fx.teams.away.name, rating: ELO_DEFAULT, played: 0, lastAt: fx.fixture.date,
    };
    const next = eloUpdate(home.rating, away.rating, ft.home, ft.away);
    ratings.set(hId, { ...home, rating: next.home, played: home.played + 1, lastAt: fx.fixture.date });
    ratings.set(aId, { ...away, rating: next.away, played: away.played + 1, lastAt: fx.fixture.date });
  }

  const rows = Array.from(ratings.entries()).map(([team_id, v]) => ({
    team_id,
    league_id: opts.leagueId,
    team_name: v.name,
    rating: +v.rating.toFixed(2),
    matches_played: v.played,
    last_match_at: v.lastAt,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return { teams: 0, matches: 0 };

  const sb = admin();
  // Upsert in chunks to avoid payload limits.
  for (let i = 0; i < rows.length; i += 100) {
    await sb.from("team_elo").upsert(rows.slice(i, i + 100), { onConflict: "team_id,league_id" });
  }
  return { teams: rows.length, matches: fixtures.length };
}
