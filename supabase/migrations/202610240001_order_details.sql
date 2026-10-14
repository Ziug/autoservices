-- Order details: additional service line items and owner notes per appointment.
--
-- Design decisions:
-- * The final order total is COMPUTED, never stored: appointments.price_minor
--   is the original service price snapshot (untouched by extras), and the
--   order total = price_minor + SUM(appointment_services.price_minor). No
--   redundant/denormalized column that could drift.
-- * Extra services snapshot name+price at insert time and reference the
--   catalog row (service_id) only for traceability; a later catalog price
--   change never rewrites an existing order line, and deleting/hiding the
--   catalog service keeps the line (ON DELETE SET NULL).
-- * Payments/refunds stay in the existing payments table (kind charge/refund,
--   amount, method, received_at). No new payment tables, no invented statuses.
-- * Duplicate submissions are safe via request_id (client-generated uuid,
--   UNIQUE per tenant): a replay inserts nothing and returns the existing row.
-- * Tenant isolation: composite FKs (tenant_id, appointment_id) and
--   (tenant_id, service_id); member-read RLS policies use QUALIFIED outer
--   columns (the shadowing bug fixed in 202610190001); anon gets nothing.

create table public.appointment_services (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  appointment_id uuid not null,
  service_id uuid,
  name text not null check (length(trim(name)) between 2 and 100),
  price_minor bigint not null check (price_minor >= 0 and price_minor <= 1000000000000),
  kind text not null default 'extra' check (kind in ('extra', 'custom')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, request_id),
  foreign key (tenant_id, appointment_id) references public.appointments(tenant_id, id) on delete cascade,
  foreign key (tenant_id, service_id) references public.services(tenant_id, id) on delete set null
);

create index appointment_services_tenant_appt_idx on public.appointment_services (tenant_id, appointment_id, created_at);

create table public.appointment_notes (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  appointment_id uuid not null,
  body text not null check (length(trim(body)) between 1 and 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, request_id),
  foreign key (tenant_id, appointment_id) references public.appointments(tenant_id, id) on delete cascade
);

create index appointment_notes_tenant_appt_idx on public.appointment_notes (tenant_id, appointment_id, created_at);

alter table public.appointment_services enable row level security;
alter table public.appointment_notes enable row level security;

drop policy if exists "Members can read tenant appointment services" on public.appointment_services;
create policy "Members can read tenant appointment services" on public.appointment_services
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = appointment_services.tenant_id
        and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

drop policy if exists "Members can read tenant appointment notes" on public.appointment_notes;
create policy "Members can read tenant appointment notes" on public.appointment_notes
  for select to authenticated using (
    exists (
      select 1 from public.tenant_memberships m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id = appointment_notes.tenant_id
        and m.user_id = auth.uid()
        and t.status in ('preview', 'live')
    )
  );

revoke all on public.appointment_services, public.appointment_notes from anon, authenticated;
grant select on public.appointment_services, public.appointment_notes to authenticated;
grant all on public.appointment_services, public.appointment_notes to service_role;
