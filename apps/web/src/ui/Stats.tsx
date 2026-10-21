/** Экран «Статистика»: выполненное по дням и неделям, серии и проекты. Считается на устройстве, на сервер не уходит. */
import { useState } from 'react';
import { TZ, durationLabel, todayDate } from '../format.ts';
import { navigate, useDoc } from '../hooks.ts';
import { LOCALE, tn, tr } from '../i18n.ts';
import { GoalStats, MilestoneStats } from './Game.tsx';
import { HabitStrip } from './Habit.tsx';
import { IconFlame } from './icons.tsx';

const PERIODS = [7, 30, 90] as const;

const short = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const tasks = (n: number) => tn(n, 'задача', 'задачи', 'задач');

interface Bar {
  key: string;
  count: number;
  /** Подпись под столбиком, пустая у большинства, чтобы не слипались. */
  label: string;
  /** Подсказка с точным числом. */
  hint: string;
}

function Bars({ bars, name }: { bars: Bar[]; name: string }) {
  const [sel, setSel] = useState<string | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.count));
  const chosen = bars.find((b) => b.key === sel);
  return (
    <div className="stats-chart" role="img" aria-label={name}>
      <div className="stats-bars">
        {bars.map((b) => (
          <button key={b.key} className={`stats-col${sel === b.key ? ' sel' : ''}`} title={b.hint} aria-label={b.hint} onClick={() => setSel(sel === b.key ? null : b.key)}>
            <span className="stats-bar" style={{ height: `${b.count ? Math.max(4, (b.count / max) * 100) : 0}%` }} />
          </button>
        ))}
      </div>
      <div className="stats-axis">
        {bars.map((b) => (
          <span key={b.key}>{b.label}</span>
        ))}
      </div>
      <div className="stats-hint muted">{chosen ? chosen.hint : tr('Нажмите на столбик, чтобы увидеть число')}</div>
    </div>
  );
}

export function StatsView() {
  const doc = useDoc();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(30);
  const today = todayDate();
  const s = doc.stats(TZ, today, { days: 28, weeks: 12, period });
  const days: Bar[] = s.days.map((d, i) => ({
    key: d.date,
    count: d.count,
    label: i % 7 === 0 ? short(d.date) : '',
    hint: `${short(d.date)}: ${tasks(d.count)}`,
  }));
  const weeks: Bar[] = s.weeks.map((w, i) => ({
    key: w.start,
    count: w.count,
    label: i % 3 === 0 ? short(w.start) : '',
    hint: `${tr('Неделя с {date}', { date: short(w.start) })}: ${tasks(w.count)}`,
  }));
  const habits = doc.habits(today, TZ);
  const peak = Math.max(1, ...s.projects.map((p) => p.count));
  const num = (n: number) => n.toLocaleString(LOCALE);
  return (
    <>
      <header className="view-head">
        <h1>{tr('Статистика')}</h1>
        {/* Итоги недели (6.3): список прошлых недель. */}
        <a className="link" href="#/review">
          {tr('Итоги недель')}
        </a>
      </header>

      {s.total === 0 ? (
        <p className="muted">{tr('Выполняйте задачи, и здесь появится статистика. Она считается на этом устройстве, сервер о ней ничего не знает.')}</p>
      ) : (
        <p className="muted">{tr('Всего выполнено: {n}', { n: tasks(s.total) })}</p>
      )}
      <div className="stats-cards">
        <div className="stats-card">
          <b>{num(s.today)}</b>
          <span>{tr('сегодня')}</span>
        </div>
        <div className="stats-card">
          <b>{num(s.thisWeek)}</b>
          <span>{tr('на этой неделе')}</span>
        </div>
        <div className="stats-card">
          <b>{num(s.streak)}</b>
          <span>{tr('серия, дней')}</span>
        </div>
        <div className="stats-card">
          <b>{num(s.bestStreak)}</b>
          <span>{tr('лучшая серия')}</span>
        </div>
      </div>

      <GoalStats />
      <MilestoneStats />

      {s.work.period + s.work.week > 0 && (
        <>
          <h2 className="stats-h">{tr('Затраченное время')}</h2>
          <div className="stats-cards stats-work">
            <div className="stats-card">
              <b>{s.work.today ? durationLabel(s.work.today) : '0'}</b>
              <span>{tr('сегодня')}</span>
            </div>
            <div className="stats-card">
              <b>{s.work.week ? durationLabel(s.work.week) : '0'}</b>
              <span>{tr('на этой неделе')}</span>
            </div>
            <div className="stats-card">
              <b>{s.work.period ? durationLabel(s.work.period) : '0'}</b>
              <span>{tr('за {period}', { period: tn(period, 'день', 'дня', 'дней') })}</span>
            </div>
          </div>
        </>
      )}

      {habits.length > 0 && (
        <>
          <h2 className="stats-h">{tr('Привычки')}</h2>
          {habits.map(({ task, streak }) => (
            <div key={task.id} className="stats-habit">
              <a
                className="stats-project-name"
                href={`#/task/${encodeURIComponent(task.id)}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate({ view: 'task', id: task.id });
                }}
              >
                {task.title || tr('Без названия')}
              </a>
              <span className={`habit-now${streak.current > 0 ? ' on' : ''}`} title={tr('серия')}>
                <IconFlame /> <b>{num(streak.current)}</b>
              </span>
              <span className="muted">{tr('лучшая: {n}', { n: num(streak.best) })}</span>
              <HabitStrip streak={streak} />
            </div>
          ))}
        </>
      )}

      <h2 className="stats-h">{tr('По дням')}</h2>
      <Bars bars={days} name={tr('Выполнено по дням за 4 недели')} />
      <h2 className="stats-h">{tr('По неделям')}</h2>
      <Bars bars={weeks} name={tr('Выполнено по неделям за 12 недель')} />

      <div className="stats-projects-head">
        <h2 className="stats-h">{tr('По проектам')}</h2>
        <div className="segmented" role="group" aria-label={tr('Период')}>
          {PERIODS.map((p) => (
            <button key={p} className={period === p ? 'active' : ''} onClick={() => setPeriod(p)}>
              {tn(p, 'день', 'дня', 'дней')}
            </button>
          ))}
        </div>
      </div>
      {s.projects.length === 0 && <p className="muted">{tr('За этот период ничего не выполнено.')}</p>}
      {s.projects.map((p) => {
        const pr = doc.project(p.projectId);
        const name = !pr ? tr('Без проекта') : pr.isInbox ? tr('Входящие') : pr.name;
        return (
          <div key={p.projectId} className="stats-project">
            <a
              className="stats-project-name"
              href={`#/project/${encodeURIComponent(p.projectId)}`}
              onClick={(e) => {
                e.preventDefault();
                navigate({ view: 'project', id: p.projectId });
              }}
            >
              {name}
            </a>
            <span className="stats-project-bar">
              <span className={`c-${pr?.color ?? 'gray'}`} style={{ width: `${(p.count / peak) * 100}%` }} />
            </span>
            <span className="stats-project-n">{num(p.count)}</span>
          </div>
        );
      })}
    </>
  );
}
