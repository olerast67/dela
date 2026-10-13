import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF,
  DecryptError,
  INSECURE_TEST_KDF,
  changePassword,
  createAccount,
  derivePasswordKeys,
  fingerprint,
  formatRecoveryKey,
  fromB64,
  initCrypto,
  newKey,
  openAccount,
  openAccountWithRecovery,
  openEnvelope,
  openSealedSpaceKey,
  parseRecoveryKey,
  sealOp,
  sealSpaceKeyFor,
  slotFor,
  spaceKeys,
  toB64,
  unwrapKey,
  unwrapSpaceKey,
  wrapKey,
  wrapSpaceKey,
  type Op,
} from '../src/index.ts';

await initCrypto();

const op: Op = {
  table: 'task',
  record: '01929c3e-0000-7000-8000-000000000001',
  field: 'title',
  value: 'Позвонить маме',
  hlc: '001760000000000-0000-00000000000000aa',
};

describe('обёртка ключей', () => {
  it('разворачивается тем же ключом и назначением', () => {
    const key = newKey();
    const kek = newKey();
    const wrapped = wrapKey(key, kek, 'master');
    expect(unwrapKey(wrapped, kek, 'master')).toEqual(key);
  });

  it('чужой ключ или чужое назначение не подходят', () => {
    const wrapped = wrapKey(newKey(), newKey(), 'master');
    expect(() => unwrapKey(wrapped, newKey(), 'master')).toThrow(DecryptError);
    const kek = newKey();
    const w2 = wrapKey(newKey(), kek, 'master');
    expect(() => unwrapKey(w2, kek, 'box-secret')).toThrow(DecryptError);
  });

  it('испорченный шифротекст отклоняется', () => {
    const kek = newKey();
    const raw = fromB64(wrapKey(newKey(), kek, 'x'));
    raw[30]! ^= 1;
    expect(() => unwrapKey(toB64(raw), kek, 'x')).toThrow(DecryptError);
    expect(() => unwrapKey(toB64(new Uint8Array(10)), kek, 'x')).toThrow(DecryptError);
  });
});

describe('пароль', () => {
  it('одинаковый пароль и соль дают одинаковые ключи, секрет входа отличается от kek', () => {
    const salt = new Uint8Array(16).fill(7);
    const a = derivePasswordKeys('пароль', salt, INSECURE_TEST_KDF);
    const b = derivePasswordKeys('пароль', salt, INSECURE_TEST_KDF);
    expect(a).toEqual(b);
    expect(a.authSecret).not.toEqual(a.kek);
    const c = derivePasswordKeys('пароль2', salt, INSECURE_TEST_KDF);
    expect(c.authSecret).not.toEqual(a.authSecret);
  });

  it('пароль нормализуется: одна и та же буква в разных формах Unicode', () => {
    const salt = new Uint8Array(16).fill(1);
    const composed = 'й';
    const decomposed = 'й';
    expect(derivePasswordKeys(composed, salt, INSECURE_TEST_KDF)).toEqual(
      derivePasswordKeys(decomposed, salt, INSECURE_TEST_KDF),
    );
  });

  it('параметры по умолчанию работают', () => {
    const salt = new Uint8Array(16).fill(3);
    expect(derivePasswordKeys('x', salt, DEFAULT_KDF).kek).toHaveLength(32);
  });
});

describe('ключ восстановления', () => {
  it('текст разбирается обратно, регистр и разделители не важны', () => {
    const key = newKey();
    const text = formatRecoveryKey(key);
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(parseRecoveryKey(text)).toEqual(key);
    expect(parseRecoveryKey(text.toLowerCase().replace(/-/g, ' '))).toEqual(key);
  });

  it('опечатка ловится контрольной суммой', () => {
    const text = formatRecoveryKey(newKey());
    const i = text.indexOf('-') - 1;
    const wrong = text.slice(0, i) + (text[i] === '0' ? '1' : '0') + text.slice(i + 1);
    expect(() => parseRecoveryKey(wrong)).toThrow(SyntaxError);
    expect(() => parseRecoveryKey('ABC')).toThrow(SyntaxError);
    expect(() => parseRecoveryKey(text + 'U')).toThrow(SyntaxError);
  });
});

describe('аккаунт', () => {
  it('открывается паролем и ключом восстановления', () => {
    const acc = createAccount('верный пароль', INSECURE_TEST_KDF);
    const { kek, authSecret } = derivePasswordKeys('верный пароль', fromB64(acc.bundle.salt), acc.bundle.kdf);
    expect(authSecret).toEqual(acc.authSecret);
    expect(openAccount(acc.bundle, kek)).toEqual(acc.keys);
    expect(openAccountWithRecovery(acc.bundle, acc.recoveryKey)).toEqual(acc.keys);
  });

  it('неверный пароль не открывает', () => {
    const acc = createAccount('верный пароль', INSECURE_TEST_KDF);
    const { kek } = derivePasswordKeys('неверный', fromB64(acc.bundle.salt), acc.bundle.kdf);
    expect(() => openAccount(acc.bundle, kek)).toThrow(DecryptError);
  });

  it('подменённый открытый ключ обнаруживается', () => {
    const acc = createAccount('p', INSECURE_TEST_KDF);
    const other = createAccount('p', INSECURE_TEST_KDF);
    const { kek } = derivePasswordKeys('p', fromB64(acc.bundle.salt), acc.bundle.kdf);
    expect(() => openAccount({ ...acc.bundle, publicKey: other.bundle.publicKey }, kek)).toThrow(DecryptError);
  });

  it('смена пароля сохраняет ключи', () => {
    const acc = createAccount('старый', INSECURE_TEST_KDF);
    const changed = changePassword(acc.bundle, acc.keys, 'новый', INSECURE_TEST_KDF);
    const { kek, authSecret } = derivePasswordKeys('новый', fromB64(changed.bundle.salt), changed.bundle.kdf);
    expect(authSecret).toEqual(changed.authSecret);
    expect(openAccount(changed.bundle, kek)).toEqual(acc.keys);
    const old = derivePasswordKeys('старый', fromB64(changed.bundle.salt), changed.bundle.kdf);
    expect(() => openAccount(changed.bundle, old.kek)).toThrow(DecryptError);
    expect(openAccountWithRecovery(changed.bundle, acc.recoveryKey)).toEqual(acc.keys);
  });

  it('отпечаток: 6 групп по 5 цифр, разный у разных ключей', () => {
    const a = createAccount('p', INSECURE_TEST_KDF).keys.publicKey;
    const b = createAccount('p', INSECURE_TEST_KDF).keys.publicKey;
    expect(fingerprint(a)).toMatch(/^(\d{5} ){5}\d{5}$/);
    expect(fingerprint(a)).toBe(fingerprint(a));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe('ключи пространств', () => {
  it('у владельца: обёртка мастер-ключом привязана к пространству', () => {
    const master = newKey();
    const sk = newKey();
    const wrapped = wrapSpaceKey(sk, master, 'sp1');
    expect(unwrapSpaceKey(wrapped, master, 'sp1')).toEqual(sk);
    expect(() => unwrapSpaceKey(wrapped, master, 'sp2')).toThrow(DecryptError);
  });

  it('участнику: запечатан его открытым ключом', () => {
    const alice = createAccount('a', INSECURE_TEST_KDF).keys;
    const bob = createAccount('b', INSECURE_TEST_KDF).keys;
    const sk = newKey();
    const sealed = sealSpaceKeyFor(sk, 'sp1', bob.publicKey);
    expect(openSealedSpaceKey(sealed, 'sp1', bob)).toEqual(sk);
    expect(() => openSealedSpaceKey(sealed, 'sp1', alice)).toThrow(DecryptError);
    expect(() => openSealedSpaceKey(sealed, 'sp2', bob)).toThrow(DecryptError);
  });

  it('ключи шифрования и слотов различаются', () => {
    const k = spaceKeys(newKey());
    expect(k.enc).not.toEqual(k.slot);
  });
});

describe('конверт операции', () => {
  const keys = spaceKeys(newKey());

  it('открывается обратно в ту же операцию', () => {
    const env = sealOp('sp1', keys, op);
    expect(env.hlc).toBe(op.hlc);
    expect(openEnvelope('sp1', keys, env)).toEqual(op);
  });

  it('сервер не видит ни текста, ни таблицы, ни id записи, ни поля', () => {
    const env = sealOp('sp1', keys, op);
    const visible = JSON.stringify(env);
    for (const secret of ['Позвонить', 'task', 'title', op.record, '01929c3e']) {
      expect(visible).not.toContain(secret);
    }
    expect(env.slot).toMatch(/^[0-9a-f]{32}$/);
  });

  it('слот одинаков для одной ячейки и различается между ячейками и пространствами', () => {
    const other = spaceKeys(newKey());
    expect(slotFor(keys, 'task', 'r', 'title')).toBe(slotFor(keys, 'task', 'r', 'title'));
    expect(slotFor(keys, 'task', 'r', 'title')).not.toBe(slotFor(keys, 'task', 'r', 'due'));
    expect(slotFor(keys, 'task', 'r', 'title')).not.toBe(slotFor(other, 'task', 'r', 'title'));
    expect(slotFor(keys, 'a\u0000b', 'c', 'd')).not.toBe(slotFor(keys, 'a', 'b\u0000c', 'd'));
  });

  it('размер выровнен по 64 байтам и не выдаёт длину текста', () => {
    const short = sealOp('sp1', keys, { ...op, value: 'a' });
    const longer = sealOp('sp1', keys, { ...op, value: 'a'.repeat(20) });
    expect(fromB64(short.payload).length).toBe(fromB64(longer.payload).length);
    expect((fromB64(short.payload).length - 24 - 16) % 64).toBe(0);
  });

  it('подмена метки, слота или пространства ломает расшифровку', () => {
    const env = sealOp('sp1', keys, op);
    expect(() => openEnvelope('sp1', keys, { ...env, hlc: '001760000000001-0000-00000000000000aa' })).toThrow(DecryptError);
    expect(() => openEnvelope('sp1', keys, { ...env, slot: slotFor(keys, 'task', op.record, 'due') })).toThrow(DecryptError);
    expect(() => openEnvelope('sp2', keys, env)).toThrow(DecryptError);
    expect(() => openEnvelope('sp1', spaceKeys(newKey()), env)).toThrow(DecryptError);
  });

  it('один и тот же текст каждый раз шифруется по-разному', () => {
    expect(sealOp('sp1', keys, op).payload).not.toBe(sealOp('sp1', keys, op).payload);
  });
});
