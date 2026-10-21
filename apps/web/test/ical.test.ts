import { describe, expect, it } from 'vitest';
import { expandCalendar, MAX_EVENTS, parseCalendar, plainText } from '../src/ical.ts';
import type { CalEvent } from '#core';

const TZ = 'Europe/Moscow';

function ics(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events, 'END:VCALENDAR'].join('\r\n');
}

/** Событие из строк свойств. */
function vevent(...lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

function expand(text: string, from: string, to: string, tz = TZ): CalEvent[] {
  return expandCalendar(parseCalendar(text), { calendar: 'c', color: 'red', from: Date.parse(`${from}T00:00:00Z`), to: Date.parse(`${to}T00:00:00Z`), tz });
}

const iso = (e: CalEvent) => (e.allDay ? [e.startDate, e.endDate] : [new Date(e.start).toISOString(), new Date(e.end).toISOString()]);

describe('разбор iCal', () => {
  it('событие на весь день и событие на несколько дней', () => {
    const list = expand(
      ics(
        vevent('UID:a', 'SUMMARY:День рождения', 'DTSTART;VALUE=DATE:20261015'),
        vevent('UID:b', 'SUMMARY:Отпуск', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261025'),
      ),
      '2026-10-01',
      '2026-11-01',
    );
    expect(list.map((e) => [e.title, e.allDay, ...iso(e)])).toEqual([
      ['День рождения', true, '2026-10-15', '2026-10-16'],
      ['Отпуск', true, '2026-10-20', '2026-10-25'],
    ]);
  });

  it('пояс IANA без VTIMEZONE, UTC, плавающее время и DURATION', () => {
    const list = expand(
      ics(
        vevent('UID:ny', 'SUMMARY:Нью-Йорк', 'DTSTART;TZID=America/New_York:20261015T090000', 'DTEND;TZID=America/New_York:20261015T100000'),
        vevent('UID:utc', 'SUMMARY:UTC', 'DTSTART:20261015T120000Z', 'DURATION:PT45M'),
        vevent('UID:fl', 'SUMMARY:Плавающее', 'DTSTART:20261015T080000', 'DTEND:20261015T083000'),
      ),
      '2026-10-01',
      '2026-11-01',
    );
    const by = Object.fromEntries(list.map((e) => [e.title, iso(e)]));
    expect(by['Нью-Йорк']).toEqual(['2026-10-15T13:00:00.000Z', '2026-10-15T14:00:00.000Z']);
    expect(by['UTC']).toEqual(['2026-10-15T12:00:00.000Z', '2026-10-15T12:45:00.000Z']);
    // Плавающее время стоит в поясе пользователя: 8:00 в Москве.
    expect(by['Плавающее']).toEqual(['2026-10-15T05:00:00.000Z', '2026-10-15T05:30:00.000Z']);
  });

  it('пояс из VTIMEZONE под своим именем, как у Outlook', () => {
    const tz = ['BEGIN:VTIMEZONE', 'TZID:Custom Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0500', 'TZOFFSETTO:+0500', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
    const list = expand(
      ics(tz, vevent('UID:x', 'SUMMARY:Екб', 'DTSTART;TZID=Custom Standard Time:20261015T100000', 'DTEND;TZID=Custom Standard Time:20261015T110000')),
      '2026-10-01',
      '2026-11-01',
    );
    expect(list.map(iso)).toEqual([['2026-10-15T05:00:00.000Z', '2026-10-15T06:00:00.000Z']]);
  });

  it('RRULE с EXDATE и RECURRENCE-ID в окне', () => {
    const list = expand(
      ics(
        vevent(
          'UID:weekly',
          'SUMMARY:Планёрка',
          'DTSTART;TZID=Europe/Moscow:20261005T100000',
          'DTEND;TZID=Europe/Moscow:20261005T103000',
          'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6',
          'EXDATE;TZID=Europe/Moscow:20261012T100000',
        ),
        vevent(
          'UID:weekly',
          'RECURRENCE-ID;TZID=Europe/Moscow:20261019T100000',
          'SUMMARY:Планёрка (перенесена)',
          'DTSTART;TZID=Europe/Moscow:20261020T150000',
          'DTEND;TZID=Europe/Moscow:20261020T160000',
        ),
        vevent(
          'UID:weekly',
          'RECURRENCE-ID;TZID=Europe/Moscow:20261026T100000',
          'STATUS:CANCELLED',
          'SUMMARY:Планёрка',
          'DTSTART;TZID=Europe/Moscow:20261026T100000',
          'DTEND;TZID=Europe/Moscow:20261026T103000',
        ),
      ),
      '2026-10-10',
      '2026-11-30',
    );
    expect(list.map((e) => [e.title, iso(e)[0]])).toEqual([
      ['Планёрка (перенесена)', '2026-10-20T12:00:00.000Z'],
      ['Планёрка', '2026-11-02T07:00:00.000Z'],
      ['Планёрка', '2026-11-09T07:00:00.000Z'],
    ]);
    // У экземпляров разные id, окно до 10 октября не попадает.
    expect(new Set(list.map((e) => e.id)).size).toBe(3);
  });

  it('RDATE добавляет экземпляры к расписанию', () => {
    const list = expand(
      ics(vevent('UID:r', 'SUMMARY:Встреча', 'DTSTART:20261001T090000Z', 'DURATION:PT1H', 'RDATE:20261015T090000Z,20261020T090000Z')),
      '2026-10-10',
      '2026-11-01',
    );
    expect(list.map((e) => iso(e)[0])).toEqual(['2026-10-15T09:00:00.000Z', '2026-10-20T09:00:00.000Z']);
  });

  it('повтор держит время на стене при переходе на летнее время', () => {
    const list = expand(
      ics(vevent('UID:dst', 'SUMMARY:Йога', 'DTSTART;TZID=Europe/Berlin:20260323T090000', 'DTEND;TZID=Europe/Berlin:20260323T100000', 'RRULE:FREQ=WEEKLY;UNTIL=20260407T000000Z')),
      '2026-03-01',
      '2026-05-01',
      'Europe/Berlin',
    );
    // 29 марта Германия перешла на летнее время: 9:00 было 08:00 UTC, стало 07:00 UTC.
    expect(list.map((e) => iso(e)[0])).toEqual(['2026-03-23T08:00:00.000Z', '2026-03-30T07:00:00.000Z', '2026-04-06T07:00:00.000Z']);
  });

  it('событие через переход часов длится столько, сколько на стене', () => {
    const list = expand(ics(vevent('UID:n', 'SUMMARY:Ночь', 'DTSTART;TZID=Europe/Berlin:20261024T230000', 'DTEND;TZID=Europe/Berlin:20261025T070000')), '2026-10-01', '2026-11-01');
    const e = list[0]!;
    expect(e.allDay).toBe(false);
    // Осенью час прибавляется: с 23:00 до 7:00 проходит девять часов.
    if (!e.allDay) expect((e.end - e.start) / 3_600_000).toBe(9);
  });

  it('бесконечный ежедневный повтор с давних времён разворачивается только в окне', () => {
    const list = expand(ics(vevent('UID:d', 'SUMMARY:Зарядка', 'DTSTART;VALUE=DATE:20100101', 'RRULE:FREQ=DAILY')), '2026-10-13', '2026-10-16');
    expect(list.map((e) => iso(e)[0])).toEqual(['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  });

  it('свёрнутые строки, экранирование и HTML в описании', () => {
    const list = expand(
      ics(vevent('UID:t', 'SUMMARY:Обед\\, потом кофе', 'LOCATION:Кафе', 'DESCRIPTION:<b>Взять</b> ноутбук<br>и за\r\n рядку', 'DTSTART:20261015T090000Z')),
      '2026-10-01',
      '2026-11-01',
    );
    expect(list[0]).toMatchObject({ title: 'Обед, потом кофе', location: 'Кафе', description: 'Взять ноутбук\nи зарядку' });
    expect(plainText('a &lt;script&gt; b')).toBe('a &lt;script&gt; b');
  });

  it('не календарь — ошибка', () => {
    expect(() => parseCalendar('<html>Sign in</html>')).toThrow();
  });

  it('повтор каждую минуту или секунду — только первый экземпляр', () => {
    const list = expand(
      ics(
        vevent('UID:m', 'SUMMARY:Минутный', 'DTSTART:20261015T090000Z', 'DTEND:20261015T090030Z', 'RRULE:FREQ=MINUTELY'),
        vevent('UID:s', 'SUMMARY:Секундный', 'DTSTART:20261015T100000Z', 'RRULE:FREQ=SECONDLY;INTERVAL=5'),
      ),
      '2026-10-15',
      '2026-10-16',
    );
    expect(list.map((e) => [e.title, ...iso(e)])).toEqual([
      ['Минутный', '2026-10-15T09:00:00.000Z', '2026-10-15T09:00:30.000Z'],
      ['Секундный', '2026-10-15T10:00:00.000Z', '2026-10-15T10:00:00.000Z'],
    ]);
  });

  it('ежечасный повтор с давних времён не перебирается', () => {
    const list = expand(ics(vevent('UID:h', 'SUMMARY:Часы', 'DTSTART:19700101T000000Z', 'RRULE:FREQ=HOURLY')), '2026-10-15', '2026-10-16');
    expect(list).toEqual([]);
  });

  it('бюджет шагов общий на весь календарь, свежие серии идут первыми', () => {
    // Каждая давняя серия укладывается в предел на событие (~19 тысяч дней), но вместе они больше общего бюджета.
    const old = Array.from({ length: 4 }, (_, i) => vevent(`UID:old${i}`, 'SUMMARY:Старый', 'DTSTART;VALUE=DATE:19750101', 'RRULE:FREQ=DAILY'));
    const list = expand(ics(...old, vevent('UID:new', 'SUMMARY:Новый', 'DTSTART;VALUE=DATE:20260901', 'RRULE:FREQ=DAILY')), '2026-10-15', '2026-10-16');
    const series = (title: string) => new Set(list.filter((e) => e.title === title).map((e) => e.id.split(':')[1])).size;
    expect(list.some((e) => e.title === 'Новый')).toBe(true);
    // Бюджета хватает на две давние серии из четырёх.
    expect(series('Старый')).toBe(2);
  });

  it('больше MAX_EVENTS событий не берётся', () => {
    const many = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => vevent(`UID:e${i}`, 'DTSTART;VALUE=DATE:20261015'));
    expect(parseCalendar(ics(...many)).events).toHaveLength(MAX_EVENTS);
    // Разбор 10 000 событий под нагрузкой полного прогона идёт дольше 5 секунд по умолчанию.
  }, 30_000);
});

