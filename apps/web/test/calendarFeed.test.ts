import { describe, expect, it } from 'vitest';
import { FeedTooLargeError, declaredTooLarge, openFeed, readCapped, sealFeed } from '../src/calendarFeed.ts';
import type { DeviceKeyStore } from '../src/storage.ts';

/** Хранилище ключа устройства в памяти вместо IndexedDB. */
function memoryStore(): DeviceKeyStore {
  const meta = new Map<string, unknown>();
  return {
    getMeta: async <T>(key: string) => meta.get(key) as T | undefined,
    setMeta: async (key: string, value: unknown) => void meta.set(key, value),
  };
}

/** Ответ, тело которого приходит кусками; считает, сколько кусков у него забрали. */
function chunked(chunks: number, size: number, headers: Record<string, string> = {}): { r: Response; pulled: () => number } {
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (n >= chunks) return c.close();
      n++;
      c.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return { r: new Response(body, { headers }), pulled: () => n };
}

describe('кеш файла календаря', () => {
  it('текст зашифрован и без ключа устройства не читается', async () => {
    const store = memoryStore();
    const text = 'BEGIN:VCALENDAR\r\nSUMMARY:Визит к врачу\r\nEND:VCALENDAR';
    const rec = await sealFeed(store, 'h', text, 42);
    expect(JSON.stringify(rec)).not.toContain('врачу');
    expect(new TextDecoder().decode(rec.sealed.data)).not.toContain('VCALENDAR');
    expect(await openFeed(store, rec)).toEqual({ hash: 'h', text, fetchedAt: 42 });
    // Другое устройство или стёртый при выходе ключ.
    expect(await openFeed(memoryStore(), rec)).toBeNull();
    // Открытая запись старого формата не принимается.
    expect(await openFeed(store, { hash: 'h', text, fetchedAt: 1 } as never)).toBeNull();
  });
});

describe('чтение ответа с пределом', () => {
  it('читает ответ меньше предела', async () => {
    expect(await readCapped(new Response('привет'), 100)).toBe('привет');
  });

  it('обрывает поток, как только сумма перевалила за предел', async () => {
    const { r, pulled } = chunked(1000, 1024);
    await expect(readCapped(r, 10 * 1024)).rejects.toBeInstanceOf(FeedTooLargeError);
    expect(pulled()).toBeLessThan(20);
  });

  it('не читает вовсе, если заявленная длина больше предела', async () => {
    const { r, pulled } = chunked(1000, 1024, { 'content-length': String(1000 * 1024) });
    await expect(readCapped(r, 10 * 1024)).rejects.toBeInstanceOf(FeedTooLargeError);
    expect(pulled()).toBeLessThanOrEqual(1);
    expect(declaredTooLarge(null, 10)).toBe(false);
    expect(declaredTooLarge('11', 10)).toBe(true);
    expect(declaredTooLarge('10', 10)).toBe(false);
  });
});
