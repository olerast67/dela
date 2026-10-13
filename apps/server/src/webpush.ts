/**
 * Web Push без сторонних библиотек: шифрование aes128gcm (RFC 8291, RFC 8188)
 * и подпись VAPID (RFC 8292) на node:crypto.
 */
import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto';

export interface Vapid {
  readonly privateKey: KeyObject;
  /** Открытый ключ, точка P-256 без сжатия (65 байт), base64url. */
  readonly publicKey: string;
}

export interface PushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export function generateVapid(): { privatePem: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export function loadVapid(privatePem: string): Vapid {
  const privateKey = createPrivateKey(privatePem);
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string; y: string };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { privateKey, publicKey: point.toString('base64url') };
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

/** Заголовок Authorization для push-сервиса. */
export function vapidAuthorization(vapid: Vapid, endpoint: string, subject: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const data = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(data), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/** Зашифровать содержимое для подписки (RFC 8291). */
export function encryptPayload(
  sub: PushSubscription,
  payload: Buffer,
  /** Только для проверки на примере из RFC: эфемерный ключ и соль. */
  fixed: { salt?: Buffer; asPrivate?: Buffer } = {},
): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.auth, 'base64url');
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('invalid subscription keys');
  const salt = fixed.salt ?? randomBytes(16);
  const ecdh = createECDH('prime256v1');
  let asPublic: Buffer;
  if (fixed.asPrivate) {
    ecdh.setPrivateKey(fixed.asPrivate);
    asPublic = ecdh.getPublicKey();
  } else asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // Одна запись: содержимое и разделитель последней записи 0x02.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Адрес подписки должен вести к известному push-сервису: сервер не будет стучаться куда попало. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
  // UnifiedPush через ntfy (телефоны без сервисов Google).
  /^ntfy\.sh$/,
];

/** extraHosts: свои распространители UnifiedPush (DELA_PUSH_HOSTS), точное имя хоста. */
export function isAllowedEndpoint(endpoint: string, extraHosts: readonly string[] = []): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && u.port === '' && (PUSH_HOSTS.some((re) => re.test(u.hostname)) || extraHosts.includes(u.hostname));
  } catch {
    return false;
  }
}

export type SendResult = 'ok' | 'gone' | 'error';

export async function sendPush(
  vapid: Vapid,
  sub: PushSubscription,
  payload: Buffer,
  options: { subject: string; ttl: number; fetcher?: typeof fetch },
): Promise<SendResult> {
  const fetcher = options.fetcher ?? fetch;
  const res = await fetcher(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(vapid, sub.endpoint, options.subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(options.ttl),
      urgency: 'high',
    },
    body: new Uint8Array(encryptPayload(sub, payload)),
    // Перенаправление увело бы запрос с разрешённого адреса; медленный сервис не держит остальные напоминания.
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'error';
}
