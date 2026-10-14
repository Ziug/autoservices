-- Forbid bookings whose work overruns the day's closing time.
--
-- Rule (product decision): a booking may start only if
-- starts_at + duration + buffer_after <= closes_at of the booking day.
-- ends_at == closes_at is allowed. Multi-day services (whose end falls on a
-- later local date) are exempt — they inherently span days. Applies to slot
-- generation and creation; move_appointment gets the same check in
-- 202610220002 (kept separate so each behavior change is atomic).
-- Midnight-spanning overnight schedules remain unsupported (fail closed).

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
      and not (
        ((((local_start at time zone hours.timezone) + make_interval(mins => hours.duration_minutes + hours.buffer_after_minutes)) at time zone hours.timezone))::date = p_local_day
        and ((((local_start at time zone hours.timezone) + make_interval(mins => hours.duration_minutes + hours.buffer_after_minutes)) at time zone hours.timezone))::time > hours.closes_at
      )
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

-- Same rule at creation time: reject when the work would end after the
-- booking day's closing (multi-day services exempt, ends_at == closes_at
-- allowed). Uses the existing OUTSIDE_OPENING_HOURS code so no API
-- contract change is needed; the Edge maps it to a Russian message.
-- All other logic is byte-identical to 202610200001.

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
  v_local_end timestamp;
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
  v_local_end := (p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes)) at time zone v_tenant.timezone;
  if v_local_end::date = v_local_start::date and v_local_end::time > v_closes_at then
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
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
    -- NOTE: any unique_violation here is assumed to be the
    -- UNIQUE(tenant_id, idempotency_key) conflict: every other INSERT in
    -- this block either uses ON CONFLICT DO NOTHING or keys that cannot
    -- collide (fresh UUID PKs). If a new unique constraint is ever added
    -- to appointments, this handler must check the constraint name first.
    when unique_violation then
      -- Same full comparison as the pre-loop replay check: a concurrent
      -- same-key booking with different details must report a mismatch
      -- (400), not a false idempotent hit and not a raw 500.
      select * into v_existing from public.appointments where tenant_id = v_tenant.id and idempotency_key = p_idempotency_key;
      if not found then raise; end if;
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
    end;
  end loop;
  raise exception 'SLOT_TAKEN' using errcode = '23P01';
end;
$$;
