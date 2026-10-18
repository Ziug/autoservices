-- Run once per project, after enabling the extensions:
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
-- (Vault ships enabled on Supabase as `supabase_vault`.)
--
-- Replace the two placeholder values below, then keep real values out of source
-- control. Safe to re-run: secrets are only created when missing, and
-- cron.schedule upserts by job name — duplicate vault rows would otherwise
-- break the cron command's scalar subqueries.
--
-- Applied to production (gabebrxkbiaokdwsixnh) on 2026-10-18 via
--   supabase db query --linked -f supabase/schedule-notifications.sql

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'autoservices_project_url') then
    perform vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'autoservices_project_url');
  end if;
  if not exists (select 1 from vault.secrets where name = 'autoservices_notification_cron_secret') then
    perform vault.create_secret('REPLACE_WITH_NOTIFICATION_CRON_SECRET', 'autoservices_notification_cron_secret');
  end if;
end $$;

select cron.schedule(
  'autoservices-notification-dispatch',
  '*/5 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'autoservices_project_url') || '/functions/v1/notification-dispatch',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'autoservices_notification_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $job$
);
