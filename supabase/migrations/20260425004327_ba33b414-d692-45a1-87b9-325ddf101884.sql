-- Cache for /fixtures?date=YYYY-MM-DD responses (30 min TTL handled in code)
CREATE TABLE public.fixtures_cache (
  cache_key TEXT NOT NULL PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.fixtures_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read fixtures cache"
  ON public.fixtures_cache FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert fixtures cache"
  ON public.fixtures_cache FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update fixtures cache"
  ON public.fixtures_cache FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER update_fixtures_cache_updated_at
  BEFORE UPDATE ON public.fixtures_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Cache for team form (24h TTL handled in code)
CREATE TABLE public.team_form_cache (
  team_id BIGINT NOT NULL PRIMARY KEY,
  payload JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.team_form_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read team form cache"
  ON public.team_form_cache FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert team form cache"
  ON public.team_form_cache FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update team form cache"
  ON public.team_form_cache FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER update_team_form_cache_updated_at
  BEFORE UPDATE ON public.team_form_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();