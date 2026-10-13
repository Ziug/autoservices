-- Super Admin corrective migration (do NOT edit 202610130001_admin.sql).
--
-- Repairs and completes the platform-admin extension:
-- 1. admin_audit_log.appointment_id had an invalid inline FK in 0001: a single
--    column cannot reference the two-column key
--    public.appointments(tenant_id, id) (ERROR 42830). It is re-pointed at
--    public.appointments(id) ON DELETE SET NULL.
-- 2. appointments_admin_list_idx column order is now
--    (tenant_id, status, starts_at DESC) so equality columns come first.
-- 3. Partial UNIQUE index on admin_audit_log(request_id) WHERE
--    request_id <> '' gives requestId idempotency to the admin-api Edge
--    Function (plain INSERT; unique violation 23505 or a pre-check hit
--    returns {deduped:true}).
-- 4. Explicit REVOKE FROM public on the new tables/functions.
-- 5. owner_metrics_for_edge now refuses suspended/archived tenants
--    (defense in depth; Edge already allow-lists preview/live).
--
-- Every statement is idempotent (IF NOT EXISTS / OR REPLACE /
-- DROP IF EXISTS / guarded DO block), so this file converges a
-- fully-applied, partially-applied, or never-applied 0001 to the same
-- correct end state.

-- Suspension / archival metadata on tenants (no-op if 0001 applied).
-- Reuses tenant_status 'paused' as the enforced suspended state; archiving is
-- tracked via archived_at while keeping status='paused'. No new enum value.
alter table public.tenants
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_by uuid references auth.users(id) on delete set null,
  add column if not exists suspend_reason text not null default '',
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users(id) on delete set null;

-- Platform administrators: separate identity table, never derived from
-- tenant_memberships or client-supplied email.
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  label text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

-- Append-only audit log. NOTE: appointment_id is declared WITHOUT an inline
-- FK here; the correct single-column FK is added below. This keeps the file
-- valid whether the table is fresh or already exists.
create table if not exists public.admin_audit_log (
  id uuid primary key default extensions.gen_random_uuid(),
  admin_user_id uuid references auth.users(id) on delete set null,
  action text not null check (action in (
    'admin.login', 'admin.suspend', 'admin.reactivate',
    'admin.archive', 'admin.unarchive', 'admin.view'
  )),
  tenant_id uuid references public.tenants(id) on delete set null,
  appointment_id uuid,
  reason text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  success boolean not null default true,
  request_id text not null default '',
  created_at timestamptz not null default now()
);

-- Backfill the FK column in case an older revision created the table without
-- it; no-op otherwise.
alter table public.admin_audit_log
  add column if not exists appointment_id uuid;

-- Drop the invalid FK from 0001 (single column referencing
-- appointments(tenant_id, id)). No-op when it was never created.
alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_appointment_id_fkey;

-- Correct single-column FK, guarded so re-runs stay no-ops.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'admin_audit_log_appointment_id_fkey'
  ) then
    alter table public.admin_audit_log
      add constraint admin_audit_log_appointment_id_fkey
      foreign key (appointment_id) references public.appointments(id) on delete set null;
  end if;
end
$$;

create index if not exists admin_audit_log_tenant_idx on public.admin_audit_log (tenant_id, created_at desc);
create index if not exists admin_audit_log_admin_idx on public.admin_audit_log (admin_user_id, created_at desc);
create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index if not exists tenants_status_updated_idx on public.tenants (status, updated_at desc);
create index if not exists tenants_archived_idx on public.tenants (archived_at) where archived_at is not null;

-- Correct column order: equality columns first (tenant_id, status), then the
-- range/order column (starts_at DESC). DROP + CREATE (not merely IF NOT
-- EXISTS) so a wrong-order index from 0001 is replaced.
drop index if exists public.appointments_admin_list_idx;
create index if not exists appointments_admin_list_idx
  on public.appointments (tenant_id, status, starts_at desc);

-- Idempotency for admin-api mutations: at most one audit row per request_id.
-- Partial so legacy/empty '' rows never conflict with each other.
create unique index if not exists admin_audit_log_request_id_uidx
  on public.admin_audit_log (request_id) where request_id <> '';

-- Helper: true when the calling JWT belongs to a platform admin.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_admins where user_id = auth.uid()
  );
$$;

-- Public visibility probe: reveals only whether a slug is bookable,
-- suspended/archived, or unknown. No reasons, no PII, no tokens.
create or replace function public.public_tenant_visibility(p_slug text)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.tenants where slug = p_slug and status in ('preview', 'live')) then 'bookable'
    when exists (select 1 from public.tenants where slug = p_slug and status = 'paused' and archived_at is not null) then 'archived'
    when exists (select 1 from public.tenants where slug = p_slug and status = 'paused') then 'suspended'
    when exists (select 1 from public.tenants where slug = p_slug) then 'unavailable'
    else 'not_found'
  end;
$$;

-- Harden owner_metrics: suspended/archived tenants must not authorize
-- owner operations even through direct RPC (defense in depth; the Edge
-- owner-api already rejects them via tenantBySlug allow-list).
create or replace function public.owner_metrics(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (arrivals bigint, completed bigint, collected_minor bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from public.tenant_memberships where tenant_id = p_tenant_id and user_id = auth.uid()) then
    raise exception 'TENANT_ACCESS_DENIED' using errcode = '42501';
  end if;
  if exists (select 1 from public.tenants where id = p_tenant_id and status not in ('preview', 'live')) then
    raise exception 'TENANT_ACCESS_DENIED' using errcode = '42501';
  end if;
  return query
  select
    count(*) filter (where appointment.status not in ('cancelled', 'no_show')),
    count(*) filter (where appointment.status = 'completed'),
    coalesce((select sum(case payment.kind when 'charge' then payment.amount_minor else -payment.amount_minor end)
      from public.payments payment where payment.tenant_id = p_tenant_id and payment.received_at >= p_from and payment.received_at < p_to), 0)::bigint
  from public.appointments appointment
  where appointment.tenant_id = p_tenant_id and appointment.starts_at >= p_from and appointment.starts_at < p_to;
end;
$$;

-- Same status guard for the service_role Edge entrypoint. It runs without a
-- calling user (no membership check possible), so only the tenant-status
-- gate applies here.
create or replace function public.owner_metrics_for_edge(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (arrivals bigint, completed bigint, collected_minor bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.tenants where id = p_tenant_id and status not in ('preview', 'live')) then
    raise exception 'TENANT_ACCESS_DENIED' using errcode = '42501';
  end if;
  return query
  select
    count(*) filter (where appointment.status not in ('cancelled', 'no_show')),
    count(*) filter (where appointment.status = 'completed'),
    coalesce((select sum(case payment.kind when 'charge' then payment.amount_minor else -payment.amount_minor end)
      from public.payments payment where payment.tenant_id = p_tenant_id and payment.received_at >= p_from and payment.received_at < p_to), 0)::bigint
  from public.appointments appointment
  where appointment.tenant_id = p_tenant_id and appointment.starts_at >= p_from and appointment.starts_at < p_to;
end;
$$;

-- RLS for new tables: deny direct client access; service_role (Edge
-- admin-api) bypasses RLS. Platform admins may read audit via policy.
alter table public.platform_admins enable row level security;
alter table public.admin_audit_log enable row level security;

drop policy if exists "Platform admins can read admin list" on public.platform_admins;
create policy "Platform admins can read admin list" on public.platform_admins
  for select to authenticated using (public.is_platform_admin());

drop policy if exists "Platform admins can read audit log" on public.admin_audit_log;
create policy "Platform admins can read audit log" on public.admin_audit_log
  for select to authenticated using (public.is_platform_admin());

-- Storage: suspended/archived owners must not upload new media.
-- Recreate upload/update policies with a live-status guard.
drop policy if exists "Tenant members upload media only under their slug" on storage.objects;
drop policy if exists "Tenant members update media only under their slug" on storage.objects;

create policy "Tenant members upload media only under their slug" on storage.objects for insert to authenticated
with check (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid() and tenant.slug = split_part(name, '/', 1)
    and tenant.status in ('preview', 'live')
));

create policy "Tenant members update media only under their slug" on storage.objects for update to authenticated
using (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid() and tenant.slug = split_part(name, '/', 1)
    and tenant.status in ('preview', 'live')
)) with check (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid() and tenant.slug = split_part(name, '/', 1)
    and tenant.status in ('preview', 'live')
));

-- Grants: keep new tables service_role-only for writes; allow
-- authenticated to attempt reads (RLS still enforces admin check).
-- Explicit REVOKE FROM public (in addition to anon/authenticated) so the
-- platform tables never inherit permissive defaults.
revoke all on public.platform_admins, public.admin_audit_log from public, anon, authenticated;
grant select on public.platform_admins, public.admin_audit_log to authenticated;
grant all on public.platform_admins, public.admin_audit_log to service_role;

revoke all on function public.is_platform_admin() from public, anon, authenticated;
grant execute on function public.is_platform_admin() to authenticated, service_role;

revoke all on function public.public_tenant_visibility(text) from public, anon, authenticated;
grant execute on function public.public_tenant_visibility(text) to anon, authenticated, service_role;

revoke all on function public.owner_metrics_for_edge(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.owner_metrics_for_edge(uuid, timestamptz, timestamptz) to service_role;
