export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Новое значение одного поля одной записи. */
export interface Op {
  readonly table: string;
  readonly record: string;
  readonly field: string;
  readonly value: Json;
  readonly hlc: string;
}

/**
 * Ячейка, к которой относится операция. На сервер уходит не она, а слот (хеш с ключом от неё).
 * JSON-массив однозначен: никакое имя с разделителями внутри не совпадёт с другой ячейкой.
 */
export function cellKey(table: string, record: string, field: string): string {
  return JSON.stringify([table, record, field]);
}

/** Правило слияния: побеждает большая метка. Равные метки означают ту же операцию. */
export function wins(incoming: string, current: string | undefined): boolean {
  return current === undefined || incoming > current;
}
