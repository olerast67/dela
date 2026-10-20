import { describe, expect, it } from 'vitest';
import { Doc, HybridClock, eventsOnDay, initCrypto, newKey, normalizeCalendarUrl, openEnvelope, sealOp, spaceKeys, type CalEvent } from '../src/index.ts';

await initCrypto();

const NOW = Date.UTC(2026, 9, 13, 9, 0);
const SPACE = '01929c3e-0000-7000-8000-0000000000a1';
const SECRET = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123456789abcdef/basic.ics';

function device(node: string, now = () => NOW) {
  return new Doc({ spaceId: SPACE, clock: new HybridClock(node, now), now, timeZone: 'Europe/Moscow' });
}

describe('подписки на календари', () => {
  it('webcal:// становится https://, http и мусор не принимаются', () => {
    expect(normalizeCalendarUrl(' webcal://example.com/cal.ics ')).toBe('https://example.com/cal.ics');
    expect(normalizeCalendarUrl('webcals://example.com/a.ics')).toBe('https://example.com/a.ics');
    expect(normalizeCalendarUrl('http://example.com/a.ics')).toBeNull();
    expect(normalizeCalendarUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeCalendarUrl('')).toBeNull();
  });

  it('хранится записью в личном пространстве, ссылка уходит на сервер только шифротекстом', () => {
    const a = device('00000000000000aa');
    const id = a.addCalendar({ name: 'Работа', url: SECRET, color: 'green' });
    expect(a.calendars()).toMatchObject([{ id, name: 'Работа', url: SECRET, color: 'green', enabled: true }]);

    const keys = spaceKeys(newKey());
    const sealed = a.pending().map((op) => sealOp(SPACE, keys, op));
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain('google');
    expect(wire).not.toContain('private-0123456789abcdef');
    expect(wire).not.toContain('calendar');
    // Другое устройство с ключом пространства открывает те же записи.
    const b = device('00000000000000bb');
    b.applyRemote(sealed.map((e) => openEnvelope(SPACE, keys, e)));
    expect(b.calendars()).toMatchObject([{ id, name: 'Работа', url: SECRET }]);
  });

  it('правки с двух устройств сливаются по ячейкам', () => {
    let t = NOW;
    const now = () => t;
    const a = device('00000000000000aa', now);
    const b = device('00000000000000bb', now);
    const id = a.addCalendar({ name: 'Семья', url: 'webcal://example.com/family.ics' });
    b.applyRemote(a.pending());
    a.acknowledge(a.pending());

    t += 1000;
    a.updateCalendar(id, { name: 'Семейный' });
    t += 1000;
    b.updateCalendar(id, { enabled: false, color: 'pink' });
    a.applyRemote(b.pending());
    b.applyRemote(a.pending());
    for (const d of [a, b]) expect(d.calendars()).toMatchObject([{ name: 'Семейный', enabled: false, color: 'pink', url: 'https://example.com/family.ics' }]);
  });

  it('удаление стирает ссылку и побеждает старую правку', () => {
    let t = NOW;
    const now = () => t;
    const a = device('00000000000000aa', now);
    const b = device('00000000000000bb', now);
    const id = a.addCalendar({ name: 'Старый', url: SECRET });
    b.applyRemote(a.pending());
    t += 1000;
    b.updateCalendar(id, { name: 'Переименован' });
    t += 1000;
    a.deleteCalendar(id);
    a.applyRemote(b.pending());
    b.applyRemote(a.pending());
    for (const d of [a, b]) {
      expect(d.calendars()).toEqual([]);
      expect(d.replica.get('calendar', id)?.url).toBeNull();
    }
  });

  it('отмена добавления убирает подписку', () => {
    const a = device('00000000000000aa');
    a.addCalendar({ name: 'x', url: SECRET });
    a.undo();
    expect(a.calendars()).toEqual([]);
  });

  it('ссылку не на https записать нельзя', () => {
    const a = device('00000000000000aa');
    expect(() => a.addCalendar({ name: 'x', url: 'ftp://example.com/a.ics' })).toThrow();
  });
});

describe('события дня', () => {
  const TZ = 'Europe/Moscow';
  const base = { calendar: 'c', location: '', description: '', color: 'red' };
  const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);

  it('раскладывает события со временем, целодневные и через полночь', () => {
    const events: CalEvent[] = [
      { ...base, id: '1', title: 'Встреча', allDay: false, start: at('2026-10-13', '10:00'), end: at('2026-10-13', '11:30') },
      { ...base, id: '2', title: 'Отпуск', allDay: true, startDate: '2026-10-12', endDate: '2026-10-15' },
      { ...base, id: '3', title: 'Ночной поезд', allDay: false, start: at('2026-10-13', '23:00'), end: at('2026-10-14', '07:00') },
      { ...base, id: '4', title: 'Конференция', allDay: false, start: at('2026-10-12', '10:00'), end: at('2026-10-14', '18:00') },
      { ...base, id: '5', title: 'Вчера', allDay: true, startDate: '2026-10-12', endDate: '2026-10-13' },
    ];
    const day = eventsOnDay(events, '2026-10-13', TZ);
    expect(day.allDay.map((e) => e.title)).toEqual(['Конференция', 'Отпуск']);
    expect(day.timed.map((x) => [x.event.title, x.start, x.end])).toEqual([
      ['Встреча', 600, 690],
      ['Ночной поезд', 1380, 1440],
    ]);
    const next = eventsOnDay(events, '2026-10-14', TZ);
    expect(next.timed.map((x) => [x.event.title, x.start, x.end])).toEqual([
      ['Ночной поезд', 0, 420],
      ['Конференция', 0, 1080],
    ]);
  });
});
