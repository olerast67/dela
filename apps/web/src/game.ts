/**
 * Игровые элементы в вебе (docs/gamification.md): звук, празднование «День закрыт» и тёплые фразы при выполнении.
 * Настройки — запись личного пространства (Workspace.getGameSettings); здесь только отклик.
 */
import { afterCompletion, beforeCompletion, completionFacts, DEFAULT_GAME_SETTINGS, gameFeature, pickPhrase, type GameSettings, type TaskView, type WarmFact, type Workspace } from '#core';
import { TZ, todayDate } from './format.ts';
import { tn, tr, LANG } from './i18n.ts';

export function gameSettingsOf(doc: Workspace | null): GameSettings {
  return doc ? doc.getGameSettings() : DEFAULT_GAME_SETTINGS;
}

// ---------- звук ----------

let audio: AudioContext | null = null;
let lastSound = 0;

/**
 * Тихий щелчок выполнения: два коротких синуса вверх, около 0,15 с, громкость низкая.
 * Генерируется WebAudio, файлов нет; тот же путь в браузере, на телефоне и в программе для Windows.
 */
function click(): void {
  const Ctx = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctx) return;
  try {
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
    const t0 = audio.currentTime + 0.005;
    for (const [freq, at, peak] of [
      [880, 0, 0.05],
      [1320, 0.055, 0.035],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0 + at);
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.11);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.12);
    }
  } catch {
    // звук не обязателен
  }
}

/** Отклик в момент нажатия: звук, если включён. Повтор в течение полсекунды (то же выполнение) молчит. */
export function doneFeedback(doc: Workspace | null): void {
  if (!gameFeature(gameSettingsOf(doc), 'sound')) return;
  const now = Date.now();
  if (now - lastSound < 500) return;
  lastSound = now;
  click();
}

// ---------- «День закрыт» ----------

const dayClosed = new Set<() => void>();
let dayClosedAt = 0;

/** Подписка на закрытие последней задачи дня (доска «Сегодня»: там пустого экрана нет). */
export function onDayClosed(fn: () => void): () => void {
  dayClosed.add(fn);
  return () => dayClosed.delete(fn);
}

/**
 * День закрыт только что: пустое «Сегодня» появляется уже после выполнения,
 * поэтому оно спрашивает при появлении, а не подписывается заранее.
 */
export function dayJustClosed(): boolean {
  return Date.now() - dayClosedAt < 1000;
}

// ---------- тёплые фразы ----------

const PHRASE_KEY = 'gamePhraseCount';

function readCount(): number {
  try {
    const n = Number(localStorage.getItem(PHRASE_KEY));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCount(n: number): void {
  try {
    localStorage.setItem(PHRASE_KEY, String(n));
  } catch {
    // без хранилища счётчик живёт до перезагрузки
  }
}

let phraseCount: number | null = null;

const ORDINALS_RU: Record<number, string> = { 5: 'Пятая', 10: 'Десятая', 15: 'Пятнадцатая', 20: 'Двадцатая', 25: 'Двадцать пятая', 30: 'Тридцатая' };

function ordinalEn(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/** Текст фразы по факту. */
export function phraseText(f: WarmFact): string {
  switch (f.kind) {
    case 'habit':
      return tr('Привычка: {n} подряд', { n: tn(f.count, 'раз', 'раза', 'раз') });
    case 'dayStreak':
      return tr('{n} подряд с выполненными задачами', { n: tn(f.days, 'день', 'дня', 'дней') });
    case 'oldestInbox':
      return tr('Это была самая старая задача во «Входящих» (висела {n})', { n: tn(f.days, 'день', 'дня', 'дней') });
    case 'noOverdue':
      return tr('Просроченных задач больше нет');
    case 'nthToday':
      return tr('{n} задача сегодня', { n: LANG === 'en' ? ordinalEn(f.n) : (ORDINALS_RU[f.n] ?? `${f.n}-я`) });
    case 'longWait':
      return tr('Задача ждала {n}', { n: tn(f.days, 'день', 'дня', 'дней') });
  }
}

/**
 * Выполнить задачу с откликом игровых элементов. Возвращает текст тоста: тёплую фразу
 * или null (обычный тост). Сигнал «День закрыт» уходит подписчикам «Сегодня».
 */
export function completeWithGame(doc: Workspace, task: TaskView): string | null {
  const s = doc.getGameSettings();
  if (!s.enabled) {
    doc.completeTask(task.id);
    return null;
  }
  doneFeedback(doc);
  const today = todayDate();
  const list = doc.today(today, TZ);
  const inToday = list.overdue.some((t) => t.id === task.id) || list.today.some((t) => t.id === task.id);
  const before = s.phrases ? beforeCompletion(doc, task.id, today, TZ) : null;
  doc.completeTask(task.id);
  if (s.celebrations && inToday) {
    const after = doc.today(today, TZ);
    if (after.overdue.length + after.today.length === 0) {
      dayClosedAt = Date.now();
      for (const fn of dayClosed) fn();
    }
  }
  if (!before) return null;
  phraseCount ??= readCount();
  const facts = completionFacts(before, afterCompletion(doc, before, today, TZ), today, TZ);
  const r = pickPhrase(facts, phraseCount + 1);
  phraseCount = r.sinceLast;
  writeCount(phraseCount);
  return r.fact ? phraseText(r.fact) : null;
}
