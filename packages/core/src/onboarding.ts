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

export function welcomeTasks(today: string): TaskInput[] {
  return WELCOME_TASKS.map(({ dueToday, ...t }) => ({ ...t, ...(dueToday ? { due: { date: today } as DateSpec } : {}) }));
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
