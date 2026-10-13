/**
 * Дробные ключи порядка: строка между двумя соседями без перенумерации списка.
 *
 * Порт алгоритма David Greenspan в реализации rocicorp/fractional-indexing (CC0).
 * Ключ = целая часть (длина задаётся первым символом a–z / A–Z) + дробная часть в base62.
 * Целая часть делает добавление в конец списка дешёвым: ключи растут медленно.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0]!;
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b !== null && b.slice(-1) === ZERO)) {
    throw new Error('trailing zero');
  }
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  }
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(int[0]!)) throw new Error(`invalid integer part: ${int}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0]!);
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

export function isOrderKey(key: string): boolean {
  try {
    validateOrderKey(key);
    return true;
  } catch {
    return false;
  }
}

function validateOrderKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`invalid order key: ${key}`);
  for (const ch of key) {
    if (!DIGITS.includes(ch)) throw new Error(`invalid order key: ${key}`);
  }
  const i = integerPart(key);
  if (key.slice(i.length).slice(-1) === ZERO) throw new Error(`invalid order key: ${key}`);
}

function incrementInteger(x: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('') as [string, ...string[]];
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) + 1;
    if (d === DIGITS.length) {
      digs[i] = ZERO;
    } else {
      digs[i] = DIGITS[d]!;
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') return 'a' + ZERO;
    if (head === 'z') return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') digs.push(ZERO);
    else digs.pop();
    return h + digs.join('');
  }
  return head + digs.join('');
}

function decrementInteger(x: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('') as [string, ...string[]];
  const last = DIGITS.slice(-1);
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) - 1;
    if (d === -1) {
      digs[i] = last;
    } else {
      digs[i] = DIGITS[d]!;
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') return 'Z' + last;
    if (head === 'A') return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') digs.push(last);
    else digs.pop();
    return h + digs.join('');
  }
  return head + digs.join('');
}

/**
 * Ключ строго между a и b. null означает начало или конец списка.
 * Две вставки в одно место на разных устройствах дадут одинаковый ключ:
 * при сортировке такие записи упорядочиваются по id.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateOrderKey(a);
  if (b !== null) validateOrderKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);

  if (a === null) {
    if (b === null) return 'a' + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error('cannot decrement any more');
    return res;
  }

  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }

  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new Error('cannot increment any more');
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/** n ключей подряд между a и b (например, для вставки нескольких задач). */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const out: string[] = [];
    let prev = a;
    for (let i = 0; i < n; i++) {
      prev = keyBetween(prev, null);
      out.push(prev);
    }
    return out;
  }
  if (a === null) {
    const out: string[] = [];
    let next = b;
    for (let i = 0; i < n; i++) {
      next = keyBetween(null, next);
      out.push(next);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}

/** Сравнение для сортировки: по ключу, при равенстве по id. */
export function compareOrder(a: { order: string; id: string }, b: { order: string; id: string }): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
