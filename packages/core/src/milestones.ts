/**
 * Вехи (docs/gamification.md, 6.4). Чистый подсчёт из уже имеющихся данных: выполнений, отрезков помодоро,
 * серий привычек и целей. Ничего не хранится: дата вехи — момент, когда порог был пересечён.
 *
 * Список вех (id вида «вид:порог»):
 * - tasks:10/100/500/1000/5000 — выполнено задач всего;
 * - inbox:50 — закрыто задач из «Входящих» (история пустоты «Входящих» не хранится, поэтому честно считаем закрытые);
 * - pomodoro:10/100 — законченные отрезки работы;
 * - habit:30/100 — привычка выполнена столько раз подряд (по серии из habits.ts; у ежедневной это дни);
 * - goal:7/30 — серия дней с выполненной целью дня (goals.ts);
 * - waited:100 — закрыта задача, которая ждала 100 дней и дольше.
 */
import { today as todayIn } from './dates.ts';
import type { DoneEvent, WorkEvent } from './stats.ts';

export type MilestoneKind = 'tasks' | 'inbox' | 'pomodoro' | 'habit' | 'goal' | 'waited';

export const MILESTONES: ReadonlyArray<{ readonly kind: MilestoneKind; readonly target: number }> = [
  { kind: 'tasks', target: 10 },
  { kind: 'tasks', target: 100 },
  { kind: 'tasks', target: 500 },
  { kind: 'tasks', target: 1000 },
  { kind: 'tasks', target: 5000 },
  { kind: 'inbox', target: 50 },
  { kind: 'pomodoro', target: 10 },
  { kind: 'pomodoro', target: 100 },
  { kind: 'habit', target: 30 },
  { kind: 'habit', target: 100 },
  { kind: 'goal', target: 7 },
  { kind: 'goal', target: 30 },
  { kind: 'waited', target: 100 },
];

export interface MilestoneInput {
  readonly events: readonly DoneEvent[];
  readonly work: readonly WorkEvent[];
  readonly inboxId: string;
  /** Привычки: текущая серия и даты, когда серия дошла до порогов (habits.ts). */
  readonly habits: ReadonlyArray<{ readonly current: number; readonly reached: Readonly<Record<number, string>> }>;
  /** Серия целей: текущая и даты порогов; null — цели дня нет. */
  readonly goalStreak: { readonly current: number; readonly reached: ReadonlyMap<number, string> } | null;
  readonly tz: string;
}

export interface ReachedMilestone {
  readonly id: string;
  readonly kind: MilestoneKind;
  readonly target: number;
  /** Дата достижения YYYY-MM-DD в поясе пользователя; null, если вычислить нельзя. */
  readonly date: string | null;
}

export interface NextMilestone {
  readonly id: string;
  readonly kind: MilestoneKind;
  readonly target: number;
  readonly progress: number;
}

export interface Milestones {
  /** Достигнутые, свежие первыми. */
  readonly reached: ReachedMilestone[];
  /** Ближайшая следующая: та, к которой подошли ближе всего по доле порога. */
  readonly next: NextMilestone | null;
}

export const milestoneId = (kind: MilestoneKind, target: number) => `${kind}:${target}`;

const DAY = 86_400_000;

export function computeMilestones(input: MilestoneInput): Milestones {
  const dayOf = (at: number) => todayIn(input.tz, at);
  const byTime = [...input.events].sort((a, b) => a.at - b.at);
  const inbox = byTime.filter((e) => e.projectId === input.inboxId);
  const work = [...input.work].sort((a, b) => a.at - b.at);
  const waited = byTime.find((e) => e.createdAt !== undefined && e.createdAt > 0 && e.at - e.createdAt >= 100 * DAY);
  const order = (id: string) => MILESTONES.findIndex((x) => milestoneId(x.kind, x.target) === id);

  const reached: ReachedMilestone[] = [];
  let next: NextMilestone | null = null;
  let nextRatio = -1;
  for (const m of MILESTONES) {
    let progress = 0;
    let date: string | null = null;
    switch (m.kind) {
      case 'tasks':
        progress = byTime.length;
        date = byTime[m.target - 1] ? dayOf(byTime[m.target - 1]!.at) : null;
        break;
      case 'inbox':
        progress = inbox.length;
        date = inbox[m.target - 1] ? dayOf(inbox[m.target - 1]!.at) : null;
        break;
      case 'pomodoro':
        progress = work.length;
        date = work[m.target - 1] ? dayOf(work[m.target - 1]!.at) : null;
        break;
      case 'habit': {
        progress = Math.max(0, ...input.habits.map((h) => h.current));
        const dates = input.habits.map((h) => h.reached[m.target]).filter((d): d is string => !!d);
        if (dates.length) {
          date = dates.reduce((a, b) => (a < b ? a : b));
          progress = m.target;
        }
        break;
      }
      case 'goal': {
        progress = input.goalStreak?.current ?? 0;
        const d = input.goalStreak?.reached.get(m.target);
        if (d) {
          date = d;
          progress = m.target;
        }
        break;
      }
      case 'waited':
        progress = waited ? m.target : 0;
        date = waited ? dayOf(waited.at) : null;
        break;
    }
    const id = milestoneId(m.kind, m.target);
    if (progress >= m.target) reached.push({ id, kind: m.kind, target: m.target, date });
    else if (m.kind !== 'waited') {
      // «Ждала 100 дней» заранее не планируется, поэтому ближайшей не бывает.
      const ratio = progress / m.target;
      if (ratio > nextRatio) {
        nextRatio = ratio;
        next = { id, kind: m.kind, target: m.target, progress };
      }
    }
  }
  reached.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || order(b.id) - order(a.id));
  return { reached, next };
}
