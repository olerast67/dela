import { describe, expect, it } from 'vitest';
import {
  Doc,
  HybridClock,
  formatRule,
  nextOccurrence,
  occurrencesBetween,
  parseRule,
  type Rule,
} from '../src/index.ts';

const r = (s: string): Rule => {
  const rule = parseRule(s);
  if (!rule) throw new Error(`bad rule ${s}`);
  return rule;
};

describe('правила RRULE', () => {
  it('разбор и запись обратно', () => {
    for (const s of [
      'FREQ=DAILY',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR',
      'FREQ=MONTHLY;BYDAY=-1FR',
      'FREQ=MONTHLY;BYMONTHDAY=-1',
      'FREQ=YEARLY;BYMONTHDAY=15;BYMONTH=11;UNTIL=20301231',
    ]) {
      expect(formatRule(r(s))).toBe(s);
    }
    expect(parseRule('FREQ=HOURLY')).toBeNull();
    expect(parseRule('FREQ=DAILY;INTERVAL=0')).toBeNull();
    expect(parseRule('FREQ=WEEKLY;BYDAY=XX')).toBeNull();
    expect(parseRule('FREQ=DAILY;COUNT=3')).toBeNull();
    expect(parseRule('FREQ=DAILY;UNTIL=20260231')).toBeNull();
  });

  it('каждые 3 дня', () => {
    expect(nextOccurrence(r('FREQ=DAILY;INTERVAL=3'), '2026-10-13', '2026-10-13')).toBe('2026-10-16');
    expect(nextOccurrence(r('FREQ=DAILY;INTERVAL=3'), '2026-10-13', '2026-10-17')).toBe('2026-10-19');
    expect(nextOccurrence(r('FREQ=DAILY'), '2026-10-13', '2026-10-01')).toBe('2026-10-13');
  });

  it('каждые 2 недели по понедельникам и пятницам', () => {
    const rule = r('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR');
    // Якорь — вторник 13 октября; неделя якоря: 12–18 октября.
    expect(occurrencesBetween(rule, '2026-10-13', '2026-10-01', '2026-11-10')).toEqual([
      '2026-10-16',
      '2026-10-26',
      '2026-10-30',
      '2026-11-09',
    ]);
  });

  it('по будням', () => {
    const rule = r('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(nextOccurrence(rule, '2026-10-16', '2026-10-16')).toBe('2026-10-19');
  });

  it('31-е число в коротких месяцах переходит на последний день, без дрейфа', () => {
    const rule = r('FREQ=MONTHLY;BYMONTHDAY=31');
    expect(occurrencesBetween(rule, '2026-01-31', '2026-01-01', '2026-05-01')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
    expect(nextOccurrence(rule, '2026-02-28', '2026-02-28')).toBe('2026-03-31');
  });

  it('последняя пятница месяца, второй вторник месяца, последний день', () => {
    expect(occurrencesBetween(r('FREQ=MONTHLY;BYDAY=-1FR'), '2026-10-01', '2026-10-01', '2027-01-01')).toEqual([
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
    ]);
    expect(nextOccurrence(r('FREQ=MONTHLY;BYDAY=2TU'), '2026-10-01', '2026-10-13')).toBe('2026-11-10');
    expect(nextOccurrence(r('FREQ=MONTHLY;BYMONTHDAY=-1'), '2026-01-31', '2026-01-31')).toBe('2026-02-28');
  });

  it('каждый год, 29 февраля и окончание серии', () => {
    expect(nextOccurrence(r('FREQ=YEARLY'), '2028-02-29', '2028-02-29')).toBe('2029-02-28');
    expect(nextOccurrence(r('FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=15'), '2026-01-01', '2026-11-15')).toBe('2027-11-15');
    expect(nextOccurrence(r('FREQ=DAILY;UNTIL=20261015'), '2026-10-13', '2026-10-14')).toBe('2026-10-15');
    expect(nextOccurrence(r('FREQ=DAILY;UNTIL=20261015'), '2026-10-13', '2026-10-15')).toBeNull();
  });
});

describe('повторяющиеся задачи в Doc', () => {
  const SPACE = '01929c3e-0000-7000-8000-00000000bbbb';
  const TZ = 'Europe/Moscow';
  // 13 октября 2026, 12:00 по Москве.
  const NOON = Date.UTC(2026, 9, 13, 9, 0);

  function device(node: string, time = NOON) {
    let t = time;
    const doc = new Doc({ spaceId: SPACE, clock: new HybridClock(node, () => t), now: () => t, timeZone: TZ });
    return { doc, setTime: (x: number) => (t = x) };
  }

  it('выполнение сдвигает срок, время сохраняется, подзадачи открываются заново', () => {
    const { doc } = device('00000000000000aa');
    const id = doc.createTask({
      title: 'Планёрка',
      due: { date: '2026-10-13', time: '10:00' },
      recurrence: { rule: 'FREQ=WEEKLY;BYDAY=TU', mode: 'schedule', text: 'каждый вторник' },
    });
    const sub = doc.createTask({ title: 'Повестка', parentId: id });
    doc.completeTask(sub);
    doc.completeTask(id);
    expect(doc.task(id)).toMatchObject({ completedAt: null, due: { date: '2026-10-20', time: '10:00' } });
    expect(doc.task(sub)?.completedAt).toBeNull();
    expect(doc.completions(id).map((c) => c.occurrence)).toEqual(['2026-10-13']);
  });

  it('просроченная ежедневная задача после выполнения переходит на завтра', () => {
    const { doc } = device('00000000000000aa');
    const id = doc.createTask({
      title: 'Зарядка',
      due: { date: '2026-10-10' },
      recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' },
    });
    doc.completeTask(id);
    expect(doc.task(id)?.due?.date).toBe('2026-10-14');
  });

  it('режим «от выполнения» считает от сегодняшнего дня', () => {
    const { doc } = device('00000000000000aa');
    const id = doc.createTask({
      title: 'Полить цветы',
      due: { date: '2026-10-05' },
      recurrence: { rule: 'FREQ=DAILY;INTERVAL=3', mode: 'completion', text: 'каждые 3 дня после выполнения' },
    });
    doc.completeTask(id);
    expect(doc.task(id)?.due?.date).toBe('2026-10-16');
  });

  it('один экземпляр, отмеченный на двух устройствах офлайн, не даёт дубля и сдвигается одинаково', () => {
    const a = device('00000000000000aa');
    const b = device('00000000000000bb');
    const id = a.doc.createTask({
      title: 'Отчёт',
      due: { date: '2026-10-13' },
      recurrence: { rule: 'FREQ=WEEKLY;BYDAY=TU', mode: 'schedule', text: 'каждый вторник' },
    });
    b.doc.applyRemote(a.doc.pending());
    a.doc.completeTask(id);
    b.setTime(NOON + 60_000);
    b.doc.completeTask(id);
    const ops = [...a.doc.pending(), ...b.doc.pending()];
    a.doc.applyRemote(ops);
    b.doc.applyRemote(ops);
    for (const d of [a.doc, b.doc]) {
      expect(d.completions(id)).toHaveLength(1);
      expect(d.task(id)?.due?.date).toBe('2026-10-20');
    }
  });

  it('конец серии закрывает задачу; пропуск экземпляра не создаёт выполнения', () => {
    const { doc } = device('00000000000000aa');
    const id = doc.createTask({
      title: 'Курс',
      due: { date: '2026-10-13' },
      recurrence: { rule: 'FREQ=DAILY;UNTIL=20261014', mode: 'schedule', text: 'каждый день до 14 октября' },
    });
    doc.skipOccurrence(id);
    expect(doc.task(id)?.due?.date).toBe('2026-10-14');
    expect(doc.completions(id)).toEqual([]);
    doc.completeTask(id);
    expect(doc.task(id)?.completedAt).not.toBeNull();
  });

  it('в «Предстоящих» видны будущие экземпляры', () => {
    const { doc } = device('00000000000000aa');
    doc.createTask({
      title: 'Спортзал',
      due: { date: '2026-10-13' },
      recurrence: { rule: 'FREQ=WEEKLY;BYDAY=TU,TH', mode: 'schedule', text: 'по вторникам и четвергам' },
    });
    const days = doc.upcoming('2026-10-13', 7, TZ).filter((g) => g.tasks.length > 0);
    expect(days.map((g) => [g.date, g.tasks[0]!.projected ?? false])).toEqual([
      ['2026-10-13', false],
      ['2026-10-15', true],
    ]);
  });
});
