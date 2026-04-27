-- Clear stale caches so the new model takes effect immediately
DELETE FROM public.team_form_cache;
DELETE FROM public.predictions_cache;

-- Backtest results table
CREATE TABLE public.backtest_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  matches_tested INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  accuracy NUMERIC NOT NULL,
  brier_score NUMERIC NOT NULL,
  log_loss NUMERIC NOT NULL,
  roi_pct NUMERIC NOT NULL,
  market_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.backtest_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read backtest runs"
ON public.backtest_runs
FOR SELECT
TO authenticated
USING (true);

CREATE INDEX idx_backtest_runs_created_at
ON public.backtest_runs (created_at DESC);