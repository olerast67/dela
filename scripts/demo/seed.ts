/**
 * Демо-аккаунт для вызова «прочитай мою задачу»: правдоподобные данные обычного человека
 * за 8 недель и одна секретная задача, текст которой автор вводит сам.
 *
 *   node scripts/demo/seed.ts [--server URL] [--email ADDR] [--invite CODE] [--secret-prompt] [--tz ZONE] [--force]
 *
 * Пароль и секрет вводятся скрыто, не печатаются и никуда не пишутся. Подробности: scripts/demo/README.md.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiClient,
  ApiError,
  Doc,
  HybridClock,
  MemorySyncStore,
  SyncEngine,
  Workspace,
  addDays,
  addMonths,
  ensurePersonalSpace,
  initCrypto,
  isTimeZone,
  isoWeekday,
  newNodeId,
  passwordProof,
  persistLocal,
  signComment,
  signIn,
  signUp,
  signingKeys,
  spaceKeys,
  toB64,
  today as todayIn,
  zonedToUtc,
  type DateSpec,
  type KdfParams,
  type Priority,
  type Recurrence,
  type Session,
} from '#core';

export interface SeedOptions {
  readonly api: ApiClient;
  readonly email: string;
  readonly password: string;
  /** Код приглашения: регистрация на сервере закрыта. */
  readonly invite?: string;
  /** Текст секретной задачи; без него секретной задачи нет. */
  readonly secret?: string;
  readonly timeZone?: string;
  /** Текущее время, мс: от него считается «сегодня» и история. */
  readonly now?: number;
  /** Параметры Argon2id для новой регистрации (в тестах облегчённые). */
  readonly kdf?: KdfParams;
  /** Наполнять, даже если в аккаунте уже есть задачи. */
  readonly force?: boolean;
  /** Спросить пароль ещё раз перед регистрацией нового аккаунта. */
  readonly confirmPassword?: () => Promise<string>;
}

export interface SeedReport {
  readonly registered: boolean;
  readonly projects: number;
  readonly openTasks: number;
  readonly completedTasks: number;
  readonly habits: number;
  readonly completions: number;
  readonly focusSessions: number;
  readonly comments: number;
  readonly ops: number;
  readonly secret: boolean;
}

export class SeedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SeedError';
    this.code = code;
  }
}

const DEVICE_NAME = 'dela-demo-seed';

/** Детерминированный генератор: при каждом запуске одни и те же «случайные» дни и задачи. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function login(o: SeedOptions): Promise<{ session: Session; registered: boolean }> {
  try {
    return { session: await signIn(o.api, { email: o.email, password: o.password, deviceName: DEVICE_NAME }), registered: false };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'totp_required') {
      throw new SeedError('totp_required', 'На аккаунте включён TOTP: выключите его на время наполнения.');
    }
    if (!(err instanceof ApiError) || err.code !== 'invalid_credentials') throw err;
  }
  // Входа нет: либо аккаунта ещё нет, либо пароль неверный. Регистрация различит.
  if (o.confirmPassword && (await o.confirmPassword()) !== o.password) {
    throw new SeedError('password_mismatch', 'Пароли не совпали.');
  }
  try {
    const { session } = await signUp(o.api, {
      email: o.email,
      password: o.password,
      deviceName: DEVICE_NAME,
      ...(o.invite ? { invite: o.invite } : {}),
      ...(o.kdf ? { kdf: o.kdf } : {}),
    });
    return { session, registered: true };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === 'email_taken') throw new SeedError('wrong_password', 'Аккаунт с этой почтой есть, пароль не подошёл.');
      // Сервер проверяет приглашение раньше почты: так же отвечает и на неверный пароль от существующего аккаунта.
      if (err.code === 'invite_required') {
        throw new SeedError('invite_required', 'Вход не удался: либо пароль неверный, либо аккаунта нет и для регистрации нужен код приглашения (--invite).');
      }
      if (err.code === 'invalid_invite') throw new SeedError('invalid_invite', 'Код приглашения не подошёл: неверный, просрочен или уже использован.');
    }
    throw err;
  }
}

// ---------- содержимое ----------

type ProjectKey = 'work' | 'home' | 'bath' | 'sport' | 'reading' | 'trip' | 'inbox';
type LabelKey = 'call' | 'shop' | 'pc' | 'wait' | 'quick';

interface OpenTask {
  readonly title: string;
  readonly project: ProjectKey;
  readonly section?: string;
  /** Срок: дней от сегодня. */
  readonly due?: number;
  readonly time?: string;
  readonly priority?: Priority;
  readonly labels?: readonly LabelKey[];
  readonly description?: string;
  readonly subtasks?: ReadonlyArray<string | { readonly title: string; readonly done: number }>;
  /** Когда создана: дней назад. */
  readonly created: number;
}

const OPEN_TASKS: readonly OpenTask[] = [
  {
    title: 'Подготовить отчёт за третий квартал',
    project: 'work',
    section: 'Отчёт за квартал',
    due: 2,
    priority: 1,
    labels: ['pc'],
    created: 9,
    description:
      'Собрать цифры по продажам и сравнить с планом.\n\n- [x] Выгрузка из CRM\n- [ ] Сводная таблица по регионам\n- [ ] Графики для презентации\n- [ ] Отправить Марине на проверку',
    subtasks: [{ title: 'Выгрузить данные из CRM', done: 3 }, 'Свести таблицу по регионам', 'Сделать пять слайдов с графиками'],
  },
  { title: 'Ответить подрядчику по договору поставки', project: 'work', section: 'Текучка', due: -1, priority: 2, labels: ['pc'], created: 4 },
  { title: 'Обновить резюме', project: 'work', created: 45 },
  { title: 'Согласовать отпуск с руководителем', project: 'work', section: 'Текучка', due: 3, labels: ['wait'], created: 6 },
  { title: 'Разобрать входящую почту', project: 'work', section: 'Текучка', due: 0, labels: ['pc', 'quick'], created: 1 },
  {
    title: 'Посмотреть запись вебинара про сводные таблицы',
    project: 'work',
    priority: 4,
    created: 15,
    description: 'Запись лежит в общей папке отдела. Смотреть на скорости 1,5.',
  },
  {
    title: 'Купить продукты на неделю',
    project: 'home',
    due: 0,
    labels: ['shop'],
    created: 2,
    description: '- [ ] Молоко и кефир\n- [ ] Гречка, рис\n- [ ] Курица\n- [ ] Яблоки, бананы\n- [ ] Кофе в зёрнах\n- [x] Хлеб',
  },
  { title: 'Поменять фильтр в кувшине', project: 'home', due: 4, labels: ['quick'], created: 12 },
  {
    title: 'Разобрать балкон',
    project: 'home',
    created: 25,
    description: 'Освободить место под сушилку и велосипед.',
    subtasks: ['Вывезти старые коробки', 'Купить узкий стеллаж', 'Отдать санки соседям'],
  },
  {
    title: 'Выбрать плитку',
    project: 'bath',
    section: 'Закупка',
    due: 5,
    priority: 2,
    created: 18,
    description:
      'Бюджет до 2 500 ₽ за м², нужно около 18 м² на стены и 4 м² на пол.\n\n- [x] Съездить в два магазина\n- [ ] Взять образцы домой\n- [ ] Посчитать с запасом 10%',
    subtasks: ['Сравнить три варианта', 'Посчитать количество с запасом'],
  },
  { title: 'Найти сантехника на замену труб', project: 'bath', section: 'Работы', due: 1, priority: 1, labels: ['call'], created: 10 },
  { title: 'Купить смеситель и душевую стойку', project: 'bath', section: 'Закупка', due: 6, labels: ['shop'], created: 14 },
  { title: 'Согласовать смету с мастером', project: 'bath', section: 'Работы', due: 3, labels: ['wait'], created: 8 },
  { title: 'Заказать вывоз строительного мусора', project: 'bath', section: 'Работы', created: 16 },
  { title: 'Выбрать зеркало со шкафчиком', project: 'bath', section: 'Закупка', priority: 4, created: 17 },
  { title: 'Купить новые кроссовки для бега', project: 'sport', due: 7, labels: ['shop'], created: 11 },
  { title: 'Записаться в бассейн на абонемент', project: 'sport', due: 2, labels: ['call'], created: 5 },
  {
    title: 'Составить план тренировок на месяц',
    project: 'sport',
    priority: 3,
    created: 20,
    description: 'Три раза в неделю:\n\n- понедельник: бег 5 км\n- среда: силовая\n- пятница: бассейн',
  },
  { title: 'Дочитать «Отцы и дети»', project: 'reading', due: 5, created: 22 },
  { title: 'Вернуть книгу в библиотеку', project: 'reading', due: -2, priority: 2, created: 13 },
  { title: 'Выписать цитаты из прочитанного', project: 'reading', created: 19 },
  {
    title: 'Список книг на осень',
    project: 'reading',
    created: 27,
    description: '- [x] Тургенев, «Отцы и дети»\n- [ ] Чехов, рассказы\n- [ ] Гончаров, «Обломов»\n- [ ] Что-нибудь из нон-фикшна про привычки',
  },
  { title: 'Купить билеты на поезд', project: 'trip', section: 'До поездки', due: 0, time: '20:00', priority: 1, labels: ['pc'], created: 7 },
  {
    title: 'Забронировать гостиницу в центре',
    project: 'trip',
    section: 'До поездки',
    due: 1,
    priority: 2,
    created: 7,
    description: 'Две ночи, рядом с улицей Баумана. Завтрак желательно.',
  },
  {
    title: 'Составить маршрут на два дня',
    project: 'trip',
    section: 'На месте',
    created: 6,
    subtasks: ['Кремль и мечеть Кул-Шариф', 'Старо-Татарская слобода', 'Попробовать эчпочмак'],
  },
  { title: 'Взять пауэрбанк и зарядки', project: 'trip', section: 'До поездки', labels: ['quick'], created: 3 },
  { title: 'Узнать погоду на выходные', project: 'trip', section: 'До поездки', due: 6, created: 3 },
  { title: 'Позвонить бабушке', project: 'inbox', due: 0, priority: 1, labels: ['call'], created: 1 },
  { title: 'Вернуть Саше деньги за кино', project: 'inbox', due: -1, labels: ['quick'], created: 3 },
  { title: 'Проверить подписку на музыку', project: 'inbox', created: 9 },
  {
    title: 'Завести таблицу расходов',
    project: 'inbox',
    created: 21,
    description: 'Колонки: дата, категория, сумма, комментарий. Раз в неделю сверять с банком.',
  },
];

/** Выполненные разовые задачи для истории: проект и с какого дня назад они уместны. */
const DONE_POOL: ReadonlyArray<readonly [ProjectKey, string, number?]> = [
  ['work', 'Отправить счёт клиенту'],
  ['work', 'Сверить акты за прошлый месяц'],
  ['work', 'Подготовить повестку планёрки'],
  ['work', 'Заказать картриджи для принтера'],
  ['work', 'Ответить на вопросы по тендеру'],
  ['work', 'Обновить прайс на сайте'],
  ['work', 'Проверить договор с юристом'],
  ['work', 'Составить план на неделю'],
  ['work', 'Собрать обратную связь от клиентов'],
  ['work', 'Сделать презентацию для новичков'],
  ['work', 'Заполнить заявку на обучение'],
  ['work', 'Поздравить коллегу с днём рождения'],
  ['work', 'Разобрать задачи после отпуска'],
  ['work', 'Перенести встречу с поставщиком'],
  ['work', 'Выгрузить отчёт по остаткам'],
  ['work', 'Написать инструкцию по возвратам'],
  ['home', 'Оплатить интернет'],
  ['home', 'Вызвать мастера по стиральной машине'],
  ['home', 'Постирать шторы'],
  ['home', 'Купить лампочки в коридор'],
  ['home', 'Разобрать шкаф с одеждой'],
  ['home', 'Отнести вещи в пункт приёма'],
  ['home', 'Помыть окна'],
  ['home', 'Продлить страховку квартиры'],
  ['home', 'Заказать воду'],
  ['home', 'Починить дверцу шкафа'],
  ['home', 'Купить подарок племяннице'],
  ['home', 'Записать кота к ветеринару'],
  ['home', 'Забрать посылку на почте'],
  ['home', 'Поменять резину на машине'],
  ['sport', 'Купить коврик для йоги'],
  ['sport', 'Пробежать 5 км'],
  ['sport', 'Сходить на силовую'],
  ['sport', 'Записаться на пробное занятие'],
  ['sport', 'Пробежать 7 км'],
  ['sport', 'Растяжка после бега'],
  ['reading', 'Дочитать «Шинель»'],
  ['reading', 'Записаться в библиотеку'],
  ['reading', 'Прочитать статью про сон'],
  ['reading', 'Купить закладки'],
  ['bath', 'Снять старую плитку', 30],
  ['bath', 'Замерить ванную', 30],
  ['bath', 'Посмотреть видео про гидроизоляцию', 30],
  ['bath', 'Купить грунтовку', 28],
  ['bath', 'Спросить у соседей контакты плиточника', 28],
  ['bath', 'Вынести старую ванну', 25],
  ['bath', 'Купить затирку и крестики', 20],
  ['trip', 'Договориться с Олей о датах поездки', 20],
  ['trip', 'Посмотреть цены на гостиницы', 18],
  ['trip', 'Спросить у коллеги, где поесть в Казани', 15],
  ['inbox', 'Позвонить в поликлинику'],
  ['inbox', 'Оплатить штраф'],
  ['inbox', 'Перевести деньги маме'],
  ['inbox', 'Отменить пробную подписку'],
  ['inbox', 'Сдать анализы'],
  ['inbox', 'Распечатать фотографии'],
  ['inbox', 'Поздравить друга с новосельем'],
  ['inbox', 'Обновить приложение банка'],
  ['inbox', 'Отписаться от рассылок'],
  ['inbox', 'Забрать справку из МФЦ'],
  ['work', 'Подписать доверенность'],
  ['home', 'Купить батарейки'],
];

const HISTORY_DAYS = 56;
const SETUP_DAYS = 70;
const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const WEEKDAY_TEXT = ['каждый понедельник', 'каждый вторник', 'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу', 'каждое воскресенье'];

/**
 * Наполнить аккаунт. Время выполнения, создания и отрезков работы в прошлом задаётся значением полей
 * (часы Doc), а метки HLC идут по настоящим часам: сервер проверяет только, что метка не из будущего.
 */
export async function seedDemo(o: SeedOptions): Promise<SeedReport> {
  await initCrypto();
  const { session, registered } = await login(o);
  try {
    return await fill(o, session, registered);
  } finally {
    // Устройство наполнения выходит и в случае ошибки: лишних сессий не остаётся.
    await o.api.logout().catch(() => undefined);
  }
}

async function fill(o: SeedOptions, session: Session, registered: boolean): Promise<SeedReport> {
  const api = o.api;
  const { spaceId, spaceKey } = await ensurePersonalSpace(api, session.keys);

  const now = o.now ?? Date.now();
  const tz = o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let offset = 0;
  const clock = new HybridClock(newNodeId(), () => Date.now() + offset);
  // Часы полей: двигаются по истории, пока идёт наполнение.
  let at = now;
  const doc = new Doc({ spaceId, clock, now: () => at, timeZone: tz });
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
  let ops = 0;
  doc.subscribe((list, origin) => {
    if (origin === 'local') ops += list.length;
  });
  const sync = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await engine.sync();
  };
  await sync();

  const ws = new Workspace(doc);
  if (ws.allTasks().length > 0 && !o.force) {
    throw new SeedError('not_empty', 'В аккаунте уже есть задачи. Наполнять можно только пустой демо-аккаунт (или с --force).');
  }

  const T = todayIn(tz, now);
  const random = rng(20261021);
  const pick = <V>(list: readonly V[]): V => list[Math.floor(random() * list.length)]!;
  /** Момент дня в поясе пользователя. */
  const moment = (date: string, time: string): number => zonedToUtc(date, time, tz);
  const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const randomTime = (from: number, to: number) => hhmm(from * 60 + Math.floor(random() * (to - from) * 60));

  // События по времени: каждое пишется с часами полей на своём моменте, поэтому порядок записей
  // (и номера seq на сервере) идёт как при обычном пользовании, а секрет оказывается в середине.
  const events: Array<{ at: number; order: number; run: () => void }> = [];
  // Сегодняшние события позже «сейчас» не наступили и не пишутся.
  const on = (t: number, run: () => void) => {
    if (t < now - 60_000) events.push({ at: t, order: events.length, run });
  };

  const projects = {} as Record<ProjectKey, string>;
  const labels = {} as Record<LabelKey, string>;
  const sections = new Map<string, string>();
  const stats = { focus: 0, comments: 0 };
  const sectionOf = (project: ProjectKey, name: string | undefined) => (name ? sections.get(`${project}/${name}`) ?? null : null);

  // Начало: «Входящие», метки, основные проекты. Раньше истории: с них начинаются ежемесячные повторы.
  const start = addDays(T, -SETUP_DAYS);
  on(moment(start, '20:10'), () => {
    projects.inbox = ws.personal.ensureInbox();
    const L: Array<[LabelKey, string, string]> = [
      ['call', 'звонок', 'green'],
      ['shop', 'магазин', 'orange'],
      ['pc', 'компьютер', 'blue'],
      ['wait', 'жду ответа', 'gray'],
      ['quick', 'быстро', 'yellow'],
    ];
    for (const [key, name, color] of L) labels[key] = ws.personal.createLabel(name, color);
    projects.work = ws.createProject({ name: 'Работа', color: 'blue' });
    ws.updateProject(projects.work, { favorite: true });
    for (const s of ['Текучка', 'Отчёт за квартал']) sections.set(`work/${s}`, ws.createSection(projects.work, s));
    projects.home = ws.createProject({ name: 'Дом', color: 'green' });
    projects.sport = ws.createProject({ name: 'Спорт', color: 'red' });
    projects.reading = ws.createProject({ name: 'Чтение', color: 'violet' });
  });
  on(moment(addDays(T, -36), '21:05'), () => {
    projects.bath = ws.createProject({ name: 'Ремонт ванной', color: 'orange', view: 'board' });
    for (const s of ['Закупка', 'Работы']) sections.set(`bath/${s}`, ws.createSection(projects.bath, s));
  });
  on(moment(addDays(T, -26), '22:15'), () => {
    projects.trip = ws.createProject({ name: 'Поездка в Казань', color: 'teal' });
    for (const s of ['До поездки', 'На месте']) sections.set(`trip/${s}`, ws.createSection(projects.trip, s));
  });
  on(moment(addDays(T, -30), '09:00'), () => ws.updateGameSettings({ dailyGoal: 4, weeklyGoal: 20, restDays: [7], weeklyReviewDay: 7, weeklyReviewTime: '19:00' }));

  // Открытые задачи.
  const ids = new Map<string, string>();
  for (const t of OPEN_TASKS) {
    const createdDay = addDays(T, -t.created);
    const createdAt = moment(createdDay, randomTime(8, 22));
    on(createdAt, () => {
      const due: DateSpec | undefined = t.due === undefined ? undefined : { date: addDays(T, t.due), ...(t.time ? { time: t.time } : {}) };
      const id = ws.createTask({
        title: t.title,
        projectId: projects[t.project],
        sectionId: sectionOf(t.project, t.section),
        ...(t.description ? { description: t.description } : {}),
        ...(t.priority ? { priority: t.priority } : {}),
        ...(due ? { due } : {}),
        labels: (t.labels ?? []).map((l) => labels[l]),
      });
      ids.set(t.title, id);
      for (const sub of t.subtasks ?? []) {
        const title = typeof sub === 'string' ? sub : sub.title;
        const subId = ws.createTask({ title, parentId: id });
        ids.set(title, subId);
      }
    });
    for (const sub of t.subtasks ?? []) {
      if (typeof sub === 'string') continue;
      on(moment(addDays(T, -sub.done), randomTime(10, 19)), () => {
        ws.completeTask(ids.get(sub.title)!);
      });
    }
  }

  // Задача, которую дважды переносили: попадёт в итоги недели.
  on(moment(addDays(T, -14), '19:40'), () => {
    ids.set('dentist', ws.createTask({ title: 'Записаться к стоматологу', projectId: projects.home, priority: 2, labels: [labels.call], due: { date: addDays(T, -10) } }));
  });
  on(moment(addDays(T, -10), '21:30'), () => ws.updateTask(ids.get('dentist')!, { due: { date: addDays(T, -6) } }));
  on(moment(addDays(T, -6), '22:05'), () => ws.updateTask(ids.get('dentist')!, { due: { date: addDays(T, -3) } }));

  // Секретная задача: в отдельном проекте с нейтральным названием, без срока и напоминаний.
  if (o.secret) {
    const secret = o.secret;
    on(moment(addDays(T, -12), '21:40'), () => {
      const personal = ws.createProject({ name: 'Личное', color: 'gray' });
      ws.createTask({ title: secret, projectId: personal });
    });
  }

  // Повторяющиеся задачи с историей выполнений.
  const weekly = (date: string): Recurrence => ({ rule: `FREQ=WEEKLY;BYDAY=${BYDAY[isoWeekday(date) - 1]}`, mode: 'schedule', text: WEEKDAY_TEXT[isoWeekday(date) - 1]! });
  const nextWeekday = (from: string, iso: number) => addDays(from, (iso - isoWeekday(from) + 7) % 7);
  interface Repeating {
    readonly title: string;
    readonly project: ProjectKey;
    readonly first: string;
    readonly recurrence: Recurrence;
    readonly time?: string;
    readonly labels?: readonly LabelKey[];
    readonly priority?: Priority;
    /** Когда отмечают выполненным: часы. */
    readonly doneAt: readonly [number, number];
    /** Вероятность отметить в срок; иначе — на следующий день. */
    readonly onTime: number;
    /** Дни, в которые выполнения нет (срок остаётся просроченным). */
    readonly skipFrom?: string;
  }
  const repeating: Repeating[] = [
    { title: 'Созвон с командой', project: 'work', first: addDays(T, -35), recurrence: weekly(T), time: '11:00', labels: ['call'], doneAt: [11, 12], onTime: 1 },
    {
      title: 'Заполнить таймшит',
      project: 'work',
      first: addDays(nextWeekday(T, 5), -42),
      recurrence: { rule: 'FREQ=WEEKLY;BYDAY=FR', mode: 'schedule', text: 'каждую пятницу' },
      labels: ['pc'],
      doneAt: [17, 19],
      onTime: 0.8,
    },
    {
      title: 'Оплатить коммуналку',
      project: 'home',
      first: addMonths(addDays(T, -1), -2),
      recurrence: { rule: 'FREQ=MONTHLY', mode: 'schedule', text: 'каждый месяц' },
      labels: ['pc'],
      priority: 2,
      doneAt: [19, 22],
      onTime: 0.7,
      skipFrom: addDays(T, -1),
    },
    {
      title: 'Передать показания счётчиков',
      project: 'home',
      first: addMonths(addDays(T, 5), -2),
      recurrence: { rule: 'FREQ=MONTHLY', mode: 'schedule', text: 'каждый месяц' },
      labels: ['pc', 'quick'],
      doneAt: [9, 21],
      onTime: 0.9,
    },
    {
      title: 'Вынести мусор',
      project: 'home',
      first: addDays(T, -48),
      recurrence: { rule: 'FREQ=DAILY;INTERVAL=2', mode: 'schedule', text: 'каждые 2 дня' },
      doneAt: [8, 10],
      onTime: 0.85,
    },
    {
      title: 'Полить цветы',
      project: 'home',
      first: addDays(T, -45),
      recurrence: { rule: 'FREQ=DAILY;INTERVAL=3', mode: 'completion', text: 'каждые 3 дня после выполнения' },
      doneAt: [19, 21],
      onTime: 0.8,
    },
  ];
  for (const r of repeating) {
    on(moment(addDays(r.first, -1), randomTime(18, 22)), () => {
      ids.set(r.title, ws.createTask({
        title: r.title,
        projectId: projects[r.project],
        due: { date: r.first, ...(r.time ? { time: r.time } : {}) },
        recurrence: r.recurrence,
        labels: (r.labels ?? []).map((l) => labels[l]),
        ...(r.priority ? { priority: r.priority } : {}),
      }));
    });
    for (let d = r.first; d < T; d = addDays(d, 1)) {
      if (r.skipFrom && d >= r.skipFrom) break;
      const day = d;
      on(moment(day, randomTime(r.doneAt[0], r.doneAt[1])), () => {
        const id = ids.get(r.title)!;
        const due = ws.task(id)?.due?.date;
        if (!due || due > day) return;
        // В срок или днём позже: просроченное отмечают на следующий день.
        if (due === day && random() > r.onTime) return;
        ws.completeTask(id);
      });
    }
  }

  // Привычки: 6 недель, серии с пропусками.
  const habits: Array<{ title: string; project: ProjectKey; rule: string; text: string; skipsPerWeek: number; time: [number, number]; p: number }> = [
    { title: 'Зарядка 10 минут', project: 'sport', rule: 'FREQ=DAILY', text: 'каждый день', skipsPerWeek: 1, time: [7, 8], p: 0.82 },
    { title: 'Читать 20 страниц', project: 'reading', rule: 'FREQ=DAILY', text: 'каждый день', skipsPerWeek: 2, time: [21, 23], p: 0.76 },
    { title: 'Английский 15 минут', project: 'inbox', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', text: 'по будням', skipsPerWeek: 0, time: [12, 14], p: 0.86 },
  ];
  const habitStart = addDays(T, -41);
  for (const h of habits) {
    const first = h.rule.includes('BYDAY') && isoWeekday(habitStart) > 5 ? nextWeekday(habitStart, 1) : habitStart;
    on(moment(addDays(first, -1), '20:30'), () => {
      ids.set(h.title, ws.createTask({
        title: h.title,
        projectId: projects[h.project],
        due: { date: first },
        recurrence: { rule: h.rule, mode: 'schedule', text: h.text },
        habit: { skipsPerWeek: h.skipsPerWeek },
      }));
    });
    // Последние три дня привычки выполнены: в «Сегодня» нет старых хвостов.
    for (let d = first; d <= T; d = addDays(d, 1)) {
      const day = d;
      const recent = day >= addDays(T, -3);
      on(moment(day, randomTime(h.time[0], h.time[1])), () => {
        const id = ids.get(h.title)!;
        const due = ws.task(id)?.due?.date;
        if (!due || due > day) return;
        const roll = random();
        if (recent || roll < h.p) {
          ws.completeTask(id);
        } else if (roll < h.p + 0.05) ws.skipOccurrence(id);
      });
    }
  }

  // Разовые выполненные задачи: больше в будни, меньше в выходные, бывают пустые дни.
  const pool = [...DONE_POOL];
  for (let back = HISTORY_DAYS - 1; back >= 0 && pool.length > 0; back--) {
    const day = addDays(T, -back);
    const weekday = isoWeekday(day);
    const n = weekday === 7 ? Math.floor(random() * 2) : weekday === 6 ? Math.floor(random() * 3) : random() < 0.12 ? 0 : 1 + Math.floor(random() * 2);
    for (let i = 0; i < n; i++) {
      const idx = pool.findIndex(([, , from]) => from === undefined || back <= from);
      if (idx < 0) break;
      const [project, title] = pool.splice(idx, 1)[0]!;
      const doneAt = moment(day, randomTime(9, 22));
      if (doneAt >= now - 60_000) continue;
      const lead = Math.floor(random() * 6);
      const createdAt = Math.min(moment(addDays(day, -lead), randomTime(8, 12)), doneAt - 3600_000);
      const priority = pick<Priority>([4, 4, 4, 3, 2]);
      on(createdAt, () => {
        ids.set(title, ws.createTask({
          title,
          projectId: projects[project],
          ...(priority !== 4 ? { priority } : {}),
          ...(random() < 0.5 ? { due: { date: day } } : {}),
        }));
      });
      on(doneAt, () => {
        ws.completeTask(ids.get(title)!);
      });
    }
  }

  // Помодоро: законченные отрезки по 25 минут в будни, иногда прерванный.
  const focusTargets = ['Подготовить отчёт за третий квартал', 'Посмотреть запись вебинара про сводные таблицы', 'Обновить резюме', 'Дочитать «Отцы и дети»'];
  for (let back = 42; back >= 1; back--) {
    const day = addDays(T, -back);
    if (isoWeekday(day) > 5 || random() < 0.35) continue;
    const sessions = 1 + Math.floor(random() * 4);
    let minute = 9 * 60 + 30 + Math.floor(random() * 120);
    for (let i = 0; i < sessions; i++) {
      const cut = i === sessions - 1 && random() < 0.25;
      const minutes = cut ? 8 + Math.floor(random() * 10) : 25;
      minute += minutes;
      const end = moment(day, hhmm(minute));
      minute += 5 + Math.floor(random() * 20);
      const target = pick(focusTargets);
      on(end, () => {
        const id = ids.get(target);
        if (!id) return;
        ws.logWork(id, minutes, { at: end, focus: cut ? 'cut' : 'full' });
        stats.focus++;
      });
    }
  }

  // Комментарии: подписаны ключом аккаунта, как в приложении.
  const sign = signingKeys(session.keys.masterKey);
  const comments: Array<[string, number, string]> = [
    ['Найти сантехника на замену труб', 4, 'Мастер из объявления обещал перезвонить в четверг. Если нет, спрошу в чате дома.'],
    ['Подготовить отчёт за третий квартал', 2, 'Марина просила добавить сравнение с прошлым годом.'],
  ];
  for (const [title, back, text] of comments) {
    on(moment(addDays(T, -back), randomTime(12, 20)), () => {
      const id = ids.get(title);
      if (!id) return;
      ws.addComment(id, { text, author: session.userId, sign: (c) => signComment(sign.secretKey, c) });
      stats.comments++;
    });
  }

  // Выполнить по времени.
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  for (const e of events) {
    at = e.at;
    e.run();
  }
  at = now;

  // Ключ подписи комментариев: из свежей сессии ставится без пароля.
  const signPublicKey = toB64(sign.publicKey);
  const account = await api.account();
  if (account.signPublicKey !== signPublicKey) {
    try {
      await api.setSignKey({ signPublicKey });
    } catch (err) {
      if (!(err instanceof ApiError) || (err.code !== 'sign_key_password' && err.code !== 'sign_key_mismatch')) throw err;
      await api.setSignKey({ signPublicKey, authSecret: await passwordProof(api, o.password) });
    }
  }

  await sync();
  const tasks = ws.allTasks();
  const report: SeedReport = {
    registered,
    projects: ws.projects().length,
    openTasks: tasks.filter((t) => t.completedAt === null).length,
    completedTasks: tasks.filter((t) => t.completedAt !== null).length,
    habits: tasks.filter((t) => t.habit).length,
    completions: ws.completions().length,
    focusSessions: stats.focus,
    comments: stats.comments,
    ops,
    secret: Boolean(o.secret),
  };
  return report;
}

// ---------- командная строка ----------

/** Чтение строк stdin, когда он не терминал (запуск из скрипта). */
let pipedLines: string[] | null = null;
async function pipedLine(): Promise<string> {
  if (pipedLines === null) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  return pipedLines.shift() ?? '';
}

/** Строка с клавиатуры. hidden — без эха: ни символов, ни звёздочек (длина тоже секрет). */
export async function ask(question: string, hidden = false): Promise<string> {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    const line = await pipedLine();
    process.stderr.write('\n');
    return line;
  }
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolveLine) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          resolveLine(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          const chars = [...value];
          chars.pop();
          value = chars.join('');
          if (!hidden) process.stderr.write('\b \b');
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        if (!hidden) process.stderr.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}

function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new SeedError('usage', `Непонятный аргумент: ${a}`);
    const [key, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (inline !== undefined) out[key] = inline;
    else if (['secret-prompt', 'force', 'help'].includes(key)) out[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new SeedError('usage', `Нет значения у --${key}`);
      out[key] = v;
    }
  }
  return out;
}

const USAGE = `Наполнение демо-аккаунта Dela.
  node scripts/demo/seed.ts [--server URL] [--email ADDR] [--invite CODE] [--secret-prompt] [--tz ZONE] [--force]
Пароль и секрет спрашиваются скрыто. Подробности: scripts/demo/README.md`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  const server = (str('server') ?? (await ask('Адрес сервера (https://...): '))).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(server)) throw new SeedError('usage', 'Адрес сервера должен начинаться с https://');
  const email = (str('email') ?? (await ask('Почта демо-аккаунта: '))).trim();
  const tz = str('tz');
  if (tz !== undefined && !isTimeZone(tz)) throw new SeedError('usage', `Неизвестный пояс: ${tz}`);
  const password = await ask('Пароль (ввод скрыт): ', true);
  if (password.length < 8) throw new SeedError('usage', 'Пароль короче 8 символов.');
  let secret: string | undefined;
  if (args['secret-prompt']) {
    secret = (await ask('Текст секретной задачи (ввод скрыт): ', true)).trim();
    if (!secret) throw new SeedError('usage', 'Пустой секрет.');
    if ((await ask('Секрет ещё раз (ввод скрыт): ', true)).trim() !== secret) throw new SeedError('usage', 'Секреты не совпали.');
  }
  const invite = str('invite');
  console.log(`Вход на ${server}...`);
  const report = await seedDemo({
    api: new ApiClient(server),
    email,
    password,
    ...(invite ? { invite } : {}),
    ...(secret ? { secret } : {}),
    ...(tz ? { timeZone: tz } : {}),
    force: args.force === true,
    confirmPassword: () => ask('Вход не удался. Если аккаунта ещё нет, он будет создан: пароль ещё раз (ввод скрыт): ', true),
  });
  console.log(
    [
      report.registered ? 'Аккаунт зарегистрирован. Ключ восстановления не показан: для демо он не нужен.' : 'Вход в существующий аккаунт.',
      `Проектов: ${report.projects}, задач открыто: ${report.openTasks}, выполнено: ${report.completedTasks}, привычек: ${report.habits}.`,
      `Выполнений повторов и привычек: ${report.completions}, отрезков помодоро: ${report.focusSessions}, комментариев: ${report.comments}.`,
      `Операций отправлено: ${report.ops}. Секретная задача: ${report.secret ? 'добавлена' : 'нет (без --secret-prompt)'}.`,
    ].join('\n'),
  );
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked) {
  main().catch((err: unknown) => {
    // Только код и сообщение: значения полей (и секрет) в ошибки не попадают.
    if (err instanceof SeedError) console.error(err.message);
    else if (err instanceof ApiError) console.error(`Ошибка сервера: ${err.code} (${err.status})`);
    else console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'Неизвестная ошибка');
    process.exit(1);
  });
}
