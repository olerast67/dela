/**
 * Гибридные логические часы (HLC).
 *
 * Метка: `WWWWWWWWWWWWWWW-CCCC-NNNNNNNNNNNNNNNN`
 *   W — физическое время в мс, 15 десятичных цифр;
 *   C — счётчик в base36, 4 знака;
 *   N — id устройства, 16 hex-символов.
 * Формат фиксированной ширины: строковое сравнение меток совпадает с логическим порядком.
 */

export interface Timestamp {
  readonly wall: number;
  readonly counter: number;
  readonly node: string;
}

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 4;
export const MAX_COUNTER = 36 ** COUNTER_DIGITS - 1;
const MAX_WALL = 10 ** WALL_DIGITS - 1;
const NODE_RE = /^[0-9a-f]{16}$/;
const TIMESTAMP_RE = /^(\d{15})-([0-9a-z]{4})-([0-9a-f]{16})$/;

export class CounterOverflowError extends Error {
  constructor() {
    super('HLC counter overflow');
    this.name = 'CounterOverflowError';
  }
}

export function isNodeId(s: string): boolean {
  return NODE_RE.test(s);
}

/** Случайный id устройства: 8 байт в hex. */
export function newNodeId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function formatTimestamp(t: Timestamp): string {
  if (!Number.isSafeInteger(t.wall) || t.wall < 0 || t.wall > MAX_WALL) {
    throw new RangeError(`HLC wall out of range: ${t.wall}`);
  }
  if (!Number.isSafeInteger(t.counter) || t.counter < 0 || t.counter > MAX_COUNTER) {
    throw new RangeError(`HLC counter out of range: ${t.counter}`);
  }
  if (!NODE_RE.test(t.node)) throw new RangeError(`Invalid HLC node: ${t.node}`);
  return (
    String(t.wall).padStart(WALL_DIGITS, '0') +
    '-' +
    t.counter.toString(36).padStart(COUNTER_DIGITS, '0') +
    '-' +
    t.node
  );
}

export function parseTimestamp(s: string): Timestamp {
  const m = TIMESTAMP_RE.exec(s);
  if (!m) throw new SyntaxError(`Invalid HLC timestamp: ${s}`);
  return { wall: Number(m[1]), counter: parseInt(m[2]!, 36), node: m[3]! };
}

export function isTimestamp(s: string): boolean {
  return TIMESTAMP_RE.test(s);
}

/**
 * Опережает ли метка заданное время больше чем на maxDrift мс.
 * Проверку делает сервер при приёме операций; клиент чужие метки не отклоняет.
 */
export function exceedsDrift(ts: string, now: number, maxDrift: number): boolean {
  return parseTimestamp(ts).wall - now > maxDrift;
}

export class HybridClock {
  readonly node: string;
  private readonly now: () => number;
  private wall = 0;
  private counter = 0;

  /**
   * @param node id устройства
   * @param now  источник времени; приложение передаёт время с поправкой на сервер
   * @param last последняя выданная метка, сохранённая между запусками
   */
  constructor(node: string, now: () => number = Date.now, last?: string) {
    if (!NODE_RE.test(node)) throw new RangeError(`Invalid HLC node: ${node}`);
    this.node = node;
    this.now = now;
    if (last !== undefined) {
      const t = parseTimestamp(last);
      this.wall = t.wall;
      this.counter = t.counter;
    }
  }

  /** Метка для новой локальной операции. Каждая следующая строго больше предыдущей. */
  tick(): string {
    const phys = this.now();
    if (phys > this.wall) {
      this.wall = phys;
      this.counter = 0;
    } else {
      this.bump(this.counter + 1);
    }
    return this.current();
  }

  /** Учесть метку полученной операции, чтобы следующие локальные метки были больше неё. */
  receive(remote: string): void {
    const r = parseTimestamp(remote);
    const phys = this.now();
    const wall = Math.max(this.wall, r.wall, phys);
    let counter: number;
    if (wall === this.wall && wall === r.wall) counter = Math.max(this.counter, r.counter) + 1;
    else if (wall === this.wall) counter = this.counter + 1;
    else if (wall === r.wall) counter = r.counter + 1;
    else counter = 0;
    this.wall = wall;
    this.bump(counter);
  }

  /** Последняя выданная или учтённая метка; её сохраняют, чтобы передать в конструктор. */
  current(): string {
    return formatTimestamp({ wall: this.wall, counter: this.counter, node: this.node });
  }

  private bump(counter: number): void {
    if (counter > MAX_COUNTER) throw new CounterOverflowError();
    this.counter = counter;
  }
}
