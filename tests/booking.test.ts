import {describe, expect, it} from 'vitest';
import {addDays} from 'date-fns';
import graphite from '../tenants/graphite-detailing/business.json';
import ceramica from '../tenants/ceramica-garage/business.json';
import {businessSchema, type BusinessConfig} from '@/domain/tenant';
import {createDemoAppointment, getDemoSlots, readDemoAppointments} from '@/lib/local-demo';

function firstOpenDay(business: BusinessConfig, startAfterDays = 2) {
  for (let offset = startAfterDays; offset < startAfterDays + 15; offset += 1) {
    const day = addDays(new Date(), offset).toISOString().slice(0, 10);
    const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
    if (business.openingHours.some((hours) => hours.weekday === weekday)) return day;
  }
  throw new Error('No opening day found in the fixture range.');
}

describe('tenant configuration and demo booking', () => {
  it('validates both tenant profile examples', () => {
    expect(businessSchema.parse(graphite).slug).toBe('graphite-detailing');
    expect(businessSchema.parse(ceramica).slug).toBe('ceramica-garage');
  });

  it('creates one appointment for a repeated idempotency key', () => {
    const business = businessSchema.parse(graphite);
    const service = business.services[0];
    const day = firstOpenDay(business);
    const slot = getDemoSlots(business, service, day).find((candidate) => candidate.availableCount > 0);
    expect(slot).toBeDefined();
    const booking = {business, service, startsAt: slot!.startsAt, customerName: 'Александр Петров', customerPhone: '+7 900 000-00-00', vehicle: 'Volvo XC60', idempotencyKey: crypto.randomUUID()};
    const first = createDemoAppointment(booking);
    const duplicate = createDemoAppointment(booking);
    expect(duplicate.appointment.id).toBe(first.appointment.id);
    expect(duplicate.accessToken).toBe(first.accessToken);
    expect(readDemoAppointments(business.slug)).toHaveLength(1);
  });

  it('marks the selected bay occupied and makes it available after cancellation', () => {
    const business = businessSchema.parse(graphite);
    const service = business.services[0];
    const day = firstOpenDay(business);
    const before = getDemoSlots(business, service, day);
    const selected = before.find((slot) => slot.availableCount > 0)!;
    const booking = createDemoAppointment({
      business, service, startsAt: selected.startsAt, customerName: 'Мария Смирнова',
      customerPhone: '+7 901 111-11-11', vehicle: 'Audi A4', idempotencyKey: crypto.randomUUID(),
    });
    const after = getDemoSlots(business, service, day).find((slot) => slot.startsAt === selected.startsAt);
    expect(after?.availableCount).toBe(selected.availableCount - 1);
    const storageKey = 'autoservices-preview:' + business.slug + ':appointments';
    localStorage.setItem(storageKey, JSON.stringify(readDemoAppointments(business.slug).map((item) => item.id === booking.appointment.id ? {...item, status: 'cancelled'} : item)));
    const reopened = getDemoSlots(business, service, day).find((slot) => slot.startsAt === selected.startsAt);
    expect(reopened?.availableCount).toBe(selected.availableCount);
  });

  it('keeps a long service reservation in place across the following day', () => {
    const business = businessSchema.parse(ceramica);
    const service = business.services.find((candidate) => candidate.durationMinutes >= 1440)!;
    const day = firstOpenDay(business);
    const slot = getDemoSlots(business, service, day).find((candidate) => candidate.availableCount > 0)!;
    createDemoAppointment({
      business, service, startsAt: slot.startsAt, customerName: 'Илья Соколов',
      customerPhone: '+7 902 222-22-22', vehicle: 'BMW X5', idempotencyKey: crypto.randomUUID(),
    });
    const nextDay = addDays(new Date(day + 'T12:00:00Z'), 1).toISOString().slice(0, 10);
    const nextDaySlots = getDemoSlots(business, service, nextDay);
    expect(nextDaySlots.every((candidate) => candidate.availableCount < business.resources.length)).toBe(true);
  });
});
