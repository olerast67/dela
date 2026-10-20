import { describe, expect, it } from 'vitest';
import { splitAlarms } from '../src/alarms.ts';

const r = (key: string, alarm?: boolean, taskId: string | null = 't-' + key) => ({ key, taskId, ...(alarm ? { alarm } : {}) });

describe('будильник или уведомление на Android', () => {
  it('срочные идут будильником, остальные уведомлением, без дублей', () => {
    const list = [r('a'), r('b', true), r('digest', true, null), r('c', true)];
    const { alarms, notifications } = splitAlarms(list, true);
    expect(alarms.map((x) => x.key)).toEqual(['b', 'c']);
    // Сводка без задачи не может быть будильником: нечего отмечать выполненной.
    expect(notifications.map((x) => x.key)).toEqual(['a', 'digest']);
  });

  it('без права на будильник срочные приходят обычным уведомлением', () => {
    const { alarms, notifications } = splitAlarms([r('a', true), r('b')], false);
    expect(alarms).toEqual([]);
    expect(notifications.map((x) => x.key)).toEqual(['a', 'b']);
  });

  it('сверх лимита будильников — уведомления', () => {
    const { alarms, notifications } = splitAlarms([r('a', true), r('b', true), r('c', true)], true, 2);
    expect(alarms.map((x) => x.key)).toEqual(['a', 'b']);
    expect(notifications.map((x) => x.key)).toEqual(['c']);
  });
});
