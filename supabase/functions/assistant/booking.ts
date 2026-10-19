import {z} from 'npm:zod@4.6.6';
import {adminClient, deterministicAccessToken, sha256} from '../_shared/http.ts';
import {EMPTY_BOOKING_DRAFT, type BookingDraft} from './prompt.ts';

/**
 * Booking intent detection.
 *
 * The client audience may ask to be booked ("запиши меня завтра на полировку").
 * The owner audience never books on a customer's behalf through the assistant —
 * the owner's cabinet manages appointments through owner-api instead.
 */

const BOOKING_TRIGGERS = /запиши|записать|забронируй|забронировать|хочу записаться|запишите|запишемся|оформи(ть)? запись|займу|бронь|приду к вам|записаться/;

export function looksLikeBookingRequest(message: string): boolean {
  return BOOKING_TRIGGERS.test(message.toLocaleLowerCase('ru-RU'));
}

/**
 * True when a booking is already in progress: some fields are collected and
 * some are still missing. A follow-up message ("зовут Некит, +7 999...") does
 * not contain a booking trigger, but it must continue the booking flow
 * instead of falling through to the ordinary chat.
 */
export function hasActiveBookingDraft(draft: BookingDraft): boolean {
  const collected = [draft.serviceSlug, draft.day, draft.customerName, draft.customerPhone, draft.vehicle].filter(Boolean);
  return collected.length > 0 && collected.length < 5;
}

/**
 * Generic words that describe a service rather than name it. They are
 * ignored on both sides: "Полировка кузова" and "Мойка кузова" must not
 * collide on the word "кузова", and a request for "полный" must not match
 * "Полировка".
 */
const SERVICE_STOP_WORDS = new Set([
  'полный', 'полная', 'полное', 'полных',
  'кузов', 'кузова', 'кузове',
  'салон', 'салона', 'салоне',
  'услуга', 'услуги', 'комплекс', 'комплекса',
  'авто', 'автомобиль', 'автомобиля',
]);

/**
 * Synonyms a customer may use for a service. The studio's own service names
 * are matched too, but a customer says "уборка" for "Чистка салона" and
 * "мойка" for "Мойка кузова" — the model alone picked the wrong one.
 */
const CONCEPT_ALIASES: Record<string, string[]> = {
  мойка: ['мойка', 'мойку', 'мыть', 'мытье', 'мытьё', 'помыть', 'помывка'],
  чистка: ['чистка', 'чистку', 'чистить', 'уборка', 'уборку', 'убрать', 'вымыть'],
  полировка: ['полировка', 'полировку', 'полировать', 'шлифовка', 'шлифовку', 'шлифовать'],
  детейлинг: ['детейлинг', 'детейлинга'],
};

/** Lowercase, ё→е, letters and digits only. */
function normalize(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
}

/**
 * 4-character stem so "чистка"/"чистку"/"чистить" share a root while
 * "полный" ("полн") stays distinct from "полировка" ("поли").
 */
function stem(word: string): string {
  return word.slice(0, 4);
}

/** True when the word only describes a service instead of naming it. */
function isStopWord(word: string): boolean {
  return SERVICE_STOP_WORDS.has(word);
}

/**
 * Match stems for one service: its own name words plus the synonyms of any
 * concept its name belongs to.
 *
 * Only the concept the name actually belongs to contributes its synonyms —
 * otherwise "Полировка кузова" would inherit the "шлифовка" stem and tie
 * with a "Шлифовка" service.
 */
function serviceStems(name: string): Set<string> {
  const stems = new Set<string>();
  const words = normalize(name).split(' ').filter(Boolean);
  for (const word of words) {
    if (word.length < 4 || isStopWord(word)) continue;
    stems.add(stem(word));
  }
  for (const [concept, aliases] of Object.entries(CONCEPT_ALIASES)) {
    // The name must contain the concept itself, not just share a stem.
    const nameBelongs = words.some((word) => word.startsWith(concept));
    if (!nameBelongs) continue;
    for (const alias of aliases) stems.add(stem(alias));
  }
  return stems;
}

export type ServiceMatch = {slug: string; score: number} | null;

/**
 * Deterministic service matching: the customer's own words decide which
 * service is meant, not the language model's guess. A tie between two
 * services returns null so the customer is asked to choose.
 */
export function matchServiceByMessage(message: string, services: Array<{slug: string; name: string}>): ServiceMatch {
  const text = normalize(message);
  if (!text) return null;
  const words = text.split(' ').filter((word) => word.length >= 4 && !isStopWord(word));
  if (!words.length) return null;
  let best: {slug: string; score: number} | null = null;
  let tied = false;
  for (const service of services) {
    const stems = serviceStems(service.name);
    if (!stems.size) continue;
    // The service that matches the most of the customer's words wins, so
    // "мойку кузова" resolves to "Мойка кузова" and not to a service that
    // only shares the generic word.
    let score = 0;
    for (const word of words) {
      if (stems.has(stem(word))) score += 1;
    }
    if (!score) continue;
    if (!best || score > best.score) { best = {slug: service.slug, score}; tied = false; }
    else if (score === best.score) tied = true;
  }
  if (!best || tied) return null;
  return best;
}

/**
 * Extracts the phone number from a message. The customer's digits are the
 * only trustworthy source — the model must never invent a contact detail.
 */
export function extractPhone(message: string): string {
  const match = message.match(/(\+?\d[\d\s()\-]{7,}\d)/);
  if (!match) return '';
  const digits = match[1].replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 15) return '';
  return match[1].trim();
}

/**
 * Extracts the day the customer asked for. Relative words are resolved
 * against the studio's current local day.
 */
export function extractDay(message: string, today: string): string | null {
  const text = message.toLocaleLowerCase('ru-RU');
  const shift = (days: number) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  if (/послезавтра/.test(text)) return shift(2);
  if (/сегодня/.test(text)) return shift(0);
  if (/завтра/.test(text)) return shift(1);
  const explicit = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (explicit) return `${explicit[1]}-${explicit[2]}-${explicit[3]}`;
  const dotted = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (dotted) {
    const day = String(Number(dotted[1])).padStart(2, '0');
    const month = String(Number(dotted[2])).padStart(2, '0');
    return `${dotted[3]}-${month}-${day}`;
  }
  return null;
}

/**
 * Extracts the time the customer asked for, in HH:MM. "В любое время" and
 * similar phrasings mean "no preference" and are reported as null so the
 * server picks the first free slot of the day.
 */
export function extractTime(message: string): string | null {
  const text = message.toLocaleLowerCase('ru-RU');
  if (/любое время|когда удобно|в любое|подходит любое|любой день|любой час/.test(text)) return null;
  const match = text.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Extracts the vehicle the customer named. Car brands the studio services are
 * recognised; anything else is left empty so the customer is asked.
 */
const VEHICLE_HINTS: Array<{patterns: RegExp; label: string}> = [
  {patterns: /бмв|\bbmw\b/i, label: 'BMW'},
  {patterns: /ауди|\baud[ie]\b/i, label: 'Audi'},
  {patterns: /мерседес|мбс|\bml\b/i, label: 'Mercedes-Benz'},
  {patterns: /\bтойота\b|\btoyota\b/i, label: 'Toyota'},
  {patterns: /\bхендай\b|\bhyundai\b/i, label: 'Hyundai'},
  {patterns: /\bфорд\b|\bford\b/i, label: 'Ford'},
  {patterns: /\bшкода\b|\bskoda\b/i, label: 'Skoda'},
  {patterns: /\bвольксваген\b|\bvw\b|\bфольксваген\b/i, label: 'Volkswagen'},
  {patterns: /\bниссан\b|\bnissan\b/i, label: 'Nissan'},
  {patterns: /\bмазда\b|\bmazda\b/i, label: 'Mazda'},
  {patterns: /\bлада\b|\bgranta\b|\bприора\b|\bкалина\b/i, label: 'Lada'},
];

export function extractVehicle(message: string): string {
  for (const hint of VEHICLE_HINTS) {
    if (hint.patterns.test(message)) return hint.label;
  }
  return '';
}

/**
 * Extracts the customer's name. Russian introductions ("зовут Саша", "меня
 * зовут Иван", "имя Анна") are recognised; a bare name in such a phrase is
 * taken as the name.
 */
export function extractName(message: string): string {
  const patterns = [
    /(?:зовут|звут|имя|имею)\s+([А-ЯЁа-яё][А-ЯЁа-яё\-]{1,30})/,
    /это\s+([А-ЯЁа-яё][А-ЯЁа-яё\-]{1,30})/,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const name = match[1].replace(/[^А-ЯЁа-яё\-]/gi, '').trim();
      if (name.length >= 2) return name;
    }
  }
  return '';
}

/**
 * Collects the booking fields from the customer's own words, without the
 * model. Values already collected in a previous turn are kept when the
 * current message does not repeat them.
 */
export function extractBookingFields(
  message: string,
  services: Array<{slug: string; name: string}>,
  today: string,
  current: BookingDraft,
): BookingDraft {
  const service = matchServiceByMessage(message, services);
  const phone = extractPhone(message);
  const name = extractName(message);
  const vehicle = extractVehicle(message);
  const day = extractDay(message, today);
  const time = extractTime(message);
  return {
    serviceSlug: service?.slug ?? current.serviceSlug,
    day: day ?? current.day,
    time: time !== null ? time : current.time,
    customerName: name || current.customerName,
    customerPhone: phone || current.customerPhone,
    vehicle: vehicle || current.vehicle,
  };
}

export const bookingDraftSchema = z.object({
  serviceSlug: z.string().max(120).nullable().optional(),
  day: z.string().max(10).nullable().optional(),
  time: z.string().max(10).nullable().optional(),
  customerName: z.string().max(120).optional(),
  customerPhone: z.string().max(60).optional(),
  vehicle: z.string().max(120).optional(),
});

export function normalizeDraft(raw: unknown): BookingDraft {
  const parsed = bookingDraftSchema.safeParse(raw ?? {});
  if (!parsed.success) return {...EMPTY_BOOKING_DRAFT};
  const value = parsed.data;
  const text = (input: unknown) => typeof input === 'string' ? input.trim() : '';
  return {
    serviceSlug: value.serviceSlug ? value.serviceSlug.trim() : null,
    day: value.day ? value.day.trim() : null,
    time: value.time ? value.time.trim() : null,
    customerName: text(value.customerName),
    customerPhone: text(value.customerPhone),
    vehicle: text(value.vehicle),
  };
}

export type BookingResult =
  | {status: 'created'; appointment: {id: string; startsAt: string; endsAt: string; serviceName: string; priceMinor: number}; accessToken: string; slotLabel: string}
  | {status: 'no_slot'; message: string}
  | {status: 'conflict'; message: string}
  | {status: 'invalid'; message: string};

/**
 * Resolves a local day+time in the studio timezone to a UTC instant, using the
 * same "local midnight as UTC" technique the rest of the function uses.
 */
export function localTimeToUtc(day: string, time: string, timezone: string): Date | null {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (!year || !month || !date || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  const utcTarget = Date.UTC(year, month - 1, date, hour, minute);
  let instant = utcTarget;
  const formatter = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    instant += utcTarget - localAsUtc;
  }
  return new Date(instant);
}

/** Formats a UTC instant as a local HH:MM label in the studio timezone. */
export function utcToLocalTime(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/**
 * Performs the booking through the very same RPC the public schedule uses, so
 * slot races, opening hours, booking step and capacity rules are enforced
 * server-side exactly once. The LLM never talks to the database directly.
 */
export async function createBooking(
  admin: ReturnType<typeof adminClient>,
  input: {slug: string; tenantId: string; timezone: string; serviceSlug: string; startsAt: Date; customerName: string; customerPhone: string; vehicle: string; idempotencyKey: string},
): Promise<BookingResult> {
  const name = input.customerName.trim();
  const phone = input.customerPhone.trim();
  const vehicle = input.vehicle.trim();
  if (name.length < 2 || name.length > 100) return {status: 'invalid', message: 'Проверьте имя — нужно от 2 до 100 символов.'};
  if (phone.length < 5 || phone.length > 40 || !/^[+\d() .-]+$/.test(phone)) return {status: 'invalid', message: 'Проверьте телефон — нужен номер в формате +7 999 123-45-67.'};
  if (vehicle.length < 2 || vehicle.length > 120) return {status: 'invalid', message: 'Укажите автомобиль — минимум 2 символа.'};

  const accessToken = await deterministicAccessToken(input.slug, input.idempotencyKey);
  const accessTokenHash = await sha256(accessToken);
  const {data, error} = await admin.rpc('create_public_booking', {
    p_slug: input.slug,
    p_service_slug: input.serviceSlug,
    p_starts_at: input.startsAt.toISOString(),
    p_customer_name: name,
    p_customer_phone: phone,
    p_vehicle: vehicle,
    p_idempotency_key: input.idempotencyKey,
    p_access_token_hash: accessTokenHash,
  });
  if (error) {
    const code = error?.code;
    const message = typeof error?.message === 'string' ? error.message : '';
    if (code === '23P01' || message.includes('SLOT_TAKEN')) {
      return {status: 'conflict', message: 'Это время только что заняли. Выберите другое окно — покажу свободные.'};
    }
    if (code === '22023' && message.includes('OUTSIDE_OPENING_HOURS')) {
      return {status: 'no_slot', message: 'В это время студия не работает. Выберите другое окно — покажу свободные.'};
    }
    if (code === '22023' && message.includes('INVALID_BOOKING_STEP')) {
      return {status: 'no_slot', message: 'Это время не попадает в шаг расписания студии. Выберите другое окно.'};
    }
    if (code === '22023' && message.includes('BOOKING_TIME_IN_PAST')) {
      return {status: 'no_slot', message: 'Это время уже прошло. Выберите ближайшее свободное окно.'};
    }
    if (code === 'P0002') {
      return {status: 'invalid', message: 'Не удалось найти услугу или студию. Проверьте название услуги.'};
    }
    return {status: 'invalid', message: 'Не удалось оформить запись. Попробуйте ещё раз или позвоните в студию.'};
  }
  const appointment = data as Record<string, unknown>;
  return {
    status: 'created',
    appointment: {
      id: String(appointment.id),
      startsAt: String(appointment.starts_at),
      endsAt: String(appointment.ends_at),
      serviceName: '',
      priceMinor: Number(appointment.price_minor ?? 0),
    },
    accessToken,
    slotLabel: utcToLocalTime(String(appointment.starts_at), input.timezone),
  };
}
