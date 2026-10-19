import {
  EMPTY_BOOKING_DRAFT,
  buildBookingMessages,
  mergeBookingDraft,
  missingBookingFields,
  parseBookingIntent,
  type BookingDraft,
} from './prompt.ts';
import {localTimeToUtc, looksLikeBookingRequest, normalizeDraft, utcToLocalTime} from './booking.ts';

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function assertTrue(value: unknown, label: string) {
  if (!value) throw new Error(`${label}: expected truthy`);
}

// ─── Booking intent detection ─────────────────────────────────────────────

Deno.test('booking requests are detected in Russian', () => {
  assertTrue(looksLikeBookingRequest('Запиши меня завтра на полировку'), 'explicit booking verb');
  assertTrue(looksLikeBookingRequest('хочу записаться на мойку'), 'wanna book');
  assertTrue(looksLikeBookingRequest('забронируй, пожалуйста'), 'book it');
  assertTrue(looksLikeBookingRequest('Оформить запись на мойку'), 'make a booking');
});

Deno.test('ordinary questions are not booking requests', () => {
  assertEqual(looksLikeBookingRequest('Сколько стоит полировка?'), false, 'price question');
  assertEqual(looksLikeBookingRequest('Как найти студию?'), false, 'location question');
  assertEqual(looksLikeBookingRequest('Какие есть услуги?'), false, 'services question');
});

// ─── Slot time conversion ─────────────────────────────────────────────────

Deno.test('local time converts to UTC and back', () => {
  const instant = localTimeToUtc('2026-10-20', '10:00', 'Europe/Moscow');
  assertTrue(instant instanceof Date, 'parsed date');
  // 10:00 MSK (UTC+3) === 07:00 UTC
  assertEqual(instant!.toISOString(), '2026-10-20T07:00:00.000Z', 'moscow offset');
  assertEqual(utcToLocalTime('2026-10-20T07:00:00.000Z', 'Europe/Moscow'), '10:00', 'round trip');
});

Deno.test('invalid local time returns null', () => {
  assertEqual(localTimeToUtc('2026-10-20', 'nonsense', 'Europe/Moscow'), null, 'bad time');
  assertEqual(localTimeToUtc('bad-day', '10:00', 'Europe/Moscow'), null, 'bad day');
});

// ─── Draft normalization ──────────────────────────────────────────────────

Deno.test('draft normalization discards a malformed draft entirely', () => {
  // customerName is a number, so the whole draft is rejected rather than
  // partially applied — a half-trusted draft is more dangerous than none.
  const draft = normalizeDraft({serviceSlug: 'x', unknown: 'y', customerName: 42});
  assertEqual(draft.serviceSlug, null, 'malformed draft discarded');
  assertEqual(draft.customerName, '', 'no partial application');
});

Deno.test('draft normalization trims and nulls', () => {
  const draft = normalizeDraft({serviceSlug: '  polirovka  ', day: null, time: '', customerName: ' Некит ', customerPhone: ' 8999 ', vehicle: ' БМВ '});
  assertEqual(draft.serviceSlug, 'polirovka', 'slug trimmed');
  assertEqual(draft.day, null, 'day null');
  assertEqual(draft.time, null, 'empty time is null');
  assertEqual(draft.customerName, 'Некит', 'name trimmed');
  assertEqual(draft.vehicle, 'БМВ', 'vehicle trimmed');
});

// ─── Intent parsing ───────────────────────────────────────────────────────

Deno.test('booking intent parses plain JSON', () => {
  const intent = parseBookingIntent(JSON.stringify({
    answer: 'Когда удобно?',
    booking: {serviceSlug: 'polirovka', day: '2026-10-20', time: null, customerName: 'Некит', customerPhone: '89996667788', vehicle: 'БМВ'},
  }));
  assertTrue(intent !== null, 'parsed');
  assertEqual(intent!.answer, 'Когда удобно?', 'answer');
  assertEqual(intent!.booking.serviceSlug, 'polirovka', 'service');
  assertEqual(intent!.booking.time, null, 'null time preserved');
  assertEqual(intent!.booking.vehicle, 'БМВ', 'vehicle');
});

Deno.test('booking intent parses JSON wrapped in a code fence', () => {
  const intent = parseBookingIntent('```json\n{"answer":"Готово","booking":{"serviceSlug":"moyka","customerName":"Иван","customerPhone":"8999","vehicle":"Ауди"}}\n```');
  assertTrue(intent !== null, 'parsed from fence');
  assertEqual(intent!.booking.serviceSlug, 'moyka', 'service');
});

Deno.test('booking intent parses JSON surrounded by prose', () => {
  const intent = parseBookingIntent('Вот мой ответ: {"answer":"Записал","booking":{"serviceSlug":"moyka"}} Спасибо!');
  assertTrue(intent !== null, 'parsed from prose');
  assertEqual(intent!.answer, 'Записал', 'answer extracted');
});

Deno.test('booking intent rejects malformed output', () => {
  assertEqual(parseBookingIntent('no json here'), null, 'plain text');
  assertEqual(parseBookingIntent('{broken json'), null, 'broken json');
  assertEqual(parseBookingIntent('{"answer":"ok"'), null, 'unterminated object');
});

Deno.test('booking intent with missing booking block yields empty draft', () => {
  const intent = parseBookingIntent('{"answer":"Просто вопрос"}');
  assertTrue(intent !== null, 'parsed');
  assertEqual(intent!.booking.serviceSlug, null, 'no service');
  assertEqual(intent!.booking.customerName, '', 'no name');
});

// ─── Draft merging ────────────────────────────────────────────────────────

Deno.test('merge keeps previously collected fields', () => {
  const current: BookingDraft = {serviceSlug: 'polirovka', day: '2026-10-20', time: null, customerName: 'Некит', customerPhone: '8999', vehicle: 'БМВ'};
  const incoming: BookingDraft = {...EMPTY_BOOKING_DRAFT, customerPhone: '89996667788'};
  const merged = mergeBookingDraft(current, incoming);
  assertEqual(merged.serviceSlug, 'polirovka', 'service kept');
  assertEqual(merged.customerName, 'Некит', 'name kept');
  assertEqual(merged.vehicle, 'БМВ', 'vehicle kept');
  assertEqual(merged.customerPhone, '89996667788', 'new phone applied');
});

Deno.test('merge lets a restated value override', () => {
  const current: BookingDraft = {serviceSlug: 'polirovka', day: '2026-10-20', time: null, customerName: 'Некит', customerPhone: '8999', vehicle: 'БМВ'};
  const incoming: BookingDraft = {serviceSlug: 'moyka', day: '2026-10-21', time: '15:00', customerName: 'Пётр', customerPhone: '8000', vehicle: 'Ауди'};
  const merged = mergeBookingDraft(current, incoming);
  assertEqual(merged.serviceSlug, 'moyka', 'service overridden');
  assertEqual(merged.day, '2026-10-21', 'day overridden');
  assertEqual(merged.time, '15:00', 'time overridden');
  assertEqual(merged.customerName, 'Пётр', 'name overridden');
});

// ─── Missing field detection ──────────────────────────────────────────────

Deno.test('missing fields are reported for an empty draft', () => {
  const missing = missingBookingFields(EMPTY_BOOKING_DRAFT);
  assertEqual(missing.length, 5, 'five fields required');
  assertTrue(missing.includes('service'), 'service missing');
  assertTrue(missing.includes('day'), 'day missing');
  assertTrue(missing.includes('customerName'), 'name missing');
  assertTrue(missing.includes('customerPhone'), 'phone missing');
  assertTrue(missing.includes('vehicle'), 'vehicle missing');
});

Deno.test('time is optional — "any time" still books', () => {
  const draft: BookingDraft = {serviceSlug: 'polirovka', day: '2026-10-20', time: null, customerName: 'Некит', customerPhone: '8999', vehicle: 'БМВ'};
  assertEqual(missingBookingFields(draft).length, 0, 'no missing fields without a time');
});

Deno.test('a complete draft has no missing fields', () => {
  const draft: BookingDraft = {serviceSlug: 'polirovka', day: '2026-10-20', time: '10:00', customerName: 'Некит', customerPhone: '8999', vehicle: 'БМВ'};
  assertEqual(missingBookingFields(draft).length, 0, 'complete draft');
});

// ─── Booking message construction ─────────────────────────────────────────

Deno.test('booking messages use the dedicated prompt and JSON contract', () => {
  const messages = buildBookingMessages('{"message":"тест"}', 0);
  assertEqual(messages.length, 2, 'system + user');
  const system = messages[0].content;
  assertTrue(system.includes('Ты НЕ можешь сам создать запись'), 'creation delegated to the server');
  assertTrue(system.includes('create_public_booking') === false, 'no internal RPC name leaked');
  assertTrue(system.includes('JSON'), 'json contract present');
  // Creation is allowed in this flow (the server performs it), but every
  // destructive tool must be denied explicitly.
  assertTrue(system.includes('deleteAppointment'), 'destructive tools named');
  assertTrue(system.includes('Функций deleteAppointment'), 'destructive tools denied');
  assertTrue(system.includes('getUserAppointments'), 'read-tools for other bookings denied');
  assertTrue(system.includes('Ты не можешь бронировать время, которого нет в расписании'), 'cannot invent slots');
});

Deno.test('booking messages include the safety reminder every 5 messages', () => {
  assertEqual(buildBookingMessages('{}', 4).length, 2, 'no reminder at 4');
  assertEqual(buildBookingMessages('{}', 5).length, 3, 'reminder at 5');
});
