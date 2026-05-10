-- Clear cached "no matching event" odds errors so the improved matcher can retry.
DELETE FROM public.fixtures_cache
WHERE cache_key LIKE 'live-odds:%'
  AND (payload->>'error') IS NOT NULL;
