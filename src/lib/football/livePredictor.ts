/**
 * Client-side live (in-play) predictor.
 *
 * Zero API cost: reuses the pre-match expected goals (xG) per team that we
 * already cached in `predictions_cache`, combines them with the live score
 * and elapsed minute, and returns updated probabilities for the most useful
 * markets (1X2, BTTS, Over/Under 2.5, Over/Under 1.5).
 *
 * Math:
 *  - Remaining-time λ for each side: preMatchXg * (minutesRemaining / 90).
 *  - Slight in-play tempo bump (+8%) — empirically goals per minute rise
 *    after halftime as fatigue and chasing increase risk.
 *  - We iterate Poisson PMFs for goals scored *from now to FT* and add the
 *    current scoreline to get the FT distribution.
 *  - Probabilities collapse to certainties at FT (e.g. if 90' and 1-1, draw=100%).
 */

export interface LiveProbabilities {
  /** 1X2 — home win / draw / away win as percentages summing to ~100 */
  home: number;
  draw: number;
  away: number;
  /** Over 2.5 goals at FT */
  over25: number;
  /** Over 1.5 goals at FT */
  over15: number;
  /** Both teams to score at FT */
  btts: number;
  /** Whether the model considers the match decided (final whistle reached) */
  settled: boolean;
}

const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE"]);
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "FINISHED"]);

function poisson(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** Effective minutes remaining (regular time only, capped at 90). */
function minutesRemaining(status: string, minute: number | null): number {
  if (FINISHED_STATUSES.has(status)) return 0;
  if (status === "HT") return 45;
  if (status === "ET" || status === "BT" || status === "P") return 0; // treat extra time as ~settled for regular markets
  if (minute == null) return 90;
  return Math.max(0, 90 - minute);
}

/**
 * @param preMatchXgHome Pre-match expected goals for home (from cached predictions)
 * @param preMatchXgAway Pre-match expected goals for away
 * @param liveHome Current home score (0 if null)
 * @param liveAway Current away score (0 if null)
 * @param status API-Sports short status code
 * @param minute Current elapsed minute (regular time)
 */
export function computeLiveProbabilities(
  preMatchXgHome: number,
  preMatchXgAway: number,
  liveHome: number,
  liveAway: number,
  status: string,
  minute: number | null,
  maxAdditionalGoals = 6,
): LiveProbabilities {
  const remaining = minutesRemaining(status, minute);
  const settled = remaining === 0;

  // Tempo bump for in-play vs neutral pre-match rate
  const tempo = LIVE_STATUSES.has(status) ? 1.08 : 1.0;
  const lambdaH = Math.max(0, preMatchXgHome) * (remaining / 90) * tempo;
  const lambdaA = Math.max(0, preMatchXgAway) * (remaining / 90) * tempo;

  let pHomeWin = 0, pDraw = 0, pAwayWin = 0;
  let pOver25 = 0, pOver15 = 0, pBtts = 0;

  for (let h = 0; h <= maxAdditionalGoals; h++) {
    const ph = poisson(h, lambdaH);
    for (let a = 0; a <= maxAdditionalGoals; a++) {
      const pa = poisson(a, lambdaA);
      const p = ph * pa;
      const finalH = liveHome + h;
      const finalA = liveAway + a;
      const total = finalH + finalA;

      if (finalH > finalA) pHomeWin += p;
      else if (finalH < finalA) pAwayWin += p;
      else pDraw += p;

      if (total > 2.5) pOver25 += p;
      if (total > 1.5) pOver15 += p;
      if (finalH >= 1 && finalA >= 1) pBtts += p;
    }
  }

  // Normalise (truncation loses tiny probability mass)
  const sum1x2 = pHomeWin + pDraw + pAwayWin || 1;
  pHomeWin /= sum1x2; pDraw /= sum1x2; pAwayWin /= sum1x2;

  return {
    home: +(pHomeWin * 100).toFixed(1),
    draw: +(pDraw * 100).toFixed(1),
    away: +(pAwayWin * 100).toFixed(1),
    over25: +(pOver25 * 100).toFixed(1),
    over15: +(pOver15 * 100).toFixed(1),
    btts: +(pBtts * 100).toFixed(1),
    settled,
  };
}

export function isLiveOrFinished(status: string): boolean {
  return LIVE_STATUSES.has(status) || FINISHED_STATUSES.has(status) || status === "HT";
}
