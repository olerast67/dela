import { LOCALE, tr } from './i18n.ts';
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
}

let permissionAsked = false;

/**
 * Телефон: заменить расписание уведомлений в Android. Уведомления приходят
 * при закрытом приложении и без связи с сервером. Android держит ограниченное число
 * будильников, поэтому ставятся ближайшие 60.
 */
export function syncNativeReminders(list: readonly NativeReminder[]): Promise<void> {
  // Пересчёты идут по очереди: иначе отмена из одного вызова снимала бы то, что поставил другой.
  const run = reminderQueue.then(() => replaceNativeReminders(list));
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

async function replaceNativeReminders(list: readonly NativeReminder[]): Promise<void> {
  if (platform() !== 'capacitor') return;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  let perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted' && !permissionAsked) {
    permissionAsked = true;
    perm = await LocalNotifications.requestPermissions();
  }
  if (perm.display !== 'granted') return;
  const now = Date.now();
  const next = list.filter((r) => r.at > now).slice(0, 60);
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
  if (platform() !== 'tauri') return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('tray_labels', { open: tr('Открыть Dela'), add: tr('Новая задача (Ctrl+Shift+Space)'), quit: tr('Выйти из Dela') });
}

/** Подписка на событие оболочки «быстрая задача» (трей, глобальное сочетание клавиш). */
export async function onQuickAddRequest(fn: () => void): Promise<() => void> {
  if (platform() !== 'tauri') return () => undefined;
  const { listen } = await import('@tauri-apps/api/event');
  return listen('quick-add', () => fn());
}

/** Телефон: текст из «Поделиться» в других приложениях. */
export async function onSharedText(fn: (text: string) => void): Promise<() => void> {
  if (platform() !== 'capacitor') return () => undefined;
  const { registerPlugin } = await import('@capacitor/core');
  const ShareIntent = registerPlugin<{
    take(): Promise<{ text?: string }>;
    addListener(event: 'shared', cb: (e: { text: string }) => void): Promise<{ remove(): Promise<void> }>;
  }>('ShareIntent');
  const handle = await ShareIntent.addListener('shared', (e) => e.text && fn(e.text));
  const first = await ShareIntent.take();
  if (first.text) fn(first.text);
  return () => void handle.remove();
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
 * Прокси плагина Capacitor нельзя вернуть из async-функции напрямую: await вызовет у него then(),
 * а такого метода у плагина нет. Поэтому плагин лежит в обёртке и регистрируется один раз.
 */
const plugins = new Map<string, unknown>();

async function nativePlugin<T>(name: string): Promise<{ readonly p: T } | null> {
  if (platform() !== 'capacitor') return null;
  if (!plugins.has(name)) {
    const { registerPlugin } = await import('@capacitor/core');
    plugins.set(name, registerPlugin<T>(name));
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

export interface DesktopUpdate {
  readonly version: string;
  install(): Promise<void>;
}

/** Программа для Windows: есть ли новая версия на GitHub. В браузере и на телефоне всегда null. */
export async function checkDesktopUpdate(): Promise<DesktopUpdate | null> {
  if (platform() !== 'tauri') return null;
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
