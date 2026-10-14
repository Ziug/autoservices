-- Fix tenant scoping in member/owner read policies (critical PII leak).
--
-- Root cause: inside EXISTS (SELECT ... FROM tenant_memberships m ...),
-- the unqualified `tenant_id` resolves to the INNER table (m.tenant_id),
-- so `m.tenant_id = tenant_id` deploys as the tautology
-- `m.tenant_id = m.tenant_id`. Any authenticated member of ANY
-- preview/live tenant could SELECT appointments (customer names/phones),
-- payments, occupancies, services, resources and overrides of EVERY
-- preview/live tenant. The tenants policy was unaffected (memberships has
-- no `id` column, so `id` fell through to the outer table).
--
-- Fix: qualify the outer table explicitly (appointments.tenant_id, …).
-- Policy names, roles, commands and the preview/live guard from
-- 202610130003_containment.sql are preserved. Writes are untouched
-- (no INSERT/UPDATE/DELETE policies exist; default deny holds).
-- Safe to re-run (DROP IF EXISTS + CREATE). Safe for existing data
-- (policy-only change, no row rewrite).

drop policy if exists "Members can read tenant appointments" on public.appointments;
create policy "Members can read tenant appointments" on public.appointments
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = appointments.tenant_id
        and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Members can read tenant payments" on public.payments;
create policy "Members can read tenant payments" on public.payments
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = payments.tenant_id
        and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Members can read tenant occupancies" on public.resource_occupancies;
create policy "Members can read tenant occupancies" on public.resource_occupancies
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = resource_occupancies.tenant_id
        and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Owners can inspect services" on public.services;
create policy "Owners can inspect services" on public.services
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = services.tenant_id
        and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Members can inspect their resources" on public.resources;
create policy "Members can inspect their resources" on public.resources
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = resources.tenant_id
        and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Owners can inspect date overrides" on public.date_overrides;
create policy "Owners can inspect date overrides" on public.date_overrides
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = date_overrides.tenant_id
        and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );
