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
// Путь относительно service worker: клиент может жить не в корне сайта (демо на GitHub Pages).
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/\/api\//] }));

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// Клик по уведомлению: открыть приложение на задаче, а утреннюю сводку — на «Сегодня».
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data as { taskId?: string; today?: boolean } | null;
  const taskId = data?.taskId;
  const base = self.registration.scope;
  const url = taskId ? `${base}#/today?task=${encodeURIComponent(taskId)}` : data?.today ? `${base}#/today` : base;
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if ('focus' in w) {
          await w.focus();
          w.postMessage(taskId || !data?.today ? { type: 'open-task', taskId } : { type: 'open-today' });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// ---------- push-напоминания ----------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('dela');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function deviceKey(): Promise<CryptoKey | undefined> {
  const db = await openDb();
  try {
    return await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const r = db.transaction('meta').objectStore('meta').get('deviceKey');
      r.onsuccess = () => resolve(r.result as CryptoKey | undefined);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

interface ReminderPayload {
  t: string;
  b: string;
  k: string;
  /** Нет у утренней сводки. */
  id?: string;
  /** Утренняя сводка: открыть «Сегодня». */
  today?: boolean;
}

async function decryptPayload(b64: string): Promise<ReminderPayload | null> {
  const key = await deviceKey();
  if (!key) return null;
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
  return JSON.parse(new TextDecoder().decode(plain)) as ReminderPayload;
}

self.addEventListener('push', (e) => {
  e.waitUntil(
    (async () => {
      let r: ReminderPayload | null = null;
      try {
        const { p } = (e.data?.json() ?? {}) as { p?: string };
        if (p) r = await decryptPayload(p);
      } catch {
        r = null;
      }
      // Открытые окна приложения показывают напоминание у себя (если ещё не показали).
      if (r) {
        for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) w.postMessage({ type: 'push-reminder', key: r.k, title: r.t, taskId: r.id });
      }
      // Браузер требует показать уведомление на каждый push; если расшифровать не вышло, показываем общее.
      try {
        const ru = /^ru/i.test(self.navigator.language);
        await self.registration.showNotification(r?.t ?? (ru ? 'Напоминание Dela' : 'Dela reminder'), {
          body: r?.b ?? (ru ? 'Откройте приложение' : 'Open the app'),
          icon: '/icon-192.png',
          ...(r ? { tag: r.k, data: r.id ? { taskId: r.id } : { today: r.today === true } } : {}),
        });
      } catch {
        // уведомления запрещены: окно приложения уже получило сообщение
      }
    })(),
  );
});
