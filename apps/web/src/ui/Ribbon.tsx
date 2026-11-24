/**
 * Лента дня (docs/time-planning.md, раздел 5): дела по порядку со временем начала, высота строки не зависит
 * от длительности, между делами строки «свободно N мин», текущее дело с полоской и остатком минут.
 * Перетаскивание меняет порядок (время пересчитывается встык), бросок задачи из списка ставит её в место
 * броска, нажатие на «свободно» добавляет дело в эту дыру.
 */
import { useEffect, useRef, useState } from 'react';
import { DAY_MINUTES, addDays, dayTimeline, nowMinute, parsePlan, parseTask, type CalEvent, type PlanDay, type TimelineRow, type TaskView, type Workspace } from '#core';
import { useCalendarEvents } from '../calendars.ts';
import { TZ, clockLabel, durationLabel, todayDate } from '../format.ts';
import { useDoc } from '../hooks.ts';
import { tr, trc } from '../i18n.ts';
import { haptic } from '../platform.ts';
import { afterLast, dayStartFor, insertPlan, placePieces, planDayFor, reorderPlan, spotStart, type DropSpot } from '../plan.ts';
import { DRAG_TYPE, dropZone } from './dnd.ts';
import { EventDetails } from './Events.tsx';
import { IconPin, IconRepeat } from './icons.tsx';
import { commitPlan, compactPlan, setPlanDate, shiftPlan, useNow, usePlanDate } from './planActions.ts';
import { createFromParsed, parseContext } from './QuickAdd.tsx';
import { completeWithUndo } from './Task.tsx';
import { showToast } from './toast.tsx';

const LONG_PRESS_MS = 450;
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

type TaskRowT = Extract<TimelineRow, { kind: 'task' }>;

/** Подпись длительности: «30 мин», «1 ч 30 мин». */
const dur = (m: number) => durationLabel(m);

/** Место броска по вертикали указателя: строка «свободно» под ним или промежуток между строками. */
function spotAt(list: HTMLElement, y: number, skip: string | null): DropSpot | null {
  const els = [...list.querySelectorAll<HTMLElement>('[data-rb-index]')];
  if (!els.length) return { kind: 'gap', index: 0 };
  for (const el of els) {
    if (skip && el.dataset.planId === skip) continue;
    const r = el.getBoundingClientRect();
    const index = Number(el.dataset.rbIndex);
    if (el.dataset.rbFree !== undefined && y >= r.top && y <= r.bottom) return { kind: 'free', start: Number(el.dataset.rbFree) };
    if (y < r.top + r.height / 2) return { kind: 'gap', index };
  }
  return { kind: 'gap', index: Number(els[els.length - 1]!.dataset.rbIndex) + 1 };
}

/** Номер среди строк-задач для промежутка перед строкой index. */
const taskIndexOf = (rows: readonly TimelineRow[], index: number) => rows.slice(0, index).filter((r) => r.kind === 'task').length;

/**
 * Поставить задачу в место броска. Задача уже в ленте этого дня — перестановка (или перенос в дыру),
 * иначе вставка: она встаёт за делом выше, следующие подвижные дела сдвигаются, если она на них налезла.
 */
function dropInto(doc: Workspace, day: PlanDay, rows: readonly TimelineRow[], taskId: string, spot: DropSpot, now: number): void {
  const inDay = rows.some((r) => r.kind === 'task' && r.id === taskId);
  if (inDay && spot.kind === 'gap') {
    commitPlan(doc, reorderPlan(day, taskId, taskIndexOf(rows, spot.index)), tr('Порядок изменён'));
    return;
  }
  const full: PlanDay = inDay ? day : { ...day, tasks: [...day.tasks, ...[doc.task(taskId)].filter((t): t is TaskView => !!t)] };
  const task = full.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const d = task.duration && task.duration > 0 ? task.duration : (day.defaultDuration ?? 15);
  const others = rows.filter((r) => !(r.kind === 'task' && r.id === taskId));
  // Номер промежутка считался по всем строкам; без самой задачи он сдвигается, если она была выше.
  const own = rows.findIndex((r) => r.kind === 'task' && r.id === taskId);
  const s = spot.kind === 'gap' && own >= 0 && own < spot.index ? { kind: 'gap' as const, index: spot.index - 1 } : spot;
  const start = spotStart(others, s, d, dayStartFor(day, now));
  commitPlan(doc, insertPlan(full, taskId, start), tr('В плане'));
}

/** Поле для дела в дыре или в конце ленты: фраза с «потом» добавляет цепочку встык. */
function PlanInput({ day, start, onDone }: { day: PlanDay; start: number; onDone: () => void }) {
  const doc = useDoc();
  const [text, setText] = useState('');
  const submit = () => {
    const value = text.trim();
    if (!value) return onDone();
    const ctx = parseContext(doc);
    const opts = { defaultDuration: day.defaultDuration ?? 15 };
    const chain = parsePlan(value, ctx, opts);
    const pieces = chain ? chain.map((p) => p.parsed) : [parseTask(value, ctx)];
    const placed = placePieces(
      pieces.filter((p) => p.title),
      day,
      start,
    );
    doc.group(() => placed.forEach((p) => createFromParsed(doc, p, { due: { date: day.date } })));
    haptic('light');
    showToast(tr('В плане'), { label: tr('Отменить'), run: () => doc.undo() });
    setText('');
    onDone();
  };
  return (
    <div className="rb-row rb-input">
      <span className="rb-time">{clockLabel(start)}</span>
      <input
        autoFocus
        value={text}
        aria-label={tr('Дело в плане')}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => (text.trim() ? submit() : onDone())}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      />
    </div>
  );
}

/** Переключатель дня: сегодня, завтра, любая дата. */
function DaySwitch({ date, today }: { date: string; today: string }) {
  const tomorrow = addDays(today, 1);
  const other = date !== today && date !== tomorrow;
  return (
    <div className="rb-head">
      <div className="segmented" role="group" aria-label={tr('День плана')}>
        <button className={date === today ? 'active' : ''} onClick={() => setPlanDate(today)}>
          {tr('Сегодня')}
        </button>
        <button className={date === tomorrow ? 'active' : ''} onClick={() => setPlanDate(tomorrow)}>
          {tr('Завтра')}
        </button>
      </div>
      <input
        type="date"
        className={`rb-date${other ? ' on' : ''}`}
        value={date}
        min={today}
        onChange={(e) => e.target.value && setPlanDate(e.target.value)}
        aria-label={tr('Дата плана')}
      />
    </div>
  );
}

/** «+15», «+30», «Уплотнить» у текущего дела. */
function RestActions({ date }: { date: string }) {
  const doc = useDoc();
  return (
    <div className="rb-actions" role="group" aria-label={tr('Остаток дня')}>
      <button onClick={() => shiftPlan(doc, date, 15)}>
        +15
      </button>
      <button onClick={() => shiftPlan(doc, date, 30)}>
        +30
      </button>
      <button onClick={() => compactPlan(doc, date)}>{tr('Уплотнить')}</button>
    </div>
  );
}

export function Ribbon({ onOpen, selectedId }: { onOpen: (id: string) => void; selectedId: string | null }) {
  const doc = useDoc();
  const date = usePlanDate();
  const today = todayDate();
  const now = useNow();
  const events = useCalendarEvents(date, 1);
  const day = planDayFor(doc, date, TZ, events, today);
  const rows = dayTimeline(day, now);
  const nm = nowMinute(date, now, TZ);
  const [adding, setAdding] = useState<number | 'end' | null>(null);
  const [drop, setDrop] = useState<DropSpot | null>(null);
  const [event, setEvent] = useState<CalEvent | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // Отпускание после перетаскивания не открывает карточку.
  const draggedAt = useRef(0);
  const live = useRef({ day, rows, now });
  live.current = { day, rows, now };
  useEffect(() => setAdding(null), [date]);

  const byId = new Map(day.tasks.map((t) => [t.id, t as TaskView]));
  const doDrop = (taskId: string, spot: DropSpot) => {
    const { day, rows, now } = live.current;
    dropInto(doc, day, rows, taskId, spot, now);
  };

  /** Перетаскивание строки ленты: копия едет за указателем, линия показывает, куда встанет. */
  const startDrag = (id: string, el: HTMLElement, x: number, y: number, touch: boolean) => {
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.add('drag-ghost', 'rb-ghost');
    Object.assign(ghost.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, margin: '0', zIndex: '50', pointerEvents: 'none' });
    document.body.appendChild(ghost);
    el.classList.add('drag-source');
    const scroller = el.closest('.plan-side') ?? el.closest('.content');
    let spot: DropSpot | null = null;
    let py = y;
    let frame = 0;
    const locate = () => {
      if (!list.current) return;
      const next = spotAt(list.current, py, id);
      if (JSON.stringify(next) !== JSON.stringify(spot)) {
        spot = next;
        setDrop(next);
      }
    };
    const tick = () => {
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (py < Math.max(r.top, 0) + 40) scroller.scrollTop -= 10;
        else if (py > Math.min(r.bottom, window.innerHeight) - 60) scroller.scrollTop += 10;
        locate();
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      py = e.clientY;
      ghost.style.transform = `translate(${e.clientX - x}px, ${e.clientY - y}px) scale(1.02)`;
      locate();
    };
    const noScroll = (e: TouchEvent) => e.preventDefault();
    const finish = (ok: boolean) => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('touchmove', noScroll);
      ghost.remove();
      el.classList.remove('drag-source');
      draggedAt.current = Date.now();
      setDrop(null);
      if (ok && spot) doDrop(id, spot);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    if (touch) document.addEventListener('touchmove', noScroll, { passive: false });
    ghost.style.transform = 'scale(1.02)';
    frame = requestAnimationFrame(tick);
    locate();
  };

  /** Мышь: перетаскивание после сдвига на 5 пикселей. Палец: долгое нажатие, как в календаре. */
  const pressProps = (id: string, enabled: boolean) => {
    if (!enabled) return {};
    return {
      onPointerDown(e: React.PointerEvent<HTMLElement>) {
        if ((e.target as HTMLElement).closest('button, input')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const el = e.currentTarget;
        const x = e.clientX;
        const y = e.clientY;
        const touch = e.pointerType !== 'mouse';
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
          clearTimeout(timer);
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', stop);
          document.removeEventListener('pointercancel', stop);
        };
        const move = (ev: PointerEvent) => {
          const far = Math.abs(ev.clientX - x) > (touch ? 10 : 5) || Math.abs(ev.clientY - y) > (touch ? 10 : 5);
          if (!far) return;
          stop();
          if (!touch) startDrag(id, el, x, y, false);
        };
        if (touch)
          timer = setTimeout(() => {
            stop();
            haptic('medium');
            startDrag(id, el, x, y, true);
          }, LONG_PRESS_MS);
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', stop);
        document.addEventListener('pointercancel', stop);
      },
      onContextMenu(e: React.MouseEvent) {
        if (coarse) e.preventDefault();
      },
    };
  };

  // Где показать «+15», «+30», «Уплотнить»: под текущим делом, иначе перед ближайшим следующим; у будущего дня сверху.
  const openAhead = rows.some((r) => r.kind === 'task' && !r.done && !r.fixed && (nm === null || r.end > nm));
  let actionsAt = -1;
  if (openAhead && nm !== DAY_MINUTES) {
    if (nm === null) actionsAt = 0;
    else {
      const cur = rows.findIndex((r) => r.kind !== 'free' && r.current);
      actionsAt = cur >= 0 ? cur + 1 : rows.findIndex((r) => r.kind !== 'free' && r.start >= nm);
    }
  }
  const endStart = afterLast(day, now);
  const line = (i: number) => drop?.kind === 'gap' && drop.index === i && <div className="rb-line" aria-hidden="true" />;

  const taskRow = (r: TaskRowT, i: number) => {
    const t = byId.get(r.id);
    const projected = !!t?.projected;
    const occurrence = t?.doneOccurrence;
    const project = t ? doc.project(t.projectId) : undefined;
    const over = r.start + r.duration > DAY_MINUTES;
    const progress = r.current && r.left !== null ? Math.min(100, Math.max(0, ((r.end - r.start - r.left) / (r.end - r.start)) * 100)) : 0;
    const canDrag = !r.done && !r.fixed && !projected;
    return (
      <div
        key={`t${r.id}@${r.start}`}
        className={`rb-row rb-task${r.current ? ' current' : ''}${r.done ? ' done' : ''}${r.fixed ? ' fixed' : ''}${over ? ' over' : ''}${selectedId === r.id ? ' selected' : ''}${projected ? ' projected' : ''}${canDrag ? ' movable' : ''}`}
        data-rb-index={i}
        data-plan-id={r.id}
        ref={(el) => {
          if (el) dropZone((id) => doDrop(id, { kind: 'gap', index: i + 1 })).ref(el);
        }}
        {...pressProps(r.id, canDrag)}
        onClick={() => {
          if (Date.now() - draggedAt.current < 400 || projected) return;
          onOpen(r.id);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && !projected && onOpen(r.id)}
      >
        <span className="rb-time" key={r.start}>
          {clockLabel(r.start)}
        </span>
        <button
          className={`check rb-check prio-${t?.priority ?? 4}${r.done ? ' checked' : ''}`}
          aria-label={r.done ? tr('Вернуть в работу') : tr('Выполнить')}
          disabled={projected || (r.done && occurrence !== undefined)}
          onClick={(e) => {
            e.stopPropagation();
            if (!t) return;
            if (r.done) doc.reopenTask(t.id);
            else {
              haptic('success');
              completeWithUndo(doc, t);
            }
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6.5 12.5l3.6 3.6 7.4-7.6" />
          </svg>
        </button>
        <span className="rb-title">{r.title || <span className="muted">{tr('Без названия')}</span>}</span>
        {t?.recurrence ? <IconRepeat className="rb-mark" /> : r.fixed && <IconPin className="rb-mark" aria-label={tr('Точное время')} />}
        {project && !project.isInbox && <i className={`rb-dot c-${project.color}`} aria-label={project.name} />}
        <span className={`rb-dur${r.defaultDuration ? ' guess' : ''}`}>{r.current && r.left !== null ? trc('остаток', 'ещё {n}').replace('{n}', dur(r.left)) : over ? `→ ${clockLabel((r.start + r.duration) % DAY_MINUTES)}` : dur(r.duration)}</span>
        {r.current && <i className="rb-progress" style={{ width: `${progress}%` }} aria-hidden="true" />}
      </div>
    );
  };

  return (
    <section
      className="ribbon"
      aria-label={tr('Лента')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE) || !list.current) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const next = spotAt(list.current, e.clientY, null);
        if (JSON.stringify(next) !== JSON.stringify(drop)) setDrop(next);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        const spot = drop ?? (list.current ? spotAt(list.current, e.clientY, null) : null);
        setDrop(null);
        if (!id || !spot) return;
        e.preventDefault();
        e.stopPropagation();
        doDrop(id, spot);
      }}
    >
      <DaySwitch date={date} today={today} />
      {actionsAt === 0 && <RestActions date={date} />}
      <div
        className={`rb-list${drop ? ' dropping' : ''}`}
        ref={(el) => {
          list.current = el;
          if (el) dropZone((id) => doDrop(id, { kind: 'gap', index: live.current.rows.length })).ref(el);
        }}
      >
        {rows.map((r, i) => (
          <div key={r.kind === 'free' ? `f${r.start}` : `${r.kind}${r.id}@${r.start}`} className="rb-slot">
            {i > 0 && actionsAt === i && <RestActions date={date} />}
            {line(i)}
            {r.kind === 'task' ? (
              taskRow(r, i)
            ) : r.kind === 'event' ? (
              <button
                className={`rb-row rb-event${r.current ? ' current' : ''}`}
                data-rb-index={i}
                style={{ ['--ec' as string]: r.color }}
                onClick={() => setEvent(events.find((e) => e.id === r.id) ?? null)}
              >
                <span className="rb-time">{clockLabel(r.start)}</span>
                <span className="rb-title">{r.title || tr('Без названия')}</span>
                <span className="rb-dur">{r.current && r.left !== null ? trc('остаток', 'ещё {n}').replace('{n}', dur(r.left)) : `${clockLabel(r.start)}-${clockLabel(r.end % DAY_MINUTES)}`}</span>
              </button>
            ) : adding === r.start ? (
              <PlanInput day={day} start={r.start} onDone={() => setAdding(null)} />
            ) : (
              <button
                className={`rb-row rb-free${drop?.kind === 'free' && drop.start === r.start ? ' over' : ''}`}
                data-rb-index={i}
                data-rb-free={r.start}
                ref={(el) => {
                  if (el) dropZone((id) => doDrop(id, { kind: 'free', start: r.start })).ref(el);
                }}
                onClick={() => setAdding(r.start)}
              >
                <span className="rb-time">{clockLabel(r.start)}</span>
                <span className="rb-title">{tr('свободно {n}', { n: dur(r.minutes) })}</span>
              </button>
            )}
          </div>
        ))}
        {actionsAt === rows.length && rows.length > 0 && <RestActions date={date} />}
        {line(rows.length)}
        {adding === 'end' ? (
          <PlanInput day={day} start={endStart} onDone={() => setAdding(null)} />
        ) : (
          nm !== DAY_MINUTES && (
            <button className="add-row rb-add" onClick={() => setAdding('end')}>
              + {tr('Добавить в план')}
            </button>
          )
        )}
      </div>
      {event && <EventDetails event={event} onClose={() => setEvent(null)} />}
    </section>
  );
}

/** Ширина области содержимого: на широком экране лента встаёт справа от списка. */
export function useContentWidth(): number {
  const [w, setW] = useState(() => document.querySelector('.content')?.clientWidth ?? window.innerWidth);
  useEffect(() => {
    const el = document.querySelector('.content');
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setW(entries[0]!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

/** С какой ширины содержимого лента стоит справа от списка. */
export const SIDE_RIBBON_MIN = 980;

/** Список слева, лента справа (широкий экран). */
export function PlanSplit({ children, onOpen, selectedId }: { children: React.ReactNode; onOpen: (id: string) => void; selectedId: string | null }) {
  return (
    <div className="plan-split">
      <div className="plan-main">{children}</div>
      <aside className="plan-side">
        <Ribbon onOpen={onOpen} selectedId={selectedId} />
      </aside>
    </div>
  );
}

