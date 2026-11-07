-- Meeting reminder emails: runs the "reminders" server function every minute.
-- Paste into Supabase → SQL Editor after the functions are deployed. Replace YOUR-PROJECT-REF first.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('meeting-reminders') where exists (select 1 from cron.job where jobname = 'meeting-reminders');
select cron.schedule('meeting-reminders', '* * * * *', $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object('Content-Type','application/json',
                 'x-cron-secret', (select value from private.settings where key = 'cron_secret')),
    body    := '{}'::jsonb
  );
$$);

-- Every hour (minute 23): tidy storage folders — old-style file names are moved to
-- <YYYY-MM>/<YYYY-MM-DD>/<Person>/<Project>/<Task>/<file>, and old copies are removed 6 hours after the move.
select cron.schedule('files-organize', '23 * * * *', $$
  select net.http_post(
    url     := 'https://jgimgizotkjnpfwcizvy.supabase.co/functions/v1/files-organize',
    headers := jsonb_build_object('Content-Type','application/json',
                 'x-cron-secret', (select value from private.settings where key = 'cron_secret')),
    body    := '{"limit":100}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
