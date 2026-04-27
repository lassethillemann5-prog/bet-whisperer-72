-- Cache for team injury data (mirrors team_form_cache structure)
CREATE TABLE IF NOT EXISTS public.team_injuries_cache (
  team_id BIGINT PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.team_injuries_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read team injuries cache"
  ON public.team_injuries_cache FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert team injuries cache"
  ON public.team_injuries_cache FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update team injuries cache"
  ON public.team_injuries_cache FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- CLV tracking columns on bet_log
ALTER TABLE public.bet_log
  ADD COLUMN IF NOT EXISTS closing_odds NUMERIC,
  ADD COLUMN IF NOT EXISTS closing_odds_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clv_pct NUMERIC;
-- closing_odds: market closing decimal odds for this selection
-- clv_pct: (taken_odds / closing_odds - 1) * 100 — positive = bet beat the close