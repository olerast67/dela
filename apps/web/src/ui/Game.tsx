/** Игровые элементы: празднование «День закрыт», цели дня и недели и раздел настроек (docs/gamification.md). */
import { useEffect, useState } from 'react';
import { DAILY_GOAL_MAX, WEEKLY_GOAL_MAX, type GameSettings, type GoalDayState, type GoalProgress } from '#core';
import { TZ, todayDate } from '../format.ts';
import { useDoc, useGame } from '../hooks.ts';
import { dayJustClosed, onDayClosed, onGoalReached } from '../game.ts';
import { EmptyArt } from './EmptyArt.tsx';
import { IconCheck, IconX } from './icons.tsx';
import { LOCALE, tn, tr } from '../i18n.ts';
import { showToast } from './toast.tsx';

/** Кусочки конфетти: угол разлёта, дальность, поворот, форма и цвет. Расчёт один на всё приложение. */
const PIECES = Array.from({ length: 18 }, (_, i) => {
  const angle = (i / 18) * Math.PI * 2 + (i % 3) * 0.17;
  const dist = 70 + ((i * 37) % 50);
  return {
    x: Math.round(Math.cos(angle) * dist * 1.5),
    y: Math.round(Math.sin(angle) * dist * 0.8),
    r: ((i * 97) % 300) - 150,
    shape: i % 3 === 0 ? 'leaf' : i % 3 === 1 ? 'dot' : 'bar',
    color: ['var(--accent)', 'var(--p2)', 'var(--c-yellow)', 'var(--p3)', 'var(--c-pink)'][i % 5],
    delay: (i % 4) * 25,
  };
});

/** Вспышка листьев и конфетти из одной точки; слой не ловит нажатия. */
function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {PIECES.map((p, i) => (
        <i
          key={i}
          className={`piece ${p.shape}`}
          style={{ ['--x' as string]: `${p.x}px`, ['--y' as string]: `${p.y}px`, ['--r' as string]: `${p.r}deg`, ['--pc' as string]: p.color, animationDelay: `${p.delay}ms` }}
        />
      ))}
    </div>
  );
}

/** Празднование идёт 1,5 с и снимается само. */
function useCelebration(initial: boolean): [boolean, () => void] {
  const [seq, setSeq] = useState(initial ? 1 : 0);
  useEffect(() => {
    if (!seq) return;
    const t = setTimeout(() => setSeq(0), 1600);
    return () => clearTimeout(t);
  }, [seq]);
  return [seq > 0, () => setSeq((n) => n + 1)];
}

/**
 * Спокойное пустое «Сегодня», когда за день что-то сделано. Если день закрыт только что
 * и празднования включены — из ростка вылетают листья, надпись «День закрыт» мягко появляется.
 */
export function DayDone({ done, today }: { done: number; today: string }) {
  const game = useGame();
  const doc = useDoc();
  const goal = game.dailyGoal !== null ? doc.goals(TZ, today).day : null;
  const goalMet = goal?.goal != null && goal.done >= goal.goal;
  const [burst] = useCelebration(game.celebrations && dayJustClosed());
  return (
    <div className={`empty with-art day-done${burst ? ' celebrate' : ''}`}>
      <div className="day-done-art">
        <EmptyArt kind="dayDone" />
        {burst && <Confetti />}
      </div>
      <p>
        <strong className="day-done-title">{tr('День закрыт')}</strong>
        <br />
        {tr('Выполнено сегодня: {n}.', { n: done })}
        {goalMet && ` ${tr('Цель дня выполнена.')}`}
        <br />
        {tr('Остаток дня свободен.')}
      </p>
    </div>
  );
}

/** «День закрыт» на доске «Сегодня»: пустого экрана там нет, поэтому короткая надпись поверх. */
export function DayClosedBurst() {
  const [on, start] = useCelebration(false);
  useEffect(() => onDayClosed(start), []);
  if (!on) return null;
  return (
    <div className="day-closed" role="status">
      <Confetti />
      <div className="day-closed-pill">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z" />
          <path d="M5 19l7-7" />
        </svg>
        {tr('День закрыт')}
      </div>
    </div>
  );
}

/** «Цель дня выполнена» поверх «Сегодня», когда задачи ещё есть: тихая надпись без конфетти. */
export function GoalBurst() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => onGoalReached(setText), []);
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => setText(null), 1600);
    return () => clearTimeout(t);
  }, [text]);
  if (!text) return null;
  return (
    <div className="day-closed goal-burst" role="status">
      <div className="day-closed-pill">
        <IconCheck />
        {text}
      </div>
    </div>
  );
}

const days = (n: number) => tn(n, 'день', 'дня', 'дней');

/** Полоска цели: заполняется плавно, при выполненной цели — галочка и акцент. */
function GoalBar({ done, goal, label }: { done: number; goal: number; label: string }) {
  const met = done >= goal;
  const text = tr('{done} из {goal}', { done, goal });
  return (
    <span className={`goal-bar${met ? ' met' : ''}`} role="img" aria-label={`${label}: ${text}`} title={`${label}: ${text}`}>
      <span className="goal-track">
        <span className="goal-fill" style={{ ['--p' as string]: Math.min(1, done / goal) }} />
      </span>
      <span className="goal-count">
        {met && <IconCheck />}
        {text}
      </span>
    </span>
  );
}

/**
 * Цель дня в заголовке «Сегодня»: полоска «3 из 5» и серия, если она от двух дней.
 * В выходной и в отпуске вместо цели подпись. Без цели и с выключенными игровыми элементами — ничего.
 */
export function TodayGoal({ g }: { g: GoalProgress }) {
  const s = useGame();
  if (!s.enabled || (s.dailyGoal === null && s.weeklyGoal === null)) return null;
  if (g.day.off)
    return (
      <div className="goal-line">
        <span className="goal-off">{g.day.off === 'rest' ? tr('выходной') : tr('отпуск')}</span>
      </div>
    );
  if (g.day.goal === null) return null;
  return (
    <div className="goal-line">
      <GoalBar done={g.day.done} goal={g.day.goal} label={tr('Цель дня')} />
      {g.streak && g.streak.current >= 2 && <span className="goal-streak">{tr('{n} подряд', { n: days(g.streak.current) })}</span>}
    </div>
  );
}

const HINT_KEY = 'gameGoalHintClosed';

function hintClosed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Подсказка цели в «Сегодня»: один раз, пока цели нет; закрытие запоминается на устройстве. */
export function GoalHint({ today }: { today: string }) {
  const doc = useDoc();
  const s = useGame();
  const [closed, setClosed] = useState(hintClosed);
  if (closed || !s.enabled || s.dailyGoal !== null) return null;
  const n = doc.suggestDailyGoal(TZ, today);
  if (n === null) return null;
  const close = () => {
    setClosed(true);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // без хранилища подсказка скроется до перезагрузки
    }
  };
  return (
    <div className="goal-hint" role="note">
      <span>{tr('За две недели вы закрывали в среднем {n} в день.', { n: tn(n, 'задачу', 'задачи', 'задач') })}</span>
      <button
        className="link"
        onClick={() => {
          doc.updateGameSettings({ dailyGoal: n });
          close();
        }}
      >
        {tr('Поставить цель {n}', { n })}
      </button>
      <button className="goal-hint-close" aria-label={tr('Закрыть подсказку')} title={tr('Закрыть подсказку')} onClick={close}>
        <IconX />
      </button>
    </div>
  );
}

const STATE_LABEL: Record<GoalDayState, string> = {
  done: tr('цель выполнена'),
  rest: tr('выходной'),
  vacation: tr('отпуск'),
  allowed: tr('пропуск по запасу'),
  missed: tr('цель не выполнена'),
  today: tr('сегодня'),
  planned: tr('впереди'),
};

/** Блок целей в «Статистике»: серии, неделя по дням и прогресс к цели недели. */
export function GoalStats() {
  const doc = useDoc();
  const s = useGame();
  if (!s.enabled || (s.dailyGoal === null && s.weeklyGoal === null)) return null;
  const today = todayDate();
  const g = doc.goals(TZ, today);
  const num = (n: number) => n.toLocaleString(LOCALE);
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE, { weekday: 'short', timeZone: 'UTC' });
  const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const daily = s.dailyGoal !== null;
  // Без цели дня у дней нет «выполнено» и «не выполнено»: только число, выходной и отпуск.
  const cls = (st: GoalDayState): string => (daily || st === 'rest' || st === 'vacation' || st === 'planned' ? st : 'plain');
  return (
    <section className="goal-stats">
      <h2 className="stats-h">{tr('Цели')}</h2>
      <div className="stats-cards goal-cards">
        {g.streak && (
          <>
            <div className="stats-card">
              <b>{num(g.streak.current)}</b>
              <span>{tr('серия целей, дней')}</span>
            </div>
            <div className="stats-card">
              <b>{num(g.streak.best)}</b>
              <span>{tr('лучшая серия целей')}</span>
            </div>
          </>
        )}
        {g.week.goal !== null && (
          <div className="stats-card goal-week">
            <GoalBar done={g.week.done} goal={g.week.goal} label={tr('Цель недели')} />
            <span>{tr('цель недели')}</span>
          </div>
        )}
      </div>
      <div className="goal-days" role="list" aria-label={tr('Эта неделя')}>
        {g.days.map((d) => {
          const what = daily || d.state === 'rest' || d.state === 'vacation' ? `${STATE_LABEL[d.state]}, ` : '';
          const hint = `${dateLabel(d.date)}: ${what}${d.date > today ? '' : tn(d.count, 'задача', 'задачи', 'задач')}`.replace(/, $/, '');
          return (
            <div key={d.date} role="listitem" className={`goal-day g-${cls(d.state)}${d.date === today ? ' is-today' : ''}`} title={hint} aria-label={hint}>
              <span className="goal-day-name">{weekday(d.date)}</span>
              <span className="goal-day-mark">{d.state === 'done' && daily ? <IconCheck /> : d.date > today ? '' : num(d.count)}</span>
            </div>
          );
        })}
      </div>
      <div className="goal-legend muted">
        {daily && (
          <>
            <span>
              <i className="goal-dot g-done" /> {tr('цель выполнена')}
            </span>
            <span>
              <i className="goal-dot g-allowed" /> {tr('пропуск по запасу')}
            </span>
          </>
        )}
        {s.restDays.length > 0 && (
          <span>
            <i className="goal-dot g-rest" /> {tr('выходной')}
          </span>
        )}
        {g.days.some((d) => d.state === 'vacation') && (
          <span>
            <i className="goal-dot g-vacation" /> {tr('отпуск')}
          </span>
        )}
      </div>
      {daily && <p className="muted goal-note">{tr('Один пропуск в неделю серию не прерывает. Выходные и отпуск не считаются.')}</p>}
    </section>
  );
}

/** Подсказка цели в настройках: среднее за две недели и кнопка «поставить». */
function GoalSuggest({ current, onPick }: { current: number | null; onPick: (n: number) => void }) {
  const doc = useDoc();
  const n = doc.suggestDailyGoal(TZ, todayDate());
  if (n === null || n === current) return null;
  return (
    <p className="muted goal-suggest">
      {tr('За две недели вы закрывали в среднем {n} в день.', { n: tn(n, 'задачу', 'задачи', 'задач') })}{' '}
      <button className="link" onClick={() => onPick(n)}>
        {tr('Поставить {n}', { n })}
      </button>
    </p>
  );
}

const DAYS: ReadonlyArray<readonly [number, string, string]> = [
  [1, tr('Пн'), tr('Понедельник')],
  [2, tr('Вт'), tr('Вторник')],
  [3, tr('Ср'), tr('Среда')],
  [4, tr('Чт'), tr('Четверг')],
  [5, tr('Пт'), tr('Пятница')],
  [6, tr('Сб'), tr('Суббота')],
  [7, tr('Вс'), tr('Воскресенье')],
];

/** Число цели: пустое поле — без цели; неверное число не записывается, пока его не исправят. */
function GoalInput({ value, max, label, onChange }: { value: number | null; max: number; label: string; onChange: (v: number | null) => void }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  // Значение пришло с другого устройства — поле показывает его.
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  const n = Number(draft);
  const bad = draft !== '' && (!Number.isInteger(n) || n < 1 || n > max);
  return (
    <input
      className={`pomo-num game-goal${bad ? ' invalid' : ''}`}
      type="number"
      inputMode="numeric"
      min={1}
      max={max}
      placeholder={tr('нет')}
      value={draft}
      aria-label={label}
      aria-invalid={bad || undefined}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw === '') return onChange(null);
        const v = Number(raw);
        if (Number.isInteger(v) && v >= 1 && v <= max) onChange(v);
      }}
    />
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="checkline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** Раздел настроек «Игровые элементы». Настройки синхронизируются между устройствами. */
export function GameSettingsSection() {
  const doc = useDoc();
  const s = useGame();
  const set = (patch: Partial<GameSettings>) => {
    try {
      doc.updateGameSettings(patch);
    } catch {
      showToast(tr('Неверное значение'));
    }
  };
  return (
    <section className="settings game-settings">
      <h2>{tr('Игровые элементы')}</h2>
      <Check checked={s.enabled} onChange={(v) => set({ enabled: v })}>
        {tr('Отклик при выполнении, цели и итоги')}
      </Check>
      <p className="muted">
        {tr('Без очков и наказаний: только отклик на сделанное и видимый прогресс. Всё считается на устройстве, настройки синхронизируются зашифрованными.')}
      </p>
      {s.enabled && (
        <div className="game-options">
          <Check checked={s.sound} onChange={(v) => set({ sound: v })}>
            {tr('Тихий звук при выполнении')}
          </Check>
          <Check checked={s.celebrations} onChange={(v) => set({ celebrations: v })}>
            {tr('Празднование «День закрыт»')}
          </Check>
          <Check checked={s.phrases} onChange={(v) => set({ phrases: v })}>
            {tr('Тёплые фразы по фактам')}
          </Check>
          <Check checked={s.milestones} onChange={(v) => set({ milestones: v })}>
            {tr('Вехи в статистике')}
          </Check>
          <Check checked={s.garden} onChange={(v) => set({ garden: v })}>
            {tr('Сад')}
          </Check>
          <Check checked={s.weeklyReview} onChange={(v) => set({ weeklyReview: v })}>
            {tr('Итоги недели')}
          </Check>
          {s.weeklyReview && (
            <div className="game-sub">
              <div className="row wrap">
                <select value={s.weeklyReviewDay} onChange={(e) => set({ weeklyReviewDay: Number(e.target.value) })} aria-label={tr('День итогов недели')}>
                  {DAYS.map(([d, , long]) => (
                    <option key={d} value={d}>
                      {long}
                    </option>
                  ))}
                </select>
                <input
                  type="time"
                  value={s.weeklyReviewTime}
                  onChange={(e) => e.target.value && set({ weeklyReviewTime: e.target.value })}
                  aria-label={tr('Время итогов недели')}
                />
              </div>
              <Check checked={s.weeklyReviewNotify} onChange={(v) => set({ weeklyReviewNotify: v })}>
                {tr('Напомнить уведомлением')}
              </Check>
            </div>
          )}

          <h3>{tr('Цели')}</h3>
          <div className="row wrap">
            <label className="row">
              {tr('В день')}
              <GoalInput value={s.dailyGoal} max={DAILY_GOAL_MAX} label={tr('Цель на день, задач')} onChange={(v) => set({ dailyGoal: v })} />
            </label>
            <label className="row">
              {tr('В неделю')}
              <GoalInput value={s.weeklyGoal} max={WEEKLY_GOAL_MAX} label={tr('Цель на неделю, задач')} onChange={(v) => set({ weeklyGoal: v })} />
            </label>
          </div>
          <GoalSuggest current={s.dailyGoal} onPick={(n) => set({ dailyGoal: n })} />
          <p className="muted">{tr('Оставьте поле пустым, если цель не нужна. До {d} задач в день и {w} в неделю.', { d: DAILY_GOAL_MAX, w: WEEKLY_GOAL_MAX })}</p>

          <h3>{tr('Выходные')}</h3>
          <div className="row wrap" role="group" aria-label={tr('Выходные дни')}>
            {DAYS.map(([d, short, long]) => {
              const on = s.restDays.includes(d);
              return (
                <button
                  key={d}
                  className={`pill toggle c-green${on ? ' on' : ''}`}
                  aria-pressed={on}
                  aria-label={long}
                  onClick={() => set({ restDays: on ? s.restDays.filter((x) => x !== d) : [...s.restDays, d] })}
                >
                  {short}
                </button>
              );
            })}
          </div>
          <p className="muted">{tr('В выходные цели не действуют, серия не прерывается.')}</p>

          <h3>{tr('Отпуск')}</h3>
          <div className="row wrap">
            <label className="row">
              {tr('с')}
              <input
                type="date"
                value={s.vacationFrom ?? ''}
                max={s.vacationTo ?? undefined}
                onChange={(e) => set({ vacationFrom: e.target.value || null })}
                aria-label={tr('Начало отпуска')}
              />
            </label>
            <label className="row">
              {tr('по')}
              <input
                type="date"
                value={s.vacationTo ?? ''}
                min={s.vacationFrom ?? undefined}
                onChange={(e) => set({ vacationTo: e.target.value || null })}
                aria-label={tr('Конец отпуска')}
              />
            </label>
            {(s.vacationFrom || s.vacationTo) && (
              <button className="link" onClick={() => set({ vacationFrom: null, vacationTo: null })}>
                {tr('Без отпуска')}
              </button>
            )}
          </div>
          <p className="muted">{tr('На время отпуска серия замирает. Если не указать начало, отпуск длится до указанного дня.')}</p>
        </div>
      )}
    </section>
  );
}
