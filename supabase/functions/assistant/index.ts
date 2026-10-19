import OpenAI from 'npm:openai@7.32.0';
import {z} from 'npm:zod@4.6.6';
import {adminClient, checkRateLimit, errorMessage, forbiddenOrigin, json, preflight, requireMembership, tenantBySlug, userFromRequest} from '../_shared/http.ts';
import {canUseOwnerAssistant, routeClientQuestion, routeOwnerQuestion} from './router.ts';
import {buildLlmMessages} from './prompt.ts';

const inputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  audience: z.enum(['client', 'owner']),
  message: z.string().trim().min(1).max(500),
  date: z.iso.date().optional(),
  messageCount: z.number().int().min(0).max(10_000).optional(),
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

async function modelAnswer(admin: ReturnType<typeof adminClient>, facts: FactSet, message: string, tenantId: string, day: string, fallback: string, messageCount: number) {
  const apiKey = Deno.env.get('LLM_API_KEY');
  const model = Deno.env.get('LLM_MODEL');
  if (!apiKey || !model) return fallback;
  const factsJson = JSON.stringify({question: message, verifiedStudioFacts: facts});
  if (factsJson.length > 12_000) return fallback;
  const positiveInteger = (name: string, fallbackValue: number, hardMaximum: number) => {
    const value = Number(Deno.env.get(name) ?? fallbackValue);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, hardMaximum) : fallbackValue;
  };
  const inputRate = positiveInteger('LLM_INPUT_MICRO_USD_PER_1K_TOKENS', 20_000, 1_000_000);
  const outputRate = positiveInteger('LLM_OUTPUT_MICRO_USD_PER_1K_TOKENS', 80_000, 1_000_000);
  const reservedInputTokens = 24_000;
  const reservedOutputTokens = 350;
  const reserveCostMicros = Math.ceil(reservedInputTokens * inputRate / 1_000) + Math.ceil(reservedOutputTokens * outputRate / 1_000);
  const dailyCalls = positiveInteger('LLM_DAILY_CALL_LIMIT', 40, 1_000);
  const dailyTokens = positiveInteger('LLM_DAILY_TOKEN_LIMIT', 300_000, 10_000_000);
  const dailyCostMicros = positiveInteger('LLM_DAILY_COST_LIMIT_MICRO_USD', 5_000_000, 50_000_000);
  const reservedTokens = reservedInputTokens + reservedOutputTokens;
  const {data: reserved, error: reserveError} = await admin.rpc('reserve_llm_budget', {
    p_tenant_id: tenantId,
    p_local_day: day,
    p_daily_calls: dailyCalls,
    p_daily_tokens: dailyTokens,
    p_reserved_tokens: reservedTokens,
    p_daily_cost_micros: dailyCostMicros,
    p_reserved_cost_micros: reserveCostMicros,
  });
  if (reserveError) throw reserveError;
  if (reserved !== true) return `${fallback}\n\nЛимит помощника на сегодня достигнут.`;

  try {
    const baseURL = Deno.env.get('LLM_BASE_URL');
    const client = new OpenAI({apiKey, ...(baseURL ? {baseURL} : {}), maxRetries: 1, timeout: 12_000});
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 350,
      messages: buildLlmMessages(factsJson, message, messageCount),
    });
    const usage = completion.usage;
    if (usage) {
      const costMicros = Math.ceil(usage.prompt_tokens * inputRate / 1_000) + Math.ceil(usage.completion_tokens * outputRate / 1_000);
      const {error: usageError} = await admin.rpc('record_llm_usage', {
        p_tenant_id: tenantId, p_local_day: day,
        p_input_tokens: usage.prompt_tokens, p_output_tokens: usage.completion_tokens, p_cost_micros: costMicros,
      });
      if (usageError) throw usageError;
    }
    const answer = completion.choices[0]?.message?.content?.trim();
    return answer || fallback;
  } catch {
    return fallback;
  }
}

Deno.serve(async (request) => {
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
    const facts = input.audience === 'client'
      ? await clientFacts(admin, studio, input.message, input.date)
      : await ownerFacts(admin, studio, input.message, input.date);
    const fallback = deterministicAnswer(facts, studio.currency);
    const answer = await modelAnswer(admin, facts, input.message, studio.id, localDay(new Date(), studio.timezone), fallback, input.messageCount ?? 0);
    return json(request, {answer});
  } catch (error) {
    return json(request, {error: errorMessage(error)}, 400);
  }
});
