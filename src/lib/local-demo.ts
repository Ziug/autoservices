import {addMinutes} from 'date-fns';
import {fromZonedTime} from 'date-fns-tz';
import type {Appointment, AvailabilitySlot, BusinessConfig, OwnerMetrics, Service} from '@/domain/tenant';
import {createClientId} from '@/lib/id';

const storageKey = (slug: string) => `autoservices-preview:${slug}:appointments`;
const settingsKey = (slug: string) => `autoservices-preview:${slug}:settings`;

export type DemoAppointment = Appointment & {resourceIndex: number; createdAt: string; collectedMinor?: number};
type DemoSettings = {
  profile?: Partial<BusinessConfig>;
  services?: Service[];
  resources?: BusinessConfig['resources'];
  dateOverrides?: Record<string, {isClosed: boolean; opensAt: string | null; closesAt: string | null; label: string}>;
};

function readSettings(slug: string): DemoSettings {
  try { return JSON.parse(localStorage.getItem(settingsKey(slug)) ?? '{}') as DemoSettings; } catch { return {}; }
}

function writeSettings(slug: string, settings: DemoSettings) {
  localStorage.setItem(settingsKey(slug), JSON.stringify(settings));
}

export function readDemoBusinessOverrides(slug: string) {
  return readSettings(slug);
}

export function updateDemoProfile(slug: string, profile: Partial<BusinessConfig>) {
  const settings = readSettings(slug);
  writeSettings(slug, {...settings, profile: {...settings.profile, ...profile}});
}

export function updateDemoServices(slug: string, services: Service[]) {
  writeSettings(slug, {...readSettings(slug), services});
}

export function updateDemoResources(slug: string, resources: BusinessConfig['resources']) {
  writeSettings(slug, {...readSettings(slug), resources});
}

export function updateDemoDateOverride(slug: string, date: string, override: NonNullable<DemoSettings['dateOverrides']>[string]) {
  const settings = readSettings(slug);
  writeSettings(slug, {...settings, dateOverrides: {...settings.dateOverrides, [date]: override}});
}

export function updateDemoPayment(slug: string, appointmentId: string, amountMinor: number, kind: 'charge' | 'refund') {
  const factor = kind === 'charge' ? 1 : -1;
  const appointments = readDemoAppointments(slug).map((item) => item.id === appointmentId
    ? {...item, collectedMinor: Math.max(0, (item.collectedMinor ?? 0) + amountMinor * factor)}
    : item);
  writeDemoAppointments(slug, appointments);
  return appointments;
}

export function readDemoAppointments(slug: string): DemoAppointment[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(slug)) ?? '[]') as DemoAppointment[];
  } catch {
    return [];
  }
}

function writeDemoAppointments(slug: string, appointments: DemoAppointment[]) {
  localStorage.setItem(storageKey(slug), JSON.stringify(appointments));
}

export function getDemoSlots(business: BusinessConfig, service: Service, day: string): AvailabilitySlot[] {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const override = readSettings(business.slug).dateOverrides?.[day];
  if (override?.isClosed) return [];
  const opening = override
    ? {weekday, opensAt: override.opensAt ?? '09:00', closesAt: override.closesAt ?? '19:00'}
    : business.openingHours.find((item) => item.weekday === weekday);
  if (!opening) return [];

  const [openHour, openMinute] = opening.opensAt.split(':').map(Number);
  const [closeHour, closeMinute] = opening.closesAt.split(':').map(Number);
  const open = openHour * 60 + openMinute;
  const close = closeHour * 60 + closeMinute;
  const appointments = readDemoAppointments(business.slug).filter((item) => !['cancelled', 'completed', 'no_show'].includes(item.status));
  const slots: AvailabilitySlot[] = [];

  const lastStart = service.durationMinutes >= 1440
    ? close - business.bookingStepMinutes
    : close - service.durationMinutes - service.bufferAfterMinutes;
  for (let minute = open; minute <= lastStart; minute += business.bookingStepMinutes) {
    const localDateTime = `${day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
    const startsAt = fromZonedTime(localDateTime, business.timezone);
    const occupiesFrom = addMinutes(startsAt, -service.bufferBeforeMinutes);
    const occupiesTo = addMinutes(startsAt, service.durationMinutes + service.bufferAfterMinutes);
    let availableCount = 0;

    for (let resourceIndex = 0; resourceIndex < business.resources.length; resourceIndex += 1) {
      const resource = business.resources[resourceIndex];
      const compatible = service.resourceTypes.includes('any') || resource.resourceType === 'any' || service.resourceTypes.includes(resource.resourceType);
      const overlaps = appointments.some((appointment) => {
        if (appointment.resourceIndex !== resourceIndex) return false;
        const appointmentStart = new Date(appointment.startsAt);
        const priorService = business.services.find((candidate) => candidate.slug === appointment.serviceSlug);
        const priorFrom = addMinutes(appointmentStart, -(priorService?.bufferBeforeMinutes ?? 0));
        const priorTo = addMinutes(appointmentStart, (priorService?.durationMinutes ?? 0) + (priorService?.bufferAfterMinutes ?? 0));
        return occupiesFrom < priorTo && occupiesTo > priorFrom;
      });
      if (compatible && startsAt.getTime() > Date.now() && !overlaps) availableCount += 1;
    }
    slots.push({startsAt: startsAt.toISOString(), availableCount});
  }
  return slots;
}

export function createDemoAppointment(input: {
  business: BusinessConfig;
  service: Service;
  startsAt: string;
  customerName: string;
  customerPhone: string;
  vehicle: string;
  idempotencyKey: string;
}): {appointment: Appointment; accessToken: string} {
  const existing = readDemoAppointments(input.business.slug).find((item) => item.id === input.idempotencyKey);
  if (existing) return {appointment: existing, accessToken: existing.accessToken ?? ''};

  const start = new Date(input.startsAt);
  const current = readDemoAppointments(input.business.slug);
  const service = input.service;
  const from = addMinutes(start, -service.bufferBeforeMinutes);
  const to = addMinutes(start, service.durationMinutes + service.bufferAfterMinutes);
  const resourceIndex = input.business.resources.findIndex((resource, index) => {
    const compatible = service.resourceTypes.includes('any') || resource.resourceType === 'any' || service.resourceTypes.includes(resource.resourceType);
    if (!compatible) return false;
    return !current.some((appointment) => {
      if (['cancelled', 'completed', 'no_show'].includes(appointment.status) || appointment.resourceIndex !== index) return false;
      const priorService = input.business.services.find((candidate) => candidate.slug === appointment.serviceSlug);
      const priorFrom = addMinutes(new Date(appointment.startsAt), -(priorService?.bufferBeforeMinutes ?? 0));
      const priorTo = addMinutes(new Date(appointment.startsAt), (priorService?.durationMinutes ?? 0) + (priorService?.bufferAfterMinutes ?? 0));
      return from < priorTo && to > priorFrom;
    });
  });
  if (resourceIndex < 0) throw new Error('Этот интервал только что заняли. Выберите другое время.');

  const accessToken = createClientId() + createClientId().replaceAll('-', '');
  const appointment: DemoAppointment = {
    id: input.idempotencyKey,
    tenantId: input.business.id ?? input.business.slug,
    serviceSlug: service.slug,
    serviceName: service.name,
    startsAt: start.toISOString(),
    endsAt: addMinutes(start, service.durationMinutes).toISOString(),
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    vehicle: input.vehicle,
    status: 'confirmed',
    priceMinor: service.priceMinor,
    resourceLabel: input.business.resources[resourceIndex]?.name,
    accessToken,
    demo: true,
    resourceIndex,
    createdAt: new Date().toISOString(),
  };
  writeDemoAppointments(input.business.slug, [...current, appointment]);
  return {appointment, accessToken};
}

export function ownerDemoData(business: BusinessConfig, from: Date, to: Date) {
  const appointments = readDemoAppointments(business.slug)
    .filter((item) => new Date(item.startsAt) >= from && new Date(item.startsAt) < to)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const metrics: OwnerMetrics = {
    arrivals: appointments.filter((item) => !['cancelled', 'no_show'].includes(item.status)).length,
    completed: appointments.filter((item) => item.status === 'completed').length,
    collectedMinor: appointments.reduce((total, appointment) => total + (appointment.collectedMinor ?? 0), 0),
  };
  return {appointments, metrics};
}

export function updateDemoAppointment(slug: string, appointmentId: string, update: Partial<Appointment>) {
  const appointments = readDemoAppointments(slug).map((item) => item.id === appointmentId ? {...item, ...update} : item);
  writeDemoAppointments(slug, appointments);
  return appointments;
}

