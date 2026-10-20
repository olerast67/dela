import { tr } from './i18n.ts';
import { platform, serverUrl } from './platform.ts';

/**
 * Ссылки на экран или задачу. В ссылке только адрес сервера и маршрут в hash:
 * без ключей аккаунта сервер по ней ничего не покажет.
 */

/** Схема приложения: dela://open#/task/<id> открывает маршрут в Android и Windows. */
export const APP_SCHEME = 'dela';

export function taskHash(id: string): string {
  return `#/task/${encodeURIComponent(id)}`;
}

/** Ссылка для пересылки: адрес сервера (или страницы клиента) и hash-маршрут. */
export function shareLink(base: string, hash: string): string {
  const u = new URL(base);
  u.hash = '';
  u.search = '';
  return `${u.href}${hash}`;
}

/** Ссылка в приложение на этом устройстве. */
export function appLink(hash: string): string {
  return `${APP_SCHEME}://open${hash}`;
}

/** Маршрут из ссылки dela://open#/… или https-ссылки Dela; null, если это не ссылка на экран. */
export function linkHash(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` && u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return /^#\/[^\s]*$/.test(u.hash) ? u.hash : null;
}

/**
 * Откуда открывать ссылку. В браузере это страница клиента; в приложении — сервер аккаунта.
 * Без сервера в приложении ссылка ведёт в приложение на этом устройстве (null).
 */
export function linkBase(local: boolean): string | null {
  if (platform() === 'web') return location.origin + location.pathname;
  if (local) return null;
  return serverUrl() || null;
}

/** Копирование текста; в WebView без clipboard API — через скрытое поле. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Скопировать ссылку на маршрут и сказать об этом тостом. */
export async function copyLink(hash: string, local: boolean, toast: (text: string) => void): Promise<void> {
  const base = linkBase(local);
  const link = base ? shareLink(base, hash) : appLink(hash);
  if (!(await copyText(link))) {
    toast(tr('Не удалось скопировать ссылку'));
    return;
  }
  if (!local) toast(tr('Ссылка скопирована'));
  else if (base) toast(tr('Ссылка скопирована. Без сервера она откроется только в этом браузере'));
  else toast(tr('Ссылка скопирована. Без сервера она откроется только на этом устройстве'));
}

/** Приложение открыто по ссылке dela://: перейти на маршрут. */
export function openLinkHash(hash: string): void {
  if (location.hash !== hash) location.hash = hash;
}
