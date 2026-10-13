/**
 * Детерминированная симуляция синхронизации.
 *
 * Несколько устройств со сдвинутыми часами пишут в общие ячейки, теряют сеть,
 * теряют подтверждения отправки и забирают изменения страницами.
 * В конце все реплики и сервер должны совпасть с эталоном: для каждой ячейки
 * значение операции с наибольшей меткой среди всех когда-либо созданных.
 */
import { describe, expect, it } from 'vitest';
import {
  HybridClock,
  MemoryRelay,
  MemoryReplica,
  cellKey,
  initCrypto,
  newKey,
  openEnvelope,
  sealOp,
  spaceKeys,
  type Envelope,
  type Json,
  type Op,
} from '../src/index.ts';

await initCrypto();

/** Как операция превращается в конверт и обратно: открытым текстом или с шифрованием. */
interface Codec<P> {
  seal(op: Op): Envelope<P>;
  open(env: Envelope<P>): Op;
}

const plainCodec: Codec<Op> = {
  seal: (op) => ({ slot: cellKey(op.table, op.record, op.field), hlc: op.hlc, payload: op }),
  open: (env) => env.payload,
};

function encryptedCodec(): Codec<string> {
  const keys = spaceKeys(newKey());
  return {
    seal: (op) => sealOp('space-1', keys, op),
    open: (env) => openEnvelope('space-1', keys, env),
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Device<P> {
  readonly clock: HybridClock;
  readonly replica = new MemoryReplica();
  outbox: Op[] = [];
  cursor = 0;
  online = true;
  maxSeen = '';

  private readonly codec: Codec<P>;

  constructor(node: string, now: () => number, codec: Codec<P>) {
    this.clock = new HybridClock(node, now);
    this.codec = codec;
  }

  write(table: string, record: string, field: string, value: Json): Op {
    const op: Op = { table, record, field, value, hlc: this.clock.tick() };
    // HLC: новая локальная метка больше всего, что устройство уже видело.
    expect(op.hlc > this.maxSeen).toBe(true);
    this.maxSeen = op.hlc;
    this.replica.apply(op);
    this.outbox.push(op);
    return op;
  }

  push(relay: MemoryRelay<P>, ackLost: boolean): void {
    if (!this.online || this.outbox.length === 0) return;
    relay.push(this.outbox.map((op) => this.codec.seal(op)));
    if (!ackLost) this.outbox = [];
  }

  pull(relay: MemoryRelay<P>, pageSize: number): void {
    if (!this.online) return;
    for (;;) {
      const page = relay.pull(this.cursor, pageSize);
      for (const env of page.envelopes) {
        this.clock.receive(env.hlc);
        if (env.hlc > this.maxSeen) this.maxSeen = env.hlc;
        this.replica.apply(this.codec.open(env));
      }
      this.cursor = page.cursor;
      if (!page.more) break;
    }
  }
}

function simulate<P>(seed: number, steps: number, codec: Codec<P>): void {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

  let time = 1_760_000_000_000;
  const deviceCount = 2 + Math.floor(rnd() * 4);
  const relay = new MemoryRelay<P>();
  const devices = Array.from({ length: deviceCount }, (_, i) => {
    const skew = Math.floor((rnd() - 0.5) * 60_000);
    return new Device(i.toString(16).padStart(16, '0'), () => time + skew, codec);
  });

  const expected = new Map<string, { value: Json; hlc: string }>();
  const records = Array.from({ length: 12 }, (_, i) => `r${i}`);
  const tables = ['task', 'project'] as const;
  const fields = ['title', 'due', 'order', 'done', 'deleted_at'] as const;

  for (let step = 0; step < steps; step++) {
    const d = pick(devices);
    const r = rnd();
    if (r < 0.5) {
      const value: Json = rnd() < 0.1 ? null : rnd() < 0.5 ? `v${step}` : { n: step, s: 'текст' };
      const op = d.write(pick(tables), pick(records), pick(fields), value);
      const key = cellKey(op.table, op.record, op.field);
      const cur = expected.get(key);
      if (!cur || op.hlc > cur.hlc) expected.set(key, { value: op.value, hlc: op.hlc });
    } else if (r < 0.7) {
      d.push(relay, rnd() < 0.15);
    } else if (r < 0.88) {
      d.pull(relay, 1 + Math.floor(rnd() * 10));
    } else if (r < 0.95) {
      d.online = !d.online;
    }
    // Время иногда стоит на месте: так проверяется счётчик внутри одной миллисекунды.
    if (rnd() < 0.6) time += Math.floor(rnd() * 40);
  }

  for (const d of devices) {
    d.online = true;
    d.push(relay, false);
  }
  for (const d of devices) d.pull(relay, 7);

  const want = [...expected.entries()]
    .map(([k, c]): [string, Json, string] => [k, c.value, c.hlc])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  for (const d of devices) {
    expect(d.outbox).toEqual([]);
    expect(d.replica.dump()).toEqual(want);
  }
  const onServer = relay
    .dump()
    .map(([slot, hlc, payload]) => {
      const op = codec.open({ slot, hlc, payload });
      return [cellKey(op.table, op.record, op.field), op.value, hlc];
    })
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  expect(onServer).toEqual(want);
}

describe('симуляция синхронизации', () => {
  for (let seed = 1; seed <= 60; seed++) {
    it(`seed ${seed}: все устройства и сервер сходятся к эталону`, () => simulate(seed, 2_000, plainCodec));
  }

  it('длинный прогон', () => simulate(424242, 50_000, plainCodec));

  for (let seed = 1; seed <= 5; seed++) {
    it(`seed ${seed}: то же поверх зашифрованных конвертов`, () => simulate(seed, 1_500, encryptedCodec()));
  }
});

describe('MemoryRelay', () => {
  it('повторная отправка той же операции ничего не меняет', () => {
    const relay = new MemoryRelay<string>();
    const env = { slot: 's', hlc: '000000000000001-0000-000000000000000a', payload: 'x' };
    expect(relay.push([env])).toBe(1);
    expect(relay.push([env])).toBe(0);
    expect(relay.pull(0).envelopes).toHaveLength(1);
  });

  it('старая метка не затирает новую, новая получает новый seq', () => {
    const relay = new MemoryRelay<string>();
    const newer = { slot: 's', hlc: '000000000000002-0000-000000000000000a', payload: 'new' };
    const older = { slot: 's', hlc: '000000000000001-0000-000000000000000b', payload: 'old' };
    relay.push([{ slot: 'other', hlc: newer.hlc, payload: 'o' }, newer]);
    expect(relay.push([older])).toBe(0);
    const before = relay.pull(0);
    expect(before.envelopes.map((e) => e.payload)).toEqual(['o', 'new']);

    const newest = { slot: 'other', hlc: '000000000000003-0000-000000000000000a', payload: 'o2' };
    relay.push([newest]);
    const after = relay.pull(before.cursor);
    expect(after.envelopes.map((e) => e.payload)).toEqual(['o2']);
    expect(relay.pull(0).envelopes.map((e) => e.payload)).toEqual(['new', 'o2']);
  });

  it('страницы', () => {
    const relay = new MemoryRelay<number>();
    relay.push(Array.from({ length: 5 }, (_, i) => ({ slot: `s${i}`, hlc: `00000000000000${i}-0000-000000000000000a`, payload: i })));
    const p1 = relay.pull(0, 2);
    expect(p1.envelopes.map((e) => e.payload)).toEqual([0, 1]);
    expect(p1.more).toBe(true);
    const p2 = relay.pull(p1.cursor, 3);
    expect(p2.envelopes.map((e) => e.payload)).toEqual([2, 3, 4]);
    expect(p2.more).toBe(false);
    expect(relay.pull(p2.cursor).envelopes).toEqual([]);
    expect(relay.pull(p2.cursor).cursor).toBe(p2.cursor);
  });
});
