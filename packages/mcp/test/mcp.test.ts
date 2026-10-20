/**
 * dela-mcp на настоящем сервере Dela в памяти (обработчик HTTP без сети): вход, инструменты через
 * клиент MCP из SDK, изменения видит второй клиент на ядре, отзыв устройства.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
  newKey,
  newNodeId,
  persistLocal,
  signIn,
  signUp,
  spaceKeys,
  today,
  uuidv7,
  wrapSpaceKey,
  type Fetcher,
  type Session,
} from '../../core/src/index.ts';
import { createApp } from '../../../apps/server/src/app.ts';
import { testConfig } from '../../../apps/server/src/config.ts';
import { openDb } from '../../../apps/server/src/db.ts';
import { Dela, login, logout } from '../src/dela.ts';
import { createServer } from '../src/tools.ts';
import { Vault } from '../src/vault.ts';

await initCrypto();

const SERVER = 'http://dela.test';
const EMAIL = 'mcp@example.com';
const PASSWORD = 'пароль для теста mcp';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dela-mcp-'));
  dirs.push(d);
  return d;
}

beforeAll(() => {
  process.env.DELA_MCP_KEYSTORE = 'file';
});
afterAll(() => {
  delete process.env.DELA_MCP_KEYSTORE;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Второй клиент на ядре: телефон или браузер того же пользователя. */
async function phone(fetcher: Fetcher, session: Session) {
  const api = new ApiClient(SERVER, fetcher);
  api.token = session.token;
  const { spaceId, spaceKey } = await ensurePersonalSpace(api, session.keys);
  const clock = new HybridClock(newNodeId());
  const doc = new Doc({ spaceId, clock });
  const store = new MemorySyncStore();
  const engine = new SyncEngine({ api, store, doc, spaceId, keys: spaceKeys(spaceKey) });
  persistLocal(doc, store, spaceId);
  const ws = new Workspace(doc);
  const sync = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await engine.sync();
  };
  return { api, doc, ws, clock, sync, spaceKey };
}

async function setup() {
  const { app } = createApp(openDb(':memory:'), testConfig());
  const fetcher: Fetcher = async (input, init) => app.fetch(new Request(input, init));
  const api = new ApiClient(SERVER, fetcher);
  const { session } = await signUp(api, { email: EMAIL, password: PASSWORD, deviceName: 'Браузер', kdf: INSECURE_TEST_KDF });
  const vault = new Vault(tempDir());
  const open = async () => {
    dela = !dela || dela.stale ? await Dela.open(vault, { fetcher, log: () => undefined }) : dela;
    return dela;
  };
  let dela: Dela | null = null;
  const server = createServer(open);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    const text = res.content[0]!.text;
    if (res.isError) return { error: text } as Record<string, any>;
    return JSON.parse(text) as Record<string, any>;
  };
  return { fetcher, api, session, vault, call, client };
}

describe('dela-mcp', () => {
  it('без входа инструменты просят войти', async () => {
    const { client } = await (async () => {
      const vault = new Vault(tempDir());
      const server = createServer(() => Dela.open(vault));
      const client = new Client({ name: 'test', version: '1.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      return { client };
    })();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['add_task', 'complete_task', 'list_projects', 'search_tasks', 'today', 'update_task']);
    // Удаляющих инструментов нет.
    expect(tools.tools.every((t) => t.annotations?.destructiveHint !== true)).toBe(true);
    const res = (await client.callTool({ name: 'today', arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/dela-mcp login/);
  });

  it('вход, добавление, поиск и выполнение; второй клиент видит изменения', async () => {
    const { fetcher, api, session, vault, call } = await setup();
    // Адрес без схемы считается https, почта без учёта регистра.
    const saved = await login(vault, { server: 'dela.test/', email: EMAIL.toUpperCase(), password: PASSWORD, fetcher, deviceName: 'Dela MCP · тест' });
    expect(saved.server).toBe('https://dela.test');
    // Новое устройство видно в списке устройств аккаунта.
    expect((await api.devices()).devices.map((d) => d.name)).toContain('Dela MCP · тест');
    // Ключи и токен не лежат в файле открытым текстом.
    const raw = (await import('node:fs')).readFileSync(vault.path, 'utf8');
    expect(raw).not.toContain(session.userId);
    expect(raw).not.toContain('Dela MCP');

    const added = await call('add_task', { text: 'Купить хлеб завтра в 10 #Дом @магазин p1' });
    expect(added.error).toBeUndefined();
    const tomorrow = addDays(today(TZ), 1);
    expect(added.added).toMatchObject({ title: 'Купить хлеб', due: `${tomorrow} 10:00`, project: 'Дом', labels: ['магазин'], priority: 1, completed: false });
    expect(added.created).toEqual(['project Дом', 'label магазин']);

    const found = await call('search_tasks', { query: 'ХЛЕБ' });
    expect(found.tasks).toHaveLength(1);
    expect(found.tasks[0].id).toBe(added.added.id);
    expect((await call('search_tasks', { project: 'дом', label: 'магазин', due: 'week' })).tasks).toHaveLength(1);
    expect((await call('search_tasks', { due: 'today' })).tasks).toHaveLength(0);
    expect((await call('search_tasks', { project: 'Работа' })).error).toMatch(/No project named "Работа"/);

    // Второй клиент (другое устройство того же пользователя) получает задачу с сервера.
    const other = await phone(fetcher, await signIn(new ApiClient(SERVER, fetcher), { email: EMAIL, password: PASSWORD, deviceName: 'Телефон' }));
    await other.sync();
    const there = other.ws.search('хлеб');
    expect(there).toHaveLength(1);
    expect(other.ws.project(there[0]!.projectId)?.name).toBe('Дом');

    const done = await call('complete_task', { id: added.added.id });
    expect(done.completed).toMatchObject({ id: added.added.id, completed: true });
    await other.sync();
    expect(other.ws.task(added.added.id)?.completedAt).not.toBeNull();
    expect((await call('search_tasks', { query: 'хлеб' })).tasks).toHaveLength(0);
    expect((await call('search_tasks', { query: 'хлеб', status: 'completed' })).tasks).toHaveLength(1);

    // Задача со второго клиента видна в «Сегодня» без перезапуска: перед вызовом идёт синхронизация.
    const fromPhone = other.ws.createTask({ title: 'Позвонить маме', due: { date: today(TZ) } });
    other.ws.createTask({ title: 'Вчерашнее', due: { date: addDays(today(TZ), -1) } });
    await other.sync();
    const t = await call('today');
    expect(t.today.map((x: { title: string }) => x.title)).toEqual(['Позвонить маме']);
    expect(t.overdue.map((x: { title: string }) => x.title)).toEqual(['Вчерашнее']);
    expect(t.overdue[0].overdue).toBe(true);

    // Повторяющаяся задача переносится на следующий раз, как в приложении.
    const rep = await call('add_task', { text: 'Полить цветы каждый день' });
    expect(rep.added.repeat).toBeTruthy();
    const firstDue = rep.added.due as string;
    const next = await call('complete_task', { id: rep.added.id });
    expect(next.completed_occurrence).toBe(firstDue);
    expect(next.next.completed).toBe(false);
    expect(next.next.due > firstDue).toBe(true);

    // Изменение: название, приоритет, срок фразой и датой, метки, проект.
    const upd = await call('update_task', { id: fromPhone, title: 'Позвонить маме вечером', due: '2030-01-02 19:30', priority: 2, labels: ['семья'] });
    expect(upd.updated).toMatchObject({ title: 'Позвонить маме вечером', due: '2030-01-02 19:30', priority: 2, labels: ['семья'] });
    expect(upd.created_labels).toEqual(['семья']);
    const moved = await call('update_task', { id: fromPhone, project: 'Дом', due: 'none', labels: [] });
    expect(moved.updated).toMatchObject({ project: 'Дом', due: null, labels: [] });
    expect((await call('update_task', { id: fromPhone, due: 'когда-нибудь потом' })).error).toMatch(/Could not understand the date/);
    expect((await call('update_task', { id: uuidv7() })).error).toMatch(/No task with id/);
    await other.sync();
    expect(other.ws.task(fromPhone)).toMatchObject({ title: 'Позвонить маме вечером', priority: 2, due: null });
    expect(other.ws.project(other.ws.task(fromPhone)!.projectId)?.name).toBe('Дом');

    const projects = await call('list_projects');
    expect(projects.projects.map((p: { name: string }) => p.name)).toEqual(['Inbox', 'Дом']);
    expect(projects.labels.sort()).toEqual(['магазин', 'семья']);

    // Новый процесс с тем же файлом видит всё из кэша и сервера.
    const again = await Dela.open(new Vault(vault.dir), { fetcher });
    await again.sync();
    expect(again.ws.search('маме')).toHaveLength(1);
  });

  it('общий проект доступен, если клиент его видит', async () => {
    const { fetcher, session, vault, call } = await setup();
    await login(vault, { server: SERVER, email: EMAIL, password: PASSWORD, fetcher });
    // Владелец создаёт общий проект в другом клиенте.
    const api = new ApiClient(SERVER, fetcher);
    api.token = session.token;
    const spaceId = uuidv7();
    const key = newKey();
    await api.createSpace(spaceId, wrapSpaceKey(key, session.keys.masterKey, spaceId), 'shared');
    const shared = new Doc({ spaceId, clock: new HybridClock(newNodeId()), kind: 'shared' });
    const store = new MemorySyncStore();
    persistLocal(shared, store, spaceId);
    shared.write([
      ['project', spaceId, 'name', 'Семья'],
      ['project', spaceId, 'order', 'a0'],
    ]);
    const engine = new SyncEngine({ api, store, doc: shared, spaceId, keys: spaceKeys(key) });
    await new Promise((r) => setTimeout(r, 0));
    await engine.sync();

    const projects = await call('list_projects');
    expect(projects.projects).toContainEqual(expect.objectContaining({ id: spaceId, name: 'Семья', shared: true, role: 'owner' }));
    const added = await call('add_task', { text: 'Купить подарок', project: 'семья' });
    expect(added.added.project).toBe('Семья');
    await engine.sync();
    expect(shared.search('подарок')).toHaveLength(1);
    // Метки личные: на задачу общего проекта их не поставить.
    expect((await call('update_task', { id: added.added.id, labels: ['x'] })).error).toMatch(/Labels are personal/);
  });

  it('отозванное устройство теряет доступ и стирает файл; выход отзывает устройство', async () => {
    const { fetcher, api, vault, call } = await setup();
    const saved = await login(vault, { server: SERVER, email: EMAIL, password: PASSWORD, fetcher, deviceName: 'Dela MCP · A' });
    expect((await call('today')).error).toBeUndefined();
    await api.revokeDevice(saved.deviceId);
    expect((await call('today')).error).toMatch(/signed out/);
    expect(vault.exists()).toBe(false);

    await login(vault, { server: SERVER, email: EMAIL, password: PASSWORD, fetcher, deviceName: 'Dela MCP · B' });
    expect((await call('add_task', { text: 'после нового входа' })).error).toBeUndefined();
    // Повторный вход закрывает прежнюю сессию этого компьютера: в списке одно устройство dela-mcp.
    const second = await login(vault, { server: SERVER, email: EMAIL, password: PASSWORD, fetcher, deviceName: 'Dela MCP · C' });
    expect((await api.devices()).devices.map((d) => d.name).filter((n) => n.startsWith('Dela MCP'))).toEqual(['Dela MCP · C']);
    expect((await call('search_tasks', { query: 'после нового' })).tasks).toHaveLength(1);

    expect(await logout(vault, fetcher)).toEqual({ hadSession: true, revoked: true });
    expect(vault.exists()).toBe(false);
    expect((await api.devices()).devices.some((d) => d.id === second.deviceId)).toBe(false);
    expect(await logout(vault, fetcher)).toEqual({ hadSession: false, revoked: false });
  });
});

describe.runIf(process.platform === 'win32')('хранилище ключа на Windows', () => {
  it('ключ файла сессии защищён DPAPI', () => {
    const prev = process.env.DELA_MCP_KEYSTORE;
    delete process.env.DELA_MCP_KEYSTORE;
    try {
      const dir = tempDir();
      const v = new Vault(dir);
      v.write({ secret: 'ключ' });
      expect(v.keystore).toBe('dpapi');
      const again = new Vault(dir);
      expect(again.read<{ secret: string }>()).toEqual({ secret: 'ключ' });
      again.remove();
      expect(again.exists()).toBe(false);
    } finally {
      if (prev !== undefined) process.env.DELA_MCP_KEYSTORE = prev;
    }
  });
});
