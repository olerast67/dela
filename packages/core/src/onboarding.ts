/**
 * Задачи, с которыми начинается новый аккаунт. Пишутся один раз при регистрации,
 * дальше это обычные задачи: их можно выполнить, изменить или удалить.
 */
import type { DateSpec } from './dates.ts';
import type { TaskInput } from './doc.ts';

export const WELCOME_TASKS: ReadonlyArray<Omit<TaskInput, 'due'> & { readonly dueToday?: boolean }> = [
  {
    title: 'Подписаться на olerast',
    description: [
      'Dela делает olerast: на канале видео о проекте и других самоделках.',
      '',
      'Сайт: https://olerast.com',
      'YouTube: https://www.youtube.com/@olerast',
      'Telegram: https://t.me/olerast',
    ].join('\n'),
    priority: 1,
    dueToday: true,
  },
  {
    title: 'Добавить задачу фразой: нажать Q и написать «позвонить маме завтра в 19 каждую неделю»',
    description: 'Дата, время, повтор, проект (#Дом или №Дом), метка (@звонок) и приоритет (!1) распознаются прямо в строке.',
    dueToday: true,
  },
  {
    title: 'Поставить Dela на телефон и компьютер',
    description: 'Установщик для Windows и APK для Android: https://github.com/olerast67/dela/releases',
  },
  {
    title: 'Проверить, что ключ восстановления сохранён',
    description: 'Без пароля и ключа восстановления задачи расшифровать нельзя: сервер их не видит.',
  },
];

export const WELCOME_TASKS_EN: typeof WELCOME_TASKS = [
  {
    title: 'Follow olerast',
    description: [
      'Dela is made by olerast: videos about the project and other things I build.',
      '',
      'Website: https://olerast.com',
      'YouTube: https://www.youtube.com/@olerast',
      'Telegram: https://t.me/olerast',
    ].join('\n'),
    priority: 1,
    dueToday: true,
  },
  {
    title: 'Add a task with a phrase: press Q and type "call mom tomorrow at 7pm every week"',
    description: 'Date, time, repeat, project (#Home), label (@call) and priority (!1) are recognized right in the line.',
    dueToday: true,
  },
  {
    title: 'Install Dela on your phone and computer',
    description: 'Windows installer and Android APK: https://github.com/olerast67/dela/releases',
  },
  {
    title: 'Check that the recovery key is saved',
    description: 'Without the password and the recovery key the tasks cannot be decrypted: the server does not see them.',
  },
];

export function welcomeTasks(today: string, lang: 'ru' | 'en' = 'ru'): TaskInput[] {
  return (lang === 'en' ? WELCOME_TASKS_EN : WELCOME_TASKS).map(({ dueToday, ...t }) => ({ ...t, ...(dueToday ? { due: { date: today } as DateSpec } : {}) }));
}

/** Ссылки http(s) в тексте: для показа кликабельными. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"«»]+/g)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    try {
      const u = new URL(url);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !out.includes(u.href)) out.push(u.href);
    } catch {
      // не ссылка
    }
  }
  return out;
}
