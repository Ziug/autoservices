import {z} from 'npm:zod@4.6.6';
import {adminClient, checkRateLimit, errorMessage, errorStatus, forbiddenOrigin, json, preflight, sha256, tenantBySlug} from '../_shared/http.ts';

const inputSchema = z.object({slug: z.string().regex(/^[a-z0-9-]+$/), appointmentId: z.uuid(), accessToken: z.string().min(32).max(256)}).strict();

Deno.serve(async (request) => {
  if (forbiddenOrigin(request)) return json(request, {error: 'Origin is not allowed.'}, 403);
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, {error: 'Method not allowed.'}, 405);
  try {
    const input = inputSchema.parse(await request.json());
    const admin = adminClient();
    const tenant = await tenantBySlug(admin, input.slug);
    if (!tenant) return json(request, {error: 'Студия не найдена.'}, 404);
    if (!await checkRateLimit(admin, request, 'cancel', tenant.id, 8, 600)) return json(request, {error: 'Слишком много попыток отмены. Попробуйте позже.'}, 429);
    const tokenHash = await sha256(input.accessToken);
    const {data: appointment, error: lookupError} = await admin.from('appointments').select('id,starts_at,status,access_token_hash')
      .eq('tenant_id', tenant.id).eq('id', input.appointmentId).eq('access_token_hash', tokenHash).maybeSingle();
    if (lookupError) throw lookupError;
    if (!appointment) return json(request, {error: 'Ссылка на запись недействительна.'}, 404);
    const cancelDeadline = new Date(appointment.starts_at).getTime() - tenant.cancellation_window_hours * 60 * 60 * 1000;
    if (Date.now() > cancelDeadline) return json(request, {error: `Отменить запись онлайн можно не позднее чем за ${tenant.cancellation_window_hours} ч. Позвоните в студию.`}, 409);
    const {data, error} = await admin.rpc('cancel_appointment', {p_tenant_id: tenant.id, p_appointment_id: appointment.id});
    if (error) return json(request, {error: errorMessage(error)}, errorStatus(error));
    if (data !== true) return json(request, {error: 'Эту запись больше нельзя отменить.'}, 409);
    return json(request, {cancelled: true});
  } catch (error) {
    return json(request, {error: errorMessage(error)}, 400);
  }
});
