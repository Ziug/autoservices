create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

create type public.tenant_status as enum ('draft', 'preview', 'live', 'paused');
create type public.appointment_status as enum ('confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show');
create type public.occupancy_kind as enum ('appointment', 'block');
create type public.payment_kind as enum ('charge', 'refund');
create type public.notification_state as enum ('pending', 'leased', 'sent', 'failed', 'cancelled');
create type public.owner_role as enum ('owner', 'manager', 'staff');

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.tenants (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  tagline text not null default '',
  description text not null default '',
  city text not null default '',
  address text not null default '',
  phone text not null default '',
  map_url text not null default '',
  timezone text not null default 'Europe/Moscow',
  currency text not null default 'RUB' check (currency ~ '^[A-Z]{3}$'),
  locale text not null default 'ru-RU',
  accent_color text not null default '#4690FF' check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  hero_image_url text not null default '',
  logo_url text not null default '',
  is_demo boolean not null default true,
  status public.tenant_status not null default 'draft',
  booking_step_minutes integer not null default 30 check (booking_step_minutes between 5 and 120),
  cancellation_window_hours integer not null default 12 check (cancellation_window_hours >= 0),
  opening_hours jsonb not null default '[]'::jsonb check (jsonb_typeof(opening_hours) = 'array'),
  gallery jsonb not null default '[]'::jsonb check (jsonb_typeof(gallery) = 'array'),
  info_cards jsonb not null default '[]'::jsonb check (jsonb_typeof(info_cards) = 'array'),
  assistant_prompts jsonb not null default '[]'::jsonb check (jsonb_typeof(assistant_prompts) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, slug)
);

create trigger tenants_updated_at before update on public.tenants
for each row execute function public.set_updated_at();

create table public.tenant_memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.owner_role not null default 'staff',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table public.services (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null default '',
  category text not null default 'Услуга',
  price_minor bigint not null check (price_minor >= 0),
  duration_minutes integer not null check (duration_minutes > 0),
  buffer_before_minutes integer not null default 0 check (buffer_before_minutes >= 0),
  buffer_after_minutes integer not null default 0 check (buffer_after_minutes >= 0),
  resource_types text[] not null default array['any']::text[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug)
);

create trigger services_updated_at before update on public.services
for each row execute function public.set_updated_at();

create table public.resources (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slug text not null,
  name text not null,
  resource_type text not null default 'any',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug)
);

create trigger resources_updated_at before update on public.resources
for each row execute function public.set_updated_at();

create table public.date_overrides (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  local_date date not null,
  is_closed boolean not null default false,
  opens_at time,
  closes_at time,
  label text not null default '',
  created_at timestamptz not null default now(),
  check ((is_closed and opens_at is null and closes_at is null) or (not is_closed and opens_at is not null and closes_at is not null and opens_at < closes_at)),
  unique (tenant_id, local_date)
);

create table public.appointments (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  service_id uuid not null,
  resource_id uuid not null,
  customer_name text not null,
  customer_phone text not null,
  vehicle text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  price_minor bigint not null check (price_minor >= 0),
  status public.appointment_status not null default 'confirmed',
  idempotency_key uuid not null,
  access_token_hash text not null,
  customer_note text not null default '',
  checked_in_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, service_id) references public.services(tenant_id, id) on delete restrict,
  foreign key (tenant_id, resource_id) references public.resources(tenant_id, id) on delete restrict
);

create index appointments_tenant_start_idx on public.appointments (tenant_id, starts_at) where status <> 'cancelled';
create index appointments_tenant_status_start_idx on public.appointments (tenant_id, status, starts_at);

create trigger appointments_updated_at before update on public.appointments
for each row execute function public.set_updated_at();

create table public.resource_occupancies (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  resource_id uuid not null,
  appointment_id uuid,
  kind public.occupancy_kind not null,
  occupied tstzrange not null,
  label text not null default '',
  released_at timestamptz,
  created_at timestamptz not null default now(),
  check (not isempty(occupied)),
  unique (tenant_id, id),
  foreign key (tenant_id, resource_id) references public.resources(tenant_id, id) on delete restrict,
  foreign key (tenant_id, appointment_id) references public.appointments(tenant_id, id) on delete cascade,
  exclude using gist (tenant_id with =, resource_id with =, occupied with &&)
    where (released_at is null)
);

create index resource_occupancies_active_idx on public.resource_occupancies using gist (tenant_id, occupied) where released_at is null;

create table public.payments (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  appointment_id uuid not null,
  kind public.payment_kind not null,
  amount_minor bigint not null check (amount_minor > 0),
  method text not null default 'cash',
  note text not null default '',
  recorded_by uuid references auth.users(id) on delete set null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, appointment_id) references public.appointments(tenant_id, id) on delete restrict
);

create index payments_tenant_received_idx on public.payments (tenant_id, received_at);

create table public.notification_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid,
  job_type text not null check (job_type in ('booking_confirmed', 'booking_reminder', 'booking_cancelled', 'booking_changed')),
  state public.notification_state not null default 'pending',
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, appointment_id) references public.appointments(tenant_id, id) on delete cascade,
  unique (tenant_id, dedupe_key)
);

create index notification_jobs_due_idx on public.notification_jobs (run_after) where state in ('pending', 'leased');

create trigger notification_jobs_updated_at before update on public.notification_jobs
for each row execute function public.set_updated_at();

create table public.push_subscriptions (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, appointment_id) references public.appointments(tenant_id, id) on delete cascade,
  unique (tenant_id, endpoint)
);

create table public.api_rate_limits (
  bucket_key text primary key,
  window_started_at timestamptz not null,
  hit_count integer not null check (hit_count >= 0),
  updated_at timestamptz not null default now()
);

create table public.llm_usage_daily (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  local_day date not null,
  reserved_calls integer not null default 0,
  reserved_tokens integer not null default 0,
  reserved_cost_micros bigint not null default 0 check (reserved_cost_micros >= 0),
  actual_input_tokens bigint not null default 0,
  actual_output_tokens bigint not null default 0,
  cost_micros bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, local_day)
);

create or replace function public.consume_api_limit(p_bucket_key text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.api_rate_limits as limits (bucket_key, window_started_at, hit_count)
  values (p_bucket_key, now(), 1)
  on conflict (bucket_key) do update
  set window_started_at = case when limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then now() else limits.window_started_at end,
      hit_count = case when limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then 1 else limits.hit_count + 1 end,
      updated_at = now()
  returning hit_count into v_count;
  return v_count <= p_limit;
end;
$$;

create or replace function public.reserve_llm_budget(p_tenant_id uuid, p_local_day date, p_daily_calls integer, p_daily_tokens integer, p_reserved_tokens integer, p_daily_cost_micros bigint, p_reserved_cost_micros bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_calls integer;
begin
  if p_daily_calls <= 0 or p_daily_tokens < 0 or p_daily_cost_micros < 0
    or p_reserved_tokens <= 0 or p_reserved_cost_micros < 0
    or p_reserved_tokens > p_daily_tokens or p_reserved_cost_micros > p_daily_cost_micros then
    return false;
  end if;
  insert into public.llm_usage_daily as usage (tenant_id, local_day, reserved_calls, reserved_tokens, reserved_cost_micros)
  values (p_tenant_id, p_local_day, 1, p_reserved_tokens, p_reserved_cost_micros)
  on conflict (tenant_id, local_day) do update
  set reserved_calls = usage.reserved_calls + 1,
      reserved_tokens = usage.reserved_tokens + p_reserved_tokens,
      reserved_cost_micros = usage.reserved_cost_micros + p_reserved_cost_micros,
      updated_at = now()
  where usage.reserved_calls < p_daily_calls
    and usage.reserved_tokens + p_reserved_tokens <= p_daily_tokens
    and usage.reserved_cost_micros + p_reserved_cost_micros <= p_daily_cost_micros
  returning reserved_calls into v_calls;
  return found;
end;
$$;

create or replace function public.record_llm_usage(p_tenant_id uuid, p_local_day date, p_input_tokens integer, p_output_tokens integer, p_cost_micros bigint)
returns void language sql security definer set search_path = '' as $$
  update public.llm_usage_daily
  set actual_input_tokens = actual_input_tokens + greatest(p_input_tokens, 0),
      actual_output_tokens = actual_output_tokens + greatest(p_output_tokens, 0),
      cost_micros = cost_micros + greatest(p_cost_micros, 0),
      updated_at = now()
  where tenant_id = p_tenant_id and local_day = p_local_day;
$$;

create or replace function public.public_booking_slots(p_slug text, p_service_slug text, p_local_day date)
returns table (starts_at timestamptz, available_count integer)
language sql stable security definer set search_path = '' as $$
  with selected as (
    select t.id as tenant_id, t.timezone, t.booking_step_minutes, s.id as service_id,
      s.duration_minutes, s.buffer_before_minutes, s.buffer_after_minutes, s.resource_types
    from public.tenants t
    join public.services s on s.tenant_id = t.id and s.slug = p_service_slug and s.active
    where t.slug = p_slug and t.status in ('preview', 'live')
  ), hours as (
    select selected.*, coalesce(overrides.is_closed, false) as is_closed,
      coalesce(overrides.opens_at, (selected_open.day_value->>'opensAt')::time) as opens_at,
      coalesce(overrides.closes_at, (selected_open.day_value->>'closesAt')::time) as closes_at
    from selected
    left join public.date_overrides overrides on overrides.tenant_id = selected.tenant_id and overrides.local_date = p_local_day
    left join lateral (
      select day_value from jsonb_array_elements((select t.opening_hours from public.tenants t where t.id = selected.tenant_id)) as day_value
      where (day_value->>'weekday')::integer = extract(dow from p_local_day)::integer
      limit 1
    ) selected_open on true
  ), candidates as (
    select hours.tenant_id, hours.service_id, hours.duration_minutes, hours.buffer_before_minutes, hours.buffer_after_minutes,
      hours.resource_types, hours.timezone,
      local_start at time zone hours.timezone as starts_at
    from hours
    cross join lateral generate_series(
      p_local_day + hours.opens_at,
      p_local_day + hours.closes_at - make_interval(mins => hours.booking_step_minutes),
      make_interval(mins => hours.booking_step_minutes)
    ) local_start
    where not hours.is_closed and hours.opens_at is not null and hours.closes_at is not null and hours.opens_at < hours.closes_at
      and local_start at time zone hours.timezone > now()
  )
  select candidates.starts_at,
    cast(count(resources.id) filter (where not exists (
      select 1 from public.resource_occupancies occupancy
      where occupancy.tenant_id = candidates.tenant_id
        and occupancy.resource_id = resources.id
        and occupancy.released_at is null
        and occupancy.occupied && tstzrange(
          candidates.starts_at - make_interval(mins => candidates.buffer_before_minutes),
          candidates.starts_at + make_interval(mins => candidates.duration_minutes + candidates.buffer_after_minutes), '[)')
    )) as integer) as available_count
  from candidates
  join public.resources resources on resources.tenant_id = candidates.tenant_id and resources.active
    and (resources.resource_type = 'any' or candidates.resource_types = array['any']::text[] or resources.resource_type = any(candidates.resource_types))
  group by candidates.starts_at
  order by candidates.starts_at;
$$;

create or replace function public.create_public_booking(
  p_slug text,
  p_service_slug text,
  p_starts_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_vehicle text,
  p_idempotency_key uuid,
  p_access_token_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tenant public.tenants%rowtype;
  v_service public.services%rowtype;
  v_resource public.resources%rowtype;
  v_existing public.appointments%rowtype;
  v_appointment public.appointments%rowtype;
  v_override public.date_overrides%rowtype;
  v_local_start timestamp;
  v_hours jsonb;
  v_opens_at time;
  v_closes_at time;
  v_resource_types text[];
begin
  select * into v_tenant from public.tenants where slug = p_slug and status in ('preview', 'live') for share;
  if not found then raise exception 'TENANT_NOT_AVAILABLE' using errcode = 'P0002'; end if;
  select * into v_service from public.services where tenant_id = v_tenant.id and slug = p_service_slug and active for share;
  if not found then raise exception 'SERVICE_NOT_AVAILABLE' using errcode = 'P0002'; end if;
  if length(trim(p_customer_name)) not between 2 and 100 or length(trim(p_customer_phone)) not between 5 and 40 or length(trim(p_vehicle)) not between 2 and 120 then
    raise exception 'INVALID_CUSTOMER_DETAILS' using errcode = '22023';
  end if;
  select * into v_existing from public.appointments where tenant_id = v_tenant.id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.access_token_hash <> p_access_token_hash then raise exception 'IDEMPOTENCY_KEY_MISMATCH' using errcode = '22023'; end if;
    if v_existing.service_id <> v_service.id or v_existing.starts_at <> p_starts_at
      or v_existing.customer_name <> trim(p_customer_name) or v_existing.customer_phone <> trim(p_customer_phone)
      or v_existing.vehicle <> trim(p_vehicle) then
      raise exception 'IDEMPOTENCY_KEY_MISMATCH' using errcode = '22023';
    end if;
    return jsonb_build_object('id', v_existing.id, 'tenant_id', v_existing.tenant_id, 'service_id', v_existing.service_id,
      'resource_id', v_existing.resource_id, 'starts_at', v_existing.starts_at, 'ends_at', v_existing.ends_at,
      'status', v_existing.status, 'price_minor', v_existing.price_minor, 'customer_name', v_existing.customer_name,
      'customer_phone', v_existing.customer_phone, 'vehicle', v_existing.vehicle, 'idempotent', true);
  end if;
  if p_starts_at <= now() then raise exception 'BOOKING_TIME_IN_PAST' using errcode = '22023'; end if;
  if p_starts_at > now() + interval '90 days' then raise exception 'BOOKING_TOO_FAR_AHEAD' using errcode = '22023'; end if;
  v_local_start := p_starts_at at time zone v_tenant.timezone;
  select item into v_hours from jsonb_array_elements(v_tenant.opening_hours) item
    where (item->>'weekday')::integer = extract(dow from v_local_start)::integer limit 1;
  select * into v_override from public.date_overrides where tenant_id = v_tenant.id and local_date = v_local_start::date;
  if found then
    if v_override.is_closed then raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023'; end if;
    v_opens_at := v_override.opens_at;
    v_closes_at := v_override.closes_at;
  else
    if v_hours is null then raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023'; end if;
    v_opens_at := (v_hours->>'opensAt')::time;
    v_closes_at := (v_hours->>'closesAt')::time;
  end if;
  if v_local_start::time < v_opens_at or v_local_start::time >= v_closes_at then
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
  end if;
  if mod((extract(epoch from (v_local_start::time - v_opens_at)) / 60)::integer, v_tenant.booking_step_minutes) <> 0 then
    raise exception 'INVALID_BOOKING_STEP' using errcode = '22023';
  end if;

  for v_resource in
    select * from public.resources resources
    where resources.tenant_id = v_tenant.id and resources.active
      and (resources.resource_type = 'any' or v_service.resource_types = array['any']::text[] or resources.resource_type = any(v_service.resource_types))
    order by resources.slug
  loop
    begin
      insert into public.appointments (tenant_id, service_id, resource_id, customer_name, customer_phone, vehicle,
        starts_at, ends_at, price_minor, idempotency_key, access_token_hash)
      values (v_tenant.id, v_service.id, v_resource.id, trim(p_customer_name), trim(p_customer_phone), trim(p_vehicle),
        p_starts_at, p_starts_at + make_interval(mins => v_service.duration_minutes), v_service.price_minor, p_idempotency_key, p_access_token_hash)
      returning * into v_appointment;
      insert into public.resource_occupancies (tenant_id, resource_id, appointment_id, kind, occupied, label)
      values (v_tenant.id, v_resource.id, v_appointment.id, 'appointment',
        tstzrange(p_starts_at - make_interval(mins => v_service.buffer_before_minutes),
          p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes), '[)'), v_service.name);
      if not v_tenant.is_demo and p_starts_at > now() + interval '24 hours' then
        insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
        values (v_tenant.id, v_appointment.id, 'booking_reminder', p_starts_at - interval '24 hours', 'reminder:' || v_appointment.id::text,
          jsonb_build_object('channel', 'push')) on conflict (tenant_id, dedupe_key) do nothing;
      end if;
      insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
      values (v_tenant.id, v_appointment.id, 'booking_confirmed', now(), 'confirmed:' || v_appointment.id::text,
        jsonb_build_object('channel', 'push')) on conflict (tenant_id, dedupe_key) do nothing;
      return jsonb_build_object('id', v_appointment.id, 'tenant_id', v_appointment.tenant_id, 'service_id', v_appointment.service_id,
        'resource_id', v_appointment.resource_id, 'starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at,
        'status', v_appointment.status, 'price_minor', v_appointment.price_minor, 'customer_name', v_appointment.customer_name,
        'customer_phone', v_appointment.customer_phone, 'vehicle', v_appointment.vehicle, 'idempotent', false);
    exception when exclusion_violation then
      continue;
    when unique_violation then
      select * into v_existing from public.appointments where tenant_id = v_tenant.id and idempotency_key = p_idempotency_key;
      if found and v_existing.access_token_hash = p_access_token_hash then
        return jsonb_build_object('id', v_existing.id, 'tenant_id', v_existing.tenant_id, 'service_id', v_existing.service_id,
          'resource_id', v_existing.resource_id, 'starts_at', v_existing.starts_at, 'ends_at', v_existing.ends_at,
          'status', v_existing.status, 'price_minor', v_existing.price_minor, 'customer_name', v_existing.customer_name,
          'customer_phone', v_existing.customer_phone, 'vehicle', v_existing.vehicle, 'idempotent', true);
      end if;
      raise;
    end;
  end loop;
  raise exception 'SLOT_TAKEN' using errcode = '23P01';
end;
$$;

create or replace function public.cancel_appointment(p_tenant_id uuid, p_appointment_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_appointment public.appointments%rowtype;
begin
  select * into v_appointment from public.appointments where tenant_id = p_tenant_id and id = p_appointment_id for update;
  if not found or v_appointment.status in ('cancelled', 'completed', 'no_show') then return false; end if;
  update public.appointments set status = 'cancelled', cancelled_at = now() where id = v_appointment.id;
  update public.resource_occupancies set released_at = now() where tenant_id = p_tenant_id and appointment_id = v_appointment.id and released_at is null;
  insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
  values (p_tenant_id, v_appointment.id, 'booking_cancelled', now(), 'cancelled:' || v_appointment.id::text, jsonb_build_object('channel', 'push'))
  on conflict (tenant_id, dedupe_key) do nothing;
  update public.notification_jobs set state = 'cancelled', updated_at = now()
  where tenant_id = p_tenant_id and appointment_id = v_appointment.id and job_type = 'booking_reminder' and state = 'pending';
  return true;
end;
$$;

create or replace function public.move_appointment(p_tenant_id uuid, p_appointment_id uuid, p_starts_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_appointment public.appointments%rowtype;
  v_service public.services%rowtype;
  v_occupancy public.resource_occupancies%rowtype;
  v_tenant public.tenants%rowtype;
  v_resource public.resources%rowtype;
  v_override public.date_overrides%rowtype;
  v_local_start timestamp;
  v_hours jsonb;
  v_opens_at time;
  v_closes_at time;
begin
  select * into v_appointment from public.appointments where tenant_id = p_tenant_id and id = p_appointment_id for update;
  if not found or v_appointment.status <> 'confirmed' then raise exception 'APPOINTMENT_NOT_MOVABLE' using errcode = '22023'; end if;
  select * into v_tenant from public.tenants where id = p_tenant_id;
  select * into v_service from public.services where tenant_id = p_tenant_id and id = v_appointment.service_id and active;
  if not found then raise exception 'SERVICE_NOT_AVAILABLE' using errcode = '22023'; end if;
  select * into v_resource from public.resources where tenant_id = p_tenant_id and id = v_appointment.resource_id and active;
  if not found or not (v_resource.resource_type = 'any' or v_service.resource_types = array['any']::text[] or v_resource.resource_type = any(v_service.resource_types)) then
    raise exception 'RESOURCE_NOT_COMPATIBLE' using errcode = '22023';
  end if;
  if p_starts_at <= now() or p_starts_at > now() + interval '90 days' then raise exception 'INVALID_BOOKING_TIME' using errcode = '22023'; end if;
  v_local_start := p_starts_at at time zone v_tenant.timezone;
  select item into v_hours from jsonb_array_elements(v_tenant.opening_hours) item
    where (item->>'weekday')::integer = extract(dow from v_local_start)::integer limit 1;
  select * into v_override from public.date_overrides where tenant_id = p_tenant_id and local_date = v_local_start::date;
  if found then
    if v_override.is_closed then raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023'; end if;
    v_opens_at := v_override.opens_at;
    v_closes_at := v_override.closes_at;
  elsif v_hours is not null then
    v_opens_at := (v_hours->>'opensAt')::time;
    v_closes_at := (v_hours->>'closesAt')::time;
  else
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
  end if;
  if v_local_start::time < v_opens_at or v_local_start::time >= v_closes_at
    or mod((extract(epoch from (v_local_start::time - v_opens_at)) / 60)::integer, v_tenant.booking_step_minutes) <> 0 then
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
  end if;
  select * into v_occupancy from public.resource_occupancies where tenant_id = p_tenant_id and appointment_id = p_appointment_id and released_at is null for update;
  if not found then raise exception 'APPOINTMENT_OCCUPANCY_NOT_FOUND' using errcode = '22023'; end if;
  update public.resource_occupancies set occupied = tstzrange(p_starts_at - make_interval(mins => v_service.buffer_before_minutes),
    p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes), '[)')
  where id = v_occupancy.id;
  update public.appointments set starts_at = p_starts_at, ends_at = p_starts_at + make_interval(mins => v_service.duration_minutes)
  where id = p_appointment_id returning * into v_appointment;
  update public.notification_jobs set state = 'cancelled', updated_at = now()
  where tenant_id = p_tenant_id and appointment_id = p_appointment_id and job_type = 'booking_reminder' and state = 'pending';
  if not (select is_demo from public.tenants where id = p_tenant_id) then
    insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
    values (p_tenant_id, p_appointment_id, 'booking_changed', now(), 'changed:' || p_appointment_id::text || ':' || extract(epoch from p_starts_at)::bigint::text,
      jsonb_build_object('channel', 'push')) on conflict (tenant_id, dedupe_key) do nothing;
    if p_starts_at > now() + interval '24 hours' then
      insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
      values (p_tenant_id, p_appointment_id, 'booking_reminder', p_starts_at - interval '24 hours', 'reminder:' || p_appointment_id::text || ':' || extract(epoch from p_starts_at)::bigint::text,
        jsonb_build_object('channel', 'push')) on conflict (tenant_id, dedupe_key) do nothing;
    end if;
  end if;
  return jsonb_build_object('id', v_appointment.id, 'starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at, 'status', v_appointment.status);
end;
$$;

create or replace function public.set_appointment_status(p_tenant_id uuid, p_appointment_id uuid, p_status public.appointment_status)
returns public.appointments language plpgsql security definer set search_path = '' as $$
declare
  v_result public.appointments%rowtype;
begin
  if p_status = 'cancelled' then raise exception 'USE_CANCEL_APPOINTMENT' using errcode = '22023'; end if;
  update public.appointments
  set status = p_status,
      checked_in_at = case when p_status = 'checked_in' then now() else checked_in_at end,
      completed_at = case when p_status = 'completed' then now() else completed_at end
  where tenant_id = p_tenant_id and id = p_appointment_id
    and status not in ('cancelled', 'completed', 'no_show')
  returning * into v_result;
  if not found then raise exception 'APPOINTMENT_NOT_UPDATABLE' using errcode = '22023'; end if;
  if p_status in ('completed', 'no_show') then
    update public.resource_occupancies set released_at = now() where tenant_id = p_tenant_id and appointment_id = p_appointment_id and released_at is null;
  end if;
  return v_result;
end;
$$;

create or replace function public.create_availability_block(p_tenant_id uuid, p_resource_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_label text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_ends_at <= p_starts_at then raise exception 'INVALID_BLOCK_RANGE' using errcode = '22023'; end if;
  insert into public.resource_occupancies (tenant_id, resource_id, kind, occupied, label)
  values (p_tenant_id, p_resource_id, 'block', tstzrange(p_starts_at, p_ends_at, '[)'), left(trim(p_label), 120)) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.add_payment(p_tenant_id uuid, p_appointment_id uuid, p_kind public.payment_kind, p_amount_minor bigint, p_method text, p_note text, p_recorded_by uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_payment_id uuid;
begin
  if p_amount_minor <= 0 or p_kind not in ('charge', 'refund') then raise exception 'INVALID_PAYMENT' using errcode = '22023'; end if;
  if not exists (select 1 from public.appointments where tenant_id = p_tenant_id and id = p_appointment_id) then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.payments (tenant_id, appointment_id, kind, amount_minor, method, note, recorded_by)
  values (p_tenant_id, p_appointment_id, p_kind, p_amount_minor, left(p_method, 32), left(p_note, 300), p_recorded_by) returning id into v_payment_id;
  return v_payment_id;
end;
$$;

create or replace function public.owner_metrics(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (arrivals bigint, completed bigint, collected_minor bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from public.tenant_memberships where tenant_id = p_tenant_id and user_id = auth.uid()) then
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

create or replace function public.owner_metrics_for_edge(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (arrivals bigint, completed bigint, collected_minor bigint)
language sql stable security definer set search_path = '' as $$
  select
    count(*) filter (where appointment.status not in ('cancelled', 'no_show')),
    count(*) filter (where appointment.status = 'completed'),
    coalesce((select sum(case payment.kind when 'charge' then payment.amount_minor else -payment.amount_minor end)
      from public.payments payment where payment.tenant_id = p_tenant_id and payment.received_at >= p_from and payment.received_at < p_to), 0)::bigint
  from public.appointments appointment
  where appointment.tenant_id = p_tenant_id and appointment.starts_at >= p_from and appointment.starts_at < p_to;
$$;

create or replace function public.claim_notification_jobs(p_batch_size integer default 50)
returns setof public.notification_jobs language sql security definer set search_path = '' as $$
  with due as (
    select id from public.notification_jobs
    where (state = 'pending' and run_after <= now()) or (state = 'leased' and lease_until < now())
    order by run_after for update skip locked limit greatest(1, least(p_batch_size, 200))
  )
  update public.notification_jobs jobs
  set state = 'leased', lease_until = now() + interval '2 minutes', attempts = jobs.attempts + 1, updated_at = now()
  from due where jobs.id = due.id returning jobs.*;
$$;

create or replace function public.finish_notification_job(p_id uuid, p_sent boolean, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.notification_jobs
  set state = case when p_sent then 'sent'::public.notification_state else case when attempts >= 5 then 'failed'::public.notification_state else 'pending'::public.notification_state end end,
      run_after = case when p_sent then run_after else now() + make_interval(mins => least(60, attempts * 5)) end,
      lease_until = null, sent_at = case when p_sent then now() else sent_at end,
      last_error = case when p_sent then null else left(coalesce(p_error, 'delivery failed'), 500) end,
      updated_at = now()
  where id = p_id and state = 'leased';
$$;

create or replace function public.save_push_subscription(p_tenant_id uuid, p_appointment_id uuid, p_endpoint text, p_p256dh text, p_auth_secret text, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if length(p_endpoint) > 2000 or length(p_p256dh) > 512 or length(p_auth_secret) > 512 then raise exception 'INVALID_PUSH_SUBSCRIPTION' using errcode = '22023'; end if;
  if not exists (select 1 from public.appointments appointment where appointment.tenant_id = p_tenant_id and appointment.id = p_appointment_id and appointment.status = 'confirmed') then raise exception 'APPOINTMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.push_subscriptions (tenant_id, appointment_id, endpoint, p256dh, auth_secret, expires_at)
  values (p_tenant_id, p_appointment_id, p_endpoint, p_p256dh, p_auth_secret, p_expires_at)
  on conflict (tenant_id, endpoint) do update set appointment_id = excluded.appointment_id, p256dh = excluded.p256dh, auth_secret = excluded.auth_secret, expires_at = excluded.expires_at
  returning id into v_id;
  return v_id;
end;
$$;

alter table public.tenants enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.services enable row level security;
alter table public.resources enable row level security;
alter table public.date_overrides enable row level security;
alter table public.appointments enable row level security;
alter table public.resource_occupancies enable row level security;
alter table public.payments enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.api_rate_limits enable row level security;
alter table public.llm_usage_daily enable row level security;

create policy "Published tenants are public" on public.tenants for select to anon, authenticated using (status in ('preview', 'live'));
create policy "Members can inspect their tenant" on public.tenants for select to authenticated using (exists (select 1 from public.tenant_memberships m where m.tenant_id = id and m.user_id = auth.uid()));
create policy "Published services are public" on public.services for select to anon, authenticated using (active and exists (select 1 from public.tenants t where t.id = tenant_id and t.status in ('preview', 'live')));
create policy "Owners can inspect services" on public.services for select to authenticated using (exists (select 1 from public.tenant_memberships m where m.tenant_id = tenant_id and m.user_id = auth.uid()));
create policy "Published resources are public" on public.resources for select to anon, authenticated using (active and exists (select 1 from public.tenants t where t.id = tenant_id and t.status in ('preview', 'live')));
create policy "Members can inspect their resources" on public.resources for select to authenticated using (exists (select 1 from public.tenant_memberships m where m.tenant_id = tenant_id and m.user_id = auth.uid()));
create policy "Owners can inspect date overrides" on public.date_overrides for select to authenticated using (exists (select 1 from public.tenant_memberships m where m.tenant_id = tenant_id and m.user_id = auth.uid()));
create policy "Members can read their memberships" on public.tenant_memberships for select to authenticated using (user_id = auth.uid());
create policy "Members can read tenant appointments" on public.appointments for select to authenticated using (exists (select 1 from public.tenant_memberships m where m.tenant_id = tenant_id and m.user_id = auth.uid()));
create policy "Members can read tenant occupancies" on public.resource_occupancies for select to authenticated using (exists (select 1 from public.tenant_memberships m where m.tenant_id = tenant_id and m.user_id = auth.uid()));
create policy "Members can read tenant payments" on public.payments for select to authenticated using (exists (select 1 from public.tenant_memberships m where m.tenant_id = tenant_id and m.user_id = auth.uid()));

revoke all on public.tenants, public.tenant_memberships, public.services, public.resources, public.date_overrides,
  public.appointments, public.resource_occupancies, public.payments, public.notification_jobs, public.push_subscriptions,
  public.api_rate_limits, public.llm_usage_daily from anon, authenticated;
grant select on public.tenants, public.services, public.resources to anon, authenticated;
grant select on public.tenant_memberships, public.resources, public.date_overrides, public.appointments,
  public.resource_occupancies, public.payments to authenticated;
grant all on public.tenants, public.tenant_memberships, public.services, public.resources, public.date_overrides,
  public.appointments, public.resource_occupancies, public.payments, public.notification_jobs, public.push_subscriptions,
  public.api_rate_limits, public.llm_usage_daily to service_role;

revoke all on function public.consume_api_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.reserve_llm_budget(uuid, date, integer, integer, integer, bigint, bigint) from public, anon, authenticated;
revoke all on function public.record_llm_usage(uuid, date, integer, integer, bigint) from public, anon, authenticated;
revoke all on function public.public_booking_slots(text, text, date) from public, anon, authenticated;
revoke all on function public.create_public_booking(text, text, timestamptz, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_appointment(uuid, uuid) from public, anon, authenticated;
revoke all on function public.move_appointment(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.set_appointment_status(uuid, uuid, public.appointment_status) from public, anon, authenticated;
revoke all on function public.create_availability_block(uuid, uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.add_payment(uuid, uuid, public.payment_kind, bigint, text, text, uuid) from public, anon, authenticated;
revoke all on function public.claim_notification_jobs(integer) from public, anon, authenticated;
revoke all on function public.finish_notification_job(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.save_push_subscription(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.owner_metrics(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.owner_metrics_for_edge(uuid, timestamptz, timestamptz) from public, anon, authenticated;

grant execute on function public.consume_api_limit(text, integer, integer) to service_role;
grant execute on function public.reserve_llm_budget(uuid, date, integer, integer, integer, bigint, bigint) to service_role;
grant execute on function public.record_llm_usage(uuid, date, integer, integer, bigint) to service_role;
grant execute on function public.public_booking_slots(text, text, date) to service_role;
grant execute on function public.create_public_booking(text, text, timestamptz, text, text, text, uuid, text) to service_role;
grant execute on function public.cancel_appointment(uuid, uuid) to service_role;
grant execute on function public.move_appointment(uuid, uuid, timestamptz) to service_role;
grant execute on function public.set_appointment_status(uuid, uuid, public.appointment_status) to service_role;
grant execute on function public.create_availability_block(uuid, uuid, timestamptz, timestamptz, text) to service_role;
grant execute on function public.add_payment(uuid, uuid, public.payment_kind, bigint, text, text, uuid) to service_role;
grant execute on function public.claim_notification_jobs(integer) to service_role;
grant execute on function public.finish_notification_job(uuid, boolean, text) to service_role;
grant execute on function public.save_push_subscription(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.owner_metrics(uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.owner_metrics_for_edge(uuid, timestamptz, timestamptz) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-media', 'tenant-media', true, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Public reads published tenant media" on storage.objects for select to anon, authenticated
using (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenants tenant where tenant.slug = split_part(name, '/', 1) and tenant.status in ('preview', 'live')
));

create policy "Tenant members upload media only under their slug" on storage.objects for insert to authenticated
with check (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid() and tenant.slug = split_part(name, '/', 1)
));

create policy "Tenant members update media only under their slug" on storage.objects for update to authenticated
using (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid() and tenant.slug = split_part(name, '/', 1)
)) with check (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid() and tenant.slug = split_part(name, '/', 1)
));
