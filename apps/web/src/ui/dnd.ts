/**
 * Перетаскивание задач (мышь, компьютер). Экран задаёт, что значит «бросить задачу сюда»:
 * в проекте — переставить, в «Предстоящих» — перенести на день, в боковой панели — в проект.
 */
import { createContext, useContext } from 'react';
import type { TaskView } from '#core';

export const DRAG_TYPE = 'application/x-dela-task';

export type DropWhere = 'before' | 'after' | 'inside';

/** Сколько держать задачу над серединой строки, чтобы сделать её подзадачей (палец). */
const INSIDE_HOLD_MS = 450;

export type DropOnTask = (draggedId: string, target: TaskView, where: DropWhere) => void;

export const DropContext = createContext<DropOnTask | null>(null);

export function useDropOnTask(): DropOnTask | null {
  return useContext(DropContext);
}

let dragged: string | null = null;

export function setDragged(id: string | null): void {
  dragged = id;
}

export function draggedId(): string | null {
  return dragged;
}

// ---------- перетаскивание пальцем (долгое нажатие на телефоне) ----------

/** Области, куда можно бросить задачу пальцем: заголовки дней, разделы, проекты. */
const touchZones = new WeakMap<Element, (taskId: string) => void>();
/** Строки задач, на которые можно бросить другую задачу. */
const touchTasks = new WeakMap<Element, { task: TaskView; drop: DropOnTask }>();

export function registerTouchTask(el: Element | null, task: TaskView, drop: DropOnTask | null): void {
  if (el && drop) touchTasks.set(el, { task, drop });
}

/**
 * Начать перетаскивание пальцем: копия строки едет за пальцем, под ней подсвечивается место.
 * Прокрутка страницы на время жеста выключена, у краёв экрана список прокручивается сам.
 */
/** onEnd(moved): moved false, если палец отпустили на месте, не перетаскивая. */
export function startTouchDrag(taskId: string, source: HTMLElement, x: number, y: number, onEnd: (moved: boolean) => void): void {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, margin: '0', zIndex: '50', pointerEvents: 'none' });
  document.body.appendChild(ghost);
  source.classList.add('drag-source');
  const dy0 = y - rect.top;
  const scroller = source.closest('.content');
  let marked: Element | null = null;
  let markClass = '';
  let target: { kind: 'task'; el: Element; where: DropWhere } | { kind: 'zone'; el: Element } | null = null;
  setDragged(taskId);

  const unmark = () => {
    if (marked) marked.classList.remove(markClass);
    marked = null;
  };
  // Вложить задачу пальцем можно, только задержав её над серединой строки: иначе при обычном
  // перетаскивании задача случайно становилась подзадачей.
  let middleRow: Element | null = null;
  let middleSince = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const locate = (cx: number, cy: number) => {
    unmark();
    target = null;
    clearTimeout(holdTimer);
    const hit = document.elementFromPoint(cx, cy);
    const row = hit?.closest('.task[data-id]');
    if (row && row !== source && touchTasks.has(row)) {
      const r = row.getBoundingClientRect();
      const rel = (cy - r.top) / r.height;
      const middle = rel >= 0.35 && rel <= 0.65;
      if (!middle || middleRow !== row) {
        middleRow = middle ? row : null;
        middleSince = Date.now();
      }
      const held = middle && Date.now() - middleSince >= INSIDE_HOLD_MS;
      if (middle && !held) holdTimer = setTimeout(() => locate(cx, cy), INSIDE_HOLD_MS);
      const where: DropWhere = held ? 'inside' : rel < 0.5 ? 'before' : 'after';
      target = { kind: 'task', el: row, where };
      marked = row;
      markClass = `drop-${where}`;
      row.classList.add(markClass);
      return;
    }
    let zone: Element | null = hit ?? null;
    while (zone && !touchZones.has(zone)) zone = zone.parentElement;
    if (zone) {
      target = { kind: 'zone', el: zone };
      marked = zone;
      markClass = 'drop-target';
      zone.classList.add(markClass);
    }
  };
  let moved = false;
  const move = (e: PointerEvent) => {
    if (Math.abs(e.clientX - x) > 10 || Math.abs(e.clientY - y) > 10) moved = true;
    ghost.style.transform = `translateY(${e.clientY - dy0 - rect.top}px) scale(1.03)`;
    if (scroller) {
      if (e.clientY < 90) scroller.scrollTop -= 12;
      else if (e.clientY > window.innerHeight - 140) scroller.scrollTop += 12;
    }
    locate(e.clientX, e.clientY);
  };
  const noScroll = (e: TouchEvent) => e.preventDefault();
  const finish = (drop: boolean) => {
    clearTimeout(holdTimer);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('touchmove', noScroll);
    unmark();
    ghost.remove();
    source.classList.remove('drag-source');
    setDragged(null);
    const t = target as typeof target;
    if (drop && t) {
      if (t.kind === 'task') {
        const info = touchTasks.get(t.el)!;
        info.drop(taskId, info.task, t.where);
      } else touchZones.get(t.el)!(taskId);
    }
    onEnd(moved);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('touchmove', noScroll, { passive: false });
  ghost.style.transform = 'scale(1.03)';
}

/** Обработчики для области, на которую можно бросить задачу (день, проект в боковой панели). */
export function dropZone(onDrop: (taskId: string) => void) {
  return {
    ref(el: Element | null) {
      if (el) touchZones.set(el, onDrop);
    },
    onDragOver(e: React.DragEvent) {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      (e.currentTarget as HTMLElement).classList.add('drop-target');
    },
    onDragLeave(e: React.DragEvent) {
      (e.currentTarget as HTMLElement).classList.remove('drop-target');
    },
    onDrop(e: React.DragEvent) {
      (e.currentTarget as HTMLElement).classList.remove('drop-target');
      const id = e.dataTransfer.getData(DRAG_TYPE);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      onDrop(id);
    },
  };
}
