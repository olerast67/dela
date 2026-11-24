import { describe, expect, it } from 'vitest';
import { widgetListTarget } from '../src/widgetList.ts';

const inbox = 'space-1';
const today = '2026-10-22';

describe('быстрое добавление с виджета Android', () => {
  it('«Сегодня»: экран «Сегодня», срок на сегодня', () => {
    expect(widgetListTarget('today', inbox, today)).toEqual({ hash: '#/today', defaults: { due: { date: today } } });
  });

  it('«Неделя»: экран «Предстоящие», без срока', () => {
    expect(widgetListTarget('week', inbox, today)).toEqual({ hash: '#/upcoming', defaults: {} });
  });

  it('проект: его экран, задача в него', () => {
    expect(widgetListTarget('project:p1', inbox, today)).toEqual({ hash: '#/project/p1', defaults: { projectId: 'p1' } });
    expect(widgetListTarget('project:a/b', inbox, today)?.hash).toBe('#/project/a%2Fb');
  });

  it('Входящие: и проектом, и отдельным списком маленького виджета', () => {
    const target = { hash: '#/inbox', defaults: { projectId: inbox } };
    expect(widgetListTarget(`project:${inbox}`, inbox, today)).toEqual(target);
    expect(widgetListTarget('inbox', inbox, today)).toEqual(target);
  });

  it('без списка или с непонятным списком — как раньше', () => {
    expect(widgetListTarget(undefined, inbox, today)).toBeNull();
    expect(widgetListTarget('', inbox, today)).toBeNull();
    expect(widgetListTarget('project:', inbox, today)).toBeNull();
    expect(widgetListTarget('label:x', inbox, today)).toBeNull();
  });
});

describe('проект виджета удалён', () => {
  it('задача уходит во «Входящие»', () => {
    expect(widgetListTarget('project:gone', 'inbox-1', '2026-10-22', () => false)).toEqual({ hash: '#/inbox', defaults: { projectId: 'inbox-1' } });
  });
});

describe('режим «План»', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 22, h, m);
  it('время после последнего дела, но не раньше «сейчас»', () => {
    expect(widgetListTarget('plan@11:30', inbox, today, undefined, at(9, 2))).toEqual({ hash: '#/today', defaults: { due: { date: today, time: '11:30' } } });
    expect(widgetListTarget('plan@08:00', inbox, today, undefined, at(9, 2))?.defaults.due).toEqual({ date: today, time: '09:05' });
    expect(widgetListTarget('plan', inbox, today, undefined, at(9, 0))?.defaults.due).toEqual({ date: today, time: '09:00' });
  });
  it('после 23:55 без времени', () => {
    expect(widgetListTarget('plan', inbox, today, undefined, at(23, 58))?.defaults.due).toEqual({ date: today });
  });
});
