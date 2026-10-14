import {z} from 'npm:zod@4.6.6';
import {adminClient, checkRateLimit, errorMessage, errorStatus, forbiddenOrigin, json, preflight, userFromRequest} from '../_shared/http.ts';

// Super Admin platform API. Mirrors supabase/functions/owner-api/index.ts
// structure: single POST endpoint, {action, ...params} envelope, zod schemas,
// service-role client used only server-side here.
//
// Security notes:
// - verify_jwt=true (see supabase/config.toml). Non-admin callers and missing
//   users get a generic 404 {error:'Not found.'} so the endpoint never reveals
//   whether an admin identity exists (no admin oracle).
// - Reuses tenants.status 'paused' as the suspended state; archiving is
//   archived_at NOT NULL + paused. No new enum, no DELETE endpoint.
// - Every mutation requires a client-generated requestId (uuid) and writes
//   one admin_audit_log row. Idempotency comes from the partial UNIQUE index
//   admin_audit_log(request_id) WHERE request_id <> '': a pre-check returns
//   {deduped:true} for replays, and a 23505 race on the plain INSERT is also
//   mapped to {deduped:true}.
// - Audit metadata is an explicit allow-list (tenant_id/from/to/reason/
//   request_id). Never put passwords, tokens, or keys in audit rows.
// - Studio lifecycle: create-tenant (draft shell, safe DB defaults; optional
//   starter `template`: 'detailing' seeds 4 services + 3 resources + opening
//   hours + placeholder media/URLs + generic copy, 'empty' keeps the bare
//   shell), validate-tenant (read-only readiness report mirroring
//   scripts/tenants.mjs validate), publish-tenant (draft→preview, single-column
//   status update), activate-tenant (preview→live, demo refused, placeholder
//   contact refused), export-tenant (business.json shape for the CLI pipeline,
//   resources carry `location`).
//   Publish/activate never touch services/resources/appointments/payments.
// - Owner accounts: list-owners (read-only roster), create-owner
//   (username + password + optional recovery contact email), update-owner
//   (new password and/or recovery email and/or role), delete-owner (remove
//   membership; deletes the auth user only when it has no other memberships).
//   Auth email is always the synthetic internal address
//   <username>@owners.local (created email-confirmed); the recovery email is
//   contact info only and is never used for login.

const NOT_FOUND = {error: 'Not found.'} as const;

const uuid = z.uuid();
const dateTime = z.iso.datetime({offset: true});
const slug = z.string().regex(/^[a-z0-9-]+$/);
// DB tenants.slug CHECK is stricter than the loose slug above; creation and
// validation use this so rejected values fail fast with 400, not 500.
const strictSlug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).min(1).max(100);
const tenantStatus = z.enum(['draft', 'preview', 'live', 'paused']);
const appointmentStatus = z.enum(['confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show']);
const auditAction = z.enum(['admin.login', 'admin.suspend', 'admin.reactivate', 'admin.archive', 'admin.unarchive', 'admin.view', 'admin.create', 'admin.publish', 'admin.activate', 'admin.update', 'admin.save-service', 'admin.save-resource', 'admin.save-date-override', 'admin.create-owner', 'admin.update-owner', 'admin.delete-owner']);
// Owner login identity: canonical lowercase username; auth uses a synthetic
// internal address so no real email is ever required. Must stay in sync with
// `ownerEmailFor` in src/lib/tenant-api.ts.
const OWNER_AUTH_DOMAIN = 'owners.local';
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const ownerUsername = z.string().trim().toLowerCase().regex(USERNAME_PATTERN, 'username must be 3..32 chars: a-z, 0-9, dot, underscore, hyphen');
const ownerPassword = z.string().min(8, 'password must be at least 8 characters').max(72);
const recoveryEmail = z.union([z.literal(''), z.email().max(320)]).default('');
function ownerAuthEmail(username: string) {
  return `${username}@${OWNER_AUTH_DOMAIN}`;
}
const reasonInput = z.string().trim().min(5).max(500);
const optionalNote = z.string().trim().max(500).default('');
const pagination = {
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
};

// Explicit column lists. APPOINTMENT_COLUMNS must NEVER include
// access_token_hash.
const TENANT_COLUMNS =
  'id,slug,name,status,is_demo,city,phone,opening_hours,suspended_at,suspended_by,suspend_reason,archived_at,archived_by,created_at,updated_at';
const APPOINTMENT_COLUMNS =
  'id,tenant_id,service_id,resource_id,customer_name,customer_phone,vehicle,starts_at,ends_at,price_minor,status,idempotency_key,customer_note,checked_in_at,completed_at,cancelled_at,created_at,updated_at';
const PAYMENT_COLUMNS =
  'id,tenant_id,appointment_id,kind,amount_minor,method,note,recorded_by,received_at,created_at';
const SERVICE_COLUMNS =
  'id,tenant_id,slug,name,description,category,price_minor,duration_minutes,buffer_before_minutes,buffer_after_minutes,resource_types,active,created_at,updated_at';
const RESOURCE_COLUMNS =
  'id,tenant_id,slug,name,resource_type,location,active,created_at,updated_at';
// Full tenant row for lifecycle actions (validate/publish/activate/export).
// TENANT_COLUMNS above is left untouched for the existing dashboard views.
const FULL_TENANT_COLUMNS =
  'id,slug,name,tagline,description,city,address,phone,map_url,timezone,currency,locale,accent_color,hero_image_url,logo_url,is_demo,status,booking_step_minutes,cancellation_window_hours,opening_hours,gallery,info_cards,assistant_prompts,archived_at,created_at,updated_at';
const AUDIT_COLUMNS =
  'id,admin_user_id,action,tenant_id,appointment_id,reason,metadata,success,request_id,created_at';

const envelopeSchema = z.object({action: z.string().min(1).max(32)}).catchall(z.unknown());

const statusSchema = z.object({}).strict();
const dashboardSchema = z.object({}).strict();
const listTenantsSchema = z.object({
  status: tenantStatus.optional(),
  archived: z.boolean().optional(),
  search: z.string().trim().min(1).max(100).optional(),
  ...pagination,
}).strict();
const getTenantSchema = z.union([
  z.object({tenantId: uuid}).strict(),
  z.object({slug}).strict(),
]);
const listAppointmentsSchema = z.object({
  tenantId: uuid,
  status: appointmentStatus.optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
  ...pagination,
}).strict();
const getOrderSchema = z.object({appointmentId: uuid}).strict();
const listPaymentsSchema = z.object({
  tenantId: uuid,
  from: dateTime.optional(),
  to: dateTime.optional(),
  ...pagination,
}).strict();
const listServicesSchema = z.object({
  tenantId: uuid,
  includeInactive: z.boolean().default(true),
}).strict();
const listResourcesSchema = z.object({
  tenantId: uuid,
  includeInactive: z.boolean().default(true),
}).strict();
const suspendSchema = z.object({tenantId: uuid, reason: reasonInput, requestId: uuid}).strict();
const reactivateSchema = z.object({tenantId: uuid, targetStatus: z.enum(['preview', 'live']), requestId: uuid}).strict();
const archiveSchema = z.object({tenantId: uuid, reason: optionalNote, requestId: uuid}).strict();
const unarchiveSchema = z.object({tenantId: uuid, requestId: uuid}).strict();
const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: strictSlug,
  timezone: z.string().min(3).max(100).default('Europe/Moscow'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('RUB'),
  template: z.enum(['detailing', 'empty']).default('detailing'),
  requestId: uuid,
}).strict();
const validateTenantSchema = z.object({tenantId: uuid}).strict();
const publishTenantSchema = z.object({tenantId: uuid, requestId: uuid}).strict();
const activateTenantSchema = z.object({tenantId: uuid, requestId: uuid}).strict();
const exportTenantSchema = z.union([
  z.object({tenantId: uuid}).strict(),
  z.object({slug}).strict(),
]);
// Content edits mirror supabase/functions/owner-api validation so admin
// writes obey the same server-side rules (scoped by tenantId, any status
// including draft). Lifecycle fields (status/is_demo) are intentionally
// excluded here — they change only via create/publish/activate/suspend flows.
const adminProfileSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(), tagline: z.string().trim().max(160).default('').optional(), description: z.string().trim().max(1500).default('').optional(),
  city: z.string().trim().max(100).default('').optional(), address: z.string().trim().max(300).default('').optional(), phone: z.string().trim().max(40).default('').optional(),
  mapUrl: z.union([z.string().max(1000), z.literal('')]).optional(), timezone: z.string().min(3).max(100).refine((value) => { try { new Intl.DateTimeFormat('en', {timeZone: value}); return true; } catch { return false; } }).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), locale: z.string().min(2).max(20).optional(),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), heroImage: z.string().max(2000).default('').optional(), logoImage: z.string().max(2000).default('').optional(),
  bookingStepMinutes: z.number().int().min(5).max(120).optional(), cancellationWindowHours: z.number().int().min(0).max(720).optional(),
  openingHours: z.array(z.object({weekday: z.number().int().min(0).max(6), opensAt: z.string().regex(/^\d{2}:\d{2}$/), closesAt: z.string().regex(/^\d{2}:\d{2}$/)})).max(7).optional(),
  gallery: z.array(z.object({id: z.string().regex(/^[a-z0-9-]+$/), image: z.string().min(1).max(2000), caption: z.string().min(1).max(180), position: z.number().int().nonnegative()})).max(30).optional(),
  infoCards: z.array(z.object({id: z.string().regex(/^[a-z0-9-]+$/), title: z.string().min(1).max(80), body: z.string().min(1).max(400)})).length(3).optional(),
  assistantPrompts: z.array(z.string().min(1).max(160)).min(1).max(8).optional(),
  isDemo: z.boolean().optional(),
}).strict();
const adminServiceSchema = z.object({slug: strictSlug, name: z.string().trim().min(1).max(100), description: z.string().max(1000).default(''), category: z.string().min(1).max(80), priceMinor: z.number().int().nonnegative(), durationMinutes: z.number().int().positive().max(10080), bufferBeforeMinutes: z.number().int().nonnegative().max(1440), bufferAfterMinutes: z.number().int().nonnegative().max(1440), resourceTypes: z.array(z.string().min(1).max(40)).min(1).max(8), active: z.boolean().default(true)}).strict();
const updateTenantSchema = z.object({tenantId: uuid, profile: adminProfileSchema}).strict();
const saveServiceSchema = z.object({tenantId: uuid, service: adminServiceSchema}).strict();
const saveResourceSchema = z.object({tenantId: uuid, resource: z.object({slug: strictSlug, name: z.string().trim().min(1).max(100), resourceType: z.string().min(1).max(40), location: z.string().trim().max(120).default(''), active: z.boolean().default(true)}).strict()}).strict();
const saveDateOverrideSchema = z.object({tenantId: uuid, override: z.object({localDate: z.iso.date(), isClosed: z.boolean(), opensAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(), closesAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(), label: z.string().max(120).default('')}).strict()}).strict();
const listOverridesSchema = z.object({tenantId: uuid}).strict();
const listOwnersSchema = z.object({tenantId: uuid}).strict();
const createOwnerSchema = z.object({
  tenantId: uuid,
  username: ownerUsername,
  password: ownerPassword,
  recoveryEmail,
  role: z.enum(['owner', 'manager']).default('owner'),
  requestId: uuid,
}).strict();
const updateOwnerSchema = z.object({
  tenantId: uuid,
  username: ownerUsername,
  password: ownerPassword.optional(),
  recoveryEmail: z.union([z.literal(''), z.email().max(320)]).optional(),
  role: z.enum(['owner', 'manager', 'staff']).optional(),
}).strict();
const deleteOwnerSchema = z.object({tenantId: uuid, username: ownerUsername, requestId: uuid}).strict();
const auditListSchema = z.object({
  tenantId: uuid.optional(),
  action: auditAction.optional(),
  ...pagination,
}).strict();

type Admin = ReturnType<typeof adminClient>;
type HeadCount = {count: number | null; error: unknown};

async function headCount(source: PromiseLike<HeadCount> | HeadCount): Promise<number> {
  const {count, error} = await source;
  if (error) throw error;
  return count ?? 0;
}
type AuditRow = {
  admin_user_id: string;
  action: string;
  tenant_id: string | null;
  appointment_id: string | null;
  reason: string;
  metadata: Record<string, unknown>;
  success: boolean;
  request_id: string;
};

async function adminTenantById(admin: Admin, tenantId: string) {
  // Admin view spans ALL statuses (unlike tenantBySlug, which allow-lists
  // preview/live for public/owner paths). Never add status filtering here.
  const {data, error} = await admin.from('tenants').select(TENANT_COLUMNS).eq('id', tenantId).maybeSingle();
  if (error) throw error;
  return data;
}

async function adminTenantBySlug(admin: Admin, tenantSlug: string) {
  const {data, error} = await admin.from('tenants').select(TENANT_COLUMNS).eq('slug', tenantSlug).maybeSingle();
  if (error) throw error;
  return data;
}

async function findAuditByRequestId(admin: Admin, requestId: string) {
  const {data, error} = await admin.from('admin_audit_log').select('id,action,tenant_id,created_at').eq('request_id', requestId).maybeSingle();
  if (error) throw error;
  return data;
}

async function insertAudit(admin: Admin, row: AuditRow): Promise<{deduped: boolean}> {
  // Plain INSERT on purpose: the partial UNIQUE index
  // admin_audit_log(request_id) WHERE request_id <> '' enforces idempotency.
  // (ON CONFLICT (request_id) inference would not match a partial index, so
  // a 23505 violation is treated as the conflict signal instead.)
  const {error} = await admin.from('admin_audit_log').insert(row);
  if (error) {
    if ((error as {code?: string})?.code === '23505') return {deduped: true};
    throw error;
  }
  return {deduped: false};
}

/** Best-effort failure audit for rejected mutations. Never blocks the response. */
async function auditFailure(admin: Admin, userId: string, action: AuditRow['action'], tenantId: string | null, reason: string, detail: string) {
  try {
    await admin.from('admin_audit_log').insert({
      admin_user_id: userId, action, tenant_id: tenantId, appointment_id: null,
      reason: reason.slice(0, 500),
      metadata: {tenant_id: tenantId, error: detail.slice(0, 200)},
      success: false, request_id: '',
    });
  } catch {
    // Audit must never break the error response.
  }
}

function mapAdminProfile(profile: z.infer<typeof adminProfileSchema>) {
  // camelCase API keys → snake_case tenant columns (mirrors owner-api).
  const columnMap: Record<string, string> = {
    name: 'name', tagline: 'tagline', description: 'description', city: 'city', address: 'address', phone: 'phone', mapUrl: 'map_url',
    timezone: 'timezone', currency: 'currency', locale: 'locale', accentColor: 'accent_color', heroImage: 'hero_image_url', logoImage: 'logo_url',
    bookingStepMinutes: 'booking_step_minutes', cancellationWindowHours: 'cancellation_window_hours', openingHours: 'opening_hours',
    gallery: 'gallery', infoCards: 'info_cards', assistantPrompts: 'assistant_prompts', isDemo: 'is_demo',
  };
  return Object.fromEntries(Object.entries(profile).map(([key, value]) => [columnMap[key], value]));
}

// ---- Studio lifecycle helpers (mirror scripts/tenants.mjs, do not fork) ----

// Placeholders written by `tenants.mjs new`; activate refuses them.
const PLACEHOLDER_NAME = 'Новая студия';
const PLACEHOLDER_CITY = 'Город';
const PLACEHOLDER_ADDRESS = 'Укажите адрес студии';
const PLACEHOLDER_PHONE = '+7 000 000-00-00';
const OPENING_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const STRICT_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---- Starter template (create-tenant ONLY) ----
//
// PWA/asset contract with the frontend agent: the backend stores ONLY these
// URL strings; the actual SVG files are created and owned by the frontend
// under public/placeholders/:
//   /placeholders/detailing-hero.svg
//   /placeholders/detailing-logo.svg
//   /placeholders/detailing-work-1.svg
//   /placeholders/detailing-work-2.svg
//   /placeholders/detailing-work-3.svg
// Seeding runs ONLY inside the create-tenant handler when template is
// 'detailing' (the default). There are no triggers and no upsert-on-read
// reseeding: update-tenant / save-service / save-resource / publish-tenant /
// activate-tenant never add rows, so edits and republishes can never reseed.
// 'empty' keeps the historical bare-shell behavior (no services/resources,
// empty opening_hours/gallery/info_cards/prompts, blank hero/logo URLs).
// Idempotency: the requestId pre-check plus the slug-clash 409 already dedupe
// retries; services/resources use upsert on (tenant_id,slug) so a resumed
// attempt cannot duplicate rows. Seeding never calls booking RPCs and never
// creates appointments/payments/notifications or real customer data. Tenant
// isolation holds via tenant_id on every row. Identity fields (tagline,
// description, city, address, phone, map_url) stay EMPTY for the admin to
// fill; activate-tenant still refuses demo tenants and placeholder contact.
const TEMPLATE_OPENING_HOURS = [
  {weekday: 1, opensAt: '09:00', closesAt: '20:00'},
  {weekday: 2, opensAt: '09:00', closesAt: '20:00'},
  {weekday: 3, opensAt: '09:00', closesAt: '20:00'},
  {weekday: 4, opensAt: '09:00', closesAt: '20:00'},
  {weekday: 5, opensAt: '09:00', closesAt: '20:00'},
  {weekday: 6, opensAt: '10:00', closesAt: '18:00'},
];
const TEMPLATE_SERVICES = [
  {slug: 'exterior-wash', name: 'Мойка кузова', description: 'Деликатная мойка, сушка и уход за внешними поверхностями.', category: 'Уход', priceMinor: 150000, durationMinutes: 60, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, resourceTypes: ['any']},
  {slug: 'interior-cleaning', name: 'Чистка салона', description: 'Тщательная очистка салона и защита материалов.', category: 'Салон', priceMinor: 890000, durationMinutes: 240, bufferBeforeMinutes: 15, bufferAfterMinutes: 30, resourceTypes: ['any']},
  {slug: 'full-detailing', name: 'Полный детейлинг', description: 'Комплексный уход за кузовом и салоном с финальным контролем.', category: 'Комплекс', priceMinor: 1890000, durationMinutes: 480, bufferBeforeMinutes: 30, bufferAfterMinutes: 60, resourceTypes: ['any']},
  {slug: 'polishing', name: 'Полировка кузова', description: 'Восстановление блеска и устранение мелких дефектов лака.', category: 'Кузов', priceMinor: 2490000, durationMinutes: 600, bufferBeforeMinutes: 30, bufferAfterMinutes: 60, resourceTypes: ['any', 'coating']},
];
const TEMPLATE_RESOURCES = [
  {slug: 'post-1', name: 'Пост 1', resourceType: 'any'},
  {slug: 'post-2', name: 'Пост 2', resourceType: 'any'},
  {slug: 'coating-post', name: 'Пост покрытия', resourceType: 'coating'},
];
const TEMPLATE_GALLERY = [
  {id: 'work-1', image: '/placeholders/detailing-work-1.svg', caption: 'Зал и посты — замените на фото студии', position: 0},
  {id: 'work-2', image: '/placeholders/detailing-work-2.svg', caption: 'Детали работы — замените на фото студии', position: 1},
  {id: 'work-3', image: '/placeholders/detailing-work-3.svg', caption: 'Готовый результат — замените на фото студии', position: 2},
];
const TEMPLATE_INFO_CARDS = [
  {id: 'care', title: 'Аккуратно', body: 'Опишите подход к работе и внимание к деталям.'},
  {id: 'transparent', title: 'Прозрачно', body: 'Укажите, как согласуете перечень работ и стоимость.'},
  {id: 'booking', title: 'По записи', body: 'Напишите, как выбрать удобное окно для визита.'},
];
const TEMPLATE_PROMPTS = ['Какие есть услуги?', 'Сколько стоит мойка?', 'Как найти студию?'];

function isValidTimezone(value: unknown) {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en', {timeZone: value});
    return true;
  } catch {
    return false;
  }
}

function isCompatibleResource(serviceTypes: unknown, resourceType: unknown) {
  // Same rule as scripts/tenants.mjs validate: service.resourceTypes includes
  // 'any' or resource.resourceType is 'any' or the type sets overlap.
  const types = Array.isArray(serviceTypes) ? serviceTypes : [];
  return types.includes('any') || resourceType === 'any' || types.includes(resourceType);
}

async function adminTenantFullById(admin: Admin, tenantId: string) {
  const {data, error} = await admin.from('tenants').select(FULL_TENANT_COLUMNS).eq('id', tenantId).maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

async function adminTenantFullBySlug(admin: Admin, tenantSlug: string) {
  const {data, error} = await admin.from('tenants').select(FULL_TENANT_COLUMNS).eq('slug', tenantSlug).maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

type TenantValidation = {errors: string[]; warnings: string[]; info: string[]};

async function buildTenantValidation(admin: Admin, tenant: Record<string, unknown>): Promise<TenantValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const tenantId = tenant['id'] as string;

  // Identity: slug valid + unique, name present.
  const slugValue = tenant['slug'] as string;
  if (typeof slugValue !== 'string' || !STRICT_SLUG_PATTERN.test(slugValue)) {
    errors.push('slug-invalid: slug must be lowercase URL-safe (a-z, 0-9, hyphens).');
  } else {
    const {data: clash, error: clashError} = await admin.from('tenants').select('id').eq('slug', slugValue).neq('id', tenantId).maybeSingle();
    if (clashError) throw clashError;
    if (clash) errors.push('slug-taken: another tenant already uses this slug.');
  }
  const nameValue = typeof tenant['name'] === 'string' ? (tenant['name'] as string).trim() : '';
  if (nameValue.length < 2) errors.push('name-missing: studio name needs at least 2 characters.');

  if (!isValidTimezone(tenant['timezone'])) errors.push('timezone-invalid: must be a valid IANA time zone.');
  if (typeof tenant['currency'] !== 'string' || !/^[A-Z]{3}$/.test(tenant['currency'] as string)) {
    errors.push('currency-invalid: must be a 3-letter uppercase code (e.g. RUB).');
  }

  // Booking ranges mirror the DB CHECKs (step 5..120, cancellation >= 0).
  const step = tenant['booking_step_minutes'] as number;
  const cancel = tenant['cancellation_window_hours'] as number;
  if (!Number.isInteger(step) || step < 5 || step > 120) errors.push('booking-step-invalid: booking_step_minutes must be 5..120.');
  if (!Number.isInteger(cancel) || cancel < 0) errors.push('cancellation-invalid: cancellation_window_hours must be >= 0.');

  // Opening hours: >= 1 row, unique weekdays, opensAt < closesAt.
  const hours = tenant['opening_hours'] as Array<{weekday?: unknown; opensAt?: unknown; closesAt?: unknown}> | null;
  if (!Array.isArray(hours) || hours.length === 0) {
    errors.push('opening-hours-missing: at least one opening-hours row is required.');
  } else {
    const seen = new Set<number>();
    for (const row of hours) {
      const weekday = row?.weekday as number;
      const opensAt = row?.opensAt as string;
      const closesAt = row?.closesAt as string;
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        errors.push('opening-hours-invalid: weekday must be an integer 0..6.');
        continue;
      }
      if (seen.has(weekday)) errors.push(`opening-hours-duplicate: weekday ${weekday} has more than one row.`);
      seen.add(weekday);
      if (typeof opensAt !== 'string' || !OPENING_TIME.test(opensAt) || typeof closesAt !== 'string' || !OPENING_TIME.test(closesAt)) {
        errors.push(`opening-hours-invalid: weekday ${weekday} needs HH:MM opensAt/closesAt.`);
      } else if (opensAt >= closesAt) {
        errors.push(`opening-hours-invalid: weekday ${weekday} opensAt must be earlier than closesAt.`);
      }
    }
  }

  // Services/resources: >= 1 active service, each with >= 1 compatible active resource.
  const [{data: services, error: servicesError}, {data: resources, error: resourcesError}] = await Promise.all([
    admin.from('services').select('slug,name,resource_types,active,duration_minutes,price_minor').eq('tenant_id', tenantId).order('slug'),
    admin.from('resources').select('slug,name,resource_type,active').eq('tenant_id', tenantId).order('slug'),
  ]);
  if (servicesError) throw servicesError;
  if (resourcesError) throw resourcesError;
  const activeServices = ((services ?? []) as Array<Record<string, unknown>>).filter((row) => row['active'] === true);
  const activeResources = ((resources ?? []) as Array<Record<string, unknown>>).filter((row) => row['active'] === true);
  if (activeServices.length === 0) {
    errors.push('services-missing: at least one active service is required.');
  } else {
    for (const service of activeServices) {
      if (typeof service['name'] !== 'string' || (service['name'] as string).trim().length < 1) {
        errors.push(`service-invalid: "${String(service['slug'] ?? '?')}" needs a name.`);
      }
      const compatible = activeResources.some((resource) => isCompatibleResource(service['resource_types'], resource['resource_type']));
      if (!compatible) errors.push(`service-no-resource: "${String(service['name'] ?? service['slug'])}" has no compatible active resource.`);
    }
  }
  info.push(`counts: ${activeServices.length} active services, ${activeResources.length} active resources, ${Array.isArray(hours) ? hours.length : 0} open days.`);

  // Marketing/content fields are OPTIONAL: warnings only, never blocking, so a
  // freshly created draft shell can reach preview without placeholder copy.
  const optionalText: Array<[string, unknown]> = [
    ['tagline', tenant['tagline']], ['description', tenant['description']],
    ['city', tenant['city']], ['address', tenant['address']], ['phone', tenant['phone']],
    ['map_url', tenant['map_url']], ['hero_image_url', tenant['hero_image_url']], ['logo_url', tenant['logo_url']],
  ];
  for (const [field, value] of optionalText) {
    if (typeof value !== 'string' || value.trim().length === 0) warnings.push(`${field}-empty: fill before going live.`);
  }
  const gallery = tenant['gallery'] as unknown[];
  if (!Array.isArray(gallery) || gallery.length === 0) warnings.push('gallery-empty: add photos before going live.');
  const infoCards = tenant['info_cards'] as unknown[];
  if (!Array.isArray(infoCards) || infoCards.length !== 3) warnings.push('info-cards: exactly 3 cards are expected before going live.');
  const prompts = tenant['assistant_prompts'] as unknown[];
  if (!Array.isArray(prompts) || prompts.length === 0) warnings.push('assistant-prompts-empty: add at least one prompt before going live.');

  // State notes.
  if (tenant['archived_at']) errors.push('tenant-archived: unarchive before publishing or activating.');
  const status = tenant['status'] as string;
  const isDemo = tenant['is_demo'] as boolean;
  if (isDemo && status === 'live') errors.push('demo-live-conflict: demo tenants cannot be live; clear the demo flag first.');
  else if (isDemo) info.push('demo: notifications stay disabled while is_demo is true.');
  if (status === 'paused') info.push('status-paused: reactivate explicitly; publish/activate refuse paused tenants.');
  else if (status === 'live') info.push('status-live: already live.');
  else if (status === 'preview') info.push('status-preview: verified preview, eligible for activation.');
  else if (status === 'draft') info.push('status-draft: eligible for publishing once errors are clear.');

  return {errors, warnings, info};
}

function isPlaceholderContact(tenant: Record<string, unknown>) {
  // Minimal placeholder rejection mirroring scripts/tenants.mjs activate.
  const problems: string[] = [];
  const name = typeof tenant['name'] === 'string' ? (tenant['name'] as string).trim() : '';
  const city = typeof tenant['city'] === 'string' ? (tenant['city'] as string).trim() : '';
  const address = typeof tenant['address'] === 'string' ? (tenant['address'] as string).trim() : '';
  const phone = typeof tenant['phone'] === 'string' ? (tenant['phone'] as string).trim() : '';
  if (!name || name === PLACEHOLDER_NAME) problems.push('name');
  if (!city || city === PLACEHOLDER_CITY) problems.push('city');
  if (!address || address === PLACEHOLDER_ADDRESS) problems.push('address');
  if (!phone || phone === PLACEHOLDER_PHONE) problems.push('phone');
  return problems;
}

function toBusinessJson(
  tenant: Record<string, unknown>,
  services: Array<Record<string, unknown>>,
  resources: Array<Record<string, unknown>>,
) {
  // DB status has 4 values, business.json only 3: paused (including archived,
  // which is stored as paused + archived_at) exports as draft so CLI verify
  // keeps refusing to share it. Only active services/resources are exported:
  // inactive rows are soft-deleted leftovers from publish cleanup.
  const status = tenant['status'] === 'live' ? 'live' : tenant['status'] === 'preview' ? 'preview' : 'draft';
  return {
    schemaVersion: 1,
    slug: tenant['slug'],
    name: tenant['name'],
    tagline: tenant['tagline'] ?? '',
    description: tenant['description'] ?? '',
    city: tenant['city'] ?? '',
    address: tenant['address'] ?? '',
    phone: tenant['phone'] ?? '',
    mapUrl: tenant['map_url'] ?? '',
    timezone: tenant['timezone'],
    currency: tenant['currency'],
    locale: tenant['locale'],
    accentColor: tenant['accent_color'],
    heroImage: tenant['hero_image_url'] ?? '',
    logoImage: tenant['logo_url'] ?? '',
    demo: tenant['is_demo'] ?? true,
    status,
    bookingStepMinutes: tenant['booking_step_minutes'],
    cancellationWindowHours: tenant['cancellation_window_hours'],
    openingHours: tenant['opening_hours'] ?? [],
    services: services.filter((row) => row['active'] === true).map((row) => ({
      slug: row['slug'],
      name: row['name'],
      description: row['description'] ?? '',
      priceMinor: row['price_minor'],
      durationMinutes: row['duration_minutes'],
      bufferBeforeMinutes: row['buffer_before_minutes'] ?? 0,
      bufferAfterMinutes: row['buffer_after_minutes'] ?? 0,
      category: row['category'] ?? 'Услуга',
      resourceTypes: row['resource_types'] ?? ['any'],
    })),
    resources: resources.filter((row) => row['active'] === true).map((row) => ({
      slug: row['slug'],
      name: row['name'],
      resourceType: row['resource_type'] ?? 'any',
      // Safe for `tenant:validate`: the CLI configSchema resource objects are
      // non-strict, so this extra key is stripped (not rejected) on import.
      // NOTE follow-up: scripts/tenants.mjs publish maps only
      // slug/name/resourceType, so location does not round-trip through the
      // CLI pipeline yet — the CLI agent owns that side.
      location: row['location'] ?? '',
    })),
    gallery: tenant['gallery'] ?? [],
    infoCards: tenant['info_cards'] ?? [],
    assistantPrompts: tenant['assistant_prompts'] ?? [],
  };
}

function paymentTotals(rows: Array<{kind: string; amount_minor: number}>) {
  let grossMinor = 0;
  let refundMinor = 0;
  for (const row of rows ?? []) {
    if (row.kind === 'refund') refundMinor += row.amount_minor;
    else grossMinor += row.amount_minor;
  }
  return {grossMinor, refundMinor, netMinor: grossMinor - refundMinor};
}

function sanitizeSearch(value: string) {
  // Strip postgREST .or() control characters so free text cannot break the
  // filter expression.
  return value.replace(/[%_,()]/g, '').trim();
}

Deno.serve(async (request) => {
  if (forbiddenOrigin(request)) return json(request, {error: 'Origin is not allowed.'}, 403);
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, {error: 'Method not allowed.'}, 405);
  try {
    const envelope = envelopeSchema.parse(await request.json());
    const {action, ...params} = envelope as {action: string} & Record<string, unknown>;
    const admin = adminClient();
    const user = await userFromRequest(request);
    if (!user) return json(request, NOT_FOUND, 404);
    const {data: adminRow, error: adminError} = await admin.from('platform_admins').select('user_id,label').eq('user_id', user.id).maybeSingle();
    if (adminError) throw adminError;
    if (!adminRow) return json(request, NOT_FOUND, 404);
    if (!await checkRateLimit(admin, request, 'admin-api', user.id, 120, 300)) {
      return json(request, {error: 'Too many requests. Try again later.'}, 429);
    }

    switch (action) {
      case 'status': {
        statusSchema.parse(params);
        return json(request, {admin: true, userId: user.id, label: (adminRow as {label?: string}).label ?? ''});
      }
      case 'dashboard': {
        dashboardSchema.parse(params);
        const tenantsBase = () => admin.from('tenants').select('id', {count: 'exact', head: true});
        const [total, draft, preview, live, paused, archived, suspended] = await Promise.all([
          headCount(tenantsBase()),
          headCount(tenantsBase().eq('status', 'draft')),
          headCount(tenantsBase().eq('status', 'preview')),
          headCount(tenantsBase().eq('status', 'live')),
          headCount(tenantsBase().eq('status', 'paused')),
          headCount(tenantsBase().not('archived_at', 'is', null)),
          headCount(tenantsBase().eq('status', 'paused').is('archived_at', null)),
        ]);
        const now = new Date();
        const upcomingCount = await headCount(
          admin.from('appointments').select('id', {count: 'exact', head: true})
            .gte('starts_at', now.toISOString())
            .lt('starts_at', new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString())
            .neq('status', 'cancelled'),
        );
        const {data: recentPayments, error: paymentsError} = await admin.from('payments').select('kind,amount_minor')
          .gte('received_at', new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString());
        if (paymentsError) throw paymentsError;
        const {data: recentAudit, error: auditError} = await admin.from('admin_audit_log').select(AUDIT_COLUMNS)
          .order('created_at', {ascending: false}).limit(10);
        if (auditError) throw auditError;
        return json(request, {
          tenants: {total, draft, preview, live, paused, archived, suspended},
          appointmentsUpcoming7d: upcomingCount,
          payments30d: paymentTotals((recentPayments ?? []) as Array<{kind: string; amount_minor: number}>),
          recentAudit: recentAudit ?? [],
        });
      }
      case 'list-tenants': {
        const args = listTenantsSchema.parse(params);
        let query = admin.from('tenants').select(TENANT_COLUMNS, {count: 'exact'}).order('updated_at', {ascending: false})
          .range(args.offset, args.offset + args.limit - 1);
        if (args.status) query = query.eq('status', args.status);
        if (typeof args.archived === 'boolean') {
          query = args.archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
        }
        if (args.search) {
          const needle = sanitizeSearch(args.search);
          if (needle) query = query.or(`slug.ilike.%${needle}%,name.ilike.%${needle}%`);
        }
        const {data, count, error} = await query;
        if (error) throw error;
        return json(request, {tenants: data ?? [], total: count ?? 0, limit: args.limit, offset: args.offset});
      }
      case 'get-tenant': {
        const args = getTenantSchema.parse(params);
        const tenant = 'tenantId' in args ? await adminTenantById(admin, args.tenantId) : await adminTenantBySlug(admin, args.slug);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const id = (tenant as {id: string}).id;
        const [services, resources, appointments] = await Promise.all([
          headCount(admin.from('services').select('id', {count: 'exact', head: true}).eq('tenant_id', id)),
          headCount(admin.from('resources').select('id', {count: 'exact', head: true}).eq('tenant_id', id)),
          headCount(admin.from('appointments').select('id', {count: 'exact', head: true}).eq('tenant_id', id)),
        ]);
        const {data: payments, error: paymentsError} = await admin.from('payments').select('kind,amount_minor').eq('tenant_id', id);
        if (paymentsError) throw paymentsError;
        return json(request, {
          tenant,
          counts: {services, resources, appointments},
          payments: paymentTotals((payments ?? []) as Array<{kind: string; amount_minor: number}>),
        });
      }
      case 'list-appointments': {
        const args = listAppointmentsSchema.parse(params);
        let query = admin.from('appointments').select(APPOINTMENT_COLUMNS, {count: 'exact'}).eq('tenant_id', args.tenantId)
          .order('starts_at', {ascending: false}).range(args.offset, args.offset + args.limit - 1);
        if (args.status) query = query.eq('status', args.status);
        if (args.from) query = query.gte('starts_at', args.from);
        if (args.to) query = query.lt('starts_at', args.to);
        const {data, count, error} = await query;
        if (error) throw error;
        const appointments = (data ?? []) as Array<Record<string, unknown>>;
        const ids = appointments.map((row) => row['id'] as string);
        // Order context for the table: extras sum (final total = price + extras),
        // owner notes count, and the payments journal for the dialog.
        let extras: Array<Record<string, unknown>> = [];
        let notes: Array<Record<string, unknown>> = [];
        let payments: Array<Record<string, unknown>> = [];
        if (ids.length > 0) {
          const [extrasResult, notesResult, paymentsResult] = await Promise.all([
            admin.from('appointment_services').select('appointment_id,price_minor').eq('tenant_id', args.tenantId).in('appointment_id', ids),
            admin.from('appointment_notes').select('appointment_id').eq('tenant_id', args.tenantId).in('appointment_id', ids),
            admin.from('payments').select('appointment_id,kind,amount_minor').eq('tenant_id', args.tenantId).in('appointment_id', ids),
          ]);
          if (extrasResult.error) throw extrasResult.error;
          if (notesResult.error) throw notesResult.error;
          if (paymentsResult.error) throw paymentsResult.error;
          extras = (extrasResult.data ?? []) as Array<Record<string, unknown>>;
          notes = (notesResult.data ?? []) as Array<Record<string, unknown>>;
          payments = (paymentsResult.data ?? []) as Array<Record<string, unknown>>;
        }
        const extrasByAppointment = new Map<string, number>();
        for (const row of extras) {
          const key = String(row['appointment_id']);
          extrasByAppointment.set(key, (extrasByAppointment.get(key) ?? 0) + Number(row['price_minor'] ?? 0));
        }
        const notesByAppointment = new Map<string, number>();
        for (const row of notes) {
          const key = String(row['appointment_id']);
          notesByAppointment.set(key, (notesByAppointment.get(key) ?? 0) + 1);
        }
        const paymentsByAppointment = new Map<string, {paidMinor: number; refundedMinor: number}>();
        for (const row of payments) {
          const key = String(row['appointment_id']);
          const current = paymentsByAppointment.get(key) ?? {paidMinor: 0, refundedMinor: 0};
          const amount = Number(row['amount_minor'] ?? 0);
          if (row['kind'] === 'refund') current.refundedMinor += amount;
          else current.paidMinor += amount;
          paymentsByAppointment.set(key, current);
        }
        return json(request, {
          appointments: appointments.map((row) => ({
            ...row,
            extrasMinor: extrasByAppointment.get(String(row['id'])) ?? 0,
            notesCount: notesByAppointment.get(String(row['id'])) ?? 0,
            paidMinor: paymentsByAppointment.get(String(row['id']))?.paidMinor ?? 0,
            refundedMinor: paymentsByAppointment.get(String(row['id']))?.refundedMinor ?? 0,
          })),
          total: count ?? 0,
          limit: args.limit,
          offset: args.offset,
        });
      }
      case 'get-order': {
        const args = z.object({appointmentId: uuid}).strict().parse(params);
        const {data: appointment, error: appointmentError} = await admin.from('appointments')
          .select(APPOINTMENT_COLUMNS).eq('id', args.appointmentId).maybeSingle();
        if (appointmentError) throw appointmentError;
        if (!appointment) return json(request, {error: 'Appointment not found.'}, 404);
        const tenantId = (appointment as {tenant_id: string}).tenant_id;
        const [extrasResult, notesResult, paymentsResult, serviceResult, resourceResult] = await Promise.all([
          admin.from('appointment_services').select('id,service_id,name,price_minor,kind,created_at').eq('tenant_id', tenantId).eq('appointment_id', args.appointmentId).order('created_at'),
          admin.from('appointment_notes').select('id,body,created_at').eq('tenant_id', tenantId).eq('appointment_id', args.appointmentId).order('created_at'),
          admin.from('payments').select('id,kind,amount_minor,method,note,received_at').eq('tenant_id', tenantId).eq('appointment_id', args.appointmentId).order('received_at'),
          admin.from('services').select('name').eq('tenant_id', tenantId).eq('id', (appointment as {service_id: string}).service_id).maybeSingle(),
          admin.from('resources').select('name').eq('tenant_id', tenantId).eq('id', (appointment as {resource_id: string}).resource_id).maybeSingle(),
        ]);
        if (extrasResult.error) throw extrasResult.error;
        if (notesResult.error) throw notesResult.error;
        if (paymentsResult.error) throw paymentsResult.error;
        const {data: tenant, error: tenantError} = await admin.from('tenants').select('slug,name').eq('id', tenantId).maybeSingle();
        if (tenantError) throw tenantError;
        return json(request, {
          appointment,
          tenant: tenant ?? null,
          serviceName: (serviceResult.data as {name?: string} | null)?.name ?? 'Услуга',
          resourceLabel: (resourceResult.data as {name?: string} | null)?.name ?? null,
          extras: extrasResult.data ?? [],
          notes: notesResult.data ?? [],
          payments: paymentsResult.data ?? [],
        });
      }
      case 'list-payments': {
        const args = listPaymentsSchema.parse(params);
        let rowsQuery = admin.from('payments').select(PAYMENT_COLUMNS, {count: 'exact'}).eq('tenant_id', args.tenantId)
          .order('received_at', {ascending: false}).range(args.offset, args.offset + args.limit - 1);
        let totalsQuery = admin.from('payments').select('kind,amount_minor').eq('tenant_id', args.tenantId);
        if (args.from) {
          rowsQuery = rowsQuery.gte('received_at', args.from);
          totalsQuery = totalsQuery.gte('received_at', args.from);
        }
        if (args.to) {
          rowsQuery = rowsQuery.lt('received_at', args.to);
          totalsQuery = totalsQuery.lt('received_at', args.to);
        }
        const [{data, count, error}, totals] = await Promise.all([rowsQuery, totalsQuery]);
        if (error) throw error;
        if (totals.error) throw totals.error;
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        // Attach the appointment to each payment so the admin never has to
        // search manually (customer, date, service).
        const appointmentIds = [...new Set(rows.map((row) => String(row['appointment_id'])).filter((value) => value && value !== 'null'))];
        const appointmentMap = new Map<string, {customerName: string; startsAt: string; serviceName: string; tenantId: string}>();
        if (appointmentIds.length > 0) {
          const {data: appointmentRows, error: appointmentError} = await admin.from('appointments')
            .select('id,tenant_id,customer_name,starts_at,service_id').in('id', appointmentIds);
          if (appointmentError) throw appointmentError;
          const serviceIds = [...new Set(((appointmentRows ?? []) as Array<Record<string, unknown>>).map((row) => String(row['service_id'])))];
          const {data: serviceRows, error: serviceError} = await admin.from('services').select('id,name').in('id', serviceIds);
          if (serviceError) throw serviceError;
          const serviceNames = new Map(((serviceRows ?? []) as Array<Record<string, unknown>>).map((row) => [String(row['id']), String(row['name'])]));
          for (const row of (appointmentRows ?? []) as Array<Record<string, unknown>>) {
            appointmentMap.set(String(row['id']), {
              customerName: String(row['customer_name'] ?? ''),
              startsAt: String(row['starts_at'] ?? ''),
              serviceName: serviceNames.get(String(row['service_id'])) ?? 'Услуга',
              tenantId: String(row['tenant_id']),
            });
          }
        }
        return json(request, {
          payments: rows.map((row) => {
            const linked = appointmentMap.get(String(row['appointment_id']));
            return {
              ...row,
              appointment: linked ? {
                customerName: linked.customerName,
                startsAt: linked.startsAt,
                serviceName: linked.serviceName,
                tenantId: linked.tenantId,
              } : null,
            };
          }),
          total: count ?? 0,
          limit: args.limit,
          offset: args.offset,
          totals: paymentTotals((totals.data ?? []) as Array<{kind: string; amount_minor: number}>),
        });
      }
      case 'list-services': {
        const args = listServicesSchema.parse(params);
        let query = admin.from('services').select(SERVICE_COLUMNS).eq('tenant_id', args.tenantId).order('slug');
        if (!args.includeInactive) query = query.eq('active', true);
        const {data, error} = await query;
        if (error) throw error;
        return json(request, {services: data ?? []});
      }
      case 'list-resources': {
        const args = listResourcesSchema.parse(params);
        let query = admin.from('resources').select(RESOURCE_COLUMNS).eq('tenant_id', args.tenantId).order('slug');
        if (!args.includeInactive) query = query.eq('active', true);
        const {data, error} = await query;
        if (error) throw error;
        return json(request, {resources: data ?? []});
      }
      case 'suspend': {
        const args = suspendSchema.parse(params);
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const tenant = await adminTenantById(admin, args.tenantId) as {
          id: string; status: string; archived_at: string | null;
        } | null;
        if (!tenant) {
          await auditFailure(admin, user.id, 'admin.suspend', args.tenantId, args.reason, 'tenant-not-found');
          return json(request, {error: 'Tenant not found.'}, 404);
        }
        if (tenant.archived_at) {
          await auditFailure(admin, user.id, 'admin.suspend', tenant.id, args.reason, 'tenant-archived');
          return json(request, {error: 'Tenant is archived. Unarchive it before changing suspension.'}, 409);
        }
        if (tenant.status === 'paused') {
          await auditFailure(admin, user.id, 'admin.suspend', tenant.id, args.reason, 'already-suspended');
          return json(request, {error: 'Tenant is already suspended.'}, 409);
        }
        const {data: updated, error: updateError} = await admin.from('tenants').update({
          status: 'paused', suspended_at: new Date().toISOString(), suspended_by: user.id, suspend_reason: args.reason,
        }).eq('id', tenant.id).select(TENANT_COLUMNS).single();
        if (updateError) throw updateError;
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.suspend', tenant_id: tenant.id, appointment_id: null,
          reason: args.reason,
          metadata: {tenant_id: tenant.id, from: tenant.status, to: 'paused', reason: args.reason, request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {suspended: true, tenant: updated});
      }
      case 'reactivate': {
        const args = reactivateSchema.parse(params);
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const tenant = await adminTenantById(admin, args.tenantId) as {
          id: string; status: string; is_demo: boolean; archived_at: string | null;
        } | null;
        if (!tenant) {
          await auditFailure(admin, user.id, 'admin.reactivate', args.tenantId, '', 'tenant-not-found');
          return json(request, {error: 'Tenant not found.'}, 404);
        }
        if (tenant.archived_at) {
          await auditFailure(admin, user.id, 'admin.reactivate', tenant.id, '', 'tenant-archived');
          return json(request, {error: 'Tenant is archived. Unarchive it first.'}, 409);
        }
        if (args.targetStatus === 'live' && tenant.is_demo) {
          await auditFailure(admin, user.id, 'admin.reactivate', tenant.id, '', 'demo-cannot-go-live');
          return json(request, {error: 'Demo tenants cannot go live.'}, 409);
        }
        if (tenant.status === args.targetStatus) {
          await auditFailure(admin, user.id, 'admin.reactivate', tenant.id, '', 'already-in-status');
          return json(request, {error: `Tenant is already ${args.targetStatus}.`}, 409);
        }
        const {data: updated, error: updateError} = await admin.from('tenants').update({
          status: args.targetStatus, suspended_at: null, suspended_by: null, suspend_reason: '',
        }).eq('id', tenant.id).select(TENANT_COLUMNS).single();
        if (updateError) throw updateError;
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.reactivate', tenant_id: tenant.id, appointment_id: null,
          reason: '',
          metadata: {tenant_id: tenant.id, from: tenant.status, to: args.targetStatus, request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {reactivated: true, tenant: updated});
      }
      case 'archive': {
        const args = archiveSchema.parse(params);
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const tenant = await adminTenantById(admin, args.tenantId) as {
          id: string; status: string; archived_at: string | null;
        } | null;
        if (!tenant) {
          await auditFailure(admin, user.id, 'admin.archive', args.tenantId, args.reason, 'tenant-not-found');
          return json(request, {error: 'Tenant not found.'}, 404);
        }
        if (tenant.archived_at) {
          await auditFailure(admin, user.id, 'admin.archive', tenant.id, args.reason, 'already-archived');
          return json(request, {error: 'Tenant is already archived.'}, 409);
        }
        const patch: Record<string, unknown> = {
          status: 'paused', archived_at: new Date().toISOString(), archived_by: user.id,
        };
        if (args.reason) patch['suspend_reason'] = args.reason;
        const {data: updated, error: updateError} = await admin.from('tenants').update(patch).eq('id', tenant.id).select(TENANT_COLUMNS).single();
        if (updateError) throw updateError;
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.archive', tenant_id: tenant.id, appointment_id: null,
          reason: args.reason,
          metadata: {tenant_id: tenant.id, from: tenant.status, to: 'archived', ...(args.reason ? {reason: args.reason} : {}), request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {archived: true, tenant: updated});
      }
      case 'unarchive': {
        const args = unarchiveSchema.parse(params);
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const tenant = await adminTenantById(admin, args.tenantId) as {
          id: string; archived_at: string | null;
        } | null;
        if (!tenant) {
          await auditFailure(admin, user.id, 'admin.unarchive', args.tenantId, '', 'tenant-not-found');
          return json(request, {error: 'Tenant not found.'}, 404);
        }
        if (!tenant.archived_at) {
          await auditFailure(admin, user.id, 'admin.unarchive', tenant.id, '', 'not-archived');
          return json(request, {error: 'Tenant is not archived.'}, 409);
        }
        // Two-step restore: unarchive clears the archive marker but the tenant
        // STAYS paused until an explicit reactivate.
        const {data: updated, error: updateError} = await admin.from('tenants').update({
          archived_at: null, archived_by: null, status: 'paused',
        }).eq('id', tenant.id).select(TENANT_COLUMNS).single();
        if (updateError) throw updateError;
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.unarchive', tenant_id: tenant.id, appointment_id: null,
          reason: '',
          metadata: {tenant_id: tenant.id, from: 'archived', to: 'paused', request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {unarchived: true, tenant: updated});
      }
      case 'create-tenant': {
        const args = createTenantSchema.parse(params);
        if (!isValidTimezone(args.timezone)) {
          return json(request, {error: 'Invalid request: timezone — must be a valid IANA time zone.'}, 400);
        }
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const {data: clash, error: clashError} = await admin.from('tenants').select('id').eq('slug', args.slug).maybeSingle();
        if (clashError) throw clashError;
        if (clash) {
          await auditFailure(admin, user.id, 'admin.create', (clash as {id: string}).id, '', 'slug-taken');
          return json(request, {error: 'Tenant slug is already taken.'}, 409);
        }
        // Draft shell with safe DB defaults. template='detailing' (the default)
        // additionally seeds the starter set defined above (services,
        // resources, opening hours, gallery, info cards, prompts, placeholder
        // hero/logo URLs); template='empty' keeps the bare shell with no
        // services/resources. Identity fields stay empty for the admin.
        // Seeding is creation-only: no triggers, no upsert-on-read elsewhere.
        const useTemplate = args.template === 'detailing';
        const {data: created, error: createError} = await admin.from('tenants').insert({
          slug: args.slug,
          name: args.name.trim(),
          tagline: '',
          description: '',
          city: '',
          address: '',
          phone: '',
          map_url: '',
          timezone: args.timezone,
          currency: args.currency,
          locale: 'ru-RU',
          accent_color: '#4690FF',
          hero_image_url: useTemplate ? '/placeholders/detailing-hero.svg' : '',
          logo_url: useTemplate ? '/placeholders/detailing-logo.svg' : '',
          is_demo: true,
          status: 'draft',
          booking_step_minutes: 30,
          cancellation_window_hours: 12,
          opening_hours: useTemplate ? TEMPLATE_OPENING_HOURS : [],
          gallery: useTemplate ? TEMPLATE_GALLERY : [],
          info_cards: useTemplate ? TEMPLATE_INFO_CARDS : [],
          assistant_prompts: useTemplate ? TEMPLATE_PROMPTS : [],
        }).select(FULL_TENANT_COLUMNS).single();
        if (createError) {
          if ((createError as {code?: string})?.code === '23505') {
            await auditFailure(admin, user.id, 'admin.create', null, '', 'slug-taken');
            return json(request, {error: 'Tenant slug is already taken.'}, 409);
          }
          throw createError;
        }
        const tenantId = (created as {id: string}).id;
        if (useTemplate) {
          // Upserts on (tenant_id,slug): a resumed attempt cannot duplicate
          // rows. Throws (no audit row written) on failure, so a retry hits
          // the slug-clash 409 above and needs manual cleanup via
          // save-service/save-resource — documented, not silently reseeded.
          const {error: seedServicesError} = await admin.from('services').upsert(
            TEMPLATE_SERVICES.map((service) => ({
              tenant_id: tenantId, slug: service.slug, name: service.name,
              description: service.description, category: service.category,
              price_minor: service.priceMinor, duration_minutes: service.durationMinutes,
              buffer_before_minutes: service.bufferBeforeMinutes,
              buffer_after_minutes: service.bufferAfterMinutes,
              resource_types: service.resourceTypes, active: true,
            })),
            {onConflict: 'tenant_id,slug'},
          );
          if (seedServicesError) throw seedServicesError;
          const {error: seedResourcesError} = await admin.from('resources').upsert(
            TEMPLATE_RESOURCES.map((resource) => ({
              tenant_id: tenantId, slug: resource.slug, name: resource.name,
              resource_type: resource.resourceType, location: '', active: true,
            })),
            {onConflict: 'tenant_id,slug'},
          );
          if (seedResourcesError) throw seedResourcesError;
        }
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.create', tenant_id: tenantId, appointment_id: null,
          reason: '',
          metadata: {tenant_id: tenantId, from: 'none', to: 'draft', request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {created: true, tenant: created, template: args.template});
      }
      case 'validate-tenant': {
        const args = validateTenantSchema.parse(params);
        const tenant = await adminTenantFullById(admin, args.tenantId);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        return json(request, {tenantId: args.tenantId, ...(await buildTenantValidation(admin, tenant))});
      }
      case 'publish-tenant': {
        const args = publishTenantSchema.parse(params);
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const tenant = await adminTenantFullById(admin, args.tenantId);
        if (!tenant) {
          await auditFailure(admin, user.id, 'admin.publish', args.tenantId, '', 'tenant-not-found');
          return json(request, {error: 'Tenant not found.'}, 404);
        }
        if (tenant['archived_at']) {
          await auditFailure(admin, user.id, 'admin.publish', tenant['id'] as string, '', 'tenant-archived');
          return json(request, {error: 'Tenant is archived. Unarchive it first.'}, 409);
        }
        if (tenant['status'] !== 'draft') {
          await auditFailure(admin, user.id, 'admin.publish', tenant['id'] as string, '', `not-draft:${String(tenant['status'])}`);
          return json(request, {error: 'Only draft tenants can be published.'}, 409);
        }
        const validation = await buildTenantValidation(admin, tenant);
        if (validation.errors.length > 0) {
          await auditFailure(admin, user.id, 'admin.publish', tenant['id'] as string, '', validation.errors[0].slice(0, 200));
          return json(request, {error: validation.errors[0], ...validation}, 409);
        }
        // Single-column status update only: appointments/payments/memberships/
        // photos/suspension columns are never touched here.
        const {data: updated, error: updateError} = await admin.from('tenants').update({
          status: 'preview',
        }).eq('id', tenant['id'] as string).select(FULL_TENANT_COLUMNS).single();
        if (updateError) throw updateError;
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.publish', tenant_id: tenant['id'] as string, appointment_id: null,
          reason: '',
          metadata: {tenant_id: tenant['id'], from: 'draft', to: 'preview', request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {published: true, tenant: updated, ...validation});
      }
      case 'activate-tenant': {
        const args = activateTenantSchema.parse(params);
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const tenant = await adminTenantFullById(admin, args.tenantId);
        if (!tenant) {
          await auditFailure(admin, user.id, 'admin.activate', args.tenantId, '', 'tenant-not-found');
          return json(request, {error: 'Tenant not found.'}, 404);
        }
        if (tenant['archived_at']) {
          await auditFailure(admin, user.id, 'admin.activate', tenant['id'] as string, '', 'tenant-archived');
          return json(request, {error: 'Tenant is archived. Unarchive it first.'}, 409);
        }
        if (tenant['status'] === 'live') {
          await auditFailure(admin, user.id, 'admin.activate', tenant['id'] as string, '', 'already-live');
          return json(request, {error: 'Tenant is already live.'}, 409);
        }
        if (tenant['status'] !== 'preview') {
          await auditFailure(admin, user.id, 'admin.activate', tenant['id'] as string, '', `not-preview:${String(tenant['status'])}`);
          return json(request, {error: 'Only preview tenants can be activated. Publish first.'}, 409);
        }
        if (tenant['is_demo']) {
          await auditFailure(admin, user.id, 'admin.activate', tenant['id'] as string, '', 'demo-cannot-go-live');
          return json(request, {error: 'Demo tenants cannot go live.'}, 409);
        }
        const placeholders = isPlaceholderContact(tenant);
        if (placeholders.length > 0) {
          await auditFailure(admin, user.id, 'admin.activate', tenant['id'] as string, '', `placeholder-contact:${placeholders.join(',')}`);
          return json(request, {error: `Replace placeholder contact details before activation: ${placeholders.join(', ')}.`, errors: placeholders.map((field) => `contact-placeholder: ${field} is still a placeholder.`), warnings: [], info: []}, 409);
        }
        const validation = await buildTenantValidation(admin, tenant);
        if (validation.errors.length > 0) {
          await auditFailure(admin, user.id, 'admin.activate', tenant['id'] as string, '', validation.errors[0].slice(0, 200));
          return json(request, {error: validation.errors[0], ...validation}, 409);
        }
        // Single-column status update only; historical prices and operational
        // rows are preserved (no service/resource rewrites).
        const {data: updated, error: updateError} = await admin.from('tenants').update({
          status: 'live',
        }).eq('id', tenant['id'] as string).select(FULL_TENANT_COLUMNS).single();
        if (updateError) throw updateError;
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.activate', tenant_id: tenant['id'] as string, appointment_id: null,
          reason: '',
          metadata: {tenant_id: tenant['id'], from: 'preview', to: 'live', request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {activated: true, tenant: updated, ...validation});
      }
      case 'export-tenant': {
        const args = exportTenantSchema.parse(params);
        const tenant = 'tenantId' in args ? await adminTenantFullById(admin, args.tenantId) : await adminTenantFullBySlug(admin, args.slug);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const tenantId = tenant['id'] as string;
        const [{data: services, error: servicesError}, {data: resources, error: resourcesError}] = await Promise.all([
          admin.from('services').select(SERVICE_COLUMNS).eq('tenant_id', tenantId).order('slug'),
          admin.from('resources').select(RESOURCE_COLUMNS).eq('tenant_id', tenantId).order('slug'),
        ]);
        if (servicesError) throw servicesError;
        if (resourcesError) throw resourcesError;
        return json(request, toBusinessJson(
          tenant,
          (services ?? []) as Array<Record<string, unknown>>,
          (resources ?? []) as Array<Record<string, unknown>>,
        ));
      }
      case 'update-tenant': {
        const args = updateTenantSchema.parse(params);
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const patch = mapAdminProfile(args.profile);
        if (!Object.keys(patch).length) return json(request, {error: 'No changes to save.'}, 400);
        const {error: updateError} = await admin.from('tenants').update(patch).eq('id', (tenant as {id: string}).id);
        if (updateError) throw updateError;
        await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.update', tenant_id: (tenant as {id: string}).id, appointment_id: null,
          reason: '',
          metadata: {tenant_id: (tenant as {id: string}).id, fields: Object.keys(patch)},
          success: true, request_id: '',
        });
        return json(request, {saved: true});
      }
      case 'save-service': {
        const args = saveServiceSchema.parse(params);
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const service = args.service;
        const {data, error} = await admin.from('services').upsert({
          tenant_id: (tenant as {id: string}).id, slug: service.slug, name: service.name, description: service.description, category: service.category,
          price_minor: service.priceMinor, duration_minutes: service.durationMinutes, buffer_before_minutes: service.bufferBeforeMinutes,
          buffer_after_minutes: service.bufferAfterMinutes, resource_types: service.resourceTypes, active: service.active,
        }, {onConflict: 'tenant_id,slug'}).select('id,slug,name,price_minor,duration_minutes').single();
        if (error) throw error;
        await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.save-service', tenant_id: (tenant as {id: string}).id, appointment_id: null,
          reason: '',
          metadata: {tenant_id: (tenant as {id: string}).id, service_slug: service.slug},
          success: true, request_id: '',
        });
        return json(request, {service: data});
      }
      case 'save-resource': {
        const args = saveResourceSchema.parse(params);
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const resource = args.resource;
        const {data, error} = await admin.from('resources').upsert({
          tenant_id: (tenant as {id: string}).id, slug: resource.slug, name: resource.name, resource_type: resource.resourceType, location: resource.location, active: resource.active,
        }, {onConflict: 'tenant_id,slug'}).select('id,slug,name,resource_type,location').single();
        if (error) throw error;
        await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.save-resource', tenant_id: (tenant as {id: string}).id, appointment_id: null,
          reason: '',
          metadata: {tenant_id: (tenant as {id: string}).id, resource_slug: resource.slug},
          success: true, request_id: '',
        });
        return json(request, {resource: data});
      }
      case 'save-date-override': {        const args = saveDateOverrideSchema.parse(params);
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const override = args.override;
        const {data, error} = await admin.from('date_overrides').upsert({
          tenant_id: (tenant as {id: string}).id, local_date: override.localDate, is_closed: override.isClosed,
          opens_at: override.isClosed ? null : override.opensAt, closes_at: override.isClosed ? null : override.closesAt, label: override.label,
        }, {onConflict: 'tenant_id,local_date'}).select('id,local_date,is_closed,opens_at,closes_at,label').single();
        if (error) throw error;
        await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.save-date-override', tenant_id: (tenant as {id: string}).id, appointment_id: null,
          reason: '',
          metadata: {tenant_id: (tenant as {id: string}).id, local_date: override.localDate},
          success: true, request_id: '',
        });
        return json(request, {override: data});
      }
      case 'list-overrides': {
        const args = listOverridesSchema.parse(params);
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const {data, error} = await admin.from('date_overrides')
          .select('id,tenant_id,local_date,is_closed,opens_at,closes_at,label,created_at')
          .eq('tenant_id', (tenant as {id: string}).id).order('local_date');
        if (error) throw error;
        return json(request, {overrides: data ?? []});
      }
      case 'list-owners': {
        const args = listOwnersSchema.parse(params);
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const {data, error} = await admin.from('tenant_memberships')
          .select('username,role,recovery_email,created_at')
          .eq('tenant_id', (tenant as {id: string}).id).order('created_at');
        if (error) throw error;
        return json(request, {
          owners: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
            username: String(row['username'] ?? ''),
            role: String(row['role'] ?? 'owner'),
            recoveryEmail: String(row['recovery_email'] ?? ''),
            createdAt: String(row['created_at'] ?? ''),
          })),
        });
      }
      case 'create-owner': {
        const args = createOwnerSchema.parse(params);
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) {
          await auditFailure(admin, user.id, 'admin.create-owner', args.tenantId, '', 'tenant-not-found');
          return json(request, {error: 'Tenant not found.'}, 404);
        }
        const tenantId = (tenant as {id: string}).id;
        const {data: taken, error: takenError} = await admin.from('tenant_memberships')
          .select('tenant_id').eq('username', args.username).limit(1);
        if (takenError) throw takenError;
        if (taken && taken.length > 0) {
          await auditFailure(admin, user.id, 'admin.create-owner', tenantId, '', 'username-taken');
          return json(request, {error: 'This login is already taken. Choose another username.'}, 409);
        }
        const authEmail = ownerAuthEmail(args.username);
        const {data: created, error: createError} = await admin.auth.admin.createUser({
          email: authEmail,
          password: args.password,
          email_confirm: true,
          user_metadata: {username: args.username},
        });
        if (createError || !created?.user) {
          const detail = createError?.message ?? 'auth-create-failed';
          await auditFailure(admin, user.id, 'admin.create-owner', tenantId, '', detail.slice(0, 200));
          if (/already|exists|registered|duplicate/i.test(detail)) {
            return json(request, {error: 'This login is already used by another account. Pick another username.'}, 409);
          }
          throw createError ?? new Error('Could not create the owner account.');
        }
        const {error: memberError} = await admin.from('tenant_memberships').upsert({
          tenant_id: tenantId, user_id: created.user.id, role: args.role,
          username: args.username, recovery_email: args.recoveryEmail || '',
        }, {onConflict: 'tenant_id,user_id'});
        if (memberError) {
          // Roll back the orphaned auth user; the retry will hit the
          // requestId dedupe only after a successful audit row, so a failed
          // attempt stays safely retryable.
          try {
            await admin.auth.admin.deleteUser(created.user.id);
          } catch {
            // Best effort: the username-taken check above prevents reuse.
          }
          throw memberError;
        }
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.create-owner', tenant_id: tenantId, appointment_id: null,
          reason: '',
          metadata: {tenant_id: tenantId, username: args.username, role: args.role, request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {
          created: true,
          owner: {username: args.username, role: args.role, recoveryEmail: args.recoveryEmail || ''},
        });
      }
      case 'update-owner': {
        const args = updateOwnerSchema.parse(params);
        if (args.password === undefined && args.recoveryEmail === undefined && args.role === undefined) {
          return json(request, {error: 'Nothing to update: provide a new password, recovery email, or role.'}, 400);
        }
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) return json(request, {error: 'Tenant not found.'}, 404);
        const tenantId = (tenant as {id: string}).id;
        const {data: member, error: memberError} = await admin.from('tenant_memberships')
          .select('user_id,role,recovery_email').eq('tenant_id', tenantId).eq('username', args.username).maybeSingle();
        if (memberError) throw memberError;
        if (!member) return json(request, {error: 'Owner not found in this studio.'}, 404);
        const userId = (member as {user_id: string}).user_id;
        const changed: string[] = [];
        if (args.role !== undefined && args.role !== (member as {role: string}).role) {
          const {error: roleError} = await admin.from('tenant_memberships')
            .update({role: args.role}).eq('tenant_id', tenantId).eq('user_id', userId);
          if (roleError) throw roleError;
          changed.push('role');
        }
        if (args.recoveryEmail !== undefined) {
          const {error: mailError} = await admin.from('tenant_memberships')
            .update({recovery_email: args.recoveryEmail || ''}).eq('tenant_id', tenantId).eq('user_id', userId);
          if (mailError) throw mailError;
          changed.push('recoveryEmail');
        }
        if (args.password !== undefined) {
          // Migrate legacy real-email accounts to the synthetic login address
          // so username login keeps working after the reset.
          const {data: authUser, error: getError} = await admin.auth.admin.getUserById(userId);
          if (getError) throw getError;
          const synthetic = ownerAuthEmail(args.username);
          if (authUser?.user && authUser.user.email !== synthetic) {
            const {error: mailError} = await admin.auth.admin.updateUserById(userId, {email: synthetic, email_confirm: true});
            if (mailError) throw mailError;
          }
          const {error: passError} = await admin.auth.admin.updateUserById(userId, {password: args.password});
          if (passError) throw passError;
          changed.push('password');
        }
        await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.update-owner', tenant_id: tenantId, appointment_id: null,
          reason: '',
          metadata: {tenant_id: tenantId, username: args.username, fields: changed},
          success: true, request_id: '',
        });
        return json(request, {saved: true, fields: changed});
      }
      case 'delete-owner': {
        const args = deleteOwnerSchema.parse(params);
        if (await findAuditByRequestId(admin, args.requestId)) return json(request, {deduped: true});
        const tenant = await adminTenantById(admin, args.tenantId);
        if (!tenant) {
          await auditFailure(admin, user.id, 'admin.delete-owner', args.tenantId, '', 'tenant-not-found');
          return json(request, {error: 'Tenant not found.'}, 404);
        }
        const tenantId = (tenant as {id: string}).id;
        const {data: member, error: memberError} = await admin.from('tenant_memberships')
          .select('user_id').eq('tenant_id', tenantId).eq('username', args.username).maybeSingle();
        if (memberError) throw memberError;
        if (!member) {
          await auditFailure(admin, user.id, 'admin.delete-owner', tenantId, '', 'owner-not-found');
          return json(request, {error: 'Owner not found in this studio.'}, 404);
        }
        const userId = (member as {user_id: string}).user_id;
        const {error: removeError} = await admin.from('tenant_memberships')
          .delete().eq('tenant_id', tenantId).eq('user_id', userId);
        if (removeError) throw removeError;
        // Delete the auth user only when it belongs to no other studio.
        const {data: remaining, error: remainingError} = await admin.from('tenant_memberships')
          .select('tenant_id').eq('user_id', userId).limit(1);
        if (remainingError) throw remainingError;
        let authUserDeleted = false;
        if (!remaining || remaining.length === 0) {
          const {error: deleteError} = await admin.auth.admin.deleteUser(userId);
          if (deleteError) throw deleteError;
          authUserDeleted = true;
        }
        const audit = await insertAudit(admin, {
          admin_user_id: user.id, action: 'admin.delete-owner', tenant_id: tenantId, appointment_id: null,
          reason: '',
          metadata: {tenant_id: tenantId, username: args.username, request_id: args.requestId},
          success: true, request_id: args.requestId,
        });
        if (audit.deduped) return json(request, {deduped: true});
        return json(request, {deleted: true, authUserDeleted});
      }
      case 'audit-list': {
        const args = auditListSchema.parse(params);        let query = admin.from('admin_audit_log').select(AUDIT_COLUMNS, {count: 'exact'})
          .order('created_at', {ascending: false}).range(args.offset, args.offset + args.limit - 1);
        if (args.tenantId) query = query.eq('tenant_id', args.tenantId);
        if (args.action) query = query.eq('action', args.action);
        const {data, count, error} = await query;
        if (error) throw error;
        return json(request, {audit: data ?? [], total: count ?? 0, limit: args.limit, offset: args.offset});
      }
      default:
        return json(request, {error: 'Unknown action.'}, 400);
    }
  } catch (error) {
    if (error instanceof z.ZodError || (error as {name?: string})?.name === 'ZodError') {
      const first = (error as z.ZodError).issues?.[0];
      const where = first && first.path.length ? first.path.map(String).join('.') : 'body';
      return json(request, {error: `Invalid request: ${where} — ${first?.message ?? 'check the payload and try again.'}`}, 400);
    }
    const status = (error as {status?: number})?.status ?? errorStatus(error);
    return json(request, {error: errorMessage(error)}, status);
  }
});
