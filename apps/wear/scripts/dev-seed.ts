/**
 * Для проверки часов на сервере разработчика: «телефон» на ядре.
 *   node apps/wear/scripts/dev-seed.ts seed   <сервер> <почта> <пароль> [минут] — аккаунт (если нет) и задачи на сегодня,
 *                                                                              у одной напоминание через [минут] (60)
 *   node apps/wear/scripts/dev-seed.ts status <сервер> <почта> <пароль>  — состояние задач после действий на часах
 * Сервер для этого: DELA_DB_PATH=:memory: DELA_OPEN_REGISTRATION=true DELA_PORT=8795 npm run server
 */
import {
  ApiClient,
  ApiError,
  Doc,
  HybridClock,
  MemorySyncStore,
  SyncEngine,
  Workspace,
  addDays,
  ensurePersonalSpace,
  initCrypto,
  newNodeId,
  persistLocal,
  signIn,
  signUp,
  spaceKeys,
  today,
  type Session,
} from '../../../packages/core/src/index.ts';

const [mode, server, email, password, minutes = '60'] = process.argv.slice(2);
if (!mode || !server || !email || !password) {
  console.error('usage: dev-seed.ts seed|status <server> <email> <password>');
  process.exit(2);
}

await initCrypto();
const api = new ApiClient(server);
let session: Session;
try {
  session = await signIn(api, { email, password, deviceName: 'dev-seed' });
} catch (err) {
  if (!(err instanceof ApiError) || err.code !== 'invalid_credentials' || mode !== 'seed') throw err;
  session = (await signUp(api, { email, password, deviceName: 'dev-seed' })).session;
}
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
await sync();

const tz = doc.timeZone;
const date = today(tz);
if (mode === 'seed') {
  ws.personal.ensureInbox();
  const home = ws.createProject({ name: 'Дом' });
  const at = new Date(Date.now() + Number(minutes) * 60_000);
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  ws.createTask({ title: 'Позвонить маме', due: { date }, priority: 1 });
  ws.createTask({ title: 'Оплатить интернет', due: { date: addDays(date, -1) }, projectId: home });
  ws.createTask({ title: 'Полить цветы', due: { date }, recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' }, projectId: home });
  ws.createTask({ title: 'Созвон с командой', due: { date: today(tz, at.getTime()), time: hhmm } });
  ws.createTask({ title: 'Через неделю', due: { date: addDays(date, 7) } });
  await sync();
}
const tasks = ws.allTasks().map((t) => ({ title: t.title, due: t.due, completed: t.completedAt !== null, completions: ws.completions(t.id).length }));
console.log(JSON.stringify({ date, tz, tasks, devices: (await api.devices()).devices.map((d) => d.name) }, null, 2));
await api.logout();
