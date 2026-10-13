import { cellKey, wins, type Json, type Op } from './op.ts';

interface Cell {
  readonly value: Json;
  readonly hlc: string;
}

/**
 * Эталонная реплика в памяти: правила слияния без хранилища.
 * Хранилище на SQLite обязано вести себя так же; тесты гоняют обе реализации.
 */
export class MemoryReplica {
  private readonly cells = new Map<string, Cell>();
  private readonly records = new Map<string, Map<string, Record<string, Json>>>();

  /** Применить операцию. Возвращает true, если значение ячейки изменилось. */
  apply(op: Op): boolean {
    const key = cellKey(op.table, op.record, op.field);
    if (!wins(op.hlc, this.cells.get(key)?.hlc)) return false;
    this.cells.set(key, { value: op.value, hlc: op.hlc });
    let table = this.records.get(op.table);
    if (!table) {
      table = new Map();
      this.records.set(op.table, table);
    }
    let rec = table.get(op.record);
    if (!rec) {
      rec = {};
      table.set(op.record, rec);
    }
    rec[op.field] = op.value;
    return true;
  }

  /** Записать ячейку без сравнения меток: только для переподписи своих операций после сдвига часов. */
  force(op: Op): void {
    const key = cellKey(op.table, op.record, op.field);
    const had = this.cells.get(key);
    this.cells.delete(key);
    if (!this.apply(op) && had) this.cells.set(key, had);
  }

  /** Метка последней записи в ячейку. */
  hlcOf(table: string, record: string, field: string): string | undefined {
    return this.cells.get(cellKey(table, record, field))?.hlc;
  }

  /** Все ячейки как операции: для сохранения состояния на устройстве. */
  *ops(): IterableIterator<Op> {
    for (const [key, c] of this.cells) {
      const [table, record, field] = JSON.parse(key) as [string, string, string];
      yield { table, record, field, value: c.value, hlc: c.hlc };
    }
  }

  get(table: string, record: string): Readonly<Record<string, Json>> | undefined {
    return this.records.get(table)?.get(record);
  }

  /** Все записи таблицы. */
  all(table: string): ReadonlyMap<string, Readonly<Record<string, Json>>> {
    return this.records.get(table) ?? new Map();
  }

  /** Состояние всех ячеек в детерминированном порядке, для сравнения реплик в тестах. */
  dump(): Array<[string, Json, string]> {
    return [...this.cells.entries()]
      .map(([k, c]): [string, Json, string] => [k, c.value, c.hlc])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}
