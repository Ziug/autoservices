import { z } from 'npm:zod@4.6.6';
import { adminClient, checkRateLimit, deterministicAccessToken, errorMessage, errorStatus, forbiddenOrigin, json, preflight, requireMembership, sha256, tenantBySlug, userFromRequest } from '../_shared/http.ts';
const slug = z.string().regex(/^[a-z0-9-]+$/);
const dateTime = z.iso.datetime({
  offset: true
});
const paymentSchema = z.object({
  appointmentId: z.uuid(),
  kind: z.enum([
    'charge',
    'refund'
  ]),
  amountMinor: z.number().int().positive(),
  method: z.string().min(1).max(32),
  note: z.string().max(300).default('')
});
const serviceSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().max(1000).default(''),
  category: z.string().min(1).max(80),
  priceMinor: z.number().int().nonnegative(),
  durationMinutes: z.number().int().positive().max(10080),
  bufferBeforeMinutes: z.number().int().nonnegative().max(1440),
  bufferAfterMinutes: z.number().int().nonnegative().max(1440),
  resourceTypes: z.array(z.string().min(1).max(40)).min(1).max(8),
  active: z.boolean().default(true)
}).strict();
const profileSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  tagline: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().min(2).max(1500).optional(),
  city: z.string().trim().min(2).max(100).optional(),
  address: z.string().trim().min(3).max(300).optional(),
  phone: z.string().trim().min(5).max(40).optional(),
  mapUrl: z.url().max(1000).optional(),
  timezone: z.string().min(3).max(100).refine((value)=>{
    try {
      new Intl.DateTimeFormat('en', {
        timeZone: value
      });
      return true;
    } catch  {
      return false;
    }
  }).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  locale: z.string().min(2).max(20).optional(),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  heroImage: z.string().max(2000).optional(),
  logoImage: z.string().max(2000).optional(),
  bookingStepMinutes: z.number().int().min(5).max(120).optional(),
  cancellationWindowHours: z.number().int().min(0).max(720).optional(),
  openingHours: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    opensAt: z.string().regex(/^\d{2}:\d{2}$/),
    closesAt: z.string().regex(/^\d{2}:\d{2}$/)
  })).max(7).optional(),
  gallery: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    image: z.string().min(1).max(2000),
    caption: z.string().min(1).max(180),
    position: z.number().int().nonnegative()
  })).max(30).optional(),
  infoCards: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(400)
  })).length(3).optional(),
  assistantPrompts: z.array(z.string().min(1).max(160)).min(1).max(8).optional()
}).strict();
const payloadSchema = z.object({
  slug,
  action: z.string().min(1).max(32)
}).catchall(z.unknown());
function forbidRole(role, minimum) {
  const allowed = minimum === 'owner' ? [
    'owner'
  ] : [
    'owner',
    'manager'
  ];
  if (!allowed.includes(role)) throw Object.assign(new Error('Only an owner or manager can change these settings.'), {
    status: 403
  });
}
function mapProfile(profile) {
  const columnMap = {
    name: 'name',
    tagline: 'tagline',
    description: 'description',
    city: 'city',
    address: 'address',
    phone: 'phone',
    mapUrl: 'map_url',
    timezone: 'timezone',
    currency: 'currency',
    locale: 'locale',
    accentColor: 'accent_color',
    heroImage: 'hero_image_url',
    logoImage: 'logo_url',
    bookingStepMinutes: 'booking_step_minutes',
    cancellationWindowHours: 'cancellation_window_hours',
    openingHours: 'opening_hours',
    gallery: 'gallery',
    infoCards: 'info_cards',
    assistantPrompts: 'assistant_prompts'
  };
  return Object.fromEntries(Object.entries(profile).map(([key, value])=>[
      columnMap[key],
      value
    ]));
}
Deno.serve(async (request)=>{
  if (forbiddenOrigin(request)) return json(request, {
    error: 'Origin is not allowed.'
  }, 403);
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return json(request, {
    error: 'Method not allowed.'
  }, 405);
  try {
    const input = payloadSchema.parse(await request.json());
    const admin = adminClient();
    const user = await userFromRequest(request);
    if (!user) return json(request, {
      error: 'Войдите в кабинет владельца.'
    }, 401);
    const tenant = await tenantBySlug(admin, input.slug);
    if (!tenant) return json(request, {
      error: 'Студия не найдена.'
    }, 404);
    const role = await requireMembership(admin, tenant.id, user.id);
    if (!role) return json(request, {
      error: 'У этой учётной записи нет доступа к студии.'
    }, 403);
    if (!await checkRateLimit(admin, request, 'owner-api', tenant.id, 120, 300)) return json(request, {
      error: 'Слишком много действий. Попробуйте позже.'
    }, 429);
    switch(input.action){
      case 'set-status':
        {
          const args = z.object({
            appointmentId: z.uuid(),
            status: z.enum([
              'checked_in',
              'in_progress',
              'completed',
              'no_show'
            ])
          }).parse(input);
          const { data, error } = await admin.rpc('set_appointment_status', {
            p_tenant_id: tenant.id,
            p_appointment_id: args.appointmentId,
            p_status: args.status
          });
          if (error) return json(request, {
            error: errorMessage(error)
          }, errorStatus(error));
          return json(request, {
            appointment: data
          });
        }
      case 'cancel':
        {
          const args = z.object({
            appointmentId: z.uuid()
          }).parse(input);
          const { data, error } = await admin.rpc('cancel_appointment', {
            p_tenant_id: tenant.id,
            p_appointment_id: args.appointmentId
          });
          if (error) return json(request, {
            error: errorMessage(error)
          }, errorStatus(error));
          return json(request, {
            cancelled: data === true
          });
        }
      case 'move':
        {
          const args = z.object({
            appointmentId: z.uuid(),
            startsAt: dateTime
          }).parse(input);
          const { data, error } = await admin.rpc('move_appointment', {
            p_tenant_id: tenant.id,
            p_appointment_id: args.appointmentId,
            p_starts_at: args.startsAt
          });
          if (error) return json(request, {
            error: errorMessage(error)
          }, errorStatus(error));
          return json(request, {
            appointment: data
          });
        }
      case 'add-extra-service':
        {
          forbidRole(role, 'manager');
          const args = z.object({
            appointmentId: z.uuid(),
            requestId: z.uuid().optional(),
            serviceSlug: z.string().regex(/^[a-z0-9-]+$/).optional(),
            name: z.string().trim().min(2).max(100).optional(),
            priceMinor: z.number().int().min(1).max(1000000000000).optional()
          }).strict().refine((value)=>Boolean(value.serviceSlug) !== Boolean(value.name && value.priceMinor !== undefined), 'Provide either serviceSlug (catalog service) or name + priceMinor (custom service).').parse(input);
          const { data: appointment, error: appointmentError } = await admin.from('appointments').select('id').eq('tenant_id', tenant.id).eq('id', args.appointmentId).maybeSingle();
          if (appointmentError) throw appointmentError;
          if (!appointment) return json(request, {
            error: 'Запись не найдена.'
          }, 404);
          let serviceId = null;
          let name;
          let priceMinor;
          let kind;
          if (args.serviceSlug) {
            const { data: service, error: serviceError } = await admin.from('services').select('id,name,price_minor').eq('tenant_id', tenant.id).eq('slug', args.serviceSlug).eq('active', true).maybeSingle();
            if (serviceError) throw serviceError;
            if (!service) return json(request, {
              error: 'Услуга не найдена или скрыта.'
            }, 404);
            // Snapshot name+price: a later catalog price change must not rewrite this order line.
            serviceId = service.id;
            name = service.name;
            priceMinor = service.price_minor;
            kind = 'extra';
          } else {
            serviceId = null;
            name = args.name.trim();
            priceMinor = args.priceMinor;
            kind = 'custom';
          }
          const requestId = args.requestId ?? crypto.randomUUID();
          // Duplicate-safe: the (tenant_id, request_id) unique makes a replay a no-op.
          const { error: insertError } = await admin.from('appointment_services').upsert({
            request_id: requestId,
            tenant_id: tenant.id,
            appointment_id: args.appointmentId,
            service_id: serviceId,
            name,
            price_minor: priceMinor,
            kind,
            created_by: user.id
          }, {
            onConflict: 'tenant_id,request_id'
          });
          if (insertError) throw insertError;
          const { data: saved, error: savedError } = await admin.from('appointment_services').select('id,service_id,name,price_minor,kind,created_at').eq('tenant_id', tenant.id).eq('request_id', requestId).single();
          if (savedError) throw savedError;
          return json(request, {
            extraService: saved
          });
        }
      case 'add-note':
        {
          const args = z.object({
            appointmentId: z.uuid(),
            requestId: z.uuid().optional(),
            body: z.string().trim().min(1).max(1000)
          }).strict().parse(input);
          const { data: appointment, error: appointmentError } = await admin.from('appointments').select('id').eq('tenant_id', tenant.id).eq('id', args.appointmentId).maybeSingle();
          if (appointmentError) throw appointmentError;
          if (!appointment) return json(request, {
            error: 'Запись не найдена.'
          }, 404);
          const requestId = args.requestId ?? crypto.randomUUID();
          const { error: insertError } = await admin.from('appointment_notes').upsert({
            request_id: requestId,
            tenant_id: tenant.id,
            appointment_id: args.appointmentId,
            body: args.body.trim(),
            created_by: user.id
          }, {
            onConflict: 'tenant_id,request_id'
          });
          if (insertError) throw insertError;
          const { data: saved, error: savedError } = await admin.from('appointment_notes').select('id,body,created_at').eq('tenant_id', tenant.id).eq('request_id', requestId).single();
          if (savedError) throw savedError;
          return json(request, {
            note: saved
          });
        }
      case 'add-payment':
        {
          forbidRole(role, 'manager');
          const args = paymentSchema.parse(input);
          const { data, error } = await admin.rpc('add_payment', {
            p_tenant_id: tenant.id,
            p_appointment_id: args.appointmentId,
            p_kind: args.kind,
            p_amount_minor: args.amountMinor,
            p_method: args.method,
            p_note: args.note,
            p_recorded_by: user.id
          });
          if (error) return json(request, {
            error: errorMessage(error)
          }, errorStatus(error));
          return json(request, {
            paymentId: data
          });
        }
      case 'add-booking':
        {
          const args = z.object({
            serviceSlug: slug,
            startsAt: dateTime,
            customerName: z.string().trim().min(2).max(100),
            customerPhone: z.string().trim().min(5).max(40),
            vehicle: z.string().trim().min(2).max(120),
            idempotencyKey: z.uuid()
          }).parse(input);
          const accessToken = await deterministicAccessToken(input.slug, args.idempotencyKey);
          const { data, error } = await admin.rpc('create_public_booking', {
            p_slug: input.slug,
            p_service_slug: args.serviceSlug,
            p_starts_at: args.startsAt,
            p_customer_name: args.customerName,
            p_customer_phone: args.customerPhone,
            p_vehicle: args.vehicle,
            p_idempotency_key: args.idempotencyKey,
            p_access_token_hash: await sha256(accessToken)
          });
          if (error) return json(request, {
            error: errorMessage(error)
          }, errorStatus(error));
          return json(request, {
            appointment: data,
            accessToken
          });
        }
      case 'create-block':
        {
          const args = z.object({
            resourceId: z.uuid(),
            startsAt: dateTime,
            endsAt: dateTime,
            label: z.string().trim().min(1).max(120)
          }).parse(input);
          const { data, error } = await admin.rpc('create_availability_block', {
            p_tenant_id: tenant.id,
            p_resource_id: args.resourceId,
            p_starts_at: args.startsAt,
            p_ends_at: args.endsAt,
            p_label: args.label
          });
          if (error) return json(request, {
            error: errorMessage(error)
          }, errorStatus(error));
          return json(request, {
            blockId: data
          });
        }
      case 'update-profile':
        {
          forbidRole(role, 'manager');
          const { profile } = z.object({
            profile: profileSchema
          }).parse(input);
          const patch = mapProfile(profile);
          if (!Object.keys(patch).length) return json(request, {
            error: 'Нет изменений для сохранения.'
          }, 400);
          const { error } = await admin.from('tenants').update(patch).eq('id', tenant.id);
          if (error) throw error;
          return json(request, {
            saved: true
          });
        }
      case 'save-service':
        {
          forbidRole(role, 'manager');
          const service = serviceSchema.parse(input.service);
          const { data, error } = await admin.from('services').upsert({
            tenant_id: tenant.id,
            slug: service.slug,
            name: service.name,
            description: service.description,
            category: service.category,
            price_minor: service.priceMinor,
            duration_minutes: service.durationMinutes,
            buffer_before_minutes: service.bufferBeforeMinutes,
            buffer_after_minutes: service.bufferAfterMinutes,
            resource_types: service.resourceTypes,
            active: service.active
          }, {
            onConflict: 'tenant_id,slug'
          }).select('id,slug,name,price_minor,duration_minutes').single();
          if (error) throw error;
          return json(request, {
            service: data
          });
        }
      case 'save-resource':
        {
          forbidRole(role, 'owner');
          const resource = z.object({
            slug,
            name: z.string().trim().min(2).max(100),
            resourceType: z.string().min(1).max(40),
            active: z.boolean().default(true)
          }).parse(input.resource);
          const { data, error } = await admin.from('resources').upsert({
            tenant_id: tenant.id,
            slug: resource.slug,
            name: resource.name,
            resource_type: resource.resourceType,
            active: resource.active
          }, {
            onConflict: 'tenant_id,slug'
          }).select('id,slug,name,resource_type').single();
          if (error) throw error;
          return json(request, {
            resource: data
          });
        }
      case 'save-date-override':
        {
          forbidRole(role, 'manager');
          const override = z.object({
            localDate: z.iso.date(),
            isClosed: z.boolean(),
            opensAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
            closesAt: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
            label: z.string().max(120).default('')
          }).parse(input.override);
          const { data, error } = await admin.from('date_overrides').upsert({
            tenant_id: tenant.id,
            local_date: override.localDate,
            is_closed: override.isClosed,
            opens_at: override.isClosed ? null : override.opensAt,
            closes_at: override.isClosed ? null : override.closesAt,
            label: override.label
          }, {
            onConflict: 'tenant_id,local_date'
          }).select('id,local_date,is_closed,opens_at,closes_at,label').single();
          if (error) throw error;
          return json(request, {
            override: data
          });
        }
      default:
        return json(request, {
          error: 'Неизвестное действие.'
        }, 400);
    }
  } catch (error) {
    const status = error?.status ?? errorStatus(error);
    const detail = (error as {details?: string})?.details ?? (error as {message?: string})?.message ?? 'unknown';
    console.error('owner-api error:', JSON.stringify({code: (error as {code?: string})?.code, status, detail}));
    return json(request, {error: errorMessage(error)}, status);
  }
});
