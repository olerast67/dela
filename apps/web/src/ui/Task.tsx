import { useRef, useState, type MouseEvent } from 'react';
import { haptic } from '../platform.ts';
import { RescheduleSheet } from './Reschedule.tsx';
import { type TaskNode, type TaskView, type Workspace } from '#core';
import { dueLabel, dueTone, dateLabel, durationLabel } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { IconChevron, IconComment, IconDeadline, IconRepeat, IconSubtasks, IconTag } from './icons.tsx';
import { controller } from '../controller.ts';
import { DRAG_TYPE, draggedId, setDragged, useDropOnTask, type DropWhere } from './dnd.ts';
import { showToast } from './toast.tsx';

/** Порог смахивания, пикселей: дальше него отпускание выполняет действие. */
const SWIPE = 84;
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * Смахивание карточки пальцем вправо и влево. Мышью карточки не смахиваются (там перетаскивание).
 * Жест начинается, только если палец ушёл в сторону заметно больше, чем вверх или вниз: прокрутка не мешает.
 */
function useSwipe(enabled: boolean, onRight: () => void, onLeft: () => void) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const st = useRef<{ x: number; y: number; id: number; active: boolean; decided: boolean; passed: boolean; dx: number } | null>(null);
  const swiped = useRef(0);
  const end = () => {
    const s = st.current;
    st.current = null;
    if (!s?.active) return;
    setDragging(false);
    swiped.current = Date.now();
    if (s.passed && s.dx > 0) {
      setDx(window.innerWidth);
      setTimeout(onRight, 160);
    } else {
      setDx(0);
      if (s.passed && s.dx < 0) onLeft();
    }
  };
  return {
    dx,
    dragging,
    armed: Math.abs(dx) >= SWIPE,
    handlers: {
      onPointerDown(e: React.PointerEvent) {
        if (!enabled || e.pointerType !== 'touch') return;
        st.current = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false, decided: false, passed: false, dx: 0 };
      },
      onPointerMove(e: React.PointerEvent) {
        const s = st.current;
        if (!s || e.pointerId !== s.id) return;
        const mx = e.clientX - s.x;
        const my = e.clientY - s.y;
        if (!s.decided) {
          if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
          s.decided = true;
          s.active = Math.abs(mx) > Math.abs(my) * 1.4;
          if (!s.active) {
            st.current = null;
            return;
          }
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            // указатель уже отпущен
          }
          setDragging(true);
        }
        const limit = SWIPE * 1.6;
        const v = Math.abs(mx) > limit ? Math.sign(mx) * (limit + (Math.abs(mx) - limit) * 0.3) : mx;
        const passed = Math.abs(mx) >= SWIPE;
        if (passed !== s.passed) {
          s.passed = passed;
          if (passed) haptic('light');
        }
        s.dx = v;
        setDx(v);
      },
      onPointerUp: end,
      onPointerCancel: end,
      onClickCapture(e: React.MouseEvent) {
        // Отпускание после смахивания не открывает карточку.
        if (Date.now() - swiped.current < 400) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
    },
  };
}

export function completeWithUndo(doc: Workspace, task: TaskView): void {
  doc.completeTask(task.id);
  showToast(task.recurrence ? 'Перенесено на следующий раз' : 'Задача выполнена', { label: 'Отменить', run: () => doc.undo() });
}

export function TaskRow({
  task,
  onOpen,
  selected,
  showProject = false,
  showDate = true,
  depth = 0,
  collapsed,
  onToggle,
}: {
  task: TaskView;
  onOpen: (id: string) => void;
  selected?: boolean;
  showProject?: boolean;
  showDate?: boolean;
  depth?: number;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const doc = useDoc();
  const onDropTask = useDropOnTask();
  const [leaving, setLeaving] = useState(false);
  const [dropPos, setDropPos] = useState<DropWhere | null>(null);
  const done = task.completedAt !== null;
  const project = showProject ? doc.project(task.projectId) : undefined;
  const [resched, setResched] = useState(false);
  const swipe = useSwipe(
    !task.projected,
    () => {
      haptic('success');
      if (done) doc.reopenTask(task.id);
      else completeWithUndo(doc, task);
    },
    () => setResched(true),
  );

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (done) {
      doc.reopenTask(task.id);
      return;
    }
    if (task.projected) return;
    setLeaving(true);
    haptic('success');
    // Галочка успевает отрисоваться, потом строка уходит.
    setTimeout(() => completeWithUndo(doc, task), 280);
  }

  const labels = task.labels.map((id) => doc.label(id)).filter((l) => l && l.deletedAt === null);

  return (
    <div className="task-wrap" style={depth ? { marginLeft: `${depth * 24}px` } : undefined}>
      {swipe.dx !== 0 && (
        <div className={`swipe-under ${swipe.dx > 0 ? 'right' : 'left'}${swipe.armed ? ' armed' : ''}`} aria-hidden="true">
          <span>{swipe.dx > 0 ? (done ? 'Вернуть' : 'Готово') : 'Перенести'}</span>
        </div>
      )}
      {resched && <RescheduleSheet task={task} onClose={() => setResched(false)} />}
    <div
      {...swipe.handlers}
      className={`task${selected ? ' selected' : ''}${leaving ? ' leaving' : ''}${done ? ' done' : ''}${task.projected ? ' projected' : ''}${dropPos ? ` drop-${dropPos}` : ''}`}
      style={swipe.dx ? { transform: `translateX(${swipe.dx}px)`, transition: swipe.dragging ? 'none' : undefined } : undefined}
      data-id={task.id}
      draggable={!task.projected && !done && !coarse}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, task.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragged(task.id);
      }}
      onDragEnd={() => setDragged(null)}
      onDragOver={(e) => {
        if (!onDropTask || !e.dataTransfer.types.includes(DRAG_TYPE) || draggedId() === task.id) return;
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        setDropPos(y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside');
      }}
      onDragLeave={() => setDropPos(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        const where = dropPos;
        setDropPos(null);
        if (!onDropTask || !id || id === task.id || !where) return;
        e.preventDefault();
        e.stopPropagation();
        onDropTask(id, task, where);
      }}
      onClick={() => onOpen(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(task.id);
      }}
    >
      {onToggle ? (
        <button
          className={`twisty${collapsed ? '' : ' open'}`}
          aria-label={collapsed ? 'Показать подзадачи' : 'Скрыть подзадачи'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <IconChevron width={14} height={14} />
        </button>
      ) : (
        <span className="twisty-space" />
      )}
      <button
        className={`check prio-${task.priority}${leaving || done ? ' checked' : ''}`}
        aria-label={done ? 'Вернуть в работу' : 'Выполнить'}
        onClick={toggle}
        disabled={task.projected}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6.5 12.5l3.6 3.6 7.4-7.6" />
        </svg>
      </button>
      <div className="task-body">
        <div className="task-title">{task.title || <span className="muted">Без названия</span>}</div>
        {task.description && <div className="task-desc">{task.description.split('\n')[0]}</div>}
        <div className="task-meta">
          {showDate && task.due && (
            <span className={`due tone-${dueTone(task)}`}>
              {dueLabel(task.due)}
              {task.recurrence && <IconRepeat />}
            </span>
          )}
          {!showDate && task.due?.time && <span className="due">{task.due.time}</span>}
          {!showDate && task.recurrence && (
            <span className="due">
              <IconRepeat />
            </span>
          )}
          {task.duration && <span>{durationLabel(task.duration)}</span>}
          {task.deadline && (
            <span className="deadline">
              <IconDeadline /> {dateLabel(task.deadline)}
            </span>
          )}
          {(task.commentCount ?? 0) > 0 && (
            <span title="Комментарии">
              <IconComment /> {task.commentCount}
            </span>
          )}
          {task.childCount > 0 && (
            <span>
              <IconSubtasks /> {task.childCount}
            </span>
          )}
          {labels.map((l) => (
            <span key={l!.id} className={`label c-${l!.color}`}>
              <IconTag /> {l!.name}
            </span>
          ))}
          {task.assignee && (
            <span className="assignee" title={`Исполнитель: ${controller.memberEmail(doc.spaceOfTask(task.id), task.assignee) ?? 'участник'}`}>
              {(controller.memberEmail(doc.spaceOfTask(task.id), task.assignee) ?? '?')[0]!.toUpperCase()}
            </span>
          )}
          {project && (
            <span className={`project-ref c-${project.color}`}>
              <i className="dot" aria-hidden="true" />
              {project.isInbox ? 'Входящие' : project.name}
            </span>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

const collapsedTasks = new Set<string>();

export function TaskTree({
  nodes,
  onOpen,
  selectedId,
  depth = 0,
  showProject,
  showDate,
}: {
  nodes: readonly TaskNode[];
  onOpen: (id: string) => void;
  selectedId: string | null;
  depth?: number;
  showProject?: boolean;
  showDate?: boolean;
}) {
  const [, force] = useState(0);
  return (
    <>
      {nodes.map((n) => {
        const collapsed = collapsedTasks.has(n.task.id);
        return (
          <div key={n.task.id}>
            <TaskRow
              task={n.task}
              onOpen={onOpen}
              selected={selectedId === n.task.id}
              depth={depth}
              {...(showProject !== undefined ? { showProject } : {})}
              {...(showDate !== undefined ? { showDate } : {})}
              {...(n.children.length > 0
                ? {
                    collapsed,
                    onToggle: () => {
                      if (collapsed) collapsedTasks.delete(n.task.id);
                      else collapsedTasks.add(n.task.id);
                      force((x) => x + 1);
                    },
                  }
                : {})}
            />
            {!collapsed && n.children.length > 0 && (
              <TaskTree
                nodes={n.children}
                onOpen={onOpen}
                selectedId={selectedId}
                depth={depth + 1}
                {...(showProject !== undefined ? { showProject } : {})}
                {...(showDate !== undefined ? { showDate } : {})}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function TaskList({
  tasks,
  onOpen,
  selectedId,
  showProject = true,
  showDate = true,
}: {
  tasks: readonly TaskView[];
  onOpen: (id: string) => void;
  selectedId: string | null;
  showProject?: boolean;
  showDate?: boolean;
}) {
  return (
    <>
      {tasks.map((t) => (
        <TaskRow
          key={`${t.id}${t.projected ? `@${t.due?.date}` : ''}`}
          task={t}
          onOpen={onOpen}
          selected={selectedId === t.id}
          showProject={showProject}
          showDate={showDate}
        />
      ))}
    </>
  );
}
