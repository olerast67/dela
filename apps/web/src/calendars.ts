/**
 * События внешних календарей на этом устройстве: подписки iCal и календари телефона.
 *
 * Подписки (название, ссылка, цвет) лежат зашифрованными в личном пространстве и синхронизируются.
 * Файлы календарей каждое устройство скачивает само, прямо с сервера календаря, и хранит в IndexedDB
 * зашифрованными ключом устройства (как и задачи); на сервер Dela ни ссылки, ни события открыто не попадают. Ссылка — секрет: она не пишется в журнал
 * и не хранится в кеше (кеш узнаёт её по хешу). События календарей телефона не покидают телефон вовсе.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import { windowBounds, type CalEvent, type CalendarSub } from '#core';
import { FeedTooLargeError, declaredTooLarge, MAX_CALENDAR_BYTES, openFeed, readCapped, sealFeed, type SealedFeed } from './calendarFeed.ts';
import { controller } from './controller.ts';
import { TZ } from './format.ts';
import type { ParsedCalendar } from './ical.ts';
import { nativePlugin, platform } from './platform.ts';

type IcalModule = typeof import('./ical.ts');

/** Как часто обновлять подписки, пока приложение открыто. */
export const REFRESH_MS = 30 * 60_000;

export type FeedError = 'cors' | 'network' | 'http' | 'parse' | 'large';

export interface FeedStatus {
  readonly fetchedAt: number | null;
  readonly error: FeedError | null;
  /** Код ответа сервера календаря при ошибке http. */
  readonly code?: number;
  readonly busy: boolean;
  readonly count: number;
}

class CalendarFetchError extends Error {
  readonly kind: FeedError;
  readonly code: number | undefined;
  constructor(kind: FeedError, code?: number) {
    super(kind);
    this.kind = kind;
    this.code = code;
  }
}

// ---------- кеш файлов в IndexedDB ----------

interface CacheSchema extends DBSchema {
  feeds: { key: string; value: SealedFeed };
}

let dbPromise: Promise<IDBPDatabase<CacheSchema>> | null = null;

function db(): Promise<IDBPDatabase<CacheSchema>> {
  // Версия 2: текст файла зашифрован. Открытые записи версии 1 стираются, файлы скачаются заново.
  dbPromise ??= openDB<CacheSchema>('dela-calendars', 2, {
    upgrade(d, _old, _new, tx) {
      if (!d.objectStoreNames.contains('feeds')) d.createObjectStore('feeds');
      else void tx.objectStore('feeds').clear();
    },
  });
  return dbPromise;
}

/** Кеш с прошлого запуска. Только при открытой сессии: ключ устройства живёт в хранилище приложения. */
async function readCache(id: string): Promise<{ hash: string; text: string; fetchedAt: number } | null> {
  if (!controller.doc) return null;
  const rec = await db()
    .then((d) => d.get('feeds', id))
    .catch(() => undefined);
  return openFeed(controller.store, rec);
}

async function writeCache(id: string, hash: string, text: string, fetchedAt: number): Promise<void> {
  if (!controller.doc) return;
  try {
    const rec = await sealFeed(controller.store, hash, text, fetchedAt);
    await (await db()).put('feeds', rec, id);
  } catch {
    // кеш не обязателен: без него события просто скачаются при следующем запуске
  }
}

async function urlHash(url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- загрузка ----------

/**
 * Скачать файл календаря. В браузере работает, только если сервер календаря разрешает запросы
 * с других сайтов (CORS). Приложения на Windows и Android ходят без этого ограничения.
 */
async function download(url: string): Promise<string> {
  const p = platform();
  if (p === 'tauri') {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<string>('fetch_calendar', { url });
    } catch (err) {
      const m = /^http (\d+)$/.exec(String(err));
      if (m) throw new CalendarFetchError('http', Number(m[1]));
      throw new CalendarFetchError(String(err) === 'large' ? 'large' : 'network');
    }
  }
  if (p === 'capacitor') {
    const { CapacitorHttp } = await import('@capacitor/core');
    let r;
    try {
      r = await CapacitorHttp.get({ url, responseType: 'text', connectTimeout: 20_000, readTimeout: 60_000 });
    } catch {
      throw new CalendarFetchError('network');
    }
    if (r.status < 200 || r.status >= 300) throw new CalendarFetchError('http', r.status);
    // CapacitorHttp отдаёт ответ целиком, потока нет: предел проверяется уже после загрузки, до разбора.
    const length = Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-length')?.[1];
    const body = typeof r.data === 'string' ? r.data : String(r.data ?? '');
    if (declaredTooLarge(length) || body.length > MAX_CALENDAR_BYTES) throw new CalendarFetchError('large');
    return body;
  }
  let r: Response;
  try {
    r = await fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60_000) });
  } catch {
    // Браузер не говорит, что именно случилось: при живой сети почти всегда это запрет CORS.
    throw new CalendarFetchError(navigator.onLine === false ? 'network' : 'cors');
  }
  if (!r.ok) throw new CalendarFetchError('http', r.status);
  try {
    return await readCapped(r);
  } catch (err) {
    throw new CalendarFetchError(err instanceof FeedTooLargeError ? 'large' : 'network');
  }
}

// ---------- состояние ----------

interface Feed {
  readonly hash: string;
  readonly parsed: ParsedCalendar | null;
  readonly fetchedAt: number | null;
}

let ical: IcalModule | null = null;
let icalLoading: Promise<IcalModule> | null = null;
const feeds = new Map<string, Feed>();
const status = new Map<string, FeedStatus>();
const listeners = new Set<() => void>();
let version = 0;
let started = false;
let signature = '';

function changed(): void {
  version++;
  expandCache.clear();
  for (const fn of listeners) fn();
}

function loadIcal(): Promise<IcalModule> {
  icalLoading ??= import('./ical.ts').then((m) => (ical = m));
  return icalLoading;
}

function subs(): CalendarSub[] {
  return controller.doc?.calendars() ?? [];
}

function setStatus(id: string, patch: Partial<FeedStatus>): void {
  const prev = status.get(id) ?? { fetchedAt: null, error: null, busy: false, count: 0 };
  status.set(id, { ...prev, ...patch });
}

function eventCount(parsed: ParsedCalendar | null): number {
  return parsed?.events.length ?? 0;
}

/** Разобрать текст и запомнить. Ошибка разбора остаётся в статусе, прежние события не теряются. */
async function accept(sub: CalendarSub, hash: string, text: string, fetchedAt: number): Promise<boolean> {
  const m = await loadIcal();
  try {
    const parsed = m.parseCalendar(text);
    feeds.set(sub.id, { hash, parsed, fetchedAt });
    setStatus(sub.id, { fetchedAt, error: null, count: eventCount(parsed) });
    return true;
  } catch {
    setStatus(sub.id, { error: text.length > m.MAX_ICS_BYTES ? 'large' : 'parse' });
    return false;
  }
}

async function refreshOne(sub: CalendarSub, force: boolean): Promise<void> {
  const hash = await urlHash(sub.url);
  let feed = feeds.get(sub.id);
  if (feed?.hash !== hash) {
    feed = undefined;
    feeds.delete(sub.id);
    // Кеш с прошлого запуска: события видны сразу, даже без сети.
    const cached = await readCache(sub.id);
    if (cached && cached.hash === hash && (await accept(sub, hash, cached.text, cached.fetchedAt))) {
      feed = feeds.get(sub.id);
      changed();
    }
  }
  if (!force && feed?.fetchedAt && Date.now() - feed.fetchedAt < REFRESH_MS) return;
  if (status.get(sub.id)?.busy) return;
  setStatus(sub.id, { busy: true });
  changed();
  try {
    const text = await download(sub.url);
    const now = Date.now();
    if (await accept(sub, hash, text, now)) await writeCache(sub.id, hash, text, now);
  } catch (err) {
    const e = err instanceof CalendarFetchError ? err : new CalendarFetchError('network');
    setStatus(sub.id, { error: e.kind, ...(e.code !== undefined ? { code: e.code } : {}) });
  } finally {
    setStatus(sub.id, { busy: false });
    changed();
  }
}

/** Привести кеш к списку подписок: загрузить новые, убрать удалённые. */
async function reconcile(force = false): Promise<void> {
  const list = subs().filter((s) => s.enabled);
  const alive = new Set(subs().map((s) => s.id));
  let dropped = false;
  for (const id of [...feeds.keys(), ...status.keys()]) {
    if (!alive.has(id)) {
      if (feeds.delete(id)) dropped = true;
      if (status.delete(id)) dropped = true;
    }
  }
  if (dropped) changed();
  // Кеш подписок, удалённых на другом устройстве, пока это было выключено.
  if (controller.doc) {
    const store = await db().catch(() => null);
    const keys = (await store?.getAllKeys('feeds').catch(() => [])) ?? [];
    for (const id of keys) if (!alive.has(id)) await store?.delete('feeds', id).catch(() => undefined);
  }
  await Promise.all(list.map((s) => refreshOne(s, force)));
}

function start(): void {
  if (started) return;
  started = true;
  const check = () => {
    // Подпись живёт только в памяти: ссылка в ней никуда не уходит.
    const next = subs()
      .map((s) => `${s.id}|${s.enabled ? 1 : 0}|${s.color}|${s.name}|${s.url}`)
      .join('\n');
    if (next === signature) return;
    signature = next;
    changed();
    void reconcile();
  };
  controller.subscribeDoc(check);
  check();
  setInterval(() => {
    void reconcile();
    deviceRange = null;
    changed();
  }, REFRESH_MS);
}

/** Обновить все подписки сейчас (кнопка в настройках). */
export async function refreshCalendars(): Promise<void> {
  deviceRange = null;
  changed();
  await reconcile(true);
}

/** Выход из аккаунта: кеш событий и выбор календарей телефона стираются. */
export async function clearCalendars(): Promise<void> {
  feeds.clear();
  status.clear();
  signature = '';
  deviceEvents = [];
  deviceRange = null;
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // нет хранилища — нечего стирать
  }
  // Без уведомления подписчиков: экраны с задачами в этот момент уходят, а документа уже нет.
  version++;
  expandCache.clear();
  await db()
    .then((d) => d.clear('feeds'))
    .catch(() => undefined);
}

export function feedStatus(id: string): FeedStatus | null {
  return status.get(id) ?? null;
}

function subscribe(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getVersion(): number {
  return version;
}

/** Перерисовать компонент при изменении событий или статуса подписок. */
export function useCalendarsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}

// ---------- календари телефона (Android) ----------

const DEVICE_KEY = 'dela.deviceCalendars';

export interface DeviceCalendar {
  readonly id: string;
  readonly name: string;
  readonly account: string;
  readonly color: string;
}

interface DevicePrefs {
  readonly on: boolean;
  /** Выбранные календари; null — все. */
  readonly ids: readonly string[] | null;
}

interface DevicePlugin {
  checkPermissions(): Promise<{ calendar: string }>;
  requestPermissions(): Promise<{ calendar: string }>;
  calendars(): Promise<{ calendars: Array<{ id: string; name: string; account: string; color: number }> }>;
  events(o: { from: number; to: number; ids: string[] | null }): Promise<{
    events: Array<{ id: string; calendar: string; title: string; location: string; description: string; begin: number; end: number; allDay: boolean; color: number }>;
  }>;
}

/**
 * Плагин календарей телефона в обёртке { p }. Сам прокси Capacitor нельзя возвращать из async-функции:
 * await вызвал бы у него then(), и промис не завершился бы никогда (см. nativePlugin).
 */
const plugin = () => nativePlugin<DevicePlugin>('DeviceCalendar');

export function devicePrefs(): DevicePrefs {
  try {
    const v = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? 'null') as DevicePrefs | null;
    if (v && typeof v.on === 'boolean') return { on: v.on, ids: Array.isArray(v.ids) ? v.ids.map(String) : null };
  } catch {
    // повреждённая настройка — как выключенная
  }
  return { on: false, ids: null };
}

export function setDevicePrefs(p: DevicePrefs): void {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(p));
  } catch {
    // без хранилища настройка живёт до перезапуска
  }
  deviceRange = null;
  deviceEvents = [];
  changed();
}

export function deviceCalendarsSupported(): boolean {
  return platform() === 'capacitor';
}

/** Спросить разрешение READ_CALENDAR. true — разрешено. */
export async function requestDeviceAccess(): Promise<boolean> {
  const p = (await plugin())?.p;
  if (!p) return false;
  if ((await p.checkPermissions()).calendar === 'granted') return true;
  return (await p.requestPermissions()).calendar === 'granted';
}

function argb(c: number): string {
  return `#${((c >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

export async function deviceCalendars(): Promise<DeviceCalendar[]> {
  const p = (await plugin())?.p;
  if (!p) return [];
  const r = await p.calendars();
  return r.calendars.map((c) => ({ id: String(c.id), name: c.name, account: c.account, color: argb(c.color) }));
}

let deviceEvents: CalEvent[] = [];
let deviceRange: { from: number; to: number } | null = null;
let deviceLoading = false;

/** Догрузить события телефона, если окно вышло за уже загруженный отрезок. Повторы разворачивает сам Android. */
function ensureDevice(from: number, to: number): void {
  const prefs = devicePrefs();
  if (!prefs.on || platform() !== 'capacitor' || deviceLoading) return;
  if (deviceRange && deviceRange.from <= from && deviceRange.to >= to) return;
  deviceLoading = true;
  // С запасом в два месяца в обе стороны: листание календаря не дёргает Android на каждом шаге.
  const range = { from: from - 60 * 86_400_000, to: to + 60 * 86_400_000 };
  void (async () => {
    try {
      const p = (await plugin())?.p;
      if (!p || (await p.checkPermissions()).calendar !== 'granted') return;
      const r = await p.events({ ...range, ids: prefs.ids ? [...prefs.ids] : null });
      deviceEvents = r.events.map((e): CalEvent => {
        const base = {
          id: `device:${e.id}`,
          calendar: `device:${e.calendar}`,
          title: e.title,
          location: e.location,
          description: e.description,
          color: argb(e.color),
        };
        if (!e.allDay) return { ...base, allDay: false, start: e.begin, end: e.end };
        // У целодневных событий Android отдаёт полночь UTC.
        const startDate = new Date(e.begin).toISOString().slice(0, 10);
        const endDate = new Date(Math.max(e.end, e.begin + 86_400_000)).toISOString().slice(0, 10);
        return { ...base, allDay: true, startDate, endDate };
      });
      deviceRange = range;
    } catch {
      // нет разрешения или календарь недоступен: событий телефона просто нет
      deviceRange = range;
    } finally {
      deviceLoading = false;
      changed();
    }
  })();
}

// ---------- события в окне ----------

const expandCache = new Map<string, CalEvent[]>();

/**
 * События всех включённых календарей, которые пересекают дни [from, from + days).
 * Пока модуль разбора или файл грузятся, список пуст, а компонент перерисуется, когда всё будет готово.
 */
export function useCalendarEvents(from: string, days: number): CalEvent[] {
  const v = useCalendarsVersion();
  const key = `${v}|${from}|${days}`;
  const hit = expandCache.get(key);
  if (hit) return hit;
  const bounds = windowBounds(from, days, TZ);
  const out: CalEvent[] = [];
  const list = subs().filter((s) => s.enabled);
  if (list.some((s) => feeds.get(s.id)?.parsed) && !ical) void loadIcal().then(changed);
  if (ical) {
    for (const s of list) {
      const parsed = feeds.get(s.id)?.parsed;
      if (!parsed) continue;
      try {
        out.push(...ical.expandCalendar(parsed, { calendar: s.id, color: `var(--c-${s.color})`, from: bounds.from, to: bounds.to, tz: TZ }));
      } catch {
        // один сломанный календарь не мешает остальным
      }
    }
  }
  ensureDevice(bounds.from, bounds.to);
  out.push(...deviceEvents.filter((e) => (e.allDay ? true : e.end > bounds.from && e.start < bounds.to)));
  if (expandCache.size > 20) expandCache.clear();
  expandCache.set(key, out);
  return out;
}
