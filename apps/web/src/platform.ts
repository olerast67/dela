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
  readonly taskId: string;
}

let permissionAsked = false;

/**
 * Телефон: заменить расписание уведомлений в Android. Уведомления приходят
 * при закрытом приложении и без связи с сервером. Android держит ограниченное число
 * будильников, поэтому ставятся ближайшие 60.
 */
export async function syncNativeReminders(list: readonly NativeReminder[]): Promise<void> {
  if (platform() !== 'capacitor') return;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  let perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted' && !permissionAsked) {
    permissionAsked = true;
    perm = await LocalNotifications.requestPermissions();
  }
  if (perm.display !== 'granted') return;
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length > 0) {
    await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
  }
  const now = Date.now();
  const next = list.filter((r) => r.at > now).slice(0, 60);
  if (next.length === 0) return;
  await LocalNotifications.schedule({
    notifications: next.map((r) => ({
      id: notificationId(r.key),
      title: r.title,
      body: r.body,
      schedule: { at: new Date(r.at), allowWhileIdle: true },
      extra: { taskId: r.taskId },
      smallIcon: 'ic_stat_dela',
    })),
  });
}

/** Телефон: тап по уведомлению открывает задачу. */
export async function onNotificationOpen(fn: (taskId: string) => void): Promise<() => void> {
  if (platform() !== 'capacitor') return () => undefined;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const handle = await LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const id = (e.notification.extra as { taskId?: string } | undefined)?.taskId;
    if (id) fn(id);
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
      reason: 'Разблокировать Dela',
      androidTitle: 'Разблокировать Dela',
      cancelTitle: 'Ввести PIN',
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
  takeLaunch(): Promise<{ taskId?: string; quickAdd?: boolean; voice?: boolean }>;
  addListener(event: 'launch', cb: (e: { taskId?: string; quickAdd?: boolean; voice?: boolean }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'completed', cb: () => void): Promise<{ remove(): Promise<void> }>;
}

async function widgetPlugin(): Promise<DelaWidgetPlugin | null> {
  if (platform() !== 'capacitor') return null;
  const { registerPlugin } = await import('@capacitor/core');
  return registerPlugin<DelaWidgetPlugin>('DelaWidget');
}

/** Отдать виджету на главном экране свежий снимок задач. */
export async function updateWidget(snapshot: unknown): Promise<void> {
  const w = await widgetPlugin();
  await w?.update({ snapshot: JSON.stringify(snapshot) });
}

/** Задачи, отмеченные выполненными на виджете, пока приложение было закрыто или в фоне. */
export async function takeWidgetCompleted(): Promise<string[]> {
  const w = await widgetPlugin();
  return w ? (await w.takeCompleted()).ids : [];
}

export async function onWidgetCompleted(fn: () => void): Promise<void> {
  const w = await widgetPlugin();
  await w?.addListener('completed', fn);
}

/** Приложение открыто с виджета или плитки: показать задачу или быстрое добавление. */
export async function onWidgetLaunch(fn: (e: { taskId?: string; quickAdd?: boolean; voice?: boolean }) => void): Promise<() => void> {
  const w = await widgetPlugin();
  if (!w) return () => undefined;
  const handle = await w.addListener('launch', fn);
  const first = await w.takeLaunch();
  if (first.taskId || first.quickAdd || first.voice) fn(first);
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
  const lang = navigator.language?.startsWith('en') ? 'en-US' : 'ru-RU';
  return (await Voice.listen({ lang })).text ?? null;
}
