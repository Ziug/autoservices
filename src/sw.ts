import {clientsClaim} from 'workbox-core';
import {createHandlerBoundToURL, precacheAndRoute} from 'workbox-precaching';
import {NavigationRoute, registerRoute} from 'workbox-routing';

type WorkerMessageEvent = Event & {data: {json: () => unknown} | null; waitUntil: (promise: Promise<unknown>) => void};
type WorkerNotificationEvent = Event & {notification: {close: () => void; data?: unknown}; waitUntil: (promise: Promise<unknown>) => void};
type WorkerClient = {navigate: (url: string) => Promise<unknown>; focus: () => Promise<unknown>};
type ServiceWorkerContext = EventTarget & {
  __WB_MANIFEST: Array<{revision?: string | null; url: string}>;
  registration: {showNotification: (title: string, options: Record<string, unknown>) => Promise<unknown>};
  clients: {matchAll: (options: {type: 'window'; includeUncontrolled: boolean}) => Promise<WorkerClient[]>; openWindow: (url: string) => Promise<unknown>};
  location: Location;
  skipWaiting: () => Promise<void>;
};

declare const self: ServiceWorkerContext;
const worker = globalThis as unknown as ServiceWorkerContext;

precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  allowlist: [/^\/s\/[a-z0-9-]+\//],
  denylist: [/\/owner(?:\/|$)/],
}));

worker.addEventListener('push', ((event: WorkerMessageEvent) => {
  if (!event.data) return;
  const payload = event.data.json() as {title?: string; body?: string; url?: string; tag?: string};
  event.waitUntil(worker.registration.showNotification(payload.title ?? 'Напоминание о записи', {
    body: payload.body ?? 'Скоро ждём вас в студии.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: payload.tag ?? 'booking-reminder',
    data: {url: payload.url ?? '/'},
  }));
}) as EventListener);

worker.addEventListener('notificationclick', ((event: WorkerNotificationEvent) => {
  event.notification.close();
  const targetUrl = new URL(String((event.notification.data as {url?: string} | undefined)?.url ?? '/'), worker.location.origin).href;
  event.waitUntil((async () => {
    const windows = await worker.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const client of windows) {
      await client.navigate(targetUrl);
      await client.focus();
      return;
    }
    await worker.clients.openWindow(targetUrl);
  })());
}) as EventListener);

worker.addEventListener('install', () => { void worker.skipWaiting(); });
clientsClaim();
