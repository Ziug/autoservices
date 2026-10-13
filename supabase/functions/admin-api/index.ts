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

const NOT_FOUND = {error: 'Not found.'} as const;

const uuid = z.uuid();
const dateTime = z.iso.datetime({offset: true});
const slug = z.string().regex(/^[a-z0-9-]+$/);
const tenantStatus = z.enum(['draft', 'preview', 'live', 'paused']);
const appointmentStatus = z.enum(['confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show']);
const auditAction = z.enum(['admin.login', 'admin.suspend', 'admin.reactivate', 'admin.archive', 'admin.unarchive', 'admin.view']);
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
  'id,tenant_id,slug,name,resource_type,active,created_at,updated_at';
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
        return json(request, {appointments: data ?? [], total: count ?? 0, limit: args.limit, offset: args.offset});
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
        return json(request, {
          payments: data ?? [],
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
      case 'audit-list': {
        const args = auditListSchema.parse(params);
        let query = admin.from('admin_audit_log').select(AUDIT_COLUMNS, {count: 'exact'})
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
