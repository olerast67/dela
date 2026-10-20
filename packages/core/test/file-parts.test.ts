import { beforeAll, describe, expect, it } from 'vitest';
import {
  DecryptError,
  FILE_PART_BYTES,
  FILE_PART_OVERHEAD,
  filePartCount,
  fileSealedSize,
  initCrypto,
  newFileKey,
  openFile,
  openFilePart,
  sealFile,
  sealFilePart,
} from '../src/index.ts';

beforeAll(async () => {
  await initCrypto();
});

const SPACE = '01929c3e-0000-7000-8000-0000000000aa';
const FILE = '01929c3e-0000-7000-8000-0000000000f1';

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** Сравнение больших массивов: toEqual на мегабайтах идёт минутами. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
}

function sealAll(data: Uint8Array, key: string, fileId = FILE): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < filePartCount(data.length); i++) {
    parts.push(sealFilePart(data.subarray(i * FILE_PART_BYTES, Math.min(data.length, (i + 1) * FILE_PART_BYTES)), key, SPACE, fileId, data.length, i));
  }
  return parts;
}

function openAll(parts: Uint8Array[], key: string, size: number, fileId = FILE): Uint8Array {
  if (parts.length !== filePartCount(size)) throw new DecryptError('part count mismatch');
  const out = new Uint8Array(size);
  parts.forEach((p, i) => out.set(openFilePart(p, key, SPACE, fileId, size, i), i * FILE_PART_BYTES));
  return out;
}

describe('файл по частям (v2)', () => {
  it('число частей и размер шифротекста', () => {
    expect(filePartCount(0)).toBe(1);
    expect(filePartCount(1)).toBe(1);
    expect(filePartCount(FILE_PART_BYTES)).toBe(1);
    expect(filePartCount(FILE_PART_BYTES + 1)).toBe(2);
    expect(fileSealedSize(0)).toBe(FILE_PART_OVERHEAD);
    expect(fileSealedSize(FILE_PART_BYTES * 2 + 5)).toBe(FILE_PART_BYTES * 2 + 5 + 3 * FILE_PART_OVERHEAD);
  });

  it('файл больше двух частей расшифровывается целиком, шифротекст не похож на открытый текст', () => {
    const data = bytes(2 * FILE_PART_BYTES + 12345);
    const key = newFileKey();
    const parts = sealAll(data, key);
    expect(parts).toHaveLength(3);
    expect(parts.reduce((n, p) => n + p.length, 0)).toBe(fileSealedSize(data.length));
    expect(same(openAll(parts, key, data.length), data)).toBe(true);
  });

  it('файл ровно на границе частей и пустой файл', () => {
    const key = newFileKey();
    const exact = bytes(FILE_PART_BYTES * 2);
    const parts = sealAll(exact, key);
    expect(parts).toHaveLength(2);
    expect(parts[1]!.length).toBe(FILE_PART_BYTES + FILE_PART_OVERHEAD);
    expect(same(openAll(parts, key, exact.length), exact)).toBe(true);

    const empty = sealAll(new Uint8Array(0), key);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.length).toBe(FILE_PART_OVERHEAD);
    expect(openAll(empty, key, 0)).toEqual(new Uint8Array(0));
  });

  it('перестановка, подмена, обрезка, лишняя часть и неверный номер дают ошибку', () => {
    const data = bytes(2 * FILE_PART_BYTES + 100);
    const key = newFileKey();
    const parts = sealAll(data, key);
    const size = data.length;
    // Перестановка частей.
    expect(() => openAll([parts[1]!, parts[0]!, parts[2]!], key, size)).toThrow(DecryptError);
    // Часть под чужим номером.
    expect(() => openFilePart(parts[0]!, key, SPACE, FILE, size, 1)).toThrow(DecryptError);
    // Испорченный байт.
    const broken = parts[1]!.slice();
    broken[100]! ^= 1;
    expect(() => openFilePart(broken, key, SPACE, FILE, size, 1)).toThrow(DecryptError);
    // Часть того же номера из другого файла с тем же ключом.
    const other = sealAll(bytes(size, 99), key, '01929c3e-0000-7000-8000-0000000000f2');
    expect(() => openFilePart(other[1]!, key, SPACE, FILE, size, 1)).toThrow(DecryptError);
    // Обрезка: без последней части или с обрезанной последней частью.
    expect(() => openAll(parts.slice(0, 2), key, size)).toThrow(DecryptError);
    expect(() => openAll(parts.slice(0, 2), key, 2 * FILE_PART_BYTES)).toThrow(DecryptError);
    expect(() => openFilePart(parts[2]!.subarray(0, parts[2]!.length - 1), key, SPACE, FILE, size, 2)).toThrow(DecryptError);
    // Лишняя часть в конце: сервер выдаёт файл большего размера.
    expect(() => openAll([...parts, parts[2]!], key, size + 100)).toThrow(DecryptError);
    // Номер за пределами файла.
    expect(() => openFilePart(parts[2]!, key, SPACE, FILE, size, 3)).toThrow(RangeError);
    // Другое пространство и другой ключ.
    expect(() => openFilePart(parts[0]!, key, '01929c3e-0000-7000-8000-0000000000ab', FILE, size, 0)).toThrow(DecryptError);
    expect(() => openFilePart(parts[0]!, newFileKey(), SPACE, FILE, size, 0)).toThrow(DecryptError);
  });

  it('часть неверной длины не шифруется', () => {
    const key = newFileKey();
    expect(() => sealFilePart(bytes(10), key, SPACE, FILE, FILE_PART_BYTES + 10, 0)).toThrow(RangeError);
    expect(() => sealFilePart(bytes(9), key, SPACE, FILE, FILE_PART_BYTES + 10, 1)).toThrow(RangeError);
  });

  it('форматы v1 и v2 не путаются', () => {
    const data = bytes(1000);
    const old = sealFile(data, SPACE, FILE);
    expect(() => openFilePart(old.blob, old.key, SPACE, FILE, data.length, 0)).toThrow(DecryptError);
    const key = newFileKey();
    const [part] = sealAll(data, key);
    expect(() => openFile(part!, key, SPACE, FILE)).toThrow(DecryptError);
    expect(same(openFile(old.blob, old.key, SPACE, FILE), data)).toBe(true);
  });
});
