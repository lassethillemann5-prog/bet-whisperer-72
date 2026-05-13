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

/**
 * Incrementally update ELO ratings for a single finished match. Called from
 * autoSettle so ratings stay fresh without needing manual recompute.
 * Idempotent enough: uses upsert; calling twice with same result will drift
 * slightly, so callers should only invoke once per match (autoSettle only
 * grades a bet once).
 */
export async function updateEloAfterMatch(opts: {
  leagueId: number;
  homeId: number;
  awayId: number;
  homeName?: string | null;
  awayName?: string | null;
  goalsHome: number;
  goalsAway: number;
  matchDate: string;
}): Promise<void> {
  const sb = admin();
  const { data } = await sb
    .from("team_elo")
    .select("team_id, rating, matches_played, team_name")
    .eq("league_id", opts.leagueId)
    .in("team_id", [opts.homeId, opts.awayId]);
  const map = new Map<number, { rating: number; played: number; name: string | null }>();
  for (const r of (data as { team_id: number; rating: number; matches_played: number; team_name: string | null }[]) ?? []) {
    map.set(r.team_id, { rating: Number(r.rating), played: r.matches_played, name: r.team_name });
  }
  const home = map.get(opts.homeId) ?? { rating: ELO_DEFAULT, played: 0, name: opts.homeName ?? null };
  const away = map.get(opts.awayId) ?? { rating: ELO_DEFAULT, played: 0, name: opts.awayName ?? null };
  // Idempotency guard: if either team's last_match_at is already >= this
  // match's date, we've likely processed this fixture before (or a later
  // one). Skip to prevent double-counting when autoSettle runs across users.
  const sbCheck = sb;
  const { data: lastRows } = await sbCheck
    .from("team_elo")
    .select("team_id, last_match_at")
    .eq("league_id", opts.leagueId)
    .in("team_id", [opts.homeId, opts.awayId]);
  const matchTs = new Date(opts.matchDate).getTime();
  for (const r of (lastRows as { team_id: number; last_match_at: string | null }[]) ?? []) {
    if (r.last_match_at && new Date(r.last_match_at).getTime() >= matchTs) {
      return; // already processed this (or a newer) fixture
    }
  }
  const next = eloUpdate(home.rating, away.rating, opts.goalsHome, opts.goalsAway);
  const now = new Date().toISOString();
  await sb.from("team_elo").upsert(
    [
      {
        team_id: opts.homeId,
        league_id: opts.leagueId,
        team_name: opts.homeName ?? home.name,
        rating: +next.home.toFixed(2),
        matches_played: home.played + 1,
        last_match_at: opts.matchDate,
        updated_at: now,
      },
      {
        team_id: opts.awayId,
        league_id: opts.leagueId,
        team_name: opts.awayName ?? away.name,
        rating: +next.away.toFixed(2),
        matches_played: away.played + 1,
        last_match_at: opts.matchDate,
        updated_at: now,
      },
    ],
    { onConflict: "team_id,league_id" },
  );
}

/** Returns true if the league has any ELO rows stored. */
export async function leagueHasElo(leagueId: number): Promise<boolean> {
  const sb = admin();
  const { count } = await sb
    .from("team_elo")
    .select("team_id", { count: "exact", head: true })
    .eq("league_id", leagueId);
  return (count ?? 0) > 0;
}

// In-process dedupe so concurrent predictions don't all kick off backfills.
const inFlightBackfills = new Set<number>();

/**
 * Fire-and-forget: if the league has no ELO data yet AND it's a known
 * BACKTEST_LEAGUES entry, recompute ELO from the last 365 days. Safe to call
 * on every prediction — guarded by an in-process Set + a DB existence check.
 */
export function ensureLeagueEloBackfilled(leagueId: number): void {
  if (inFlightBackfills.has(leagueId)) return;
  if (!BACKTEST_LEAGUES.find((l) => l.id === leagueId)) return;
  inFlightBackfills.add(leagueId);
  (async () => {
    try {
      if (await leagueHasElo(leagueId)) return;
      const to = new Date();
      const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      console.log(`[elo] auto-backfilling league ${leagueId} (${fmt(from)}..${fmt(to)})`);
      const r = await recomputeLeagueElo({ leagueId, from: fmt(from), to: fmt(to) });
      console.log(`[elo] backfill done: ${r.teams} teams, ${r.matches} matches`);
    } catch (e) {
      console.warn(`[elo] backfill failed for league ${leagueId}`, e);
    } finally {
      inFlightBackfills.delete(leagueId);
    }
  })();
}
