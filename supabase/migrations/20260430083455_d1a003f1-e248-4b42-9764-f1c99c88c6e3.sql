CREATE TABLE public.odds_api_usage (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  match_id BIGINT,
  market TEXT NOT NULL,
  credits_used INTEGER NOT NULL DEFAULT 0,
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.odds_api_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own odds usage"
  ON public.odds_api_usage FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own odds usage"
  ON public.odds_api_usage FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_odds_api_usage_user_created ON public.odds_api_usage(user_id, created_at DESC);