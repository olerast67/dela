/// <reference lib="webworker" />
/**
 * Service worker Dela: офлайн-оболочка приложения, уведомления и (позже) Web Push.
 * Запросы к API не кэшируются: данные живут в IndexedDB.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// Клик по уведомлению: открыть приложение на задаче.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const taskId = (e.notification.data as { taskId?: string } | null)?.taskId;
  const url = taskId ? `/#/today?task=${encodeURIComponent(taskId)}` : '/';
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if ('focus' in w) {
          await w.focus();
          w.postMessage({ type: 'open-task', taskId });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
