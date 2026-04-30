import type { MatchSummary, TeamForm } from "@/lib/football/types";
import { predictForBacktest, type BacktestModelConfig } from "@/lib/football/predictor";

const BASE = "https://v3.football.api-sports.io";

function getKey(): string {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("FOOTBALL_DATA_API_KEY is not configured");
  return key;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": getKey() },
  });
  if (!res.ok) {
    throw new Error(`API-SPORTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as T & { errors?: unknown };
  const errs = json.errors;
  if (errs && ((Array.isArray(errs) && errs.length > 0) || Object.keys(errs as object).length > 0)) {
    throw new Error(`API-SPORTS error: ${JSON.stringify(errs).slice(0, 200)}`);
  }
  return json;
}

interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { id: number; name: string; season: number; country?: string };
  teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  goals: { home: number | null; away: number | null };
  score: { fulltime?: { home: number | null; away: number | null } };
}

/** Finished fixtures in [from, to] for a league. Auto-detects season from `from`. */
export async function fetchFinishedFixturesInRange(
  leagueId: number,
  from: string,
  to: string,
): Promise<ApiFixture[]> {
  const season = parseInt(from.slice(0, 4), 10);
  // For seasons that span calendar years (Aug→May), API-Sports indexes by the
  // starting year. If `from` is in Jan-Jun, the season is likely the previous
  // year for European leagues.
  const month = parseInt(from.slice(5, 7), 10);
  const seasonGuess = month >= 7 ? season : season - 1;
  const all: ApiFixture[] = [];
  for (const s of [seasonGuess, season]) {
    try {
      const data = await apiFetch<{ response: ApiFixture[] }>(
        `/fixtures?league=${leagueId}&season=${s}&from=${from}&to=${to}&status=FT`,
      );
      for (const f of data.response ?? []) {
        if (!all.some((x) => x.fixture.id === f.fixture.id)) all.push(f);
      }
    } catch (e) {
      console.warn(`[backtest] fixtures season=${s} failed:`, e);
    }
    if (seasonGuess === season) break;
  }
  return all.sort((a, b) => a.fixture.date.localeCompare(b.fixture.date));
}

/**
 * Compute a team's form using ONLY matches strictly before `asOfDate`.
 * Mirrors the production form calc (90-day half-life, weighted attack/defense)
 * but does NOT use xG (Pro tier; expensive on backtests). xG is gracefully
 * absent and the predictor falls back to weighted goal averages.
 */
export async function fetchAsOfForm(
  teamId: number,
  asOfDate: string,
  last = 8,
): Promise<TeamForm | null> {
  // API-Sports `to=` is inclusive; subtract one day so we never leak the
  // current match into its own form.
  const to = new Date(asOfDate);
  to.setUTCDate(to.getUTCDate() - 1);
  const toStr = to.toISOString().slice(0, 10);
  try {
    const data = await apiFetch<{ response: ApiFixture[] }>(
      `/fixtures?team=${teamId}&to=${toStr}&last=${last}&status=FT`,
    );
    const matches = data.response ?? [];
    if (matches.length === 0) return null;
    let played = 0, wins = 0, draws = 0, losses = 0, gf = 0, ga = 0;
    const last5: ("W" | "D" | "L")[] = [];
    const HALF_LIFE_DAYS = 90;
    const decay = Math.LN2 / HALF_LIFE_DAYS;
    const refMs = new Date(asOfDate).getTime();
    let wA = 0, wD = 0, wS = 0;
    for (const m of matches) {
      const isHome = m.teams.home.id === teamId;
      const ft = m.score.fulltime ?? m.goals;
      if (ft.home == null || ft.away == null) continue;
      played++;
      const f = isHome ? ft.home : ft.away;
      const a = isHome ? ft.away : ft.home;
      gf += f; ga += a;
      let r: "W" | "D" | "L";
      if (f > a) { wins++; r = "W"; }
      else if (f < a) { losses++; r = "L"; }
      else { draws++; r = "D"; }
      last5.push(r);
      const ageDays = Math.max(0, (refMs - new Date(m.fixture.date).getTime()) / 86_400_000);
      const w = Math.exp(-decay * ageDays);
      wA += f * w; wD += a * w; wS += w;
    }
    if (played === 0) return null;
    return {
      played, wins, draws, losses,
      goalsFor: gf, goalsAgainst: ga,
      last5: last5.slice(-5),
      weightedAttackPerGame: wS > 0 ? +(wA / wS).toFixed(3) : undefined,
      weightedDefensePerGame: wS > 0 ? +(wD / wS).toFixed(3) : undefined,
      effectiveSample: wS > 0 ? +wS.toFixed(2) : undefined,
    };
  } catch (e) {
    console.warn(`[backtest] form team=${teamId} as-of=${toStr} failed:`, e);
    return null;
  }
}

export interface BacktestPrediction {
  matchId: number;
  date: string;
  home: string;
  away: string;
  actual: { h: number; a: number; result: "1" | "X" | "2"; total: number; btts: boolean };
  pred: { pH: number; pD: number; pA: number; pBtts: number; pOver25: number; lH: number; lA: number };
  scored: boolean;
}

export interface BacktestSummary {
  matchesTotal: number;
  matchesScored: number;
  brier_1x2: number | null;
  logloss_1x2: number | null;
  hitrate_1x2: number | null;
  brier_btts: number | null;
  brier_ou25: number | null;
  // ROI: flat 1u stake on the model's top 1X2 pick at fair odds (no overround
  // assumed since we don't have historical closing odds in this MVP).
  // Reported as percent of total stake.
  roi_flat: number | null;
  bets_placed: number | null;
  predictions: BacktestPrediction[];
}

/**
 * Run a backtest over a competition + date range.
 * Concurrency is intentionally low (4 in-flight) to stay under the API-Sports
 * 30 req/min free-tier limit. A 50-match window costs ~100 req (2 form lookups
 * per match) and finishes in ~30-60s.
 */
export async function runBacktest(opts: {
  leagueId: number;
  from: string;
  to: string;
  cfg: BacktestModelConfig;
  maxMatches?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<BacktestSummary> {
  const max = Math.max(1, Math.min(200, opts.maxMatches ?? 50));
  const fixtures = (await fetchFinishedFixturesInRange(opts.leagueId, opts.from, opts.to))
    .filter((f) => f.score.fulltime?.home != null && f.score.fulltime?.away != null)
    .slice(0, max);

  const out: BacktestPrediction[] = [];
  const CONCURRENCY = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < fixtures.length) {
      const idx = cursor++;
      const fx = fixtures[idx];
      const date = fx.fixture.date.slice(0, 10);
      const ft = fx.score.fulltime!;
      const h = ft.home!, a = ft.away!;
      const result: "1" | "X" | "2" = h > a ? "1" : h < a ? "2" : "X";
      try {
        const [hf, af] = await Promise.all([
          fetchAsOfForm(fx.teams.home.id, date),
          fetchAsOfForm(fx.teams.away.id, date),
        ]);
        const scored = !!hf && !!af && hf.played >= 3 && af.played >= 3;
        const pred = predictForBacktest(hf, af, opts.cfg);
        out.push({
          matchId: fx.fixture.id,
          date,
          home: fx.teams.home.name,
          away: fx.teams.away.name,
          actual: { h, a, result, total: h + a, btts: h >= 1 && a >= 1 },
          pred: {
            pH: +pred.pHome.toFixed(4),
            pD: +pred.pDraw.toFixed(4),
            pA: +pred.pAway.toFixed(4),
            pBtts: +pred.pBttsYes.toFixed(4),
            pOver25: +pred.pOver25.toFixed(4),
            lH: +pred.lambdaHome.toFixed(2),
            lA: +pred.lambdaAway.toFixed(2),
          },
          scored,
        });
      } catch (e) {
        console.warn("[backtest] fixture failed", fx.fixture.id, e);
      }
      opts.onProgress?.(out.length, fixtures.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const scored = out.filter((p) => p.scored);
  let brier1x2 = 0, logloss1x2 = 0, hits = 0;
  let brierBtts = 0, brierOu = 0;
  let roiPnl = 0, bets = 0;
  for (const p of scored) {
    const actH = p.actual.result === "1" ? 1 : 0;
    const actD = p.actual.result === "X" ? 1 : 0;
    const actA = p.actual.result === "2" ? 1 : 0;
    brier1x2 += (p.pred.pH - actH) ** 2 + (p.pred.pD - actD) ** 2 + (p.pred.pA - actA) ** 2;
    const pickProb =
      actH ? p.pred.pH : actD ? p.pred.pD : p.pred.pA;
    logloss1x2 += -Math.log(Math.max(1e-9, pickProb));
    const top = Math.max(p.pred.pH, p.pred.pD, p.pred.pA);
    const topPick: "1" | "X" | "2" =
      top === p.pred.pH ? "1" : top === p.pred.pA ? "2" : "X";
    if (topPick === p.actual.result) hits++;
    // ROI at fair odds: stake 1u on top pick at price = 1 / topProb.
    // Win -> +(price-1), lose -> -1.
    const fairPrice = 1 / Math.max(1e-9, top);
    if (topPick === p.actual.result) roiPnl += fairPrice - 1;
    else roiPnl -= 1;
    bets++;
    const actBtts = p.actual.btts ? 1 : 0;
    brierBtts += (p.pred.pBtts - actBtts) ** 2;
    const actOver = p.actual.total >= 3 ? 1 : 0;
    brierOu += (p.pred.pOver25 - actOver) ** 2;
  }
  const n = scored.length;
  return {
    matchesTotal: out.length,
    matchesScored: n,
    brier_1x2: n ? +(brier1x2 / n).toFixed(4) : null,
    logloss_1x2: n ? +(logloss1x2 / n).toFixed(4) : null,
    hitrate_1x2: n ? +(hits / n).toFixed(4) : null,
    brier_btts: n ? +(brierBtts / n).toFixed(4) : null,
    brier_ou25: n ? +(brierOu / n).toFixed(4) : null,
    roi_flat: bets ? +(roiPnl / bets).toFixed(4) : null,
    bets_placed: bets,
    predictions: out,
  };
}

/** Curated list of leagues users can backtest. Keeps the UI simple and
 *  avoids an extra API call to list every competition. IDs are API-Sports v3
 *  `league.id` values. */
export const BACKTEST_LEAGUES: { id: number; name: string; country: string }[] = [
  { id: 39, name: "Premier League", country: "England" },
  { id: 140, name: "La Liga", country: "Spain" },
  { id: 78, name: "Bundesliga", country: "Germany" },
  { id: 135, name: "Serie A", country: "Italy" },
  { id: 61, name: "Ligue 1", country: "France" },
  { id: 88, name: "Eredivisie", country: "Netherlands" },
  { id: 94, name: "Primeira Liga", country: "Portugal" },
  { id: 119, name: "Superliga", country: "Denmark" },
  { id: 103, name: "Eliteserien", country: "Norway" },
  { id: 113, name: "Allsvenskan", country: "Sweden" },
  { id: 2, name: "Champions League", country: "Europe" },
  { id: 3, name: "Europa League", country: "Europe" },
];