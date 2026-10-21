/**
 * Демо для вызова «прочитай задачу»: наполнение аккаунта через настоящий обработчик сервера (в памяти),
 * выгрузка из его базы и проверка, что в выгрузке нет почты, хешей, секрета и чужих данных.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ApiClient,
  Doc,
  addDays,
  HybridClock,
  INSECURE_TEST_KDF,
  MemorySyncStore,
  SyncEngine,
  Workspace,
  ensurePersonalSpace,
  initCrypto,
  newKey,
  newNodeId,
  openEnvelope,
  persistLocal,
  signIn,
  signUp,
  spaceKeys,
  today,
  uuidv7,
  weekStart,
  wrapSpaceKey,
  type Fetcher,
} from '#core';
import { createApp } from '../../../apps/server/src/app.ts';
import { testConfig } from '../../../apps/server/src/config.ts';
import { SCHEMA_VERSION, openDb, type Db } from '../../../apps/server/src/db.ts';
import { KNOWN_SCHEMA, TABLE_POLICY, checkExport, exportChallenge, formatSummary, type ChallengeExport } from '../export.ts';
import { SeedError, seedDemo, type SeedReport } from '../seed.ts';

await initCrypto();

const TZ = 'Europe/Moscow';
const SECRET = 'Тестовый секрет: код от сейфа 4711, никому не говорить';
const DEMO = { email: 'Demo.Person@Example.test', password: 'демо пароль для теста' };
const CONTROL = { email: 'control@example.test', password: 'контрольный пароль', marker: 'Контрольная задача второго пользователя' };
const EXPORT_SCRIPT = fileURLToPath(new URL('../export.ts', import.meta.url));

function server(): { db: Db; fetcher: Fetcher } {
  const db = openDb(':memory:');
  const { app } = createApp(db, testConfig());
  return { db, fetcher: async (input, init) => app.fetch(new Request(input, init)) };
}

const client = (fetcher: Fetcher) => new ApiClient('http://dela.test', fetcher);

/** Второе устройство демо-аккаунта: забирает всё с сервера и собирает Workspace. */
async function pullDemo(fetcher: Fetcher): Promise<{ ws: Workspace; spaceId: string; keys: ReturnType<typeof spaceKeys> }> {
  const api = client(fetcher);
  const session = await signIn(api, { ...DEMO, deviceName: 'проверка' });
  const { spaceId, spaceKey } = await ensurePersonalSpace(api, session.keys);
  const doc = new Doc({ spaceId, clock: new HybridClock(newNodeId()), timeZone: TZ });
  const store = new MemorySyncStore();
  persistLocal(doc, store, spaceId);
  const keys = spaceKeys(spaceKey);
  await new SyncEngine({ api, store, doc, spaceId, keys }).sync();
  return { ws: new Workspace(doc), spaceId, keys };
}

describe('демо-аккаунт для вызова', () => {
  it('список таблиц выгрузки совпадает со схемой сервера', () => {
    expect(KNOWN_SCHEMA).toBe(SCHEMA_VERSION);
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables.sort()).toEqual(Object.keys(TABLE_POLICY).sort());
  });

  it('наполнение, выгрузка и проверка: только шифротекст демо-аккаунта', async () => {
    const { db, fetcher } = server();

    // Администратор (первый пользователь) выдаёт приглашения.
    const admin = client(fetcher);
    await signUp(admin, { email: 'admin@example.test', password: 'пароль администратора', deviceName: 'админ', kdf: INSECURE_TEST_KDF });
    const demoInvite = (await admin.createInvite()).code;
    const controlInvite = (await admin.createInvite()).code;

    // Без приглашения регистрации нет.
    await expect(seedDemo({ api: client(fetcher), ...DEMO, kdf: INSECURE_TEST_KDF, timeZone: TZ })).rejects.toMatchObject({ code: 'invite_required' });

    const report: SeedReport = await seedDemo({ api: client(fetcher), ...DEMO, invite: demoInvite, secret: SECRET, kdf: INSECURE_TEST_KDF, timeZone: TZ });
    expect(report.registered).toBe(true);
    expect(report.secret).toBe(true);
    expect(report.openTasks).toBeGreaterThanOrEqual(40);
    expect(report.openTasks).toBeLessThanOrEqual(60);
    expect(report.completedTasks).toBeGreaterThanOrEqual(40);
    expect(report.habits).toBe(3);
    expect(report.completions).toBeGreaterThan(80);
    expect(report.focusSessions).toBeGreaterThan(20);
    expect(report.comments).toBe(2);

    // Второй запуск по непустому аккаунту и неверный пароль — отказ.
    await expect(seedDemo({ api: client(fetcher), ...DEMO, timeZone: TZ })).rejects.toBeInstanceOf(SeedError);
    await expect(seedDemo({ api: client(fetcher), ...DEMO, timeZone: TZ })).rejects.toMatchObject({ code: 'not_empty' });
    // С приглашением регистрация упирается в занятую почту, а приглашение остаётся неиспользованным.
    await expect(seedDemo({ api: client(fetcher), email: DEMO.email, password: 'не тот пароль', invite: controlInvite, timeZone: TZ })).rejects.toMatchObject({ code: 'wrong_password' });

    // Контрольный пользователь со своими данными.
    const controlApi = client(fetcher);
    const control = await signUp(controlApi, { email: CONTROL.email, password: CONTROL.password, deviceName: 'контроль', invite: controlInvite, kdf: INSECURE_TEST_KDF });
    const controlSpace = await ensurePersonalSpace(controlApi, control.session.keys);
    {
      const doc = new Doc({ spaceId: controlSpace.spaceId, clock: new HybridClock(newNodeId()) });
      const store = new MemorySyncStore();
      persistLocal(doc, store, controlSpace.spaceId);
      new Workspace(doc).createTask({ title: CONTROL.marker });
      await new Promise((r) => setTimeout(r, 0));
      await new SyncEngine({ api: controlApi, store, doc, spaceId: controlSpace.spaceId, keys: spaceKeys(controlSpace.spaceKey) }).sync();
    }

    // Общие пространства демо: одно только своё (выгружается), одно вместе с контрольным (нет).
    const demoApi = client(fetcher);
    const demo = await signIn(demoApi, { ...DEMO, deviceName: 'общие' });
    const soloId = uuidv7();
    await demoApi.createSpace(soloId, wrapSpaceKey(newKey(), demo.keys.masterKey, soloId), 'shared');
    const withControlId = uuidv7();
    await demoApi.createSpace(withControlId, wrapSpaceKey(newKey(), demo.keys.masterKey, withControlId), 'shared');
    db.prepare("INSERT INTO members (space_id, user_id, role, key_kind, key) VALUES (?, ?, 'editor', 'sealed', 'AAAA')").run(withControlId, control.session.userId);

    const data = exportChallenge(db, { email: DEMO.email.toUpperCase() });
    expect(checkExport(db, data)).toEqual([]);

    const text = JSON.stringify(data);
    const lower = text.toLowerCase();
    // Ни почты, ни секрета, ни чужих id.
    for (const email of [DEMO.email, CONTROL.email, 'admin@example.test']) expect(lower).not.toContain(email.toLowerCase());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('код от сейфа');
    expect(text).not.toContain(Buffer.from(SECRET).toString('base64'));
    expect(text).not.toContain(CONTROL.marker);
    expect(text).not.toContain(control.session.userId);
    expect(text).not.toContain(controlSpace.spaceId);
    expect(text).not.toContain(withControlId);
    expect(text).toContain(soloId);
    // Ни хешей входа и восстановления, ни мастер-ключа под паролем.
    const row = db.prepare('SELECT auth_hash, auth_salt, recovery_hash, bundle FROM users WHERE id = ?').get(demo.userId) as Record<string, Uint8Array | string>;
    for (const k of ['auth_hash', 'auth_salt', 'recovery_hash'] as const) expect(text).not.toContain(Buffer.from(row[k] as Uint8Array).toString('base64'));
    const bundle = JSON.parse(row.bundle as string) as Record<string, string>;
    for (const k of ['masterByPassword', 'masterByRecovery', 'salt']) expect(text).not.toContain(bundle[k]);
    expect(data.account.email).toBe('demo');
    expect(data.devices.every((d) => /^device-\d+$/.test(d.name))).toBe(true);

    // Сводка.
    const s = data.summary;
    expect(s.spaces).toBe(2);
    expect(s.spacesByKind).toEqual({ personal: 1, shared: 1 });
    expect(s.sharedSpacesWithOthersSkipped).toBe(1);
    expect(s.envelopes).toBe(data.spaces.reduce((n, x) => n + x.envelopes.length, 0));
    expect(s.acceptedOps).toBeGreaterThanOrEqual(report.ops);
    expect(s.overwritten).toBe(s.acceptedOps - s.envelopes);
    expect(s.recordKinds).toBeNull();
    expect(s.hlc.nodes).toBe(1);
    expect(s.devices).toBe(data.devices.length);
    expect(s.devices).toBeGreaterThanOrEqual(2);
    expect(Object.keys(s.payloadBytes.histogram).every((len) => (Number(len) - 40) % 64 === 0)).toBe(true);
    expect(formatSummary(s)).toContain('Записей в журнале');

    // Выгрузка полная: ключом демо-аккаунта из неё читается секретная задача, ровно одна.
    const { ws, spaceId, keys } = await pullDemo(fetcher);
    const personal = data.spaces.find((x) => x.id === spaceId)!;
    const titles = personal.envelopes.map((e) => openEnvelope(spaceId, keys, e)).filter((op) => op.table === 'task' && op.field === 'title');
    expect(titles.filter((op) => op.value === SECRET)).toHaveLength(1);

    // История правдоподобна: статистика по неделям, привычки с сериями, сад с деревьями фокуса.
    const t = today(TZ);
    const stats = ws.stats(TZ, t);
    expect(stats.weeks.filter((w) => w.count > 0).length).toBeGreaterThanOrEqual(7);
    const habits = ws.habits(t, TZ);
    expect(habits).toHaveLength(3);
    for (const h of habits) {
      expect(h.streak.best).toBeGreaterThanOrEqual(3);
      expect(h.streak.days.some((d) => d.state === 'done')).toBe(true);
    }
    expect(habits.some((h) => h.streak.days.some((d) => d.state === 'missed' || d.state === 'allowed' || d.state === 'skipped'))).toBe(true);
    const garden = ws.garden(TZ, t);
    expect(garden.trees).toBeGreaterThan(10);
    expect(garden.plants).toBeGreaterThan(30);
    expect(ws.getGameSettings().dailyGoal).toBe(4);
    expect(ws.weekReview(TZ, addDays(weekStart(t), -7), t).done).toBeGreaterThan(0);
    const overdue = ws.today(t, TZ).overdue;
    expect(overdue.length).toBeGreaterThan(0);
    expect(ws.projects().map((p) => p.project.name)).toEqual(expect.arrayContaining(['Работа', 'Дом', 'Ремонт ванной', 'Спорт', 'Чтение', 'Поездка в Казань']));

    // Командная строка на копии базы: тот же результат, файл пишется только после проверки.
    const dir = mkdtempSync(join(tmpdir(), 'dela-challenge-'));
    try {
      const file = join(dir, 'dela.sqlite');
      db.prepare('VACUUM INTO ?').run(file);
      const out = join(dir, 'out.json');
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', EXPORT_SCRIPT, '--db', file, '--email', DEMO.email, '--out', out], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Проверка пройдена');
      const fromCli = JSON.parse(readFileSync(out, 'utf8')) as ChallengeExport;
      expect(fromCli.spaces).toEqual(data.spaces);
      expect(readFileSync(out, 'utf8')).not.toContain(SECRET);
      // --out -: выгрузка в stdout, сводка в stderr (так запускают в контейнере с read-only диском).
      const piped = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', EXPORT_SCRIPT, '--db', file, '--user', demo.userId, '--out', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
      expect(piped.status).toBe(0);
      expect(piped.stderr).toContain('Проверка пройдена');
      expect((JSON.parse(piped.stdout) as ChallengeExport).spaces).toEqual(data.spaces);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('проверка ловит открытый текст, почту и лишние поля', async () => {
    const { db, fetcher } = server();
    const api = client(fetcher);
    const { session } = await signUp(api, { ...DEMO, deviceName: 'демо', kdf: INSECURE_TEST_KDF });
    const { spaceId, spaceKey } = await ensurePersonalSpace(api, session.keys);
    const doc = new Doc({ spaceId, clock: new HybridClock(newNodeId()) });
    const store = new MemorySyncStore();
    persistLocal(doc, store, spaceId);
    new Workspace(doc).createTask({ title: 'Обычная задача' });
    await new Promise((r) => setTimeout(r, 0));
    await new SyncEngine({ api, store, doc, spaceId, keys: spaceKeys(spaceKey) }).sync();

    const data = exportChallenge(db, { userId: session.userId });
    expect(checkExport(db, data)).toEqual([]);
    const space = data.spaces[0]!;
    const env = space.envelopes[0]!;

    // Клиент мог бы прислать открытый текст под видом шифротекста нужной длины: сервер его не проверяет.
    const plain = Buffer.alloc(104, ' ');
    plain.write(JSON.stringify({ t: 'task', r: 'x', f: 'title', v: 'plain text secret' }));
    const tampered: ChallengeExport = { ...data, spaces: [{ ...space, envelopes: [{ ...env, payload: plain.toString('base64') }, ...space.envelopes.slice(1)] }] };
    expect(checkExport(db, tampered).join('\n')).toContain('читается как текст UTF-8');

    const withEmail = { ...data, account: { ...data.account, email: DEMO.email.toLowerCase() } } as unknown as ChallengeExport;
    expect(checkExport(db, withEmail).some((p) => p.includes('почта'))).toBe(true);

    const withNote = { ...data, note: 'секретная задача лежит в проекте Личное' } as unknown as ChallengeExport;
    expect(checkExport(db, withNote).join('\n')).toContain('похоже на текст');

    const wrongLength = { ...data, spaces: [{ ...space, envelopes: [{ ...env, payload: Buffer.from(env.payload, 'base64').subarray(0, 120).toString('base64') }] }] };
    expect(checkExport(db, wrongLength).join('\n')).toContain('40 + 64');
  });
});
