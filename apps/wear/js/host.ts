/**
 * Функции, которые приложение часов даёт движку QuickJS (globalThis.__host). Двоичные данные идут
 * строками hex: мост QuickJS надёжно передаёт только строки и числа. Ошибка расшифровки — null.
 */
export interface Host {
  /** Синхронный HTTP-запрос: JSON {status, body} или {error} при сбое сети. */
  http(method: string, url: string, headers: string, body: string | null): string;
  randomHex(n: number): string;
  /** «YYYY-MM-DD HH:mm:ss» на стенных часах пояса tz в момент ms; null, если пояса нет. */
  zone(ms: number, tz: string): string | null;
  defaultZone(): string;
  log(msg: string): void;

  /** password — байты UTF-8 в hex. */
  pwhash(outLen: number, password: string, salt: string, ops: number, mem: number, alg: number): string;
  kdf(outLen: number, subkeyId: number, ctx: string, key: string): string;
  aeadEncrypt(m: string, ad: string, nonce: string, key: string): string;
  aeadDecrypt(c: string, ad: string, nonce: string, key: string): string | null;
  /** key пустой — хеш без ключа. */
  generichash(outLen: number, m: string, key: string): string;
  scalarmultBase(sk: string): string;
  boxKeypair(): string;
  boxSeal(m: string, pk: string): string;
  boxSealOpen(c: string, pk: string, sk: string): string | null;
  boxEasy(m: string, nonce: string, pk: string, sk: string): string;
  boxOpenEasy(c: string, nonce: string, pk: string, sk: string): string | null;
  /** «pk:sk» в hex. */
  signSeedKeypair(seed: string): string;
  signDetached(m: string, sk: string): string;
  signVerifyDetached(sig: string, m: string, pk: string): boolean;

  vaultExists(): boolean;
  /** Файл сессии (расшифрованный JSON) или null. */
  vaultRead(): string | null;
  vaultWrite(json: string): void;
  vaultRemove(): void;
  deviceName(): string;
}

export function host(): Host {
  const h = (globalThis as { __host?: Host }).__host;
  if (!h) throw new Error('__host is not installed');
  return h;
}

const HEX = '0123456789abcdef';

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]! >> 4]! + HEX[b[i]! & 15]!;
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new SyntaxError('odd hex length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) throw new SyntaxError('invalid hex');
    out[i] = v;
  }
  return out;
}
