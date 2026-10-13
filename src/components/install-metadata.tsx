import {useEffect} from 'react';
import type {BusinessConfig} from '@/domain/tenant';

/** Generated placeholder logo used when a studio has no uploaded (same-origin) logo. */
export const TENANT_PLACEHOLDER_LOGO = '/placeholders/detailing-logo.svg';
const ICON_BACKGROUND = '#111112';

function setLink(rel: string, href: string, type?: string) {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement('link');
    link.rel = rel;
    document.head.append(link);
  }
  link.href = href;
  if (type) link.type = type;
  else link.removeAttribute('type');
}

function removeLink(rel: string) {
  document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)?.remove();
}

function setMeta(name: string, content: string) {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

/**
 * Same-origin logo path for install icons, or the generated placeholder.
 * External hotlinks are deliberately NOT used: iOS ignores remote/SVG
 * apple-touch-icons, which is exactly how studios ended up with the
 * first-letter fallback.
 */
export function resolveTenantLogo(business: BusinessConfig): string {
  const logo = business.logoImage.trim();
  if (!logo) return TENANT_PLACEHOLDER_LOGO;
  try {
    const url = new URL(logo, window.location.origin);
    if (url.origin === window.location.origin) return `${url.pathname}${url.search}`;
  } catch {
    // Malformed URL — fall through to the placeholder.
  }
  return TENANT_PLACEHOLDER_LOGO;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`icon-load-failed: ${src}`));
    img.src = src;
  });
}

/** Rasterize the (same-origin, incl. SVG) logo into a PNG data URL for apple-touch-icon/PWA icons. */
async function renderPngIcon(src: string, size: number): Promise<string> {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('icon-no-2d-context');
  ctx.fillStyle = ICON_BACKGROUND;
  ctx.fillRect(0, 0, size, size);
  const pad = Math.round(size * 0.12);
  const box = size - pad * 2;
  const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  ctx.drawImage(img, Math.round((size - width) / 2), Math.round((size - height) / 2), width, height);
  return canvas.toDataURL('image/png');
}

/** Last-resort tile with the studio initial (per-tenant data, never a shared brand). */
function renderLetterTile(name: string, accentColor: string, size: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('icon-no-2d-context');
  ctx.fillStyle = ICON_BACKGROUND;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = accentColor;
  ctx.font = `700 ${Math.round(size * 0.52)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const initial = (name.trim().charAt(0) || '•').toLocaleUpperCase('ru-RU');
  ctx.fillText(initial, size / 2, size * 0.54);
  return canvas.toDataURL('image/png');
}

/**
 * Per-tenant install metadata.
 *
 * Root cause of the iPhone first-letter bug: DB-only studios have no
 * `public/tenants/<slug>/` build dir (build-assets only emits file-based
 * tenants), so the manifest, apple-touch-icon and startup-image URLs this
 * component used to link all 404'd. iOS then falls back to a generated
 * first-letter tile. Not a manifest-format, routing or cache problem — the
 * files simply don't exist for DB studios, and an empty/external logo_url
 * gave iOS nothing usable either.
 *
 * Fix: theme-color + title always come from the tenant; the favicon uses the
 * same-origin logo (or placeholder); the apple-touch-icon is rasterized to a
 * real PNG from that logo; and when the server manifest is missing we inject
 * a synthesized per-tenant manifest (correct id/start_url/scope/icons)
 * instead of linking a 404.
 */
export function InstallMetadata({business}: {business: BusinessConfig}) {
  useEffect(() => {
    let cancelled = false;
    const ownedUrls: string[] = [];

    document.title = `${business.name} — онлайн-запись`;
    setMeta('description', business.description);
    setMeta('theme-color', business.accentColor);
    setMeta('apple-mobile-web-app-title', business.name.slice(0, 18));
    setMeta('application-name', business.name.slice(0, 18));

    const logo = resolveTenantLogo(business);
    setLink('icon', logo, logo.endsWith('.svg') ? 'image/svg+xml' : undefined);

    const applyTouchIcon = async () => {
      try {
        const png = await renderPngIcon(logo, 180);
        if (!cancelled) setLink('apple-touch-icon', png);
      } catch {
        if (cancelled) return;
        try {
          setLink('apple-touch-icon', renderLetterTile(business.name, business.accentColor, 180));
        } catch {
          // Leave the platform default rather than a broken link.
        }
      }
    };

    const applyManifest = async () => {
      const serverManifest = `/tenants/${business.slug}/manifest.webmanifest`;
      let serverOk = false;
      try {
        serverOk = (await fetch(serverManifest, {method: 'HEAD'})).ok;
      } catch {
        serverOk = false;
      }
      if (cancelled) return;
      if (serverOk) {
        setLink('manifest', serverManifest, 'application/manifest+json');
        setLink('apple-touch-startup-image', `/tenants/${business.slug}/startup-image.png`, 'image/png');
        return;
      }
      let icon192 = logo;
      let icon512 = logo;
      try {
        [icon192, icon512] = await Promise.all([renderPngIcon(logo, 192), renderPngIcon(logo, 512)]);
      } catch {
        // Keep the logo URLs; a same-origin icon still beats a 404 manifest.
      }
      if (cancelled) return;
      const manifest = {
        id: `/s/${business.slug}/`,
        name: business.name,
        short_name: business.name.slice(0, 18),
        description: business.tagline,
        start_url: `/s/${business.slug}/`,
        scope: `/s/${business.slug}/`,
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: ICON_BACKGROUND,
        theme_color: business.accentColor,
        icons: [
          {src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any'},
          {src: icon512, sizes: '512x512', type: 'image/png', purpose: 'maskable'},
        ],
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(manifest)], {type: 'application/manifest+json'}));
      ownedUrls.push(url);
      setLink('manifest', url);
      removeLink('apple-touch-startup-image');
    };

    void applyTouchIcon();
    void applyManifest();
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register(`/sw.js?tenant=${encodeURIComponent(business.slug)}`, {scope: `/s/${business.slug}/`}).catch(() => undefined);
    }
    return () => {
      cancelled = true;
      for (const url of ownedUrls) URL.revokeObjectURL(url);
    };
  }, [business.accentColor, business.description, business.logoImage, business.name, business.slug, business.tagline]);
  return null;
}
