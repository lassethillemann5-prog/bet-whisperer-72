import type { MarketPrediction, TeamForm } from "./types";

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
  ];

  return {
    markets,
    expectedGoalsHome: +lambdaHome.toFixed(2),
    expectedGoalsAway: +lambdaAway.toFixed(2),
  };
}
