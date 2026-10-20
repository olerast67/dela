/**
 * Часы: заплатки для QuickJS сверяются с родными реализациями Node, замена libsodium — с libsodium.js
 * через эталонный мост (тот же контракт __host, что у приложения на Kotlin), логика часов — на настоящем
 * сервере в памяти вместе со «вторым устройством» на ядре.
 */
import sodium from 'libsodium-wrappers-sumo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiClient,
  Doc,
  HybridClock,
  INSECURE_TEST_KDF,
  MemorySyncStore,
  SyncEngine,
  Workspace,
  addDays,
  ensurePersonalSpace,
  initCrypto,
  newNodeId,
  openEnvelope,
  persistLocal,
  sealOp,
  signUp,
  spaceKeys,
  today,
  type Fetcher,
  type Session,
} from '../../../packages/core/src/index.ts';
import { createApp } from '../../server/src/app.ts';
import { testConfig } from '../../server/src/config.ts';
import { openDb } from '../../server/src/db.ts';
import type { Host } from '../js/host.ts';
import { fromHex, toHex } from '../js/host.ts';
import { testing } from '../js/polyfills.ts';
import shim from '../js/sodium.ts';
import { createWear, watchServer, type SessionFile, type Snapshot } from '../js/wear.ts';

await initCrypto();

const SERVER = 'http://dela.test';
const EMAIL = 'watch@example.com';
const PASSWORD = 'пароль часов';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Эталонная реализация моста на libsodium.js: приложение на Kotlin делает то же на lazysodium. */
function referenceHost(): Host {
  const s = sodium;
  const tryHex = (f: () => Uint8Array): string | null => {
    try {
      return toHex(f());
    } catch {
      return null;
    }
  };
  let session: string | null = null;
  return {
    http: () => {
      throw new Error('not used in Node');
    },
    randomHex: (n) => toHex(s.randombytes_buf(n)),
    zone: (ms, tz) => {
      try {
        const p: Record<string, string> = {};
        const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
      } catch {
        return null;
      }
    },
    defaultZone: () => TZ,
    log: () => undefined,
    pwhash: (len, pw, salt, ops, mem, alg) => toHex(s.crypto_pwhash(len, fromHex(pw), fromHex(salt), ops, mem, alg)),
    kdf: (len, id, ctx, key) => toHex(s.crypto_kdf_derive_from_key(len, id, ctx, fromHex(key))),
    aeadEncrypt: (m, ad, n, k) => toHex(s.crypto_aead_xchacha20poly1305_ietf_encrypt(fromHex(m), ad ? fromHex(ad) : null, null, fromHex(n), fromHex(k))),
    aeadDecrypt: (c, ad, n, k) => tryHex(() => s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromHex(c), ad ? fromHex(ad) : null, fromHex(n), fromHex(k))),
    generichash: (len, m, key) => toHex(s.crypto_generichash(len, fromHex(m), key ? fromHex(key) : null)),
    scalarmultBase: (sk) => toHex(s.crypto_scalarmult_base(fromHex(sk))),
    boxKeypair: () => {
      const p = s.crypto_box_keypair();
      return `${toHex(p.publicKey)}:${toHex(p.privateKey)}`;
    },
    boxSeal: (m, pk) => toHex(s.crypto_box_seal(fromHex(m), fromHex(pk))),
    boxSealOpen: (c, pk, sk) => tryHex(() => s.crypto_box_seal_open(fromHex(c), fromHex(pk), fromHex(sk))),
    boxEasy: (m, n, pk, sk) => toHex(s.crypto_box_easy(fromHex(m), fromHex(n), fromHex(pk), fromHex(sk))),
    boxOpenEasy: (c, n, pk, sk) => tryHex(() => s.crypto_box_open_easy(fromHex(c), fromHex(n), fromHex(pk), fromHex(sk))),
    signSeedKeypair: (seed) => {
      const p = s.crypto_sign_seed_keypair(fromHex(seed));
      return `${toHex(p.publicKey)}:${toHex(p.privateKey)}`;
    },
    signDetached: (m, sk) => toHex(s.crypto_sign_detached(fromHex(m), fromHex(sk))),
    signVerifyDetached: (sig, m, pk) => s.crypto_sign_verify_detached(fromHex(sig), fromHex(m), fromHex(pk)),
    vaultExists: () => session !== null,
    vaultRead: () => session,
    vaultWrite: (json) => {
      session = json;
    },
    vaultRemove: () => {
      session = null;
    },
    deviceName: () => 'Dela · Wear OS · test',
  };
}

const g = globalThis as { __host?: Host };
beforeAll(() => {
  g.__host = referenceHost();
});
afterAll(() => {
  delete g.__host;
});

describe('заплатки QuickJS', () => {
  it('TextEncoder и TextDecoder совпадают с родными', () => {
    const enc = new testing.Utf8Encoder();
    const dec = new testing.Utf8Decoder('utf-8', { fatal: true });
    for (const s of ['', 'abc', 'Купить хлеб', 'ёЁ', '😀 emoji 👍🏽', '\u0000\u007f\u0080߿ࠀ￿', '中文']) {
      const native = new TextEncoder().encode(s);
      expect(enc.encode(s)).toEqual(native);
      expect(dec.decode(native)).toBe(s);
    }
    expect(enc.encode('\ud800x')).toEqual(new TextEncoder().encode('\ud800x'));
    for (const bad of [[0xff], [0xc0, 0x80], [0xe0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xd0]]) {
      expect(() => dec.decode(new Uint8Array(bad))).toThrow(TypeError);
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bad))).toThrow(TypeError);
    }
  });

  it('Intl.DateTimeFormat даёт те же части, что родной, и проверяет пояс', () => {
    const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' } as const;
    const DTF = testing.DateTimeFormat as unknown as (l?: string, o?: { timeZone?: string }) => Intl.DateTimeFormat;
    for (const tz of ['Europe/Moscow', 'Asia/Novosibirsk', 'America/New_York', 'UTC', 'Australia/Lord_Howe']) {
      for (const ms of [0, Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 9, 25, 1, 15, 7), Date.now()]) {
        const want = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).formatToParts(new Date(ms)).filter((p) => p.type !== 'literal');
        const got = DTF('en-US', { timeZone: tz }).formatToParts(new Date(ms)).filter((p) => p.type !== 'literal');
        expect(got).toEqual(want);
      }
    }
    // Вызов без new, как в doc.ts.
    expect(DTF().resolvedOptions().timeZone).toBe(TZ);
    expect(() => DTF('en-US', { timeZone: 'Mars/Olympus' })).toThrow(RangeError);
  });

  it('URL и адрес сервера', () => {
    const u = new testing.MiniUrl('HTTPS://Dela.Example.com:8443/x/');
    expect(u.origin).toBe('https://dela.example.com:8443');
    expect(u.pathname).toBe('/x/');
    expect(() => new testing.MiniUrl('ftp://x')).toThrow(TypeError);
    expect(watchServer('dela.example.com/')).toBe('https://dela.example.com');
    expect(watchServer('http://10.0.2.2:8795')).toBe('http://10.0.2.2:8795');
    expect(watchServer('http://dela.example.com')).toBeNull();
    expect(watchServer('  ')).toBeNull();
  });
});

describe('замена libsodium', () => {
  it('base64, pad и unpad как в libsodium.js', () => {
    for (let n = 0; n < 140; n++) {
      const b = sodium.randombytes_buf(n);
      expect(shim.to_base64(b, shim.base64_variants.ORIGINAL)).toBe(sodium.to_base64(b, sodium.base64_variants.ORIGINAL));
      expect(shim.from_base64(sodium.to_base64(b, sodium.base64_variants.ORIGINAL), shim.base64_variants.ORIGINAL)).toEqual(b);
      expect(shim.pad(b, 64)).toEqual(sodium.pad(b, 64));
      expect(shim.unpad(sodium.pad(b, 64), 64)).toEqual(b);
    }
    expect(() => shim.from_base64('abc', shim.base64_variants.ORIGINAL)).toThrow();
    expect(() => shim.unpad(new Uint8Array(64), 64)).toThrow();
  });

  it('примитивы через мост совпадают с libsodium.js', () => {
    const key = sodium.randombytes_buf(32);
    const salt = sodium.randombytes_buf(16);
    expect(shim.crypto_pwhash(32, 'пароль'.normalize('NFKC'), salt, 1, 8192, 2)).toEqual(sodium.crypto_pwhash(32, 'пароль', salt, 1, 8192, 2));
    expect(shim.crypto_kdf_derive_from_key(32, 2, 'dela_pwd', key)).toEqual(sodium.crypto_kdf_derive_from_key(32, 2, 'dela_pwd', key));
    expect(shim.crypto_generichash(16, 'x', key)).toEqual(sodium.crypto_generichash(16, 'x', key));
    expect(shim.crypto_generichash(30, new Uint8Array([1, 2]), null)).toEqual(sodium.crypto_generichash(30, new Uint8Array([1, 2]), null));
    // Шифротекст моста открывает libsodium.js и наоборот; чужой ключ — исключение, как у libsodium.js.
    const nonce = sodium.randombytes_buf(24);
    const ad = new TextEncoder().encode('ad');
    const ct = shim.crypto_aead_xchacha20poly1305_ietf_encrypt(new TextEncoder().encode('hello'), ad, null, nonce, key);
    expect(sodium.to_string(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, ad, nonce, key))).toBe('hello');
    expect(() => shim.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, ad, nonce, sodium.randombytes_buf(32))).toThrow();
    const pair = sodium.crypto_box_keypair();
    expect(shim.crypto_scalarmult_base(pair.privateKey)).toEqual(pair.publicKey);
    expect(shim.crypto_box_seal_open(sodium.crypto_box_seal(key, pair.publicKey), pair.publicKey, pair.privateKey)).toEqual(key);
    const other = sodium.crypto_box_keypair();
    const boxed = sodium.crypto_box_easy(key, nonce, pair.publicKey, other.privateKey);
    expect(shim.crypto_box_open_easy(boxed, nonce, other.publicKey, pair.privateKey)).toEqual(key);
    expect(() => shim.crypto_box_open_easy(boxed, nonce, pair.publicKey, pair.privateKey)).toThrow();
    const seed = sodium.randombytes_buf(32);
    expect(shim.crypto_sign_seed_keypair(seed).publicKey).toEqual(sodium.crypto_sign_seed_keypair(seed).publicKey);
  });

  it('операции, запечатанные ядром, открываются через мост и наоборот', () => {
    const keys = spaceKeys(sodium.randombytes_buf(32));
    const op = { table: 'task', record: 'r1', field: 'title', value: 'Купить хлеб 🍞', hlc: `${String(Date.now()).padStart(15, '0')}-0000-0123456789abcdef` };
    const env = sealOp('space', keys, op);
    // Разбор конверта на стороне часов: те же шаги, что openEnvelope, но примитивы из моста.
    const raw = shim.from_base64(env.payload, shim.base64_variants.ORIGINAL);
    const ad = new TextEncoder().encode(`dela/op/v1\nspace\n${env.slot}\n${env.hlc}`);
    const plain = shim.crypto_aead_xchacha20poly1305_ietf_decrypt(null, raw.subarray(24), ad, raw.subarray(0, 24), keys.enc);
    expect(JSON.parse(new testing.Utf8Decoder('utf-8', { fatal: true }).decode(shim.unpad(plain, 64)))).toEqual({ t: 'task', r: 'r1', f: 'title', v: op.value });
    expect(openEnvelope('space', keys, env)).toEqual(op);
  });
});

/** Второе устройство пользователя на ядре: телефон. */
async function phone(fetcher: Fetcher, session: Session) {
  const api = new ApiClient(SERVER, fetcher);
  api.token = session.token;
  const { spaceId, spaceKey } = await ensurePersonalSpace(api, session.keys);
  const doc = new Doc({ spaceId, clock: new HybridClock(newNodeId()) });
  const store = new MemorySyncStore();
  const engine = new SyncEngine({ api, store, doc, spaceId, keys: spaceKeys(spaceKey) });
  persistLocal(doc, store, spaceId);
  const ws = new Workspace(doc);
  const sync = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await engine.sync();
  };
  return { api, ws, sync };
}

function memoryFile(): SessionFile & { data: string | null } {
  const f = {
    data: null as string | null,
    exists: () => f.data !== null,
    read: () => f.data,
    write: (json: string) => {
      f.data = json;
    },
    remove: () => {
      f.data = null;
    },
  };
  return f;
}

describe('часы на сервере', () => {
  it('вход, «Сегодня», напоминания, выполнение и выход', async () => {
    const { app } = createApp(openDb(':memory:'), testConfig({ openRegistration: true }));
    const fetcher: Fetcher = async (input, init) => app.fetch(new Request(input, init));
    const { session } = await signUp(new ApiClient(SERVER, fetcher), { email: EMAIL, password: PASSWORD, deviceName: 'Телефон', kdf: INSECURE_TEST_KDF });
    const p = await phone(fetcher, session);
    const date = today(TZ);
    const later = new Date(Date.now() + 3 * 3600_000);
    const laterDate = today(TZ, later.getTime());
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(later);
    const call1 = p.ws.createTask({ title: 'Позвонить маме', due: { date }, priority: 1 });
    const late = p.ws.createTask({ title: 'Вчерашнее', due: { date: addDays(date, -1) } });
    const daily = p.ws.createTask({ title: 'Полить цветы', due: { date }, recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' } });
    const timed = p.ws.createTask({ title: 'Созвон', due: { date: laterDate, time: hhmm } });
    p.ws.createTask({ title: 'Через неделю', due: { date: addDays(date, 7) } });
    await p.sync();

    const file = memoryFile();
    const wear = createWear({ file, deviceName: 'Dela · Wear OS · test', fetcher });
    expect(await wear.call('status')).toEqual({ signedIn: false });
    expect(await wear.call('login', { server: 'http://dela.example.com', email: EMAIL, password: PASSWORD })).toEqual({ error: 'bad_server' });
    expect((await wear.call('login', { server: SERVER.replace('http', 'https'), email: EMAIL, password: 'не тот' })).error).toBe('invalid_credentials');

    const snap = (await wear.call('login', { server: 'dela.test', email: EMAIL.toUpperCase(), password: PASSWORD })) as unknown as Snapshot;
    expect(snap.signedIn).toBe(true);
    expect(snap.date).toBe(date);
    expect(snap.overdue.map((t) => t.title)).toEqual(['Вчерашнее']);
    expect(snap.today.map((t) => t.title).sort()).toEqual(laterDate === date ? ['Позвонить маме', 'Полить цветы', 'Созвон'] : ['Позвонить маме', 'Полить цветы']);
    expect(snap.today.find((t) => t.id === daily)).toMatchObject({ recurring: true, inbox: true, project: null, readOnly: false });
    expect(snap.reminders.map((r) => r.taskId)).toEqual([timed]);
    expect(Math.abs(snap.reminders[0]!.at - later.getTime())).toBeLessThan(60_000);
    // Ключи и токен в файле сессии лежат у приложения, которое шифрует его ключом Keystore.
    expect(file.data).toContain('masterKey');
    expect((await p.api.devices()).devices.map((d) => d.name)).toContain('Dela · Wear OS · test');

    // Выполнение: обычная задача закрывается, повторяющаяся переносится на завтра; телефон это видит.
    const after1 = (await wear.call('complete', { id: call1 })) as unknown as Snapshot;
    expect(after1.today.map((t) => t.id)).not.toContain(call1);
    expect(after1.pending).toBe(0);
    const after2 = (await wear.call('complete', { id: daily })) as unknown as Snapshot;
    expect(after2.today.map((t) => t.id)).not.toContain(daily);
    await p.sync();
    expect(p.ws.task(call1)?.completedAt).not.toBeNull();
    expect(p.ws.task(daily)?.due?.date).toBe(addDays(date, 1));
    expect(p.ws.task(daily)?.completedAt).toBeNull();
    expect(p.ws.completions(daily).map((c) => c.occurrence)).toEqual([date]);
    expect((await wear.call('complete', { id: 'нет такой' })).error).toBe('not_found');

    // Изменение с телефона приходит на часы при синхронизации.
    p.ws.completeTask(late);
    await p.sync();
    expect(((await wear.call('sync')) as unknown as Snapshot).overdue).toEqual([]);

    // Новый запуск движка с тем же файлом: «Сегодня» из кэша без сети.
    const offline = createWear({ file, deviceName: 'x', fetcher: async () => Promise.reject(new TypeError('offline')) });
    const cached = (await offline.call('today')) as unknown as Snapshot;
    expect(cached.email).toBe(EMAIL);
    expect(cached.today.map((t) => t.id)).not.toContain(call1);
    const off = (await offline.call('sync')) as unknown as Snapshot;
    expect(off.offline).toBe(true);

    // Выход отзывает устройство и стирает файл.
    expect(await wear.call('logout')).toEqual({ signedIn: false });
    expect(file.data).toBeNull();
    expect((await p.api.devices()).devices.map((d) => d.name)).not.toContain('Dela · Wear OS · test');
    expect((await wear.call('today')).error).toBe('signed_out');
  });

  it('отозванное с телефона устройство выходит само', async () => {
    const { app } = createApp(openDb(':memory:'), testConfig({ openRegistration: true }));
    const fetcher: Fetcher = async (input, init) => app.fetch(new Request(input, init));
    const { session } = await signUp(new ApiClient(SERVER, fetcher), { email: EMAIL, password: PASSWORD, deviceName: 'Телефон', kdf: INSECURE_TEST_KDF });
    const p = await phone(fetcher, session);
    const file = memoryFile();
    const wear = createWear({ file, deviceName: 'Часы', fetcher });
    await wear.call('login', { server: SERVER.replace('http', 'https'), email: EMAIL, password: PASSWORD });
    const watch = (await p.api.devices()).devices.find((d) => d.name === 'Часы')!;
    await p.api.revokeDevice(watch.id);
    expect((await wear.call('sync')).error).toBe('signed_out');
    expect(file.data).toBeNull();
    expect(await wear.call('status')).toEqual({ signedIn: false });
  });
});
