/**
 * Разбор календаря iCal (RFC 5545) и развёртка событий в окне дат. Модуль тяжёлый (ical.js),
 * поэтому грузится отдельным чанком и только когда у пользователя есть подписки.
 *
 * Пояса: имя IANA (Europe/Berlin) переводится средствами Intl, у них свежие правила перехода
 * на летнее время. Своё имя (у Outlook «Russian Standard Time») берётся из VTIMEZONE в файле.
 * Время без пояса — «плавающее», оно стоит в поясе пользователя.
 */
import ICAL from 'ical.js';
import { addDays, isTimeZone, zonedToUtc, type CalEvent } from '#core';

type Component = InstanceType<typeof ICAL.Component>;
type Event = InstanceType<typeof ICAL.Event>;
type Time = InstanceType<typeof ICAL.Time>;

/** Больше этого файл календаря не разбирается: защита от зависания на огромном ответе. */
export const MAX_ICS_BYTES = 20 * 1024 * 1024;
/** Сколько экземпляров одного повтора перебирается до конца окна. */
const MAX_STEPS = 50_000;

export interface ParsedCalendar {
  readonly events: readonly Event[];
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function dateOf(t: Time): string {
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
}

/** Мгновение UTC для времени события; tzid — параметр TZID свойства, из которого время пришло. */
function instantOf(t: Time, tzid: string | null, userTz: string): number {
  const zone = t.zone?.tzid;
  if (zone === 'UTC' || zone === 'Z') return t.toUnixTime() * 1000;
  const wall = (tz: string) => zonedToUtc(dateOf(t), `${pad(t.hour)}:${pad(t.minute)}`, tz) + t.second * 1000;
  if (tzid && isTimeZone(tzid)) return wall(tzid);
  // Пояс описан в файле (VTIMEZONE) под своим именем.
  if (zone && zone !== 'floating') return t.toUnixTime() * 1000;
  return wall(userTz);
}

function tzidOf(item: Event, prop: 'dtstart' | 'dtend'): string | null {
  const p = item.component.getFirstProperty(prop);
  const v = p?.getParameter('tzid');
  return typeof v === 'string' ? v : null;
}

function cancelled(item: Event): boolean {
  return String(item.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

/** Описание текстом: у Google в нём бывает HTML. Теги убираются, сущности раскрываются. */
export function plainText(s: string): string {
  if (!/<[a-z/][^>]*>/i.test(s)) return s.trim();
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** Разобрать файл .ics. Бросает ошибку, если это не календарь. */
export function parseCalendar(ics: string): ParsedCalendar {
  if (ics.length > MAX_ICS_BYTES) throw new Error('calendar is too large');
  const jcal = ICAL.parse(ics);
  const roots = (Array.isArray(jcal[0]) ? jcal : [jcal]) as unknown[];
  const events: Event[] = [];
  for (const root of roots) {
    const comp: Component = new ICAL.Component(root as never);
    if (comp.name !== 'vcalendar') throw new Error('not a calendar');
    const vevents = comp.getAllSubcomponents('vevent');
    const masters = new Map<string, Event>();
    const exceptions: Event[] = [];
    for (const v of vevents) {
      if (!v.getFirstProperty('dtstart')) continue;
      const e = new ICAL.Event(v);
      if (v.hasProperty('recurrence-id')) exceptions.push(e);
      else {
        events.push(e);
        if (e.isRecurring() && e.uid) masters.set(e.uid, e);
      }
    }
    for (const x of exceptions) {
      const master = masters.get(x.uid);
      // Исключение без основного события показывается само по себе.
      if (master) master.relateException(x);
      else events.push(x);
    }
  }
  return { events };
}

export interface ExpandOptions {
  /** Id календаря: из него и UID строится id события. */
  readonly calendar: string;
  readonly color: string;
  /** Окно в мс UTC: [from, to). */
  readonly from: number;
  readonly to: number;
  /** Пояс пользователя: в нём стоят «плавающие» времена. */
  readonly tz: string;
}

/** События календаря, которые пересекают окно, с развёрнутыми повторами (RRULE, RDATE, EXDATE, RECURRENCE-ID). */
export function expandCalendar(cal: ParsedCalendar, o: ExpandOptions): CalEvent[] {
  const out: CalEvent[] = [];
  const seen = new Set<string>();
  const fromDate = new Date(o.from).toISOString().slice(0, 10);
  const toDate = addDays(new Date(o.to).toISOString().slice(0, 10), 1);

  const push = (item: Event, start: Time, end: Time, key: string, sameZoneEnd: boolean) => {
    if (cancelled(item)) return;
    let id = `${o.calendar}:${key}`;
    // UID может повторяться в плохо собранном файле: id всё равно должен быть уникален.
    for (let n = 2; seen.has(id); n++) id = `${o.calendar}:${key}#${n}`;
    const base = {
      id,
      calendar: o.calendar,
      title: text(item.summary, 500),
      location: text(item.location, 1000),
      description: plainText(text(item.description, 20_000)),
      color: o.color,
    };
    if (start.isDate) {
      const startDate = dateOf(start);
      let endDate = end.isDate ? dateOf(end) : addDays(startDate, 1);
      if (endDate <= startDate) endDate = addDays(startDate, 1);
      if (endDate <= fromDate || startDate >= toDate) return;
      seen.add(id);
      out.push({ ...base, allDay: true, startDate, endDate });
      return;
    }
    const s = instantOf(start, tzidOf(item, 'dtstart'), o.tz);
    const e = Math.max(s, instantOf(end, sameZoneEnd ? tzidOf(item, 'dtstart') : (tzidOf(item, 'dtend') ?? tzidOf(item, 'dtstart')), o.tz));
    if (Math.max(e, s + 1) <= o.from || s >= o.to) return;
    seen.add(id);
    out.push({ ...base, allDay: false, start: s, end: e });
  };

  cal.events.forEach((event, index) => {
    const uid = event.uid || `#${index}`;
    if (!event.isRecurring() || event.isRecurrenceException()) {
      const key = event.isRecurrenceException() ? `${uid}:${event.recurrenceId.toString()}` : uid;
      push(event, event.startDate, event.endDate, key, false);
      return;
    }
    const it = event.iterator();
    // Запас в двое суток: время экземпляра здесь грубое, пояс ещё не учтён.
    const stop = o.to + 2 * 86_400_000;
    for (let i = 0; i < MAX_STEPS; i++) {
      const occ = it.next();
      if (!occ) break;
      if (occ.toUnixTime() * 1000 > stop) break;
      const d = event.getOccurrenceDetails(occ);
      const exception = d.item !== event;
      // У экземпляра основного события конец посчитан от начала: он в поясе начала.
      push(d.item, d.startDate, d.endDate, `${uid}:${occ.toString()}`, !exception);
    }
  });
  return out;
}
