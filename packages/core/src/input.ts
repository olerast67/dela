/**
 * Настройки ввода задач: одна запись input/settings в личном пространстве, отдельно от игровых.
 *
 * Как и у игровых настроек, каждое поле — своя ячейка LWW, запись шифруется вместе с остальными
 * операциями пространства. Нет записи или поле испорчено — значение по умолчанию.
 */
import type { Json } from './op.ts';

export const INPUT_TABLE = 'input';
export const INPUT_RECORD = 'settings';

export interface InputSettings {
  /** Разбирать текст быстрого добавления: срок, время, проект, метки, приоритет, повтор, напоминания. */
  readonly parse: boolean;
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = Object.freeze({
  parse: true,
});

/** Поле настроек → ячейка записи. */
const FIELDS: Record<keyof InputSettings, string> = {
  parse: 'parse',
};

/** Все поля пока флажки. */
const valid = (v: unknown): v is boolean => typeof v === 'boolean';

/** Настройки из записи; испорченное или отсутствующее поле — значение по умолчанию. */
export function readInputSettings(rec: Readonly<Record<string, Json>> | undefined): InputSettings {
  if (!rec) return DEFAULT_INPUT_SETTINGS;
  const out: Record<string, unknown> = { ...DEFAULT_INPUT_SETTINGS };
  for (const key of Object.keys(FIELDS) as Array<keyof InputSettings>) {
    const v = rec[FIELDS[key]];
    if (v !== undefined && valid(v)) out[key] = v;
  }
  return out as unknown as InputSettings;
}

/** Изменения записи для правки настроек. Неверное значение — исключение: в данные оно не попадает. */
export function inputSettingsChanges(patch: Partial<InputSettings>): Array<readonly [string, string, string, Json]> {
  const out: Array<readonly [string, string, string, Json]> = [];
  for (const key of Object.keys(patch) as Array<keyof InputSettings>) {
    if (!(key in FIELDS)) throw new RangeError(`unknown input setting: ${key}`);
    const v = patch[key];
    if (v === undefined) continue;
    if (!valid(v)) throw new RangeError(`bad value for ${key}`);
    out.push([INPUT_TABLE, INPUT_RECORD, FIELDS[key], v]);
  }
  return out;
}
