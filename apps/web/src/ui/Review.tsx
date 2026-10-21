/**
 * Итоги недели (docs/gamification.md, 6.3): спокойная страница-рассказ о неделе, список прошлых недель
 * и карточка «Итоги недели готовы» в «Сегодня». Считается на устройстве (review.ts в ядре), только факты.
 */
import { useEffect, useState } from 'react';
import { addDays, lastReview, reviewWeeks, weekStart, type ReviewTask } from '#core';
import { TZ, dateLabel, durationLabel, todayDate, weekTitle } from '../format.ts';
import { href, navigate, useDoc, useGame } from '../hooks.ts';
import { LOCALE, tn, tr } from '../i18n.ts';
import { IconChevron, IconX } from './icons.tsx';
import { requestSubtaskInput } from './TaskPanel.tsx';
import { showToast } from './toast.tsx';

/** Последняя неделя, чьи итоги открыты или закрыты карточкой на этом устройстве. */
const SEEN_KEY = 'gameReviewSeen';
/** Карточка видна с момента итогов двое суток, если её не закрыли. */
const CARD_MS = 48 * 3600_000;

function seenWeek(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function markSeen(week: string): void {
  try {
    if (seenWeek() < week) localStorage.setItem(SEEN_KEY, week);
  } catch {
    // без хранилища карточка скроется до перезагрузки
  }
}

/** «Итоги недели готовы» в «Сегодня»: в выбранный день после выбранного времени, пока не открыли или не закрыли. */
export function ReviewCard() {
  const game = useGame();
  const [seen, setSeen] = useState(seenWeek);
  if (!game.enabled || !game.weeklyReview) return null;
  const now = Date.now();
  const m = lastReview(game, now, TZ);
  if (now - m.at >= CARD_MS || seen >= m.week) return null;
  const close = () => {
    markSeen(m.week);
    setSeen(m.week);
  };
  return (
    <div className="goal-hint review-card" role="note">
      <span>
        <b>{tr('Итоги недели готовы')}</b> <span className="muted nowrap">{weekTitle(m.week)}</span>
      </span>
      <a className="link" href={href({ view: 'review', week: m.week })} onClick={close}>
        {tr('Открыть')}
      </a>
      <button className="goal-hint-close" aria-label={tr('Закрыть')} title={tr('Закрыть')} onClick={close}>
        <IconX />
      </button>
    </div>
  );
}

export function ReviewView({ week, onOpen }: { week: string | null; onOpen: (id: string) => void }) {
  return week ? <WeekPage week={weekStart(week)} onOpen={onOpen} /> : <WeekList />;
}

/** Список последних 12 недель: ссылка из «Статистики». */
function WeekList() {
  const doc = useDoc();
  const game = useGame();
  const weeks = reviewWeeks(game, Date.now(), TZ, 12);
  const counts = new Map(doc.stats(TZ, todayDate(), { days: 1, weeks: 14 }).weeks.map((w) => [w.start, w.count]));
  return (
    <>
      <header className="view-head">
        <h1>{tr('Итоги недель')}</h1>
      </header>
      <p className="muted">{tr('Последние 12 недель. Итоги считаются на этом устройстве из ваших данных.')}</p>
      <ul className="review-weeks">
        {weeks.map((w) => (
          <li key={w}>
            <a href={href({ view: 'review', week: w })}>{weekTitle(w)}</a>
            <span className="muted">{tn(counts.get(w) ?? 0, 'задача', 'задачи', 'задач')}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function TaskLink({ task, onOpen }: { task: ReviewTask; onOpen: (id: string) => void }) {
  return (
    <a
      className="review-task"
      href={`#/task/${encodeURIComponent(task.id)}`}
      onClick={(e) => {
        e.preventDefault();
        onOpen(task.id);
      }}
    >
      {task.title || tr('Без названия')}
    </a>
  );
}

function WeekPage({ week, onOpen }: { week: string; onOpen: (id: string) => void }) {
  const doc = useDoc();
  const today = todayDate();
  const r = doc.weekReview(TZ, week, today);
  useEffect(() => markSeen(week), [week]);
  const num = (n: number) => n.toLocaleString(LOCALE);
  const projectName = (id: string) => {
    const p = doc.project(id);
    return !p ? tr('Без проекта') : p.isInbox ? tr('Входящие') : p.name;
  };
  const peak = Math.max(1, ...r.projects.map((p) => p.count));
  const next = addDays(week, 7);
  const go = (w: string) => navigate({ view: 'review', week: w });

  return (
    <article className="review">
      <header className="view-head">
        <h1>{weekTitle(r.start)}</h1>
        <div className="head-tools review-nav">
          <button className="icon" aria-label={tr('Предыдущая неделя')} title={tr('Предыдущая неделя')} onClick={() => go(addDays(week, -7))}>
            <IconChevron style={{ transform: 'scaleX(-1)' }} />
          </button>
          <button className="icon" aria-label={tr('Следующая неделя')} title={tr('Следующая неделя')} disabled={next > today} onClick={() => go(next)}>
            <IconChevron />
          </button>
          <a className="link" href={href({ view: 'review', week: null })}>
            {tr('Все недели')}
          </a>
        </div>
      </header>

      <div className="review-numbers">
        <div>
          <b>{num(r.done)}</b>
          <span>{tr('выполнено')}</span>
        </div>
        <div>
          <b>{tr('{n} из 7', { n: num(r.activeDays) })}</b>
          <span>{tr('дней с задачами')}</span>
        </div>
        {r.work.minutes > 0 && (
          <div>
            <b>{durationLabel(r.work.minutes)}</b>
            <span>{tr('в помодоро')}</span>
          </div>
        )}
      </div>
      <p className="review-lead">
        {r.done === 0 ? tr('За эту неделю выполненных задач нет.') : tr('На прошлой неделе: {tasks}.', { tasks: tn(r.previous, 'задача', 'задачи', 'задач') })}
        {r.current && today < r.end && ` ${tr('Неделя ещё идёт, итоги на сегодня.')}`}
      </p>

      {r.waited.length > 0 && (
        <section>
          <h2 className="stats-h">{tr('Больше всего ждали')}</h2>
          <ul className="review-list">
            {r.waited.map((t) => (
              <li key={t.id}>
                <TaskLink task={t} onOpen={onOpen} />
                <span className="muted">{tr('{days} от создания до выполнения', { days: tn(t.days, 'день', 'дня', 'дней') })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.postponed.length > 0 && (
        <section>
          <h2 className="stats-h">{tr('Часто переносятся')}</h2>
          <p className="muted review-note">{tr('Срок этих задач откладывали три раза и больше. Их можно оставить, разбить на шаги поменьше или удалить.')}</p>
          <ul className="review-list">
            {r.postponed.map((t) => (
              <li key={t.id} className="review-postponed">
                <TaskLink task={t} onOpen={onOpen} />
                <span className="muted">{tr('переносилась {n}', { n: tn(t.count, 'раз', 'раза', 'раз') })}</span>
                <span className="review-actions">
                  <button
                    onClick={() => {
                      doc.keepPostponed(t.id);
                      showToast(tr('Задача остаётся, счёт переносов начат заново'), { label: tr('Отменить'), run: () => doc.undo() });
                    }}
                  >
                    {tr('Оставить')}
                  </button>
                  <button
                    onClick={() => {
                      requestSubtaskInput(t.id);
                      onOpen(t.id);
                    }}
                  >
                    {tr('Разбить на шаги')}
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      doc.deleteTask(t.id);
                      showToast(tr('Задача удалена'), { label: tr('Отменить'), run: () => doc.undo() });
                    }}
                  >
                    {tr('Удалить')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.missed.count > 0 && (
        <section>
          <h2 className="stats-h">{tr('Не успели из запланированного')}</h2>
          <ul className="review-list">
            {r.missed.tasks.map((t) => (
              <li key={t.id}>
                <TaskLink task={t} onOpen={onOpen} />
                <span className="muted">{tr('срок {date}', { date: dateLabel(t.due, today).toLocaleLowerCase(LOCALE) })}</span>
              </li>
            ))}
          </ul>
          {r.missed.count > r.missed.tasks.length && <p className="muted review-note">{tr('И ещё {n}', { n: r.missed.count - r.missed.tasks.length })}</p>}
        </section>
      )}

      {r.projects.length > 0 && (
        <section>
          <h2 className="stats-h">{tr('Проекты недели')}</h2>
          {r.projects.map((p) => {
            const pr = doc.project(p.projectId);
            return (
              <div key={p.projectId} className="stats-project">
                <a className="stats-project-name" href={href({ view: 'project', id: p.projectId })}>
                  {projectName(p.projectId)}
                </a>
                <span className="stats-project-bar">
                  <span className={`c-${pr?.color ?? 'gray'}`} style={{ width: `${(p.count / peak) * 100}%` }} />
                </span>
                <span className="stats-project-n">{num(p.count)}</span>
              </div>
            );
          })}
        </section>
      )}

      {(r.goals || r.habits.length > 0) && (
        <section>
          <h2 className="stats-h">{tr('Привычки и цели')}</h2>
          <ul className="review-list">
            {r.goals?.daily != null && (
              <li>
                <span>{tr('Цель дня ({n}) выполнена в {met} из 7 дней', { n: r.goals.daily, met: r.goals.daysMet })}</span>
                {r.goals.streak !== null && <span className="muted">{tr('серия {days}', { days: tn(r.goals.streak, 'день', 'дня', 'дней') })}</span>}
              </li>
            )}
            {r.goals?.weekly != null && (
              <li>
                <span>{tr('Цель недели: {done} из {goal}', { done: num(r.done), goal: num(r.goals.weekly) })}</span>
              </li>
            )}
            {r.habits.map((h) => (
              <li key={h.id}>
                <TaskLink task={h} onOpen={onOpen} />
                <span className="muted">
                  {tr('за неделю {times}, серия {n}', { times: tn(h.week, 'раз', 'раза', 'раз'), n: num(h.current) })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.work.minutes > 0 && (
        <section>
          <h2 className="stats-h">{tr('Помодоро')}</h2>
          <p className="review-lead">
            {tr('{time} работы, {sessions}.', { time: durationLabel(r.work.minutes), sessions: tn(r.work.sessions, 'отрезок', 'отрезка', 'отрезков') })}
          </p>
        </section>
      )}
    </article>
  );
}
