/**
 * Хранилище синхронизации в памяти, которое целиком сохраняется в файл сессии (вместо IndexedDB браузера).
 * Ведёт себя как MemorySyncStore ядра; dump() и конструктор переводят его в JSON и обратно.
 */
import { cellKey, wins, type Op, type OutboxEntry, type SyncStore } from '../../core/src/index.ts';

export interface StoreData {
  readonly cells: Record<string, Op[]>;
  readonly outbox: Record<string, OutboxEntry[]>;
  readonly cursors: Record<string, number>;
  readonly nextKey: number;
}

export class FileSyncStore implements SyncStore {
  private readonly cells = new Map<string, Map<string, Op>>();
  private readonly queue = new Map<string, OutboxEntry[]>();
  private readonly cursors = new Map<string, number>();
  private nextKey = 1;

  constructor(data?: StoreData) {
    if (!data) return;
    for (const [space, ops] of Object.entries(data.cells)) this.put(space, ops);
    for (const [space, q] of Object.entries(data.outbox)) this.queue.set(space, [...q]);
    for (const [space, c] of Object.entries(data.cursors)) this.cursors.set(space, c);
    this.nextKey = data.nextKey;
  }

  dump(): StoreData {
    return {
      cells: Object.fromEntries([...this.cells].map(([s, m]) => [s, [...m.values()]])),
      outbox: Object.fromEntries([...this.queue].filter(([, q]) => q.length > 0)),
      cursors: Object.fromEntries(this.cursors),
      nextKey: this.nextKey,
    };
  }

  private cellsOf(spaceId: string): Map<string, Op> {
    let m = this.cells.get(spaceId);
    if (!m) this.cells.set(spaceId, (m = new Map()));
    return m;
  }

  private put(spaceId: string, ops: readonly Op[]): void {
    const m = this.cellsOf(spaceId);
    for (const op of ops) {
      const key = cellKey(op.table, op.record, op.field);
      if (wins(op.hlc, m.get(key)?.hlc)) m.set(key, op);
    }
  }

  cellsSync(spaceId: string): Op[] {
    return [...(this.cells.get(spaceId)?.values() ?? [])];
  }

  /** Сохранить локальные операции сразу, без ожидания: следующая синхронизация их уже видит. */
  saveLocalSync(spaceId: string, ops: readonly Op[]): void {
    this.put(spaceId, ops);
    const q = this.queue.get(spaceId) ?? [];
    for (const op of ops) q.push({ key: this.nextKey++, op });
    this.queue.set(spaceId, q);
  }

  pendingCount(): number {
    let n = 0;
    for (const q of this.queue.values()) n += q.length;
    return n;
  }

  /** Пространство пропало (исключили из общего проекта): его данные больше не нужны. */
  clearSpace(spaceId: string): void {
    this.cells.delete(spaceId);
    this.queue.delete(spaceId);
    this.cursors.delete(spaceId);
  }

  async loadCells(spaceId: string): Promise<Op[]> {
    return this.cellsSync(spaceId);
  }

  async saveLocal(spaceId: string, ops: readonly Op[]): Promise<void> {
    this.saveLocalSync(spaceId, ops);
  }

  async saveRemote(spaceId: string, ops: readonly Op[], cursor: number): Promise<void> {
    this.put(spaceId, ops);
    this.cursors.set(spaceId, cursor);
  }

  async outbox(spaceId: string, limit: number): Promise<OutboxEntry[]> {
    return (this.queue.get(spaceId) ?? []).slice(0, limit);
  }

  async dropOutbox(spaceId: string, keys: readonly number[]): Promise<void> {
    const drop = new Set(keys);
    this.queue.set(spaceId, (this.queue.get(spaceId) ?? []).filter((e) => !drop.has(e.key)));
  }

  async replaceOutbox(spaceId: string, entries: readonly OutboxEntry[]): Promise<void> {
    const byKey = new Map(entries.map((e) => [e.key, e]));
    this.queue.set(
      spaceId,
      (this.queue.get(spaceId) ?? []).map((e) => byKey.get(e.key) ?? e),
    );
    // Новая метка меньше старой (та была из будущего), поэтому ячейка перезаписывается без сравнения.
    const m = this.cellsOf(spaceId);
    for (const e of entries) m.set(cellKey(e.op.table, e.op.record, e.op.field), e.op);
  }

  async cursor(spaceId: string): Promise<number> {
    return this.cursors.get(spaceId) ?? 0;
  }
}
