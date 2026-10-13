/**
 * Движок синхронизации одного пространства: отправляет очередь исходящих и забирает новое.
 * Хранилище на устройстве задаётся интерфейсом SyncStore: IndexedDB в браузере, SQLite на телефоне.
 */
import { ApiError, NetworkError, type ApiClient } from './client.ts';
import { DecryptError, openEnvelope, sealOp, type SpaceKeys } from './crypto.ts';
import type { Doc } from './doc.ts';
import { parseTimestamp } from './hlc.ts';
import { cellKey, wins, type Op } from './op.ts';

export interface OutboxEntry {
  readonly key: number;
  readonly op: Op;
}

export interface SyncStore {
  /** Все сохранённые ячейки пространства. */
  loadCells(spaceId: string): Promise<Op[]>;
  /** Сохранить локальные операции: в ячейки и в очередь исходящих. */
  saveLocal(spaceId: string, ops: readonly Op[]): Promise<void>;
  /** Сохранить полученные операции и курсор одной транзакцией. */
  saveRemote(spaceId: string, ops: readonly Op[], cursor: number): Promise<void>;
  outbox(spaceId: string, limit: number): Promise<OutboxEntry[]>;
  /** Удалить из очереди отправленные записи. */
  dropOutbox(spaceId: string, keys: readonly number[]): Promise<void>;
  /** Заменить записи очереди (переподписанные после сдвига часов). */
  replaceOutbox(spaceId: string, entries: readonly OutboxEntry[]): Promise<void>;
  cursor(spaceId: string): Promise<number>;
}

/** Хранилище в памяти: для тестов и как образец поведения. */
export class MemorySyncStore implements SyncStore {
  private readonly cells = new Map<string, Map<string, Op>>();
  private readonly queue = new Map<string, OutboxEntry[]>();
  private readonly cursors = new Map<string, number>();
  private nextKey = 1;

  private cellsOf(spaceId: string): Map<string, Op> {
    let m = this.cells.get(spaceId);
    if (!m) this.cells.set(spaceId, (m = new Map()));
    return m;
  }

  private put(spaceId: string, ops: readonly Op[]): void {
    const m = this.cellsOf(spaceId);
    for (const op of ops) {
      const k = cellKey(op.table, op.record, op.field);
      if (wins(op.hlc, m.get(k)?.hlc)) m.set(k, op);
    }
  }

  async loadCells(spaceId: string): Promise<Op[]> {
    return [...this.cellsOf(spaceId).values()];
  }

  async saveLocal(spaceId: string, ops: readonly Op[]): Promise<void> {
    this.put(spaceId, ops);
    const q = this.queue.get(spaceId) ?? [];
    for (const op of ops) q.push({ key: this.nextKey++, op });
    this.queue.set(spaceId, q);
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

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  readonly state: SyncState;
  readonly pending: number;
  readonly lastSyncedAt: number | null;
  readonly error: string | null;
}

export interface SyncEngineOptions {
  readonly api: ApiClient;
  readonly store: SyncStore;
  readonly doc: Doc;
  readonly spaceId: string;
  readonly keys: SpaceKeys;
  /** Версия ключа пространства, с которой шифруется отправка. */
  readonly keyVersion?: number;
  /** Сервер ответил, что ключ пространства сменился: приложение берёт новый ключ и пересоздаёт движок. */
  readonly onKeyRotated?: () => void;
  /** Сервер сообщил своё время (при расхождении часов): приложение обновляет поправку часов. */
  readonly onServerTime?: (serverTime: number) => void;
  /** Переподписать операцию новой меткой после исправления часов. */
  readonly restamp?: () => string;
  readonly onStatus?: (status: SyncStatus) => void;
  /** Сессия больше не действует (устройство отозвано). */
  readonly onUnauthorized?: () => void;
  readonly batchSize?: number;
}

const BATCH = 500;

export class SyncEngine {
  private readonly o: SyncEngineOptions;
  private running: Promise<void> | null = null;
  private again = false;
  private status: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null };
  /** Сколько конвертов не удалось расшифровать (испорченные или чужие). */
  skipped = 0;

  constructor(options: SyncEngineOptions) {
    this.o = options;
  }

  get current(): SyncStatus {
    return this.status;
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.o.onStatus?.(this.status);
  }

  /** Синхронизировать сейчас. Повторный вызов во время работы ставит ещё один проход. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.once();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async once(): Promise<void> {
    this.setStatus({ state: 'syncing' });
    try {
      await this.pushAll();
      await this.pullAll();
      const pending = (await this.o.store.outbox(this.o.spaceId, 1)).length;
      this.setStatus({ state: 'idle', pending, lastSyncedAt: Date.now(), error: null });
    } catch (err) {
      if (err instanceof NetworkError) {
        this.setStatus({ state: 'offline', error: null });
        return;
      }
      if (err instanceof ApiError && err.status === 401) this.o.onUnauthorized?.();
      this.setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async pushAll(): Promise<void> {
    const { api, store, spaceId, keys } = this.o;
    const size = this.o.batchSize ?? BATCH;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const batch = await store.outbox(spaceId, size);
      if (batch.length === 0) return;
      try {
        await api.push(
          spaceId,
          batch.map((e) => sealOp(spaceId, keys, e.op)),
          this.o.keyVersion ?? 1,
        );
      } catch (err) {
        if (err instanceof ApiError && err.code === 'key_rotated') {
          // Очередь остаётся: после смены ключа те же операции уйдут зашифрованными новым ключом.
          this.o.onKeyRotated?.();
          throw err;
        }
        if (err instanceof ApiError && err.code === 'clock_drift' && typeof err.body.serverTime === 'number') {
          await this.fixClock(batch, err.body.serverTime);
          continue;
        }
        throw err;
      }
      await store.dropOutbox(
        spaceId,
        batch.map((e) => e.key),
      );
    }
  }

  /** Часы устройства спешили: исправить поправку и переподписать операции из будущего. */
  private async fixClock(batch: readonly OutboxEntry[], serverTime: number): Promise<void> {
    const { onServerTime, restamp, store, spaceId, doc } = this.o;
    if (!onServerTime || !restamp) throw new Error('clock drift and no way to fix it');
    onServerTime(serverTime);
    const future = batch.filter((e) => parseTimestamp(e.op.hlc).wall > serverTime + 30_000);
    const fixed = future.map((e) => ({ key: e.key, op: { ...e.op, hlc: restamp() } }));
    for (const e of fixed) doc.replica.force(e.op);
    await store.replaceOutbox(spaceId, fixed);
  }

  private async pullAll(): Promise<void> {
    const { api, store, spaceId, keys, doc } = this.o;
    let cursor = await store.cursor(spaceId);
    for (;;) {
      const page = await api.pull(spaceId, cursor, BATCH);
      const ops: Op[] = [];
      for (const env of page.envelopes) {
        try {
          ops.push(openEnvelope(spaceId, keys, env));
        } catch (err) {
          if (!(err instanceof DecryptError)) throw err;
          this.skipped++;
        }
      }
      doc.applyRemote(ops);
      await store.saveRemote(spaceId, ops, page.cursor);
      cursor = page.cursor;
      if (!page.more) return;
    }
  }
}

/**
 * Сохранять локальные изменения документа в хранилище и запускать синхронизацию.
 * Очередь исходящих живёт в хранилище, поэтому из памяти документа операции сразу убираются.
 */
export function persistLocal(doc: Doc, store: SyncStore, spaceId: string, afterSave?: () => void): () => void {
  return doc.subscribe((ops, origin) => {
    if (origin !== 'local') return;
    void store.saveLocal(spaceId, ops).then(() => {
      doc.acknowledge(ops);
      afterSave?.();
    });
  });
}
