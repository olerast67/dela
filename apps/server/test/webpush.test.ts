import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, generateVapid, isAllowedEndpoint, loadVapid, vapidAuthorization } from '../src/webpush.ts';

/** Расшифровка на стороне браузера по RFC 8291 — независимая от шифрования реализация. */
function decrypt(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const shared = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1);
}

describe('Web Push', () => {
  it('пример из RFC 8291, раздел 5', () => {
    const b = (s: string) => Buffer.from(s, 'base64url');
    const sub = {
      endpoint: 'https://push.example.net/x',
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    };
    const body = encryptPayload(sub, Buffer.from('When I grow up, I want to be a watermelon'), {
      salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
      asPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
    });
    expect(body.subarray(21, 86).toString('base64url')).toBe(
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    );
    expect(decrypt(body, b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), b(sub.auth)).toString()).toBe('When I grow up, I want to be a watermelon');
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('случайные ключи: браузер расшифровывает то, что зашифровал сервер', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.from('0123456789abcdef');
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
    const payload = Buffer.from(JSON.stringify({ p: 'шифротекст' }));
    expect(decrypt(encryptPayload(sub, payload), ua.getPrivateKey(), auth)).toEqual(payload);
  });

  it('подпись VAPID проверяется открытым ключом', () => {
    const vapid = loadVapid(generateVapid().privatePem);
    expect(Buffer.from(vapid.publicKey, 'base64url')).toHaveLength(65);
    const header = vapidAuthorization(vapid, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:admin@example.com', 1_760_000_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(JSON.parse(Buffer.from(m[2]!, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_760_000_000 + 12 * 3600,
      sub: 'mailto:admin@example.com',
    });
    const point = Buffer.from(m[4]!, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url'))).toBe(true);
  });

  it('только адреса известных push-сервисов', () => {
    expect(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    // UnifiedPush: ntfy.sh из коробки, свой распространитель только по DELA_PUSH_HOSTS.
    expect(isAllowedEndpoint('https://ntfy.sh/upAbC123?up=1')).toBe(true);
    // Только сервис push Google, а не любой его API.
    expect(isAllowedEndpoint('https://storage.googleapis.com/bucket/x')).toBe(false);
    expect(isAllowedEndpoint('https://evil.ntfy.sh.example/x')).toBe(false);
    expect(isAllowedEndpoint('https://push.example.org/up123')).toBe(false);
    expect(isAllowedEndpoint('https://push.example.org/up123', ['push.example.org'])).toBe(true);
    expect(isAllowedEndpoint('http://push.example.org/up123', ['push.example.org'])).toBe(false);
    expect(isAllowedEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isAllowedEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isAllowedEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedEndpoint('https://evil.com/fcm.googleapis.com')).toBe(false);
    expect(isAllowedEndpoint('https://googleapis.com.evil.com/x')).toBe(false);
    expect(isAllowedEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isAllowedEndpoint('https://169.254.169.254/latest')).toBe(false);
  });
});
