import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Клиент присылает секрет входа, полученный из пароля через Argon2id на устройстве.
 * Сервер хранит его хеш scrypt с отдельной солью: утечка базы не даёт войти,
 * а пароль и ключи шифрования сервер не видит никогда.
 */
export function hashAuthSecret(secret: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Соль для несуществующего адреса: детерминированная, чтобы по ответу prelogin
 * нельзя было узнать, зарегистрирован ли адрес.
 */
export function fakeSalt(serverSecret: Uint8Array, email: string): Buffer {
  return createHmac('sha256', serverSecret).update(`prelogin\n${email}`).digest().subarray(0, 16);
}

/** Ограничение частоты: не больше limit событий за windowMs на ключ. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Записать событие. false, если лимит превышен. */
  hit(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(t);
    return true;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) {
      if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    }
  }
}
