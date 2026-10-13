import { useEffect, useSyncExternalStore } from 'react';

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

let current: Toast | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function showToast(text: string, action?: Toast['action'], ms = 5000): void {
  clearTimeout(timer);
  current = { id: ++seq, text, ...(action ? { action } : {}) };
  emit();
  timer = setTimeout(() => {
    current = null;
    emit();
  }, ms);
}

export function hideToast(): void {
  clearTimeout(timer);
  current = null;
  emit();
}

export function ToastHost() {
  const toast = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
  useEffect(() => () => clearTimeout(timer), []);
  if (!toast) return null;
  return (
    <div className="toast" role="status" key={toast.id}>
      <span>{toast.text}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            hideToast();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
