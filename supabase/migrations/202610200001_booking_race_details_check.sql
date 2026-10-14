-- Harden the idempotency race path in create_public_booking.
--
-- The pre-loop replay check verifies the access-token hash AND the full
-- booking details (service, start, customer fields) before returning
-- idempotent:true. The unique_violation rescue path (two concurrent
-- transactions inserting the same idempotency key) only verified the token
-- hash, so same-key-different-details racers could get a false
-- idempotent:true. This replaces the handler with the same full comparison;
-- mismatches re-raise instead of returning the other booking.
-- No behavior change for matching retries. No other logic touched.

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
