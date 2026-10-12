import {z} from 'npm:zod@4.6.6';
import {adminClient, checkRateLimit, errorMessage, forbiddenOrigin, json, preflight, tenantBySlug} from '../_shared/http.ts';

const inputSchema = z.object({slug: z.string().regex(/^[a-z0-9-]+$/), serviceSlug: z.string().regex(/^[a-z0-9-]+$/), day: z.iso.date()}).strict();

Deno.serve(async (request) => {
  if (forbiddenOrigin(request)) return json(request, {error: 'Origin is not allowed.'}, 403);
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, {error: 'Method not allowed.'}, 405);
  try {
    const input = inputSchema.parse(await request.json());
    const admin = adminClient();
    const tenant = await tenantBySlug(admin, input.slug);
    if (!tenant) return json(request, {error: 'Studio not found.'}, 404);
    if (!await checkRateLimit(admin, request, 'slots', tenant.id, 60, 300)) return json(request, {error: 'Слишком много запросов. Попробуйте через несколько минут.'}, 429);
    const {data, error} = await admin.rpc('public_booking_slots', {p_slug: input.slug, p_service_slug: input.serviceSlug, p_local_day: input.day});
    if (error) throw error;
    return json(request, {slots: data ?? []});
  } catch (error) {
    return json(request, {error: errorMessage(error)}, 400);
  }
});
