/**
 * Таймер помодоро: чистые переходы состояния. Хранится время окончания, а не тики,
 * поэтому таймер переживает перезагрузку и сон устройства: остаток считается от часов.
 */

export type PomodoroPhase = 'work' | 'break';

export interface PomodoroState {
  /** Id отрезка работы: он же id записи о затраченном времени, повторная запись не удваивает время. */
  readonly id: string;
  readonly taskId: string;
  readonly phase: PomodoroPhase;
  /** Длина фазы в мс. */
  readonly length: number;
  /** Когда фаза закончится; null — на паузе. */
  readonly endsAt: number | null;
  /** Остаток на паузе, мс. */
  readonly left: number;
  /** Работа закончилась и время уже записано в задачу: ждём, начнут ли перерыв. */
  readonly logged?: boolean;
}

export const MINUTE = 60_000;

export function startWork(id: string, taskId: string, minutes: number, now: number): PomodoroState {
  const length = minutes * MINUTE;
  return { id, taskId, phase: 'work', length, endsAt: now + length, left: length };
}

export function startBreak(prev: PomodoroState, minutes: number, now: number): PomodoroState {
  const length = minutes * MINUTE;
  return { id: prev.id, taskId: prev.taskId, phase: 'break', length, endsAt: now + length, left: length };
}

/** Сколько осталось, мс. */
export function remaining(s: PomodoroState, now: number): number {
  return s.endsAt === null ? s.left : Math.max(0, s.endsAt - now);
}

export function isOver(s: PomodoroState, now: number): boolean {
  return remaining(s, now) === 0;
}

export function pause(s: PomodoroState, now: number): PomodoroState {
  return s.endsAt === null ? s : { ...s, endsAt: null, left: remaining(s, now) };
}

export function resume(s: PomodoroState, now: number): PomodoroState {
  return s.endsAt !== null ? s : { ...s, endsAt: now + s.left };
}

/** Отработанные минуты отрезка: время на паузе не считается, перерыв — тоже. */
export function workedMinutes(s: PomodoroState, now: number): number {
  if (s.phase !== 'work') return 0;
  return Math.round((s.length - remaining(s, now)) / MINUTE);
}

/** «24:59», а с часами — «1:05:00». */
export function clockLabel(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** Разбор сохранённого состояния: в хранилище могло лечь что угодно. */
export function parsePomodoro(v: unknown): PomodoroState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (typeof o.id !== 'string' || typeof o.taskId !== 'string' || (o.phase !== 'work' && o.phase !== 'break')) return null;
  if (!num(o.length) || !num(o.left) || !(o.endsAt === null || num(o.endsAt))) return null;
  return {
    id: o.id,
    taskId: o.taskId,
    phase: o.phase,
    length: o.length as number,
    endsAt: o.endsAt as number | null,
    left: o.left as number,
    ...(o.logged === true ? { logged: true } : {}),
  };
}
