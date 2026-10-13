/**
 * Календарь: месяц, неделя и день. В неделе и дне задачи со временем стоят в сетке часов:
 * их можно перетащить на другой час или день и растянуть за нижний край (длительность).
 * Задачи без времени лежат в строке «Весь день»; оттуда их перетаскивают в сетку, так планируется день.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addDays, addMonths, layoutDay, monthGrid, monthStart, moveDue, slotOf, snapMinute, weekDates, type DateSpec, type TaskView } from '#core';
import { TZ, clock, monthTitle, rangeTitle, todayDate, weekdayShort } from '../format.ts';
import { navigate, useDoc, useMedia } from '../hooks.ts';
import { DRAG_TYPE, setDragged } from './dnd.ts';
import type { QuickAddDefaults } from './QuickAdd.tsx';
import { completeWithUndo } from './Task.tsx';
import { tr } from '../i18n.ts';

export type CalendarMode = 'day' | 'week' | 'month';

/** Высота часа в сетке, пикселей. */
const HOUR = 48;
/** Задача без длительности занимает в сетке полчаса. */
const DEFAULT_DURATION = 30;

const MODE_KEY = 'dela.calendarMode';

function savedMode(narrow: boolean): CalendarMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'day' || m === 'week' || m === 'month') return m;
  } catch {
    // нет доступа к хранилищу
  }
  return narrow ? 'day' : 'week';
}

/** На сколько минут ниже верха задачи её взяли мышью: при броске верх встаёт туда же. */
let grabOffset = 0;

interface Props {
  readonly mode: CalendarMode | null;
  readonly date: string | null;
  readonly onOpen: (id: string) => void;
  readonly selectedId: string | null;
  readonly onQuickAdd: (defaults: QuickAddDefaults) => void;
}

export function CalendarView({ mode: routeMode, date: routeDate, onOpen, selectedId, onQuickAdd }: Props) {
  const doc = useDoc();
  const narrow = useMedia('(max-width: 760px)');
  const today = todayDate();
  const mode = routeMode ?? savedMode(narrow);
  const anchor = routeDate ?? today;

  const go = (m: CalendarMode, d: string) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // нет доступа к хранилищу
    }
    navigate({ view: 'calendar', mode: m, date: d === today ? null : d });
  };
  const step = (dir: 1 | -1) => go(mode, mode === 'month' ? addMonths(monthStart(anchor), dir) : addDays(anchor, dir * (mode === 'week' ? 7 : 1)));

  const dates = mode === 'month' ? monthGrid(anchor) : mode === 'week' ? weekDates(anchor) : [anchor];
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  const byDate = new Map(doc.upcoming(first, dates.length, TZ).map((g) => [g.date, g.tasks]));
  // Просроченные показываются в «Весь день» сегодня: их удобно сразу разложить по часам.
  if (byDate.has(today)) {
    const overdue = doc.today(today, TZ).overdue;
    byDate.set(today, [...overdue.map((t) => ({ ...t, overdueMark: true }) as TaskView), ...(byDate.get(today) ?? [])]);
    for (const d of dates) if (d < today) byDate.set(d, (byDate.get(d) ?? []).filter((t) => !overdue.some((o) => o.id === t.id)));
  }

  const move = (taskId: string, date: string, minute: number | null, allDayRow = false) => {
    const t = doc.task(taskId);
    if (!t) return;
    const due: DateSpec = allDayRow ? { date } : moveDue(t.due, date, minute, TZ);
    doc.updateTask(taskId, { due });
  };

  const title = mode === 'month' ? monthTitle(anchor) : rangeTitle(first, last);

  return (
    <div className={`calendar calendar-${mode}`}>
      <header className="view-head cal-head">
        <h1>{title}</h1>
        <div className="cal-nav">
          <button className="icon" onClick={() => step(-1)} aria-label={tr('Назад')}>
            ‹
          </button>
          <button onClick={() => go(mode, today)}>{tr('Сегодня')}</button>
          <button className="icon" onClick={() => step(1)} aria-label={tr('Вперёд')}>
            ›
          </button>
          <div className="segmented" role="tablist" aria-label={tr('Вид календаря')}>
            {(
              [
                ['day', tr('День')],
                ['week', tr('Неделя')],
                ['month', tr('Месяц')],
              ] as const
            ).map(([m, label]) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => go(m, anchor)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>
      {mode === 'month' ? (
        <MonthGrid
          dates={dates}
          anchor={anchor}
          today={today}
          byDate={byDate}
          onOpen={onOpen}
          selectedId={selectedId}
          onDropDay={(id, d) => move(id, d, null)}
          onDay={(d) => go('day', d)}
        />
      ) : (
        <TimeGrid
          dates={dates}
          today={today}
          byDate={byDate}
          onOpen={onOpen}
          selectedId={selectedId}
          onMove={move}
          onDay={(d) => go('day', d)}
          onQuickAdd={onQuickAdd}
        />
      )}
    </div>
  );
}

type Overdue = TaskView & { overdueMark?: boolean };

function dragProps(t: TaskView) {
  if (t.projected) return {};
  return {
    draggable: true,
    onDragStart(e: React.DragEvent<HTMLElement>) {
      e.dataTransfer.setData(DRAG_TYPE, t.id);
      e.dataTransfer.effectAllowed = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      grabOffset = e.currentTarget.classList.contains('cal-block') ? ((e.clientY - rect.top) / HOUR) * 60 : 0;
      setDragged(t.id);
    },
    onDragEnd() {
      setDragged(null);
    },
  };
}

function Chip({ task, onOpen, selected, showTime }: { task: Overdue; onOpen: (id: string) => void; selected: boolean; showTime: boolean }) {
  const doc = useDoc();
  const slot = task.due ? slotOf(task.due, TZ) : null;
  return (
    <div
      className={`cal-chip prio-${task.priority}${selected ? ' selected' : ''}${task.overdueMark ? ' overdue' : ''}${task.projected ? ' projected' : ''}`}
      data-id={task.id}
      {...dragProps(task)}
      onClick={() => onOpen(task.id)}
      title={task.title}
    >
      <button
        className="cal-dot"
        aria-label={tr('Выполнить: {title}', { title: task.title })}
        disabled={task.projected}
        onClick={(e) => {
          e.stopPropagation();
          completeWithUndo(doc, task);
        }}
      />
      {showTime && slot && <span className="cal-time">{clock(slot.minute)}</span>}
      <span className="cal-title">{task.title}</span>
    </div>
  );
}

function acceptDrop(e: React.DragEvent): boolean {
  if (!e.dataTransfer.types.includes(DRAG_TYPE)) return false;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return true;
}

function MonthGrid(props: {
  dates: string[];
  anchor: string;
  today: string;
  byDate: Map<string, TaskView[]>;
  onOpen: (id: string) => void;
  selectedId: string | null;
  onDropDay: (taskId: string, date: string) => void;
  onDay: (date: string) => void;
}) {
  const { dates, anchor, today, byDate, onOpen, selectedId, onDropDay, onDay } = props;
  const month = anchor.slice(0, 7);
  const [over, setOver] = useState<string | null>(null);
  const LIMIT = 4;
  return (
    <div className="cal-month">
      {dates.slice(0, 7).map((d) => (
        <div key={d} className="cal-weekday">
          {weekdayShort(d)}
        </div>
      ))}
      {dates.map((d) => {
        const tasks = byDate.get(d) ?? [];
        return (
          <div
            key={d}
            className={`cal-cell${d.slice(0, 7) !== month ? ' other' : ''}${d === today ? ' today' : ''}${over === d ? ' drop-target' : ''}`}
            onDragOver={(e) => acceptDrop(e) && setOver(d)}
            onDragLeave={() => setOver((o) => (o === d ? null : o))}
            onDrop={(e) => {
              setOver(null);
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (!id) return;
              e.preventDefault();
              onDropDay(id, d);
            }}
          >
            <button className="cal-daynum" onClick={() => onDay(d)} aria-label={tr('Открыть день {d}', { d: d })}>
              {Number(d.slice(8))}
            </button>
            {tasks.slice(0, LIMIT).map((t) => (
              <Chip key={`${t.id}-${d}`} task={t} onOpen={onOpen} selected={t.id === selectedId} showTime />
            ))}
            {tasks.length > LIMIT && (
              <button className="cal-more" onClick={() => onDay(d)}>
                {tr('ещё {n}', { n: tasks.length - LIMIT })}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function useNowMinute(): number {
  const get = () => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  };
  const [now, setNow] = useState(get);
  useEffect(() => {
    const id = setInterval(() => setNow(get()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function TimeGrid(props: {
  dates: string[];
  today: string;
  byDate: Map<string, TaskView[]>;
  onOpen: (id: string) => void;
  selectedId: string | null;
  onMove: (taskId: string, date: string, minute: number | null, allDayRow?: boolean) => void;
  onDay: (date: string) => void;
  onQuickAdd: (defaults: QuickAddDefaults) => void;
}) {
  const { dates, today, byDate, onOpen, selectedId, onMove, onDay, onQuickAdd } = props;
  const doc = useDoc();
  const body = useRef<HTMLDivElement>(null);
  const now = useNowMinute();
  const [indicator, setIndicator] = useState<{ date: string; minute: number } | null>(null);
  const [allDayOver, setAllDayOver] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ id: string; duration: number } | null>(null);

  const timed = new Map<string, Array<{ task: TaskView; start: number; end: number }>>();
  const allDay = new Map<string, TaskView[]>();
  for (const d of dates) {
    const items: Array<{ task: TaskView; start: number; end: number }> = [];
    const untimed: TaskView[] = [];
    for (const t of byDate.get(d) ?? []) {
      const slot = t.due && !(t as Overdue).overdueMark ? slotOf(t.due, TZ) : null;
      if (!slot) {
        untimed.push(t);
        continue;
      }
      const duration = resizing?.id === t.id ? resizing.duration : (t.duration ?? DEFAULT_DURATION);
      items.push({ task: t, start: slot.minute, end: Math.min(24 * 60, slot.minute + Math.max(duration, 15)) });
    }
    timed.set(d, items);
    allDay.set(d, untimed);
  }

  // Сетка открывается на текущем часе, если в ней есть сегодня, иначе на первой задаче или на 8:00.
  const firstKey = dates.join();
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const starts = dates.flatMap((d) => (timed.get(d) ?? []).map((i) => i.start));
    const focus = dates.includes(today) ? now : starts.length ? Math.min(...starts) : 8 * 60;
    el.scrollTop = Math.max(0, (focus / 60) * HOUR - 2 * HOUR);
  }, [firstKey]);

  const minuteAt = (e: React.DragEvent | React.MouseEvent, col: HTMLElement, offset = 0) => {
    const rect = col.getBoundingClientRect();
    return snapMinute(((e.clientY - rect.top) / HOUR) * 60 - offset);
  };

  const startResize = (e: React.PointerEvent, task: TaskView, start: number) => {
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY;
    const base = task.duration ?? DEFAULT_DURATION;
    let current = base;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMoveEv = (ev: PointerEvent) => {
      const next = Math.max(15, Math.min(24 * 60 - start, snapMinute(base + ((ev.clientY - y0) / HOUR) * 60)));
      if (next !== current) {
        current = next;
        setResizing({ id: task.id, duration: next });
      }
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMoveEv);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      setResizing(null);
      if (current !== base) doc.updateTask(task.id, { duration: current });
    };
    target.addEventListener('pointermove', onMoveEv);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  return (
    <div className="cal-time-grid" style={{ ['--cols' as string]: dates.length }}>
      <div className="cal-row cal-dates">
        <div className="cal-gutter" />
        {dates.map((d) => (
          <button key={d} className={`cal-date${d === today ? ' today' : ''}`} onClick={() => onDay(d)}>
            <span>{weekdayShort(d)}</span>
            <b>{Number(d.slice(8))}</b>
          </button>
        ))}
      </div>
      <div className="cal-row cal-allday">
        <div className="cal-gutter">{tr('Весь день')}</div>
        {dates.map((d) => (
          <div
            key={d}
            className={`cal-allday-cell${allDayOver === d ? ' drop-target' : ''}`}
            onDragOver={(e) => acceptDrop(e) && setAllDayOver(d)}
            onDragLeave={() => setAllDayOver((o) => (o === d ? null : o))}
            onDrop={(e) => {
              setAllDayOver(null);
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (!id) return;
              e.preventDefault();
              onMove(id, d, null, true);
            }}
          >
            {(allDay.get(d) ?? []).map((t) => (
              <Chip key={`${t.id}-${d}`} task={t} onOpen={onOpen} selected={t.id === selectedId} showTime={false} />
            ))}
          </div>
        ))}
      </div>
      <div className="cal-body" ref={body}>
        <div className="cal-hours">
          <div className="cal-gutter">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="cal-hour-label" style={{ top: h * HOUR }}>
                {h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}
              </div>
            ))}
          </div>
          {dates.map((d) => (
            <div
              key={d}
              className={`cal-col${d === today ? ' today' : ''}`}
              style={{ height: 24 * HOUR }}
              onDragOver={(e) => {
                if (!acceptDrop(e)) return;
                const minute = minuteAt(e, e.currentTarget, grabOffset);
                setIndicator((i) => (i?.date === d && i.minute === minute ? i : { date: d, minute }));
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIndicator(null);
              }}
              onDrop={(e) => {
                setIndicator(null);
                const id = e.dataTransfer.getData(DRAG_TYPE);
                if (!id) return;
                e.preventDefault();
                onMove(id, d, minuteAt(e, e.currentTarget, grabOffset));
                grabOffset = 0;
              }}
              onClick={(e) => {
                if (e.target !== e.currentTarget) return;
                const minute = Math.floor(minuteAt(e, e.currentTarget) / 30) * 30;
                onQuickAdd({ due: { date: d, time: clock(minute) } });
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="cal-line" style={{ top: h * HOUR }} />
              ))}
              {layoutDay((timed.get(d) ?? []).map((i) => ({ id: i.task.id, start: i.start, end: i.end }))).map((p) => {
                const item = timed.get(d)!.find((i) => i.task.id === p.id)!;
                const t = item.task;
                const height = ((p.end - p.start) / 60) * HOUR;
                return (
                  <div
                    key={`${t.id}-${d}`}
                    className={`cal-block prio-${t.priority}${t.id === selectedId ? ' selected' : ''}${t.projected ? ' projected' : ''}${height < 36 ? ' short' : ''}`}
                    data-id={t.id}
                    style={{
                      top: (p.start / 60) * HOUR,
                      height: height - 2,
                      left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                      width: `calc(${100 / p.cols}% - 4px)`,
                    }}
                    {...dragProps(t)}
                    onClick={() => onOpen(t.id)}
                    title={t.title}
                  >
                    <span className="cal-title">{t.title}</span>
                    <span className="cal-time">
                      {clock(p.start)}-{clock(p.end)}
                    </span>
                    {!t.projected && <div className="cal-resize" onPointerDown={(e) => startResize(e, t, p.start)} aria-hidden="true" />}
                  </div>
                );
              })}
              {indicator?.date === d && <div className="cal-indicator" style={{ top: (indicator.minute / 60) * HOUR }} data-time={clock(indicator.minute)} />}
              {d === today && <div className="cal-now" style={{ top: (now / 60) * HOUR }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
