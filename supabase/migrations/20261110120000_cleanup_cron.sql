-- Tägliches Aufräumen: Spiele älter als 7 Tage samt Fotos löschen.
-- Die Arbeit macht die Edge Function cleanup-old-games (Fotos lassen sich nur über
-- die Storage-API löschen). Der Schlüssel im Header ist der öffentliche anon-Key.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'hideseek-cleanup',
  '17 3 * * *',
  $$
  select net.http_post(
    url     := 'https://knntkrobxuioqmfmvook.supabase.co/functions/v1/cleanup-old-games',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtubnRrcm9ieHVpb3FtZm12b29rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyNTkyMDUsImV4cCI6MjEwOTgzNTIwNX0.iOY0adfvossiOhDWblC8NntSV4JDiaMNfPBxWwIe3ho'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Fotos sind nach dem Verkleinern in der App deutlich unter 1 MB
update storage.buckets set file_size_limit = 1048576 where id = 'photos';
