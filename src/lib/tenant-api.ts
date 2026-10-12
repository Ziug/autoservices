import {addDays, format} from 'date-fns';
import {formatInTimeZone, fromZonedTime} from 'date-fns-tz';
import {businessSchema, type Appointment, type AvailabilitySlot, type BusinessConfig, type OwnerMetrics, type Service} from '@/domain/tenant';
import {createDemoAppointment, getDemoSlots, ownerDemoData, readDemoAppointments, readDemoBusinessOverrides, updateDemoDateOverride, updateDemoPayment, updateDemoProfile, updateDemoResources, updateDemoServices, updateDemoAppointment} from '@/lib/local-demo';
import {hasSupabaseConfig, supabase} from '@/lib/supabase';

function requireSupabase() {
  if (!supabase) throw new Error('Подключите Supabase в .env.local, чтобы включить рабочую базу и кабинет владельца.');
  return supabase;
}

async function loadLocalBusiness(slug: string, options: {includeInactive?: boolean} = {}): Promise<BusinessConfig> {
  const response = await fetch(`/tenants/${encodeURIComponent(slug)}/business.json`, {headers: {'Cache-Control': 'no-cache'}});
  if (!response.ok) throw new Error(response.status === 404 ? 'Студия не найдена.' : 'Не удалось загрузить демо-настройки.');
  const source = businessSchema.parse(await response.json());
  if (source.status === 'draft') throw new Error('Эта студия ещё не подготовлена для предварительного просмотра.');
  const overrides = readDemoBusinessOverrides(slug);
  const merged: BusinessConfig = {...source, ...overrides.profile, services: overrides.services ?? source.services, resources: overrides.resources ?? source.resources};
  if (!options.includeInactive) {
    merged.services = merged.services.filter((service) => service.active);
    merged.resources = merged.resources.filter((resource) => resource.active !== false);
  }
  return businessSchema.parse(merged);
}

export async function loadBusiness(slug: string, options: {includeInactive?: boolean} = {}): Promise<BusinessConfig> {
  if (hasSupabaseConfig && supabase) {
    try {
      const local = await loadLocalBusiness(slug, {includeInactive: true});
      if (local.demo) {
        if (options.includeInactive) return local;
        return businessSchema.parse({...local, services: local.services.filter((service) => service.active), resources: local.resources.filter((resource) => resource.active !== false)});
      }
    } catch {
      // Live profiles come from Supabase; a missing local demo file is expected there.
    }
    const {data: tenant, error} = await supabase.from('tenants').select('*').eq('slug', slug).in('status', ['preview', 'live']).maybeSingle();
    if (error) throw new Error(`Не удалось загрузить студию: ${error.message}`);
    if (!tenant) throw new Error('Студия не найдена или ещё не опубликована.');
    const [{data: serviceRows, error: serviceError}, {data: resourceRows, error: resourceError}] = await Promise.all([
      supabase.from('services').select('*').eq('tenant_id', tenant.id).order('created_at'),
      supabase.from('resources').select('*').eq('tenant_id', tenant.id).order('created_at'),
    ]);
    if (serviceError || resourceError) throw new Error(serviceError?.message ?? resourceError?.message ?? 'Не удалось загрузить услуги и посты.');
    return businessSchema.parse({
      id: tenant.id,
      schemaVersion: 1,
      slug: tenant.slug,
      name: tenant.name,
      tagline: tenant.tagline,
      description: tenant.description,
      city: tenant.city,
      address: tenant.address,
      phone: tenant.phone,
      mapUrl: tenant.map_url,
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

  return loadLocalBusiness(slug, options);
}

export async function loadAvailability(business: BusinessConfig, service: Service, day: string): Promise<AvailabilitySlot[]> {
  if (business.demo || !hasSupabaseConfig) return getDemoSlots(business, service, day);
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
  if (input.business.demo || !hasSupabaseConfig) return createDemoAppointment(input);
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
  if (business.demo || !hasSupabaseConfig) {
    const appointment = readDemoAppointments(business.slug).find((item) => item.id === appointmentId && item.accessToken === accessToken);
    if (!appointment) throw new Error('Ссылка на запись недействительна.');
    return appointment;
  }
  const {data, error} = await requireSupabase().functions.invoke('appointment-access', {body: {slug: business.slug, appointmentId, accessToken}});
  if (error) throw new Error(error.message || 'Не удалось загрузить запись.');
  return data?.appointment as Appointment;
}

export async function cancelAppointment(business: BusinessConfig, appointmentId: string, accessToken: string) {
  if (business.demo || !hasSupabaseConfig) {
    updateDemoAppointment(business.slug, appointmentId, {status: 'cancelled'});
    return {cancelled: true};
  }
  const {data, error} = await requireSupabase().functions.invoke('cancel-appointment', {body: {slug: business.slug, appointmentId, accessToken}});
  if (error) throw new Error(error.message || 'Не удалось отменить запись.');
  return data as {cancelled: boolean};
}

export async function signInOwner(email: string, password: string) {
  const client = requireSupabase();
  const {data, error} = await client.auth.signInWithPassword({email, password});
  if (error) throw new Error(error.message);
  return data.user;
}

export async function signOutOwner() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function loadOwnerSchedule(business: BusinessConfig, from: Date, to: Date) {
  if (business.demo || !hasSupabaseConfig) return ownerDemoData(business, from, to);
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
  if (business.demo || !hasSupabaseConfig) {
    if (action === 'set-status' && typeof payload.appointmentId === 'string' && typeof payload.status === 'string') {
      updateDemoAppointment(business.slug, payload.appointmentId, {status: payload.status as Appointment['status']});
      return {ok: true};
    }
    if (action === 'move' && typeof payload.appointmentId === 'string' && typeof payload.startsAt === 'string') {
      updateDemoAppointment(business.slug, payload.appointmentId, {startsAt: payload.startsAt});
      return {ok: true};
    }
    if (action === 'cancel' && typeof payload.appointmentId === 'string') {
      updateDemoAppointment(business.slug, payload.appointmentId, {status: 'cancelled'});
      return {ok: true};
    }
    if (action === 'add-payment' && typeof payload.appointmentId === 'string' && typeof payload.amountMinor === 'number') {
      updateDemoPayment(business.slug, payload.appointmentId, payload.amountMinor, payload.kind === 'refund' ? 'refund' : 'charge');
      return {ok: true, demo: true};
    }
    if (action === 'add-booking') {
      const service = business.services.find((item) => item.slug === payload.serviceSlug);
      if (!service || typeof payload.startsAt !== 'string' || typeof payload.customerName !== 'string' || typeof payload.customerPhone !== 'string' || typeof payload.vehicle !== 'string' || typeof payload.idempotencyKey !== 'string') {
        throw new Error('Проверьте поля новой записи.');
      }
      return createDemoAppointment({business, service, startsAt: payload.startsAt, customerName: payload.customerName, customerPhone: payload.customerPhone, vehicle: payload.vehicle, idempotencyKey: payload.idempotencyKey});
    }
    if (action === 'update-profile' && payload.profile && typeof payload.profile === 'object') {
      updateDemoProfile(business.slug, payload.profile as Partial<BusinessConfig>);
      return {ok: true, demo: true};
    }
    if (action === 'save-service' && payload.service && typeof payload.service === 'object') {
      const service = payload.service as Service;
      const services = business.services.filter((item) => item.slug !== service.slug);
      services.push(service);
      updateDemoServices(business.slug, services);
      return {ok: true, demo: true};
    }
    if (action === 'save-resource' && payload.resource && typeof payload.resource === 'object') {
      const resource = payload.resource as BusinessConfig['resources'][number];
      const resources = business.resources.filter((item) => item.slug !== resource.slug);
      resources.push(resource);
      updateDemoResources(business.slug, resources);
      return {ok: true, demo: true};
    }
    if (action === 'save-date-override' && payload.override && typeof payload.override === 'object') {
      const override = payload.override as {localDate: string; isClosed: boolean; opensAt: string | null; closesAt: string | null; label: string};
      updateDemoDateOverride(business.slug, override.localDate, override);
      return {ok: true, demo: true};
    }
    throw new Error('Действие недоступно в демо-режиме.');
  }
  const {data, error} = await requireSupabase().functions.invoke('owner-api', {body: {slug: business.slug, action, ...payload}});
  if (error) throw new Error(error.message || 'Не удалось сохранить изменение.');
  return data;
}

export async function sendAssistantMessage(input: {business: BusinessConfig; audience: 'client' | 'owner'; message: string; date?: string}) {
  if (hasSupabaseConfig && !input.business.demo) {
    const {data, error} = await requireSupabase().functions.invoke('assistant', {
      body: {slug: input.business.slug, audience: input.audience, message: input.message, date: input.date},
    });
    if (error) throw new Error(error.message || 'Помощник сейчас недоступен.');
    return data?.answer as string;
  }
  const prompt = input.message.toLocaleLowerCase(input.business.locale);
  if (input.audience === 'owner') {
    const today = formatInTimeZone(new Date(), input.business.timezone, 'yyyy-MM-dd');
    if (/недел|week|машин|оплат|денег|доход|выручк/.test(prompt)) {
      const date = new Date(`${today}T12:00:00Z`);
      const weekStart = addDays(date, -((date.getUTCDay() + 6) % 7));
      const weekEnd = addDays(weekStart, 7);
      const {metrics} = ownerDemoData(input.business, fromZonedTime(`${format(weekStart, 'yyyy-MM-dd')}T00:00:00`, input.business.timezone), fromZonedTime(`${format(weekEnd, 'yyyy-MM-dd')}T00:00:00`, input.business.timezone));
      return `За эту неделю: ${metrics.arrivals} заездов, ${metrics.completed} завершённых работ и ${new Intl.NumberFormat(input.business.locale, {style: 'currency', currency: input.business.currency, maximumFractionDigits: 0}).format(metrics.collectedMinor / 100)} полученных оплат. Это демо-данные только этого браузера.`;
    }
    const tomorrowKey = format(addDays(new Date(`${today}T12:00:00Z`), 1), 'yyyy-MM-dd');
    const tomorrowStart = fromZonedTime(`${tomorrowKey}T00:00:00`, input.business.timezone);
    const tomorrowEnd = fromZonedTime(`${format(addDays(new Date(`${tomorrowKey}T12:00:00Z`), 1), 'yyyy-MM-dd')}T00:00:00`, input.business.timezone);
    const {appointments} = ownerDemoData(input.business, tomorrowStart, tomorrowEnd);
    return appointments.length ? `На завтра ${appointments.length} ${appointments.length === 1 ? 'заезд' : 'заезда'}. Ближайший — ${new Intl.DateTimeFormat('ru-RU', {timeZone: input.business.timezone, hour: '2-digit', minute: '2-digit'}).format(new Date(appointments[0].startsAt))}.` : 'На завтра пока нет заездов.';
  }
  if (/адрес|найти|где|location|address/.test(prompt)) return `${input.business.address}, ${input.business.city}. ${input.business.mapUrl}`;
  const service = input.business.services.find((item) => prompt.includes(item.name.toLocaleLowerCase(input.business.locale)) || item.name.toLocaleLowerCase(input.business.locale).split(/\s+/).some((word) => word.length > 4 && prompt.includes(word)));
  if (/цен|стоим|сколько|price|cost/.test(prompt) && service) return `${service.name}: ${new Intl.NumberFormat(input.business.locale, {style: 'currency', currency: input.business.currency, maximumFractionDigits: 0}).format(service.priceMinor / 100)}. Продолжительность — ${service.durationMinutes >= 1440 ? `${Math.round(service.durationMinutes / 1440)} дн.` : `${Math.round(service.durationMinutes / 60)} ч.`}.`;
  if (/окн|свобод|ближай|when|available/.test(prompt)) {
    const startDate = input.date ?? format(new Date(), 'yyyy-MM-dd');
    const dates = [0, 1, 2, 3, 4, 5, 6].map((offset) => format(addDays(new Date(`${startDate}T12:00:00`), offset), 'yyyy-MM-dd'));
    const slots = dates.flatMap((day) => input.business.services.flatMap((candidate) => getDemoSlots(input.business, candidate, day).filter((slot) => slot.availableCount > 0).map((slot) => ({day, slot, candidate}))));
    const next = slots[0];
    if (!next) return 'На ближайшую неделю свободных окон нет. Попробуйте выбрать другой период или напишите студии.';
    return `Ближайшее окно: ${next.day} в ${new Intl.DateTimeFormat(input.business.locale, {timeZone: input.business.timezone, hour: '2-digit', minute: '2-digit'}).format(new Date(next.slot.startsAt))} — ${next.candidate.name}. Это доступность демо-данных в этом браузере.`;
  }
  return `Могу подсказать стоимость услуги, ближайшее свободное время и адрес студии. Например: «Сколько стоит ${input.business.services[0]?.name.toLocaleLowerCase(input.business.locale)}?»`;
}

export async function updateTenantProfile(business: BusinessConfig, updates: Partial<BusinessConfig>) {
  if (business.demo || !hasSupabaseConfig) {
    updateDemoProfile(business.slug, updates);
    return {ok: true, demo: true};
  }
  const {data, error} = await requireSupabase().functions.invoke('owner-api', {
    body: {slug: business.slug, action: 'update-profile', profile: updates},
  });
  if (error) throw new Error(error.message || 'Не удалось сохранить настройки.');
  return data;
}

export function getDefaultBookingDate(business: BusinessConfig) {
  return formatInTimeZone(new Date(), business.timezone, 'yyyy-MM-dd');
}
