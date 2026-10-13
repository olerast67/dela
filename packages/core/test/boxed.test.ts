import { beforeAll, describe, expect, it } from 'vitest';
import { boxSpaceKeyFor, createAccount, initCrypto, isBoxedSpaceKey, newKey, openBoxedSpaceKey, sealSpaceKeyFor, toB64 } from '../src/index.ts';
import { INSECURE_TEST_KDF } from '../src/crypto.ts';

beforeAll(async () => {
  await initCrypto();
});

describe('ключ проекта от владельца', () => {
  it('участник открывает ключ и видит отправителя; другое пространство или версия не подходят', () => {
    const owner = createAccount('о', INSECURE_TEST_KDF).keys;
    const member = createAccount('у', INSECURE_TEST_KDF).keys;
    const stranger = createAccount('ч', INSECURE_TEST_KDF).keys;
    const key = newKey();
    const boxed = boxSpaceKeyFor(key, 'space-1', 2, member.publicKey, owner);
    expect(isBoxedSpaceKey(boxed)).toBe(true);
    expect(isBoxedSpaceKey(sealSpaceKeyFor(key, 'space-1', member.publicKey))).toBe(false);
    const opened = openBoxedSpaceKey(boxed, 'space-1', 2, member);
    expect(opened.key).toEqual(key);
    expect(toB64(opened.sender)).toBe(toB64(owner.publicKey));
    expect(() => openBoxedSpaceKey(boxed, 'space-2', 2, member)).toThrow();
    expect(() => openBoxedSpaceKey(boxed, 'space-1', 3, member)).toThrow();
    expect(() => openBoxedSpaceKey(boxed, 'space-1', 2, stranger)).toThrow();
    // Сервер может зашифровать свой ключ своим ключом, но отправителем тогда будет не владелец.
    const forged = boxSpaceKeyFor(newKey(), 'space-1', 2, member.publicKey, stranger);
    expect(toB64(openBoxedSpaceKey(forged, 'space-1', 2, member).sender)).not.toBe(toB64(owner.publicKey));
  });
});
