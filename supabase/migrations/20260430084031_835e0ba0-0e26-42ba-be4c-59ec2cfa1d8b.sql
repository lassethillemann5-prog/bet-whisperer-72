CREATE TABLE public.backtest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL DEFAULT 'Untitled backtest',
  competition_id text,
  competition_name text,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  -- model config
  temperature numeric NOT NULL DEFAULT 1.289,
  home_advantage numeric NOT NULL DEFAULT 1.15,
  dc_rho numeric NOT NULL DEFAULT 0.08,
  xg_weight numeric NOT NULL DEFAULT 0.7,
  -- summary metrics
  matches_total integer NOT NULL DEFAULT 0,
  matches_scored integer NOT NULL DEFAULT 0,
  brier_1x2 numeric,
  logloss_1x2 numeric,
  hitrate_1x2 numeric,
  brier_btts numeric,
  brier_ou25 numeric,
  roi_flat numeric,
  bets_placed integer,
  -- detailed results
  results jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE public.backtest_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own backtests"
  ON public.backtest_runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own backtests"
  ON public.backtest_runs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own backtests"
  ON public.backtest_runs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own backtests"
  ON public.backtest_runs FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_backtest_runs_user_created
  ON public.backtest_runs (user_id, created_at DESC);

CREATE TRIGGER update_backtest_runs_updated_at
  BEFORE UPDATE ON public.backtest_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();