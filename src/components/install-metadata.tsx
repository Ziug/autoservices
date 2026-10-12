import {useEffect} from 'react';
import type {BusinessConfig} from '@/domain/tenant';

function setLink(rel: string, href: string, type?: string) {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement('link');
    link.rel = rel;
    document.head.append(link);
  }
  link.href = href;
  if (type) link.type = type;
}

export function InstallMetadata({business}: {business: BusinessConfig}) {
  useEffect(() => {
    const name = `${business.name} — онлайн-запись`;
    document.title = name;
    const description = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = business.description;
    const themeColor = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) themeColor.content = business.accentColor;
    setLink('manifest', `/tenants/${business.slug}/manifest.webmanifest`, 'application/manifest+json');
    setLink('apple-touch-icon', `/tenants/${business.slug}/icons/apple-touch-icon.png`);
    setLink('apple-touch-startup-image', `/tenants/${business.slug}/startup-image.png`, 'image/png');
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register(`/sw.js?tenant=${encodeURIComponent(business.slug)}`, {scope: `/s/${business.slug}/`}).catch(() => undefined);
    }
  }, [business.accentColor, business.description, business.name, business.slug]);
  return null;
}
