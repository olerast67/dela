import { describe, expect, it } from 'vitest';
import { Doc, FilterSyntaxError, HybridClock, parseFilter, runFilter } from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 13, 9, 0);
const TODAY = '2026-10-13';
const TZ = 'Europe/Moscow';

function setup() {
  const doc = new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000dddd', clock: new HybridClock('00000000000000aa', () => NOW), now: () => NOW, timeZone: TZ });
  const work = doc.createProject({ name: 'Работа' });
  const reports = doc.createProject({ name: 'Отчёты', parentId: work });
  const home = doc.createProject({ name: 'Дом' });
  const sec = doc.createSection(work, 'Сейчас');
  const waiting = doc.createLabel('ждёт');
  const call = doc.createLabel('звонок');
  doc.createTask({ title: 'Просроченный отчёт', projectId: reports, due: { date: '2026-10-10' }, priority: 1 });
  doc.createTask({ title: 'Сегодняшний звонок', projectId: work, sectionId: sec, due: { date: TODAY }, labels: [call] });
  const parent = doc.createTask({ title: 'Ждём ответа', projectId: work, due: { date: '2026-10-15' }, labels: [waiting], priority: 2 });
  doc.createTask({ title: 'Подзадача', parentId: parent });
  doc.createTask({ title: 'Купить молоко', projectId: home });
  doc.createTask({
    title: 'Зарядка',
    projectId: home,
    due: { date: TODAY, time: '07:00' },
    recurrence: { rule: 'FREQ=DAILY', mode: 'schedule', text: 'каждый день' },
  });
  doc.createTask({ title: 'Во входящих', due: { date: '2026-10-25' } });
  return doc;
}

const titles = (doc: Doc, q: string) => runFilter(doc, q, TODAY, TZ).tasks.map((t) => t.title);

describe('фильтры', () => {
  const doc = setup();

  it('синтаксис Todoist', () => {
    expect(titles(doc, '(today | overdue) & p1')).toEqual(['Просроченный отчёт']);
    expect(titles(doc, 'today | overdue')).toEqual(['Просроченный отчёт', 'Зарядка', 'Сегодняшний звонок']);
    expect(titles(doc, '#Работа')).toEqual(['Сегодняшний звонок', 'Ждём ответа', 'Подзадача']);
    expect(titles(doc, '##Работа & !subtask')).toEqual(['Просроченный отчёт', 'Сегодняшний звонок', 'Ждём ответа']);
    expect(titles(doc, '#Работа & !@ждёт & !subtask')).toEqual(['Сегодняшний звонок']);
    expect(titles(doc, '@звон*')).toEqual(['Сегодняшний звонок']);
    expect(titles(doc, '/Сейчас')).toEqual(['Сегодняшний звонок']);
    expect(titles(doc, 'no date & !subtask')).toEqual(['Купить молоко']);
    expect(titles(doc, 'recurring')).toEqual(['Зарядка']);
    expect(titles(doc, '7 days')).toEqual(['Зарядка', 'Сегодняшний звонок', 'Ждём ответа']);
    expect(titles(doc, 'due before: Oct 15')).toEqual(['Просроченный отчёт', 'Зарядка', 'Сегодняшний звонок']);
    expect(titles(doc, 'search: молоко')).toEqual(['Купить молоко']);
    expect(titles(doc, '#Inbox')).toEqual(['Во входящих']);
    expect(titles(doc, 'p2, p1')).toEqual(['Просроченный отчёт', 'Ждём ответа']);
  });

  it('русские синонимы', () => {
    expect(titles(doc, 'сегодня | просрочено')).toEqual(titles(doc, 'today | overdue'));
    expect(titles(doc, 'следующие 7 дней & !повторяющиеся')).toEqual(['Сегодняшний звонок', 'Ждём ответа']);
    expect(titles(doc, 'поиск: МОЛОКО')).toEqual(['Купить молоко']);
    expect(titles(doc, 'до: четверг')).toEqual(['Просроченный отчёт', 'Зарядка', 'Сегодняшний звонок']);
    expect(titles(doc, 'п1 | п2')).toEqual(['Просроченный отчёт', 'Ждём ответа']);
    expect(titles(doc, '#Входящие')).toEqual(['Во входящих']);
    expect(titles(doc, 'пятница')).toEqual([]);
    expect(titles(doc, '15 октября')).toEqual(['Ждём ответа']);
  });

  it('неизвестные условия возвращаются, синтаксические ошибки выбрасываются', () => {
    expect(runFilter(doc, 'today | assigned to: me', TODAY, TZ).unknown).toEqual(['assigned to: me']);
    expect(() => parseFilter('(today | p1')).toThrow(FilterSyntaxError);
    expect(() => parseFilter('today &')).toThrow(FilterSyntaxError);
    expect(() => parseFilter('')).toThrow(FilterSyntaxError);
  });
});
