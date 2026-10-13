import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { tr } from '../i18n.ts';

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

/** Без кнопки плашка висит 2,5 с; с кнопкой («Отменить») 4 с, чтобы успеть нажать. */
export function showToast(text: string, action?: Toast['action'], ms = action ? 4000 : 2500): void {
  clearTimeout(timer);
  current = { id: ++seq, text, ...(action ? { action } : {}) };
  emit();
  timer = setTimeout(hideToast, ms);
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
  return <ToastView toast={toast} key={toast.id} />;
}

/** Плашку можно смахнуть в сторону или вниз; пока палец на ней, она не исчезает. */
function ToastView({ toast }: { toast: Toast }) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const [shift, setShift] = useState<{ x: number; y: number } | null>(null);
  const [leaving, setLeaving] = useState<'left' | 'right' | 'down' | null>(null);
  const end = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 60 || dy > 30) {
      setLeaving(Math.abs(dx) > 60 ? (dx < 0 ? 'left' : 'right') : 'down');
      setTimeout(hideToast, 160);
      return;
    }
    setShift(null);
    // Палец отпустили, плашка остаётся: ещё немного времени на кнопку и уходит.
    clearTimeout(timer);
    timer = setTimeout(hideToast, 2000);
  };
  const style: React.CSSProperties | undefined = leaving
    ? undefined
    : shift ? { transform: `translate(calc(-50% + ${shift.x}px), ${Math.max(0, shift.y)}px)`, opacity: Math.max(0.3, 1 - Math.abs(shift.x) / 240), transition: 'none' } : undefined;
  return (
    <div
      className={`toast${leaving ? ` toast-leave-${leaving}` : ''}`}
      role="status"
      style={style}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        clearTimeout(timer);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s && s.id === e.pointerId) setShift({ x: e.clientX - s.x, y: e.clientY - s.y });
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
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
      <button className="toast-close" aria-label={tr('Скрыть уведомление')} onClick={hideToast}>
        ×
      </button>
    </div>
  );
}
