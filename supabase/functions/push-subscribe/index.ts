import {z} from 'npm:zod@4.6.6';
import {adminClient, checkRateLimit, errorMessage, errorStatus, forbiddenOrigin, json, preflight, sha256, tenantBySlug} from '../_shared/http.ts';

const inputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  appointmentId: z.uuid(),
  accessToken: z.string().min(32).max(256),
  subscription: z.object({
    endpoint: z.url().max(2000),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({p256dh: z.string().min(16).max(512), auth: z.string().min(8).max(512)}).strict(),
  }).strict(),
}).strict();

Deno.serve(async (request) => {
  if (forbiddenOrigin(request)) return json(request, {error: 'Origin is not allowed.'}, 403);
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, {error: 'Method not allowed.'}, 405);
  try {
    const input = inputSchema.parse(await request.json());
    const admin = adminClient();
    const tenant = await tenantBySlug(admin, input.slug);
    if (!tenant || tenant.is_demo) return json(request, {error: 'Push-напоминания недоступны для демо-студий.'}, 400);
    if (!await checkRateLimit(admin, request, 'push-subscribe', tenant.id, 15, 600)) return json(request, {error: 'Слишком много попыток подключения уведомлений. Подождите несколько минут и попробуйте снова.'}, 429);
    const tokenHash = await sha256(input.accessToken);
    const {data: appointment, error: lookupError} = await admin.from('appointments').select('id,status,starts_at')
      .eq('tenant_id', tenant.id).eq('id', input.appointmentId).eq('access_token_hash', tokenHash).maybeSingle();
    if (lookupError) throw lookupError;
    if (!appointment) return json(request, {error: 'Ссылка на запись недействительна.'}, 404);
    if (appointment.status !== 'confirmed') return json(request, {error: 'Включить напоминание можно только для подтверждённой записи.'}, 404);
    if (new Date(appointment.starts_at).getTime() <= Date.now() + 24 * 60 * 60 * 1000) return json(request, {error: 'До записи осталось меньше суток. Добавьте её в календарь.'}, 409);
    const expiresAt = input.subscription.expirationTime ? new Date(input.subscription.expirationTime).toISOString() : null;
    const {data, error} = await admin.rpc('save_push_subscription', {
      p_tenant_id: tenant.id, p_appointment_id: appointment.id, p_endpoint: input.subscription.endpoint,
      p_p256dh: input.subscription.keys.p256dh, p_auth_secret: input.subscription.keys.auth, p_expires_at: expiresAt,
    });
    if (error) return json(request, {error: errorMessage(error)}, errorStatus(error));
    return json(request, {subscribed: Boolean(data)});
  } catch (error) {
    return json(request, {error: errorMessage(error)}, 400);
  }
});
