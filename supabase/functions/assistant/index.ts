import OpenAI from 'npm:openai@7.32.0';
import {z} from 'npm:zod@4.6.6';
import {adminClient, checkRateLimit, errorMessage, forbiddenOrigin, json, preflight, requireMembership, tenantBySlug, userFromRequest} from '../_shared/http.ts';
import {canUseOwnerAssistant, routeClientQuestion, routeOwnerQuestion} from './router.ts';
import {buildBookingMessages, buildLlmMessages, mergeBookingDraft, missingBookingFields, parseBookingIntent, type BookingDraft, type StudioScope} from './prompt.ts';
import {createBooking, localTimeToUtc, looksLikeBookingRequest, normalizeDraft, utcToLocalTime} from './booking.ts';

const inputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  audience: z.enum(['client', 'owner']),
  message: z.string().trim().min(1).max(500),
  date: z.iso.date().optional(),
  messageCount: z.number().int().min(0).max(10_000).optional(),
  bookingDraft: z.unknown().optional(),
  idempotencyKey: z.uuid().optional(),
}).strict();

type FactSet = {kind: string; facts: Record<string, unknown>};

function localDay(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dateRange(day: string, timezone: string) {
  const [year, month, date] = day.split('-').map(Number);
  const localMidnightAsUtc = (dayNumber: number) => {
    const utcTarget = Date.UTC(year, month - 1, dayNumber);
    let instant = utcTarget;
    const formatter = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = formatter.formatToParts(new Date(instant));
      const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
      const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
      instant += utcTarget - localAsUtc;
    }
    return new Date(instant);
  };
  const nextDate = new Date(Date.UTC(year, month - 1, date + 1));
  const nextDayNumber = nextDate.getUTCDate();
  const nextMonth = nextDate.getUTCMonth();
  const nextYear = nextDate.getUTCFullYear();
  const start = localMidnightAsUtc(date);
  const endTarget = Date.UTC(nextYear, nextMonth, nextDayNumber);
  let end = new Date(endTarget);
  const formatter = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = formatter.formatToParts(end);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    end = new Date(end.getTime() + endTarget - localAsUtc);
  }
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    startDay: day,
    nextDay: `${String(nextYear).padStart(4, '0')}-${String(nextMonth + 1).padStart(2, '0')}-${String(nextDayNumber).padStart(2, '0')}`,
  };
}

function minuteLabel(iso: string, timezone: string) {
  return new Intl.DateTimeFormat('ru-RU', {timeZone: timezone, dateStyle: 'medium', timeStyle: 'short'}).format(new Date(iso));
}

function serviceForMessage(message: string, services: Array<{slug: string; name: string}>) {
  const query = message.toLocaleLowerCase('ru-RU');
  return services.find((service) => query.includes(service.name.toLocaleLowerCase('ru-RU')))
    ?? services.find((service) => service.name.toLocaleLowerCase('ru-RU').split(/\s+/).some((word) => word.length > 4 && query.includes(word)));
}

async function clientFacts(admin: ReturnType<typeof adminClient>, tenant: Record<string, any>, message: string, requestedDay?: string): Promise<FactSet> {
  const {data: services, error} = await admin.from('services')
    .select('slug,name,description,price_minor,duration_minutes,active')
    .eq('tenant_id', tenant.id).eq('active', true).order('name');
  if (error) throw error;
  const route = routeClientQuestion(message);
  if (route === 'location') {
    return {kind: 'location', facts: {address: tenant.address, city: tenant.city, mapUrl: tenant.map_url, phone: tenant.phone}};
  }
  if (route === 'prices') {
    const matched = serviceForMessage(message, services ?? []);
    return {kind: 'prices', facts: {currency: tenant.currency, services: matched ? services?.filter((service) => service.slug === matched.slug) : services}};
  }
  if (route === 'availability') {
    const service = serviceForMessage(message, services ?? []);
    if (!service) return {kind: 'clarify-service', facts: {services: (services ?? []).map((item) => item.name)}};
    const baseDay = requestedDay ?? localDay(new Date(), tenant.timezone);
    const rows: Array<{starts_at: string; available_count: number}> = [];
    for (let offset = 0; offset < 14; offset += 1) {
      const target = new Date(`${baseDay}T12:00:00Z`);
      target.setUTCDate(target.getUTCDate() + offset);
      const day = target.toISOString().slice(0, 10);
      const {data: slots, error: slotsError} = await admin.rpc('public_booking_slots', {p_slug: tenant.slug, p_service_slug: service.slug, p_local_day: day});
      if (slotsError) throw slotsError;
      rows.push(...(slots ?? []).filter((slot: {available_count: number}) => slot.available_count > 0).map((slot: {starts_at: string; available_count: number}) => ({starts_at: slot.starts_at, available_count: slot.available_count})));
      if (rows.length >= 8) break;
    }
    return {kind: 'availability', facts: {service: service.name, timezone: tenant.timezone, slots: rows.slice(0, 8).map((slot) => ({time: minuteLabel(slot.starts_at, tenant.timezone), availablePosts: slot.available_count}))}};
  }
  if (route === 'services') {
    return {kind: 'services', facts: {services: services?.map((service) => ({name: service.name, description: service.description, priceMinor: service.price_minor, durationMinutes: service.duration_minutes})), currency: tenant.currency}};
  }
  return {kind: 'clarify', facts: {topics: ['услуги и цены', 'свободное время', 'адрес и контакты']}};
}

async function ownerFacts(admin: ReturnType<typeof adminClient>, tenant: Record<string, any>, message: string, requestedDay?: string): Promise<FactSet> {
  const today = localDay(new Date(), tenant.timezone);
  const route = routeOwnerQuestion(message, requestedDay, today);
  const targetDate = route.date;
  const range = dateRange(targetDate, tenant.timezone);
  if (route.kind === 'weekly-metrics') {
    const weekDay = new Date(`${targetDate}T12:00:00Z`).getUTCDay();
    const weekStart = new Date(`${targetDate}T12:00:00Z`);
    weekStart.setUTCDate(weekStart.getUTCDate() - ((weekDay + 6) % 7));
    const weekKey = weekStart.toISOString().slice(0, 10);
    const weekRange = dateRange(weekKey, tenant.timezone);
    const {data, error} = await admin.rpc('owner_metrics_for_edge', {p_tenant_id: tenant.id, p_from: weekRange.from, p_to: weekRange.to});
    if (error) throw error;
    const metrics = Array.isArray(data) ? data[0] : data;
    return {kind: 'weekly-metrics', facts: {from: weekKey, to: weekRange.nextDay, arrivals: metrics?.arrivals ?? 0, completed: metrics?.completed ?? 0, collectedMinor: metrics?.collected_minor ?? 0, currency: tenant.currency}};
  }
  const {data, error} = await admin.from('appointments')
    .select('id,customer_name,customer_phone,vehicle,starts_at,ends_at,status,price_minor,service_id')
    .eq('tenant_id', tenant.id).gte('starts_at', range.from).lt('starts_at', range.to)
    .neq('status', 'cancelled').order('starts_at');
  if (error) throw error;
  const serviceIds = [...new Set((data ?? []).map((row) => row.service_id))];
  const {data: services, error: serviceError} = serviceIds.length
    ? await admin.from('services').select('id,name').eq('tenant_id', tenant.id).in('id', serviceIds)
    : {data: [], error: null};
  if (serviceError) throw serviceError;
  const serviceMap = new Map((services ?? []).map((service) => [service.id, service.name]));
  return {kind: 'owner-schedule', facts: {date: targetDate, appointments: (data ?? []).map((appointment) => ({
    time: minuteLabel(appointment.starts_at, tenant.timezone),
    customer: appointment.customer_name, vehicle: appointment.vehicle,
    service: serviceMap.get(appointment.service_id) ?? 'Услуга',
    status: appointment.status, priceMinor: appointment.price_minor,
  }))}};
}

function deterministicAnswer(facts: FactSet, currency: string) {
  if (facts.kind === 'location') {
    const value = facts.facts;
    return `${value.address}, ${value.city}. Маршрут: ${value.mapUrl}. Телефон: ${value.phone}.`;
  }
  if (facts.kind === 'prices' || facts.kind === 'services') {
    const services = facts.facts.services as Array<{name: string; description?: string; price_minor?: number; priceMinor?: number; duration_minutes?: number; durationMinutes?: number}> | undefined;
    if (!services?.length) return 'У этой студии пока нет опубликованных услуг.';
    return services.map((service) => {
      const price = service.price_minor ?? service.priceMinor ?? 0;
      const duration = service.duration_minutes ?? service.durationMinutes ?? 0;
      return `${service.name}: ${new Intl.NumberFormat('ru-RU', {style: 'currency', currency, maximumFractionDigits: 0}).format(price / 100)}${duration ? `, ${duration} мин.` : ''}${service.description ? `. ${service.description}` : ''}`;
    }).join('\n');
  }
  if (facts.kind === 'clarify-service') return `Для какой услуги посмотреть свободное время? Доступны: ${(facts.facts.services as string[]).join(', ')}.`;
  if (facts.kind === 'availability') {
    const slots = facts.facts.slots as Array<{time: string; availablePosts: number}>;
    if (!slots.length) return `В ближайшие две недели нет свободных окон на услугу «${facts.facts.service}».`;
    return `Ближайшие окна на услугу «${facts.facts.service}»: ${slots.map((slot) => `${slot.time} (свободных постов: ${slot.availablePosts})`).join('; ')}.`;
  }
  if (facts.kind === 'weekly-metrics') {
    return `За период ${facts.facts.from}–${facts.facts.to}: заездов — ${facts.facts.arrivals}, завершено — ${facts.facts.completed}, чистые поступления — ${new Intl.NumberFormat('ru-RU', {style: 'currency', currency, maximumFractionDigits: 0}).format(Number(facts.facts.collectedMinor) / 100)}.`;
  }
  if (facts.kind === 'owner-schedule') {
    const appointments = facts.facts.appointments as Array<{time: string; customer: string; vehicle: string; service: string; status: string}>;
    return appointments.length
      ? `Записи на ${facts.facts.date}:\n${appointments.map((appointment) => `${appointment.time} — ${appointment.customer}, ${appointment.vehicle}, ${appointment.service} (${appointment.status})`).join('\n')}`
      : `На ${facts.facts.date} записей нет.`;
  }
  return 'Уточните, пожалуйста: вас интересуют услуги и цены, свободное время или адрес?';
}

function llmRates() {
  const positiveInteger = (name: string, fallbackValue: number, hardMaximum: number) => {
    const value = Number(Deno.env.get(name) ?? fallbackValue);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, hardMaximum) : fallbackValue;
  };
  const inputRate = positiveInteger('LLM_INPUT_MICRO_USD_PER_1K_TOKENS', 20_000, 1_000_000);
  const outputRate = positiveInteger('LLM_OUTPUT_MICRO_USD_PER_1K_TOKENS', 80_000, 1_000_000);
  const reservedInputTokens = 24_000;
  const reservedOutputTokens = 400;
  return {
    inputRate,
    outputRate,
    reservedInputTokens,
    reservedOutputTokens,
    reserveCostMicros: Math.ceil(reservedInputTokens * inputRate / 1_000) + Math.ceil(reservedOutputTokens * outputRate / 1_000),
    dailyCalls: positiveInteger('LLM_DAILY_CALL_LIMIT', 40, 1_000),
    dailyTokens: positiveInteger('LLM_DAILY_TOKEN_LIMIT', 300_000, 10_000_000),
    dailyCostMicros: positiveInteger('LLM_DAILY_COST_LIMIT_MICRO_USD', 5_000_000, 50_000_000),
  };
}

/** Atomically reserves the daily LLM budget. Returns false when exhausted. */
async function reserveBudget(admin: ReturnType<typeof adminClient>, tenantId: string, day: string): Promise<boolean> {
  const rates = llmRates();
  const reservedTokens = rates.reservedInputTokens + rates.reservedOutputTokens;
  const {data, error} = await admin.rpc('reserve_llm_budget', {
    p_tenant_id: tenantId,
    p_local_day: day,
    p_daily_calls: rates.dailyCalls,
    p_daily_tokens: rates.dailyTokens,
    p_reserved_tokens: reservedTokens,
    p_daily_cost_micros: rates.dailyCostMicros,
    p_reserved_cost_micros: rates.reserveCostMicros,
  });
  if (error) throw error;
  return data === true;
}

/** Records the actual token usage after a completed call. */
async function recordUsage(admin: ReturnType<typeof adminClient>, completion: {usage?: {prompt_tokens: number; completion_tokens: number} | null}, tenantId: string, day: string) {
  const usage = completion.usage;
  if (!usage) return;
  const rates = llmRates();
  const costMicros = Math.ceil(usage.prompt_tokens * rates.inputRate / 1_000) + Math.ceil(usage.completion_tokens * rates.outputRate / 1_000);
  const {error} = await admin.rpc('record_llm_usage', {
    p_tenant_id: tenantId, p_local_day: day,
    p_input_tokens: usage.prompt_tokens, p_output_tokens: usage.completion_tokens, p_cost_micros: costMicros,
  });
  if (error) throw error;
}

async function modelAnswer(admin: ReturnType<typeof adminClient>, facts: FactSet, message: string, tenantId: string, day: string, fallback: string, messageCount: number, studio: StudioScope) {
  const apiKey = Deno.env.get('LLM_API_KEY');
  const model = Deno.env.get('LLM_MODEL');
  if (!apiKey || !model) {
    console.error('[assistant] LLM secrets missing:', !apiKey ? 'LLM_API_KEY' : '', !model ? 'LLM_MODEL' : '');
    return fallback;
  }
  // The studio scope travels with every request so the model can never answer
  // about a tenant other than the one the request was scoped to.
  const factsJson = JSON.stringify({
    studio: {
      id: studio.id,
      slug: studio.slug,
      name: studio.name,
      city: studio.city,
      address: studio.address,
      phone: studio.phone,
      timezone: studio.timezone,
      currency: studio.currency,
    },
    question: message,
    verifiedStudioFacts: facts,
  });
  if (factsJson.length > 12_000) return fallback;
  if (!await reserveBudget(admin, tenantId, day)) return `${fallback}\n\nЛимит помощника на сегодня достигнут.`;

  try {
    const baseURL = Deno.env.get('LLM_BASE_URL');
    const client = new OpenAI({apiKey, ...(baseURL ? {baseURL} : {}), maxRetries: 0, timeout: 6_000});
    // Manual retry with longer timeout — free-tier OpenRouter can be slow
    let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        completion = await client.chat.completions.create({model, temperature: 0, max_tokens: 350, messages: buildLlmMessages(factsJson, message, messageCount)});
        break;
      } catch (retryError) {
        if (attempt === 2) throw retryError;
        console.error(`[assistant] attempt ${attempt} failed, retrying...`);
      }
    }
    await recordUsage(admin, completion!, tenantId, day);
    const choice = completion!.choices[0]?.message;
    // Only `content` may reach the user. `reasoning` is the model's internal
    // chain of thought (often English, often a tool-name hallucination) and
    // must never be surfaced as an answer.
    const answer = (choice?.content ?? '').trim();
    if (!answer) {
      console.error('[assistant] empty content from model, using deterministic fallback');
      return fallback;
    }
    return answer;
  } catch (error) {
    console.error('[assistant] LLM call failed:', error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

/**
 * Booking flow: the model extracts the five fields, the server performs the
 * booking through create_public_booking and returns the access token so the
 * booking lands in the customer's "Моя запись" cabinet.
 */
async function handleBooking(
  admin: ReturnType<typeof adminClient>,
  studio: Record<string, any>,
  input: {message: string; messageCount: number; draft: unknown; idempotencyKey?: string},
): Promise<{answer: string; draft: BookingDraft; booking?: {appointmentId: string; accessToken: string; startsAt: string; endsAt: string; serviceName: string; priceMinor: number}}> {
  const previousDraft = normalizeDraft(input.draft);
  const {data: services, error: servicesError} = await admin.from('services')
    .select('slug,name,price_minor,duration_minutes,active')
    .eq('tenant_id', studio.id).eq('active', true).order('name');
  if (servicesError) throw servicesError;

  const today = localDay(new Date(), studio.timezone);
  const payload = JSON.stringify({
    studio: {
      id: studio.id, slug: studio.slug, name: studio.name, city: studio.city,
      address: studio.address, phone: studio.phone, timezone: studio.timezone, currency: studio.currency,
    },
    today,
    services: (services ?? []).map((service) => ({slug: service.slug, name: service.name, priceMinor: service.price_minor, durationMinutes: service.duration_minutes})),
    draft: previousDraft,
    message: input.message,
  });

  const intent = await bookingIntent(admin, payload, studio.id, today, input.messageCount);
  if (!intent) {
    return {
      answer: 'Сейчас не получается оформить запись через чат. Позвоните в студию или оформите запись через расписание.',
      draft: previousDraft,
    };
  }
  const draft = mergeBookingDraft(previousDraft, intent.booking);
  const missing = missingBookingFields(draft);
  if (missing.length) {
    return {answer: intent.answer || 'Уточните, пожалуйста, детали записи.', draft};
  }
  // The booking window is validated before touching the schedule: a past day
  // or a day beyond the 90-day horizon is rejected with a clear message.
  const dayError = validateBookingDay(draft.day, today);
  if (dayError) {
    return {answer: dayError, draft: {...draft, day: null}};
  }

  // Resolve the target slot. "Любое время" (draft.time === null) resolves to
  // the first free slot of the requested day.
  const service = (services ?? []).find((item) => item.slug === draft.serviceSlug);
  if (!service) {
    return {answer: 'Не нашёл такую услугу. Уточните, какая услуга нужна.', draft: {...draft, serviceSlug: null}};
  }
  const slot = await resolveSlot(admin, studio, draft);
  if (!slot) {
    // A missing slot means either the day is fully booked or the requested
    // time does not exist in the schedule — the two need different wording.
    const dayHasSlots = await dayHasAnySlot(admin, studio, draft);
    return {
      answer: dayHasSlots
        ? 'На это время у студии нет свободного окна. Назовите другое время или выберите «любое время».'
        : 'На этот день свободных окон нет. Выберите другую дату.',
      draft,
    };
  }

  const result = await createBooking(admin, {
    slug: studio.slug,
    tenantId: studio.id,
    timezone: studio.timezone,
    serviceSlug: service.slug,
    startsAt: slot,
    customerName: draft.customerName,
    customerPhone: draft.customerPhone,
    vehicle: draft.vehicle,
    idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
  });
  if (result.status !== 'created') {
    return {answer: result.message, draft};
  }
  return {
    answer: `${intent.answer || 'Записал вас.'}`.trim(),
    draft,
    booking: {
      appointmentId: result.appointment.id,
      accessToken: result.accessToken,
      startsAt: result.appointment.startsAt,
      endsAt: result.appointment.endsAt,
      serviceName: service.name,
      priceMinor: result.appointment.priceMinor,
    },
  };
}

/** Runs the booking-intent model call and parses its JSON reply. */
async function bookingIntent(admin: ReturnType<typeof adminClient>, payload: string, tenantId: string, day: string, messageCount: number) {
  const apiKey = Deno.env.get('LLM_API_KEY');
  const model = Deno.env.get('LLM_MODEL');
  if (!apiKey || !model) return null;
  if (!await reserveBudget(admin, tenantId, day)) return null;
  try {
    const baseURL = Deno.env.get('LLM_BASE_URL');
    const client = new OpenAI({apiKey, ...(baseURL ? {baseURL} : {}), maxRetries: 0, timeout: 6_000});
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 400,
      messages: buildBookingMessages(payload, messageCount),
    });
    await recordUsage(admin, completion, tenantId, day);
    const content = (completion.choices[0]?.message?.content ?? '').trim();
    if (!content) {
      console.error('[assistant] booking intent: empty content');
      return null;
    }
    return parseBookingIntent(content);
  } catch (error) {
    console.error('[assistant] booking intent failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Finds the concrete slot to book. A specific time must exist in the studio
 * schedule; "any time" resolves to the first slot with free capacity.
 */
async function resolveSlot(admin: ReturnType<typeof adminClient>, studio: Record<string, any>, draft: BookingDraft): Promise<Date | null> {
  if (!draft.day) return null;
  const {data: slots, error} = await admin.rpc('public_booking_slots', {
    p_slug: studio.slug, p_service_slug: draft.serviceSlug, p_local_day: draft.day,
  });
  if (error) throw error;
  const available = (slots ?? []).filter((slot: {available_count: number}) => slot.available_count > 0);
  if (!available.length) return null;
  if (draft.time) {
    const wanted = normalizeTime(draft.time);
    const match = available.find((slot: {starts_at: string}) => utcToLocalTime(slot.starts_at, studio.timezone) === wanted);
    if (!match) return null;
    return new Date(match.starts_at);
  }
  return new Date(available[0].starts_at);
}

/** True when the requested day has any free slot, regardless of the time. */
async function dayHasAnySlot(admin: ReturnType<typeof adminClient>, studio: Record<string, any>, draft: BookingDraft): Promise<boolean> {
  if (!draft.day) return false;
  const {data: slots, error} = await admin.rpc('public_booking_slots', {
    p_slug: studio.slug, p_service_slug: draft.serviceSlug, p_local_day: draft.day,
  });
  if (error) throw error;
  return (slots ?? []).some((slot: {available_count: number}) => slot.available_count > 0);
}

/** Normalizes "19:30", "19.30", "1930" to a zero-padded HH:MM string. */
function normalizeTime(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 3) return `0${digits.slice(0, 1)}:${digits.slice(1)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return value.trim();
}

/**
 * Validates the requested day against the booking window: today through 90
 * days ahead, matching the server-side limits of create_public_booking.
 */
function validateBookingDay(day: string | null, today: string): string | null {
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'Укажите дату в формате ГГГГ-ММ-ДД.';
  const target = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(target.getTime())) return 'Укажите дату в формате ГГГГ-ММ-ДД.';
  const current = new Date(`${today}T12:00:00Z`);
  const diffDays = Math.round((target.getTime() - current.getTime()) / 86_400_000);
  if (diffDays < 0) return 'Эта дата уже прошла. Назовите дату позже.';
  if (diffDays > 90) return 'Запись доступна не более чем на 90 дней вперёд. Назовите дату поближе.';
  return null;
}

console.log('[assistant] module loaded, secrets check:', {
  hasApiKey: Boolean(Deno.env.get('LLM_API_KEY')),
  hasBaseURL: Boolean(Deno.env.get('LLM_BASE_URL')),
  hasModel: Boolean(Deno.env.get('LLM_MODEL')),
});

Deno.serve(async (request) => {
  console.log('[assistant] request received:', request.method, request.url);
  if (request.method === 'OPTIONS') return preflight(request);
  if (forbiddenOrigin(request)) return json(request, {error: 'Origin is not allowed.'}, 403);
  if (request.method !== 'POST') return json(request, {error: 'Method not allowed.'}, 405);
  try {
    const input = inputSchema.parse(await request.json());
    const admin = adminClient();
    const tenant = await tenantBySlug(admin, input.slug);
    if (!tenant) return json(request, {error: 'Студия не найдена.'}, 404);
    const {data: studio, error: studioError} = await admin.from('tenants')
      .select('id,slug,name,address,city,map_url,phone,timezone,currency,cancellation_window_hours,assistant_prompts,opening_hours')
      .eq('id', tenant.id).single();
    if (studioError) throw studioError;
    if (!await checkRateLimit(admin, request, `assistant-${input.audience}`, tenant.id, input.audience === 'owner' ? 20 : 30, 300)) {
      return json(request, {error: 'Слишком много сообщений. Попробуйте через несколько минут.'}, 429);
    }
    if (input.audience === 'owner') {
      const user = await userFromRequest(request);
      if (!user) return json(request, {error: 'Войдите в кабинет владельца.'}, 401);
      const role = await requireMembership(admin, tenant.id, user.id);
      if (!canUseOwnerAssistant(role)) return json(request, {error: 'Нет доступа к помощнику владельца.'}, 403);
    }
    // Booking flow: only for clients, only when the customer actually asks to
    // be booked. The owner audience manages appointments through owner-api.
    if (input.audience === 'client' && looksLikeBookingRequest(input.message)) {
      // Bookings are writes — they get their own, tighter budget than chat.
      if (!await checkRateLimit(admin, request, 'assistant-booking', tenant.id, 8, 600)) {
        return json(request, {error: 'Слишком много попыток записи. Подождите несколько минут.'}, 429);
      }
      const booking = await handleBooking(admin, studio, {
        message: input.message,
        messageCount: input.messageCount ?? 0,
        draft: input.bookingDraft,
        idempotencyKey: input.idempotencyKey,
      });
      return json(request, {answer: booking.answer, draft: booking.draft, booking: booking.booking ?? null});
    }
    const facts = input.audience === 'client'
      ? await clientFacts(admin, studio, input.message, input.date)
      : await ownerFacts(admin, studio, input.message, input.date);
    const fallback = deterministicAnswer(facts, studio.currency);
    const answer = await modelAnswer(admin, facts, input.message, studio.id, localDay(new Date(), studio.timezone), fallback, input.messageCount ?? 0, {
      id: studio.id, slug: studio.slug, name: studio.name, city: studio.city,
      address: studio.address, phone: studio.phone, timezone: studio.timezone, currency: studio.currency,
    });
    return json(request, {answer});
  } catch (error) {
    return json(request, {error: errorMessage(error)}, 400);
  }
});
