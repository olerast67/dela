import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Workspace } from '#core';
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

export type Route =
  | { view: 'inbox' }
  | { view: 'today' }
  | { view: 'upcoming' }
  | { view: 'project'; id: string }
  | { view: 'label'; id: string }
  | { view: 'filter'; id: string }
  | { view: 'search'; q: string }
  | { view: 'completed' }
  | { view: 'trash' }
  | { view: 'settings' };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [view, id] = path.split('/');
  switch (view) {
    case 'inbox':
    case 'upcoming':
    case 'completed':
    case 'trash':
    case 'settings':
      return { view };
    case 'project':
    case 'label':
    case 'filter':
      return id ? { view, id: decodeURIComponent(id) } : { view: 'today' };
    case 'search':
      return { view: 'search', q: new URLSearchParams(query).get('q') ?? '' };
    default:
      return { view: 'today' };
  }
}

export function href(route: Route): string {
  switch (route.view) {
    case 'project':
    case 'label':
    case 'filter':
      return `#/${route.view}/${encodeURIComponent(route.id)}`;
    case 'search':
      return `#/search?q=${encodeURIComponent(route.q)}`;
    default:
      return `#/${route.view}`;
  }
}

export function navigate(route: Route): void {
  location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
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
