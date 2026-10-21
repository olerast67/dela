/**
 * Всплывающая строка быстрого добавления (программа для Windows, Ctrl+Shift+Space): маленькое окно поверх
 * всех программ, только поле быстрого ввода. Задача пишется в общую базу, главное окно получает её
 * через BroadcastChannel и отправляет на сервер.
 */
import { useEffect, useRef, useState } from 'react';
import { controller } from '../controller.ts';
import { useAppState } from '../hooks.ts';
import { hideQuickWindow, onQuickWindowShown, quickWindowReady, resizeQuickWindow, showMainWindow } from '../platform.ts';
import { QuickAdd } from './QuickAdd.tsx';
import { tr } from '../i18n.ts';

export function QuickWindow() {
  const { phase, locked } = useAppState();
  // Каждый показ — чистое поле: QuickAdd собирается заново.
  const [seq, setSeq] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onQuickWindowShown(() => {
      // Вошли в главном окне, пока строка ждала скрытой: база уже другая.
      if (controller.getState().phase === 'auth') {
        location.reload();
        return;
      }
      void controller.reloadLock();
      setSeq((n) => n + 1);
    }).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    // Esc закрывает строку и на экране блокировки.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void hideQuickWindow();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      off?.();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Первый показ — когда база открыта: без белой вспышки пустого окна.
  const ready = useRef(false);
  useEffect(() => {
    if (phase === 'loading' || ready.current) return;
    ready.current = true;
    // Скрытое окно не рисует кадры, и ResizeObserver до показа молчит: высота задаётся сразу.
    const height = Math.ceil(box.current?.getBoundingClientRect().height ?? 0);
    void resizeQuickWindow(height)
      .then(() => quickWindowReady())
      .catch(() => undefined);
  }, [phase]);

  // Высота окна по содержимому: чипы и вставленный список делают строку выше.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => void resizeQuickWindow(Math.ceil(el.getBoundingClientRect().height)).catch(() => undefined));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hide = () => void hideQuickWindow();
  const openMain = () => void showMainWindow();

  let body: React.ReactNode = null;
  if (phase === 'auth' || phase === 'recovery') {
    body = <QuickNote text={tr('Войдите в Dela в главном окне, чтобы добавлять задачи.')} onCancel={hide} onOpen={openMain} />;
  } else if (locked) {
    // Строка не открывается PIN-кодом и не показывает ни проектов, ни меток: только главное окно.
    body = <QuickNote text={tr('Dela заблокирована PIN-кодом. Откройте главное окно и введите PIN.')} onCancel={hide} onOpen={openMain} />;
  } else if (phase === 'ready' && controller.doc) {
    body = <QuickAdd key={seq} onClose={hide} onAdded={hide} compact={false} />;
  }

  return (
    <div className="quick-window" ref={box}>
      {body}
    </div>
  );
}

function QuickNote({ text, onCancel, onOpen }: { text: string; onCancel: () => void; onOpen: () => void }) {
  return (
    <div className="quick-add quick-note" role="alert">
      <p>{text}</p>
      <div className="qa-actions">
        <button type="button" onClick={onCancel}>
          {tr('Отмена')}
        </button>
        <button type="button" className="primary" onClick={onOpen} autoFocus>
          {tr('Открыть Dela')}
        </button>
      </div>
    </div>
  );
}
