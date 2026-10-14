import {z} from 'zod';

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const timezoneSchema = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat('en', {timeZone: value}); return true; } catch { return false; }
}, 'Укажите существующую IANA-зону времени.');

export const serviceSchema = z.object({
  id: z.string().optional(),
  slug: slugSchema,
  name: z.string().min(1),
  description: z.string(),
  priceMinor: z.number().int().nonnegative(),
  durationMinutes: z.number().int().positive(),
  bufferBeforeMinutes: z.number().int().nonnegative(),
  bufferAfterMinutes: z.number().int().nonnegative(),
  category: z.string(),
  resourceTypes: z.array(z.string()).default(['any']),
  active: z.boolean().default(true),
});

export const businessSchema = z.object({
  id: z.string().optional(),
  schemaVersion: z.literal(1).default(1),
  slug: slugSchema,
  name: z.string().min(1),
  tagline: z.string().min(1),
  description: z.string().min(1),
  city: z.string().min(1),
  address: z.string().min(1),
  phone: z.string().min(5),
  mapUrl: z.string().url().optional(),
  timezone: timezoneSchema,
  currency: z.string().length(3),
  locale: z.string().min(2),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  heroImage: z.string().min(1),
  logoImage: z.string().min(1),
  demo: z.boolean(),
  status: z.enum(['draft', 'preview', 'live']),
  bookingStepMinutes: z.number().int().min(5).max(120),
  cancellationWindowHours: z.number().int().nonnegative(),
  openingHours: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    opensAt: z.string().regex(/^\d{2}:\d{2}$/),
    closesAt: z.string().regex(/^\d{2}:\d{2}$/),
  })),
  services: z.array(serviceSchema).min(1),
  resources: z.array(z.object({id: z.string().optional(), slug: slugSchema, name: z.string().min(1), resourceType: z.string().min(1), active: z.boolean().default(true)})).min(1),
  gallery: z.array(z.object({id: slugSchema, image: z.string().min(1), caption: z.string().min(1), position: z.number().int().nonnegative()})),
  infoCards: z.array(z.object({id: slugSchema, title: z.string().min(1), body: z.string().min(1)})).length(3),
  assistantPrompts: z.array(z.string().min(1)).min(1),
});

export type BusinessConfig = z.infer<typeof businessSchema>;
export type Service = z.infer<typeof serviceSchema>;

export type Appointment = {
  id: string;
  tenantId: string;
  serviceSlug: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  customerName: string;
  customerPhone: string;
  vehicle: string;
  status: 'confirmed' | 'checked_in' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  priceMinor: number;
  resourceLabel?: string;
  accessToken?: string;
  demo?: boolean;
  /** Customer comment captured at booking time (may be empty). */
  customerNote?: string;
};

export type AvailabilitySlot = {startsAt: string; availableCount: number};

export type OwnerMetrics = {
  arrivals: number;
  completed: number;
  collectedMinor: number;
};
