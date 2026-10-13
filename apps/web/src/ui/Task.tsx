import { useState, type MouseEvent } from 'react';
import { type Doc, type TaskNode, type TaskView } from '#core';
import { dueLabel, dueTone, dateLabel, durationLabel } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { IconChevron, IconDeadline, IconRepeat, IconSubtasks, IconTag } from './icons.tsx';
import { showToast } from './toast.tsx';

export function completeWithUndo(doc: Doc, task: TaskView): void {
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
  const [leaving, setLeaving] = useState(false);
  const done = task.completedAt !== null;
  const project = showProject ? doc.project(task.projectId) : undefined;

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (done) {
      doc.reopenTask(task.id);
      return;
    }
    if (task.projected) return;
    setLeaving(true);
    // Галочка успевает отрисоваться, потом строка уходит.
    setTimeout(() => completeWithUndo(doc, task), 280);
  }

  const labels = task.labels.map((id) => doc.label(id)).filter((l) => l && l.deletedAt === null);

  return (
    <div
      className={`task${selected ? ' selected' : ''}${leaving ? ' leaving' : ''}${done ? ' done' : ''}${task.projected ? ' projected' : ''}`}
      style={{ paddingLeft: `${depth * 28}px` }}
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
          {project && !project.isInbox && <span className="project-ref">{project.name}</span>}
          {project?.isInbox && <span className="project-ref">Входящие</span>}
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
