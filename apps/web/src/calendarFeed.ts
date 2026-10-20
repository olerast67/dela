/**
 * Файл календаря по подписке: чтение ответа с пределом размера и кеш на устройстве под ключом устройства.
 * Отдельно от calendars.ts, чтобы проверять без React и IndexedDB.
 */
import { openLocal, sealLocal, type DeviceKeyStore } from './storage.ts';

/** Больше этого файл календаря не скачивается: тот же предел, что в программе для компьютера. */
export const MAX_CALENDAR_BYTES = 20 * 1024 * 1024;

export class FeedTooLargeError extends Error {
  constructor() {
    super('large');
  }
}

/** Заявленная длина ответа больше предела. Без заголовка — неизвестно, false. */
export function declaredTooLarge(length: string | null | undefined, max = MAX_CALENDAR_BYTES): boolean {
  const n = Number(length);
  return length != null && length !== '' && Number.isFinite(n) && n > max;
}

/** Прочитать тело ответа текстом, оборвав загрузку, как только оно перевалит за предел. */
export async function readCapped(r: Response, max = MAX_CALENDAR_BYTES): Promise<string> {
  if (declaredTooLarge(r.headers.get('content-length'), max)) {
    await r.body?.cancel().catch(() => undefined);
    throw new FeedTooLargeError();
  }
  if (!r.body) return '';
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new FeedTooLargeError();
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** Запись кеша: текст файла зашифрован ключом устройства, открыто только хеш ссылки и время. */
export interface SealedFeed {
  readonly hash: string;
  readonly fetchedAt: number;
  readonly sealed: { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };
}

export async function sealFeed(store: DeviceKeyStore, hash: string, text: string, fetchedAt: number): Promise<SealedFeed> {
  return { hash, fetchedAt, sealed: await sealLocal(store, text) };
}

/** Расшифровать запись кеша. Чужой ключ, повреждённая или старая открытая запись — null. */
export async function openFeed(store: DeviceKeyStore, rec: SealedFeed | undefined): Promise<{ hash: string; text: string; fetchedAt: number } | null> {
  if (!rec?.sealed) return null;
  try {
    const text = await openLocal<unknown>(store, rec.sealed);
    return typeof text === 'string' ? { hash: rec.hash, text, fetchedAt: rec.fetchedAt } : null;
  } catch {
    return null;
  }
}
