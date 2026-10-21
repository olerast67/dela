/**
 * Запись экрана для ролика с вызовом «прочитай мою задачу» (docs/challenge.md).
 *
 *   npm run build:web && node scripts/demo/record.ts [--out media/challenge-demo]
 *
 * Поднимает свой сервер Dela на временной базе (localhost), наполняет демо-аккаунт скриптом seed.ts
 * с одной секретной задачей и записывает веб-версию в Playwright: обычный показ, тела запросов
 * синхронизации и то, что лежит в базе сервера (выгрузка export.ts). Почта, пароль и текст секрета
 * создаются здесь же случайно, живут только в памяти и не пишутся ни в файлы, ни в вывод.
 * После каждой сцены проверяется, что секрета нет на странице, а в запросах нет открытого текста задач.
 *
 * Выход: challenge-demo.mp4 (1920×1080, 30 к/с), кадры shot-*.png и shots.md с таймкодами.
 */
import { serve } from '@hono/node-server';
import { chromium, type Page, type Request } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ApiClient, initCrypto } from '#core';
import { createApp } from '../../apps/server/src/app.ts';
import { testConfig } from '../../apps/server/src/config.ts';
import { openDb } from '../../apps/server/src/db.ts';
import { exportChallenge, formatSummary } from './export.ts';
import { seedDemo } from './seed.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const WEB = join(ROOT, 'apps/web/dist');
const args = process.argv.slice(2);
const OUT = resolve(ROOT, args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'media/challenge-demo');
const TZ = 'Europe/Moscow';
const QUICK_ADD = 'позвонить маме завтра в семь вечера';

if (!existsSync(join(WEB, 'index.html'))) throw new Error('нет сборки веб-версии: сначала npm run build:web');
await initCrypto();

// ---------- сервер и демо-аккаунт ----------

const dataDir = mkdtempSync(join(tmpdir(), 'dela-record-'));
const dbPath = join(dataDir, 'dela.sqlite');
const db = openDb(dbPath);
const config = testConfig({ openRegistration: true, webDir: WEB, publicUrl: '' });
const { app, injectWebSocket } = createApp(db, config);
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
injectWebSocket(server);
await new Promise<void>((r) => server.once('listening', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const words = ['кедр', 'маяк', 'олово', 'тетива', 'гранат', 'шлюз', 'ветер', 'сурик', 'плато', 'кварц'];
const email = `demo-${randomBytes(4).toString('hex')}@dela.test`;
const password = randomBytes(18).toString('base64url');
const secret = `Секрет ${Array.from({ length: 4 }, () => words[randomInt(words.length)]).join(' ')} ${randomInt(1000, 9999)}`;
await seedDemo({ api: new ApiClient(base), email, password, secret, timeZone: TZ });
console.log('демо-аккаунт наполнен (почта, пароль и секрет только в памяти)');

// ---------- запись ----------

/** Курсор в кадре: headless-браузер свой не рисует. */
const CURSOR = `(() => {
  const add = () => {
    if (document.getElementById('rec-cursor')) return;
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:transform .08s';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 9-7 1.6L8 20z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'translate(-3px,-2px) scale(.82)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = 'translate(-3px,-2px)'; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add();
})();`;

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^shot-.*\.png$/.test(f)) rmSync(join(OUT, f));
const rawDir = mkdtempSync(join(tmpdir(), 'dela-record-video-'));
const browser = await chromium.launch();
const context = await browser.newContext({
  // Видео пишется в размере окна: окно 1920×1080, а интерфейс увеличен в полтора раза (как экран 1280×720 на ноутбуке).
  viewport: { width: 1920, height: 1080 },
  locale: 'ru-RU',
  timezoneId: TZ,
  colorScheme: 'dark',
  recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
});
await context.addInitScript(CURSOR);
await context.addInitScript(() => {
  const zoom = () => document.documentElement && (document.documentElement.style.zoom = '1.5');
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', zoom);
  else zoom();
});

// Вход до записи: эта страница и её видео выбрасываются.
const login = await context.newPage();
await login.goto(base);
await login.locator('input[type=email]').fill(email);
await login.locator('input[type=password]').first().fill(password);
await login.getByRole('button', { name: 'Войти', exact: true }).click();
await login.locator('.task').first().waitFor({ timeout: 60_000 });
// Панель календаря «Не запланировано» показывает задачи без срока, а секретная задача как раз без срока: панель закрыта.
await login.evaluate(() => localStorage.setItem('dela.calendarSide', '0'));
const loginVideo = login.video();
await login.close();
await loginVideo?.delete();

const page = await context.newPage();
const started = Date.now();
const pushes: Array<{ url: string; body: string }> = [];
page.on('request', (r: Request) => {
  if (r.method() === 'POST' && /\/api\/spaces\/[^/]+\/push$/.test(r.url())) pushes.push({ url: new URL(r.url()).pathname, body: r.postData() ?? '' });
});

const shots: Array<{ at: number; title: string; text: string }> = [];
const frames: Array<{ at: number; name: string }> = [];
const at = () => (Date.now() - started) / 1000;
let trimFrom = 0;
const scene = (title: string, text: string) => shots.push({ at: at(), title, text });
/** Кадр для автора: снимок экрана в этот момент, после проверки секрета. */
const frame = async (name: string) => {
  await guard(page);
  frames.push({ at: at(), name });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
};
const pause = (ms: number) => page.waitForTimeout(ms);

/** Секрета не должно быть ни в одном кадре. */
async function guard(p: Page): Promise<void> {
  const text = await p.evaluate(() => document.body.innerText + document.title);
  if (text.includes(secret)) throw new Error('секретная задача попала на экран, запись остановлена');
}

async function moveTo(p: Page, selector: string | ReturnType<Page['locator']>): Promise<void> {
  const el = typeof selector === 'string' ? p.locator(selector).first() : selector;
  const box = await el.boundingBox();
  if (!box) throw new Error(`элемент не виден: ${String(selector)}`);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
}

async function click(p: Page, selector: string | ReturnType<Page['locator']>): Promise<void> {
  const el = typeof selector === 'string' ? p.locator(selector).first() : selector;
  await el.scrollIntoViewIfNeeded();
  await moveTo(p, el);
  await pause(250);
  await el.click();
}

await page.goto(`${base}/#/today`);
await page.locator('.task').first().waitFor({ timeout: 60_000 });
await page.mouse.move(640, 360);
await pause(1200);
trimFrom = at();

// 1. Обычный показ.
scene('«Сегодня»', 'Обычный список дел на день: задачи по проектам, сроки, привычки с серией.');
await guard(page);
await pause(2500);
await frame('shot-1-today');
await pause(500);

scene('Быстрый ввод фразой', `Фраза «${QUICK_ADD}»: срок «завтра 19:00» распознаётся и подсвечивается прямо в строке.`);
const addRow = page.locator('button.add-row').first();
await addRow.scrollIntoViewIfNeeded();
await click(page, addRow);
await pause(600);
const input = page.locator('.qa-input').first();
await input.waitFor();
await moveTo(page, input);
await page.keyboard.type(QUICK_ADD, { delay: 70 });
await pause(1800);
await frame('shot-2-quick-add');
await page.keyboard.press('Enter');
await pause(1500);
await guard(page);

scene('Календарь', 'Неделя в календаре: задачи со временем стоят в своих часах.');
await page.evaluate(() => (location.hash = '#/calendar/week'));
await pause(1200);
await page.mouse.move(820, 330, { steps: 30 });
await pause(2500);
await frame('shot-3-calendar');
await guard(page);

scene('Привычки', 'Статистика: привычки с сериями и полоской недель, выполнено по дням.');
await page.evaluate(() => (location.hash = '#/stats'));
await pause(1200);
const habits = page.getByRole('heading', { name: 'Привычки' }).first();
await habits.scrollIntoViewIfNeeded();
await page.mouse.move(700, 420, { steps: 25 });
await pause(3000);
await guard(page);

scene('Помодоро', 'Таймер помодоро на обычной задаче: отрезок работы запишется в задачу.');
await page.evaluate(() => (location.hash = '#/today'));
await pause(1200);
const task = page.locator('.task:not(.done) .task-title').first();
await click(page, task);
await pause(1200);
const pomo = page.locator('button.pomo-btn').first();
try {
  await pomo.waitFor({ timeout: 10_000 });
} catch (err) {
  // Снимок для разбора: проверка секрета идёт до сохранения.
  await guard(page);
  await page.screenshot({ path: join(rawDir, 'debug.png') });
  console.error(`карточка задачи не открылась, снимок: ${join(rawDir, 'debug.png')}`);
  throw err;
}
await click(page, pomo);
await pause(3500);
await frame('shot-4-pomodoro');
await guard(page);
const stop = page.getByRole('button', { name: 'Остановить таймер' }).first();
if (await stop.isVisible()) await click(page, stop);
await pause(800);
await page.keyboard.press('Escape');
await pause(1200);
await guard(page);

// 2. Запросы синхронизации.
await page.waitForTimeout(2500); // отложенная отправка изменений
if (pushes.length === 0) throw new Error('за запись не было ни одного запроса синхронизации');
for (const p of pushes) {
  if (p.body.includes('маме') || p.body.includes(secret) || /"(title|description)"/.test(p.body)) throw new Error('в запросе синхронизации есть открытый текст');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const STYLE = `
  body{margin:0;background:#16181a;color:#e7e4dc;font:21px/1.5 "JetBrains Mono",Consolas,monospace;padding:40px 52px}
  h1{font:600 40px/1.2 system-ui,sans-serif;margin:0 0 10px}
  p.lead{font:24px/1.4 system-ui,sans-serif;color:#a9a59b;margin:0 0 26px}
  .req{border:1px solid #2c3033;border-radius:10px;padding:14px 18px;margin-bottom:14px;background:#1c1f21}
  .k{color:#7fb69a}.s{color:#d9b770}.n{color:#8fb3e0}.dim{color:#6f6b63}
  .row{white-space:pre;overflow:hidden;text-overflow:ellipsis}
  mark{background:#2e4a3c;color:#e7e4dc;padding:0 4px;border-radius:4px}
`;

function envelopeRows(list: Array<{ slot: string; hlc: string; payload: string; seq?: number }>, n: number): string {
  return list
    .slice(0, n)
    .map(
      (e) =>
        `<div class="row">{ ${e.seq !== undefined ? `<span class="k">"seq"</span>: <span class="n">${e.seq}</span>, ` : ''}<span class="k">"slot"</span>: <span class="s">"${esc(e.slot)}"</span>, <span class="k">"hlc"</span>: <span class="s">"${esc(e.hlc)}"</span>, <span class="k">"payload"</span>: <span class="s">"${esc(e.payload.slice(0, 40))}…"</span> }</div>`,
    )
    .join('');
}

const lastPush = JSON.parse(pushes[pushes.length - 1]!.body) as { envelopes: Array<{ slot: string; hlc: string; payload: string }>; keyVersion?: number };
await page.goto('about:blank');
scene('Что уходит на сервер', 'Тело запроса синхронизации POST /api/spaces/…/push: слот, метка времени и шифротекст. Текста задачи «позвонить маме» в запросе нет.');
await page.setContent(`<!doctype html><meta charset="utf-8"><style>${STYLE}</style>
  <h1>Запрос синхронизации</h1>
  <p class="lead">Перехвачено в браузере во время записи: <mark>POST ${esc(pushes[pushes.length - 1]!.url.replace(/spaces\/[^/]+/, 'spaces/…'))}</mark>, запросов за запись: ${pushes.length}. Только что добавленная задача «позвонить маме» ушла вот так:</p>
  <div class="req"><div class="dim">{ "keyVersion": ${lastPush.keyVersion ?? 1}, "envelopes": [</div>${envelopeRows(lastPush.envelopes, 12)}<div class="dim">] }  — конвертов в запросе: ${lastPush.envelopes.length}</div></div>`);
await page.mouse.move(900, 300, { steps: 30 });
await pause(1500);
await frame('shot-5-network');
await page.mouse.move(1000, 520, { steps: 30 });
await pause(5500);

// 3. Что лежит на сервере.
const exportDb = openDb(dbPath);
const dump = exportChallenge(exportDb, { email });
exportDb.close();
const space = dump.spaces[0]!;
scene('Что хранит сервер', 'Те же записи в базе сервера (выгрузка scripts/demo/export.ts): только шифротексты и служебные поля — номер, слот, метка времени, длина.');
await page.setContent(`<!doctype html><meta charset="utf-8"><style>${STYLE}</style>
  <h1>База сервера</h1>
  <p class="lead">Выгрузка scripts/demo/export.ts по этому аккаунту. Сервер хранит конверты: номер, слот, метку времени и шифротекст. Видны число и размер записей и время изменений, текста задач нет.</p>
  <div class="req"><div class="row dim">${esc(formatSummary(dump.summary).split('\n').slice(0, 9).join('\n'))}</div></div>
  <div class="req">${envelopeRows(space.envelopes.slice(-10).reverse(), 10)}</div>`);
await page.mouse.move(800, 260, { steps: 30 });
await pause(1500);
await frame('shot-6-server');
await page.mouse.move(900, 600, { steps: 40 });
await pause(6000);
const ended = at();

const video = page.video();
await page.close();
await context.close();
await browser.close();
server.close();
db.close();
const webm = await video!.path();

// ---------- видео, кадры, таймкоды ----------

const ffmpeg = (a: string[]) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${a.join(' ')}`);
};
const mp4 = join(OUT, 'challenge-demo.mp4');
ffmpeg(['-ss', trimFrom.toFixed(2), '-i', webm, '-t', (ended - trimFrom).toFixed(2), '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);

const tc = (s: number) => {
  const t = Math.max(0, s - trimFrom);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
};
const md = [
  '# Запись экрана для вызова «прочитай мою задачу»',
  '',
  `Файл: challenge-demo.mp4, 1920×1080, 30 к/с, длина ${tc(ended)}. Записано скриптом scripts/demo/record.ts на локальном сервере Dela с тем же наполнением, что у демо-аккаунта (scripts/demo/seed.ts). Секретная задача в аккаунте есть, но в кадр не попадает: её проект не открывается, скрипт после каждой сцены проверяет текст страницы.`,
  '',
  '| Начало | Сцена | Что на экране |',
  '|---|---|---|',
  ...shots.map((s, i) => `| ${tc(s.at)}–${tc(shots[i + 1]?.at ?? ended)} | ${s.title} | ${s.text} |`),
  '',
  'Кадры: ' + frames.map((f) => `${f.name}.png (${tc(f.at)})`).join(', ') + '.',
  '',
].join('\n');
writeFileSync(join(OUT, 'shots.md'), md);
rmSync(rawDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
console.log(`готово: ${mp4}`);
