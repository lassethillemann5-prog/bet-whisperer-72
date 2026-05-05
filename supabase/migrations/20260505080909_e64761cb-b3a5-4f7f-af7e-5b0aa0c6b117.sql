CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'daily-odds-snapshot',
  '0 7 * * *',
  $$
  SELECT net.http_post(
    url:='https://project--e02f00b5-c664-4815-8d21-933fa2ac8f3d.lovable.app/api/public/hooks/daily-odds-snapshot',
    headers:='{"Content-Type": "application/json"}'::jsonb,
    body:='{}'::jsonb
  ) as request_id;
  $$
);