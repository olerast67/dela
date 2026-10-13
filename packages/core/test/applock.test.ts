import { beforeAll, describe, expect, it } from 'vitest';
import { applyPinAttempt, failureDelayMs, hashPin, initCrypto, isValidPin, lockAfterBackground, MAX_PIN_FAILURES, verifyPin, type LockConfig } from '../src/index.ts';
import { INSECURE_TEST_KDF } from '../src/crypto.ts';

beforeAll(async () => {
  await initCrypto();
});

const base = (): LockConfig => ({ pinHash: hashPin('2468', INSECURE_TEST_KDF), timeoutMin: 5, biometric: false, failures: 0, blockedUntil: 0 });

describe('блокировка PIN-кодом', () => {
  it('хеш PIN проверяется и не содержит PIN', () => {
    const h = hashPin('2468', INSECURE_TEST_KDF);
    expect(h).not.toContain('2468');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(verifyPin(h, '2468')).toBe(true);
    expect(verifyPin(h, '2469')).toBe(false);
    expect(verifyPin('мусор', '2468')).toBe(false);
  });

  it('PIN из 4-8 цифр', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('12345678')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('123456789')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
  });

  it('паузы растут после пятой ошибки', () => {
    expect([1, 4, 5, 6, 7, 8, 9].map(failureDelayMs)).toEqual([0, 0, 30_000, 60_000, 300_000, 900_000, 900_000]);
  });

  it('верный PIN сбрасывает счётчик, неверные копятся, десятый стирает', () => {
    let config = base();
    let now = 1_000_000;
    for (let i = 1; i < MAX_PIN_FAILURES; i++) {
      const r = applyPinAttempt(config, now, () => verifyPin(config.pinHash, '0000'));
      expect(r.kind).toBe('wrong');
      if (r.kind !== 'wrong') return;
      expect(r.left).toBe(MAX_PIN_FAILURES - i);
      config = r.config;
      now = config.blockedUntil;
    }
    expect(applyPinAttempt(config, now, () => false).kind).toBe('wipe');
    const ok = applyPinAttempt(config, now, () => true);
    expect(ok).toMatchObject({ kind: 'ok', config: { failures: 0, blockedUntil: 0 } });
  });

  it('во время паузы PIN даже не проверяется', () => {
    const config = { ...base(), failures: 5, blockedUntil: 2_000 };
    let called = false;
    const r = applyPinAttempt(config, 1_000, () => {
      called = true;
      return true;
    });
    expect(r).toMatchObject({ kind: 'blocked', waitMs: 1_000 });
    expect(called).toBe(false);
  });

  it('блокировка после фона по таймауту', () => {
    const config = base();
    expect(lockAfterBackground(null, 0, 10 ** 9)).toBe(false);
    expect(lockAfterBackground(config, null, 10 ** 9)).toBe(false);
    expect(lockAfterBackground(config, 0, 4 * 60_000)).toBe(false);
    expect(lockAfterBackground(config, 0, 5 * 60_000)).toBe(true);
    expect(lockAfterBackground({ ...config, timeoutMin: 0 }, 0, 1)).toBe(true);
  });
});
