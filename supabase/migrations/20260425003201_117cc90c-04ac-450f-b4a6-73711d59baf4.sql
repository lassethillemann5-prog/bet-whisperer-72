-- Bankroll settings (one row per user)
CREATE TABLE public.bankroll_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  starting_bankroll NUMERIC NOT NULL DEFAULT 1000,
  current_bankroll NUMERIC NOT NULL DEFAULT 1000,
  unit_size NUMERIC NOT NULL DEFAULT 10,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.bankroll_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own bankroll" ON public.bankroll_settings
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own bankroll" ON public.bankroll_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own bankroll" ON public.bankroll_settings
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own bankroll" ON public.bankroll_settings
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_bankroll_settings_updated_at
  BEFORE UPDATE ON public.bankroll_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Bet log
CREATE TABLE public.bet_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  match_id BIGINT,
  home_team TEXT,
  away_team TEXT,
  competition TEXT,
  utc_date TIMESTAMP WITH TIME ZONE,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  decimal_odds NUMERIC NOT NULL,
  stake NUMERIC NOT NULL,
  units NUMERIC NOT NULL,
  model_probability NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending',
  profit NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.bet_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own bets" ON public.bet_log
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own bets" ON public.bet_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own bets" ON public.bet_log
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own bets" ON public.bet_log
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_bet_log_updated_at
  BEFORE UPDATE ON public.bet_log
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_bet_log_user_status ON public.bet_log(user_id, status);
CREATE INDEX idx_bet_log_user_created ON public.bet_log(user_id, created_at DESC);

-- Status check
ALTER TABLE public.bet_log ADD CONSTRAINT bet_log_status_check
  CHECK (status IN ('pending', 'won', 'lost', 'void', 'half_won', 'half_lost'));