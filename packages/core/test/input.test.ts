import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_SETTINGS, Doc, HybridClock, Workspace, initCrypto, newKey, sealOp, spaceKeys, type Op } from '../src/index.ts';

const TZ = 'Europe/Moscow';
const START = Date.UTC(2026, 9, 1, 9, 0);
const LATER = '999999999999999-0000-00000000000000ff';

function doc(node = 'aa', now: () => number = () => START) {
  return new Doc({ spaceId: '01929c3e-0000-7000-8000-00000000eeee', clock: new HybridClock(node.padStart(16, '0'), now), now, timeZone: TZ });
}

describe('настройки ввода задач', () => {
  it('по умолчанию распознавание включено, чтение ничего не пишет', () => {
    const d = doc();
    expect(d.getInputSettings()).toEqual(DEFAULT_INPUT_SETTINGS);
    expect(DEFAULT_INPUT_SETTINGS).toEqual({ parse: true });
    expect(d.pending()).toEqual([]);
  });

  it('правка пишет одну ячейку своей записи, не трогает игровые и не попадает в отмену', () => {
    const ws = new Workspace(doc());
    ws.updateInputSettings({ parse: false });
    expect(ws.getInputSettings().parse).toBe(false);
    expect(ws.personal.pending().map((o) => [o.table, o.record, o.field, o.value])).toEqual([['input', 'settings', 'parse', false]]);
    expect(ws.canUndo).toBe(false);
    ws.updateInputSettings({ parse: false });
    expect(ws.personal.pending()).toHaveLength(1);
    ws.updateInputSettings({ parse: true });
    expect(ws.getInputSettings().parse).toBe(true);
    expect(ws.getGameSettings().enabled).toBe(true);
  });

  it('неверные значения не записываются', () => {
    const d = doc();
    for (const patch of [{ parse: 'no' }, { parse: 0 }, { nonsense: true }]) expect(() => d.updateInputSettings(patch as never), JSON.stringify(patch)).toThrow(RangeError);
    expect(d.pending()).toEqual([]);
  });

  it('испорченное значение с другого устройства читается как умолчание', () => {
    const d = doc();
    d.applyRemote([{ table: 'input', record: 'settings', field: 'parse', value: 'off' as never, hlc: LATER }]);
    expect(d.getInputSettings()).toEqual(DEFAULT_INPUT_SETTINGS);
  });

  it('выключатель доходит до другого устройства, побеждает поздняя правка', () => {
    let t = START;
    const a = doc('aa', () => t);
    const b = doc('bb', () => t);
    a.updateInputSettings({ parse: false });
    b.applyRemote(a.pending());
    expect(b.getInputSettings().parse).toBe(false);
    t += 1000;
    b.updateInputSettings({ parse: true });
    a.applyRemote(b.pending());
    for (const d of [a, b]) expect(d.getInputSettings().parse).toBe(true);
  });

  it('на сервер уходит только шифротекст', async () => {
    await initCrypto();
    const keys = spaceKeys(newKey());
    const d = doc();
    const ops: Op[] = [];
    d.subscribe((o) => ops.push(...o));
    d.updateInputSettings({ parse: false });
    expect(ops).toHaveLength(1);
    const env = JSON.stringify(ops.map((op) => sealOp('space-1', keys, op)));
    expect(env).not.toMatch(/input|parse/);
  });
});
