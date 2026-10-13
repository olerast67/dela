/**
 * Сквозной тест ядра и сервера: регистрация, вход со второго устройства, синхронизация
 * через настоящий HTTP-обработчик сервера (без сети), офлайн-правки, спешащие часы.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiClient,
  Doc,
  HybridClock,
  INSECURE_TEST_KDF,
  MemorySyncStore,
  NetworkError,
  SyncEngine,
  ensurePersonalSpace,
  initCrypto,
  newNodeId,
  persistLocal,
  signIn,
  signUp,
  spaceKeys,
  type Fetcher,
} from '#core';
import { createApp } from '../src/app.ts';
import { testConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

await initCrypto();

function server() {
  const { app } = createApp(openDb(':memory:'), testConfig());
  let online = true;
  const fetcher: Fetcher = async (input, init) => {
    if (!online) throw new TypeError('Failed to fetch');
    return app.fetch(new Request(input, init));
  };
  return { fetcher, setOnline: (v: boolean) => (online = v) };
}

async function device(fetcher: Fetcher, session: { token: string; keys: Parameters<typeof ensurePersonalSpace>[1] }, skew = 0) {
  const api = new ApiClient('http://dela.test', fetcher);
  api.token = session.token;
  const { spaceId, spaceKey } = await ensurePersonalSpace(api, session.keys);
  let offset = skew;
  const now = () => Date.now() + offset;
  const clock = new HybridClock(newNodeId(), now);
  const doc = new Doc({ spaceId, clock, now });
  const store = new MemorySyncStore();
  const engine = new SyncEngine({
    api,
    store,
    doc,
    spaceId,
    keys: spaceKeys(spaceKey),
    onServerTime: (t) => {
      offset = t - Date.now();
      clock.rewind();
    },
    restamp: () => clock.tick(),
  });
  persistLocal(doc, store, spaceId);
  /** Дождаться, пока локальные изменения лягут в хранилище. */
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { api, doc, store, engine, flush, spaceId };
}

describe('синхронизация через сервер', () => {
  it('два устройства одного пользователя видят задачи друг друга', async () => {
    const s = server();
    const api = new ApiClient('http://dela.test', s.fetcher);
    const { session, recoveryKey } = await signUp(api, {
      email: 'Me@Example.com',
      password: 'длинный пароль',
      deviceName: 'Ноутбук',
      kdf: INSECURE_TEST_KDF,
    });
    expect(recoveryKey).toMatch(/^[0-9A-Z-]{65}$/);
    const a = await device(s.fetcher, session);
    a.doc.createTask({ title: 'Купить хлеб', due: { date: '2026-10-14' } });
    const work = a.doc.createProject({ name: 'Работа' });
    a.doc.createTask({ title: 'Отчёт', projectId: work });
    await a.flush();
    await a.engine.sync();
    expect(a.engine.current).toMatchObject({ state: 'idle', pending: 0 });

    const api2 = new ApiClient('http://dela.test', s.fetcher);
    const session2 = await signIn(api2, { email: 'me@example.com', password: 'длинный пароль', deviceName: 'Телефон' });
    const b = await device(s.fetcher, session2);
    expect(b.spaceId).toBe(a.spaceId);
    await b.engine.sync();
    expect(b.doc.projects().map((p) => p.project.name)).toEqual(['Работа']);
    expect(b.doc.allTasks().map((t) => t.title).sort()).toEqual(['Купить хлеб', 'Отчёт']);
  });

  it('правки офлайн на двух устройствах сходятся после восстановления сети', async () => {
    const s = server();
    const { session } = await signUp(new ApiClient('http://dela.test', s.fetcher), {
      email: 'a@b.cd',
      password: 'p',
      deviceName: 'A',
      kdf: INSECURE_TEST_KDF,
    });
    const a = await device(s.fetcher, session);
    const id = a.doc.createTask({ title: 'Общая задача' });
    await a.flush();
    await a.engine.sync();
    const b = await device(s.fetcher, session);
    await b.engine.sync();

    s.setOnline(false);
    a.doc.updateTask(id, { priority: 1 });
    b.doc.updateTask(id, { title: 'Общая задача (изменено)' });
    b.doc.createTask({ title: 'Новая офлайн' });
    await a.flush();
    await a.engine.sync();
    expect(a.engine.current.state).toBe('offline');

    s.setOnline(true);
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    for (const d of [a.doc, b.doc]) {
      expect(d.task(id)).toMatchObject({ title: 'Общая задача (изменено)', priority: 1 });
      expect(d.allTasks()).toHaveLength(2);
    }
  });

  it('часы устройства спешат на 10 минут: операции переподписываются и доходят', async () => {
    const s = server();
    const { session } = await signUp(new ApiClient('http://dela.test', s.fetcher), {
      email: 'a@b.cd',
      password: 'p',
      deviceName: 'A',
      kdf: INSECURE_TEST_KDF,
    });
    const fast = await device(s.fetcher, session, 10 * 60_000);
    const id = fast.doc.createTask({ title: 'Из будущего' });
    await fast.flush();
    await fast.engine.sync();
    expect(fast.engine.current.pending).toBe(0);

    const other = await device(s.fetcher, session);
    await other.engine.sync();
    expect(other.doc.task(id)?.title).toBe('Из будущего');
    // Правка с нормальными часами должна победить, а не проиграть «будущей» метке.
    other.doc.updateTask(id, { title: 'Исправлено' });
    await other.flush();
    await other.engine.sync();
    await fast.engine.sync();
    expect(fast.doc.task(id)?.title).toBe('Исправлено');
  });

  it('неверный пароль и офлайн при входе', async () => {
    const s = server();
    const api = new ApiClient('http://dela.test', s.fetcher);
    await signUp(api, { email: 'a@b.cd', password: 'верный', deviceName: 'A', kdf: INSECURE_TEST_KDF });
    await expect(signIn(new ApiClient('http://dela.test', s.fetcher), { email: 'a@b.cd', password: 'нет', deviceName: 'B' })).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    s.setOnline(false);
    await expect(signIn(new ApiClient('http://dela.test', s.fetcher), { email: 'a@b.cd', password: 'верный', deviceName: 'B' })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});
