import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAME_SETTINGS,
  Doc,
  GARDEN_SPECIES,
  HybridClock,
  Workspace,
  computeGarden,
  gardenSpecies,
  gardenStage,
  type DoneEvent,
  type GameSettings,
  type GardenInput,
  type WorkEvent,
} from '../src/index.ts';

const TZ = 'Europe/Moscow';
const TODAY = '2026-10-21'; // среда
/** Момент в этот день по Москве: час, минуты. */
const at = (date: string, h = 12, m = 0) => Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`);
const done = (date: string, n: number, extra: Partial<DoneEvent> = {}): DoneEvent[] => Array.from({ length: n }, (_, i) => ({ at: at(date, 9, i), projectId: 'p', ...extra }));
const input = (patch: Partial<GardenInput> = {}, settings: Partial<GameSettings> = {}): GardenInput => ({
  events: [],
  work: [],
  settings: { ...DEFAULT_GAME_SETTINGS, ...settings },
  tz: TZ,
  today: TODAY,
  ...patch,
});
const day = (g: ReturnType<typeof computeGarden>, date: string) => g.weeks.flatMap((w) => w.days).find((d) => d.date === date)!;

describe('сад', () => {
  it('недели с понедельника, текущая первой, 12 по умолчанию', () => {
    const g = computeGarden(input());
    expect(g.weeks).toHaveLength(12);
    expect(g.weeks[0]!.start).toBe('2026-10-19');
    expect(g.weeks[1]!.start).toBe('2026-10-12');
    expect(g.weeks[0]!.days.map((d) => d.date)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(day(g, TODAY).today).toBe(true);
    expect(day(g, '2026-10-22').future).toBe(true);
    expect(computeGarden(input({ weeks: 24 })).weeks).toHaveLength(24);
  });

  it('размер растения от числа задач: росток, куст, дерево', () => {
    expect(gardenStage(0)).toEqual({ stage: 0, growth: 0 });
    expect(gardenStage(1)).toEqual({ stage: 1, growth: 0 });
    expect(gardenStage(2).stage).toBe(1);
    expect(gardenStage(3)).toEqual({ stage: 2, growth: 0 });
    expect(gardenStage(5).stage).toBe(2);
    expect(gardenStage(6)).toEqual({ stage: 3, growth: 0 });
    expect(gardenStage(12)).toEqual({ stage: 3, growth: 1 });
    expect(gardenStage(40)).toEqual({ stage: 3, growth: 1 });
    // Внутри стадии растение подрастает.
    expect(gardenStage(4).growth).toBeGreaterThan(gardenStage(3).growth);

    const g = computeGarden(input({ events: [...done('2026-10-19', 1), ...done('2026-10-20', 4), ...done(TODAY, 7)] }));
    expect(day(g, '2026-10-19').stage).toBe(1);
    expect(day(g, '2026-10-20').stage).toBe(2);
    expect(day(g, TODAY)).toMatchObject({ stage: 3, done: 7 });
    expect(g.plants).toBe(3);
  });

  it('пустой день: пустая земля, ничего не вянет', () => {
    const g = computeGarden(input({ events: done('2026-10-12', 3) }));
    const empty = day(g, '2026-10-13');
    expect(empty).toMatchObject({ done: 0, stage: 0, bloom: false, focus: 0, habits: 0 });
    // Растение позавчерашней недели осталось прежним, хотя потом задач не было.
    expect(day(g, '2026-10-12').stage).toBe(2);
  });

  it('цветение: только при выполненной цели дня и не в выходной', () => {
    const events = [...done('2026-10-19', 5), ...done('2026-10-20', 4), ...done('2026-10-18', 6)];
    const noGoal = computeGarden(input({ events }));
    expect(day(noGoal, '2026-10-19').bloom).toBe(false);
    const g = computeGarden(input({ events }, { dailyGoal: 5, restDays: [7] }));
    expect(day(g, '2026-10-19')).toMatchObject({ bloom: true, goal: 5 });
    expect(day(g, '2026-10-20')).toMatchObject({ bloom: false, goal: 5 });
    // Воскресенье — выходной: цели нет, цветения нет, растение есть.
    expect(day(g, '2026-10-18')).toMatchObject({ off: 'rest', goal: null, bloom: false, stage: 3 });
    const vac = computeGarden(input({ events }, { dailyGoal: 5, vacationFrom: '2026-10-19', vacationTo: '2026-10-19' }));
    expect(day(vac, '2026-10-19')).toMatchObject({ off: 'vacation', bloom: false });
  });

  it('привычки дня — ягоды', () => {
    const g = computeGarden(input({ events: [...done(TODAY, 2, { habit: true }), ...done(TODAY, 1)] }));
    expect(day(g, TODAY)).toMatchObject({ done: 3, habits: 2 });
  });

  it('помодоро: законченный отрезок — дерево фокуса, прерванный — росток, правка вручную — ничего', () => {
    const work: WorkEvent[] = [
      { at: at(TODAY, 10), minutes: 25, focus: 'full' },
      { at: at(TODAY, 11), minutes: 25, focus: 'full' },
      { at: at(TODAY, 12), minutes: 7, focus: 'cut' },
      { at: at(TODAY, 13), minutes: 90 },
    ];
    const g = computeGarden(input({ work }));
    expect(day(g, TODAY)).toMatchObject({ focus: 2, focusCut: 1, focusMinutes: 57, stage: 0 });
    expect(g.trees).toBe(2);
  });

  it('порода детерминирована датой и разная у соседних дней', () => {
    expect(gardenSpecies('2026-10-21')).toBe(gardenSpecies('2026-10-21'));
    const a = computeGarden(input({ events: done(TODAY, 3) }));
    const b = computeGarden(input({ events: done(TODAY, 3) }));
    expect(a).toEqual(b);
    // За 12 недель встречаются все породы.
    const kinds = new Set(a.weeks.flatMap((w) => w.days.map((d) => d.species)));
    expect(kinds.size).toBe(GARDEN_SPECIES.length);
    // Порода не зависит от данных дня.
    const c = computeGarden(input({ events: done(TODAY, 9) }));
    expect(day(c, TODAY).species).toBe(day(a, TODAY).species);
  });

  it('часовой пояс: выполнение в 01:30 по Москве — в этот день, а не во вчерашний по UTC', () => {
    const late = Date.parse('2026-10-20T22:30:00Z'); // 21 октября, 01:30 по Москве
    const g = computeGarden(input({ events: [{ at: late, projectId: 'p' }] }));
    expect(day(g, TODAY).done).toBe(1);
    expect(day(g, '2026-10-20').done).toBe(0);
    const utc = computeGarden(input({ events: [{ at: late, projectId: 'p' }], tz: 'UTC', today: '2026-10-20' }));
    expect(day(utc, '2026-10-20').done).toBe(1);
  });

  it('«показать ещё»: есть ли история раньше показанных недель', () => {
    expect(computeGarden(input({ events: done(TODAY, 1) })).older).toBe(false);
    const events = done('2026-06-01', 2);
    expect(computeGarden(input({ events })).older).toBe(true);
    expect(computeGarden(input({ events, weeks: 30 })).older).toBe(false);
    expect(day(computeGarden(input({ events, weeks: 30 })), '2026-06-01').stage).toBe(1);
  });

  it('Workspace: выполнения, привычки и отрезки таймера из данных', () => {
    let now = at(TODAY, 9);
    const ws = new Workspace(new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000eeef', clock: new HybridClock('a'.padStart(16, '0'), () => now), now: () => now, timeZone: TZ }));
    const habit = ws.createTask({ title: 'Зарядка', due: { date: TODAY }, recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' }, habit: { skipsPerWeek: 1 } });
    const a = ws.createTask({ title: 'a' });
    now += 60_000;
    ws.completeTask(habit);
    ws.completeTask(a);
    ws.logWork(a, 25, { id: '01929c3e-0000-7000-8000-0000000000a1', focus: 'full' });
    ws.logWork(a, 5, { id: '01929c3e-0000-7000-8000-0000000000a2', focus: 'cut' });
    ws.logWork(a, 30);
    const d = day(ws.garden(TZ, TODAY), TODAY);
    expect(d).toMatchObject({ done: 2, habits: 1, focus: 1, focusCut: 1, focusMinutes: 30, stage: 1 });
  });
});
