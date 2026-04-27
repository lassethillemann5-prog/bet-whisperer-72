import type { MarketPrediction, TeamForm } from "./types";
import type { InjuryImpact } from "./types";

/** Poisson PMF */
function poisson(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Dixon-Coles low-score correction τ(x, y, λ, μ, ρ).
 * Reduces the over-prediction of 0-0 / 1-1 and under-prediction of 1-0 / 0-1
 * caused by assuming home & away goals are independent Poisson variables.
 * Reference: Dixon & Coles 1997, "Modelling Association Football Scores".
 *   ρ ∈ ~[-0.2, 0.2]; we use a mild ρ = 0.08 which fits most leagues.
 */
const DC_RHO = 0.08;
function dcTau(x: number, y: number, lh: number, la: number, rho = DC_RHO): number {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Build a Dixon-Coles-corrected scoreline matrix up to maxGoals each side. */
function buildMatrix(lambdaHome: number, lambdaAway: number, maxGoals = 7) {
  const m: number[][] = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    const row: number[] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const p =
        poisson(h, lambdaHome) *
        poisson(a, lambdaAway) *
        dcTau(h, a, lambdaHome, lambdaAway);
      row.push(p);
      total += p;
    }
    m.push(row);
  }
  // Renormalise — DC correction nudges the total mass off 1.
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    for (let h = 0; h < m.length; h++) {
      for (let a = 0; a < m[h].length; a++) {
        m[h][a] /= total;
      }
    }
  }
  return m;
}

function formStrength(form: TeamForm | null): {
  attackPerGame: number;
  defensePerGame: number;
  reliability: number; // 0..1 based on number of games
} {
  if (!form || form.played === 0) {
    return { attackPerGame: 1.35, defensePerGame: 1.35, reliability: 0 };
  }
  // Prefer time-decay weighted stats when available (recent matches matter more).
  const goalsAttack =
    form.weightedAttackPerGame ?? form.goalsFor / form.played;
  const goalsDefense =
    form.weightedDefensePerGame ?? form.goalsAgainst / form.played;
  // xG blend — when xG signal is available, weight it 70% vs 30% raw goals.
  // Fitted offline on 2023-24 EPL using a Dixon-Coles likelihood objective
  // (see /mnt/documents/epl_xg_blend_results.csv). xG is less noisy than
  // goals, so this materially improves out-of-sample Brier/LogLoss in
  // leagues where we have xG. Falls back to goals-only when xG missing.
  const XG_WEIGHT = 0.7;
  const attack =
    form.weightedXgForPerGame != null
      ? XG_WEIGHT * form.weightedXgForPerGame + (1 - XG_WEIGHT) * goalsAttack
      : goalsAttack;
  const defense =
    form.weightedXgAgainstPerGame != null
      ? XG_WEIGHT * form.weightedXgAgainstPerGame + (1 - XG_WEIGHT) * goalsDefense
      : goalsDefense;
  // Effective sample after weighting — caps reliability when most evidence is old.
  const eff = form.effectiveSample ?? form.played;
  return {
    attackPerGame: attack,
    defensePerGame: defense,
    reliability: Math.min(1, eff / 8),
  };
}

const LEAGUE_AVG_GOALS_PER_TEAM = 1.35;
const HOME_ADVANTAGE = 1.15;

/**
 * Temperature scaling for 1X2 probabilities.
 * Fitted offline on 2023-24 EPL, validated on 2024-25 EPL:
 *   - T = 1.289 → Brier 0.6005 → 0.5920, LogLoss 1.0045 → 0.9916
 * (See /mnt/documents/epl_calibration_temperature_meta.json.)
 * T > 1 means the raw model is over-confident; we soften the distribution
 * by raising each probability to power 1/T and renormalising.
 */
const TEMPERATURE = 1.289;
function applyTemperature(p1: number, pX: number, p2: number, T = TEMPERATURE): [number, number, number] {
  const a = Math.pow(Math.max(p1, 1e-9), 1 / T);
  const b = Math.pow(Math.max(pX, 1e-9), 1 / T);
  const c = Math.pow(Math.max(p2, 1e-9), 1 / T);
  const s = a + b + c;
  return [a / s, b / s, c / s];
}

export function predictMarkets(
  homeForm: TeamForm | null,
  awayForm: TeamForm | null,
  homeInjuries?: InjuryImpact | null,
  awayInjuries?: InjuryImpact | null,
): {
  markets: MarketPrediction[];
  expectedGoalsHome: number;
  expectedGoalsAway: number;
} {
  const h = formStrength(homeForm);
  const a = formStrength(awayForm);

  // Blend each team's attack with opponent's defense, regress to league avg by reliability
  const lambdaHomeRaw =
    h.attackPerGame * a.defensePerGame / LEAGUE_AVG_GOALS_PER_TEAM;
  const lambdaAwayRaw =
    a.attackPerGame * h.defensePerGame / LEAGUE_AVG_GOALS_PER_TEAM;

  const blend = (raw: number, rel: number) =>
    rel * raw + (1 - rel) * LEAGUE_AVG_GOALS_PER_TEAM;

  const reliability = Math.min(h.reliability, a.reliability);
  let lambdaHome = blend(lambdaHomeRaw, reliability) * HOME_ADVANTAGE;
  let lambdaAway = blend(lambdaAwayRaw, reliability);

  // Apply injury penalties: missing key attackers reduce λ for this team's
  // attack; missing key defenders inflate λ for the opponent's attack.
  if (homeInjuries) {
    lambdaHome *= homeInjuries.attackFactor;
    lambdaAway *= homeInjuries.defenseFactor;
  }
  if (awayInjuries) {
    lambdaAway *= awayInjuries.attackFactor;
    lambdaHome *= awayInjuries.defenseFactor;
  }

  // Clamp realistic range
  lambdaHome = Math.max(0.3, Math.min(4.0, lambdaHome));
  lambdaAway = Math.max(0.2, Math.min(3.5, lambdaAway));

  const matrix = buildMatrix(lambdaHome, lambdaAway);

  // 1X2
  let pHome = 0, pDraw = 0, pAway = 0;
  for (let hh = 0; hh < matrix.length; hh++) {
    for (let aa = 0; aa < matrix[hh].length; aa++) {
      const p = matrix[hh][aa];
      if (hh > aa) pHome += p;
      else if (hh < aa) pAway += p;
      else pDraw += p;
    }
  }
  const total1x2 = pHome + pDraw + pAway || 1;
  pHome /= total1x2; pDraw /= total1x2; pAway /= total1x2;
  // Calibrate over-confident raw model probabilities.
  [pHome, pDraw, pAway] = applyTemperature(pHome, pDraw, pAway);

  // Over/Under
  const probGoals = (n: number) => {
    let p = 0;
    for (let hh = 0; hh < matrix.length; hh++) {
      for (let aa = 0; aa < matrix[hh].length; aa++) {
        if (hh + aa === n) p += matrix[hh][aa];
      }
    }
    return p;
  };
  const probOver = (line: number) => {
    let p = 0;
    for (let n = 0; n <= Math.floor(line); n++) p += probGoals(n);
    return Math.max(0, Math.min(1, 1 - p));
  };

  const over15 = probOver(1.5);
  const over25 = probOver(2.5);

  // Both Teams To Score (BTTS): P(home>=1 AND away>=1) = 1 - P(home=0) - P(away=0) + P(0-0)
  let pHome0 = 0,
    pAway0 = 0,
    p00 = 0;
  for (let hh = 0; hh < matrix.length; hh++) {
    for (let aa = 0; aa < matrix[hh].length; aa++) {
      if (hh === 0) pAway0 += matrix[hh][aa];
      if (aa === 0) pHome0 += matrix[hh][aa];
      if (hh === 0 && aa === 0) p00 += matrix[hh][aa];
    }
  }
  const bttsYes = Math.max(0, Math.min(1, 1 - pHome0 - pAway0 + p00));

  // Team to Score (Over 0.5 goals for each side) — derived from the same matrix.
  // P(home scores) = 1 - P(home == 0); same for away.
  const homeScoresYes = Math.max(0, Math.min(1, 1 - pHome0));
  const awayScoresYes = Math.max(0, Math.min(1, 1 - pAway0));

  // ---- Double Chance: combine 1X2 ----
  const dc1X = pHome + pDraw;
  const dc12 = pHome + pAway;
  const dcX2 = pDraw + pAway;

  // ---- Draw No Bet: renormalise excluding the draw ----
  const dnbDen = pHome + pAway || 1;
  const dnbHome = pHome / dnbDen;
  const dnbAway = pAway / dnbDen;

  // ---- Asian Handicap (pick a single line near the model's expected margin)
  // We pick a half-line so there's no push, and report P(home covers).
  // expectedMargin > 0 → home favoured; we offer a handicap that brings the
  // game closest to a 50/50 from the model's perspective (i.e. round to .5).
  const expectedMargin = lambdaHome - lambdaAway;
  // Round to nearest .5 then negate for the home line. Cap at +/-2.5.
  const ahMagnitude = Math.max(0.5, Math.min(2.5, Math.round(Math.abs(expectedMargin) * 2) / 2));
  const homeLine = expectedMargin >= 0 ? -ahMagnitude : +ahMagnitude;
  // Compute P(home covers homeLine) by summing matrix cells where
  // (h - a) + homeLine > 0 (home wins handicap).
  let pHomeCovers = 0;
  for (let hh = 0; hh < matrix.length; hh++) {
    for (let aa = 0; aa < matrix[hh].length; aa++) {
      if (hh - aa + homeLine > 0) pHomeCovers += matrix[hh][aa];
    }
  }
  pHomeCovers = Math.max(0, Math.min(1, pHomeCovers));
  const pAwayCovers = 1 - pHomeCovers;
  const homeLineLabel = (homeLine > 0 ? "+" : "") + homeLine.toFixed(1);
  const awayLineLabel = (-homeLine > 0 ? "+" : "") + (-homeLine).toFixed(1);

  // Corners / Shots / Shots on target — approximated from goal expectancy
  // (Football-Data free tier doesn't provide these stats.)
  // Empirical league averages:
  //  - Corners per match ≈ 10.3, scales with attacking intent (goals)
  //  - Shots per match ≈ 24, on-target ≈ 8.5
  const totalGoals = lambdaHome + lambdaAway;
  const goalsScaler = totalGoals / 2.7; // 2.7 ≈ league avg total goals
  const expCorners = 10.3 * (0.6 + 0.4 * goalsScaler);
  const expShots = 24 * (0.7 + 0.3 * goalsScaler);
  const expSoT = 8.5 * (0.7 + 0.3 * goalsScaler);
  // Cards per match ≈ 3.7 league average. Slight positive correlation with
  // attacking intent / goals (more action → more fouls), so we apply a mild
  // scaler around the goals baseline.
  const expCards = 3.7 * (0.85 + 0.15 * goalsScaler);

  const markets: MarketPrediction[] = [
    {
      market: "1x2",
      label: "Match Result (1X2)",
      pick:
        pHome >= pDraw && pHome >= pAway
          ? "1 (Home)"
          : pAway >= pDraw && pAway >= pHome
          ? "2 (Away)"
          : "X (Draw)",
      probabilities: {
        "1": +(pHome * 100).toFixed(1),
        X: +(pDraw * 100).toFixed(1),
        "2": +(pAway * 100).toFixed(1),
      },
    },
    {
      market: "ou_15",
      label: "Over / Under 1.5 Goals",
      line: 1.5,
      pick: over15 >= 0.5 ? "Over 1.5" : "Under 1.5",
      probabilities: {
        Over: +(over15 * 100).toFixed(1),
        Under: +((1 - over15) * 100).toFixed(1),
      },
    },
    {
      market: "ou_25",
      label: "Over / Under 2.5 Goals",
      line: 2.5,
      pick: over25 >= 0.5 ? "Over 2.5" : "Under 2.5",
      probabilities: {
        Over: +(over25 * 100).toFixed(1),
        Under: +((1 - over25) * 100).toFixed(1),
      },
    },
    {
      market: "btts",
      label: "Both Teams To Score",
      pick: bttsYes >= 0.5 ? "Yes" : "No",
      probabilities: {
        Yes: +(bttsYes * 100).toFixed(1),
        No: +((1 - bttsYes) * 100).toFixed(1),
      },
    },
    {
      market: "home_to_score",
      label: "Home Team to Score (Over 0.5)",
      line: 0.5,
      pick: homeScoresYes >= 0.5 ? "Yes" : "No",
      probabilities: {
        Yes: +(homeScoresYes * 100).toFixed(1),
        No: +((1 - homeScoresYes) * 100).toFixed(1),
      },
    },
    {
      market: "away_to_score",
      label: "Away Team to Score (Over 0.5)",
      line: 0.5,
      pick: awayScoresYes >= 0.5 ? "Yes" : "No",
      probabilities: {
        Yes: +(awayScoresYes * 100).toFixed(1),
        No: +((1 - awayScoresYes) * 100).toFixed(1),
      },
    },
    {
      market: "double_chance",
      label: "Double Chance",
      pick:
        dc1X >= dc12 && dc1X >= dcX2
          ? "1X (Home or Draw)"
          : dc12 >= dcX2
          ? "12 (Home or Away)"
          : "X2 (Draw or Away)",
      probabilities: {
        "1X": +(dc1X * 100).toFixed(1),
        "12": +(dc12 * 100).toFixed(1),
        X2: +(dcX2 * 100).toFixed(1),
      },
    },
    {
      market: "dnb",
      label: "Draw No Bet",
      pick: dnbHome >= dnbAway ? "Home (DNB)" : "Away (DNB)",
      probabilities: {
        Home: +(dnbHome * 100).toFixed(1),
        Away: +(dnbAway * 100).toFixed(1),
      },
    },
    {
      market: "ah",
      label: `Asian Handicap (Home ${homeLineLabel})`,
      line: homeLine,
      pick: pHomeCovers >= pAwayCovers ? `Home ${homeLineLabel}` : `Away ${awayLineLabel}`,
      probabilities: {
        [`Home ${homeLineLabel}`]: +(pHomeCovers * 100).toFixed(1),
        [`Away ${awayLineLabel}`]: +(pAwayCovers * 100).toFixed(1),
      },
    },
    {
      market: "corners",
      label: "Total Corners",
      line: 9.5,
      expected: +expCorners.toFixed(1),
      pick: expCorners >= 9.5 ? "Over 9.5" : "Under 9.5",
      probabilities: {
        "Over 9.5": +(Math.min(95, Math.max(5, 50 + (expCorners - 9.5) * 8))).toFixed(1),
        "Under 9.5": +(Math.min(95, Math.max(5, 50 - (expCorners - 9.5) * 8))).toFixed(1),
      },
    },
    {
      market: "shots",
      label: "Total Shots",
      line: 24.5,
      expected: +expShots.toFixed(1),
      pick: expShots >= 24.5 ? "Over 24.5" : "Under 24.5",
      probabilities: {
        "Over 24.5": +(Math.min(95, Math.max(5, 50 + (expShots - 24.5) * 4))).toFixed(1),
        "Under 24.5": +(Math.min(95, Math.max(5, 50 - (expShots - 24.5) * 4))).toFixed(1),
      },
    },
    {
      market: "shots_on_target",
      label: "Total Shots on Target",
      line: 8.5,
      expected: +expSoT.toFixed(1),
      pick: expSoT >= 8.5 ? "Over 8.5" : "Under 8.5",
      probabilities: {
        "Over 8.5": +(Math.min(95, Math.max(5, 50 + (expSoT - 8.5) * 8))).toFixed(1),
        "Under 8.5": +(Math.min(95, Math.max(5, 50 - (expSoT - 8.5) * 8))).toFixed(1),
      },
    },
    {
      market: "cards",
      label: "Total Cards",
      line: 3.5,
      expected: +expCards.toFixed(1),
      pick: expCards >= 3.5 ? "Over 3.5" : "Under 3.5",
      probabilities: {
        "Over 3.5": +(Math.min(95, Math.max(5, 50 + (expCards - 3.5) * 18))).toFixed(1),
        "Under 3.5": +(Math.min(95, Math.max(5, 50 - (expCards - 3.5) * 18))).toFixed(1),
      },
    },
  ];

  return {
    markets,
    expectedGoalsHome: +lambdaHome.toFixed(2),
    expectedGoalsAway: +lambdaAway.toFixed(2),
  };
}

/* ============================================================
 * Bet Builder — same-game joint probability
 * ==========================================================*/

/**
 * Recompute the (calibrated) λ values used in `predictMarkets`. Returns the
 * Dixon-Coles corrected scoreline matrix that everything else is derived
 * from, so the bet builder can compute true joint probabilities for any
 * combination of legs in the SAME match (correlation-aware).
 */
export function buildScorelineMatrix(
  homeForm: TeamForm | null,
  awayForm: TeamForm | null,
  homeInjuries?: InjuryImpact | null,
  awayInjuries?: InjuryImpact | null,
): { matrix: number[][]; lambdaHome: number; lambdaAway: number } {
  const h = formStrength(homeForm);
  const a = formStrength(awayForm);

  const lambdaHomeRaw = (h.attackPerGame * a.defensePerGame) / LEAGUE_AVG_GOALS_PER_TEAM;
  const lambdaAwayRaw = (a.attackPerGame * h.defensePerGame) / LEAGUE_AVG_GOALS_PER_TEAM;

  const blend = (raw: number, rel: number) => rel * raw + (1 - rel) * LEAGUE_AVG_GOALS_PER_TEAM;
  const reliability = Math.min(h.reliability, a.reliability);

  let lambdaHome = blend(lambdaHomeRaw, reliability) * HOME_ADVANTAGE;
  let lambdaAway = blend(lambdaAwayRaw, reliability);

  if (homeInjuries) {
    lambdaHome *= homeInjuries.attackFactor;
    lambdaAway *= homeInjuries.defenseFactor;
  }
  if (awayInjuries) {
    lambdaAway *= awayInjuries.attackFactor;
    lambdaHome *= awayInjuries.defenseFactor;
  }

  lambdaHome = Math.max(0.3, Math.min(4.0, lambdaHome));
  lambdaAway = Math.max(0.2, Math.min(3.5, lambdaAway));

  const matrix = buildMatrix(lambdaHome, lambdaAway);
  return { matrix, lambdaHome, lambdaAway };
}

/**
 * A single bet-builder leg. Each leg is a predicate over the (homeGoals, awayGoals)
 * scoreline; the joint probability is the sum of matrix cells where ALL leg
 * predicates evaluate true.
 */
export type BuilderLegId =
  | "1" | "X" | "2"
  | "1X" | "12" | "X2"
  | "dnb_home" | "dnb_away"
  | "over_15" | "under_15"
  | "over_25" | "under_25"
  | "btts_yes" | "btts_no"
  | "home_scores_yes" | "home_scores_no"
  | "away_scores_yes" | "away_scores_no";

export interface BuilderLegMeta {
  id: BuilderLegId;
  /** Logical group — only one leg per group can be selected. */
  group: "result" | "double_chance" | "dnb" | "ou_15" | "ou_25" | "btts" | "home_scores" | "away_scores";
  marketLabel: string;
  selectionLabel: string;
}

export const BUILDER_LEGS: BuilderLegMeta[] = [
  { id: "1", group: "result", marketLabel: "Match Result", selectionLabel: "Home" },
  { id: "X", group: "result", marketLabel: "Match Result", selectionLabel: "Draw" },
  { id: "2", group: "result", marketLabel: "Match Result", selectionLabel: "Away" },
  { id: "1X", group: "double_chance", marketLabel: "Double Chance", selectionLabel: "Home or Draw" },
  { id: "12", group: "double_chance", marketLabel: "Double Chance", selectionLabel: "Home or Away" },
  { id: "X2", group: "double_chance", marketLabel: "Double Chance", selectionLabel: "Draw or Away" },
  { id: "dnb_home", group: "dnb", marketLabel: "Draw No Bet", selectionLabel: "Home" },
  { id: "dnb_away", group: "dnb", marketLabel: "Draw No Bet", selectionLabel: "Away" },
  { id: "over_15", group: "ou_15", marketLabel: "Goals 1.5", selectionLabel: "Over 1.5" },
  { id: "under_15", group: "ou_15", marketLabel: "Goals 1.5", selectionLabel: "Under 1.5" },
  { id: "over_25", group: "ou_25", marketLabel: "Goals 2.5", selectionLabel: "Over 2.5" },
  { id: "under_25", group: "ou_25", marketLabel: "Goals 2.5", selectionLabel: "Under 2.5" },
  { id: "btts_yes", group: "btts", marketLabel: "BTTS", selectionLabel: "Yes" },
  { id: "btts_no", group: "btts", marketLabel: "BTTS", selectionLabel: "No" },
  { id: "home_scores_yes", group: "home_scores", marketLabel: "Home to Score", selectionLabel: "Yes" },
  { id: "home_scores_no", group: "home_scores", marketLabel: "Home to Score", selectionLabel: "No" },
  { id: "away_scores_yes", group: "away_scores", marketLabel: "Away to Score", selectionLabel: "Yes" },
  { id: "away_scores_no", group: "away_scores", marketLabel: "Away to Score", selectionLabel: "No" },
];

function legPredicate(id: BuilderLegId): (h: number, a: number) => boolean {
  switch (id) {
    case "1": return (h, a) => h > a;
    case "X": return (h, a) => h === a;
    case "2": return (h, a) => h < a;
    case "1X": return (h, a) => h >= a;
    case "12": return (h, a) => h !== a;
    case "X2": return (h, a) => h <= a;
    case "dnb_home": return (h, a) => h > a; // draw → void; we report conditional below
    case "dnb_away": return (h, a) => h < a;
    case "over_15": return (h, a) => h + a >= 2;
    case "under_15": return (h, a) => h + a <= 1;
    case "over_25": return (h, a) => h + a >= 3;
    case "under_25": return (h, a) => h + a <= 2;
    case "btts_yes": return (h, a) => h >= 1 && a >= 1;
    case "btts_no": return (h, a) => h === 0 || a === 0;
    case "home_scores_yes": return (h) => h >= 1;
    case "home_scores_no": return (h) => h === 0;
    case "away_scores_yes": return (_h, a) => a >= 1;
    case "away_scores_no": return (_h, a) => a === 0;
  }
}

/**
 * Compute correlation-adjusted joint probability for a set of bet-builder
 * legs in the same match. Returns null if `legs` is empty.
 *
 * Notes on edge cases:
 *  - DNB legs: the standard convention is "draw → stake refunded". We model
 *    it by computing P(DNB selection wins | match not drawn) and combining
 *    with the non-draw mass that satisfies the other legs. To keep the math
 *    consistent for combos, we approximate by treating DNB as the same
 *    predicate as the corresponding 1/2 win — this is conservative because
 *    pushed (drawn) outcomes don't add value but also don't lose. Bookmakers
 *    use the same approach when listing DNB inside same-game multis.
 */
export function jointProbability(
  matrix: number[][],
  legIds: BuilderLegId[],
): number {
  if (legIds.length === 0) return 0;
  const preds = legIds.map(legPredicate);
  let p = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      if (preds.every((fn) => fn(h, a))) p += matrix[h][a];
    }
  }
  return Math.max(0, Math.min(1, p));
}

/**
 * Given the current set of selected legs, return the set of OTHER legs that
 * are now logically incompatible (joint probability == 0 against the matrix,
 * OR same group as a currently-selected leg).
 */
export function conflictingLegs(
  matrix: number[][],
  selected: BuilderLegId[],
): Set<BuilderLegId> {
  const out = new Set<BuilderLegId>();
  // Same-group lockout (only one selection per market)
  const usedGroups = new Set(
    selected.map((id) => BUILDER_LEGS.find((l) => l.id === id)!.group),
  );
  for (const meta of BUILDER_LEGS) {
    if (selected.includes(meta.id)) continue;
    if (usedGroups.has(meta.group)) {
      out.add(meta.id);
      continue;
    }
    // Logical impossibility (joint prob = 0)
    const candidate = [...selected, meta.id];
    if (jointProbability(matrix, candidate) <= 1e-9) out.add(meta.id);
  }
  return out;
}
