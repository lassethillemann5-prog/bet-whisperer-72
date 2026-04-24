CREATE POLICY "Authenticated users can insert predictions"
  ON public.predictions_cache FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update predictions"
  ON public.predictions_cache FOR UPDATE TO authenticated USING (true) WITH CHECK (true);