/**
 * События внешних календарей поверх задач: подписки iCal и календари телефона. Только для чтения.
 *
 * Подписка — запись в личном пространстве (название, ссылка, цвет, вкл/выкл): ссылка — секрет,
 * поэтому она лежит только в зашифрованной записи и синхронизируется как любая ячейка.
 * Сами события в синхронизацию не попадают: каждое устройство загружает их само.
 */
import { addDays, wallClock, zonedToUtc } from './dates.ts';
import { COLORS } from './model.ts';
import type { Json } from './op.ts';

export interface CalendarSub {
  readonly id: string;
  readonly name: string;
  /** Ссылка https на файл .ics. Пустая строка — запись повреждена или ссылка стёрта при удалении. */
  readonly url: string;
  readonly color: string;
  readonly enabled: boolean;
  readonly order: string;
  readonly createdAt: number;
  readonly deletedAt: number | null;
}

/** Разбор записи подписки: поля проверяются, как у остальных записей пространства. */
export function toCalendarSub(id: string, r: Readonly<Record<string, Json>>): CalendarSub {
  const url = typeof r.url === 'string' ? normalizeCalendarUrl(r.url) : null;
  return {
    id,
    name: typeof r.name === 'string' ? r.name.slice(0, 200) : '',
    url: url ?? '',
    color: typeof r.color === 'string' && (COLORS as readonly string[]).includes(r.color) ? r.color : 'blue',
    // Выключенность хранится отдельным флагом: у записи без поля подписка включена.
    enabled: r.off !== true,
    order: typeof r.order === 'string' && r.order.length <= 512 ? r.order : '',
    createdAt: typeof r.created_at === 'number' ? r.created_at : 0,
    deletedAt: typeof r.deleted_at === 'number' ? r.deleted_at : null,
  };
}

interface EventBase {
  /** Уникален в пределах всех календарей и экземпляров повтора. */
  readonly id: string;
  /** Источник: id подписки или «device:<id календаря>». */
  readonly calendar: string;
  readonly title: string;
  readonly location: string;
  readonly description: string;
  /** Цвет календаря: значение CSS. */
  readonly color: string;
}

/** Событие на весь день: даты, конец не включается (как DTEND в iCal). */
export interface AllDayEvent extends EventBase {
  readonly allDay: true;
  readonly startDate: string;
  readonly endDate: string;
}

/** Событие со временем: мгновения UTC в миллисекундах. */
export interface TimedEvent extends EventBase {
  readonly allDay: false;
  readonly start: number;
  readonly end: number;
}

export type CalEvent = AllDayEvent | TimedEvent;

/** Привести ссылку к https: webcal:// и webcals:// — это тот же https. null — ссылка не подходит. */
export function normalizeCalendarUrl(input: string): string | null {
  let s = input.trim();
  if (!s || s.length > 2000) return null;
  s = s.replace(/^webcals?:\/\//i, 'https://');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Полночь даты в поясе пользователя (мс UTC). */
function dayStart(date: string, tz: string): number {
  return zonedToUtc(date, '00:00', tz);
}

function minuteOf(ms: number, tz: string): number {
  const [h, m] = wallClock(ms, tz).time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export interface DayEvents {
  readonly allDay: readonly CalEvent[];
  /** События со временем в этот день: минуты от полуночи, обрезанные краями дня. */
  readonly timed: ReadonlyArray<{ readonly event: TimedEvent; readonly start: number; readonly end: number }>;
}

/**
 * События одного дня у пользователя. Событие через полночь попадает в оба дня, а событие
 * длиннее суток (с 10:00 одного дня до 18:00 следующего) в днях целиком лежит в строке «Весь день».
 */
export function eventsOnDay(events: readonly CalEvent[], date: string, tz: string): DayEvents {
  const from = dayStart(date, tz);
  const to = dayStart(addDays(date, 1), tz);
  const allDay: CalEvent[] = [];
  const timed: Array<{ event: TimedEvent; start: number; end: number }> = [];
  for (const e of events) {
    if (e.allDay) {
      if (e.startDate <= date && date < e.endDate) allDay.push(e);
      continue;
    }
    // Событие без длительности видно в момент начала.
    const end = Math.max(e.end, e.start + 1);
    if (end <= from || e.start >= to) continue;
    if (e.start <= from && end >= to) {
      allDay.push(e);
      continue;
    }
    const start = e.start <= from ? 0 : minuteOf(e.start, tz);
    const stop = end >= to ? 24 * 60 : minuteOf(end, tz);
    timed.push({ event: e, start, end: Math.max(stop, start + 1) });
  }
  allDay.sort((a, b) => a.title.localeCompare(b.title));
  timed.sort((a, b) => a.start - b.start || a.end - b.end || a.event.title.localeCompare(b.event.title));
  return { allDay, timed };
}

/** Края окна дат [from, to) в мс UTC с запасом в сутки: пояса событий и пользователя могут различаться. */
export function windowBounds(from: string, days: number, tz: string): { from: number; to: number } {
  return { from: dayStart(addDays(from, -1), tz), to: dayStart(addDays(from, days + 1), tz) };
}
