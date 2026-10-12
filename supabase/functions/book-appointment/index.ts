import {z} from 'npm:zod@4.6.6';
import {adminClient, checkRateLimit, deterministicAccessToken, errorMessage, errorStatus, forbiddenOrigin, json, preflight, sha256, tenantBySlug} from '../_shared/http.ts';

const inputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  serviceSlug: z.string().regex(/^[a-z0-9-]+$/),
  startsAt: z.iso.datetime({offset: true}),
  customerName: z.string().trim().min(2).max(100),
  customerPhone: z.string().trim().min(5).max(40).regex(/^[+\d() .-]+$/),
  vehicle: z.string().trim().min(2).max(120),
  idempotencyKey: z.uuid(),
}).strict();

Deno.serve(async (request) => {
  if (forbiddenOrigin(request)) return json(request, {error: 'Origin is not allowed.'}, 403);
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, {error: 'Method not allowed.'}, 405);
  try {
    const input = inputSchema.parse(await request.json());
    const admin = adminClient();
    const tenant = await tenantBySlug(admin, input.slug);
    if (!tenant) return json(request, {error: 'Studio not found.'}, 404);
    if (!await checkRateLimit(admin, request, 'booking', tenant.id, 12, 600)) return json(request, {error: 'Слишком много попыток записи. Попробуйте позже.'}, 429);
    const accessToken = await deterministicAccessToken(input.slug, input.idempotencyKey);
    const accessTokenHash = await sha256(accessToken);
    const {data, error} = await admin.rpc('create_public_booking', {
      p_slug: input.slug,
      p_service_slug: input.serviceSlug,
      p_starts_at: input.startsAt,
      p_customer_name: input.customerName,
      p_customer_phone: input.customerPhone,
      p_vehicle: input.vehicle,
      p_idempotency_key: input.idempotencyKey,
      p_access_token_hash: accessTokenHash,
    });
    if (error) return json(request, {error: errorMessage(error)}, errorStatus(error));
    const appointment = data as Record<string, unknown>;
    return json(request, {
      appointment: {
        id: appointment.id,
        tenantId: appointment.tenant_id,
        serviceSlug: input.serviceSlug,
        startsAt: appointment.starts_at,
        endsAt: appointment.ends_at,
        customerName: appointment.customer_name,
        customerPhone: appointment.customer_phone,
        vehicle: appointment.vehicle,
        status: appointment.status,
        priceMinor: appointment.price_minor,
      },
      accessToken,
      idempotent: appointment.idempotent === true,
    }, 201);
  } catch (error) {
    return json(request, {error: errorMessage(error)}, 400);
  }
});
