/**
 * Lightweight football ELO. Cold-start at 1500. Updates per finished match
 * with a margin-of-victory multiplier (FiveThirtyEight style).
 */
export const ELO_DEFAULT = 1500;
export const ELO_HOME_BONUS = 65;
export const ELO_K_BASE = 20;

/** Expected score for `ratingA` against `ratingB` (no home bonus applied). */
export function eloExpected(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/** ELO-derived home win probability (no draw split). Home bonus baked in. */
export function eloHomeWinProb(ratingHome: number, ratingAway: number): number {
  return eloExpected(ratingHome + ELO_HOME_BONUS, ratingAway);
}

/** Convert ELO into a 1X2 distribution by carving a draw share out of the
 *  closeness of the two ratings. Cheap heuristic — only used as a prior to
 *  blend with the Poisson model. */
export function eloDistribution(
  ratingHome: number,
  ratingAway: number,
): { pH: number; pD: number; pA: number } {
  const diff = (ratingHome + ELO_HOME_BONUS) - ratingAway;
  // Draw share peaks (~0.30) when ratings are equal, decays as |diff| grows.
  const pD = 0.30 * Math.exp(-(diff * diff) / (2 * 200 * 200));
  const pHraw = eloExpected(ratingHome + ELO_HOME_BONUS, ratingAway);
  // Distribute remaining (1 - pD) across H/A using ELO expected score.
  const pH = (1 - pD) * pHraw;
  const pA = (1 - pD) * (1 - pHraw);
  return { pH, pD, pA };
}

/** Logit-pool two 1X2 distributions with weight w on the second one. */
export function logitPool1x2(
  base: { pH: number; pD: number; pA: number },
  prior: { pH: number; pD: number; pA: number },
  w: number,
): { pH: number; pD: number; pA: number } {
  const lg = (p: number) => Math.log(Math.max(1e-9, p));
  const ln = {
    pH: (1 - w) * lg(base.pH) + w * lg(prior.pH),
    pD: (1 - w) * lg(base.pD) + w * lg(prior.pD),
    pA: (1 - w) * lg(base.pA) + w * lg(prior.pA),
  };
  const eH = Math.exp(ln.pH), eD = Math.exp(ln.pD), eA = Math.exp(ln.pA);
  const s = eH + eD + eA;
  return { pH: eH / s, pD: eD / s, pA: eA / s };
}

/** Update ratings after a finished match. Returns the new ratings. */
export function eloUpdate(
  ratingHome: number,
  ratingAway: number,
  goalsHome: number,
  goalsAway: number,
): { home: number; away: number } {
  const expH = eloExpected(ratingHome + ELO_HOME_BONUS, ratingAway);
  const actH = goalsHome > goalsAway ? 1 : goalsHome === goalsAway ? 0.5 : 0;
  const margin = Math.abs(goalsHome - goalsAway);
  // 538-style multiplier: 1 for 1-goal margin, log-scaled higher for blowouts,
  // damped when the favourite wins big.
  const eloDiff = (ratingHome + ELO_HOME_BONUS) - ratingAway;
  const winnerFav = (goalsHome > goalsAway && eloDiff > 0) || (goalsAway > goalsHome && eloDiff < 0);
  const mult =
    margin <= 1
      ? 1
      : margin === 2
      ? 1.5
      : (11 + margin) / 8;
  const damp = winnerFav ? 2.2 / (Math.abs(eloDiff) * 0.001 + 2.2) : 1;
  const k = ELO_K_BASE * mult * damp;
  const delta = k * (actH - expH);
  return { home: ratingHome + delta, away: ratingAway - delta };
}
