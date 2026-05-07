export type MarketKey =
  | "1x2"
  | "ou_15"
  | "ou_25"
  | "btts"
  | "corners"
  | "shots"
  | "shots_on_target"
  | "cards"
  | "double_chance"
  | "dnb"
  | "ah"
  | "home_to_score"
  | "away_to_score";

export interface TeamForm {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  last5: ("W" | "D" | "L")[];
  /**
   * Time-decay weighted attack/defense per game.
   * Computed by `fetchTeamForm` using a 90-day half-life so recent matches
   * count more than older ones. Falls back to raw averages when missing.
   */
  weightedAttackPerGame?: number;
  weightedDefensePerGame?: number;
  /** Effective sample size after weighting (used for reliability blending). */
  effectiveSample?: number;
  /**
   * xG-based attack/defense per game (time-decay weighted, same 90-day
   * half-life as the goals-based stats). When present these are blended into
   * the rate used by the predictor (xG signal is ~30% more predictive than
   * raw goals, per our offline 2023-24 EPL fit).
   */
  weightedXgForPerGame?: number;
  weightedXgAgainstPerGame?: number;
}

/**
 * Injury-impact summary for a team. Computed in `fetchTeamInjuries` from
 * API-Sports `/injuries` endpoint. We translate the count of out / doubtful
 * key players into a small attack/defense penalty applied to λ in the
 * predictor.
 */
export interface InjuryImpact {
  /** Number of players currently flagged out for this fixture (or upcoming). */
  out: number;
  /** Names of the most notable absentees (cap 5, for UI). */
  notable: string[];
  /** Multiplicative penalty on attacking λ (0.85..1.0). */
  attackFactor: number;
  /** Multiplicative penalty on defensive λ (1.0..1.18 = concedes more). */
  defenseFactor: number;
}

export interface MatchSummary {
  id: number;
  utcDate: string;
  status: string;
  competition: {
    name: string;
    emblem?: string | null;
    code?: string;
    /** Country / region of the competition — used to disambiguate leagues
     *  that share the same name (e.g. "Premier League" exists in England,
     *  Russia, Egypt, Ukraine, …). */
    country?: string | null;
  };
  homeTeam: { id: number; name: string; shortName?: string; crest?: string | null };
  awayTeam: { id: number; name: string; shortName?: string; crest?: string | null };
  score: {
    fullTime: { home: number | null; away: number | null };
    halfTime?: { home: number | null; away: number | null };
  };
}

export interface MarketPrediction {
  market: MarketKey;
  label: string;
  pick: string;
  probabilities: Record<string, number>;
  expected?: number;
  line?: number;
}

export interface MatchPredictions {
  matchId: number;
  generatedAt: string;
  homeForm: TeamForm | null;
  awayForm: TeamForm | null;
  expectedGoalsHome: number;
  expectedGoalsAway: number;
  markets: MarketPrediction[];
  commentary: string;
  homeInjuries?: InjuryImpact | null;
  awayInjuries?: InjuryImpact | null;
  /**
   * Model reliability: 0 (no form data — league-average prior only) to 1
   * (8+ recent weighted matches for both teams). Drives the confidence label
   * shown in the UI.
   */
  modelReliability?: number;
}
