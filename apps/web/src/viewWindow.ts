/**
 * Проект или задача в отдельном окне программы для Windows. Окно — та же страница клиента
 * с параметром ?window=1: компактный вид без боковой панели и панели вкладок.
 * Данные общие с главным окном: тот же источник, та же IndexedDB, изменения идут через BroadcastChannel.
 */

/** Параметр адреса, по которому клиент узнаёт отдельное окно. */
export const VIEW_WINDOW_PARAM = 'window';

/** Открыта ли страница в отдельном окне (компактный вид). search — location.search. */
export function isViewWindow(search: string): boolean {
  return new URLSearchParams(search).get(VIEW_WINDOW_PARAM) === '1';
}

/**
 * Метка окна по маршруту: одна на проект или задачу, поэтому повторное открытие
 * показывает уже открытое окно. Tauri принимает в метке буквы, цифры, «-» и «_».
 */
export function viewWindowLabel(hash: string): string {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return `view-${path.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Адрес окна относительно страницы клиента: параметр компактного вида и hash-маршрут. */
export function viewWindowUrl(hash: string): string {
  return `?${VIEW_WINDOW_PARAM}=1${hash}`;
}

/** Параметр адреса всплывающей строки быстрого добавления (Ctrl+Shift+Space). */
export const QUICK_WINDOW_PARAM = 'quick';

/** Открыта ли страница во всплывающей строке быстрого добавления. search — location.search. */
export function isQuickWindow(search: string): boolean {
  return new URLSearchParams(search).get(QUICK_WINDOW_PARAM) === '1';
}

/** Задача из маршрута отдельного окна (#/task/<id>), иначе null. */
export function windowTaskId(hash: string): string | null {
  const m = /^#\/task\/([^/?]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]!) : null;
}
