import {z} from 'npm:zod@4.6.6';
import {adminClient, checkRateLimit, errorMessage, forbiddenOrigin, json, preflight, sha256, tenantBySlug} from '../_shared/http.ts';

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
    if (!await checkRateLimit(admin, request, 'appointment-access', tenant.id, 30, 300)) return json(request, {error: 'Слишком много запросов. Попробуйте позже.'}, 429);
    const tokenHash = await sha256(input.accessToken);
    const {data: appointment, error} = await admin.from('appointments')
      .select('id,tenant_id,service_id,resource_id,customer_name,customer_phone,vehicle,starts_at,ends_at,status,price_minor')
      .eq('tenant_id', tenant.id).eq('id', input.appointmentId).eq('access_token_hash', tokenHash).maybeSingle();
    if (error) throw error;
    if (!appointment) return json(request, {error: 'Ссылка на запись недействительна.'}, 404);
    const [{data: service}, {data: resource}] = await Promise.all([
      admin.from('services').select('slug,name').eq('tenant_id', tenant.id).eq('id', appointment.service_id).maybeSingle(),
      admin.from('resources').select('name').eq('tenant_id', tenant.id).eq('id', appointment.resource_id).maybeSingle(),
    ]);
    return json(request, {appointment: {
      id: appointment.id, tenantId: appointment.tenant_id, serviceSlug: service?.slug ?? '', serviceName: service?.name ?? 'Услуга',
      resourceLabel: resource?.name, startsAt: appointment.starts_at, endsAt: appointment.ends_at,
      customerName: appointment.customer_name, customerPhone: appointment.customer_phone, vehicle: appointment.vehicle,
      status: appointment.status, priceMinor: appointment.price_minor,
    }});
  } catch (error) {
    return json(request, {error: errorMessage(error)}, 400);
  }
});
