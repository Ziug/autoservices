insert into public.tenants (
  slug, name, tagline, description, city, address, phone, map_url, timezone, currency, locale,
  accent_color, hero_image_url, logo_url, is_demo, status, booking_step_minutes,
  cancellation_window_hours, opening_hours, gallery, info_cards, assistant_prompts
)
values
  (
    'graphite-detailing', 'GRAPHITE Detailing', 'Точный уход за автомобилем',
    'Детейлинг, полировка и защитные покрытия с бережным отношением к каждой детали.',
    'Санкт-Петербург', 'Санкт-Петербург, Лиговский проспект, 274', '+7 812 000-00-00',
    'https://maps.google.com/?q=Saint+Petersburg+auto+detailing', 'Europe/Moscow', 'RUB', 'ru-RU', '#4690FF',
    'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1800&q=85',
    '/tenants/graphite-detailing/images/mark.svg', true, 'preview', 30, 12,
    '[{"weekday":1,"opensAt":"09:00","closesAt":"20:00"},{"weekday":2,"opensAt":"09:00","closesAt":"20:00"},{"weekday":3,"opensAt":"09:00","closesAt":"20:00"},{"weekday":4,"opensAt":"09:00","closesAt":"20:00"},{"weekday":5,"opensAt":"09:00","closesAt":"20:00"},{"weekday":6,"opensAt":"10:00","closesAt":"18:00"}]',
    '[{"id":"paint","image":"https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80","caption":"Глубокий блеск после полировки","position":0},{"id":"interior","image":"https://images.unsplash.com/photo-1507136566006-cfc505b114fc?auto=format&fit=crop&w=1200&q=80","caption":"Чистый салон до мелочей","position":1},{"id":"coating","image":"https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=1200&q=80","caption":"Защитное покрытие кузова","position":2}]',
    '[{"id":"care","title":"Аккуратно","body":"Работаем с материалами по их состоянию и рекомендациям производителя."},{"id":"quality","title":"Под контролем","body":"Согласуем перечень работ и стоимость до начала."},{"id":"timing","title":"По записи","body":"Выберите удобное окно — мы заранее подготовим пост."}]',
    '["Когда ближайшее окно?","Сколько стоит полировка?","Как найти студию?"]'
  ),
  (
    'ceramica-garage', 'Ceramica Garage', 'Защита и восстановление кузова',
    'Мастерская керамических покрытий, оклейки и точечной коррекции лакокрасочного покрытия.',
    'Казань', 'Казань, улица Техническая, 7', '+7 843 000-00-00',
    'https://maps.google.com/?q=Kazan+car+care', 'Europe/Moscow', 'RUB', 'ru-RU', '#D88A4A',
    'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1800&q=85',
    '/tenants/ceramica-garage/images/mark.svg', true, 'preview', 60, 24,
    '[{"weekday":1,"opensAt":"10:00","closesAt":"19:00"},{"weekday":2,"opensAt":"10:00","closesAt":"19:00"},{"weekday":3,"opensAt":"10:00","closesAt":"19:00"},{"weekday":4,"opensAt":"10:00","closesAt":"19:00"},{"weekday":5,"opensAt":"10:00","closesAt":"19:00"},{"weekday":6,"opensAt":"11:00","closesAt":"16:00"}]',
    '[{"id":"film","image":"https://images.unsplash.com/photo-1617814076367-b759c7d7e738?auto=format&fit=crop&w=1200&q=80","caption":"Защитная плёнка на передней части","position":0},{"id":"finish","image":"https://images.unsplash.com/photo-1607860108855-64acf2078ed9?auto=format&fit=crop&w=1200&q=80","caption":"Финишная полировка перед защитой","position":1}]',
    '[{"id":"consult","title":"Подбор покрытия","body":"Сначала обсудим задачи и состояние автомобиля."},{"id":"materials","title":"Материалы с гарантией","body":"Уточняем условия ухода и эксплуатации после работ."},{"id":"handover","title":"Прозрачная приёмка","body":"Фиксируем состояние автомобиля и объём работ."}]',
    '["Какие есть покрытия?","Сколько стоит оклейка?","Можно приехать на осмотр?"]'
  )
on conflict (slug) do update set
  name = excluded.name, tagline = excluded.tagline, description = excluded.description, city = excluded.city,
  address = excluded.address, phone = excluded.phone, map_url = excluded.map_url, timezone = excluded.timezone,
  currency = excluded.currency, locale = excluded.locale, accent_color = excluded.accent_color,
  hero_image_url = excluded.hero_image_url, logo_url = excluded.logo_url, is_demo = excluded.is_demo,
  status = excluded.status, booking_step_minutes = excluded.booking_step_minutes,
  cancellation_window_hours = excluded.cancellation_window_hours, opening_hours = excluded.opening_hours,
  gallery = excluded.gallery, info_cards = excluded.info_cards, assistant_prompts = excluded.assistant_prompts;

insert into public.services (tenant_id, slug, name, description, category, price_minor, duration_minutes, buffer_before_minutes, buffer_after_minutes, resource_types, active)
select tenant.id, service.slug, service.name, service.description, service.category, service.price_minor,
  service.duration_minutes, service.buffer_before_minutes, service.buffer_after_minutes, service.resource_types, true
from public.tenants tenant
join (values
  ('graphite-detailing','express-care','Экспресс-уход','Деликатная мойка, сушка и быстрая уборка салона.','Уход',490000,90,10,20,array['any']::text[]),
  ('graphite-detailing','interior-detail','Детейлинг салона','Глубокая очистка материалов и защита поверхностей.','Салон',1250000,240,15,30,array['any']::text[]),
  ('graphite-detailing','paint-correction','Полировка кузова','Восстановление блеска и коррекция мелких дефектов лака.','Кузов',2850000,600,30,60,array['any']::text[]),
  ('graphite-detailing','ceramic-coating','Керамическая защита','Многоэтапная подготовка и нанесение защитного покрытия.','Защита',5490000,1440,60,120,array['any','coating']::text[]),
  ('ceramica-garage','ceramic-check','Диагностика покрытия','Осмотр кузова и подбор системы защиты.','Осмотр',0,60,10,10,array['any']::text[]),
  ('ceramica-garage','film-front','Защита передней части плёнкой','Оклейка зон повышенного риска прозрачной плёнкой.','Плёнка',3290000,720,30,60,array['any','film']::text[]),
  ('ceramica-garage','ceramic-pro','Керамика Pro','Подготовка поверхности и двухслойное защитное покрытие.','Керамика',4190000,1800,60,120,array['any','coating']::text[])
 ) as service(tenant_slug, slug, name, description, category, price_minor, duration_minutes, buffer_before_minutes, buffer_after_minutes, resource_types)
on tenant.slug = service.tenant_slug
on conflict (tenant_id, slug) do update set
  name = excluded.name, description = excluded.description, category = excluded.category, price_minor = excluded.price_minor,
  duration_minutes = excluded.duration_minutes, buffer_before_minutes = excluded.buffer_before_minutes,
  buffer_after_minutes = excluded.buffer_after_minutes, resource_types = excluded.resource_types, active = true;

insert into public.resources (tenant_id, slug, name, resource_type, active)
select tenant.id, resource.slug, resource.name, resource.resource_type, true
from public.tenants tenant
join (values
  ('graphite-detailing','bay-one','Пост 1','any'),
  ('graphite-detailing','bay-two','Пост 2','any'),
  ('graphite-detailing','coating-bay','Пост покрытия','coating'),
  ('ceramica-garage','prep-bay','Пост подготовки','any'),
  ('ceramica-garage','film-bay','Пост плёнки','film'),
  ('ceramica-garage','coating-bay','Пост керамики','coating')
 ) as resource(tenant_slug, slug, name, resource_type)
on tenant.slug = resource.tenant_slug
on conflict (tenant_id, slug) do update set name = excluded.name, resource_type = excluded.resource_type, active = true;
