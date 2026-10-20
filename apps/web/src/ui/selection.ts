import { useSyncExternalStore } from 'react';

// Выделенные задачи: Ctrl или Cmd с щелчком на компьютере, долгое нажатие без перетаскивания на телефоне.
let picked: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function set(next: ReadonlySet<string>): void {
  picked = next;
  for (const fn of listeners) fn();
}

export function togglePicked(id: string): void {
  const next = new Set(picked);
  if (!next.delete(id)) next.add(id);
  set(next);
}

export function clearPicked(): void {
  if (picked.size > 0) set(new Set());
}

export function pickedIds(): ReadonlySet<string> {
  return picked;
}

export function usePicked(): ReadonlySet<string> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => picked,
  );
}
