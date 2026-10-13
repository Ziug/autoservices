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
 *
 * Mutations are idempotent via client-generated `requestId` (createClientId);
 * replays return { deduped: true } and are treated as success.
 */
import {supabase} from '@/lib/supabase';
import {createClientId} from '@/lib/id';

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
  category: string;
  priceMinor: number;
  durationMinutes: number;
  active: boolean;
}

export interface AdminResourceRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  resourceType: string;
  active: boolean;
}

export interface AdminTenantDetail {
  tenant: AdminTenantRow;
  counts: {services: number; resources: number; appointments: number};
  payments: {grossMinor: number; refundMinor: number; netMinor: number};
}

export function newRequestId(): string {
  return createClientId();
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
async function readFunctionErrorBody(error: unknown): Promise<string | null> {
  try {
    const context = (error as {context?: unknown}).context;
    if (context instanceof Response) {
      const copy = context.clone();
      const body = (await copy.json()) as {error?: unknown};
      if (body && typeof body.error === 'string' && body.error) return body.error;
    }
  } catch {
    // Fall through to the generic message.
  }
  return null;
}

async function invokeAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const client = requireClient();
  const {data, error} = await client.functions.invoke('admin-api', {body: {action, ...payload}});
  if (error) {
    const detail = await readFunctionErrorBody(error);
    throw new Error(detail ?? (error instanceof Error && error.message ? error.message : 'Не удалось выполнить запрос. Попробуйте ещё раз.'));
  }
  if (data && typeof data === 'object' && 'error' in data && typeof (data as {error: unknown}).error === 'string') {
    throw new Error(String((data as {error: string}).error));
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
    category: str(row.category),
    priceMinor: num(row.price_minor),
    durationMinutes: num(row.duration_minutes),
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
