/**
 * Шифрование Dela. Схема описана в docs/architecture.md, раздел «Шифрование».
 *
 * Перед первым вызовом любой функции нужно один раз дождаться initCrypto().
 * Все двоичные данные для передачи и хранения кодируются в base64 (стандартный алфавит).
 */
import sodium from 'libsodium-wrappers-sumo';
import { cellKey, type Json, type Op } from './op.ts';
import type { Envelope } from './relay.ts';

let ready = false;

export async function initCrypto(): Promise<void> {
  await sodium.ready;
  ready = true;
}

function na(): typeof sodium {
  if (!ready) throw new Error('initCrypto() must be awaited before using crypto');
  return sodium;
}

export class DecryptError extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'DecryptError';
  }
}

export const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const PAD_BLOCK = 64;
const SLOT_BYTES = 16;

// ---------- кодирование ----------

export function toB64(data: Uint8Array): string {
  return na().to_base64(data, sodium.base64_variants.ORIGINAL);
}

export function fromB64(s: string): Uint8Array {
  return na().from_base64(s, sodium.base64_variants.ORIGINAL);
}

export function randomBytes(n: number): Uint8Array {
  return na().randombytes_buf(n);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------- симметричное шифрование ----------

/** XChaCha20-Poly1305 со случайным nonce. Результат: nonce ‖ шифротекст. */
function seal(plain: Uint8Array, key: Uint8Array, ad: string): Uint8Array {
  const s = na();
  const nonce = s.randombytes_buf(NONCE_BYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, encoder.encode(ad), null, nonce, key);
  return concat(nonce, ct);
}

function open(sealed: Uint8Array, key: Uint8Array, ad: string): Uint8Array {
  if (sealed.length < NONCE_BYTES + 16) throw new DecryptError('ciphertext too short');
  try {
    return na().crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sealed.subarray(NONCE_BYTES),
      encoder.encode(ad),
      sealed.subarray(0, NONCE_BYTES),
      key,
    );
  } catch {
    throw new DecryptError();
  }
}

/** Ключ, обёрнутый другим ключом. purpose попадает в AAD: ключ одного назначения нельзя подсунуть вместо другого. */
export function wrapKey(key: Uint8Array, wrappingKey: Uint8Array, purpose: string): string {
  return toB64(seal(key, wrappingKey, `dela/wrap/v1/${purpose}`));
}

export function unwrapKey(wrapped: string, wrappingKey: Uint8Array, purpose: string): Uint8Array {
  const key = open(fromB64(wrapped), wrappingKey, `dela/wrap/v1/${purpose}`);
  if (key.length !== KEY_BYTES) throw new DecryptError('wrapped key has wrong length');
  return key;
}

export function newKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

// ---------- пароль ----------

export interface KdfParams {
  readonly alg: 'argon2id13';
  /** Число проходов. */
  readonly ops: number;
  /** Память в байтах. */
  readonly mem: number;
}

/** 3 прохода, 64 МиБ: как у Bitwarden; выдерживает и браузер, и телефон. */
export const DEFAULT_KDF: KdfParams = { alg: 'argon2id13', ops: 3, mem: 64 * 1024 * 1024 };
/** Только для тестов. */
export const INSECURE_TEST_KDF: KdfParams = { alg: 'argon2id13', ops: 1, mem: 8192 };

export function newSalt(): Uint8Array {
  return randomBytes(na().crypto_pwhash_SALTBYTES);
}

export interface PasswordKeys {
  /** Уходит на сервер как доказательство знания пароля. Из него нельзя получить kek. */
  readonly authSecret: Uint8Array;
  /** Ключ обёртки мастер-ключа. Не покидает устройство. */
  readonly kek: Uint8Array;
}

export function derivePasswordKeys(password: string, salt: Uint8Array, kdf: KdfParams): PasswordKeys {
  const s = na();
  if (kdf.alg !== 'argon2id13') throw new Error(`unsupported kdf: ${kdf.alg}`);
  const root = s.crypto_pwhash(
    KEY_BYTES,
    password.normalize('NFKC'),
    salt,
    kdf.ops,
    kdf.mem,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
  return {
    authSecret: s.crypto_kdf_derive_from_key(KEY_BYTES, 1, 'dela_pwd', root),
    kek: s.crypto_kdf_derive_from_key(KEY_BYTES, 2, 'dela_pwd', root),
  };
}

// ---------- ключ восстановления ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of text) {
    const v = CROCKFORD.indexOf(ch);
    if (v === -1) throw new SyntaxError(`invalid character in recovery key: ${ch}`);
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      if (i < bytes) out[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (i !== bytes) throw new SyntaxError('recovery key has wrong length');
  return out;
}

function checksum(key: Uint8Array): Uint8Array {
  return na().crypto_generichash(16, key, null).subarray(0, 2);
}

/** Ключ восстановления как текст: 55 символов base32 Crockford группами по 5, последние 2 байта — контрольная сумма. */
export function formatRecoveryKey(key: Uint8Array): string {
  const raw = base32(concat(key, checksum(key)));
  return raw.match(/.{1,5}/g)!.join('-');
}

/** Разбирает ключ восстановления: регистр, пробелы и дефисы не важны, O читается как 0, I и L как 1. */
export function parseRecoveryKey(text: string): Uint8Array {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  const raw = unbase32(clean, KEY_BYTES + 2);
  const key = raw.subarray(0, KEY_BYTES);
  const sum = checksum(key);
  if (sum[0] !== raw[KEY_BYTES] || sum[1] !== raw[KEY_BYTES + 1]) {
    throw new SyntaxError('recovery key checksum mismatch');
  }
  return key.slice();
}

// ---------- аккаунт ----------

export interface AccountKeys {
  readonly masterKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/** Хранится на сервере. Все поля непрозрачны для сервера, кроме параметров KDF и соли. */
export interface AccountBundle {
  readonly kdf: KdfParams;
  readonly salt: string;
  readonly masterByPassword: string;
  readonly masterByRecovery: string;
  readonly publicKey: string;
  readonly secretKeyByMaster: string;
}

export interface NewAccount {
  readonly bundle: AccountBundle;
  readonly authSecret: Uint8Array;
  /** Показать пользователю один раз и попросить сохранить. */
  readonly recoveryKey: string;
  /** Секрет входа по ключу восстановления: уходит на сервер при регистрации (сервер хранит его хеш). */
  readonly recoveryAuth: Uint8Array;
  readonly keys: AccountKeys;
}

/**
 * Секрет входа по ключу восстановления. Получается из ключа через KDF,
 * поэтому сервер, зная его хеш, не может развернуть мастер-ключ.
 */
export function recoveryAuthSecret(recoveryKey: Uint8Array): Uint8Array {
  return na().crypto_kdf_derive_from_key(KEY_BYTES, 3, 'dela_rec', recoveryKey);
}

export function createAccount(password: string, kdf: KdfParams = DEFAULT_KDF): NewAccount {
  const s = na();
  const salt = newSalt();
  const { authSecret, kek } = derivePasswordKeys(password, salt, kdf);
  const masterKey = newKey();
  const recovery = newKey();
  const pair = s.crypto_box_keypair();
  return {
    bundle: {
      kdf,
      salt: toB64(salt),
      masterByPassword: wrapKey(masterKey, kek, 'master'),
      masterByRecovery: wrapKey(masterKey, recovery, 'master-recovery'),
      publicKey: toB64(pair.publicKey),
      secretKeyByMaster: wrapKey(pair.privateKey, masterKey, 'box-secret'),
    },
    authSecret,
    recoveryKey: formatRecoveryKey(recovery),
    recoveryAuth: recoveryAuthSecret(recovery),
    keys: { masterKey, publicKey: pair.publicKey, secretKey: pair.privateKey },
  };
}

function openWithMaster(bundle: AccountBundle, masterKey: Uint8Array): AccountKeys {
  const publicKey = fromB64(bundle.publicKey);
  const secretKey = unwrapKey(bundle.secretKeyByMaster, masterKey, 'box-secret');
  if (toB64(na().crypto_scalarmult_base(secretKey)) !== bundle.publicKey) {
    throw new DecryptError('account key pair mismatch');
  }
  return { masterKey, publicKey, secretKey };
}

export function openAccount(bundle: AccountBundle, kek: Uint8Array): AccountKeys {
  return openWithMaster(bundle, unwrapKey(bundle.masterByPassword, kek, 'master'));
}

export function openAccountWithRecovery(bundle: AccountBundle, recoveryKey: string): AccountKeys {
  return openWithMaster(bundle, unwrapKey(bundle.masterByRecovery, parseRecoveryKey(recoveryKey), 'master-recovery'));
}

/** Смена пароля: перешифровывается только мастер-ключ. */
export function changePassword(
  bundle: AccountBundle,
  keys: AccountKeys,
  newPassword: string,
  kdf: KdfParams = DEFAULT_KDF,
): { bundle: AccountBundle; authSecret: Uint8Array } {
  const salt = newSalt();
  const { authSecret, kek } = derivePasswordKeys(newPassword, salt, kdf);
  return {
    bundle: { ...bundle, kdf, salt: toB64(salt), masterByPassword: wrapKey(keys.masterKey, kek, 'master') },
    authSecret,
  };
}

/** Отпечаток открытого ключа для сверки участниками: 6 групп по 5 цифр, как safety number в Signal. */
export function fingerprint(publicKey: Uint8Array): string {
  const h = na().crypto_generichash(30, publicKey, null);
  const groups: string[] = [];
  for (let i = 0; i < 30; i += 5) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[i + j]!;
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// ---------- пространства ----------

export interface SpaceKeys {
  readonly enc: Uint8Array;
  readonly slot: Uint8Array;
}

export function spaceKeys(spaceKey: Uint8Array): SpaceKeys {
  const s = na();
  return {
    enc: s.crypto_kdf_derive_from_key(KEY_BYTES, 1, 'dela_enc', spaceKey),
    slot: s.crypto_kdf_derive_from_key(KEY_BYTES, 2, 'dela_slt', spaceKey),
  };
}

/** Ключ пространства для хранения у владельца: обёрнут мастер-ключом. */
export function wrapSpaceKey(spaceKey: Uint8Array, masterKey: Uint8Array, spaceId: string): string {
  return wrapKey(spaceKey, masterKey, `space/${spaceId}`);
}

export function unwrapSpaceKey(wrapped: string, masterKey: Uint8Array, spaceId: string): Uint8Array {
  return unwrapKey(wrapped, masterKey, `space/${spaceId}`);
}

/** Ключ пространства для участника: запечатан его открытым ключом (crypto_box_seal). */
export function sealSpaceKeyFor(spaceKey: Uint8Array, spaceId: string, recipientPublicKey: Uint8Array): string {
  const payload = concat(encoder.encode(`${spaceId}\n`), spaceKey);
  return toB64(na().crypto_box_seal(payload, recipientPublicKey));
}

export function openSealedSpaceKey(sealed: string, spaceId: string, keys: AccountKeys): Uint8Array {
  let payload: Uint8Array;
  try {
    payload = na().crypto_box_seal_open(fromB64(sealed), keys.publicKey, keys.secretKey);
  } catch {
    throw new DecryptError();
  }
  const prefix = encoder.encode(`${spaceId}\n`);
  if (payload.length !== prefix.length + KEY_BYTES || !prefix.every((b, i) => payload[i] === b)) {
    throw new DecryptError('sealed key belongs to another space');
  }
  return payload.slice(prefix.length);
}

/**
 * Ключ пространства от владельца с подтверждением отправителя: crypto_box (секретный ключ владельца,
 * открытый ключ участника). Участник видит, чей это ключ, и сверяет его с закреплённым ключом владельца:
 * сервер не может выдать свой ключ проекта под видом владельца. Формат: «DB1» ‖ открытый ключ отправителя ‖
 * nonce ‖ шифротекст («пространство\nверсия\n» ‖ ключ). Кладётся в то же поле, что и запечатанный ключ.
 */
const BOX_MAGIC = encoder.encode('DB1');

export function boxSpaceKeyFor(spaceKey: Uint8Array, spaceId: string, keyVersion: number, recipientPublicKey: Uint8Array, sender: AccountKeys): string {
  const s = na();
  const nonce = s.randombytes_buf(s.crypto_box_NONCEBYTES);
  const payload = concat(encoder.encode(`${spaceId}\n${keyVersion}\n`), spaceKey);
  return toB64(concat(concat(BOX_MAGIC, sender.publicKey), concat(nonce, s.crypto_box_easy(payload, nonce, recipientPublicKey, sender.secretKey))));
}

export function isBoxedSpaceKey(key: string): boolean {
  const raw = fromB64(key);
  return raw.length > BOX_MAGIC.length && BOX_MAGIC.every((b, i) => raw[i] === b);
}

/** Открыть ключ от владельца: возвращает ключ и открытый ключ отправителя (его сверяют с закреплённым). */
export function openBoxedSpaceKey(boxed: string, spaceId: string, keyVersion: number, keys: AccountKeys): { key: Uint8Array; sender: Uint8Array } {
  const s = na();
  const raw = fromB64(boxed);
  const pkEnd = BOX_MAGIC.length + s.crypto_box_PUBLICKEYBYTES;
  const nonceEnd = pkEnd + s.crypto_box_NONCEBYTES;
  if (raw.length <= nonceEnd) throw new DecryptError('boxed key too short');
  const sender = raw.slice(BOX_MAGIC.length, pkEnd);
  let payload: Uint8Array;
  try {
    payload = s.crypto_box_open_easy(raw.subarray(nonceEnd), raw.subarray(pkEnd, nonceEnd), sender, keys.secretKey);
  } catch {
    throw new DecryptError();
  }
  const prefix = encoder.encode(`${spaceId}\n${keyVersion}\n`);
  if (payload.length !== prefix.length + KEY_BYTES || !prefix.every((b, i) => payload[i] === b)) {
    throw new DecryptError('boxed key belongs to another space or version');
  }
  return { key: payload.slice(prefix.length), sender };
}

// ---------- конверт операции ----------

/** Непрозрачный id ячейки: BLAKE2b-128 с ключом слотов пространства. */
export function slotFor(keys: SpaceKeys, table: string, record: string, field: string): string {
  return na().to_hex(na().crypto_generichash(SLOT_BYTES, encoder.encode(cellKey(table, record, field)), keys.slot));
}

function opAd(spaceId: string, slot: string, hlc: string): string {
  return `dela/op/v1\n${spaceId}\n${slot}\n${hlc}`;
}

export function sealOp(spaceId: string, keys: SpaceKeys, op: Op): Envelope<string> {
  const s = na();
  const slot = slotFor(keys, op.table, op.record, op.field);
  const body = encoder.encode(JSON.stringify({ t: op.table, r: op.record, f: op.field, v: op.value }));
  const padded = s.pad(body, PAD_BLOCK);
  return { slot, hlc: op.hlc, payload: toB64(seal(padded, keys.enc, opAd(spaceId, slot, op.hlc))) };
}

export function openEnvelope(spaceId: string, keys: SpaceKeys, env: Envelope<string>): Op {
  const s = na();
  const padded = open(fromB64(env.payload), keys.enc, opAd(spaceId, env.slot, env.hlc));
  let body: { t: string; r: string; f: string; v: Json };
  try {
    body = JSON.parse(decoder.decode(s.unpad(padded, PAD_BLOCK)));
  } catch {
    throw new DecryptError('malformed operation');
  }
  // Участник пространства мог бы положить данные одной ячейки под слот другой.
  if (slotFor(keys, body.t, body.r, body.f) !== env.slot) throw new DecryptError('slot mismatch');
  return { table: body.t, record: body.r, field: body.f, value: body.v, hlc: env.hlc };
}

// ---------- PIN блокировки приложения ----------

/**
 * Хеш PIN-кода для блокировки экрана на этом устройстве (Argon2id, строка libsodium с солью и параметрами).
 * PIN короткий, поэтому защита держится на лимите попыток в приложении, а хеш нужен,
 * чтобы PIN не лежал на устройстве открытым текстом.
 */
export function hashPin(pin: string, kdf: KdfParams = PIN_KDF): string {
  const s = na();
  return s.crypto_pwhash_str(pin.normalize('NFKC'), kdf.ops, kdf.mem);
}

export function verifyPin(hash: string, pin: string): boolean {
  try {
    return na().crypto_pwhash_str_verify(hash, pin.normalize('NFKC'));
  } catch {
    return false;
  }
}

/** 2 прохода, 32 МиБ: проверка PIN занимает доли секунды и на телефоне. */
export const PIN_KDF: KdfParams = { alg: 'argon2id13', ops: 2, mem: 32 * 1024 * 1024 };

// ---------- файлы в комментариях ----------

/**
 * Зашифровать файл новым случайным ключом. AAD связывает шифротекст с пространством и id файла:
 * сервер не может подсунуть один файл вместо другого. Ключ кладётся в запись комментария,
 * которая сама зашифрована ключом пространства.
 */
export function sealFile(data: Uint8Array, spaceId: string, fileId: string): { key: string; blob: Uint8Array } {
  const key = newKey();
  return { key: toB64(key), blob: seal(data, key, `dela/file/v1\n${spaceId}\n${fileId}`) };
}

export function openFile(blob: Uint8Array, key: string, spaceId: string, fileId: string): Uint8Array {
  return open(blob, fromB64(key), `dela/file/v1\n${spaceId}\n${fileId}`);
}

// ---------- passkey с PRF ----------

/**
 * Соль PRF одна на всё приложение: секрет PRF и так свой у каждого passkey.
 * Этот секрет не покидает устройство, из него выводится ключ, которым обёрнут мастер-ключ аккаунта.
 */
export function passkeyPrfSalt(): Uint8Array {
  return na().crypto_generichash(32, encoder.encode('dela/passkey/prf/v1'), null);
}

function passkeyWrappingKey(prfOutput: Uint8Array): Uint8Array {
  const s = na();
  return s.crypto_kdf_derive_from_key(KEY_BYTES, 1, 'dela_psk', s.crypto_generichash(KEY_BYTES, prfOutput, null));
}

export function wrapMasterForPasskey(masterKey: Uint8Array, prfOutput: Uint8Array): string {
  return wrapKey(masterKey, passkeyWrappingKey(prfOutput), 'master-passkey');
}

export function openAccountWithPasskey(bundle: AccountBundle, wrappedMaster: string, prfOutput: Uint8Array): AccountKeys {
  return openWithMaster(bundle, unwrapKey(wrappedMaster, passkeyWrappingKey(prfOutput), 'master-passkey'));
}
