import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  INSECURE_TEST_KDF,
  createAccount,
  derivePasswordKeys,
  fromB64,
  formatTimestamp,
  initCrypto,
  newKey,
  openAccount,
  openEnvelope,
  sealOp,
  spaceKeys,
  toB64,
  unwrapSpaceKey,
  uuidv7,
  wrapSpaceKey,
  changePassword,
  type AccountBundle,
} from '#core';
import { createApp } from '../src/app.ts';
import { testConfig, type Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';

await initCrypto();

const NOW = 1_760_000_000_000;

function makeServer(overrides: Partial<Config> = {}) {
  let time = NOW;
  const db = openDb(':memory:');
  const server = createApp(db, testConfig(overrides), () => time);
  async function call(method: string, path: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await server.app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any };
  }
  return { ...server, db, call, advance: (ms: number) => (time += ms) };
}

async function register(s: ReturnType<typeof makeServer>, email: string, password: string, invite?: string) {
  const acc = createAccount(password, INSECURE_TEST_KDF);
  const res = await s.call('POST', '/api/auth/register', {
    email,
    authSecret: toB64(acc.authSecret),
    recoveryAuth: toB64(acc.recoveryAuth),
    bundle: acc.bundle,
    deviceName: 'Ноутбук',
    ...(invite ? { invite } : {}),
  });
  return { acc, res };
}

const ts = (wall: number, node = '00000000000000aa') => formatTimestamp({ wall, counter: 0, node });

describe('вход', () => {
  it('регистрация, prelogin, вход со второго устройства и расшифровка ключей', async () => {
    const s = makeServer();
    const { acc, res } = await register(s, 'Egor@Example.com', 'пароль');
    expect(res.status).toBe(201);
    expect(res.json.isAdmin).toBe(true);

    const pre = await s.call('POST', '/api/auth/prelogin', { email: 'egor@example.com' });
    expect(pre.json).toEqual({ kdf: acc.bundle.kdf, salt: acc.bundle.salt });

    const { authSecret, kek } = derivePasswordKeys('пароль', fromB64(pre.json.salt), pre.json.kdf);
    const login = await s.call('POST', '/api/auth/login', {
      email: 'EGOR@example.com',
      authSecret: toB64(authSecret),
      deviceName: 'Телефон',
    });
    expect(login.status).toBe(200);
    expect(openAccount(login.json.bundle as AccountBundle, kek)).toEqual(acc.keys);

    const devices = await s.call('GET', '/api/devices', undefined, login.json.token);
    expect(devices.json.devices.map((d: any) => d.name)).toEqual(['Ноутбук', 'Телефон']);
  });

  it('неверный пароль и несуществующий адрес выглядят одинаково', async () => {
    const s = makeServer();
    await register(s, 'a@b.cd', 'верный');
    const pre = await s.call('POST', '/api/auth/prelogin', { email: 'a@b.cd' });
    const wrong = derivePasswordKeys('неверный', fromB64(pre.json.salt), pre.json.kdf);
    const r1 = await s.call('POST', '/api/auth/login', { email: 'a@b.cd', authSecret: toB64(wrong.authSecret), deviceName: 'x' });
    const r2 = await s.call('POST', '/api/auth/login', { email: 'no@b.cd', authSecret: toB64(wrong.authSecret), deviceName: 'x' });
    expect(r1).toEqual({ status: 401, json: { error: 'invalid_credentials' } });
    expect(r2).toEqual(r1);

    const fake1 = await s.call('POST', '/api/auth/prelogin', { email: 'no@b.cd' });
    const fake2 = await s.call('POST', '/api/auth/prelogin', { email: 'no@b.cd' });
    expect(fake1.json).toEqual(fake2.json);
    expect(fromB64(fake1.json.salt)).toHaveLength(16);
  });

  it('ограничивает частоту попыток входа', async () => {
    const s = makeServer();
    const body = { email: 'x@y.zz', authSecret: toB64(new Uint8Array(32)), deviceName: 'x' };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await s.call('POST', '/api/auth/login', body)).status);
    expect(statuses.slice(0, 10).every((x) => x === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    s.advance(16 * 60_000);
    expect((await s.call('POST', '/api/auth/login', body)).status).toBe(401);
  });

  it('после первого пользователя регистрация только по приглашению', async () => {
    const s = makeServer();
    const admin = await register(s, 'admin@x.yz', 'p');
    expect((await register(s, 'guest@x.yz', 'p')).res).toEqual({ status: 403, json: { error: 'invite_required' } });
    expect((await register(s, 'guest@x.yz', 'p', 'wrong-code')).res.status).toBe(403);

    const inv = await s.call('POST', '/api/invites', {}, admin.res.json.token);
    expect(inv.status).toBe(201);
    const guest = await register(s, 'guest@x.yz', 'p', inv.json.code);
    expect(guest.res.status).toBe(201);
    expect(guest.res.json.isAdmin).toBe(false);
    expect((await register(s, 'other@x.yz', 'p', inv.json.code)).res.json.error).toBe('invalid_invite');
    expect((await s.call('POST', '/api/invites', {}, guest.res.json.token)).status).toBe(403);
  });

  it('открытая регистрация и занятый адрес', async () => {
    const s = makeServer({ openRegistration: true });
    await register(s, 'a@x.yz', 'p');
    expect((await register(s, 'b@x.yz', 'p')).res.status).toBe(201);
    expect((await register(s, 'B@x.yz', 'p')).res).toEqual({ status: 409, json: { error: 'email_taken' } });
  });

  it('отзыв устройства и выход закрывают сессию', async () => {
    const s = makeServer();
    const { res } = await register(s, 'a@x.yz', 'p');
    const token = res.json.token;
    expect((await s.call('GET', '/api/account', undefined, token)).status).toBe(200);
    expect((await s.call('DELETE', `/api/devices/${res.json.deviceId}`, undefined, token)).status).toBe(200);
    expect((await s.call('GET', '/api/account', undefined, token)).status).toBe(401);
  });

  it('смена пароля: старые сессии других устройств закрываются, новый пароль работает', async () => {
    const s = makeServer();
    const { acc, res } = await register(s, 'a@x.yz', 'старый');
    const other = await s.call('POST', '/api/auth/login', { email: 'a@x.yz', authSecret: toB64(acc.authSecret), deviceName: 'B' });
    const changed = changePassword(acc.bundle, acc.keys, 'новый', INSECURE_TEST_KDF);
    const r = await s.call(
      'PUT',
      '/api/account/password',
      { authSecret: toB64(acc.authSecret), newAuthSecret: toB64(changed.authSecret), bundle: changed.bundle },
      res.json.token,
    );
    expect(r.status).toBe(200);
    expect((await s.call('GET', '/api/account', undefined, res.json.token)).status).toBe(200);
    expect((await s.call('GET', '/api/account', undefined, other.json.token)).status).toBe(401);
    const login = await s.call('POST', '/api/auth/login', { email: 'a@x.yz', authSecret: toB64(changed.authSecret), deviceName: 'C' });
    expect(login.status).toBe(200);
  });

  it('отклоняет неверные данные и запросы без токена', async () => {
    const s = makeServer();
    expect((await s.call('GET', '/api/account')).status).toBe(401);
    expect((await s.call('GET', '/api/account', undefined, 'x'.repeat(43))).status).toBe(401);
    expect((await s.call('POST', '/api/auth/prelogin', { email: 'not-an-email' })).status).toBe(400);
    const acc = createAccount('p', INSECURE_TEST_KDF);
    const r = await s.call('POST', '/api/auth/register', {
      email: 'a@x.yz',
      authSecret: toB64(new Uint8Array(31)),
      bundle: acc.bundle,
      deviceName: 'x',
    });
    expect(r.status).toBe(400);
    const r2 = await s.call('POST', '/api/auth/register', {
      email: 'a@x.yz',
      authSecret: toB64(acc.authSecret),
      recoveryAuth: toB64(acc.recoveryAuth),
      bundle: { ...acc.bundle, kdf: { alg: 'md5', ops: 1, mem: 1 } },
      deviceName: 'x',
    });
    expect(r2.status).toBe(400);
  });
});

describe('синхронизация через API', () => {
  async function withSpace(overrides: Partial<Config> = {}) {
    const s = makeServer(overrides);
    const { acc, res } = await register(s, 'a@x.yz', 'p');
    const token = res.json.token as string;
    const spaceId = uuidv7(NOW);
    const spaceKey = newKey();
    const created = await s.call('POST', '/api/spaces', { id: spaceId, key: wrapSpaceKey(spaceKey, acc.keys.masterKey, spaceId) }, token);
    expect(created.status).toBe(201);
    return { s, acc, token, spaceId, spaceKey };
  }

  it('второе устройство получает ключ пространства и расшифровывает операции', async () => {
    const { s, acc, token, spaceId, spaceKey } = await withSpace();
    const keys = spaceKeys(spaceKey);
    const ops = [
      { table: 'task', record: uuidv7(NOW), field: 'title', value: 'Купить хлеб', hlc: ts(NOW) },
      { table: 'task', record: uuidv7(NOW), field: 'title', value: 'Позвонить маме', hlc: ts(NOW + 1) },
    ];
    const push = await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: ops.map((op) => sealOp(spaceId, keys, op)) }, token);
    expect(push.json).toMatchObject({ accepted: 2, seq: 2 });

    const login = await s.call('POST', '/api/auth/login', { email: 'a@x.yz', authSecret: toB64(acc.authSecret), deviceName: 'Телефон' });
    const t2 = login.json.token;
    const spaces = await s.call('GET', '/api/spaces', undefined, t2);
    expect(spaces.json.spaces).toHaveLength(1);
    const sk = unwrapSpaceKey(spaces.json.spaces[0].key, acc.keys.masterKey, spaceId);
    const pulled = await s.call('GET', `/api/spaces/${spaceId}/pull?since=0&limit=1`, undefined, t2);
    expect(pulled.json.more).toBe(true);
    const rest = await s.call('GET', `/api/spaces/${spaceId}/pull?since=${pulled.json.cursor}`, undefined, t2);
    const all = [...pulled.json.envelopes, ...rest.json.envelopes].map((e: any) => openEnvelope(spaceId, spaceKeys(sk), e));
    expect(all).toEqual(ops);

    // Повторная отправка ничего не меняет.
    const again = await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: ops.map((op) => sealOp(spaceId, keys, op)) }, token);
    expect(again.json.accepted).toBe(0);
  });

  it('метки из будущего отклоняются с временем сервера', async () => {
    const { s, token, spaceId, spaceKey } = await withSpace();
    const op = { table: 'task', record: 'r', field: 'title', value: 'x', hlc: ts(NOW + 120_000) };
    const r = await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: [sealOp(spaceId, spaceKeys(spaceKey), op)] }, token);
    expect(r).toEqual({ status: 409, json: { error: 'clock_drift', serverTime: NOW } });
  });

  it('чужое пространство неотличимо от несуществующего', async () => {
    const { s, spaceId } = await withSpace({ openRegistration: true });
    const other = await register(s, 'b@x.yz', 'p');
    const t = other.res.json.token;
    const foreign = await s.call('GET', `/api/spaces/${spaceId}/pull`, undefined, t);
    const missing = await s.call('GET', `/api/spaces/${uuidv7(NOW)}/pull`, undefined, t);
    expect(foreign).toEqual({ status: 404, json: { error: 'not_found' } });
    expect(missing).toEqual(foreign);
    expect((await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: [] }, t)).status).toBe(404);
    expect((await s.call('GET', '/api/spaces', undefined, t)).json.spaces).toEqual([]);
  });

  it('проверяет конверты', async () => {
    const { s, token, spaceId } = await withSpace();
    const push = (envelopes: unknown) => s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes }, token);
    expect((await push('x')).status).toBe(400);
    expect((await push([{ slot: 'zz', hlc: ts(NOW), payload: 'AAAA' }])).status).toBe(400);
    expect((await push([{ slot: '0'.repeat(32), hlc: 'bad', payload: 'AAAA' }])).status).toBe(400);
    expect((await push([{ slot: '0'.repeat(32), hlc: ts(NOW), payload: '***' }])).status).toBe(400);
    expect((await push(Array.from({ length: 1001 }, () => ({ slot: '0'.repeat(32), hlc: ts(NOW), payload: 'AAAA' })))).status).toBe(400);
    expect((await s.call('GET', `/api/spaces/${spaceId}/pull?limit=5000`, undefined, token)).status).toBe(400);
    expect((await s.call('GET', '/api/spaces/not-a-uuid/pull', undefined, token)).status).toBe(404);
  });
});

describe('WebSocket', () => {
  it('после отправки другое устройство получает сигнал', async () => {
    const db = openDb(':memory:');
    const { app, injectWebSocket } = createApp(db, testConfig());
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    injectWebSocket(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = async (path: string, body: unknown, token?: string) => {
        const res = await fetch(`http://${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        });
        return (await res.json()) as any;
      };
      const acc = createAccount('p', INSECURE_TEST_KDF);
      const reg = await post('/api/auth/register', { email: 'a@x.yz', authSecret: toB64(acc.authSecret), recoveryAuth: toB64(acc.recoveryAuth), bundle: acc.bundle, deviceName: 'A' });
      const spaceId = uuidv7();
      const spaceKey = newKey();
      await post('/api/spaces', { id: spaceId, key: wrapSpaceKey(spaceKey, acc.keys.masterKey, spaceId) }, reg.token);

      const ws = new WebSocket(`ws://${base}/api/ws`);
      const messages: any[] = [];
      const ready = new Promise<void>((resolve) => {
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(String(e.data));
          messages.push(m);
          if (m.type === 'ready') resolve();
        });
      });
      await new Promise<void>((r) => ws.addEventListener('open', () => r()));
      ws.send(JSON.stringify({ type: 'auth', token: reg.token }));
      await ready;

      const op = { table: 'task', record: 'r', field: 'title', value: 'x', hlc: ts(Date.now()) };
      await post(`/api/spaces/${spaceId}/push`, { envelopes: [sealOp(spaceId, spaceKeys(spaceKey), op)] }, reg.token);
      await expect.poll(() => messages.find((m) => m.type === 'changed')).toEqual({ type: 'changed', space: spaceId, seq: 1 });

      const bad = new WebSocket(`ws://${base}/api/ws`);
      const closed = new Promise<number>((r) => bad.addEventListener('close', (e) => r(e.code)));
      await new Promise<void>((r) => bad.addEventListener('open', () => r()));
      bad.send(JSON.stringify({ type: 'auth', token: 'nope' }));
      expect(await closed).toBe(4001);
      ws.close();
    } finally {
      server.close();
    }
  });
});

describe('Web Push', () => {
  it('подписка, расписание и отправка наступивших напоминаний', async () => {
    let time = NOW;
    const sent: Array<{ url: string; headers: Record<string, string>; size: number }> = [];
    const fakePush: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), headers: init!.headers as Record<string, string>, size: (init!.body as Uint8Array).length });
      return new Response(null, { status: sent.length === 2 ? 410 : 201 });
    };
    const db = openDb(':memory:');
    const server = createApp(db, testConfig(), () => time, fakePush);
    const call = async (method: string, path: string, body?: unknown, token?: string) => {
      const res = await server.app.request(path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    const acc = createAccount('p', INSECURE_TEST_KDF);
    const reg = await call('POST', '/api/auth/register', {
      email: 'a@x.yz',
      authSecret: toB64(acc.authSecret),
      recoveryAuth: toB64(acc.recoveryAuth),
      bundle: acc.bundle,
      deviceName: 'A',
    });
    const token = reg.json.token;
    expect((await call('GET', '/api/push/key')).json.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

    const ecdh = (await import('node:crypto')).createECDH('prime256v1');
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
    expect((await call('PUT', '/api/push/subscription', { endpoint: 'https://evil.example/x', keys }, token)).status).toBe(400);
    expect((await call('PUT', '/api/push/subscription', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }, token)).status).toBe(200);

    const entries = [
      { id: 'r1', fireAt: NOW + 60_000, payload: toB64(new Uint8Array(40)) },
      { id: 'r2', fireAt: NOW + 120_000, payload: toB64(new Uint8Array(40)) },
      { id: 'r3', fireAt: NOW + 3_600_000, payload: toB64(new Uint8Array(40)) },
    ];
    expect((await call('PUT', '/api/push/schedule', { entries }, token)).json).toEqual({ ok: true, count: 3 });
    expect((await call('PUT', '/api/push/schedule', { entries: [{ id: 'x', fireAt: NOW + 40 * 24 * 3600_000, payload: 'AAAA' }] }, token)).status).toBe(400);

    expect(await server.pushTick()).toEqual({ sent: 0, gone: 0, failed: 0 });
    time = NOW + 61_000;
    expect(await server.pushTick()).toEqual({ sent: 1, gone: 0, failed: 0 });
    expect(sent[0]).toMatchObject({ url: 'https://fcm.googleapis.com/fcm/send/abc', headers: { 'content-encoding': 'aes128gcm', ttl: '3600' } });
    expect(sent[0]!.headers.authorization).toMatch(/^vapid t=.+, k=.+$/);

    // Push-сервис ответил 410: подписка удалена вместе с расписанием.
    time = NOW + 121_000;
    expect(await server.pushTick()).toEqual({ sent: 0, gone: 1, failed: 0 });
    time = NOW + 3_700_000;
    expect(await server.pushTick()).toEqual({ sent: 0, gone: 0, failed: 0 });
    expect(sent).toHaveLength(2);
  });
});

describe('двухфакторный вход', () => {
  it('включение, вход с кодом, повтор кода и отключение', async () => {
    const { hotp, base32Decode, totpCounter } = await import('../src/totp.ts');
    const s = makeServer();
    const { acc, res } = await register(s, 'a@x.yz', 'p');
    const token = res.json.token;
    // Без пароля включить TOTP нельзя: украденной сессии мало.
    expect((await s.call('POST', '/api/account/totp/setup', {}, token)).status).toBe(400);
    expect((await s.call('POST', '/api/account/totp/setup', { authSecret: toB64(new Uint8Array(32)) }, token)).status).toBe(401);
    const setup = await s.call('POST', '/api/account/totp/setup', { authSecret: toB64(acc.authSecret) }, token);
    expect(setup.json.uri).toMatch(/^otpauth:\/\/totp\//);
    const code = (dt = 0) => hotp(base32Decode(setup.json.secret), totpCounter(NOW + dt));
    expect((await s.call('POST', '/api/account/totp/enable', { code: '000000' }, token)).status).toBe(401);
    expect((await s.call('POST', '/api/account/totp/enable', { code: code() }, token)).status).toBe(200);
    expect((await s.call('GET', '/api/account', undefined, token)).json.totpEnabled).toBe(true);

    const login = (totp?: string) =>
      s.call('POST', '/api/auth/login', { email: 'a@x.yz', authSecret: toB64(acc.authSecret), deviceName: 'B', ...(totp ? { totp } : {}) });
    expect((await login()).json.error).toBe('totp_required');
    // Тот же код второй раз не принимается.
    expect((await login(code())).json.error).toBe('invalid_totp');
    s.advance(30_000);
    expect((await login(code(30_000))).status).toBe(200);

    s.advance(30_000);
    expect((await s.call('POST', '/api/account/totp/disable', { code: code(60_000) }, token)).status).toBe(200);
    expect((await login()).status).toBe(200);
  });
});

describe('защита сервера за прокси', () => {
  it('лимит попыток считается по адресу клиента из X-Forwarded-For', async () => {
    const db = openDb(':memory:');
    const { app } = createApp(db, testConfig({ trustProxy: true }), () => NOW);
    const login = (ip: string) =>
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `6.6.6.6, ${ip}` },
        body: JSON.stringify({ email: `u${ip}@x.yz`, authSecret: toB64(new Uint8Array(32)), deviceName: 'x' }),
      });
    for (let i = 0; i < 60; i++) await login('1.1.1.1');
    expect((await login('1.1.1.1')).status).toBe(429);
    // Другой клиент за тем же прокси не заблокирован.
    expect((await login('2.2.2.2')).status).toBe(401);
  });

  it('первым может зарегистрироваться только адрес администратора', async () => {
    const s = makeServer({ adminEmail: 'owner@x.yz' });
    expect((await register(s, 'stranger@x.yz', 'p')).res).toEqual({ status: 403, json: { error: 'registration_closed' } });
    expect((await register(s, 'owner@x.yz', 'p')).res.status).toBe(201);
  });

  it('ответы API не кэшируются, у пространства есть предел записей', async () => {
    const s = makeServer({ maxRecordsPerSpace: 2 });
    const { acc, res } = await register(s, 'a@x.yz', 'p');
    const token = res.json.token;
    const health = await s.app.request('/api/health');
    expect(health.headers.get('cache-control')).toBe('no-store');
    const spaceId = uuidv7(NOW);
    await s.call('POST', '/api/spaces', { id: spaceId, key: wrapSpaceKey(newKey(), acc.keys.masterKey, spaceId) }, token);
    const env = (i: number) => ({ slot: i.toString(16).padStart(32, '0'), hlc: ts(NOW), payload: 'AAAA' });
    expect((await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: [env(1), env(2)] }, token)).status).toBe(200);
    expect((await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: [env(3)] }, token))).toEqual({ status: 413, json: { error: 'space_full' } });
  });
});

describe('удаление аккаунта', () => {
  it('нужен пароль; аккаунт, личное пространство и сессии исчезают, общий проект переходит участнику', async () => {
    const s = makeServer({ openRegistration: true });
    const a = await register(s, 'a@x.yz', 'пароль-а');
    const b = await register(s, 'b@x.yz', 'пароль-б');
    const ta = a.res.json.token as string;
    const tb = b.res.json.token as string;
    const keysA = openAccount(a.acc.bundle, derivePasswordKeys('пароль-а', fromB64(a.acc.bundle.salt), a.acc.bundle.kdf).kek);
    const personal = uuidv7();
    const shared = uuidv7();
    const lonely = uuidv7();
    await s.call('POST', '/api/spaces', { id: personal, key: wrapSpaceKey(newKey(), keysA.masterKey, personal) }, ta);
    await s.call('POST', '/api/spaces', { id: shared, kind: 'shared', key: wrapSpaceKey(newKey(), keysA.masterKey, shared) }, ta);
    await s.call('POST', '/api/spaces', { id: lonely, kind: 'shared', key: wrapSpaceKey(newKey(), keysA.masterKey, lonely) }, ta);
    expect((await s.call('POST', `/api/spaces/${shared}/members`, { userId: b.res.json.userId, key: toB64(newKey()) }, ta)).status).toBe(201);

    const wrong = derivePasswordKeys('не тот', fromB64(a.acc.bundle.salt), a.acc.bundle.kdf).authSecret;
    expect((await s.call('POST', '/api/account/delete', { authSecret: toB64(wrong) }, ta)).status).toBe(401);
    expect((await s.call('POST', '/api/account/delete', { authSecret: toB64(a.acc.authSecret) }, ta)).json).toEqual({ ok: true });

    // Токен больше не действует, войти нельзя.
    expect((await s.call('GET', '/api/account', undefined, ta)).status).toBe(401);
    const login = await s.call('POST', '/api/auth/login', { email: 'a@x.yz', authSecret: toB64(a.acc.authSecret), deviceName: 'x' });
    expect(login.status).toBe(401);
    // Личное пространство и проект без участников удалены, общий проект у B, B теперь владелец и администратор.
    expect(s.db.prepare('SELECT id FROM spaces ORDER BY id').all().map((r: any) => r.id)).toEqual([shared]);
    const spacesB = (await s.call('GET', '/api/spaces', undefined, tb)).json.spaces;
    expect(spacesB).toMatchObject([{ id: shared, role: 'owner' }]);
    expect((await s.call('GET', '/api/account', undefined, tb)).json.isAdmin).toBe(true);
  });

  it('с включённым TOTP нужен код', async () => {
    const s = makeServer();
    const a = await register(s, 'a@x.yz', 'пароль');
    const t = a.res.json.token as string;
    s.db.prepare("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_enabled = 1").run();
    const r = await s.call('POST', '/api/account/delete', { authSecret: toB64(a.acc.authSecret) }, t);
    expect(r).toEqual({ status: 401, json: { error: 'totp_required' } });
    expect((await s.call('POST', '/api/account/delete', { authSecret: toB64(a.acc.authSecret), totp: '000000' }, t)).json.error).toBe('invalid_totp');
  });
});

describe('новый ключ общего проекта', () => {
  it('после удаления участника владелец перешифровывает проект; старый ключ больше не принимается', async () => {
    const s = makeServer({ openRegistration: true });
    const a = await register(s, 'a@x.yz', 'пароль-а');
    const b = await register(s, 'b@x.yz', 'пароль-б');
    const c = await register(s, 'c@x.yz', 'пароль-в');
    const [ta, tb] = [a.res.json.token as string, b.res.json.token as string];
    const spaceId = uuidv7(NOW);
    const k1 = newKey();
    await s.call('POST', '/api/spaces', { id: spaceId, kind: 'shared', key: wrapSpaceKey(k1, a.acc.keys.masterKey, spaceId) }, ta);
    for (const m of [b, c]) await s.call('POST', `/api/spaces/${spaceId}/members`, { userId: m.res.json.userId, key: toB64(newKey()) }, ta);
    const op = { table: 'task', record: uuidv7(NOW), field: 'title', value: 'Секрет', hlc: ts(NOW) };
    expect((await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: [sealOp(spaceId, spaceKeys(k1), op)] }, tb)).json.accepted).toBe(1);
    expect((await s.call('DELETE', `/api/spaces/${spaceId}/members/${c.res.json.userId}`, undefined, ta)).status).toBe(200);

    const k2 = newKey();
    const keys = [
      { userId: a.res.json.userId, key: wrapSpaceKey(k2, a.acc.keys.masterKey, spaceId) },
      { userId: b.res.json.userId, key: toB64(newKey()) },
    ];
    const rotate = async (token: string, baseSeq: number, ks = keys) => {
      const begin = await s.call('POST', `/api/spaces/${spaceId}/rotate/begin`, { keyVersion: 2 }, token);
      if (begin.status !== 201) return begin;
      const rid = begin.json.rotationId as string;
      await s.call('POST', `/api/spaces/${spaceId}/rotate/${rid}/envelopes`, { envelopes: [sealOp(spaceId, spaceKeys(k2), op)] }, token);
      return s.call('POST', `/api/spaces/${spaceId}/rotate/${rid}/commit`, { baseSeq, keys: ks }, token);
    };
    // Только владелец; ключи для всех оставшихся; журнал не вырос.
    expect((await rotate(tb, 1)).status).toBe(403);
    expect((await rotate(ta, 1, keys.slice(0, 1))).status).toBe(400);
    expect((await rotate(ta, 0)).json).toEqual({ error: 'stale', lastSeq: 1 });
    // Правка, пришедшая между началом смены и commit, тоже делает смену устаревшей.
    const begin = await s.call('POST', `/api/spaces/${spaceId}/rotate/begin`, { keyVersion: 2 }, ta);
    const late = { ...op, field: 'description', value: 'пока шифровали', hlc: ts(NOW + 2) };
    expect((await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: [sealOp(spaceId, spaceKeys(k1), late)] }, tb)).json.accepted).toBe(1);
    expect((await s.call('POST', `/api/spaces/${spaceId}/rotate/${begin.json.rotationId}/commit`, { baseSeq: 1, keys }, ta)).json).toEqual({ error: 'stale', lastSeq: 2 });
    expect((await rotate(ta, 2)).json).toEqual({ ok: true, keyVersion: 2, seq: 3 });

    // На сервере только новые конверты; их открывает новый ключ.
    const pulled = (await s.call('GET', `/api/spaces/${spaceId}/pull?since=0`, undefined, tb)).json.envelopes;
    expect(pulled).toHaveLength(1);
    expect(openEnvelope(spaceId, spaceKeys(k2), pulled[0])).toEqual(op);
    expect(() => openEnvelope(spaceId, spaceKeys(k1), pulled[0])).toThrow();
    // Устройство со старым ключом получает отказ и версию ключа.
    const later = { ...op, value: 'Новое', hlc: ts(NOW + 5) };
    expect((await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: [sealOp(spaceId, spaceKeys(k1), later)] }, tb)).json).toEqual({
      error: 'key_rotated',
      keyVersion: 2,
    });
    expect((await s.call('POST', `/api/spaces/${spaceId}/push`, { envelopes: [sealOp(spaceId, spaceKeys(k2), later)], keyVersion: 2 }, tb)).json.accepted).toBe(1);
    const listB = (await s.call('GET', '/api/spaces', undefined, tb)).json.spaces;
    expect(listB.find((x: any) => x.id === spaceId)).toMatchObject({ keyVersion: 2, key: keys[1]!.key, keyKind: 'sealed' });
  });
});

describe('файлы', () => {
  it('участник загружает и скачивает шифротекст, чужой не видит, пределы размера', async () => {
    const s = makeServer({ openRegistration: true });
    const a = await register(s, 'a@x.yz', 'пароль-а');
    const b = await register(s, 'b@x.yz', 'пароль-б');
    const ta = a.res.json.token as string;
    const spaceId = uuidv7(NOW);
    await s.call('POST', '/api/spaces', { id: spaceId, key: wrapSpaceKey(newKey(), a.acc.keys.masterKey, spaceId) }, ta);
    const fileId = uuidv7(NOW);
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    const put = (token: string, body: Uint8Array, id = fileId) =>
      s.app.request(`/api/spaces/${spaceId}/files/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: body as BodyInit });
    expect((await put(ta, blob)).status).toBe(201);
    expect((await put(ta, blob)).status).toBe(409);
    const got = await s.app.request(`/api/spaces/${spaceId}/files/${fileId}`, { headers: { authorization: `Bearer ${ta}` } });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(blob);
    const stranger = await s.app.request(`/api/spaces/${spaceId}/files/${fileId}`, { headers: { authorization: `Bearer ${b.res.json.token}` } });
    expect(stranger.status).toBe(404);
    expect((await put(ta, new Uint8Array(7 * 1024 * 1024 + 1), uuidv7(NOW + 1))).status).toBe(413);
    expect((await s.call('DELETE', `/api/spaces/${spaceId}/files/${fileId}`, undefined, ta)).status).toBe(200);
    expect((await s.app.request(`/api/spaces/${spaceId}/files/${fileId}`, { headers: { authorization: `Bearer ${ta}` } })).status).toBe(404);
  });
});

describe('passkey', () => {
  it('добавить passkey можно только с паролем', async () => {
    const s = makeServer();
    const a = await register(s, 'a@x.yz', 'пароль');
    const t = a.res.json.token as string;
    expect((await s.call('POST', '/api/passkeys/register/options', {}, t)).status).toBe(400);
    expect((await s.call('POST', '/api/passkeys/register/options', { authSecret: toB64(new Uint8Array(32)) }, t)).status).toBe(401);
    const ok = await s.call('POST', '/api/passkeys/register/options', { authSecret: toB64(a.acc.authSecret) }, t);
    expect(ok.status).toBe(200);
    expect(ok.json.options.rp).toMatchObject({ id: 'localhost', name: 'Dela' });
  });
});
