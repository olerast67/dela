/**
 * Язык интерфейса. Строки в коде написаны по-русски и служат ключами словаря:
 * tr('Сегодня') возвращает «Today», если выбран английский. Язык выбирается при запуске
 * (настройка или язык системы), смена языка перезагружает страницу.
 */
import { EN } from './i18n/en.ts';

export type Lang = 'ru' | 'en';

const KEY = 'lang';

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'ru' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

function system(): Lang {
  const list = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language];
  // Русский интерфейс для русского и языков, где его обычно понимают; остальным английский.
  return list.some((l) => /^(ru|be|uk|kk|ky|uz|tg|hy|az)\b/i.test(l ?? '')) ? 'ru' : 'en';
}

/** Выбор пользователя: язык или null, если язык как в системе. */
export const LANG_CHOICE: Lang | null = stored();
export const LANG: Lang = LANG_CHOICE ?? system();
/** Для Intl: даты, числа, сравнение строк. */
export const LOCALE = LANG === 'ru' ? 'ru-RU' : 'en-US';

if (typeof document !== 'undefined') document.documentElement.lang = LANG;

export function setLang(lang: Lang | null): void {
  try {
    if (lang) localStorage.setItem(KEY, lang);
    else localStorage.removeItem(KEY);
  } catch {
    // без localStorage язык остаётся системным
  }
  location.reload();
}

/** Перевод строки. Подстановки: tr('Вышла версия {v}', { v: '1.0' }). */
export function tr(ru: string, vars?: Readonly<Record<string, string | number>>): string {
  const s = LANG === 'en' ? (EN[ru] ?? ru) : ru;
  return vars ? s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Перевод с уточнением, когда одна русская строка значит разное: trc('проект', 'Выйти') → «Leave». */
export function trc(context: string, ru: string): string {
  return LANG === 'en' ? (EN[`${context}|${ru}`] ?? EN[ru] ?? ru) : ru;
}

/**
 * Число со словом: tn(3, 'задача', 'задачи', 'задач') → «3 задачи» или «3 tasks».
 * Английские формы берутся из словаря по русской форме «один».
 */
export function tn(n: number, one: string, few: string, many: string): string {
  if (LANG === 'en') {
    const forms = EN_PLURAL[one];
    const word = forms ? (n === 1 ? forms[0] : forms[1]) : one;
    return `${n} ${word}`;
  }
  const rule = new Intl.PluralRules('ru').select(n);
  return `${n} ${rule === 'one' ? one : rule === 'few' ? few : many}`;
}

/** Английские формы для tn: русская форма «один» → [one, many]. */
const EN_PLURAL: Readonly<Record<string, readonly [string, string]>> = {
  задача: ['task', 'tasks'],
  задачу: ['task', 'tasks'],
  'задача перенесена на сегодня': ['task moved to today', 'tasks moved to today'],
  подзадача: ['subtask', 'subtasks'],
  проект: ['project', 'projects'],
  комментарий: ['comment', 'comments'],
  день: ['day', 'days'],
  неделю: ['week', 'weeks'],
  неделя: ['week', 'weeks'],
  месяц: ['month', 'months'],
  час: ['hour', 'hours'],
  минута: ['minute', 'minutes'],
  минуту: ['minute', 'minutes'],
  участник: ['member', 'members'],
  устройство: ['device', 'devices'],
  изменение: ['change', 'changes'],
  попытка: ['attempt', 'attempts'],
  файл: ['file', 'files'],
  шаблон: ['template', 'templates'],
  раздел: ['section', 'sections'],
  метка: ['label', 'labels'],
  фильтр: ['filter', 'filters'],
  раз: ['time', 'times'],
};
