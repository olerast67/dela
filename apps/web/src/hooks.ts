import { useEffect, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { GameSettings, InputSettings, Workspace } from '#core';
import { controller, type AppState } from './controller.ts';

export function useAppState(): AppState {
  return useSyncExternalStore(controller.subscribe, controller.getState);
}

/** Документ и номер его версии: компонент перерисовывается при любом изменении данных. */
export function useDoc(): Workspace {
  useSyncExternalStore(controller.subscribeDoc, controller.getDocVersion);
  const doc = controller.doc;
  if (!doc) throw new Error('document is not loaded');
  return doc;
}

/** Настройки игровых элементов (запись личного пространства); перерисовка при любом изменении данных, как useDoc. */
export function useGame(): GameSettings {
  return useDoc().getGameSettings();
}

/** Настройки ввода задач (своя запись личного пространства): распознавать ли сроки, проекты и метки в тексте. */
export function useInputSettings(): InputSettings {
  return useDoc().getInputSettings();
}

/** Атрибут data-game на <html>: по нему CSS включает анимации выполнения. Выключено — всё как раньше. */
export function useGameAttribute(): void {
  const on = useGame().enabled;
  useEffect(() => {
    document.documentElement.toggleAttribute('data-game', on);
  }, [on]);
}

export type Route =
  | { view: 'inbox' }
  | { view: 'today' }
  | { view: 'upcoming' }
  | { view: 'calendar'; mode: 'day' | '3day' | 'week' | 'month' | null; date: string | null }
  | { view: 'project'; id: string }
  | { view: 'label'; id: string }
  | { view: 'filter'; id: string }
  /** Ссылка на задачу: открывает её проект с карточкой. */
  | { view: 'task'; id: string }
  | { view: 'search'; q: string }
  | { view: 'completed' }
  | { view: 'activity' }
  | { view: 'stats' }
  /** Итоги недели с понедельника week; null — список последних недель. */
  | { view: 'review'; week: string | null }
  | { view: 'garden' }
  | { view: 'templates' }
  | { view: 'trash' }
  | { view: 'settings' };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [view, id] = path.split('/');
  switch (view) {
    case 'inbox':
    case 'upcoming':
    case 'completed':
    case 'activity':
    case 'stats':
    case 'garden':
    case 'templates':
    case 'trash':
    case 'settings':
      return { view };
    case 'project':
    case 'label':
    case 'filter':
    case 'task':
      return id ? { view, id: decodeURIComponent(id) } : { view: 'today' };
    case 'search':
      return { view: 'search', q: new URLSearchParams(query).get('q') ?? '' };
    case 'review':
      return { view: 'review', week: id && /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : null };
    case 'calendar': {
      const date = new URLSearchParams(query).get('d');
      return {
        view: 'calendar',
        mode: id === 'day' || id === '3day' || id === 'week' || id === 'month' ? id : null,
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      };
    }
    default:
      return { view: 'today' };
  }
}

export function href(route: Route): string {
  switch (route.view) {
    case 'project':
    case 'label':
    case 'filter':
    case 'task':
      return `#/${route.view}/${encodeURIComponent(route.id)}`;
    case 'search':
      return `#/search?q=${encodeURIComponent(route.q)}`;
    case 'review':
      return `#/review${route.week ? `/${route.week}` : ''}`;

    case 'calendar':
      return `#/calendar${route.mode ? `/${route.mode}` : ''}${route.date ? `?d=${route.date}` : ''}`;
    default:
      return `#/${route.view}`;
  }
}

export function navigate(route: Route): void {
  location.hash = href(route);
}

/** Экран при запуске (настройки): адрес вида «#/inbox», хранится на этом устройстве. */
export function startHash(): string | null {
  try {
    const v = localStorage.getItem('startView');
    return v && v.startsWith('#/') ? v : null;
  } catch {
    return null;
  }
}

export function setStartHash(hash: string | null): void {
  try {
    if (hash) localStorage.setItem('startView', hash);
    else localStorage.removeItem('startView');
  } catch {
    // без хранилища приложение открывается на «Сегодня»
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => {
    // Запуск без адреса экрана открывает экран из настроек; ссылка на конкретный экран важнее.
    const start = startHash();
    if (start && (location.hash === '' || location.hash === '#' || location.hash === '#/')) history.replaceState(null, '', start);
    return parseRoute(location.hash);
  });
  useEffect(() => {
    const on = () => {
      const next = parseRoute(location.hash);
      const doc = document as Document & { startViewTransition?: (fn: () => void) => unknown };
      if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(() => flushSync(() => setRoute(next)));
      else setRoute(next);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** Медиа-запрос как состояние. */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}
