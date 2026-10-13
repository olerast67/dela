import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, verifyTotp } from '../src/totp.ts';

describe('TOTP', () => {
  it('примеры из RFC 6238 (SHA1, 8 цифр)', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(hotp(secret, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    expect(hotp(secret, Math.floor(20000000000 / 30), 8)).toBe('65353130');
  });

  it('base32 туда и обратно', () => {
    const data = Buffer.from('12345678901234567890');
    expect(base32Encode(data)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(data);
  });

  it('проверка кода: допуск в один шаг, повтор запрещён', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const t = 1_760_000_000_000;
    const code = hotp(base32Decode(secret), Math.floor(t / 30_000));
    const step = verifyTotp(secret, code, t, null);
    expect(step).toBe(Math.floor(t / 30_000));
    expect(verifyTotp(secret, code, t + 30_000, null)).not.toBeNull();
    expect(verifyTotp(secret, code, t + 90_000, null)).toBeNull();
    expect(verifyTotp(secret, code, t, step)).toBeNull();
    expect(verifyTotp(secret, '12345', t, null)).toBeNull();
    expect(otpauthUri(secret, 'a@b.cd')).toMatch(/^otpauth:\/\/totp\/Dela%3Aa%40b\.cd\?secret=GEZD/);
  });
});
