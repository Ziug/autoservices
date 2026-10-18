import {formatInTimeZone} from 'date-fns-tz';
import {businessSchema, type Appointment, type AvailabilitySlot, type BusinessConfig, type OwnerMetrics, type Service} from '@/domain/tenant';
import {byCreatedAt, type OrderLine, type OrderLineKind, type OrderNote, type OrderPayment} from '@/lib/order';
import {hasSupabaseConfig, supabase} from '@/lib/supabase';

function requireSupabase() {
  if (!supabase) throw new Error('Для работы приложения нужен Supabase: задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY.');
  return supabase;
}

export async function loadBusiness(slug: string, options: {includeInactive?: boolean} = {}): Promise<BusinessConfig> {
  const client = requireSupabase();
  const {data: tenant, error} = await client.from('tenants').select('*').eq('slug', slug).in('status', ['preview', 'live']).maybeSingle();
  if (error) throw new Error(`Не удалось загрузить студию: ${error.message}`);
  if (!tenant) throw new Error('Студия не найдена или ещё не опубликована.');
  const [{data: serviceRows, error: serviceError}, {data: resourceRows, error: resourceError}] = await Promise.all([
    client.from('services').select('*').eq('tenant_id', tenant.id).order('created_at'),
    client.from('resources').select('*').eq('tenant_id', tenant.id).order('created_at'),
  ]);
  if (serviceError || resourceError) throw new Error(serviceError?.message ?? resourceError?.message ?? 'Не удалось загрузить услуги и посты.');
  return businessSchema.parse({
    id: tenant.id,
    schemaVersion: 1,
    slug: tenant.slug,
    name: tenant.name,
    tagline: tenant.tagline || '',
    description: tenant.description || '',
    city: tenant.city || '',
    address: tenant.address || '',
    phone: tenant.phone || '',
    mapUrl: tenant.map_url || undefined,
    timezone: tenant.timezone,
    currency: tenant.currency,
    locale: tenant.locale,
    accentColor: tenant.accent_color,
    heroImage: tenant.hero_image_url,
    logoImage: tenant.logo_url,
    demo: tenant.is_demo,
    status: tenant.status,
    bookingStepMinutes: tenant.booking_step_minutes,
    cancellationWindowHours: tenant.cancellation_window_hours,
    openingHours: tenant.opening_hours,
    gallery: tenant.gallery,
    infoCards: tenant.info_cards,
    assistantPrompts: tenant.assistant_prompts,
    services: (serviceRows ?? []).filter((service) => options.includeInactive || service.active).map((service) => ({
      id: service.id,
      slug: service.slug,
      name: service.name,
      description: service.description,
      priceMinor: service.price_minor,
      durationMinutes: service.duration_minutes,
      bufferBeforeMinutes: service.buffer_before_minutes,
      bufferAfterMinutes: service.buffer_after_minutes,
      category: service.category,
      resourceTypes: service.resource_types,
      active: service.active,
    })),
    resources: (resourceRows ?? []).filter((resource) => options.includeInactive || resource.active).map((resource) => ({id: resource.id, slug: resource.slug, name: resource.name, resourceType: resource.resource_type, active: resource.active})),
  });
}

type SlotRow = {starts_at?: unknown; available_count?: unknown; startsAt?: unknown; availableCount?: unknown};

/**
 * Boundary mapping for get-slots rows. The RPC returns Postgres column names
 * (`starts_at`, `available_count`) and the Edge Function passes them through
 * unchanged, while the app (and the offline demo engine) speaks camelCase.
 * A missing mapping here silently empties every day: `availableCount` reads
 * `undefined`, the `> 0` filter drops all rows, and no slot can be confirmed.
 * Zero-count rows are preserved (the page decides emptiness); malformed rows
 * without a usable start time are dropped.
 */
export function toAvailableSlots(rows: unknown): AvailabilitySlot[] {
  if (!Array.isArray(rows)) return [];
  const mapped: AvailabilitySlot[] = [];
  for (const row of rows as SlotRow[]) {
    if (!row || typeof row !== 'object') continue;
    const startsAt = typeof row.starts_at === 'string' ? row.starts_at : typeof row.startsAt === 'string' ? row.startsAt : null;
    const rawCount = typeof row.available_count === 'number' ? row.available_count : typeof row.availableCount === 'number' ? row.availableCount : null;
    if (startsAt === null || rawCount === null) continue;
    mapped.push({startsAt, availableCount: rawCount});
  }
  return mapped;
}

/**
 * Best-effort read of the server's {error} body from a FunctionsHttpError.
 * supabase-js v2 puts a generic English text in error.message; the actual
 * Russian message (e.g. SLOT_TAKEN) travels in error.context (Response).
 * Without this, message-matching branches in the booking flow are dead.
 */
async function readFunctionErrorBody(error: unknown): Promise<string | null> {
  try {
    const context = (error as {context?: unknown}).context;
    if (context instanceof Response) {
      const body = (await context.clone().json()) as {error?: unknown};
      if (body && typeof body.error === 'string' && body.error) return body.error;
    }
  } catch {
    // Fall through to the generic message.
  }
  return null;
}

async function functionError(prefix: string, fallback: string, error: unknown): Promise<never> {
  const detail = await readFunctionErrorBody(error);
  if (detail) throw new Error(detail);
  const message = error instanceof Error && error.message ? error.message : fallback;
  throw new Error(prefix ? `${prefix}: ${message}` : message);
}

export async function loadAvailability(business: BusinessConfig, service: Service, day: string): Promise<AvailabilitySlot[]> {
  const {data, error} = await requireSupabase().functions.invoke('get-slots', {body: {slug: business.slug, serviceSlug: service.slug, day}});
  if (error) await functionError('Не удалось проверить свободное время', 'Не удалось проверить свободное время.', error);
  return toAvailableSlots((data as {slots?: unknown} | null)?.slots);
}

export async function reserveAppointment(input: {
  business: BusinessConfig;
  service: Service;
  startsAt: string;
  customerName: string;
  customerPhone: string;
  vehicle: string;
  idempotencyKey: string;
}): Promise<{appointment: Appointment; accessToken: string}> {
  const {data, error} = await requireSupabase().functions.invoke('book-appointment', {
    body: {
      slug: input.business.slug,
      serviceSlug: input.service.slug,
      startsAt: input.startsAt,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      vehicle: input.vehicle,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (error) await functionError('', 'Не удалось оформить запись.', error);
  return data as {appointment: Appointment; accessToken: string};
}

export async function loadAppointmentAccess(business: BusinessConfig, appointmentId: string, accessToken: string) {
  const {data, error} = await requireSupabase().functions.invoke('appointment-access', {body: {slug: business.slug, appointmentId, accessToken}});
  if (error) await functionError('', 'Не удалось загрузить запись.', error);
  return data?.appointment as Appointment;
}

export async function cancelAppointment(business: BusinessConfig, appointmentId: string, accessToken: string) {
  const {data, error} = await requireSupabase().functions.invoke('cancel-appointment', {body: {slug: business.slug, appointmentId, accessToken}});
  if (error) await functionError('', 'Не удалось отменить запись.', error);
  return data as {cancelled: boolean};
}

/**
 * Stores the browser push subscription for one appointment. The Edge Function
 * enforces its own rules (demo tenants, bookings under 24h away, rate limits);
 * its Russian message reaches the caller through functionError, so the page
 * shows the real reason instead of the generic "non-2xx status code".
 */
export async function storePushSubscription(business: BusinessConfig, appointmentId: string, accessToken: string, subscription: PushSubscriptionJSON): Promise<void> {
  const {error} = await requireSupabase().functions.invoke('push-subscribe', {
    body: {slug: business.slug, appointmentId, accessToken, subscription},
  });
  if (error) await functionError('', 'Не удалось включить напоминание. Попробуйте ещё раз позже.', error);
}

/**
 * Internal auth domain for username-only owner logins. The browser NEVER sees
 * a service-role key: login is a plain signInWithPassword against the
 * synthetic address <username>@owners.local created (email-confirmed) by the
 * admin panel. Must stay in sync with OWNER_AUTH_DOMAIN in
 * supabase/functions/admin-api/index.ts.
 */
export const OWNER_AUTH_DOMAIN = 'owners.local';

export function ownerEmailFor(username: string): string {
  return `${username.trim().toLowerCase()}@${OWNER_AUTH_DOMAIN}`;
}

export async function signInOwner(identifier: string, password: string, slug?: string) {
  const client = requireSupabase();
  const clean = identifier.trim();
  // Legacy identifiers containing '@' are treated as raw auth emails (lets
  // pre-migration accounts keep working until an admin resets them).
  const email = clean.includes('@') ? clean : ownerEmailFor(clean);
  const {data, error} = await client.auth.signInWithPassword({email, password});
  if (error) throw new Error('Неверный логин или пароль.');
  // When signing in from a studio page, confirm the account actually belongs
  // to this studio; otherwise sign out so no foreign session lingers.
  if (slug) {
    const {data: tenant, error: tenantError} = await client.from('tenants')
      .select('id').eq('slug', slug).maybeSingle();
    if (tenantError || !tenant) {
      await client.auth.signOut();
      throw new Error('Студия не найдена.');
    }
    const {data: membership, error: memberError} = await client.from('tenant_memberships')
      .select('user_id').eq('tenant_id', (tenant as {id: string}).id).eq('user_id', data.user.id).maybeSingle();
    if (memberError || !membership) {
      await client.auth.signOut();
      throw new Error('У этой учётной записи нет доступа к студии.');
    }
  }
  return data.user;
}

export async function signOutOwner() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** Full financial context of one appointment for the owner dashboard. */
export interface OwnerOrder {
  extras: OrderLine[];
  notes: OrderNote[];
  payments: OrderPayment[];
}

export type OwnerSchedule = Awaited<ReturnType<typeof loadOwnerSchedule>>;

/** Keep line items and notes in history order regardless of fetch order. */
export function normalizeOwnerOrder(order: OwnerOrder): OwnerOrder {
  return {
    extras: [...order.extras].sort(byCreatedAt),
    notes: [...order.notes].sort(byCreatedAt),
    payments: [...order.payments].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
  };
}

export async function loadOwnerSchedule(business: BusinessConfig, from: Date, to: Date) {
  const client = requireSupabase();
  const [{data: rows, error}, {data: metricRows, error: metricError}] = await Promise.all([
    client.from('appointments').select('id,tenant_id,service_id,resource_id,customer_name,customer_phone,vehicle,starts_at,ends_at,status,price_minor,customer_note').eq('tenant_id', business.id!).gte('starts_at', from.toISOString()).lt('starts_at', to.toISOString()).order('starts_at'),
    client.rpc('owner_metrics', {p_tenant_id: business.id, p_from: from.toISOString(), p_to: to.toISOString()}),
  ]);
  if (error || metricError) throw new Error(error?.message ?? metricError?.message ?? 'Не удалось загрузить расписание.');
  const appointments = (rows ?? []).map((row) => {
    const service = business.services.find((item) => item.id === row.service_id);
    const resource = business.resources.find((item) => item.id === row.resource_id);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      serviceSlug: service?.slug ?? '',
      serviceName: service?.name ?? 'Услуга',
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      vehicle: row.vehicle,
      status: row.status,
      priceMinor: row.price_minor,
      customerNote: row.customer_note ?? '',
      resourceLabel: resource?.name,
    } satisfies Appointment;
  });
  const metrics = (Array.isArray(metricRows) ? metricRows[0] : metricRows) as {arrivals: number; completed: number; collected_minor: number} | null;
  // Full order context for the visible appointments: extra service lines,
  // owner notes and the payment/refund history (RLS scopes all three to
  // this tenant's members).
  const appointmentIds = appointments.map((appointment) => appointment.id);
  const orders: Record<string, OwnerOrder> = {};
  for (const appointment of appointments) orders[appointment.id] = {extras: [], notes: [], payments: []};
  if (appointmentIds.length > 0) {
    const [extrasResult, notesResult, paymentsResult] = await Promise.all([
      client.from('appointment_services').select('id,appointment_id,service_id,name,price_minor,kind,created_at').eq('tenant_id', business.id!).in('appointment_id', appointmentIds).order('created_at'),
      client.from('appointment_notes').select('id,appointment_id,body,created_at').eq('tenant_id', business.id!).in('appointment_id', appointmentIds).order('created_at'),
      client.from('payments').select('id,appointment_id,kind,amount_minor,method,note,received_at').eq('tenant_id', business.id!).in('appointment_id', appointmentIds).order('received_at'),
    ]);
    if (extrasResult.error || notesResult.error || paymentsResult.error) {
      throw new Error(extrasResult.error?.message ?? notesResult.error?.message ?? paymentsResult.error?.message ?? 'Не удалось загрузить детали заказов.');
    }
    for (const row of extrasResult.data ?? []) {
      const line: OrderLine = {
        id: row.id, serviceId: row.service_id, name: row.name, priceMinor: row.price_minor,
        kind: (row.kind === 'custom' ? 'custom' : 'extra') as OrderLineKind, createdAt: row.created_at,
      };
      orders[row.appointment_id]?.extras.push(line);
    }
    for (const row of notesResult.data ?? []) {
      const note: OrderNote = {id: row.id, body: row.body, createdAt: row.created_at};
      orders[row.appointment_id]?.notes.push(note);
    }
    for (const row of paymentsResult.data ?? []) {
      const payment: OrderPayment = {
        id: row.id, kind: row.kind === 'refund' ? 'refund' : 'charge', amountMinor: row.amount_minor,
        method: row.method, note: row.note ?? '', receivedAt: row.received_at,
      };
      orders[row.appointment_id]?.payments.push(payment);
    }
  }
  return {
    appointments,
    orders,
    metrics: {arrivals: metrics?.arrivals ?? 0, completed: metrics?.completed ?? 0, collectedMinor: metrics?.collected_minor ?? 0} satisfies OwnerMetrics,
  };
}

export async function ownerAction(business: BusinessConfig, action: string, payload: Record<string, unknown>) {
  const {data, error} = await requireSupabase().functions.invoke('owner-api', {body: {slug: business.slug, action, ...payload}});
  if (error) await functionError('', 'Не удалось сохранить изменение.', error);
  if (data && typeof data === 'object' && 'error' in data && typeof (data as {error: unknown}).error === 'string') {
    throw new Error((data as {error: string}).error);
  }
  return data;
}

export async function sendAssistantMessage(input: {business: BusinessConfig; audience: 'client' | 'owner'; message: string; date?: string}) {
  if (!hasSupabaseConfig) throw new Error('Помощник сейчас недоступен. Для работы помощника нужен Supabase.');
  const {data, error} = await requireSupabase().functions.invoke('assistant', {
    body: {slug: input.business.slug, audience: input.audience, message: input.message, date: input.date},
  });
  if (error) throw new Error(error.message || 'Помощник сейчас недоступен.');
  return data?.answer as string;
}

export async function updateTenantProfile(business: BusinessConfig, updates: Partial<BusinessConfig>) {
  const {data, error} = await requireSupabase().functions.invoke('owner-api', {
    body: {slug: business.slug, action: 'update-profile', profile: updates},
  });
  if (error) throw new Error(error.message || 'Не удалось сохранить настройки.');
  return data;
}

export function getDefaultBookingDate(business: BusinessConfig) {
  return formatInTimeZone(new Date(), business.timezone, 'yyyy-MM-dd');
}
