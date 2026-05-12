
CREATE TABLE public.league_calibration (
  league_id integer PRIMARY KEY,
  league_name text NOT NULL,
  temperature numeric NOT NULL DEFAULT 1.289,
  home_advantage numeric NOT NULL DEFAULT 1.15,
  dc_rho numeric NOT NULL DEFAULT 0.08,
  xg_weight numeric NOT NULL DEFAULT 0.7,
  elo_weight numeric NOT NULL DEFAULT 0.3,
  brier_1x2 numeric,
  logloss_1x2 numeric,
  hitrate_1x2 numeric,
  matches_scored integer,
  date_from date,
  date_to date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.league_calibration ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read league calibration"
  ON public.league_calibration FOR SELECT
  TO authenticated USING (true);

CREATE TABLE public.team_elo (
  team_id bigint NOT NULL,
  league_id integer NOT NULL,
  team_name text,
  rating numeric NOT NULL DEFAULT 1500,
  matches_played integer NOT NULL DEFAULT 0,
  last_match_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, league_id)
);

CREATE INDEX idx_team_elo_league ON public.team_elo(league_id);

ALTER TABLE public.team_elo ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read team elo"
  ON public.team_elo FOR SELECT
  TO authenticated USING (true);

CREATE TRIGGER trg_league_calibration_updated_at
  BEFORE UPDATE ON public.league_calibration
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_team_elo_updated_at
  BEFORE UPDATE ON public.team_elo
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
