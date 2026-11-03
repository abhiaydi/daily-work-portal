-- Meeting reminder emails: runs the "reminders" server function every minute.
-- Paste into Supabase → SQL Editor AFTER the functions are deployed.
-- Replace the two CAPITALISED placeholders first. Do NOT commit the filled-in version.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('meeting-reminders') where exists (select 1 from cron.job where jobname = 'meeting-reminders');
select cron.schedule('meeting-reminders', '* * * * *', $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','YOUR-CRON-SECRET'),
    body    := '{}'::jsonb
  );
$$);
