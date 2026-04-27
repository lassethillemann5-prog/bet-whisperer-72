export type MarketKey =
  | "1x2"
  | "ou_15"
  | "ou_25"
  | "btts"
  | "corners"
  | "shots"
  | "shots_on_target";

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
}
