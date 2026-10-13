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
      const reg = await post('/api/auth/register', { email: 'a@x.yz', authSecret: toB64(acc.authSecret), bundle: acc.bundle, deviceName: 'A' });
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
