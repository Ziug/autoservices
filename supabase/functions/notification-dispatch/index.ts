import webpush from 'npm:web-push@3.6.7';
import {adminClient, errorMessage, json, preflight} from '../_shared/http.ts';

type NotificationJob = {
  id: string;
  tenant_id: string;
  appointment_id: string;
  job_type: 'booking_confirmed' | 'booking_reminder' | 'booking_cancelled' | 'booking_changed';
};

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) mismatch |= leftBytes[index] ^ rightBytes[index];
  return mismatch === 0;
}

function messageFor(jobType: NotificationJob['job_type'], startsAt: string, timezone: string) {
  const when = new Intl.DateTimeFormat('ru-RU', {timeZone: timezone, dateStyle: 'medium', timeStyle: 'short'}).format(new Date(startsAt));
  if (jobType === 'booking_reminder') return {title: 'Завтра ждём вас в студии', body: `Ваша запись: ${when}.`};
  if (jobType === 'booking_cancelled') return {title: 'Запись отменена', body: `Запись на ${when} отменена.`};
  if (jobType === 'booking_changed') return {title: 'Время записи изменено', body: `Новое время: ${when}.`};
  return {title: 'Запись подтверждена', body: `Ждём вас ${when}.`};
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, {error: 'Method not allowed.'}, 405);
  const secret = Deno.env.get('NOTIFICATION_CRON_SECRET') ?? '';
  if (secret.length < 32 || !constantTimeEqual(request.headers.get('x-cron-secret') ?? '', secret)) {
    return json(request, {error: 'Unauthorized.'}, 401);
  }
  try {
    const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
    const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
    const subject = Deno.env.get('VAPID_SUBJECT') ?? '';
    if (!publicKey || !privateKey || !/^mailto:|^https:/.test(subject)) throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be configured.');
    webpush.setVapidDetails(subject, publicKey, privateKey);
    const admin = adminClient();
    const {data: jobs, error: claimError} = await admin.rpc('claim_notification_jobs', {p_batch_size: 50});
    if (claimError) throw claimError;
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const job of (jobs ?? []) as NotificationJob[]) {
      try {
        const [{data: tenant, error: tenantError}, {data: appointment, error: appointmentError}] = await Promise.all([
          admin.from('tenants').select('slug,name,status,is_demo,timezone').eq('id', job.tenant_id).maybeSingle(),
          admin.from('appointments').select('id,idempotency_key,starts_at,status').eq('tenant_id', job.tenant_id).eq('id', job.appointment_id).maybeSingle(),
        ]);
        if (tenantError || appointmentError) throw tenantError ?? appointmentError;
        if (!tenant || !appointment || tenant.status === 'paused' || tenant.status === 'draft' || tenant.is_demo) {
          await admin.rpc('finish_notification_job', {p_id: job.id, p_sent: true, p_error: null});
          skipped += 1;
          continue;
        }
        if (job.job_type === 'booking_reminder' && appointment.status !== 'confirmed') {
          await admin.rpc('finish_notification_job', {p_id: job.id, p_sent: true, p_error: null});
          skipped += 1;
          continue;
        }
        const {data: subscription, error: subscriptionError} = await admin.from('push_subscriptions')
          .select('id,endpoint,p256dh,auth_secret,expires_at').eq('tenant_id', job.tenant_id).eq('appointment_id', job.appointment_id).maybeSingle();
        if (subscriptionError) throw subscriptionError;
        if (!subscription) {
          await admin.rpc('finish_notification_job', {p_id: job.id, p_sent: true, p_error: null});
          skipped += 1;
          continue;
        }
        const copy = messageFor(job.job_type, appointment.starts_at, tenant.timezone);
        const bookingTokenSecret = Deno.env.get('BOOKING_TOKEN_SECRET');
        if (!bookingTokenSecret || bookingTokenSecret.length < 32) throw new Error('BOOKING_TOKEN_SECRET must contain at least 32 characters.');
        const baseUrl = (Deno.env.get('APP_PUBLIC_URL') ?? '').replace(/\/$/, '');
        const accessTokenKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(bookingTokenSecret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
        const signature = new Uint8Array(await crypto.subtle.sign('HMAC', accessTokenKey, new TextEncoder().encode(`${tenant.slug}:${appointment.idempotency_key}`)));
        let binary = '';
        for (const byte of signature) binary += String.fromCharCode(byte);
        const accessToken = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        const url = baseUrl ? `${baseUrl}/s/${tenant.slug}/reservation/${appointment.id}?token=${encodeURIComponent(accessToken)}` : `/s/${tenant.slug}/`;
        try {
          await webpush.sendNotification({
            endpoint: subscription.endpoint,
            keys: {p256dh: subscription.p256dh, auth: subscription.auth_secret},
            expirationTime: subscription.expires_at ? new Date(subscription.expires_at).getTime() : null,
          }, JSON.stringify({...copy, url, tag: `booking-${appointment.id}`}), {TTL: 60 * 60 * 24});
          await admin.rpc('finish_notification_job', {p_id: job.id, p_sent: true, p_error: null});
          sent += 1;
        } catch (pushError) {
          const statusCode = (pushError as {statusCode?: number})?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await admin.from('push_subscriptions').delete().eq('id', subscription.id);
            await admin.rpc('finish_notification_job', {p_id: job.id, p_sent: true, p_error: null});
            skipped += 1;
          } else {
            await admin.rpc('finish_notification_job', {p_id: job.id, p_sent: false, p_error: errorMessage(pushError)});
            failed += 1;
          }
        }
      } catch (jobError) {
        await admin.rpc('finish_notification_job', {p_id: job.id, p_sent: false, p_error: errorMessage(jobError)});
        failed += 1;
      }
    }
    return json(request, {claimed: (jobs ?? []).length, sent, skipped, failed});
  } catch (error) {
    return json(request, {error: errorMessage(error)}, 500);
  }
});
