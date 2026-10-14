/**
 * Super Admin API client.
 *
 * All data flows through the `admin-api` Edge Function (service-role inside
 * the function only — the browser NEVER sees a service-role key). Every call
 * sends the user's Supabase JWT; the server verifies platform-admin
 * membership per request and is the sole authority (unknown callers get a
 * generic 404, so the endpoint never reveals whether an admin exists).
 * UI session checks only decide what to render, never what is allowed.
 *
 * Server contract (strict zod schemas — send exactly the listed params):
 *   status {} -> { admin: true, userId, label }
 *   dashboard {} -> { tenants: {total,draft,preview,live,paused,archived,suspended},
 *     appointmentsUpcoming7d, payments30d: {grossMinor,refundMinor,netMinor}, recentAudit }
 *   list-tenants { status?, archived?, search?, limit?, offset? }
 *     -> { tenants (snake_case rows), total }
 *   get-tenant { tenantId } -> { tenant, counts: {services,resources,appointments}, payments }
 *   list-appointments { tenantId, status?, from?, to?, limit?, offset? } -> { appointments, total }
 *   list-payments { tenantId, from?, to?, limit?, offset? } -> { payments, total, totals }
 *   list-services { tenantId, includeInactive? } -> { services }
 *   list-resources { tenantId, includeInactive? } -> { resources }
 *   suspend { tenantId, reason (min 5), requestId } -> { suspended: true } | { deduped: true }
 *   reactivate { tenantId, targetStatus: 'preview'|'live', requestId } -> { reactivated: true }
 *   archive { tenantId, reason?, requestId } -> { archived: true }
 *   unarchive { tenantId, requestId } -> { unarchived: true }
 *   audit-list { tenantId?, action?, limit?, offset? } -> { audit, total }
 *   create-tenant { name, slug, timezone?, currency?, template?, requestId } -> { created, tenant }
 *     template 'detailing' (default) seeds 4 services + compatible resources +
 *     hours + gallery/cards/prompts; 'empty' creates a bare draft shell.
 *     Servers that predate the template param reject it with
 *     "Invalid request: Unrecognized key" — the wrapper below retries once
 *     without the key (same requestId; the first attempt never reaches the DB).
 *   validate-tenant { tenantId } -> { tenantId, errors[], warnings[], info[] }
 *   publish-tenant { tenantId, requestId } -> { published } | 409 { error, errors[] }
 *   activate-tenant { tenantId, requestId } -> { activated } | 409 { error, errors[] }
 *   export-tenant { tenantId } | { slug } -> business.json-shaped object
 *   update-tenant { tenantId, profile } -> { saved }
 *   save-service { tenantId, service } -> { service }
 *   save-resource { tenantId, resource (...+ optional location≤120) } -> { resource }
 *     Same unrecognized-key retry as create-tenant applies to `location`.
 *   save-date-override { tenantId, override } -> { override }
 *   list-owners { tenantId } -> { owners: [{ username, role, recoveryEmail, createdAt }] }
 *   create-owner { tenantId, username, password, recoveryEmail?, role?, requestId }
 *     -> { created } | { deduped: true } (username-only login; recovery email optional)
 *   update-owner { tenantId, username, password?, recoveryEmail?, role? } -> { saved, fields }
 *   delete-owner { tenantId, username, requestId } -> { deleted, authUserDeleted }
 *
 * Mutations are idempotent via client-generated `requestId` (createClientId);
 * replays return { deduped: true } and are treated as success.
 */
import {supabase} from '@/lib/supabase';
import {createClientId} from '@/lib/id';
import {suggestSlug} from '@/lib/suggest-slug';

export type AdminTenantVisibility = 'draft' | 'preview' | 'live' | 'suspended' | 'archived';
export type AdminTenantFilter = 'all' | AdminTenantVisibility;
/** Server-side tenant status values (suspended/archived are derived: paused ± archived_at). */
export type AdminServerStatus = 'draft' | 'preview' | 'live' | 'paused';

export interface AdminTenantRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  city: string;
  phone: string;
  isDemo: boolean;
  /** Raw DB tenant_status value (draft/preview/live/paused). */
  status: string;
  /** Computed platform visibility: paused -> suspended, paused+archived_at -> archived. */
  visibility: AdminTenantVisibility;
  suspended: boolean;
  archived: boolean;
  suspendReason: string;
  suspendedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
  createdAt: string;
  openingHours: Array<{weekday: number; opensAt: string; closesAt: string}>;
}

export interface AdminDashboardMetrics {
  tenants: {total: number; draft: number; live: number; preview: number; paused: number; suspended: number; archived: number};
  /** Upcoming appointments in the next 7 days (server window). */
  upcoming7d: number;
  /** RECORDED payments over the last 30 days (journal sums, never forecasts). Minor units. */
  payments30d: {grossMinor: number; refundMinor: number; netMinor: number};
  recentAudit: AdminAuditEntry[];
}

export interface AdminAppointmentRow extends Record<string, unknown> {
  id: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  customerName: string;
  customerPhone: string;
  serviceName: string;
  status: string;
  priceMinor: number;
}

export interface AdminPaymentRow extends Record<string, unknown> {
  id: string;
  receivedAt: string;
  appointmentId: string;
  kind: string;
  amountMinor: number;
  method: string;
}

export interface AdminAuditEntry extends Record<string, unknown> {
  id: string;
  action: string;
  tenantId: string | null;
  adminUserId: string | null;
  appointmentId?: string | null;
  metadata?: Record<string, unknown>;
  reason: string;
  success: boolean;
  requestId: string;
  createdAt: string;
}

export interface AdminServiceRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  priceMinor: number;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  resourceTypes: string[];
  active: boolean;
}

export interface AdminResourceRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  resourceType: string;
  /** Physical location of the post (e.g. 'Пост № 2'). Optional; '' when unset or on older servers. */
  location: string;
  active: boolean;
}

export interface AdminTenantDetail {
  tenant: AdminTenantRow;
  counts: {services: number; resources: number; appointments: number};
  payments: {grossMinor: number; refundMinor: number; netMinor: number};
}

/** One validation finding. Server sends "code: message" strings; code is the part before the first ": ". */
export interface ValidationItem {
  code: string;
  message: string;
}

export interface ValidationReport {
  errors: ValidationItem[];
  warnings: ValidationItem[];
  info: ValidationItem[];
}

function toValidationItem(raw: unknown): ValidationItem {
  const text = typeof raw === 'string' ? raw : '';
  const separator = text.indexOf(': ');
  if (separator > 0) return {code: text.slice(0, separator), message: text.slice(separator + 2)};
  return {code: 'note', message: text || '—'};
}

function toValidationReport(raw: Record<string, unknown>): ValidationReport {
  const list = (value: unknown): ValidationItem[] => (Array.isArray(value) ? value.map(toValidationItem) : []);
  return {errors: list(raw.errors), warnings: list(raw.warnings), info: list(raw.info)};
}

export function newRequestId(): string {
  return createClientId();
}

/** Canonical owner login form: lowercase, trimmed. Mirrors the server regex. */
const OWNER_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function normalizeOwnerUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidOwnerUsername(value: string): boolean {
  return OWNER_USERNAME_PATTERN.test(normalizeOwnerUsername(value));
}

/** Map the directory UI filter to exact server params (strict schema — no extras). */
export function tenantFilterParams(filter: AdminTenantFilter): {status?: AdminServerStatus; archived?: boolean} {
  if (filter === 'all') return {};
  if (filter === 'suspended') return {status: 'paused', archived: false};
  if (filter === 'archived') return {archived: true};
  return {status: filter};
}

function requireClient() {
  if (!supabase) throw new Error('Для панели нужен Supabase: задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY.');
  return supabase;
}

/** Best-effort read of the server's {error} body from a FunctionsHttpError. */
async function readFunctionErrorBody(error: unknown): Promise<Record<string, unknown> | null> {
  try {
    const context = (error as {context?: unknown}).context;
    if (context instanceof Response) {
      const copy = context.clone();
      const body = (await copy.json()) as Record<string, unknown>;
      if (body && typeof body === 'object') return body;
    }
  } catch {
    // Fall through to the generic message.
  }
  return null;
}

/** Error from admin-api carrying the parsed response body (e.g. 409 validation reports). */
export class AdminApiError extends Error {
  body: Record<string, unknown> | null;
  constructor(message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'AdminApiError';
    this.body = body;
  }
}

/** Extract a validation report from a publish/activate 409 error, if present. */
export function adminApiErrorReport(error: unknown): ValidationReport | null {
  if (error instanceof AdminApiError && error.body && ('errors' in error.body || 'warnings' in error.body)) {
    return toValidationReport(error.body);
  }
  return null;
}

async function invokeAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const client = requireClient();
  const {data, error} = await client.functions.invoke('admin-api', {body: {action, ...payload}});
  if (error) {
    const body = await readFunctionErrorBody(error);
    const detail = body && typeof body.error === 'string' && body.error ? body.error : null;
    throw new AdminApiError(detail ?? (error instanceof Error && error.message ? error.message : 'Не удалось выполнить запрос. Попробуйте ещё раз.'), body);
  }
  if (data && typeof data === 'object' && 'error' in data && typeof (data as {error: unknown}).error === 'string') {
    throw new AdminApiError(String((data as {error: string}).error), data as Record<string, unknown>);
  }
  return data as T;
}

/** Sign in and verify platform-admin membership server-side. Throws (and signs out) for non-admins. */
export async function signInAdmin(email: string, password: string): Promise<void> {
  const client = requireClient();
  const {error} = await client.auth.signInWithPassword({email: email.trim(), password});
  if (error) throw new Error(error.message || 'Не удалось войти.');
  try {
    const whoami = await invokeAdmin<{admin?: boolean}>('status');
    if (!whoami?.admin) throw new Error('NO_ADMIN');
  } catch {
    await client.auth.signOut();
    // Generic message on purpose: the endpoint never reveals whether an admin exists.
    throw new Error('Нет доступа к панели. Проверьте данные и попробуйте ещё раз.');
  }
}

export async function signOutAdmin(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** UI guard only: returns the session user or throws. Real authz stays server-side. */
export async function requireAdminSession() {
  const client = requireClient();
  const {data} = await client.auth.getSession();
  if (!data.session?.user) throw new Error('Войдите в панель.');
  return data.session.user;
}

/** Server-verified admin check for the layout guard (`status` is authoritative). */
export async function verifyAdminSession() {
  await requireAdminSession();
  const whoami = await invokeAdmin<{admin?: boolean}>('status');
  if (!whoami?.admin) {
    await signOutAdmin();
    throw new Error('Нет доступа к панели.');
  }
  return true;
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function pick<T>(...candidates: unknown[]): T | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate as T;
  }
  return undefined;
}

function normalizeHours(raw: unknown): AdminTenantRow['openingHours'] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const hours = (item ?? {}) as Record<string, unknown>;
    return {weekday: num(hours.weekday), opensAt: str(hours.opensAt ?? hours.opens_at), closesAt: str(hours.closesAt ?? hours.closes_at)};
  });
}

export function normalizeTenantRow(raw: Record<string, unknown>): AdminTenantRow {
  const status = str(raw.status, 'draft');
  const archivedAt = strOrNull(raw.archived_at);
  const suspended = status === 'paused';
  const archived = archivedAt !== null;
  const visibility: AdminTenantVisibility = archived ? 'archived' : suspended ? 'suspended' : status === 'live' ? 'live' : status === 'preview' ? 'preview' : 'draft';
  return {
    ...raw,
    id: str(raw.id),
    slug: str(raw.slug),
    name: str(raw.name, '—'),
    city: str(raw.city),
    phone: str(raw.phone),
    isDemo: Boolean(raw.is_demo),
    status,
    visibility,
    suspended,
    archived,
    suspendReason: str(raw.suspend_reason),
    suspendedAt: strOrNull(raw.suspended_at),
    archivedAt,
    updatedAt: str(raw.updated_at),
    createdAt: str(raw.created_at),
    openingHours: normalizeHours(raw.opening_hours),
  };
}

export function normalizeAuditEntry(raw: Record<string, unknown>): AdminAuditEntry {
  return {
    ...raw,
    id: str(raw.id),
    action: str(raw.action),
    tenantId: strOrNull(raw.tenant_id),
    adminUserId: strOrNull(raw.admin_user_id),
    appointmentId: strOrNull((raw as Record<string, unknown>).appointment_id),
    metadata: (raw.metadata as Record<string, unknown> | undefined) ?? undefined,
    reason: str(raw.reason),
    success: Boolean(raw.success ?? true),
    requestId: str(raw.request_id),
    createdAt: str(raw.created_at),
  };
}

export function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'admin.login': 'Вход',
    'admin.suspend': 'Приостановка',
    'admin.reactivate': 'Возобновление',
    'admin.archive': 'В архив',
    'admin.unarchive': 'Из архива',
    'admin.view': 'Просмотр',
  };
  return labels[action] ?? action;
}

export async function getAdminDashboard(): Promise<AdminDashboardMetrics> {
  const raw = await invokeAdmin<Record<string, unknown>>('dashboard');
  const tenants = ((raw.tenants ?? {}) as Record<string, unknown>);
  const payments = ((raw.payments30d ?? {}) as Record<string, unknown>);
  const recentAudit = Array.isArray(raw.recentAudit) ? raw.recentAudit : [];
  // Only computable metrics: plain counts and RECORDED payment sums. No forecasts.
  return {
    tenants: {
      total: num(tenants.total),
      draft: num(tenants.draft),
      live: num(tenants.live),
      preview: num(tenants.preview),
      paused: num(tenants.paused),
      suspended: num(tenants.suspended),
      archived: num(tenants.archived),
    },
    upcoming7d: num(raw.appointmentsUpcoming7d),
    payments30d: {
      grossMinor: num(pick(payments.grossMinor, payments.gross_minor)),
      refundMinor: num(pick(payments.refundMinor, payments.refund_minor)),
      netMinor: num(pick(payments.netMinor, payments.net_minor)),
    },
    recentAudit: (recentAudit as Record<string, unknown>[]).map(normalizeAuditEntry),
  };
}

export interface ListTenantsParams {
  search: string;
  status: AdminTenantFilter;
  limit: number;
  offset: number;
}

export async function listTenants(params: ListTenantsParams): Promise<{tenants: AdminTenantRow[]; total: number}> {
  const {status, archived} = tenantFilterParams(params.status);
  const body: Record<string, unknown> = {limit: params.limit, offset: params.offset};
  if (status) body.status = status;
  if (archived !== undefined) body.archived = archived;
  if (params.search.trim()) body.search = params.search.trim();
  const raw = await invokeAdmin<{tenants?: Record<string, unknown>[]; total?: number}>('list-tenants', body);
  return {
    tenants: Array.isArray(raw.tenants) ? raw.tenants.map(normalizeTenantRow) : [],
    total: num(raw.total),
  };
}

export async function getTenantDetail(tenantId: string): Promise<AdminTenantDetail> {
  const raw = await invokeAdmin<Record<string, unknown>>('get-tenant', {tenantId});
  if (!raw.tenant || typeof raw.tenant !== 'object') throw new Error('Студия не найдена.');
  const counts = ((raw.counts ?? {}) as Record<string, unknown>);
  const payments = ((raw.payments ?? {}) as Record<string, unknown>);
  return {
    tenant: normalizeTenantRow(raw.tenant as Record<string, unknown>),
    counts: {services: num(counts.services), resources: num(counts.resources), appointments: num(counts.appointments)},
    payments: {
      grossMinor: num(pick(payments.grossMinor, payments.gross_minor)),
      refundMinor: num(pick(payments.refundMinor, payments.refund_minor)),
      netMinor: num(pick(payments.netMinor, payments.net_minor)),
    },
  };
}

export async function listServices(tenantId: string): Promise<AdminServiceRow[]> {
  const raw = await invokeAdmin<{services?: Record<string, unknown>[]}>('list-services', {tenantId, includeInactive: true});
  return (Array.isArray(raw.services) ? raw.services : []).map((row) => ({
    ...row,
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name, '—'),
    description: str(row.description),
    category: str(row.category),
    priceMinor: num(row.price_minor),
    durationMinutes: num(row.duration_minutes),
    bufferBeforeMinutes: num(row.buffer_before_minutes),
    bufferAfterMinutes: num(row.buffer_after_minutes),
    resourceTypes: Array.isArray(row.resource_types) ? (row.resource_types as string[]) : ['any'],
    active: Boolean(row.active ?? true),
  }));
}

export async function listResources(tenantId: string): Promise<AdminResourceRow[]> {
  const raw = await invokeAdmin<{resources?: Record<string, unknown>[]}>('list-resources', {tenantId, includeInactive: true});
  return (Array.isArray(raw.resources) ? raw.resources : []).map((row) => ({
    ...row,
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name, '—'),
    resourceType: str(row.resource_type),
    location: str(row.location),
    active: Boolean(row.active ?? true),
  }));
}

export async function listTenantAppointments(tenantId: string, page: number, pageSize: number) {
  const raw = await invokeAdmin<{appointments?: Record<string, unknown>[]; total?: number}>('list-appointments', {
    tenantId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const appointments: AdminAppointmentRow[] = (Array.isArray(raw.appointments) ? raw.appointments : []).map((row) => ({
    ...row,
    id: str(row.id),
    serviceId: str(row.service_id),
    startsAt: str(row.starts_at),
    endsAt: str(row.ends_at),
    customerName: str(row.customer_name, '—'),
    customerPhone: str(row.customer_phone),
    serviceName: '',
    status: str(row.status, 'confirmed'),
    priceMinor: num(row.price_minor),
  }));
  return {appointments, total: num(raw.total)};
}

export async function listTenantPayments(tenantId: string, page: number, pageSize: number) {
  const raw = await invokeAdmin<{payments?: Record<string, unknown>[]; total?: number; totals?: Record<string, unknown>}>('list-payments', {
    tenantId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const payments: AdminPaymentRow[] = (Array.isArray(raw.payments) ? raw.payments : []).map((row) => ({
    ...row,
    id: str(row.id),
    receivedAt: str(row.received_at),
    appointmentId: str(row.appointment_id),
    kind: str(row.kind, 'charge'),
    amountMinor: num(row.amount_minor),
    method: str(row.method),
  }));
  const totals = ((raw.totals ?? {}) as Record<string, unknown>);
  return {
    payments,
    total: num(raw.total),
    grossMinor: num(pick(totals.grossMinor, totals.gross_minor)),
    refundMinor: num(pick(totals.refundMinor, totals.refund_minor)),
    netMinor: num(pick(totals.netMinor, totals.net_minor)),
  };
}

export async function listAudit(input: {tenantId?: string; page: number; pageSize: number}) {
  const body: Record<string, unknown> = {limit: input.pageSize, offset: (input.page - 1) * input.pageSize};
  if (input.tenantId) body.tenantId = input.tenantId;
  const raw = await invokeAdmin<{audit?: Record<string, unknown>[]; total?: number}>('audit-list', body);
  return {
    entries: (Array.isArray(raw.audit) ? raw.audit : []).map(normalizeAuditEntry),
    total: num(raw.total),
  };
}

export async function suspendTenant(tenantId: string, reason: string, requestId: string) {
  return invokeAdmin<{suspended?: boolean; deduped?: boolean}>('suspend', {tenantId, reason: reason.trim(), requestId});
}

export async function reactivateTenant(tenantId: string, targetStatus: 'preview' | 'live', requestId: string) {
  return invokeAdmin<{reactivated?: boolean; deduped?: boolean}>('reactivate', {tenantId, targetStatus, requestId});
}

export async function archiveTenant(tenantId: string, requestId: string, reason?: string) {
  const body: Record<string, unknown> = {tenantId, requestId};
  if (reason?.trim()) body.reason = reason.trim();
  return invokeAdmin<{archived?: boolean; deduped?: boolean}>('archive', body);
}

export async function unarchiveTenant(tenantId: string, requestId: string) {
  return invokeAdmin<{unarchived?: boolean; deduped?: boolean}>('unarchive', {tenantId, requestId});
}

export type StudioTemplate = 'detailing' | 'empty';

/** Contents seeded by the 'detailing' starter template (server contract). Shown on the create page so the choice is informed. */
export const DETAILING_TEMPLATE_CONTENTS = [
  '4 услуги с ценами и длительностью',
  'Совместимые рабочие посты',
  'Еженедельный график работы',
  'Фото, карточки и подсказки помощника',
] as const;

/** True when the server rejected an optional key it does not know yet (strict zod schema on older backends). */
function isUnrecognizedKeyError(error: unknown): boolean {
  if (!(error instanceof AdminApiError)) return false;
  return /unrecognized key/i.test(error.message);
}

export async function createTenant(input: {name: string; slug: string; timezone: string; currency: string; requestId: string; template?: StudioTemplate}) {
  const body: Record<string, unknown> = {
    name: input.name.trim(),
    slug: input.slug.trim().toLowerCase(),
    timezone: input.timezone,
    currency: input.currency.toUpperCase(),
    requestId: input.requestId,
  };
  // Always send explicitly: 'detailing' is the server default, but being
  // explicit keeps create-page behaviour independent of server defaults.
  if (input.template) body.template = input.template;
  try {
    return await invokeAdmin<{created?: boolean; deduped?: boolean; tenant?: Record<string, unknown>}>('create-tenant', body);
  } catch (error) {
    // Older servers predate `template`: retry once without it (same
    // requestId — the rejected attempt fails zod parsing before any insert).
    if (input.template && isUnrecognizedKeyError(error)) {
      const {template: _dropped, ...legacy} = body;
      void _dropped;
      return invokeAdmin<{created?: boolean; deduped?: boolean; tenant?: Record<string, unknown>}>('create-tenant', legacy);
    }
    throw error;
  }
}

export async function validateTenant(tenantId: string): Promise<ValidationReport & {tenantId: string}> {
  const raw = await invokeAdmin<Record<string, unknown>>('validate-tenant', {tenantId});
  return {...toValidationReport(raw), tenantId: str(raw.tenantId, tenantId)};
}

export async function publishTenant(tenantId: string, requestId: string) {
  // Note: on 409 the server also returns the blocking validation report
  // (errors/warnings/info) alongside the error message.
  return invokeAdmin<{published?: boolean; deduped?: boolean}>('publish-tenant', {tenantId, requestId});
}

export async function activateTenant(tenantId: string, requestId: string) {
  return invokeAdmin<{activated?: boolean; deduped?: boolean}>('activate-tenant', {tenantId, requestId});
}

/** Full business.json-shaped object for export/preview (keys are camelCase). */
export async function exportTenant(tenantId: string): Promise<Record<string, unknown>> {
  return invokeAdmin<Record<string, unknown>>('export-tenant', {tenantId});
}

export async function updateAdminTenantProfile(tenantId: string, profile: Record<string, unknown>) {
  return invokeAdmin<{saved?: boolean}>('update-tenant', {tenantId, profile});
}

export async function saveAdminService(tenantId: string, service: Record<string, unknown>) {
  return invokeAdmin<{service?: Record<string, unknown>}>('save-service', {tenantId, service});
}

export async function saveAdminResource(tenantId: string, resource: Record<string, unknown>) {
  try {
    return await invokeAdmin<{resource?: Record<string, unknown>}>('save-resource', {tenantId, resource});
  } catch (error) {
    // Older servers predate `location`: retry once without it. An empty
    // location is dropped silently; a non-empty one is reported so the data
    // loss is visible instead of silent.
    if ('location' in resource && isUnrecognizedKeyError(error)) {
      const {location: dropped, ...legacy} = resource;
      const retried = await invokeAdmin<{resource?: Record<string, unknown>}>('save-resource', {tenantId, resource: legacy});
      if (typeof dropped === 'string' && dropped.trim()) {
        // The post IS saved; only the new field was dropped. The body marker
        // lets the page show "saved with a warning" instead of a failure.
        throw new AdminApiError(
          'Пост сохранён, но место не сохранилось: сервер пока не знает это поле.',
          {locationDropped: true, saved: retried},
        );
      }
      return retried;
    }
    throw error;
  }
}

export async function saveAdminDateOverride(tenantId: string, override: Record<string, unknown>) {
  return invokeAdmin<{override?: Record<string, unknown>}>('save-date-override', {tenantId, override});
}

export interface AdminOwnerRow extends Record<string, unknown> {
  username: string;
  role: string;
  /** Optional contact email for password hand-off. Never used for login. */
  recoveryEmail: string;
  createdAt: string;
}

export type AdminOwnerRole = 'owner' | 'manager' | 'staff';

export async function listOwners(tenantId: string): Promise<AdminOwnerRow[]> {
  const raw = await invokeAdmin<{owners?: Record<string, unknown>[]}>('list-owners', {tenantId});
  return (Array.isArray(raw.owners) ? raw.owners : []).map((row) => ({
    ...row,
    username: str(row.username),
    role: str(row.role, 'owner'),
    recoveryEmail: str(row.recoveryEmail ?? row.recovery_email),
    createdAt: str(row.createdAt ?? row.created_at),
  }));
}

export async function createOwner(input: {
  tenantId: string;
  username: string;
  password: string;
  recoveryEmail?: string;
  role?: 'owner' | 'manager';
  requestId: string;
}) {
  const body: Record<string, unknown> = {
    tenantId: input.tenantId,
    username: input.username.trim().toLowerCase(),
    password: input.password,
    role: input.role ?? 'owner',
    requestId: input.requestId,
  };
  if (input.recoveryEmail?.trim()) body.recoveryEmail = input.recoveryEmail.trim();
  return invokeAdmin<{created?: boolean; deduped?: boolean; owner?: Record<string, unknown>}>('create-owner', body);
}

export async function updateOwner(
  tenantId: string,
  username: string,
  patch: {password?: string; recoveryEmail?: string; role?: AdminOwnerRole},
) {
  const body: Record<string, unknown> = {tenantId, username: username.trim().toLowerCase()};
  if (patch.password !== undefined) body.password = patch.password;
  if (patch.recoveryEmail !== undefined) body.recoveryEmail = patch.recoveryEmail.trim();
  if (patch.role !== undefined) body.role = patch.role;
  return invokeAdmin<{saved?: boolean; fields?: string[]}>('update-owner', body);
}

export async function deleteOwner(tenantId: string, username: string, requestId: string) {
  return invokeAdmin<{deleted?: boolean; deduped?: boolean; authUserDeleted?: boolean}>('delete-owner', {
    tenantId,
    username: username.trim().toLowerCase(),
    requestId,
  });
}

export interface AdminDateOverrideRow extends Record<string, unknown> {
  id: string;
  localDate: string;
  isClosed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  label: string;
}

export async function listAdminOverrides(tenantId: string): Promise<AdminDateOverrideRow[]> {
  const raw = await invokeAdmin<{overrides?: Record<string, unknown>[]}>('list-overrides', {tenantId});
  return (Array.isArray(raw.overrides) ? raw.overrides : []).map((row) => ({
    ...row,
    id: str(row.id),
    localDate: str(row.local_date),
    isClosed: Boolean(row.is_closed),
    opensAt: strOrNull(row.opens_at),
    closesAt: strOrNull(row.closes_at),
    label: str(row.label),
  }));
}

/** Tabs of the studio setup workspace. Used to link validation findings to their fix location. */
export type AdminSetupTab = 'overview' | 'branding' | 'services' | 'resources' | 'publication';

/**
 * Same compatibility rule as the server (and scripts/tenants.mjs validate):
 * a post serves a service when the service lists 'any', the post is 'any',
 * or the type sets overlap.
 */
export function isCompatibleResource(serviceTypes: string[], resourceType: string): boolean {
  const types = serviceTypes.map((value) => value.trim()).filter(Boolean);
  if (types.length === 0) return false;
  return types.includes('any') || resourceType === 'any' || types.includes(resourceType);
}

/** Active posts that can serve a service with the given resource types. */
export function compatibleResources(serviceTypes: string[], resources: AdminResourceRow[]): AdminResourceRow[] {
  return resources.filter((resource) => resource.active && isCompatibleResource(serviceTypes, resource.resourceType));
}

/**
 * Suggest resource types for a service form: when exactly one active post is
 * compatible, its type is the obvious choice; otherwise an 'any' post (when
 * present) means the default 'any' just works. Returns null when the operator
 * must choose or create a post.
 */
export function suggestServiceResourceTypes(serviceTypes: string[], resources: AdminResourceRow[]): {compatible: AdminResourceRow[]; suggestion: string[] | null} {
  const compatible = compatibleResources(serviceTypes, resources);
  if (compatible.length === 1) return {compatible, suggestion: [compatible[0].resourceType || 'any']};
  if (compatible.some((resource) => resource.resourceType === 'any')) return {compatible, suggestion: ['any']};
  return {compatible, suggestion: null};
}

export interface DerivedResourceDraft {
  name: string;
  slug: string;
  resourceType: string;
}

/**
 * One-click draft for the "no compatible post" dead end: derives the post
 * type from the service (first concrete type, else 'any') and a unique slug.
 * The caller still saves via saveAdminResource — server validation stays
 * authoritative.
 */
export function deriveResourceDraft(serviceTypes: string[], existingSlugs: string[]): DerivedResourceDraft {
  const types = serviceTypes.map((value) => value.trim()).filter(Boolean);
  const resourceType = types.find((value) => value !== 'any') ?? 'any';
  const name = resourceType === 'any' ? 'Универсальный пост' : `Пост ${resourceType}`;
  const taken = new Set(existingSlugs.map((value) => value.trim().toLowerCase()));
  let slug = suggestSlug(name) || 'post';
  for (let attempt = 2; taken.has(slug); attempt += 1) slug = `${suggestSlug(name) || 'post'}-${attempt}`;
  return {name, slug, resourceType};
}

/**
 * Map a validate-tenant finding code to the setup tab that fixes it.
 * Codes are the part before ": " in server "code: message" strings.
 */
export function validationFindingTarget(code: string): AdminSetupTab {
  if (/^(services-missing|service-)/.test(code)) return 'services';
  if (/^(demo-live-conflict|contact-placeholder)/.test(code)) return code === 'demo-live-conflict' ? 'publication' : 'branding';
  if (/^(tenant-archived|status-|counts|demo|slug-)/.test(code)) return 'overview';
  if (
    /^(name-missing|timezone-|currency-|booking-step-|cancellation-|opening-hours-|tagline|description|city|address|phone|map_url|hero_image_url|logo_url|gallery|info-cards|assistant-prompts)/.test(code)
  ) return 'branding';
  return 'overview';
}

/** Human label for a setup tab (used by fix-links). */
export function adminSetupTabLabel(tab: AdminSetupTab): string {
  if (tab === 'branding') return 'Оформление и профиль';
  if (tab === 'services') return 'Услуги';
  if (tab === 'resources') return 'Ресурсы и часы';
  if (tab === 'publication') return 'Публикация';
  return 'Обзор';
}
