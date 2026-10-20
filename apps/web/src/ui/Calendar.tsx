/**
 * Календарь: месяц, неделя, три дня и день. В неделе и дне задачи со временем стоят в сетке часов:
 * их можно перетащить на другой час или день и растянуть за нижний край (длительность).
 * Задачи без времени лежат в строке «Весь день»; оттуда их перетаскивают в сетку, так планируется день.
 * На телефоне задачу берут долгим нажатием и ведут пальцем.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addDays, addMonths, layoutDay, monthGrid, monthStart, moveDue, slotOf, snapMinute, weekDates, type DateSpec, type TaskView } from '#core';
import { TZ, clock, clockLabel, dateLabel, hourLabel, monthTitle, rangeTitle, todayDate, weekdayShort } from '../format.ts';
import { navigate, useDoc, useMedia } from '../hooks.ts';
import { DRAG_TYPE, setDragged } from './dnd.ts';
import type { QuickAddDefaults } from './QuickAdd.tsx';
import { completeWithUndo } from './Task.tsx';
import { OptionsPopover } from './ViewOptions.tsx';
import { tr } from '../i18n.ts';
import { haptic } from '../platform.ts';

export type CalendarMode = 'day' | '3day' | 'week' | 'month';
type ColorBy = 'priority' | 'project';

/** Высота часа в сетке, пикселей. */
const HOUR = 48;
/** Задача без длительности занимает в сетке полчаса. */
const DEFAULT_DURATION = 30;

const MODE_KEY = 'dela.calendarMode';
/** Цвет задач, скрытие будущих повторов и боковая панель: настройки отображения этого устройства. */
const COLOR_KEY = 'dela.calendarColor';
const REPEATS_KEY = 'dela.calendarHideRepeats';
const SIDE_KEY = 'dela.calendarSide';

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // без хранилища настройка живёт до перезагрузки
  }
}

/** Чем красить задачи в сетке: приоритетом или цветом проекта. */
const ColorContext = createContext<ColorBy>('priority');

function useToneClass(): (t: TaskView) => string {
  const by = useContext(ColorContext);
  const doc = useDoc();
  return (t) => (by === 'priority' ? `prio-${t.priority}` : `by-project c-${doc.project(t.projectId)?.color ?? 'gray'}`);
}

function savedMode(narrow: boolean): CalendarMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'day' || m === '3day' || m === 'week' || m === 'month') return m;
  } catch {
    // нет доступа к хранилищу
  }
  return narrow ? 'day' : 'week';
}

/** На сколько минут ниже верха задачи её взяли мышью: при броске верх встаёт туда же. */
let grabOffset = 0;

// ---------- перетаскивание пальцем ----------

const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** Сколько держать палец на задаче, чтобы её взять. */
const LONG_PRESS_MS = 450;

/** Куда бросят задачу, если отпустить палец сейчас: день месяца, строка «Весь день» или час в сетке. */
type TouchOver = { kind: 'day' | 'allday'; date: string } | { kind: 'time'; date: string; minute: number };

interface TouchDrag {
  readonly over: TouchOver | null;
  readonly begin: (task: TaskView, el: HTMLElement, x: number, y: number) => void;
}

const TouchContext = createContext<TouchDrag>({ over: null, begin: () => {} });

let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number; id: number } | null = null;
/** Когда закончилось перетаскивание пальцем: щелчок, который браузер пришлёт следом, задачу не открывает. */
let touchEndedAt = 0;

function cancelPress(): void {
  if (press) clearTimeout(press.timer);
  press = null;
}

function justDragged(): boolean {
  return Date.now() - touchEndedAt < 400;
}

/** Долгое нажатие пальцем на задаче начинает перетаскивание. Мышью задачи тащат обычным drag and drop. */
function touchProps(t: TaskView, begin: TouchDrag['begin']) {
  if (t.projected) return {};
  return {
    onPointerDown(e: React.PointerEvent<HTMLElement>) {
      if (e.pointerType !== 'touch') return;
      cancelPress();
      const el = e.currentTarget;
      const x = e.clientX;
      const y = e.clientY;
      const timer = setTimeout(() => {
        press = null;
        haptic('medium');
        begin(t, el, x, y);
      }, LONG_PRESS_MS);
      press = { timer, x, y, id: e.pointerId };
    },
    onPointerMove(e: React.PointerEvent) {
      if (press && e.pointerId === press.id && (Math.abs(e.clientX - press.x) > 10 || Math.abs(e.clientY - press.y) > 10)) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onContextMenu(e: React.MouseEvent) {
      if (coarse) e.preventDefault();
    },
  };
}

function sameOver(a: TouchOver | null, b: TouchOver | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.date === b.date && (a.kind !== 'time' || a.minute === (b as typeof a).minute);
}

/**
 * Копия задачи едет за пальцем, под пальцем подсвечивается день или линия часа.
 * Прокрутка страницы на время жеста выключена; у верхнего и нижнего края сетка прокручивается сама.
 */
function trackTouchDrag(el: HTMLElement, x: number, y: number, scroller: HTMLElement | null, onOver: (o: TouchOver | null) => void, onEnd: (o: TouchOver | null) => void): void {
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    zIndex: '50',
    pointerEvents: 'none',
    transform: 'scale(1.03)',
  });
  document.body.appendChild(ghost);
  el.classList.add('drag-source');
  // Блок из сетки встаёт верхом туда, где был его верх под пальцем, как при перетаскивании мышью.
  const grab = el.classList.contains('cal-block') ? ((y - rect.top) / HOUR) * 60 : 0;
  let px = x;
  let py = y;
  let over: TouchOver | null = null;
  const locate = () => {
    const zone = document.elementFromPoint(px, py)?.closest<HTMLElement>('[data-drop]');
    let next: TouchOver | null = null;
    const date = zone?.dataset.date;
    if (zone && date) {
      if (zone.dataset.drop === 'time') next = { kind: 'time', date, minute: snapMinute(((py - zone.getBoundingClientRect().top) / HOUR) * 60 - grab) };
      else next = { kind: zone.dataset.drop === 'allday' ? 'allday' : 'day', date };
    }
    if (!sameOver(next, over)) {
      over = next;
      onOver(next);
    }
  };
  let frame = 0;
  const tick = () => {
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const top = Math.max(r.top, 0);
      // Нижняя панель вкладок на телефоне закрывает конец сетки: край считается от неё.
      const bar = document.querySelector('.tabbar')?.getBoundingClientRect();
      const bottom = Math.min(r.bottom, window.innerHeight, bar && bar.height > 0 ? bar.top : Infinity);
      if (py < top + 48 && scroller.scrollTop > 0) {
        scroller.scrollTop -= 10;
        locate();
      } else if (py > bottom - 48 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight) {
        scroller.scrollTop += 10;
        locate();
      }
    }
    frame = requestAnimationFrame(tick);
  };
  const move = (e: PointerEvent) => {
    px = e.clientX;
    py = e.clientY;
    ghost.style.transform = `translate(${px - x}px, ${py - y}px) scale(1.03)`;
    locate();
  };
  const noScroll = (e: TouchEvent) => e.preventDefault();
  const finish = (drop: boolean) => {
    cancelAnimationFrame(frame);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('touchmove', noScroll);
    ghost.remove();
    el.classList.remove('drag-source');
    touchEndedAt = Date.now();
    onEnd(drop ? over : null);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('touchmove', noScroll, { passive: false });
  frame = requestAnimationFrame(tick);
  locate();
}

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
  const [color, setColor] = useState<ColorBy>(() => (readPref(COLOR_KEY) === 'project' ? 'project' : 'priority'));
  const [hideRepeats, setHideRepeats] = useState(() => readPref(REPEATS_KEY) === '1');
  // На широком экране панель открыта, пока её не закрыли; на узком она прячется за кнопкой.
  const [sideOpen, setSideOpen] = useState(() => readPref(SIDE_KEY) !== '0');
  const [sheet, setSheet] = useState(false);
  // Узко бывает и на компьютере, когда открыта карточка задачи: тогда панель тоже прячется за кнопку,
  // иначе она сжимала колонки недели до нескольких пикселей.
  const root = useRef<HTMLDivElement>(null);
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setTight(e!.contentRect.width < 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = narrow || tight;
  const showSide = compact ? sheet : sideOpen;

  const go = (m: CalendarMode, d: string) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // нет доступа к хранилищу
    }
    navigate({ view: 'calendar', mode: m, date: d === today ? null : d });
  };
  const step = (dir: 1 | -1) => go(mode, mode === 'month' ? addMonths(monthStart(anchor), dir) : addDays(anchor, dir * (mode === 'week' ? 7 : mode === '3day' ? 3 : 1)));

  const dates = mode === 'month' ? monthGrid(anchor) : mode === 'week' ? weekDates(anchor) : mode === '3day' ? [anchor, addDays(anchor, 1), addDays(anchor, 2)] : [anchor];
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  // Будущие повторы (projected) можно скрыть: остаётся только ближайший настоящий срок задачи.
  const byDate = new Map(doc.upcoming(first, dates.length, TZ).map((g) => [g.date, hideRepeats ? g.tasks.filter((t) => !t.projected) : g.tasks]));
  // Просроченные показываются в «Весь день» сегодня: их удобно сразу разложить по часам.
  // Когда открыта боковая панель, они лежат там и в сетке не повторяются.
  if (byDate.has(today) && !showSide) {
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
  const unscheduled = doc.today(today, TZ).overdue.length + doc.openTasks().filter((t) => !t.due).length;

  // Панель поверх сетки уходит с дороги, пока из неё тащат задачу.
  const [sideAway, setSideAway] = useState(false);
  const [touchOver, setTouchOver] = useState<TouchOver | null>(null);
  const touch: TouchDrag = {
    over: touchOver,
    begin(task, el, x, y) {
      const fromSheet = compact && el.closest('.cal-side') !== null;
      if (fromSheet) setSideAway(true);
      const scroller = root.current?.querySelector<HTMLElement>('.cal-body') ?? root.current?.closest<HTMLElement>('.content') ?? null;
      trackTouchDrag(el, x, y, scroller, setTouchOver, (o) => {
        setTouchOver(null);
        if (fromSheet) {
          setSideAway(false);
          // Задачу бросили в сетку: панель закрывается, как после перетаскивания мышью. Отпустили мимо: панель остаётся.
          if (o) setSheet(false);
        }
        if (o) move(task.id, o.date, o.kind === 'time' ? o.minute : null, o.kind === 'allday');
      });
    },
  };

  return (
    <ColorContext.Provider value={color}>
    <TouchContext.Provider value={touch}>
    <div className={`calendar calendar-${mode}`} ref={root}>
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
                ['3day', tr('3 дня')],
                ['week', tr('Неделя')],
                ['month', tr('Месяц')],
              ] as const
            ).map(([m, label]) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => go(m, anchor)}>
                {label}
              </button>
            ))}
          </div>
          <OptionsPopover label={tr('Вид')} title={tr('Цвет задач и повторы')} on={color !== 'priority' || hideRepeats}>
            <label>
              <span>{tr('Цвет задач')}</span>
              <select
                value={color}
                onChange={(e) => {
                  const v = e.target.value === 'project' ? 'project' : 'priority';
                  setColor(v);
                  writePref(COLOR_KEY, v);
                }}
              >
                <option value="priority">{tr('По приоритету')}</option>
                <option value="project">{tr('По проекту')}</option>
              </select>
            </label>
            <label className="checkline">
              <input
                type="checkbox"
                checked={hideRepeats}
                onChange={(e) => {
                  setHideRepeats(e.target.checked);
                  writePref(REPEATS_KEY, e.target.checked ? '1' : '0');
                }}
              />
              {tr('Скрыть будущие повторы')}
            </label>
          </OptionsPopover>
          <button
            className={`cal-side-toggle${showSide ? ' active' : ''}`}
            aria-expanded={showSide}
            onClick={() => {
              if (compact) setSheet(!sheet);
              else {
                setSideOpen(!sideOpen);
                writePref(SIDE_KEY, sideOpen ? '0' : '1');
              }
            }}
          >
            {tr('Не запланировано')} <span className="muted">{unscheduled}</span>
          </button>
        </div>
      </header>
      <div className="cal-layout">
      <div className="cal-main">
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
      {showSide && <SidePanel today={today} onOpen={onOpen} selectedId={selectedId} sheet={compact} away={sideAway} onAway={setSideAway} onClose={() => setSheet(false)} />}
      </div>
    </div>
    </TouchContext.Provider>
    </ColorContext.Provider>
  );
}

/**
 * Боковая панель: просроченные задачи и задачи без даты. Их перетаскивают на день месяца,
 * в строку «Весь день» или на час в сетке: задача получает дату (и время).
 * Когда места мало, панель открывается кнопкой поверх сетки (на телефоне снизу); когда задачу потащили, она уходит с дороги.
 */
function SidePanel(props: {
  today: string;
  onOpen: (id: string) => void;
  selectedId: string | null;
  sheet: boolean;
  away: boolean;
  onAway: (away: boolean) => void;
  onClose: () => void;
}) {
  const { today, onOpen, selectedId, sheet, away, onAway, onClose } = props;
  const doc = useDoc();
  const overdue = doc.today(today, TZ).overdue;
  const undated = doc.openTasks().filter((t) => !t.due);
  return (
    <aside
      className={`cal-side${sheet ? ' sheet' : ''}${away ? ' away' : ''}`}
      aria-label={tr('Не запланировано')}
      onDragStart={() => sheet && setTimeout(() => onAway(true), 0)}
      onDragEnd={() => {
        if (!sheet) return;
        onAway(false);
        onClose();
      }}
    >
      {sheet && (
        <div className="cal-side-head">
          <b>{tr('Не запланировано')}</b>
          <button className="icon" onClick={onClose} aria-label={tr('Закрыть')}>
            ×
          </button>
        </div>
      )}
      <h2>
        {tr('Просрочено')} <span className="muted">{overdue.length || ''}</span>
      </h2>
      {overdue.length === 0 && <p className="muted">{tr('Просроченных задач нет.')}</p>}
      {overdue.map((t) => (
        <Chip key={t.id} task={t} onOpen={onOpen} selected={t.id === selectedId} showTime={false} note={t.due ? dateLabel(t.due.date, today) : undefined} />
      ))}
      <h2>
        {tr('Без даты')} <span className="muted">{undated.length || ''}</span>
      </h2>
      {undated.length === 0 && <p className="muted">{tr('Задач без даты нет.')}</p>}
      {undated.map((t) => (
        <Chip key={t.id} task={t} onOpen={onOpen} selected={t.id === selectedId} showTime={false} />
      ))}
      <p className="muted cal-side-hint">
        {coarse ? tr('Удерживайте задачу и перетащите её на день или на час в сетке, чтобы назначить срок.') : tr('Перетащите задачу на день или на час в сетке, чтобы назначить срок.')}
      </p>
    </aside>
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

function Chip({ task, onOpen, selected, showTime, note }: { task: Overdue; onOpen: (id: string) => void; selected: boolean; showTime: boolean; note?: string | undefined }) {
  const doc = useDoc();
  const tone = useToneClass();
  const { begin } = useContext(TouchContext);
  const slot = task.due ? slotOf(task.due, TZ) : null;
  return (
    <div
      className={`cal-chip ${tone(task)}${selected ? ' selected' : ''}${task.overdueMark ? ' overdue' : ''}${task.projected ? ' projected' : ''}`}
      data-id={task.id}
      {...dragProps(task)}
      {...touchProps(task, begin)}
      onClick={() => !justDragged() && onOpen(task.id)}
      title={task.title}
    >
      <button
        className="cal-dot"
        aria-label={tr('Выполнить: {title}', { title: task.title })}
        disabled={task.projected}
        onClick={(e) => {
          e.stopPropagation();
          if (justDragged()) return;
          completeWithUndo(doc, task);
        }}
      />
      {showTime && slot && <span className="cal-time">{clockLabel(slot.minute)}</span>}
      <span className="cal-title">{task.title}</span>
      {note && <span className="cal-time cal-note">{note}</span>}
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
  const [mouseOver, setOver] = useState<string | null>(null);
  const touchOver = useContext(TouchContext).over;
  const over = touchOver?.kind === 'day' ? touchOver.date : mouseOver;
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
            data-drop="day"
            data-date={d}
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
  const tone = useToneClass();
  const body = useRef<HTMLDivElement>(null);
  const now = useNowMinute();
  const [mouseIndicator, setIndicator] = useState<{ date: string; minute: number } | null>(null);
  const [mouseAllDayOver, setAllDayOver] = useState<string | null>(null);
  const touch = useContext(TouchContext);
  const indicator = touch.over?.kind === 'time' ? touch.over : mouseIndicator;
  const allDayOver = touch.over?.kind === 'allday' ? touch.over.date : mouseAllDayOver;
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
            data-drop="allday"
            data-date={d}
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
                {h === 0 ? '' : hourLabel(h)}
              </div>
            ))}
          </div>
          {dates.map((d) => (
            <div
              key={d}
              className={`cal-col${d === today ? ' today' : ''}`}
              data-drop="time"
              data-date={d}
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
                if (e.target !== e.currentTarget || justDragged()) return;
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
                    className={`cal-block ${tone(t)}${t.id === selectedId ? ' selected' : ''}${t.projected ? ' projected' : ''}${height < 36 ? ' short' : ''}`}
                    data-id={t.id}
                    style={{
                      top: (p.start / 60) * HOUR,
                      height: height - 2,
                      left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                      width: `calc(${100 / p.cols}% - 4px)`,
                    }}
                    {...dragProps(t)}
                    {...touchProps(t, touch.begin)}
                    onClick={() => !justDragged() && onOpen(t.id)}
                    title={t.title}
                  >
                    <span className="cal-title">{t.title}</span>
                    <span className="cal-time">
                      {clockLabel(p.start)}-{clockLabel(p.end)}
                    </span>
                    {!t.projected && <div className="cal-resize" onPointerDown={(e) => startResize(e, t, p.start)} aria-hidden="true" />}
                  </div>
                );
              })}
              {indicator?.date === d && <div className="cal-indicator" style={{ top: (indicator.minute / 60) * HOUR }} data-time={clockLabel(indicator.minute)} />}
              {d === today && <div className="cal-now" style={{ top: (now / 60) * HOUR }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
