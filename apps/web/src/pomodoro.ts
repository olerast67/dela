/**
 * Помодоро на этом устройстве: один таймер на устройство, состояние в localStorage
 * (время окончания, а не тики), длительности — настройка устройства.
 * Уведомление об окончании ставит controller вместе с напоминаниями задач.
 */
import { isOver, parsePomodoro, pausePomodoro, resumePomodoro, startBreak, startWork, uuidv7, workedMinutes, type PomodoroState, type Workspace } from '#core';

const KEY = 'pomodoro';
const SETTINGS_KEY = 'pomodoroMinutes';

export interface PomodoroSettings {
  readonly work: number;
  readonly rest: number;
}

const DEFAULTS: PomodoroSettings = { work: 25, rest: 5 };

const okMinutes = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

export function pomodoroSettings(): PomodoroSettings {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<PomodoroSettings> | null;
    return { work: okMinutes(v?.work, 180) ? v.work : DEFAULTS.work, rest: okMinutes(v?.rest, 60) ? v.rest : DEFAULTS.rest };
  } catch {
    return DEFAULTS;
  }
}

export function setPomodoroSettings(value: PomodoroSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  } catch {
    // без localStorage действуют 25 и 5 минут
  }
}

const listeners = new Set<() => void>();
let cached: { raw: string | null; state: PomodoroState | null } | null = null;

export function loadPomodoro(): PomodoroState | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return cached?.state ?? null;
  }
  // Один и тот же объект, пока строка не изменилась: так его можно отдавать в useSyncExternalStore.
  if (cached && cached.raw === raw) return cached.state;
  let state: PomodoroState | null = null;
  try {
    state = raw ? parsePomodoro(JSON.parse(raw)) : null;
  } catch {
    state = null;
  }
  cached = { raw, state };
  return state;
}

function save(state: PomodoroState | null): void {
  try {
    if (state) localStorage.setItem(KEY, JSON.stringify(state));
    else localStorage.removeItem(KEY);
  } catch {
    // без localStorage таймер живёт до перезагрузки
    cached = { raw: state ? JSON.stringify(state) : null, state };
  }
  for (const fn of listeners) fn();
}

/** Подписка на изменения таймера, в том числе из других вкладок. */
export function onPomodoroChange(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => e.key === KEY && fn();
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/**
 * Записать отработанное в задачу. Id записи — id отрезка, поэтому повтор не удваивает время.
 * focus: отрезок закончен (в саду — дерево фокуса) или прерван (росток).
 */
function logWork(doc: Workspace, s: PomodoroState, now: number, focus: 'full' | 'cut'): void {
  const minutes = workedMinutes(s, now);
  if (minutes > 0 && doc.task(s.taskId)) doc.logWork(s.taskId, minutes, { id: s.id, at: s.endsAt !== null && s.endsAt < now ? s.endsAt : now, focus });
}

/**
 * Запустить работу над задачей. Таймер на устройстве один: если он шёл на другой задаче,
 * отработанное там записывается, и таймер переключается на новую.
 */
export function startPomodoro(doc: Workspace, taskId: string, now = Date.now()): void {
  const prev = loadPomodoro();
  if (prev && prev.phase === 'work' && !prev.logged) logWork(doc, prev, now, isOver(prev, now) ? 'full' : 'cut');
  save(startWork(uuidv7(now), taskId, pomodoroSettings().work, now));
}

export function pausePomo(now = Date.now()): void {
  const s = loadPomodoro();
  if (s) save(pausePomodoro(s, now));
}

export function resumePomo(now = Date.now()): void {
  const s = loadPomodoro();
  if (s) save(resumePomodoro(s, now));
}

/** Остановить: отработанное записывается в задачу, перерыв просто заканчивается. */
export function stopPomodoro(doc: Workspace, now = Date.now()): void {
  const s = loadPomodoro();
  if (s && s.phase === 'work' && !s.logged) logWork(doc, s, now, isOver(s, now) ? 'full' : 'cut');
  save(null);
}

export function startRest(now = Date.now()): void {
  const s = loadPomodoro();
  if (s) save(startBreak(s, pomodoroSettings().rest, now));
}

/**
 * Проверка по часам: работа кончилась — время записывается в задачу, таймер ждёт перерыва;
 * перерыв кончился — таймер снимается. Возвращает, что закончилось.
 */
export function settlePomodoro(doc: Workspace, now = Date.now()): 'work' | 'break' | null {
  const s = loadPomodoro();
  if (!s || !isOver(s, now) || s.logged) return null;
  if (s.phase === 'work') {
    logWork(doc, s, now, 'full');
    save({ ...s, logged: true });
    return 'work';
  }
  save(null);
  return 'break';
}
