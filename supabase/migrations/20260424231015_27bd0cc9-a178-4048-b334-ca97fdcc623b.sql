CREATE TABLE public.match_odds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  match_id BIGINT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  decimal_odds NUMERIC(8,3) NOT NULL CHECK (decimal_odds > 1),
  bookmaker TEXT,
  line NUMERIC(5,2),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX match_odds_unique_user_match_market_selection
  ON public.match_odds (user_id, match_id, market, selection);

CREATE INDEX match_odds_user_match_idx ON public.match_odds (user_id, match_id);

ALTER TABLE public.match_odds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own odds"
ON public.match_odds FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own odds"
ON public.match_odds FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own odds"
ON public.match_odds FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own odds"
ON public.match_odds FOR DELETE
USING (auth.uid() = user_id);

CREATE TRIGGER update_match_odds_updated_at
BEFORE UPDATE ON public.match_odds
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();