/**
 * Перетаскивание задач (мышь, компьютер). Экран задаёт, что значит «бросить задачу сюда»:
 * в проекте — переставить, в «Предстоящих» — перенести на день, в боковой панели — в проект.
 */
import { createContext, useContext } from 'react';
import type { TaskView } from '#core';

export const DRAG_TYPE = 'application/x-dela-task';

export type DropWhere = 'before' | 'after' | 'inside';

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

/** Обработчики для области, на которую можно бросить задачу (день, проект в боковой панели). */
export function dropZone(onDrop: (taskId: string) => void) {
  return {
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
