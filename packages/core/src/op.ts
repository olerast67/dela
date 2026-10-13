export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Новое значение одного поля одной записи. */
export interface Op {
  readonly table: string;
  readonly record: string;
  readonly field: string;
  readonly value: Json;
  readonly hlc: string;
}

/** Ячейка, к которой относится операция. На сервер уходит не она, а слот (HMAC от неё). */
export function cellKey(table: string, record: string, field: string): string {
  return `${table}\u0000${record}\u0000${field}`;
}

/** Правило слияния: побеждает большая метка. Равные метки означают ту же операцию. */
export function wins(incoming: string, current: string | undefined): boolean {
  return current === undefined || incoming > current;
}
