/**
 * Замена libsodium-wrappers-sumo в сборке для часов. В QuickJS нет WebAssembly, а Argon2id на 64 МиБ
 * в интерпретаторе шёл бы минуты, поэтому примитивы считает libsodium приложения (lazysodium), а здесь
 * только тот же интерфейс, что у libsodium.js, для crypto.ts ядра. Кодирование base64/hex и pad/unpad — на JS.
 */
import { fromHex, host, toHex } from './host.ts';

type Bytes = Uint8Array;
type Input = Uint8Array | string;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

function bytes(x: Input): Bytes {
  return typeof x === 'string' ? enc.encode(x) : x;
}

function hexOf(x: Input | null | undefined): string {
  return x == null ? '' : toHex(bytes(x));
}

const base64_variants = { ORIGINAL: 1, ORIGINAL_NO_PADDING: 3, URLSAFE: 5, URLSAFE_NO_PADDING: 7 } as const;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function to_base64(data: Input, variant: number = base64_variants.URLSAFE_NO_PADDING): string {
  const b = bytes(data);
  const abc = variant & 4 ? B64URL : B64;
  const pad = (variant & 2) === 0;
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]!;
    out += i + 1 < b.length ? abc[(n >> 6) & 63]! : pad ? '=' : '';
    out += i + 2 < b.length ? abc[n & 63]! : pad ? '=' : '';
  }
  return out;
}

function from_base64(s: string, variant: number = base64_variants.URLSAFE_NO_PADDING): Bytes {
  const abc = variant & 4 ? B64URL : B64;
  const clean = s.replace(/=+$/, '');
  if ((variant & 2) === 0 && s.length % 4 !== 0) throw new Error('incomplete input');
  if (clean.length % 4 === 1) throw new Error('incomplete input');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let j = 0;
  for (const ch of clean) {
    const v = abc.indexOf(ch);
    if (v === -1) throw new Error('invalid input');
    value = ((value << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

/** ISO/IEC 7816-4, как sodium_pad: всегда добавляется хотя бы один байт 0x80. */
function pad(buf: Bytes, blocksize: number): Bytes {
  const xpad = blocksize - 1 - (buf.length % blocksize);
  const out = new Uint8Array(buf.length + xpad + 1);
  out.set(buf, 0);
  out[buf.length] = 0x80;
  return out;
}

function unpad(buf: Bytes, blocksize: number): Bytes {
  if (buf.length === 0 || buf.length % blocksize !== 0) throw new Error('unsupported input');
  for (let i = buf.length - 1, n = 0; i >= 0 && n < blocksize; i--, n++) {
    if (buf[i] === 0x80) return buf.slice(0, i);
    if (buf[i] !== 0) break;
  }
  throw new Error('unsupported input');
}

function fail(result: string | null, message: string): Bytes {
  if (result === null) throw new Error(message);
  return fromHex(result);
}

function pair(s: string): { publicKey: Bytes; privateKey: Bytes; keyType: string } {
  const [pk, sk] = s.split(':') as [string, string];
  return { publicKey: fromHex(pk), privateKey: fromHex(sk), keyType: 'x25519' };
}

const sodium = {
  ready: Promise.resolve(),
  base64_variants,
  crypto_pwhash_SALTBYTES: 16,
  crypto_pwhash_ALG_ARGON2ID13: 2,
  crypto_box_NONCEBYTES: 24,
  crypto_box_PUBLICKEYBYTES: 32,
  crypto_box_SECRETKEYBYTES: 32,

  to_base64,
  from_base64,
  to_hex: (b: Input) => toHex(bytes(b)),
  from_hex: (s: string) => fromHex(s),
  from_string: (s: string) => enc.encode(s),
  to_string: (b: Bytes) => dec.decode(b),
  pad,
  unpad,
  randombytes_buf: (n: number) => fromHex(host().randomHex(n)),

  crypto_pwhash(outLen: number, password: Input, salt: Bytes, ops: number, mem: number, alg: number): Bytes {
    return fromHex(host().pwhash(outLen, hexOf(password), toHex(salt), ops, mem, alg));
  },
  crypto_kdf_derive_from_key(outLen: number, subkeyId: number, ctx: string, key: Bytes): Bytes {
    return fromHex(host().kdf(outLen, subkeyId, ctx, toHex(key)));
  },
  crypto_aead_xchacha20poly1305_ietf_encrypt(m: Input, ad: Input | null, _nsec: null, nonce: Bytes, key: Bytes): Bytes {
    return fromHex(host().aeadEncrypt(hexOf(m), hexOf(ad), toHex(nonce), toHex(key)));
  },
  crypto_aead_xchacha20poly1305_ietf_decrypt(_nsec: null, c: Bytes, ad: Input | null, nonce: Bytes, key: Bytes): Bytes {
    return fail(host().aeadDecrypt(toHex(c), hexOf(ad), toHex(nonce), toHex(key)), 'ciphertext cannot be decrypted using that key');
  },
  crypto_generichash(outLen: number, m: Input, key?: Input | null): Bytes {
    return fromHex(host().generichash(outLen, hexOf(m), hexOf(key)));
  },
  crypto_scalarmult_base: (sk: Bytes) => fromHex(host().scalarmultBase(toHex(sk))),
  crypto_box_keypair: () => pair(host().boxKeypair()),
  crypto_box_seal: (m: Input, pk: Bytes) => fromHex(host().boxSeal(hexOf(m), toHex(pk))),
  crypto_box_seal_open(c: Bytes, pk: Bytes, sk: Bytes): Bytes {
    return fail(host().boxSealOpen(toHex(c), toHex(pk), toHex(sk)), 'incorrect key pair for the given ciphertext');
  },
  crypto_box_easy: (m: Input, nonce: Bytes, pk: Bytes, sk: Bytes) => fromHex(host().boxEasy(hexOf(m), toHex(nonce), toHex(pk), toHex(sk))),
  crypto_box_open_easy(c: Bytes, nonce: Bytes, pk: Bytes, sk: Bytes): Bytes {
    return fail(host().boxOpenEasy(toHex(c), toHex(nonce), toHex(pk), toHex(sk)), 'incorrect key pair for the given ciphertext');
  },
  crypto_sign_seed_keypair: (seed: Bytes) => ({ ...pair(host().signSeedKeypair(toHex(seed))), keyType: 'ed25519' }),
  crypto_sign_detached: (m: Input, sk: Bytes) => fromHex(host().signDetached(hexOf(m), toHex(sk))),
  crypto_sign_verify_detached: (sig: Bytes, m: Input, pk: Bytes) => host().signVerifyDetached(toHex(sig), hexOf(m), toHex(pk)),
  crypto_pwhash_str(): string {
    throw new Error('PIN lock is not available on the watch');
  },
  crypto_pwhash_str_verify(): boolean {
    throw new Error('PIN lock is not available on the watch');
  },
};

export default sodium;
