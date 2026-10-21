/**
 * Сад (docs/gamification.md, 6.5): каждый день с выполненными задачами — растение, неделя — грядка из семи мест.
 * Рисуется SVG на устройстве из данных ядра (computeGarden); цвета — переменные --g-* в styles.css.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { gameFeature, gardenDay, GARDEN_WEEKS, type GardenDay, type GardenSpecies, type GardenWeek } from '#core';
import { TZ, todayDate } from '../format.ts';
import { href, useDoc, useGame } from '../hooks.ts';
import { LOCALE, tn, tr } from '../i18n.ts';
import { IconX } from './icons.tsx';

type Pt = readonly [number, number];

/** Форма растения: стебель или ствол, листва, места для цветов и ягод. Координаты в поле 60×72 (видно с y = 9), земля на y = 62. */
interface Shape {
  readonly trunk?: string;
  readonly leaves: readonly string[];
  readonly blooms: readonly Pt[];
  readonly berries: readonly Pt[];
}

const SPROUT: Shape = {
  trunk: 'M30 62C30 57 30 53 31 48',
  leaves: ['M30.6 54C25 54 21 50 20 45c6 0 10 4 10.6 9z', 'M31 49c1-6 5-9 11-9-1 6-5 9-11 9z'],
  blooms: [[31, 46]],
  berries: [
    [21.5, 46.5],
    [40.5, 41.5],
  ],
};

/** Куст и дерево каждой породы. */
const SHAPES: Record<GardenSpecies, readonly [Shape, Shape]> = {
  round: [
    {
      leaves: ['M18 62a6 6 0 0 1 1-10 8 8 0 0 1 14-5 7 7 0 0 1 9 8 5 5 0 0 1-1 7z'],
      blooms: [
        [22, 55],
        [30, 49],
        [37, 55],
      ],
      berries: [
        [26, 53],
        [34, 51],
        [21, 59],
        [39, 59],
      ],
    },
    {
      trunk: 'M30 62V38M30 50l-5-5',
      leaves: ['M17 37a7 7 0 0 1 2-12 9 9 0 0 1 16-7 8 8 0 0 1 9 10 6 6 0 0 1-3 10z'],
      blooms: [
        [22, 29],
        [31, 22],
        [39, 29],
        [27, 34],
        [36, 35],
      ],
      berries: [
        [25, 24],
        [35, 26],
        [41, 33],
        [20, 33],
      ],
    },
  ],
  pine: [
    {
      trunk: 'M30 60v2',
      leaves: ['M30 39l8 12h-3l6 9H19l6-9h-3z'],
      blooms: [
        [30, 43],
        [25, 56],
        [35, 56],
      ],
      berries: [
        [28, 50],
        [33, 49],
        [22, 58],
        [38, 58],
      ],
    },
    {
      trunk: 'M30 55v7',
      leaves: ['M30 15l9 15h-3.5l8.5 14h-5l7 11H14l7-11h-5l8.5-14H21z'],
      blooms: [
        [30, 20],
        [25, 39],
        [35, 38],
        [21, 51],
        [39, 51],
      ],
      berries: [
        [28, 29],
        [33, 33],
        [30, 46],
        [26, 50],
      ],
    },
  ],
  poplar: [
    {
      trunk: 'M30 59v3',
      leaves: ['M30 40c6 4 7 14 5 19-2 3-8 3-10 0-2-5-1-15 5-19z'],
      blooms: [
        [30, 44],
        [27, 52],
        [33, 56],
      ],
      berries: [
        [32, 48],
        [28, 57],
        [26, 46],
        [34, 52],
      ],
    },
    {
      trunk: 'M30 62V40M30 36l4-4M30 29l-3.5-3.5',
      leaves: ['M30 13c10 6 11 20 8 28-2 5-14 5-16 0-3-8-2-22 8-28z'],
      blooms: [
        [30, 19],
        [25, 28],
        [35, 32],
        [27, 39],
        [34, 41],
      ],
      berries: [
        [33, 23],
        [26, 34],
        [31, 36],
        [24, 22],
      ],
    },
  ],
  acacia: [
    {
      leaves: ['M30 61c-6-1-12-5-13-11 6 0 11 4 13 11z', 'M30 61c-3-7-3-15 0-20 3 5 3 13 0 20z', 'M30 61c6-1 12-5 13-11-6 0-11 4-13 11z'],
      blooms: [
        [18, 50],
        [30, 42],
        [42, 50],
      ],
      berries: [
        [23, 55],
        [37, 55],
        [30, 49],
        [26, 59],
      ],
    },
    {
      trunk: 'M30 62V47M30 51l-7-11M30 49l7-10',
      leaves: ['M12 38.5c-2-5 2-9 7-8.5 1-4 6-5.5 9.5-3.5 3-3 9-2.5 10.5 1.5 5-1 9.5 3.5 8.5 9-7 3-28 3-35.5 1.5z'],
      blooms: [
        [17, 34],
        [25, 30],
        [34, 31],
        [42, 34],
        [30, 36],
      ],
      berries: [
        [21, 37],
        [29, 31],
        [38, 36],
        [45, 37],
      ],
    },
  ],
};

/** Места деревьев фокуса: два позади растения, два впереди. */
const FOCUS_SPOTS: readonly { x: number; y: number; back: boolean }[] = [
  { x: 10, y: 64, back: false },
  { x: 50, y: 64, back: false },
  { x: 17, y: 61, back: true },
  { x: 43, y: 61, back: true },
];
const MAX_FOCUS = FOCUS_SPOTS.length;

/** Маленькое дерево фокуса или росток прерванного отрезка: основание в (x, y). */
function FocusMark({ x, y, cut }: { x: number; y: number; cut: boolean }) {
  return cut ? (
    <g className="g-focus-cut" transform={`translate(${x} ${y})`}>
      <path className="g-stem" d="M0 0v-5" />
      <path className="g-focus-leaf" d="M0-3c-3 0-4-2-4-4 2 0 4 1 4 4zM0-4c0-3 2-4 4-4 0 2-1 4-4 4z" />
    </g>
  ) : (
    <g className="g-focus-tree" transform={`translate(${x} ${y})`}>
      <path className="g-stem" d="M0 0v-9" />
      <path className="g-focus-leaf" d="M0-17c3.6 2.2 4.6 6.4 3.3 9.1-1 1.8-5.6 1.8-6.6 0C-4.6-10.6-3.6-14.8 0-17z" />
    </g>
  );
}

/** Камушки на земле: по хешу даты, чтобы пустая грядка не была мёртвой. */
function Pebbles({ seed }: { seed: number }) {
  const a = 6 + (seed % 17);
  const b = 34 + ((seed >>> 5) % 20);
  return (
    <>
      <circle className="g-pebble" cx={a} cy={66 + ((seed >>> 3) % 3)} r="0.9" />
      <circle className="g-pebble" cx={b} cy={67 + ((seed >>> 8) % 3)} r="1.1" />
    </>
  );
}

/** Подпись дня, которая звучит в подсказке и для чтения с экрана. */
export function gardenDayLabel(d: GardenDay): string {
  const date = new Date(`${d.date}T12:00:00Z`).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const parts = [date[0]!.toUpperCase() + date.slice(1)];
  if (d.future) parts.push(tr('впереди'));
  else {
    parts.push(d.done ? tr('Выполнено: {n}', { n: d.done }) : tr('Задач не было'));
    if (d.goal !== null && !d.future) parts.push(`${tr('Цель дня')}: ${tr('{done} из {goal}', { done: d.done, goal: d.goal })}`);
    if (d.off) parts.push(d.off === 'rest' ? tr('выходной') : tr('отпуск'));
    if (d.focus || d.focusCut) parts.push(tr('Помодоро: {n}', { n: d.focus }) + (d.focusCut ? `, ${tr('прервано: {n}', { n: d.focusCut })}` : ''));
    if (d.habits) parts.push(tr('Привычки: {n}', { n: d.habits }));
  }
  return parts.join('. ');
}

/**
 * Растение одного дня. Когда данные дня меняются на глазах (выполнили задачу), растение мягко
 * подрастает: рост внутри стадии — плавным масштабом, новая стадия — коротким «прыжком» вверх.
 */
export const GardenPlant = memo(function GardenPlant({ day, className }: { day: GardenDay; className?: string }) {
  const sig = `${day.stage}|${day.bloom}|${Math.min(day.habits, 4)}|${Math.min(day.focus, MAX_FOCUS)}|${day.focusCut > 0}`;
  const prev = useRef(sig);
  const [grow, setGrow] = useState(false);
  useEffect(() => {
    if (prev.current === sig) return;
    prev.current = sig;
    setGrow(true);
    const t = setTimeout(() => setGrow(false), 900);
    return () => clearTimeout(t);
  }, [sig]);

  const shape = day.stage === 1 ? SPROUT : day.stage >= 2 ? SHAPES[day.species][day.stage - 2] : null;
  const scale = 0.84 + 0.16 * day.growth;
  // Наклон в пару градусов: одинаковые породы рядом не выглядят копиями.
  const tilt = ((day.seed >>> 4) % 7) - 3;
  const focus = Math.min(day.focus, MAX_FOCUS);
  const marks = [...Array.from({ length: focus }, () => false), ...Array.from({ length: Math.min(day.focusCut, MAX_FOCUS - focus) }, () => true)];
  const spots = marks.map((cut, i) => ({ ...FOCUS_SPOTS[i]!, cut }));
  const bloomShift = day.seed % 3;
  const blooms = shape && day.bloom ? (day.stage === 1 ? shape.blooms : shape.blooms.filter((_, i) => (i + bloomShift) % 5 !== 4)) : [];
  const berries = shape ? shape.berries.slice(0, Math.min(day.habits, shape.berries.length)) : [];
  return (
    <svg className={`g-plant sp-${day.species}${grow ? ' g-grow' : ''}${className ? ` ${className}` : ''}`} viewBox="0 9 60 63" aria-hidden="true" data-stage={day.stage}>
      <rect className="g-soil" x="-1" y="62" width="62" height="11" />
      <Pebbles seed={day.seed} />
      {spots.filter((s) => s.back).map((s, i) => <FocusMark key={`b${i}`} x={s.x} y={s.y} cut={s.cut} />)}
      {shape ? (
        <g className="g-main">
          <g className="g-body" style={{ transform: `rotate(${tilt}deg) scale(${scale})` }}>
            {shape.trunk && <path className="g-stem" d={shape.trunk} />}
            {shape.leaves.map((d, i) => (
              <path key={i} className="g-leaf" d={d} />
            ))}
            {berries.map(([x, y], i) => (
              <circle key={`r${i}`} className="g-berry" cx={x} cy={y} r="1.7" />
            ))}
            {blooms.map(([x, y], i) => (
              <g key={`f${i}`} className="g-bloom">
                <circle cx={x} cy={y} r="2.7" />
                <circle className="g-bloom-eye" cx={x} cy={y} r="1" />
              </g>
            ))}
          </g>
        </g>
      ) : day.today ? (
        // Сегодня ещё ничего: в земле семечко.
        <g className="g-main">
          <path className="g-seed-mound" d="M24 62.5c2-3 10-3 12 0" />
          <ellipse className="g-seed" cx="30" cy="59.6" rx="2" ry="1.4" />
        </g>
      ) : null}
      {spots.filter((s) => !s.back).map((s, i) => <FocusMark key={`f${i}`} x={s.x} y={s.y} cut={s.cut} />)}
      {day.off === 'rest' && <ellipse className="g-stone" cx="50" cy="65.5" rx="3.6" ry="2.3" />}
      {day.off === 'vacation' && (
        <g className="g-sign">
          <path d="M53 67v-9" />
          <rect x="48" y="53" width="10" height="6" rx="1.2" />
        </g>
      )}
    </svg>
  );
});

/** Росток таймера: растёт по доле прошедшего времени, законченный отрезок — дерево. */
export function FocusSprout({ progress, done, size = 22 }: { progress: number; done: boolean; size?: number }) {
  const p = Math.max(0, Math.min(1, progress));
  const leaf = 0.35 + 0.65 * Math.min(1, p / 0.6);
  return (
    <svg className={`focus-sprout${done ? ' done' : ''}`} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={done ? tr('Дерево фокуса выросло') : tr('Дерево фокуса растёт')}>
      <path className="fs-ground" d="M5 21.5h14" />
      {done ? (
        <g className="fs-tree">
          <path className="g-stem" d="M12 21.5v-9M12 17.5l-2.5-2.5" />
          <path className="g-focus-leaf" d="M12 2c4.6 2.8 5.9 8.2 4.3 11.6-1.2 2.3-7.4 2.3-8.6 0C6.1 10.2 7.4 4.8 12 2z" />
        </g>
      ) : (
        <g>
          <path className="g-stem fs-stem" d="M12 21.5V6.5" style={{ transform: `scaleY(${0.35 + 0.65 * p})` }} />
          <g className="fs-leaves" style={{ transform: `translateY(${(1 - p) * 9.75}px) scale(${leaf})` }}>
            <path className="g-focus-leaf" d="M12 10c-4 0-6-2.6-6.4-5.6 3.6 0 6.2 2.4 6.4 5.6zM12 8.4c.4-3 2.6-5 6-5-.4 3-2.6 5-6 5z" />
          </g>
        </g>
      )}
    </svg>
  );
}

const rangeLabel = (start: string) => {
  const a = new Date(`${start}T12:00:00Z`);
  const b = new Date(a.getTime() + 6 * 86_400_000);
  const same = a.getUTCMonth() === b.getUTCMonth();
  const day = (d: Date) => d.toLocaleDateString(LOCALE, { day: 'numeric', timeZone: 'UTC' });
  const full = (d: Date) => d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return same ? `${day(a)}–${full(b)}` : `${full(a)} – ${full(b)}`;
};

/** Грядка недели: семь мест с понедельника и подсказка выбранного дня под ней. */
const GardenBed = memo(function GardenBed({ week, selected, onSelect }: { week: GardenWeek; selected: string | null; onSelect: (date: string | null) => void }) {
  const done = week.days.reduce((n, d) => n + d.done, 0);
  const focus = week.days.reduce((n, d) => n + d.focus, 0);
  const chosen = week.days.find((d) => d.date === selected);
  return (
    <section className="g-week" aria-label={rangeLabel(week.start)}>
      <div className="g-week-head">
        <span className="g-week-range">{rangeLabel(week.start)}</span>
        <span className="muted">
          {done ? tn(done, 'задача', 'задачи', 'задач') : ''}
          {focus ? `${done ? ', ' : ''}${tr('{n} помодоро', { n: focus })}` : ''}
        </span>
      </div>
      <div className="g-bed" role="list">
        {week.days.map((d) => (
          <button
            key={d.date}
            role="listitem"
            className={`g-slot${d.today ? ' is-today' : ''}${d.future ? ' is-future' : ''}${d.date === selected ? ' sel' : ''}`}
            data-date={d.date}
            data-done={d.done}
            data-stage={d.stage}
            disabled={d.future}
            aria-label={gardenDayLabel(d)}
            aria-expanded={d.future ? undefined : d.date === selected}
            title={gardenDayLabel(d)}
            onClick={() => onSelect(d.date === selected ? null : d.date)}
          >
            <GardenPlant day={d} />
          </button>
        ))}
      </div>
      {chosen && (
        <div className="g-tip" role="status">
          <div className="g-tip-text">
            {gardenDayLabel(chosen)
              .split('. ')
              .map((line, i) => (i === 0 ? <b key={i}>{line}</b> : <span key={i}>{line}</span>))}
          </div>
          <button className="icon small" onClick={() => onSelect(null)} aria-label={tr('Закрыть')} title={tr('Закрыть')}>
            <IconX width={16} height={16} />
          </button>
        </div>
      )}
    </section>
  );
});

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 9, 19 + i, 12)).toLocaleDateString(LOCALE, { weekday: 'short', timeZone: 'UTC' }));

/** Экран «Сад»: последние недели грядками, свежая сверху, дальше по кнопке «Показать ещё». */
export function GardenView() {
  const doc = useDoc();
  const game = useGame();
  const [weeks, setWeeks] = useState(GARDEN_WEEKS);
  const [selected, setSelected] = useState<string | null>(null);
  if (!gameFeature(game, 'garden'))
    return (
      <>
        <header className="view-head">
          <h1>{tr('Сад')}</h1>
        </header>
        <p className="muted">
          {tr('Сад выключен в настройках.')}{' '}
          <a className="link" href={href({ view: 'settings' })}>
            {tr('Открыть настройки')}
          </a>
        </p>
      </>
    );
  const garden = doc.garden(TZ, todayDate(), weeks);
  return (
    <div className="garden">
      <header className="view-head">
        <h1>{tr('Сад')}</h1>
      </header>
      <p className="muted garden-about">
        {tr('Каждый день с выполненными задачами сажает растение. Цель дня распускает цветы, привычки дают ягоды, законченный помодоро сажает рядом дерево фокуса.')}
      </p>
      <p className="garden-sum">
        {tr('За {weeks}: {plants} и {trees}.', {
          weeks: tn(weeks, 'неделю', 'недели', 'недель'),
          plants: tn(garden.plants, 'растение', 'растения', 'растений'),
          trees: tn(garden.trees, 'дерево фокуса', 'дерева фокуса', 'деревьев фокуса'),
        })}
      </p>
      <div className="g-weekdays" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      {garden.weeks.map((w) => (
        <GardenBed key={w.start} week={w} selected={w.days.some((d) => d.date === selected) ? selected : null} onSelect={setSelected} />
      ))}
      {garden.older && (
        <button className="g-more" onClick={() => setWeeks((n) => n + GARDEN_WEEKS)}>
          {tr('Показать ещё')}
        </button>
      )}
    </div>
  );
}

/** Сегодняшнее растение в заголовке «Сегодня»: ведёт в сад, растёт на глазах при выполнении задач. */
export function GardenMini({ today }: { today: string }) {
  const doc = useDoc();
  const game = useGame();
  if (!gameFeature(game, 'garden')) return null;
  const day = doc.garden(TZ, today, 1).weeks[0]?.days.find((d) => d.date === today) ?? gardenDay(today, {}, game, today);
  const label = `${tr('Сад')}: ${gardenDayLabel(day)}`;
  return (
    <a className="garden-mini" href={href({ view: 'garden' })} aria-label={label} title={label} data-done={day.done} data-stage={day.stage}>
      <GardenPlant day={day} />
    </a>
  );
}
