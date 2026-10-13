import {formatInTimeZone} from 'date-fns-tz';
import {businessSchema, type Appointment, type AvailabilitySlot, type BusinessConfig, type OwnerMetrics, type Service} from '@/domain/tenant';
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

export async function loadAvailability(business: BusinessConfig, service: Service, day: string): Promise<AvailabilitySlot[]> {
  const {data, error} = await requireSupabase().functions.invoke('get-slots', {body: {slug: business.slug, serviceSlug: service.slug, day}});
  if (error) throw new Error(`Не удалось проверить свободное время: ${error.message}`);
  return (data?.slots ?? []) as AvailabilitySlot[];
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
  if (error) throw new Error(error.message || 'Не удалось оформить запись.');
  return data as {appointment: Appointment; accessToken: string};
}

export async function loadAppointmentAccess(business: BusinessConfig, appointmentId: string, accessToken: string) {
  const {data, error} = await requireSupabase().functions.invoke('appointment-access', {body: {slug: business.slug, appointmentId, accessToken}});
  if (error) throw new Error(error.message || 'Не удалось загрузить запись.');
  return data?.appointment as Appointment;
}

export async function cancelAppointment(business: BusinessConfig, appointmentId: string, accessToken: string) {
  const {data, error} = await requireSupabase().functions.invoke('cancel-appointment', {body: {slug: business.slug, appointmentId, accessToken}});
  if (error) throw new Error(error.message || 'Не удалось отменить запись.');
  return data as {cancelled: boolean};
}

export async function signInOwner(identifier: string, password: string) {
  const client = requireSupabase();
  const {data: membership, error: lookupError} = await client.from('tenant_memberships')
    .select('user_id, username')
    .eq('username', identifier.toLowerCase())
    .single();
  if (lookupError || !membership) {
    throw new Error('Имя пользователя не найдено.');
  }
  const userId = membership.user_id;
  const {data: authUser, error: userError} = await client.auth.admin.getUserById(userId);
  if (userError || !authUser?.user?.email) {
    throw new Error('Не удалось найти email пользователя.');
  }
  const {data, error} = await client.auth.signInWithPassword({email: authUser.user.email, password});
  if (error) throw new Error(error.message);
  return data.user;
}

export async function signOutOwner() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function loadOwnerSchedule(business: BusinessConfig, from: Date, to: Date) {
  const client = requireSupabase();
  const [{data: rows, error}, {data: metricRows, error: metricError}] = await Promise.all([
    client.from('appointments').select('id,tenant_id,service_id,resource_id,customer_name,customer_phone,vehicle,starts_at,ends_at,status,price_minor').eq('tenant_id', business.id!).gte('starts_at', from.toISOString()).lt('starts_at', to.toISOString()).order('starts_at'),
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
      resourceLabel: resource?.name,
    } satisfies Appointment;
  });
  const metrics = (Array.isArray(metricRows) ? metricRows[0] : metricRows) as {arrivals: number; completed: number; collected_minor: number} | null;
  return {appointments, metrics: {arrivals: metrics?.arrivals ?? 0, completed: metrics?.completed ?? 0, collectedMinor: metrics?.collected_minor ?? 0} satisfies OwnerMetrics};
}

export async function ownerAction(business: BusinessConfig, action: string, payload: Record<string, unknown>) {
  const {data, error} = await requireSupabase().functions.invoke('owner-api', {body: {slug: business.slug, action, ...payload}});
  if (error) throw new Error(error.message || 'Не удалось сохранить изменение.');
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
