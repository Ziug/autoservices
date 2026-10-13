-- Containment hardening: suspended/archived owners must not keep reading
-- customer PII via direct PostgREST after suspension. Edge mutations were
-- already blocked via tenantBySlug allow-list; this closes the read path.
-- Admin inspection uses service_role (bypasses RLS) and is unaffected.
-- Idempotent: DROP IF EXISTS + CREATE, safe to re-run.

drop policy if exists "Members can read tenant appointments" on public.appointments;
create policy "Members can read tenant appointments" on public.appointments
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = tenant_id and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Members can read tenant payments" on public.payments;
create policy "Members can read tenant payments" on public.payments
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = tenant_id and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Members can read tenant occupancies" on public.resource_occupancies;
create policy "Members can read tenant occupancies" on public.resource_occupancies
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = tenant_id and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Owners can inspect services" on public.services;
create policy "Owners can inspect services" on public.services
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = tenant_id and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Members can inspect their resources" on public.resources;
create policy "Members can inspect their resources" on public.resources
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = tenant_id and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Owners can inspect date overrides" on public.date_overrides;
create policy "Owners can inspect date overrides" on public.date_overrides
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = tenant_id and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

-- Append-only audit log: belt-and-braces deny of UPDATE/DELETE even for
-- service_role callers (RLS is bypassed by service_role, so enforce here).
create or replace function public.prevent_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'ADMIN_AUDIT_IMMUTABLE' using errcode = '42501';
end;
$$;

drop trigger if exists admin_audit_log_no_update on public.admin_audit_log;
create trigger admin_audit_log_no_update
  before update or delete on public.admin_audit_log
  for each row execute function public.prevent_audit_mutation();
