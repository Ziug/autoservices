import {promises as fs} from 'node:fs';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {z} from 'zod';
import {mergeOwnerGallery} from './tenant-publishing.mjs';

const root = process.cwd();
const tenantsRoot = path.join(root, 'tenants');
const publicRoot = path.join(root, 'public', 'tenants');
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const configSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(slugPattern),
  name: z.string().min(2),
  tagline: z.string().min(2),
  description: z.string().min(2),
  city: z.string().min(2),
  address: z.string().min(3),
  phone: z.string().min(5),
  mapUrl: z.string().url(),
  timezone: z.string().min(3).refine((value) => {
    try { new Intl.DateTimeFormat('en', {timeZone: value}); return true; } catch { return false; }
  }, 'timezone must be an IANA time zone'),
  currency: z.string().length(3),
  locale: z.string().min(2),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  heroImage: z.string().min(1),
  logoImage: z.string().min(1),
  demo: z.boolean(),
  status: z.enum(['draft', 'preview', 'live']),
  bookingStepMinutes: z.number().int().min(5).max(120),
  cancellationWindowHours: z.number().int().nonnegative(),
  openingHours: z.array(z.object({weekday: z.number().int().min(0).max(6), opensAt: z.string().regex(/^\d{2}:\d{2}$/), closesAt: z.string().regex(/^\d{2}:\d{2}$/)})),
  services: z.array(z.object({slug: z.string().regex(slugPattern), name: z.string().min(2), description: z.string(), priceMinor: z.number().int().nonnegative(), durationMinutes: z.number().int().positive(), bufferBeforeMinutes: z.number().int().nonnegative(), bufferAfterMinutes: z.number().int().nonnegative(), category: z.string(), resourceTypes: z.array(z.string()).default(['any'])})).min(1),
  resources: z.array(z.object({slug: z.string().regex(slugPattern), name: z.string().min(2), resourceType: z.string().min(1)})).min(1),
  gallery: z.array(z.object({id: z.string().regex(slugPattern), image: z.string().min(1), caption: z.string().min(1), position: z.number().int().nonnegative()})),
  infoCards: z.array(z.object({id: z.string().regex(slugPattern), title: z.string().min(1), body: z.string().min(1)})).length(3),
  assistantPrompts: z.array(z.string().min(1)).min(1),
});

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function loadTenant(slug) {
  if (!slug || !slugPattern.test(slug)) throw new Error('Use a lowercase slug such as new-studio.');
  const file = path.join(tenantsRoot, slug, 'business.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  const config = configSchema.parse(parsed);
  if (config.slug !== slug) throw new Error(`Folder slug ${slug} does not match business.json slug ${config.slug}.`);
  return {config, directory: path.dirname(file)};
}

async function allTenants() {
  const entries = await fs.readdir(tenantsRoot, {withFileTypes: true});
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    result.push(await loadTenant(entry.name));
  }
  return result;
}

function loadLocalEnvironment() {
  try { process.loadEnvFile(path.join(root, '.env.local')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const result = Buffer.alloc(4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return result;
}

function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, payload, crc32(payload)]);
}

function makeIcon(size, color, background) {
  const pixels = Buffer.alloc(size * size * 4);
  const parse = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const bg = parse(background);
  const fg = parse(color);
  const setPixel = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (Math.floor(y) * size + Math.floor(x)) * 4;
    pixels[offset] = rgba[0]; pixels[offset + 1] = rgba[1]; pixels[offset + 2] = rgba[2]; pixels[offset + 3] = 255;
  };
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) setPixel(x, y, bg);
  const scale = size / 64;
  const line = (x0, y0, x1, y1, width, rgba) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let step = 0; step <= steps; step += 1) {
      const x = (x0 + (x1 - x0) * step / steps) * scale;
      const y = (y0 + (y1 - y0) * step / steps) * scale;
      for (let dy = -width * scale / 2; dy <= width * scale / 2; dy += 1) for (let dx = -width * scale / 2; dx <= width * scale / 2; dx += 1) setPixel(x + dx, y + dy, rgba);
    }
  };
  line(12, 37, 52, 37, 4, fg); line(16, 37, 20, 25, 4, fg); line(20, 25, 42, 25, 4, fg); line(42, 25, 48, 37, 4, fg);
  line(18, 43, 46, 43, 4, fg); line(18, 37, 18, 43, 4, fg); line(46, 37, 46, 43, 4, fg);
  for (const wheelX of [22, 42]) {
    for (let y = -4; y <= 4; y += 0.5) for (let x = -4; x <= 4; x += 0.5) if (x * x + y * y <= 16) setPixel((wheelX + x) * scale, (40 + y) * scale, bg);
    for (let y = -2; y <= 2; y += 0.5) for (let x = -2; x <= 2; x += 0.5) if (x * x + y * y <= 4) setPixel((wheelX + x) * scale, (40 + y) * scale, fg);
  }
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function makeStartupImage(width, height, color, background) {
  const pixels = Buffer.alloc(width * height * 4);
  const parse = (hex) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const bg = parse(background);
  const fg = parse(color);
  const scale = Math.min(width / 1170, height / 2532);
  const setPixel = (x, y, rgb) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 4;
    pixels[offset] = rgb[0]; pixels[offset + 1] = rgb[1]; pixels[offset + 2] = rgb[2]; pixels[offset + 3] = 255;
  };
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = bg[0]; pixels[offset + 1] = bg[1]; pixels[offset + 2] = bg[2]; pixels[offset + 3] = 255;
  }
  const line = (x0, y0, x1, y1, thickness, rgb) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let step = 0; step <= steps; step += 1) {
      const x = (x0 + (x1 - x0) * step / steps) * scale + (width - 1170 * scale) / 2;
      const y = (y0 + (y1 - y0) * step / steps) * scale + (height - 2532 * scale) / 2;
      const radius = thickness * scale / 2;
      for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) setPixel(x + dx, y + dy, rgb);
    }
  };
  line(280, 1380, 890, 1380, 34, fg);
  line(330, 1380, 395, 1200, 34, fg);
  line(395, 1200, 780, 1200, 34, fg);
  line(780, 1200, 850, 1380, 34, fg);
  line(330, 1380, 330, 1470, 34, fg);
  line(850, 1380, 850, 1470, 34, fg);
  line(330, 1470, 850, 1470, 34, fg);
  for (const wheelX of [425, 755]) {
    const centerX = wheelX * scale + (width - 1170 * scale) / 2;
    const centerY = 1470 * scale + (height - 2532 * scale) / 2;
    for (let y = -42; y <= 42; y += 1) for (let x = -42; x <= 42; x += 1) if (x * x + y * y <= 42 * 42) setPixel(centerX + x, centerY + y, bg);
    for (let y = -20; y <= 20; y += 1) for (let x = -20; x <= 20; x += 1) if (x * x + y * y <= 20 * 20) setPixel(centerX + x, centerY + y, fg);
  }
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function buildAssets() {
  const entries = await allTenants();
  const slugs = entries.map(({config}) => config.slug);
  if (new Set(slugs).size !== slugs.length) throw new Error('Tenant slugs must be unique.');
  // Production (Vercel) builds never bundle demo tenants unless explicitly allowed.
  // Local dev, staging previews, and tests keep them via INCLUDE_DEMO_TENANTS=1 or any non-Vercel env.
  const includeDemo = process.env.INCLUDE_DEMO_TENANTS === '1' || process.env.VERCEL !== '1';
  const buildable = includeDemo ? entries : entries.filter(({config}) => !config.demo);
  await fs.rm(publicRoot, {recursive: true, force: true});
  await fs.mkdir(publicRoot, {recursive: true});
  for (const {config, directory} of buildable) {
    const target = path.join(publicRoot, config.slug);
    await fs.mkdir(target, {recursive: true});
    await fs.copyFile(path.join(directory, 'business.json'), path.join(target, 'business.json'));
    const images = path.join(directory, 'images');
    try { await fs.cp(images, path.join(target, 'images'), {recursive: true}); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const icons = path.join(target, 'icons');
    await fs.mkdir(icons, {recursive: true});
    const background = '#111112';
    const icon192 = makeIcon(192, config.accentColor, background);
    const icon512 = makeIcon(512, config.accentColor, background);
    await fs.writeFile(path.join(icons, 'icon-192.png'), icon192);
    await fs.writeFile(path.join(icons, 'icon-512.png'), icon512);
    await fs.writeFile(path.join(icons, 'maskable-512.png'), icon512);
    await fs.writeFile(path.join(icons, 'apple-touch-icon.png'), makeIcon(180, config.accentColor, background));
    const manifest = {
      id: `/s/${config.slug}/`,
      name: config.name,
      short_name: config.name.slice(0, 18),
      description: config.tagline,
      start_url: `/s/${config.slug}/`,
      scope: `/s/${config.slug}/`,
      display: 'standalone',
      orientation: 'portrait-primary',
      background_color: background,
      theme_color: config.accentColor,
      icons: [
        {src: `/tenants/${config.slug}/icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any'},
        {src: `/tenants/${config.slug}/icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any'},
        {src: `/tenants/${config.slug}/icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable'},
      ],
    };
    await fs.writeFile(path.join(target, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(target, 'startup-image.png'), makeStartupImage(1170, 2532, config.accentColor, background));
  }
  console.log(`Prepared tenant manifests and icons for ${buildable.length} business profiles${buildable.length === entries.length ? '' : ` (${entries.length - buildable.length} demo skipped)`}.`);
}

async function createTenant(slug) {
  if (!slugPattern.test(slug ?? '')) throw new Error('Pass a lowercase slug: pnpm tenant:new north-studio');
  const target = path.join(tenantsRoot, slug);
  await fs.mkdir(path.join(target, 'images'), {recursive: true});
  const config = {
    schemaVersion: 1, slug, name: 'Новая студия', tagline: 'Автомобильный уход по записи', description: 'Кратко расскажите о студии и услугах.',
    city: 'Город', address: 'Укажите адрес студии', phone: '+7 000 000-00-00', mapUrl: 'https://maps.google.com/', timezone: 'Europe/Moscow', currency: 'RUB', locale: 'ru-RU',
    accentColor: '#4690FF', heroImage: `/tenants/${slug}/images/hero.jpg`, logoImage: `/tenants/${slug}/images/mark.svg`, demo: true, status: 'preview',
    bookingStepMinutes: 30, cancellationWindowHours: 12, openingHours: [{weekday: 1, opensAt: '09:00', closesAt: '19:00'}, {weekday: 2, opensAt: '09:00', closesAt: '19:00'}, {weekday: 3, opensAt: '09:00', closesAt: '19:00'}, {weekday: 4, opensAt: '09:00', closesAt: '19:00'}, {weekday: 5, opensAt: '09:00', closesAt: '19:00'}],
    services: [{slug: 'service', name: 'Новая услуга', description: 'Описание услуги', priceMinor: 0, durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, category: 'Услуга', resourceTypes: ['any']}],
    resources: [{slug: 'post-one', name: 'Пост 1', resourceType: 'any'}], gallery: [],
    infoCards: [{id: 'card-one', title: 'Карточка 1', body: 'Описание'}, {id: 'card-two', title: 'Карточка 2', body: 'Описание'}, {id: 'card-three', title: 'Карточка 3', body: 'Описание'}], assistantPrompts: ['Какие есть услуги?', 'Сколько стоит работа?', 'Как найти студию?'],
  };
  await fs.writeFile(path.join(target, 'business.json'), `${JSON.stringify(config, null, 2)}\n`, {flag: 'wx'});
  await fs.writeFile(path.join(target, 'images', 'README.md'), 'Place this tenant’s logo and original photography in this folder.\n');
  console.log(`Created ${path.relative(root, target)}. Replace the sample contact, hours, service, resources, copy, and images before publishing.`);
}

async function publishTenant(slug) {
  const {config} = await loadTenant(slug);
  loadLocalEnvironment();
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. No tenant was published.');
  if (config.demo && config.status === 'live') throw new Error('Demo profiles cannot be published as live.');
  const headers = {apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation'};
  const rest = (table, search = '') => `${url.replace(/\/$/, '')}/rest/v1/${table}${search}`;
  const existingResponse = await fetch(rest('tenants', `?select=id,status,gallery&slug=eq.${encodeURIComponent(config.slug)}`), {headers});
  if (!existingResponse.ok) throw new Error(`Could not read the existing tenant before publishing (${existingResponse.status}): ${await existingResponse.text()}`);
  const existingTenant = (await existingResponse.json())[0];
  if (existingTenant?.status === 'paused') throw new Error('This tenant is paused. Reactivate it through an owner-managed operation before publishing updates.');
  if (existingTenant?.status === 'live' && (config.demo || config.status !== 'live')) {
    throw new Error('This tenant is already live. Keep demo=false and status=live while updating it, or deactivate it through an owner-managed operation first.');
  }
  const keepLive = existingTenant?.status === 'live';
  const gallery = mergeOwnerGallery(config.gallery, existingTenant?.gallery);
  const tenantBody = {
    slug: config.slug, name: config.name, tagline: config.tagline, description: config.description, city: config.city,
    address: config.address, phone: config.phone, map_url: config.mapUrl, timezone: config.timezone, currency: config.currency,
    locale: config.locale, accent_color: config.accentColor, hero_image_url: config.heroImage, logo_url: config.logoImage,
    is_demo: config.demo, status: keepLive ? 'live' : 'draft', booking_step_minutes: config.bookingStepMinutes,
    cancellation_window_hours: config.cancellationWindowHours,
    opening_hours: config.openingHours, gallery, info_cards: config.infoCards, assistant_prompts: config.assistantPrompts,
  };
  const tenantResponse = await fetch(rest('tenants', '?on_conflict=slug'), {method: 'POST', headers, body: JSON.stringify(tenantBody)});
  if (!tenantResponse.ok) throw new Error(`Tenant publish failed (${tenantResponse.status}): ${await tenantResponse.text()}`);
  const tenantRows = await tenantResponse.json();
  const tenant = tenantRows[0];
  if (!tenant?.id) throw new Error('The tenant upsert succeeded without returning an id.');
  const syncRows = async (table, rows, filter) => {
    if (rows.length) {
      const response = await fetch(rest(table, '?on_conflict=tenant_id,slug'), {
        method: 'POST', headers: {...headers, Prefer: 'resolution=merge-duplicates,return=minimal'}, body: JSON.stringify(rows),
      });
      if (!response.ok) throw new Error(`${table} publish failed (${response.status}): ${await response.text()}`);
    }
    const keepSlugs = rows.map((row) => row.slug);
    const staleFilter = keepSlugs.length ? `${filter}&slug=not.in.(${keepSlugs.map(encodeURIComponent).join(',')})` : filter;
    const response = await fetch(rest(table, `?${staleFilter}`), {
      method: 'PATCH', headers: {...headers, Prefer: 'return=minimal'}, body: JSON.stringify({active: false}),
    });
    if (!response.ok) throw new Error(`${table} cleanup failed (${response.status}): ${await response.text()}`);
  };
  await syncRows('services', config.services.map((service) => ({tenant_id: tenant.id, slug: service.slug, name: service.name, description: service.description, price_minor: service.priceMinor, duration_minutes: service.durationMinutes, buffer_before_minutes: service.bufferBeforeMinutes, buffer_after_minutes: service.bufferAfterMinutes, category: service.category, resource_types: service.resourceTypes, active: true})), `tenant_id=eq.${tenant.id}`);
  await syncRows('resources', config.resources.map((resource) => ({tenant_id: tenant.id, slug: resource.slug, name: resource.name, resource_type: resource.resourceType, active: true})), `tenant_id=eq.${tenant.id}`);
  const publishStatus = keepLive ? 'live' : 'preview';
  const publishResponse = await fetch(rest('tenants', `?id=eq.${tenant.id}`), {method: 'PATCH', headers: {...headers, Prefer: 'return=minimal'}, body: JSON.stringify({status: publishStatus})});
  if (!publishResponse.ok) throw new Error(`Tenant status update failed (${publishResponse.status}): ${await publishResponse.text()}`);
  console.log(`Published ${config.slug} as ${publishStatus}. New profiles remain in preview until tenant:verify and tenant:activate succeed.`);
}

async function verifyTenant(slug) {
  const {config} = await loadTenant(slug);
  loadLocalEnvironment();
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before verifying the live tenant.');
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/tenants?select=slug,status,name&slug=eq.${encodeURIComponent(slug)}`, {headers: {apikey: key, Authorization: `Bearer ${key}`}});
  if (!response.ok) throw new Error(`Public tenant check failed (${response.status}): ${await response.text()}`);
  const rows = await response.json();
  if (!rows[0] || rows[0].status === 'draft') throw new Error('Tenant is missing or still in draft; it must not be shared.');
  console.log(`Verified ${rows[0].slug} (${rows[0].status}) in Supabase.`);
  if (config.demo) console.log('This tenant is marked demo; real notifications remain disabled.');
  const publicBase = process.env.PUBLIC_BASE_URL;
  if (publicBase) {
    const publicUrl = new URL(`/s/${encodeURIComponent(slug)}/`, publicBase);
    const page = await fetch(publicUrl);
    if (!page.ok) throw new Error(`Public studio URL check failed (${page.status}).`);
    if (!(await page.text()).includes('id="root"')) throw new Error('The public studio URL did not return the app shell.');
    console.log(`Verified public studio URL: ${publicUrl}`);
  } else {
    console.log('Set PUBLIC_BASE_URL to also verify the deployed studio link.');
  }
}

async function activateTenant(slug) {
  const {config} = await loadTenant(slug);
  if (config.demo || config.status !== 'live') throw new Error('Set demo=false and status="live" in business.json before activation.');
  if (config.name === 'Новая студия' || config.city === 'Город' || config.address === 'Укажите адрес студии' || config.phone === '+7 000 000-00-00') {
    throw new Error('Replace the new-studio placeholder contact details before activation.');
  }
  loadLocalEnvironment();
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  if (!process.env.PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is required before a tenant can be activated.');
  await verifyTenant(slug);
  const headers = {apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal'};
  const rest = (table, search = '') => `${url.replace(/\/$/, '')}/rest/v1/${table}${search}`;
  const tenantResponse = await fetch(rest('tenants', `?select=id,status,is_demo,name,address,phone&slug=eq.${encodeURIComponent(slug)}`), {headers});
  if (!tenantResponse.ok) throw new Error(`Could not verify the tenant before activation (${tenantResponse.status}): ${await tenantResponse.text()}`);
  const tenant = (await tenantResponse.json())[0];
  if (!tenant) throw new Error('Publish this tenant before activating it.');
  if (tenant.status === 'live') { console.log(`${slug} is already live.`); return; }
  if (tenant.status !== 'preview' || tenant.is_demo) throw new Error('Only a verified non-demo preview tenant can be activated.');
  if (tenant.name !== config.name || tenant.address !== config.address || tenant.phone !== config.phone) {
    throw new Error('The published contact details differ from business.json. Run tenant:publish and verify again.');
  }
  for (const [table, expected] of [['services', config.services.map((item) => item.slug)], ['resources', config.resources.map((item) => item.slug)]]) {
    const rowsResponse = await fetch(rest(table, `?select=slug,active&tenant_id=eq.${tenant.id}&active=eq.true`), {headers});
    if (!rowsResponse.ok) throw new Error(`Could not verify ${table} before activation (${rowsResponse.status}): ${await rowsResponse.text()}`);
    const actual = new Set((await rowsResponse.json()).map((row) => row.slug));
    if (expected.some((item) => !actual.has(item))) throw new Error(`The published ${table} list is incomplete. Run tenant:publish and verify again.`);
  }
  const response = await fetch(rest('tenants', `?id=eq.${tenant.id}`), {method: 'PATCH', headers, body: JSON.stringify({status: 'live'})});
  if (!response.ok) throw new Error(`Tenant activation failed (${response.status}): ${await response.text()}`);
  console.log(`Activated ${slug} as live after the public link and Supabase records were verified.`);
}

const [action, slug] = process.argv.slice(2);
try {
  if (action === 'new') await createTenant(slug);
  else if (action === 'validate') {
    const entries = slug ? [await loadTenant(slug)] : await allTenants();
    const unique = new Set();
    for (const {config} of entries) {
      if (unique.has(config.slug)) throw new Error(`Duplicate tenant slug: ${config.slug}`);
      unique.add(config.slug);
      const galleryIds = config.gallery.map((photo) => photo.id);
      if (new Set(galleryIds).size !== galleryIds.length) throw new Error(`${config.slug}: gallery ids must be unique.`);
      if (new Set(config.services.map((service) => service.slug)).size !== config.services.length) throw new Error(`${config.slug}: service slugs must be unique.`);
      if (new Set(config.resources.map((resource) => resource.slug)).size !== config.resources.length) throw new Error(`${config.slug}: resource slugs must be unique.`);
      if (new Set(config.openingHours.map((hours) => hours.weekday)).size !== config.openingHours.length) throw new Error(`${config.slug}: each weekday can have only one opening-hours row.`);
      if (config.openingHours.some((hours) => hours.opensAt >= hours.closesAt)) throw new Error(`${config.slug}: opening time must be earlier than closing time.`);
      for (const service of config.services) if (!config.resources.some((resource) => service.resourceTypes.includes('any') || resource.resourceType === 'any' || service.resourceTypes.includes(resource.resourceType))) throw new Error(`${config.slug}: ${service.name} has no compatible resource.`);
      console.log(`✓ ${config.slug}: ${config.services.length} services, ${config.resources.length} posts, ${config.openingHours.length} open days`);
    }
    console.log(`Validated ${entries.length} tenant configuration(s).`);
  }
  else if (action === 'publish') await publishTenant(slug);
  else if (action === 'verify') await verifyTenant(slug);
  else if (action === 'activate') await activateTenant(slug);
  else if (action === 'build-assets') await buildAssets();
  else throw new Error('Use one of: new <slug>, validate [slug], publish <slug>, verify <slug>, activate <slug>, build-assets.');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
