/**
 * Корпус фраз быстрого ввода. Каждый баг разбора добавляется сюда новой строкой.
 * «Сейчас» — вторник 13 октября 2026, 12:00 по Москве.
 */
import { describe, expect, it } from 'vitest';
import { parseTask, splitTaskList, type ParseContext, type ParsedTask } from '../src/index.ts';

const ctx: ParseContext = {
  now: Date.UTC(2026, 9, 13, 9, 0),
  tz: 'Europe/Moscow',
  projects: [
    { id: 'p-home', name: 'Дом' },
    { id: 'p-work', name: 'Работа' },
    { id: 'p-my', name: 'Мой проект' },
    { id: 'p-home-en', name: 'Home' },
  ],
  sections: [{ id: 's-reports', name: 'Отчёты', projectId: 'p-work' }],
  labels: [
    { id: 'l-urgent', name: 'срочно' },
    { id: 'l-call', name: 'звонок' },
  ],
};

type Expect = Partial<Omit<ParsedTask, 'recurrence' | 'tokens'>> & { rule?: string | null; mode?: 'schedule' | 'completion' };

const cases: Array<[string, Expect]> = [
  // Даты
  ['Купить хлеб сегодня', { title: 'Купить хлеб', due: { date: '2026-10-13' } }],
  ['завтра купить хлеб', { title: 'купить хлеб', due: { date: '2026-10-14' } }],
  ['послезавтра в баню', { title: 'в баню', due: { date: '2026-10-15' } }],
  ['отчёт в пятницу', { title: 'отчёт', due: { date: '2026-10-16' } }],
  ['отчёт к среде', { title: 'отчёт', due: { date: '2026-10-14' } }],
  ['отчёт в следующую пятницу', { title: 'отчёт', due: { date: '2026-10-23' } }],
  ['созвон во вторник в 15:00', { title: 'созвон', due: { date: '2026-10-20', time: '15:00' } }],
  ['встреча 15 ноября в 10:30', { title: 'встреча', due: { date: '2026-11-15', time: '10:30' } }],
  ['сдать 15.11', { title: 'сдать', due: { date: '2026-11-15' } }],
  ['сдать 1.10', { title: 'сдать', due: { date: '2027-10-01' } }],
  ['сдать 1.10.2026', { title: 'сдать', due: { date: '2026-10-01' } }],
  ['оплатить 2026-12-01', { title: 'оплатить', due: { date: '2026-12-01' } }],
  ['через 3 дня проверить', { title: 'проверить', due: { date: '2026-10-16' } }],
  ['через неделю', { title: '', due: { date: '2026-10-20' } }],
  ['через два месяца продлить', { title: 'продлить', due: { date: '2026-12-13' } }],
  ['в конце месяца сверка', { title: 'сверка', due: { date: '2026-10-31' } }],
  ['на выходных дача', { title: 'дача', due: { date: '2026-10-17' } }],
  ['на следующей неделе план', { title: 'план', due: { date: '2026-10-19' } }],
  ['в субботу утром рынок', { title: 'рынок', due: { date: '2026-10-17', time: '09:00' } }],
  // Время
  ['через 2 часа выключить духовку', { title: 'выключить духовку', due: { date: '2026-10-13', time: '14:00' } }],
  ['через полчаса', { title: '', due: { date: '2026-10-13', time: '12:30' } }],
  ['в 9 позвонить', { title: 'позвонить', due: { date: '2026-10-14', time: '09:00' } }],
  ['в 7 вечера ужин', { title: 'ужин', due: { date: '2026-10-13', time: '19:00' } }],
  ['в 3 дня встреча', { title: 'встреча', due: { date: '2026-10-13', time: '15:00' } }],
  ['завтра 18:30 тренировка', { title: 'тренировка', due: { date: '2026-10-14', time: '18:30' } }],
  ['созвон в 15:00 по Москве', { title: 'созвон', due: { date: '2026-10-13', time: '15:00', tz: 'Europe/Moscow' } }],
  // Интервал и длительность
  ['встреча с 9 до 10:30 завтра', { title: 'встреча', due: { date: '2026-10-14', time: '09:00' }, duration: 90 }],
  ['оплатить интернет вчера', { title: 'оплатить интернет', due: { date: '2026-10-12' } }],
  ['созвон с командой сегодня в 10:00-11:30', { title: 'созвон с командой', due: { date: '2026-10-13', time: '10:00' }, duration: 90 }],
  ['call at 9-10 tomorrow', { title: 'call', due: { date: '2026-10-14', time: '09:00' }, duration: 60 }],
  ['уборка на 30 минут', { title: 'уборка', due: null, duration: 30 }],
  ['уборка на полтора часа', { title: 'уборка', duration: 90 }],
  ['чтение на 1,5 ч', { title: 'чтение', duration: 90 }],
  // Повторы
  // Сейчас 12:00: время 7:00 и 10:00 сегодня уже прошло, первый срок завтра.
  ['зарядка каждый день в 7 утра', { title: 'зарядка', due: { date: '2026-10-14', time: '07:00' }, rule: 'FREQ=DAILY' }],
  ['планёрка по будням в 10', { title: 'планёрка', due: { date: '2026-10-14', time: '10:00' }, rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }],
  ['созвон каждый день в 15', { title: 'созвон', due: { date: '2026-10-13', time: '15:00' }, rule: 'FREQ=DAILY' }],
  ['планёрка по будням с сегодня в 10', { title: 'планёрка', due: { date: '2026-10-13', time: '10:00' }, rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }],
  ['платить аренду каждое 5 число', { title: 'платить аренду', due: { date: '2026-11-05' }, rule: 'FREQ=MONTHLY;BYMONTHDAY=5' }],
  [
    'полить цветы каждые 3 дня после выполнения',
    { title: 'полить цветы', due: { date: '2026-10-13' }, rule: 'FREQ=DAILY;INTERVAL=3', mode: 'completion' },
  ],
  ['уборка каждую субботу', { title: 'уборка', due: { date: '2026-10-17' }, rule: 'FREQ=WEEKLY;BYDAY=SA' }],
  ['бассейн по понедельникам и средам', { title: 'бассейн', due: { date: '2026-10-14' }, rule: 'FREQ=WEEKLY;BYDAY=MO,WE' }],
  ['день рождения мамы каждое 3 марта', { title: 'день рождения мамы', due: { date: '2027-03-03' }, rule: 'FREQ=YEARLY;BYMONTHDAY=3;BYMONTH=3' }],
  ['отчёт каждую последнюю пятницу месяца', { title: 'отчёт', due: { date: '2026-10-30' }, rule: 'FREQ=MONTHLY;BYDAY=-1FR' }],
  ['созвон каждый второй вторник', { title: 'созвон', due: { date: '2026-10-13' }, rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' }],
  ['созвон каждый второй вторник месяца', { title: 'созвон', due: { date: '2026-10-13' }, rule: 'FREQ=MONTHLY;BYDAY=2TU' }],
  ['счётчики каждый месяц', { title: 'счётчики', due: { date: '2026-10-13' }, rule: 'FREQ=MONTHLY;BYMONTHDAY=13' }],
  ['каждые 2 недели уборка', { title: 'уборка', due: { date: '2026-10-13' }, rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' }],
  ['каждую неделю с пятницы', { title: '', due: { date: '2026-10-16' }, rule: 'FREQ=WEEKLY;BYDAY=FR' }],
  [
    'курс каждый понедельник с 1 ноября до 1 декабря',
    { title: 'курс', due: { date: '2026-11-02' }, rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261201' },
  ],
  ['отчёт каждый последний день месяца', { title: 'отчёт', due: { date: '2026-10-31' }, rule: 'FREQ=MONTHLY;BYMONTHDAY=-1' }],
  // Дедлайн
  ['проект {пятница}', { title: 'проект', deadline: '2026-10-16' }],
  ['проект дедлайн 20 октября', { title: 'проект', deadline: '2026-10-20' }],
  // Приоритет, проект, раздел, метки
  ['!!! срочно разобраться', { title: 'срочно разобраться', priority: 1 }],
  ['задача п2', { title: 'задача', priority: 2 }],
  ['задача !3', { title: 'задача', priority: 3 }],
  [
    'сводка @срочно @звонок #Работа /Отчёты',
    { title: 'сводка', projectId: 'p-work', sectionId: 's-reports', labelIds: ['l-urgent', 'l-call'] },
  ],
  ['идея №Мой проект', { title: 'идея', projectId: 'p-my' }],
  ['идея #Новый @новая', { title: 'идея', projectId: null, newProject: 'Новый', newLabels: ['новая'] }],
  [
    'позвонить маме завтра в 19 №Дом каждую неделю !1',
    { title: 'позвонить маме', due: { date: '2026-10-14', time: '19:00' }, rule: 'FREQ=WEEKLY;BYDAY=WE', projectId: 'p-home', priority: 1 },
  ],
  // Английский
  ['call mom tomorrow at 7pm #Home p2', { title: 'call mom', due: { date: '2026-10-14', time: '19:00' }, projectId: 'p-home-en', priority: 2 }],
  ['pay rent every month', { title: 'pay rent', due: { date: '2026-10-13' }, rule: 'FREQ=MONTHLY;BYMONTHDAY=13' }],
  ['standup every weekday at 9:30am', { title: 'standup', due: { date: '2026-10-14', time: '09:30' }, rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }],
  ['review every other friday', { title: 'review', due: { date: '2026-10-16' }, rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR' }],
  ['water plants every! 3 days', { title: 'water plants', rule: 'FREQ=DAILY;INTERVAL=3', mode: 'completion' }],
  ['meeting next monday for 1h', { title: 'meeting', due: { date: '2026-10-19' }, duration: 60 }],
  ['dentist Nov 3 at 10', { title: 'dentist', due: { date: '2026-11-03', time: '10:00' } }],
  ['report in 2 weeks', { title: 'report', due: { date: '2026-10-27' } }],
  // Не должно распознаваться
  ['call Tom', { title: 'call Tom', due: null }],
  ['buy sun cream', { title: 'buy sun cream', due: null }],
  ['написать a@b.ru', { title: 'написать a@b.ru', labelIds: [], newLabels: [] }],
  ['прочитать 2026 год в книгах', { title: 'прочитать 2026 год в книгах', due: null }],
];

describe('корпус фраз', () => {
  for (const [input, want] of cases) {
    it(input, () => {
      const got = parseTask(input, ctx);
      const { rule, mode, ...rest } = want;
      expect(got).toMatchObject(rest);
      if (rule !== undefined) expect(got.recurrence?.rule ?? null).toBe(rule);
      if (mode !== undefined) expect(got.recurrence?.mode).toBe(mode);
    });
  }
});

describe('токены и игнорирование', () => {
  it('токены указывают на исходный текст', () => {
    const text = 'позвонить маме завтра в 19 №Дом !1';
    const got = parseTask(text, ctx);
    for (const t of got.tokens) expect(text.slice(t.start, t.end)).toBe(t.text);
    expect(got.tokens.map((t) => t.kind)).toEqual(['date', 'time', 'project', 'priority']);
  });

  it('участок из ignore остаётся в названии', () => {
    const text = 'купить завтра';
    const plain = parseTask(text, ctx);
    const tok = plain.tokens[0]!;
    const got = parseTask(text, { ...ctx, ignore: [[tok.start, tok.end]] });
    expect(got).toMatchObject({ title: 'купить завтра', due: null });
  });

  it('повтор хранит исходную фразу', () => {
    expect(parseTask('бассейн по понедельникам и средам в 8', ctx).recurrence?.text).toBe('по понедельникам и средам');
  });
});

describe('splitTaskList', () => {
  it('одна строка остаётся фразой', () => {
    expect(splitTaskList('купить хлеб завтра')).toBeNull();
    expect(splitTaskList('купить хлеб\n\n  \n')).toBeNull();
  });

  it('маркеры убираются, отмеченные пункты пропускаются, отступ даёт подзадачу', () => {
    const text = '- [ ] Ремонт #Дом\n  - [x] купить краску\n  - [ ] покрасить стену завтра\n1. Позвонить маме в 19\r\n\n* [X] старое\n• Отчёт !1';
    expect(splitTaskList(text)).toEqual([
      { text: 'Ремонт #Дом', depth: 0 },
      { text: 'покрасить стену завтра', depth: 1 },
      { text: 'Позвонить маме в 19', depth: 0 },
      { text: 'Отчёт !1', depth: 0 },
    ]);
  });

  it('общий отступ всего списка не делает подзадач', () => {
    expect(splitTaskList('    первая\n    вторая\n      третья')).toEqual([
      { text: 'первая', depth: 0 },
      { text: 'вторая', depth: 0 },
      { text: 'третья', depth: 1 },
    ]);
  });
});

describe('напоминания фразой', () => {
  const p = (text: string) => parseTask(text, ctx);
  it.each<[string, Partial<ParsedTask>]>([
    ['созвон завтра в 15 напомни за час', { title: 'созвон', due: { date: '2026-10-14', time: '15:00' }, reminders: [60] }],
    ['созвон завтра в 15 напомни за час и за 10 минут', { title: 'созвон', reminders: [60, 10] }],
    ['врач в пятницу в 10 напомнить за день', { title: 'врач', due: { date: '2026-10-16', time: '10:00' }, reminders: [1440] }],
    ['поезд завтра в 8 напомни за полчаса', { title: 'поезд', reminders: [30] }],
    ['полить цветы завтра напомни в 9 утра', { title: 'полить цветы', due: { date: '2026-10-14', time: '09:00' }, reminders: [0] }],
    ['встреча завтра в 15 напомни в 9', { title: 'встреча', due: { date: '2026-10-14', time: '15:00' }, reminders: [360] }],
    ['встреча завтра в 9 напомни в 20', { title: 'встреча', due: { date: '2026-10-14', time: '09:00' }, reminders: [780] }],
    ['купить хлеб завтра без напоминания', { title: 'купить хлеб', reminders: [] }],
    ['call mom tomorrow at 7pm remind me an hour before', { title: 'call mom', due: { date: '2026-10-14', time: '19:00' }, reminders: [60] }],
    ['standup tomorrow at 10 remind me at 9am', { title: 'standup', reminders: [60] }],
    ['напомни купить хлеб', { title: 'напомни купить хлеб', reminders: null }],
    ['заехать за 5 минут до встречи', { reminders: null }],
  ])('%s', (text, want) => {
    expect(p(text)).toMatchObject(want);
  });
});

describe('время словами (голосовой ввод)', () => {
  // Сейчас 12:00: время до полудня уходит на завтра, как и у цифр.
  const T = '2026-10-13';
  const M = '2026-10-14';
  const timed: Array<[string, string, string, string]> = [
    ['Купить молоко завтра в десять утра', 'Купить молоко', M, '10:00'],
    ['позвонить в десять', 'позвонить', M, '10:00'],
    ['ужин в семь вечера', 'ужин', T, '19:00'],
    ['встреча в два часа дня', 'встреча', T, '14:00'],
    ['обед в двенадцать', 'обед', M, '12:00'],
    ['сверка в пятнадцать часов', 'сверка', T, '15:00'],
    ['созвон завтра в десять тридцать', 'созвон', M, '10:30'],
    ['кино в половине восьмого вечера', 'кино', T, '19:30'],
    ['подъём в половине восьмого', 'подъём', M, '07:30'],
    ['обед в полдень', 'обед', M, '12:00'],
    ['выключить свет в полночь', 'выключить свет', M, '00:00'],
    ['планёрка завтра в девять ноль ноль', 'планёрка', M, '09:00'],
    ['поезд в восемь', 'поезд', M, '08:00'],
    ['поезд в восемнадцать', 'поезд', T, '18:00'],
    ['поезд в двадцать три', 'поезд', T, '23:00'],
    ['поезд в двадцать два сорок пять', 'поезд', T, '22:45'],
    ['обед в час', 'обед', T, '13:00'],
    ['таблетка в час ночи', 'таблетка', M, '01:00'],
    ['отбой в одиннадцать ночи', 'отбой', T, '23:00'],
    ['звонок в одиннадцать сорок пять', 'звонок', M, '11:45'],
    ['звонок в семь пятнадцать вечера', 'звонок', T, '19:15'],
    ['звонок в восемь двадцать', 'звонок', M, '08:20'],
    ['звонок в девять ноль пять', 'звонок', M, '09:05'],
    ['звонок в семь часов тридцать минут', 'звонок', M, '07:30'],
    ['зарядка в четверть восьмого', 'зарядка', M, '07:15'],
    ['call mom at ten', 'call mom', M, '10:00'],
    ['call mom at ten am', 'call mom', M, '10:00'],
    ['dinner at seven pm', 'dinner', T, '19:00'],
    ['dinner at seven thirty', 'dinner', M, '07:30'],
    ['dinner tomorrow at seven thirty p.m.', 'dinner', M, '19:30'],
    ['run at half past seven', 'run', M, '07:30'],
    ['lunch at noon', 'lunch', M, '12:00'],
    ['backup at midnight', 'backup', M, '00:00'],
    ['standup at nine o\'clock', 'standup', M, '09:00'],
    ['standup at nine oh five', 'standup', M, '09:05'],
    ['call at a quarter to eight in the evening', 'call', T, '19:45'],
  ];
  for (const [input, title, date, time] of timed) {
    it(input, () => {
      const got = parseTask(input, ctx);
      expect(got).toMatchObject({ title, due: { date, time } });
      // Подсветка: весь фрагмент времени — один токен, в названии от него ничего не остаётся.
      const tok = got.tokens.find((t) => t.kind === 'time')!;
      expect(input.slice(tok.start, tok.end)).toBe(tok.text);
    });
  }

  it('фрагмент времени подсвечивается целиком', () => {
    const got = parseTask('Купить молоко завтра в десять утра', ctx);
    expect(got.tokens.map((t) => [t.kind, t.text])).toEqual([
      ['date', 'завтра'],
      ['time', 'в десять утра'],
    ]);
  });

  it('напоминание словами', () => {
    expect(parseTask('полить цветы завтра напомни в девять утра', ctx)).toMatchObject({
      title: 'полить цветы',
      due: { date: '2026-10-14', time: '09:00' },
      reminders: [0],
    });
    expect(parseTask('water plants tomorrow remind me at seven pm', ctx)).toMatchObject({
      title: 'water plants',
      due: { date: '2026-10-14', time: '19:00' },
      reminders: [0],
    });
  });

  const plain: Array<[string, Partial<ParsedTask>]> = [
    ['купить десять яиц', { title: 'купить десять яиц', due: null }],
    ['семь раз отмерь', { title: 'семь раз отмерь', due: null }],
    ['вырасти в два раза', { title: 'вырасти в два раза', due: null }],
    ['уложиться в пять минут', { title: 'уложиться в пять минут', due: null }],
    ['сделать в один клик', { title: 'сделать в один клик', due: null }],
    ['at one point fix it', { title: 'at one point fix it', due: null }],
    ['buy ten eggs', { title: 'buy ten eggs', due: null }],
    ['через пять минут выключить', { title: 'выключить', due: { date: '2026-10-13', time: '12:05' } }],
    ['созвон завтра в 15 напомни за час', { title: 'созвон', reminders: [60] }],
    ['созвон завтра в 15 напомни за десять минут', { title: 'созвон', reminders: [10] }],
    ['полить цветы каждые два дня', { title: 'полить цветы', due: { date: '2026-10-13' } }],
  ];
  for (const [input, want] of plain) {
    it(input, () => expect(parseTask(input, ctx)).toMatchObject(want));
  }
});
