import { splitAlarms } from './alarms.ts';
import { LOCALE, tr } from './i18n.ts';
import { isQuickWindow, isViewWindow, viewWindowLabel, viewWindowUrl } from './viewWindow.ts';
/**
 * Где запущен клиент: браузер (сервер отдаёт клиент сам), оболочка Tauri на компьютере
 * или Capacitor на телефоне. В оболочках клиент встроен в приложение, а адрес сервера
 * пользователь вводит при первом входе.
 */

export type Platform = 'web' | 'tauri' | 'capacitor';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }
}

export function platform(): Platform {
  if (typeof window === 'undefined') return 'web';
  if (window.__TAURI_INTERNALS__) return 'tauri';
  if (window.Capacitor?.isNativePlatform?.()) return 'capacitor';
  return 'web';
}

export function isNative(): boolean {
  return platform() !== 'web';
}

const SERVER_KEY = 'dela.server';

/** Адрес сервера. В браузере — тот же источник, с которого загружен клиент. */
export function serverUrl(): string {
  if (!isNative()) return '';
  try {
    return localStorage.getItem(SERVER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setServerUrl(url: string): void {
  try {
    localStorage.setItem(SERVER_KEY, url);
  } catch {
    // без localStorage адрес придётся вводить при каждом запуске
  }
}

/** Привести введённый адрес к виду https://host[:port] без пути. */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '10.0.2.2'].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Системное уведомление средствами оболочки. Возвращает false в браузере:
 * там уведомление показывает service worker.
 */
export async function nativeNotify(title: string, body: string): Promise<boolean> {
  if (platform() === 'tauri') {
    const n = await import('@tauri-apps/plugin-notification');
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === 'granted';
    if (granted) n.sendNotification({ title, body });
    return true;
  }
  // На телефоне напоминание уже стоит в расписании Android и придёт само.
  if (platform() === 'capacitor') return true;
  return false;
}

/** 31-битный id уведомления из ключа напоминания (FNV-1a). */
function notificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff;
}

export interface NativeReminder {
  readonly key: string;
  readonly at: number;
  readonly title: string;
  readonly body: string;
  /** null — утренняя сводка: нажатие открывает «Сегодня». */
  readonly taskId: string | null;
  /** Срочное напоминание: на Android звенит будильником, а не приходит уведомлением. */
  readonly alarm?: boolean;
}

let permissionAsked = false;

/**
 * Телефон: заменить расписание уведомлений в Android. Уведомления приходят
 * при закрытом приложении и без связи с сервером. Android держит ограниченное число
 * будильников, поэтому ставятся ближайшие 60.
 */
export function syncNativeReminders(list: readonly NativeReminder[], alarmTasks: readonly string[] = []): Promise<void> {
  // Пересчёты идут по очереди: иначе отмена из одного вызова снимала бы то, что поставил другой.
  const run = reminderQueue.then(() => replaceNativeReminders(list, alarmTasks));
  reminderQueue = run.catch(() => undefined);
  return run;
}

let reminderQueue: Promise<void> = Promise.resolve();

/** Какие уведомления и на какое время Dela уже поставила в Android (id → время). */
function loadScheduled(): Map<number, number> {
  try {
    return new Map(JSON.parse(localStorage.getItem('nativeReminders') ?? '[]') as Array<[number, number]>);
  } catch {
    return new Map();
  }
}

function saveScheduled(m: ReadonlyMap<number, number>): void {
  try {
    localStorage.setItem('nativeReminders', JSON.stringify([...m]));
  } catch {
    // без localStorage старые напоминания снимутся при следующем пересчёте
  }
}

async function replaceNativeReminders(list: readonly NativeReminder[], alarmTasks: readonly string[]): Promise<void> {
  if (platform() !== 'capacitor') return;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  let perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted' && !permissionAsked) {
    permissionAsked = true;
    perm = await LocalNotifications.requestPermissions();
  }
  const now = Date.now();
  const upcoming = list.filter((r) => r.at > now);
  // Срочные ставятся будильником, и уведомление для них не ставится: иначе пришло бы и то и другое.
  // Без уведомлений будильник не покажется на весь экран, поэтому без разрешения будильники только снимаются.
  const split = splitAlarms(upcoming, perm.display === 'granted' && (await alarmsAllowed()));
  const alarmsSet = await setNativeAlarms(perm.display === 'granted' ? split.alarms : [], alarmTasks).catch((err) => {
    console.error('alarms failed', err);
    return false;
  });
  if (perm.display !== 'granted') return;
  const next = (alarmsSet ? split.notifications : upcoming).slice(0, 60);
  const wanted = new Set(next.map((r) => notificationId(r.key)));
  const known = loadScheduled();
  // Наступившие напоминания не отменяются: Android показывает их с задержкой до минуты,
  // а отмена убрала бы и уже показанное уведомление из шторки. Старше суток снимаются из хранилища плагина.
  const stale = (await LocalNotifications.getPending()).notifications.filter((n) => {
    if (wanted.has(n.id)) return false;
    const at = known.get(n.id);
    return at === undefined || at > now || at < now - 24 * 3600_000;
  });
  if (stale.length > 0) await LocalNotifications.cancel({ notifications: stale.map((n) => ({ id: n.id })) });
  for (const n of stale) known.delete(n.id);
  for (const r of next) known.set(notificationId(r.key), r.at);
  saveScheduled(known);
  if (next.length === 0) return;
  // Без разрешения на точное время Android может сдвинуть напоминание на несколько минут.
  // Само разрешение пользователь даёт кнопкой в настройках: иначе плагин открывал бы системный экран при каждом пересчёте.
  const exact = (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted';
  await LocalNotifications.schedule({
    notifications: next.map((r) => ({
      id: notificationId(r.key),
      title: r.title,
      body: r.body,
      schedule: { at: new Date(r.at), allowWhileIdle: true },
      isExactNotification: exact,
      extra: r.taskId ? { taskId: r.taskId } : { today: true },
      smallIcon: 'ic_stat_dela',
    })),
  });
}

interface DelaAlarmPlugin {
  set(o: { alarms: Array<{ key: string; at: number; title: string; taskId: string }>; active: readonly string[] }): Promise<{ ok: boolean }>;
  status(): Promise<{ exact: boolean; fullScreen: boolean }>;
  openFullScreenSettings(): Promise<void>;
}

/** Может ли телефон ставить будильники: нужен точный будильник (на Android 13+ разрешён всегда). */
async function alarmsAllowed(): Promise<boolean> {
  const a = (await nativePlugin<DelaAlarmPlugin>('DelaAlarm'))?.p;
  return a ? (await a.status().catch(() => ({ exact: false }))).exact : false;
}

/**
 * Заменить будильники в Android. active — открытые задачи с флагом: отложенные на 10 минут звонки
 * других задач (выполненных, удалённых, без флага) снимаются. false — будильники не поставлены.
 */
async function setNativeAlarms(alarms: readonly NativeReminder[], active: readonly string[]): Promise<boolean> {
  const a = (await nativePlugin<DelaAlarmPlugin>('DelaAlarm'))?.p;
  if (!a) return false;
  const { ok } = await a.set({ alarms: alarms.map((r) => ({ key: r.key, at: r.at, title: r.title, taskId: r.taskId ?? '' })), active });
  return ok;
}

/**
 * Телефон: разрешения для будильника, спрашиваются при включении будильника у задачи.
 * 'fullscreen' — Android 14+ запретил показ на весь экран: открывается системный экран, где это разрешают.
 * null вне Android.
 */
export async function prepareAlarms(): Promise<'ok' | 'notifications' | 'fullscreen' | null> {
  const a = (await nativePlugin<DelaAlarmPlugin>('DelaAlarm'))?.p;
  if (!a) return null;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  let perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted') perm = await LocalNotifications.requestPermissions();
  if (perm.display !== 'granted') return 'notifications';
  // Android 12: точные будильники разрешают в настройках (на 13+ разрешение USE_EXACT_ALARM есть всегда).
  if (!(await a.status()).exact) await LocalNotifications.changeExactNotificationSetting();
  if (!(await a.status()).fullScreen) {
    await a.openFullScreenSettings();
    return 'fullscreen';
  }
  return 'ok';
}

// ---------- напоминания по месту ----------

interface DelaPlacesPlugin {
  set(o: { zones: readonly PlaceZoneLike[] }): Promise<{ tracking: boolean }>;
  status(): Promise<PlaceStatus>;
  requestLocation(): Promise<PlaceStatus>;
  requestBackground(): Promise<PlaceStatus>;
  setEnabled(o: { enabled: boolean }): Promise<PlaceStatus>;
  openSettings(): Promise<void>;
  current(): Promise<{ lat: number; lon: number; accuracy: number }>;
}

interface PlaceZoneLike {
  readonly taskId: string;
  readonly title: string;
  readonly lat: number;
  readonly lon: number;
  readonly radius: number;
  readonly on: 'arrive' | 'leave';
  readonly name: string;
  readonly alarm: boolean;
}

/** Состояние слежения за местами на телефоне. */
export interface PlaceStatus {
  /** Разрешение на геолокацию, пока приложение открыто (точное или приблизительное). */
  readonly location: boolean;
  /** Точная геолокация: с приблизительной (Android 12+, около 2 км) зоны в сотни метров не различить. */
  readonly precise: boolean;
  /** Разрешение «Разрешить всегда»: без него после перезагрузки телефона слежение не возобновится. */
  readonly background: boolean;
  /** Пользователь не выключал слежение кнопкой в уведомлении. */
  readonly enabled: boolean;
  /** Служба сейчас следит (есть зоны и разрешение). */
  readonly tracking: boolean;
}

let placesSent = '';
let placesQueue: Promise<unknown> = Promise.resolve();

/**
 * Телефон: отдать Android зоны открытых задач с напоминанием по месту. Список хранится в приватных настройках
 * приложения на телефоне; пустой список останавливает слежение. Одинаковый список повторно не отправляется.
 */
export function syncNativePlaces(zones: readonly PlaceZoneLike[]): Promise<void> {
  const run = placesQueue.then(async () => {
    const p = (await nativePlugin<DelaPlacesPlugin>('DelaPlaces'))?.p;
    if (!p) return;
    const json = JSON.stringify(zones);
    if (json === placesSent) return;
    await p.set({ zones });
    placesSent = json;
  });
  placesQueue = run.catch(() => undefined);
  return run;
}

/** Состояние слежения; null вне Android. */
export async function placeStatus(): Promise<PlaceStatus | null> {
  const p = (await nativePlugin<DelaPlacesPlugin>('DelaPlaces'))?.p;
  return p ? p.status() : null;
}

/**
 * Телефон: разрешения на геолокацию, спрашиваются при первом напоминании по месту (объяснение показывает карточка задачи).
 * Сначала «при использовании», затем «всегда»: на Android 11+ второе разрешают на экране настроек приложения.
 * Без разрешения на уведомления напоминание не покажется, его тоже спрашиваем. null вне Android.
 */
export async function preparePlaces(again = false): Promise<PlaceStatus | null> {
  const p = (await nativePlugin<DelaPlacesPlugin>('DelaPlaces'))?.p;
  if (!p) return null;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  if ((await LocalNotifications.checkPermissions()).display !== 'granted') await LocalNotifications.requestPermissions();
  let st = await p.status();
  if (!st.location || !st.precise) st = await p.requestLocation();
  if (st.location && !st.background) st = await p.requestBackground();
  if (!st.enabled) st = await p.setEnabled({ enabled: true });
  // Повторная просьба после отказа: Android больше не показывает запрос, разрешают на экране приложения в настройках.
  if (again && (!st.location || !st.precise || !st.background)) await p.openSettings();
  return st;
}

/** Включить или выключить слежение за местами (то же, что кнопка в уведомлении «Dela следит за местами»). */
export async function setPlaceTracking(enabled: boolean): Promise<PlaceStatus | null> {
  const p = (await nativePlugin<DelaPlacesPlugin>('DelaPlaces'))?.p;
  return p ? p.setEnabled({ enabled }) : null;
}

/**
 * Где сейчас устройство. На Android — LocationManager телефона без сервисов Google, в браузере — Geolocation API.
 * Координаты никуда не отправляются: адрес по ним не ищется, карта не загружается.
 */
export async function currentPosition(): Promise<{ lat: number; lon: number; accuracy: number }> {
  const p = (await nativePlugin<DelaPlacesPlugin>('DelaPlaces'))?.p;
  if (p) return p.current();
  if (typeof navigator === 'undefined' || !navigator.geolocation) throw new Error('no geolocation');
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 },
    ),
  );
}

/** Телефон: можно ли ставить напоминания на точное время. null вне Android. */
export async function exactRemindersAllowed(): Promise<boolean | null> {
  if (platform() !== 'capacitor') return null;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted';
}

/** Телефон: открыть системный экран «Будильники и напоминания» и вернуть итог. */
export async function allowExactReminders(): Promise<boolean> {
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  return (await LocalNotifications.changeExactNotificationSetting()).exact_alarm === 'granted';
}

/** Телефон: тап по уведомлению открывает задачу, а по утренней сводке — «Сегодня». */
export async function onNotificationOpen(fn: (taskId: string) => void, onToday: () => void): Promise<() => void> {
  if (platform() !== 'capacitor') return () => undefined;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const handle = await LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const extra = e.notification.extra as { taskId?: string; today?: boolean } | undefined;
    if (extra?.taskId) fn(extra.taskId);
    else if (extra?.today) onToday();
  });
  return () => void handle.remove();
}

/** Телефон: системная кнопка «Назад». Обработчик возвращает false, если закрывать нечего. */
export async function onBackButton(fn: () => boolean): Promise<() => void> {
  if (platform() !== 'capacitor') return () => undefined;
  const { App } = await import('@capacitor/app');
  const handle = await App.addListener('backButton', () => {
    if (!fn()) void App.minimizeApp();
  });
  return () => void handle.remove();
}

/** Windows: подписи меню в трее на языке интерфейса. */
export async function localizeTray(): Promise<void> {
  if (platform() !== 'tauri' || inViewWindow()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('tray_labels', { open: tr('Открыть Dela'), add: tr('Новая задача (Ctrl+Shift+Space)'), quit: tr('Выйти из Dela') });
}

/** Отдельное окно или всплывающая строка программы для Windows: трей, глобальные клавиши и ссылки dela:// обслуживает главное окно. */
function inViewWindow(): boolean {
  return typeof location !== 'undefined' && (isViewWindow(location.search) || isQuickWindow(location.search));
}

/** Всплывающая строка: оболочка показала её снова — очистить поле и перечитать PIN. */
export async function onQuickWindowShown(fn: () => void): Promise<() => void> {
  if (platform() !== 'tauri') return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('quick-open', () => fn());
}

/** Всплывающая строка готова: оболочка ставит её по центру сверху и показывает. Вызывается один раз после загрузки. */
export async function quickWindowReady(): Promise<void> {
  if (platform() !== 'tauri') return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('quick_ready');
}

/** Спрятать всплывающую строку: Windows вернёт фокус программе, где был пользователь. */
export async function hideQuickWindow(): Promise<void> {
  if (platform() !== 'tauri') return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('quick_hide');
}

/** Высота всплывающей строки по содержимому (в CSS-пикселях): список и чипы делают её выше. */
export async function resizeQuickWindow(height: number): Promise<void> {
  if (platform() !== 'tauri') return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('quick_resize', { height });
}

/** Из всплывающей строки или отдельного окна: показать главное окно. */
export async function showMainWindow(): Promise<void> {
  if (platform() !== 'tauri') return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('show_main_window');
}

/** Закрыть отдельное окно задачи. В браузере — обычное закрытие вкладки. */
export async function closeViewWindow(): Promise<void> {
  if (platform() !== 'tauri') {
    window.close();
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('close_view_window');
}

/** Подписка на событие оболочки «быстрая задача» (трей, глобальное сочетание клавиш). */
export async function onQuickAddRequest(fn: () => void): Promise<() => void> {
  if (platform() !== 'tauri' || inViewWindow()) return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('quick-add', () => fn());
}

/**
 * Приложение открыто по ссылке dela://open#/… (Android и Windows): и при запуске, и когда уже работает.
 * Обработчик получает ссылку целиком.
 */
export async function onAppLink(fn: (url: string) => void): Promise<void> {
  if (platform() === 'capacitor') {
    const { App } = await import('@capacitor/app');
    await App.addListener('appUrlOpen', (e) => fn(e.url));
    const launch = await App.getLaunchUrl();
    if (launch?.url) fn(launch.url);
  } else if (platform() === 'tauri' && !inViewWindow()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    await listen<string>('app-link', (e) => fn(e.payload));
    const first = await invoke<string | null>('take_app_link');
    if (first) fn(first);
  }
}

/** Что прислали через «Поделиться», кроме текста: картинка или голосовое сообщение. */
export type SharedMediaKind = 'image' | 'audio';

/**
 * Телефон: текст из «Поделиться» в других приложениях. Картинка или голосовое сообщение
 * приходят в onMedia: файл ждёт распознавания в Android (плагин Recognize).
 */
export async function onSharedText(fn: (text: string) => void, onMedia?: (kind: SharedMediaKind) => void): Promise<() => void> {
  if (platform() !== 'capacitor') return () => undefined;
  const { registerPlugin } = await import('@capacitor/core');
  type Shared = { text?: string; media?: SharedMediaKind };
  const ShareIntent = registerPlugin<{
    take(): Promise<Shared>;
    addListener(event: 'shared', cb: (e: Shared) => void): Promise<{ remove(): Promise<void> }>;
  }>('ShareIntent');
  const deliver = (e: Shared) => {
    if (e.media) onMedia?.(e.media);
    else if (e.text) fn(e.text);
  };
  const handle = await ShareIntent.addListener('shared', deliver);
  deliver(await ShareIntent.take());
  return () => void handle.remove();
}

/** Модель распознавания: языковые данные Tesseract или модель речи sherpa-onnx для русского или английского. */
export type ModelPack = 'ocr' | 'ru' | 'en';

export interface PackStatus {
  readonly ready: boolean;
  /** Сколько весит модель целиком, байт. */
  readonly size: number;
}

export interface RecognizerStatus {
  readonly ocr: PackStatus;
  readonly ru: PackStatus;
  readonly en: PackStatus;
  /** Есть ли в APK библиотеки для этого телефона: распознавание речи только на 64-битных ARM. */
  readonly ocrSupported: boolean;
  readonly speechSupported: boolean;
  readonly downloading: ModelPack | null;
  /** Присланный файл, который ждёт распознавания. */
  readonly pending: SharedMediaKind | null;
}

/** Плагин Recognize в Android. Ошибки приходят с кодом: no_media, no_model, unsupported, cancelled, busy, checksum, no_space, network, failed. */
export interface RecognizeApi {
  status(): Promise<RecognizerStatus>;
  download(o: { pack: ModelPack }): Promise<void>;
  cancelDownload(): Promise<void>;
  remove(o: { pack: ModelPack }): Promise<void>;
  recognize(o: { lang: string }): Promise<{ kind: SharedMediaKind; text: string }>;
  cancel(): Promise<void>;
  discard(): Promise<void>;
  addListener(event: 'progress', cb: (e: { share: number }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'modelProgress', cb: (e: { pack: ModelPack; done: number; total: number }) => void): Promise<{ remove(): Promise<void> }>;
}

/** Плагин распознавания на телефоне; null в браузере и на компьютере. */
export async function recognizeApi(): Promise<{ readonly p: RecognizeApi } | null> {
  return nativePlugin<RecognizeApi>('Recognize');
}

/** Открыть ссылку в системном браузере. */
export async function openExternal(url: string): Promise<void> {
  if (platform() === 'tauri') {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Есть ли на телефоне отпечаток или лицо для разблокировки. На компьютере и в браузере нет. */
export async function biometryAvailable(): Promise<boolean> {
  if (platform() !== 'capacitor') return false;
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    return (await BiometricAuth.checkBiometry()).isAvailable;
  } catch {
    return false;
  }
}

/** Системный запрос отпечатка. true, если пользователь подтвердил. */
export async function biometryUnlock(): Promise<boolean> {
  if (platform() !== 'capacitor') return false;
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    await BiometricAuth.authenticate({
      reason: tr('Разблокировать Dela'),
      androidTitle: tr('Разблокировать Dela'),
      cancelTitle: tr('Ввести PIN'),
      allowDeviceCredential: false,
    });
    return true;
  } catch {
    return false;
  }
}

/** Приложение на телефоне ушло в фон (pause) и вернулось (resume). */
export async function onAppPauseResume(onPause: () => void, onResume: () => void): Promise<void> {
  if (platform() !== 'capacitor') return;
  const { App } = await import('@capacitor/app');
  await App.addListener('pause', onPause);
  await App.addListener('resume', onResume);
}

/** Короткая вибрация на телефоне: отклик на жест и выполнение задачи. */
export function haptic(kind: 'light' | 'medium' | 'success' = 'light'): void {
  if (platform() !== 'capacitor') return;
  void import('@capacitor/haptics')
    .then(({ Haptics, ImpactStyle, NotificationType }) =>
      kind === 'success' ? Haptics.notification({ type: NotificationType.Success }) : Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light }),
    )
    .catch(() => undefined);
}

interface DelaWidgetPlugin {
  update(o: { snapshot: string }): Promise<void>;
  takeCompleted(): Promise<{ ids: string[] }>;
  takeLaunch(): Promise<WidgetLaunch>;
  addListener(event: 'launch', cb: (e: WidgetLaunch) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'completed', cb: () => void): Promise<{ remove(): Promise<void> }>;
}

/**
 * Прокси плагина Capacitor нельзя вернуть из async-функции напрямую, в том числе из `async () => proxy`:
 * у прокси есть любой метод, и await вызовет у него then(); такого метода в Android нет, вызов отклонится
 * («"X.then()" is not implemented on android» в консоли), а колбэки await не вызовутся никогда. Поэтому плагин
 * лежит в обёртке { p }, а достаётся из неё уже после await. Регистрируется один раз.
 */
const plugins = new Map<string, unknown>();

export async function nativePlugin<T>(name: string): Promise<{ readonly p: T } | null> {
  if (platform() !== 'capacitor') return null;
  if (!plugins.has(name)) {
    const { registerPlugin } = await import('@capacitor/core');
    // Два одновременных первых вызова: второй не регистрирует плагин повторно.
    if (!plugins.has(name)) plugins.set(name, registerPlugin<T>(name));
  }
  return { p: plugins.get(name) as T };
}


/** Отдать виджету на главном экране свежий снимок задач. */
export async function updateWidget(snapshot: unknown): Promise<void> {
  const w = (await nativePlugin<DelaWidgetPlugin>('DelaWidget'))?.p;
  await w?.update({ snapshot: JSON.stringify(snapshot) });
}

/** Задачи, отмеченные выполненными на виджете, пока приложение было закрыто или в фоне. */
export async function takeWidgetCompleted(): Promise<string[]> {
  const w = (await nativePlugin<DelaWidgetPlugin>('DelaWidget'))?.p;
  return w ? (await w.takeCompleted()).ids : [];
}

export async function onWidgetCompleted(fn: () => void): Promise<void> {
  const w = (await nativePlugin<DelaWidgetPlugin>('DelaWidget'))?.p;
  await w?.addListener('completed', fn);
}

/** Что открыть при запуске: задачу, быстрое добавление или «Сегодня» (push утренней сводки). */
export interface WidgetLaunch {
  readonly taskId?: string;
  readonly quickAdd?: boolean;
  readonly voice?: boolean;
  readonly today?: boolean;
}

/** Приложение открыто с виджета, плитки или push-уведомления: показать задачу, быстрое добавление или «Сегодня». */
export async function onWidgetLaunch(fn: (e: WidgetLaunch) => void): Promise<() => void> {
  const w = (await nativePlugin<DelaWidgetPlugin>('DelaWidget'))?.p;
  if (!w) return () => undefined;
  const handle = await w.addListener('launch', fn);
  const first = await w.takeLaunch();
  if (first.taskId || first.quickAdd || first.voice || first.today) fn(first);
  return () => void handle.remove();
}

/** Программа для Windows: проект или задача (hash-маршрут) в отдельном окне; уже открытое окно выходит вперёд. */
export async function openViewWindow(hash: string, title: string): Promise<void> {
  if (platform() !== 'tauri') return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_view_window', { label: viewWindowLabel(hash), url: viewWindowUrl(hash), title: `${title} · Dela` });
}

/** Можно ли открыть отдельное окно: только в программе для Windows. */
export function canOpenViewWindow(): boolean {
  return platform() === 'tauri';
}

/** Программа для Windows: запускается ли она при входе в систему. null в браузере и на телефоне. */
export async function autostartEnabled(): Promise<boolean | null> {
  if (platform() !== 'tauri') return null;
  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return isEnabled();
}

/** Включить или выключить запуск при входе: программа стартует свёрнутой в трей. */
export async function setAutostart(on: boolean): Promise<void> {
  const { enable, disable } = await import('@tauri-apps/plugin-autostart');
  await (on ? enable() : disable());
}

export interface DesktopUpdate {
  readonly version: string;
  install(): Promise<void>;
}

/** Программа для Windows: есть ли новая версия на GitHub. В браузере и на телефоне всегда null. */
export async function checkDesktopUpdate(): Promise<DesktopUpdate | null> {
  // Обновление проверяет главное окно: у отдельных окон нет на это прав.
  if (platform() !== 'tauri' || inViewWindow()) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    async install() {
      await update.downloadAndInstall();
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}

/** Голосовой ввод на телефоне: системное окно распознавания. null, если отменили или ничего не распознано. */
export async function voiceAvailable(): Promise<boolean> {
  if (platform() !== 'capacitor') return false;
  const { registerPlugin } = await import('@capacitor/core');
  const Voice = registerPlugin<{ available(): Promise<{ available: boolean }> }>('VoiceInput');
  return (await Voice.available().catch(() => ({ available: false }))).available;
}

export async function listenVoice(): Promise<string | null> {
  if (platform() !== 'capacitor') return null;
  const { registerPlugin } = await import('@capacitor/core');
  const Voice = registerPlugin<{ listen(o: { lang: string }): Promise<{ text?: string }> }>('VoiceInput');
  const lang = LOCALE;
  return (await Voice.listen({ lang })).text ?? null;
}

interface UnifiedPushPlugin {
  register(o: { vapid: string }): Promise<{ ok: boolean }>;
  unregister(): Promise<void>;
  getEndpoint(): Promise<{ url?: string; p256dh?: string; auth?: string }>;
  setKey(o: { key: string }): Promise<void>;
  addListener(event: 'endpoint', cb: (e: { url?: string; p256dh?: string; auth?: string }) => void): Promise<{ remove(): Promise<void> }>;
}


/**
 * Телефон: подписка на напоминания через UnifiedPush (ntfy и другие распространители).
 * Возвращает адрес и ключи Web Push для сервера; null, если распространитель не установлен.
 */
export async function nativePushSubscribe(vapid: string, textKey: string): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } } | null> {
  const up = (await nativePlugin<UnifiedPushPlugin>('UnifiedPush'))?.p;
  if (!up) return null;
  await up.setKey({ key: textKey });
  const got = new Promise<{ url?: string; p256dh?: string; auth?: string }>((resolve) => {
    void up.addListener('endpoint', resolve);
    setTimeout(() => void up.getEndpoint().then(resolve), 15_000);
  });
  const { ok } = await up.register({ vapid });
  if (!ok) return null;
  const now = await up.getEndpoint();
  const e = now.url ? now : await got;
  if (!e.url || !e.p256dh || !e.auth) return null;
  return { endpoint: e.url, keys: { p256dh: e.p256dh, auth: e.auth } };
}

export async function nativePushUnsubscribe(): Promise<void> {
  await (await nativePlugin<UnifiedPushPlugin>('UnifiedPush'))?.p.unregister();
}
