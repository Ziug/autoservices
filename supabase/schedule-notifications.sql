-- Run once in the Supabase SQL Editor after enabling pg_cron, pg_net and Vault.
-- Replace the two values in the vault calls, then keep the values out of source control.
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'autoservices_project_url');
select vault.create_secret('REPLACE_WITH_NOTIFICATION_CRON_SECRET', 'autoservices_notification_cron_secret');

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
