/**
 * Снимки экрана для README, сайта и F-Droid: `npm run screenshots`.
 *
 * Поднимает Vite с веб-версией, открывает её в Chromium в режиме «Попробовать без сервера»,
 * заполняет задачи правдоподобными данными (по-русски и по-английски), подписывается на календарь .ics,
 * который отдаёт page.route, и снимает экраны в docs/images. Потом собирает баннер и коллаж из
 * docs/images/banner*.html и screens*.html, сжимает PNG и копирует снимки в fastlane/.
 *
 * Дата и время в браузере зафиксированы (FIXED_NOW), поэтому снимки от запуска к запуску одинаковые.
 * Только один язык: `npm run screenshots -- en` или `-- ru`.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'images');
const PORT = Number(process.env.DELA_SHOTS_PORT ?? 5199);
const BASE = `http://localhost:${PORT}`;
const TZ = 'Europe/Moscow';
/** Среда, 21 октября 2026, 11:10 по Москве. */
const FIXED_NOW = new Date('2026-10-21T11:10:00+03:00');
const TODAY = '2026-10-21';

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const stamp = (date) => date.replaceAll('-', '');

// ---------- данные ----------

const TEXT = {
  ru: {
    locale: 'ru-RU',
    tryLocal: /Попробовать без сервера/,
    newTask: 'Новая задача',
    projects: { work: 'Работа', home: 'Дом', reno: 'Ремонт', sport: 'Спорт', personal: 'Личное' },
    labels: { shop: 'магазин', call: 'звонок' },
    habit: {
      title: 'Английский, 20 минут',
      text: 'каждый день',
      description: 'Учебник, урок 7.\n\n- [x] Новые слова к уроку\n- [ ] Упражнения 3-5 на странице 64\n- [ ] Подкаст на **10 минут**\n\nСлова повторять в карточках перед сном.',
    },
    run: { title: 'Пробежка 5 км', text: 'по пн, ср и пт' },
    report: { title: 'Сдать отчёт по продажам за квартал' },
    tiles: {
      title: 'Выбрать плитку для ванной',
      subs: ['Замерить стены и пол', 'Посчитать клей и затирку', 'Съездить в строительный магазин'],
    },
    groceries: { title: 'Купить продукты на неделю' },
    call: 'Позвонить в управляющую компанию про батареи',
    upcoming: [
      { title: 'Забрать костюм из химчистки', day: 1, time: '18:30', project: 'home' },
      { title: 'Подготовить слайды к квартальному ревью', day: 1, project: 'work', priority: 2 },
      { title: 'Заказать доставку плитки', day: 2, project: 'reno' },
      { title: 'Оплатить интернет', day: 2, project: 'home', rec: ['FREQ=MONTHLY', 'каждый месяц'] },
      { title: 'Вывезти строительный мусор', day: 3, time: '10:00', duration: 120, project: 'reno' },
      { title: 'Купить корм коту', day: 3, project: 'home', label: 'shop' },
      { title: 'Позвонить родителям', day: 4, time: '19:00', project: 'personal', label: 'call', rec: ['FREQ=WEEKLY;BYDAY=SU', 'каждое воскресенье'] },
      { title: 'Записать машину на смену шин', day: 5, project: 'personal', priority: 3 },
      { title: 'Отправить счёт клиенту', day: 6, project: 'work', priority: 2 },
    ],
    undated: ['Записаться к стоматологу', 'Продлить страховку на машину', 'Выбрать подарок маме на юбилей'],
    done: {
      work: ['Ответить на письма клиентов', 'Согласовать договор с поставщиком', 'Обновить прайс-лист', 'Созвон с бухгалтерией', 'Написать план на неделю'],
      home: ['Оплатить коммуналку', 'Постирать шторы', 'Разобрать балкон', 'Купить лампочки в коридор'],
      reno: ['Снять старую плитку', 'Купить грунтовку', 'Вызвать сантехника', 'Выбрать смеситель'],
    },
    calendars: { work: 'Работа', family: 'Семья' },
    events: {
      standup: 'Планёрка',
      standupEnd: '110000',
      review: 'Квартальное ревью',
      lunch: 'Обед с Андреем',
      birthday: 'День рождения Лены',
      contractor: 'Встреча с прорабом',
      movie: 'Кино с друзьями',
      pool: 'Бассейн',
      office: 'Переговорная 2',
    },
    quickAdd: 'Купить краску для балкона завтра в 10 #Ремонт !2 @магазин напомни за час',
  },
  en: {
    locale: 'en-US',
    tryLocal: /Try without a server/,
    newTask: 'New task',
    projects: { work: 'Work', home: 'Home', reno: 'Renovation', sport: 'Sport', personal: 'Personal' },
    labels: { shop: 'errands', call: 'calls' },
    habit: {
      title: 'Spanish practice, 20 min',
      text: 'every day',
      description: 'Textbook, lesson 7.\n\n- [x] New words for the lesson\n- [ ] Exercises 3-5 on page 64\n- [ ] A **10-minute** podcast\n\nReview the flashcards before bed.',
    },
    run: { title: 'Run 5 km', text: 'every Mon, Wed, Fri' },
    report: { title: 'Send the quarterly sales report' },
    tiles: {
      title: 'Pick tiles for the bathroom',
      subs: ['Measure the walls and floor', 'Work out adhesive and grout', 'Visit the hardware store'],
    },
    groceries: { title: 'Weekly grocery run' },
    call: 'Call the building manager about the radiators',
    upcoming: [
      { title: 'Pick up the suit from the dry cleaner', day: 1, time: '18:30', project: 'home' },
      { title: 'Prepare slides for the quarterly review', day: 1, project: 'work', priority: 2 },
      { title: 'Order tile delivery', day: 2, project: 'reno' },
      { title: 'Pay the internet bill', day: 2, project: 'home', rec: ['FREQ=MONTHLY', 'every month'] },
      { title: 'Haul away construction debris', day: 3, time: '10:00', duration: 120, project: 'reno' },
      { title: 'Buy cat food', day: 3, project: 'home', label: 'shop' },
      { title: 'Call Mom and Dad', day: 4, time: '19:00', project: 'personal', label: 'call', rec: ['FREQ=WEEKLY;BYDAY=SU', 'every Sunday'] },
      { title: 'Book the winter tire change', day: 5, project: 'personal', priority: 3 },
      { title: 'Send the invoice to the client', day: 6, project: 'work', priority: 2 },
    ],
    undated: ['Book a dentist appointment', 'Renew the car insurance', 'Choose a gift for Mom'],
    done: {
      work: ['Answer client emails', 'Review the supplier contract', 'Update the price list', 'Call with accounting', 'Write the weekly plan'],
      home: ['Pay the utility bills', 'Wash the curtains', 'Clear out the balcony', 'Buy hallway light bulbs'],
      reno: ['Remove the old tiles', 'Buy primer', 'Book a plumber', 'Choose a faucet'],
    },
    calendars: { work: 'Work', family: 'Family' },
    events: {
      // Время в 12-часовом формате занимает две строки: блоку нужно место и под название.
      standup: 'Morning planning',
      standupEnd: '111500',
      review: 'Quarterly review',
      lunch: 'Lunch with Tom',
      birthday: "Emma's birthday",
      contractor: 'Meet the contractor',
      movie: 'Movie night with friends',
      pool: 'Swimming pool',
      office: 'Meeting room 2',
    },
    quickAdd: 'Buy paint tomorrow at 10am #Renovation p2 remind me an hour before',
  },
};

const WORK_ICS = 'https://calendar.example.test/work/basic.ics';
const FAMILY_ICS = 'https://calendar.example.test/family/basic.ics';

function vevent(uid, summary, start, end, extra = []) {
  return ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`, `DTSTART;TZID=${TZ}:${start}`, `DTEND;TZID=${TZ}:${end}`, ...extra, 'END:VEVENT'];
}

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//dela screenshots//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

function workIcs(t) {
  const monday = addDays(TODAY, -2);
  return ics([
    ...vevent('standup', t.events.standup, `${stamp(monday)}T100000`, `${stamp(monday)}T${t.events.standupEnd}`, ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', `LOCATION:${t.events.office}`]),
    ...vevent('review', t.events.review, `${stamp(addDays(TODAY, 1))}T150000`, `${stamp(addDays(TODAY, 1))}T163000`, [`LOCATION:${t.events.office}`]),
    ...vevent('lunch', t.events.lunch, `${stamp(addDays(TODAY, -1))}T130000`, `${stamp(addDays(TODAY, -1))}T140000`),
  ]);
}

function familyIcs(t) {
  return ics([
    'BEGIN:VEVENT',
    'UID:birthday',
    `SUMMARY:${t.events.birthday}`,
    `DTSTART;VALUE=DATE:${stamp(TODAY)}`,
    `DTEND;VALUE=DATE:${stamp(addDays(TODAY, 1))}`,
    'END:VEVENT',
    ...vevent('contractor', t.events.contractor, `${stamp(TODAY)}T140000`, `${stamp(TODAY)}T150000`),
    ...vevent('movie', t.events.movie, `${stamp(addDays(TODAY, 2))}T190000`, `${stamp(addDays(TODAY, 2))}T213000`),
    ...vevent('pool', t.events.pool, `${stamp(addDays(TODAY, 3))}T120000`, `${stamp(addDays(TODAY, 3))}T130000`),
  ]);
}

/**
 * Заполнение выполняется в странице: модули Vite отдаются по тем же адресам, что и приложению,
 * поэтому import() возвращает тот же controller, с которым работает открытый интерфейс.
 */
async function seed(page, t) {
  await page.evaluate(
    async ({ t, today, calendars }) => {
      const { controller } = await import('/src/controller.ts');
      const { refreshCalendars } = await import('/src/calendars.ts');
      const doc = controller.doc;
      const DAY = 86_400_000;
      const at = (days) => {
        controller.clockOffset = days * DAY;
      };
      const addDays = (date, n) => {
        const d = new Date(`${date}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const due = (n, time) => (time ? { date: addDays(today, n), time } : { date: addDays(today, n) });

      // Приветственные задачи режима без сервера на снимках не нужны.
      for (const task of doc.allTasks()) doc.deleteTask(task.id);
      doc.emptyTrash();

      at(-90);
      const P = {};
      P.work = doc.createProject({ name: t.projects.work, color: 'blue' });
      P.home = doc.createProject({ name: t.projects.home, color: 'green' });
      P.reno = doc.createProject({ name: t.projects.reno, color: 'orange' });
      P.sport = doc.createProject({ name: t.projects.sport, color: 'violet' });
      P.personal = doc.createProject({ name: t.projects.personal, color: 'teal' });
      const L = { shop: doc.createLabel(t.labels.shop, 'yellow'), call: doc.createLabel(t.labels.call, 'pink') };

      // История выполненного для статистики: 4 недели, по одному-пять дел в день.
      const pattern = [2, 3, 1, 4, 2, 1, 3, 2, 5, 3, 1, 2, 4, 3, 2, 1, 3, 4, 2, 3, 1, 2, 3, 4, 2, 3, 2];
      const pools = [
        ['work', t.done.work],
        ['home', t.done.home],
        ['reno', t.done.reno],
      ];
      let n = 0;
      for (let k = 83; k >= 1; k--) {
        at(-k);
        // Два пустых дня: серия в статистике не бесконечная.
        const count = k === 12 || k === 47 ? 0 : pattern[k % pattern.length] + (k < 30 ? 1 : 0);
        for (let i = 0; i < count; i++, n++) {
          const [project, titles] = pools[n % 3];
          const id = doc.createTask({ title: titles[n % titles.length], projectId: P[project], due: due(0) });
          doc.completeTask(id);
        }
      }

      // Привычка с серией и временем помодоро по дням.
      at(-21);
      const habit = doc.createTask({
        title: t.habit.title,
        projectId: P.personal,
        description: t.habit.description,
        due: due(-20),
        recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: t.habit.text },
        habit: { skipsPerWeek: 1 },
      });
      for (let k = 20; k >= 1; k--) {
        at(-k);
        if (k === 8) {
          doc.skipOccurrence(habit);
          continue;
        }
        doc.completeTask(habit);
        doc.logWork(habit, 20 + ((k * 7) % 15), { at: Date.now() - k * DAY });
      }

      // Пробежка по пн, ср и пт: история и выполненный сегодня экземпляр.
      at(-24);
      const run = doc.createTask({
        title: t.run.title,
        projectId: P.sport,
        due: due(-23, '07:30'),
        duration: 45,
        recurrence: { rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', mode: 'schedule', text: t.run.text },
      });
      for (let k = 23; k >= 1; k--) {
        const d = new Date(`${addDays(today, -k)}T12:00:00Z`).getUTCDay();
        if (d !== 1 && d !== 3 && d !== 5) continue;
        at(-k);
        doc.completeTask(run);
      }

      // Сегодня.
      at(-3);
      const report = doc.createTask({ title: t.report.title, projectId: P.work, priority: 1, due: due(0, '18:00'), duration: 60 });
      doc.updateTask(report, { deadline: addDays(today, 1) });
      const tiles = doc.createTask({ title: t.tiles.title, projectId: P.reno, priority: 2, due: due(0) });
      const s1 = doc.createTask({ title: t.tiles.subs[0], parentId: tiles });
      doc.createTask({ title: t.tiles.subs[1], parentId: tiles, due: due(0) });
      doc.createTask({ title: t.tiles.subs[2], parentId: tiles, due: due(3) });
      at(-1);
      doc.completeTask(s1);
      at(-2);
      doc.createTask({ title: t.groceries.title, projectId: P.home, labels: [L.shop], due: due(0, '19:30'), duration: 60 });
      doc.createTask({ title: t.call, projectId: P.home, labels: [L.call], due: due(0, '12:30'), duration: 45 });
      for (const title of t.undated) doc.createTask({ title });
      for (const u of t.upcoming) {
        const id = doc.createTask({
          title: u.title,
          projectId: P[u.project],
          priority: u.priority ?? 4,
          due: due(u.day, u.time),
          duration: u.duration ?? (u.time ? 60 : null),
          labels: u.label ? [L[u.label]] : [],
          recurrence: u.rec ? { rule: u.rec[0], mode: 'schedule', text: u.rec[1] } : null,
        });
        void id;
      }

      at(0);
      controller.clockOffset = -3 * 3600_000;
      doc.completeTask(run);
      controller.clockOffset = 0;

      doc.addCalendar({ name: t.calendars.work, url: calendars.work, color: 'blue' });
      doc.addCalendar({ name: t.calendars.family, url: calendars.family, color: 'pink' });
      await refreshCalendars();

      doc.logWork(habit, 25, { at: Date.now() - 3 * 3600_000 });
      localStorage.setItem('dela.calendarColor', 'project');
      localStorage.setItem('dela.calendarHideRepeats', '1');
      return habit;
    },
    { t, today: TODAY, calendars: { work: WORK_ICS, family: FAMILY_ICS } },
  );
}

async function openApp(browser, lang, device, colorScheme) {
  const t = TEXT[lang];
  const context = await browser.newContext({ ...device, locale: t.locale, timezoneId: TZ, colorScheme, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.clock.install({ time: FIXED_NOW });
  await page.clock.resume();
  await page.route(WORK_ICS, (r) => r.fulfill({ status: 200, contentType: 'text/calendar', headers: { 'Access-Control-Allow-Origin': '*' }, body: workIcs(t) }));
  await page.route(FAMILY_ICS, (r) => r.fulfill({ status: 200, contentType: 'text/calendar', headers: { 'Access-Control-Allow-Origin': '*' }, body: familyIcs(t) }));
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: t.tryLocal }).click();
  await page.locator('.task').first().waitFor();
  await seed(page, t);
  await page.goto(`${BASE}/#/today`);
  await page.locator('.day-event').first().waitFor();
  return { context, page, t };
}

/** Убрать курсор и всплывающие сообщения, дождаться шрифтов и анимаций. */
async function settle(page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.toast').evaluateAll((els) => els.forEach((e) => e.remove()));
  await page.waitForTimeout(700);
}

async function shoot(page, name) {
  await settle(page);
  const file = join(OUT, name);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  console.log('  ', name);
}

/** «Предстоящие» с завтрашнего дня: сегодняшние задачи уже есть на снимке «Сегодня». */
async function upcoming(page) {
  await page.goto(`${BASE}/#/upcoming`);
  await page.locator('section.day').nth(1).waitFor();
  await page.locator('section.day').nth(1).evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollTop > 0) p.scrollTop -= 24;
    if (window.scrollY > 0) window.scrollBy(0, -24);
  });
}

async function desktop(browser, lang) {
  const sfx = lang === 'en' ? '-en' : '';
  const { context, page, t } = await openApp(browser, lang, DESKTOP, 'light');

  await page.goto(`${BASE}/#/today`);
  await shoot(page, `today-light${sfx}.png`);

  // Помодоро идёт седьмую минуту.
  await page.evaluate(async (title) => {
    const { controller } = await import('/src/controller.ts');
    const { startPomodoro } = await import('/src/pomodoro.ts');
    const habit = controller.doc.allTasks().find((x) => x.title === title);
    startPomodoro(controller.doc, habit.id, Date.now() - 6.5 * 60_000);
  }, t.habit.title);
  await page.locator('.task', { hasText: t.habit.title }).first().click();
  await page.locator('.pomo-big').waitFor();
  await shoot(page, `task-panel${sfx}.png`);
  await page.keyboard.press('Escape');

  await page.goto(`${BASE}/#/stats`);
  await shoot(page, `stats${sfx}.png`);

  await page.goto(`${BASE}/#/calendar/week`);
  await page.locator('.cal-event').first().waitFor();
  await page.locator('.cal-time-grid').evaluate((el) => {
    const scroller = el.closest('.cal-scroll') ?? el;
    scroller.scrollTop = 0;
  });
  await shoot(page, `calendar-week${sfx}.png`);

  await page.goto(`${BASE}/#/today`);
  await page.locator('.task').first().waitFor();
  await page.keyboard.press('q');
  await page.getByLabel(t.newTask).pressSequentially(t.quickAdd, { delay: 5 });
  await shoot(page, `quick-add${sfx}.png`);
  await page.keyboard.press('Escape');

  await page.emulateMedia({ colorScheme: 'dark' });
  await upcoming(page);
  await shoot(page, `upcoming-dark${sfx}.png`);
  await context.close();
}

async function phone(browser, lang) {
  const sfx = lang === 'en' ? '-en' : '';
  const { context, page } = await openApp(browser, lang, PHONE, 'light');
  await page.goto(`${BASE}/#/today`);
  await shoot(page, `phone-today${sfx}.png`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await upcoming(page);
  await shoot(page, `phone-upcoming-dark${sfx}.png`);
  await context.close();
}

/** Баннер и коллаж: HTML-шаблоны в docs/images снимаются как есть. */
async function composites(browser, lang) {
  const sfx = lang === 'en' ? '-en' : '';
  const context = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(pathToFileURL(join(OUT, `banner${sfx}.html`)).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `banner${sfx}.png`) });
  console.log('  ', `banner${sfx}.png`);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(pathToFileURL(join(OUT, `screens${sfx}.html`)).href);
  await page.waitForLoadState('load');
  await page.locator('.grid').screenshot({ path: join(OUT, `screens${sfx}.png`) });
  console.log('  ', `screens${sfx}.png`);
  await context.close();
}

/** Сжатие: pngquant или oxipng, если есть; иначе Pillow (256 цветов), если есть Python. */
function compress(files) {
  if (process.env.DELA_SHOTS_RAW) return;
  const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
  if (has('pngquant')) {
    for (const f of files) spawnSync('pngquant', ['--force', '--skip-if-larger', '--quality=80-98', '--output', f, f], { stdio: 'inherit' });
  } else {
    const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0);
    if (python) {
      const code = [
        'import sys, os',
        'from PIL import Image',
        'for f in sys.argv[1:]:',
        '    im = Image.open(f).convert("RGB")',
        '    q = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG)',
        '    q.save(f + ".tmp", format="PNG", optimize=True)',
        '    os.replace(f + ".tmp", f) if os.path.getsize(f + ".tmp") < os.path.getsize(f) else os.remove(f + ".tmp")',
      ].join('\n');
      spawnSync(python, ['-c', code, ...files], { stdio: 'inherit' });
    } else console.log('pngquant и Pillow не найдены: PNG остаются без сжатия');
  }
  if (has('oxipng')) spawnSync('oxipng', ['-o', '4', '--strip', 'safe', ...files], { stdio: 'inherit' });
}

/** F-Droid: баннер и два снимка телефона на каждом языке. */
function fastlane() {
  const map = [
    ['ru-RU', ''],
    ['en-US', '-en'],
  ];
  for (const [dir, sfx] of map) {
    const base = join(ROOT, 'fastlane', 'metadata', 'android', dir, 'images');
    if (!existsSync(base)) continue;
    mkdirSync(join(base, 'phoneScreenshots'), { recursive: true });
    copyFileSync(join(OUT, `banner${sfx}.png`), join(base, 'featureGraphic.png'));
    copyFileSync(join(OUT, `phone-today${sfx}.png`), join(base, 'phoneScreenshots', '1.png'));
    copyFileSync(join(OUT, `phone-upcoming-dark${sfx}.png`), join(base, 'phoneScreenshots', '2.png'));
  }
}

const langs = process.argv.slice(2).filter((a) => a === 'ru' || a === 'en');
const LANGS = langs.length ? langs : ['ru', 'en'];

const server = await createServer({ configFile: join(ROOT, 'apps', 'web', 'vite.config.ts'), server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch();
try {
  for (const lang of LANGS) {
    console.log(lang);
    await desktop(browser, lang);
    await phone(browser, lang);
  }
  const sfxs = LANGS.map((l) => (l === 'en' ? '-en' : ''));
  const shots = sfxs.flatMap((s) => ['today-light', 'task-panel', 'stats', 'calendar-week', 'quick-add', 'upcoming-dark', 'phone-today', 'phone-upcoming-dark'].map((n) => join(OUT, `${n}${s}.png`)));
  compress(shots);
  for (const lang of LANGS) await composites(browser, lang);
  // Баннер не сжимается в 256 цветов: на тенях видны ступеньки.
  const composed = sfxs.flatMap((s) => [join(OUT, `banner${s}.png`), join(OUT, `screens${s}.png`)]);
  compress(composed.filter((f) => !f.includes('banner')));
  fastlane();
  for (const f of [...shots, ...composed]) console.log(`${(statSync(f).size / 1024).toFixed(0).padStart(5)} KB  ${f.slice(ROOT.length + 1)}`);
} finally {
  await browser.close();
  await server.close();
}
