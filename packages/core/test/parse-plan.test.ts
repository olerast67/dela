/**
 * План дня в разборщике (7.2): длительность без «на», цепочки «потом/then/→», список со временем.
 * «Сейчас» — вторник 24 ноября 2026, 05:00 по Москве.
 */
import { describe, expect, it } from 'vitest';
import { parsePlan, parseTask, planTaskList, splitTaskList, type ParseContext } from '../src/index.ts';

const ctx: ParseContext = { now: Date.UTC(2026, 10, 24, 2, 0), tz: 'Europe/Moscow', projects: [{ id: 'p-home', name: 'Дом' }] };
const D = '2026-11-24';

describe('длительность без «на»', () => {
  const cases: Array<[string, string, number]> = [
    ['уборка 30м', 'уборка', 30],
    ['уборка 30 мин', 'уборка', 30],
    ['уборка 30 минут', 'уборка', 30],
    ['уборка 1 минуту', 'уборка', 1],
    ['спорт 1ч', 'спорт', 60],
    ['спорт 1 час', 'спорт', 60],
    ['спорт 2 часа', 'спорт', 120],
    ['чтение 1,5ч', 'чтение', 90],
    ['reading 1.5h', 'reading', 90],
    ['обед полчаса', 'обед', 30],
    ['обед полтора часа', 'обед', 90],
    ['email 30m', 'email', 30],
    ['gym 1h', 'gym', 60],
    ['gym 90min', 'gym', 90],
    ['gym 90 minutes', 'gym', 90],
    ['gym 2 hours', 'gym', 120],
    ['gym 2hrs', 'gym', 120],
  ];
  for (const [text, title, duration] of cases) {
    it(text, () => {
      const p = parseTask(text, ctx);
      expect(p.title).toBe(title);
      expect(p.duration).toBe(duration);
      expect(p.tokens.some((t) => t.kind === 'duration')).toBe(true);
    });
  }

  it('вместе со временем и датой', () => {
    expect(parseTask('6:00 подъём и зарядка 1ч', ctx)).toMatchObject({ title: 'подъём и зарядка', due: { date: D, time: '06:00' }, duration: 60 });
    expect(parseTask('обед 13:00 1ч', ctx)).toMatchObject({ title: 'обед', due: { date: D, time: '13:00' }, duration: 60 });
    expect(parseTask('завтра в 9 созвон 20 мин', ctx)).toMatchObject({ title: 'созвон', due: { date: '2026-11-25', time: '09:00' }, duration: 20 });
    expect(parseTask('call tomorrow at 9 45m', ctx)).toMatchObject({ title: 'call', due: { date: '2026-11-25', time: '09:00' }, duration: 45 });
  });

  const untouched: Array<[string, Partial<ReturnType<typeof parseTask>>]> = [
    ['купить 2 кг яблок', { title: 'купить 2 кг яблок', duration: null }],
    ['купить 30 м кабеля', { title: 'купить 30 м кабеля', duration: null }],
    ['план 2026', { title: 'план 2026', duration: null }],
    ['через 2 часа позвонить', { title: 'позвонить', duration: null }],
    ['через полчаса выйти', { title: 'выйти', duration: null }],
    ['напомни за 30 минут встреча в 15', { title: 'встреча', duration: null, reminders: [30] }],
    ['сериал по 30 минут', { title: 'сериал по 30 минут', duration: null }],
    ['выйти за 2 часа до поезда', { title: 'выйти за 2 часа до поезда', duration: null }],
    ['in 30 min check oven', { title: 'check oven', duration: null }],
    ['в 9 ч встреча', { title: 'встреча', duration: null }],
    ['встреча на 45 минут', { title: 'встреча', duration: 45 }],
    ['звонок p1 30м', { title: 'звонок', priority: 1, duration: 30 }],
    ['5m30 test', { title: '5m30 test', duration: null }],
    ['h1 header', { title: 'h1 header', duration: null }],
  ];
  for (const [text, want] of untouched) {
    it(`не ломает: ${text}`, () => expect(parseTask(text, ctx)).toMatchObject(want));
  }

  it('интервал задаёт длительность, «30м» после него не перебивает', () => {
    expect(parseTask('встреча 9-10 30м', ctx)).toMatchObject({ due: { time: '09:00' }, duration: 60 });
  });

  it('разбор выключен — длительности нет', () => {
    expect(parseTask('уборка 30м', { ...ctx, plain: true })).toMatchObject({ title: 'уборка 30м', duration: null });
  });
});

describe('цепочка одной фразой', () => {
  it('голосом: «в шесть подъём на час потом банк полчаса потом созвон 20 минут»', () => {
    const r = parsePlan('в шесть подъём на час потом банк полчаса потом созвон 20 минут', ctx)!;
    expect(r.map((p) => [p.parsed.title, p.parsed.due?.time, p.parsed.duration])).toEqual([
      ['подъём', '06:00', 60],
      ['банк', '07:00', 30],
      ['созвон', '07:30', 20],
    ]);
    expect(r.every((p) => p.parsed.due?.date === D)).toBe(true);
  });

  it('разделители: затем, после этого, а потом, стрелки, then, after that', () => {
    const titles = (t: string) => parsePlan(t, ctx)!.map((p) => p.parsed.title);
    expect(titles('в 9 почта затем отчёт, после этого обед')).toEqual(['почта', 'отчёт', 'обед']);
    expect(titles('в 9 почта, а потом отчёт и потом обед')).toEqual(['почта', 'отчёт', 'обед']);
    expect(titles('9:00 email → standup 15m -> code 2h')).toEqual(['email', 'standup', 'code']);
    expect(titles('at 9 email then standup 15m and then code, after that lunch')).toEqual(['email', 'standup', 'code', 'lunch']);
  });

  it('позиции кусков в исходной фразе', () => {
    const text = 'в 9 почта потом отчёт';
    const r = parsePlan(text, ctx)!;
    expect(r.map((p) => text.slice(p.start, p.start + p.text.length))).toEqual(['в 9 почта', 'отчёт']);
  });

  it('без длительности следующий встаёт через 15 минут (или defaultDuration)', () => {
    expect(parsePlan('в 9 почта потом отчёт', ctx)!.map((p) => p.parsed.due?.time)).toEqual(['09:00', '09:15']);
    expect(parsePlan('в 9 почта потом отчёт', ctx, { defaultDuration: 30 })!.map((p) => p.parsed.due?.time)).toEqual(['09:00', '09:30']);
    // Длительность по умолчанию в задачу не пишется.
    expect(parsePlan('в 9 почта потом отчёт', ctx)![0]!.parsed.duration).toBeNull();
  });

  it('дело со своим временем начинает новую цепочку и берёт дату цепочки', () => {
    const r = parsePlan('завтра в 9 почта 30м потом в 14 встреча 1ч потом звонок', ctx)!;
    expect(r.map((p) => [p.parsed.due?.date, p.parsed.due?.time])).toEqual([
      ['2026-11-25', '09:00'],
      ['2026-11-25', '14:00'],
      ['2026-11-25', '15:00'],
    ]);
  });

  it('обходит занятые отрезки', () => {
    const r = parsePlan('в 9 почта 30м потом отчёт 1ч', ctx, { busy: { [D]: [{ start: 9 * 60 + 40, end: 10 * 60 }] } })!;
    expect(r.map((p) => p.parsed.due?.time)).toEqual(['09:00', '10:00']);
  });

  it('за полночь — дата цепочки без времени', () => {
    const r = parsePlan('в 23:30 сериал 1ч потом спать', ctx)!;
    expect(r.map((p) => p.parsed.due)).toEqual([{ date: D, time: '23:30' }, { date: D }]);
  });

  it('без времени — дата цепочки без времени; без даты и времени — как есть', () => {
    expect(parsePlan('завтра хлеб потом молоко', ctx)!.map((p) => p.parsed.due)).toEqual([{ date: '2026-11-25' }, { date: '2026-11-25' }]);
    expect(parsePlan('хлеб потом молоко', ctx)!.map((p) => p.parsed.due)).toEqual([null, null]);
  });

  it('null, если разделителя нет, кусок один или разбор выключен', () => {
    expect(parsePlan('купить хлеб', ctx)).toBeNull();
    expect(parsePlan('потом', ctx)).toBeNull();
    expect(parsePlan('потомки и затемнение', ctx)).toBeNull();
    expect(parsePlan('a потом b', { ...ctx, plain: true })).toBeNull();
  });
});

describe('вставленный список', () => {
  it('пример из плана: 6:00 60, 7:00 30, 7:30 20, 13:00 60', () => {
    const lines = splitTaskList('6:00 подъём и зарядка 1ч\nбанк, выписка 30м\nсозвон с юристом 20м\nобед 13:00 1ч')!;
    const r = planTaskList(lines, ctx);
    expect(r.map((p) => [p.title, p.due?.date, p.due?.time, p.duration])).toEqual([
      ['подъём и зарядка', D, '06:00', 60],
      ['банк, выписка', D, '07:00', 30],
      ['созвон с юристом', D, '07:30', 20],
      ['обед', D, '13:00', 60],
    ]);
  });

  it('строки после времени без даты остаются в дне первой строки', () => {
    // В 14:00 «6:00» по отдельности ушло бы на завтра; «15:00» — сегодня. В списке — один день.
    const late = { ...ctx, now: Date.UTC(2026, 10, 24, 11, 0) };
    const r = planTaskList(splitTaskList('6:00 подъём 1ч\nзарядка\n15:00 обед')!, late);
    expect(r.map((p) => p.due)).toEqual([
      { date: '2026-11-25', time: '06:00' },
      { date: '2026-11-25', time: '07:00' },
      { date: '2026-11-25', time: '15:00' },
    ]);
  });

  it('без времени — как раньше: каждая строка разбирается сама', () => {
    const lines = splitTaskList('купить хлеб\nзавтра позвонить маме\nмолоко')!;
    expect(planTaskList(lines, ctx)).toEqual(lines.map((l) => parseTask(l.text, ctx)));
  });

  it('строка с датой без времени прерывает цепочку; подзадачи не участвуют', () => {
    const lines = splitTaskList('9:00 почта 30м\n  подзадача\nотчёт\nзавтра купить\nзвонок')!;
    const r = planTaskList(lines, ctx);
    expect(r.map((p) => p.due)).toEqual([
      { date: D, time: '09:00' },
      null,
      { date: D, time: '09:30' },
      { date: '2026-11-25' },
      null,
    ]);
  });

  it('строки до первой со временем остаются без срока', () => {
    const r = planTaskList(splitTaskList('купить хлеб\n10:00 встреча\nзаметки')!, ctx);
    expect(r.map((p) => p.due)).toEqual([null, { date: D, time: '10:00' }, { date: D, time: '10:15' }]);
  });
});
