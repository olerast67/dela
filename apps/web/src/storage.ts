/**
 * Хранилище на устройстве в IndexedDB: ячейки, очередь исходящих, курсоры и сессия.
 *
 * Ключи аккаунта и пространства лежат зашифрованными ключом AES-GCM, который создан
 * неизвлекаемым (extractable: false): скопировав файлы браузера, ключи не достать.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { cellKey, wins, type Op, type OutboxEntry, type SyncStore } from '#core';

interface Schema extends DBSchema {
  cells: { key: [string, string]; value: { space: string; key: string; op: Op } };
  outbox: { key: number; value: { space: string; op: Op }; indexes: { space: string } };
  meta: { key: string; value: unknown };
}

const DB_NAME = 'dela';

export class IdbStore implements SyncStore {
  private readonly db: Promise<IDBPDatabase<Schema>>;

  constructor(name = DB_NAME) {
    this.db = openDB<Schema>(name, 1, {
      upgrade(db) {
        db.createObjectStore('cells', { keyPath: ['space', 'key'] });
        db.createObjectStore('outbox', { autoIncrement: true }).createIndex('space', 'space');
        db.createObjectStore('meta');
      },
    });
  }

  async loadCells(spaceId: string): Promise<Op[]> {
    const db = await this.db;
    const range = IDBKeyRange.bound([spaceId, ''], [spaceId, '￿']);
    return (await db.getAll('cells', range)).map((c) => c.op);
  }

  private async putCells(ops: readonly Op[], spaceId: string, tx: { objectStore(name: 'cells'): any }): Promise<void> {
    const store = tx.objectStore('cells');
    for (const op of ops) {
      const key = cellKey(op.table, op.record, op.field);
      const existing = (await store.get([spaceId, key])) as { op: Op } | undefined;
      if (wins(op.hlc, existing?.op.hlc)) await store.put({ space: spaceId, key, op });
    }
  }

  async saveLocal(spaceId: string, ops: readonly Op[]): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['cells', 'outbox'], 'readwrite');
    await this.putCells(ops, spaceId, tx);
    for (const op of ops) await tx.objectStore('outbox').add({ space: spaceId, op });
    await tx.done;
  }

  async saveRemote(spaceId: string, ops: readonly Op[], cursor: number): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['cells', 'meta'], 'readwrite');
    await this.putCells(ops, spaceId, tx);
    await tx.objectStore('meta').put(cursor, `cursor:${spaceId}`);
    await tx.done;
  }

  async outbox(spaceId: string, limit: number): Promise<OutboxEntry[]> {
    const db = await this.db;
    const out: OutboxEntry[] = [];
    let cursor = await db.transaction('outbox').store.index('space').openCursor(spaceId);
    while (cursor && out.length < limit) {
      out.push({ key: cursor.primaryKey, op: cursor.value.op });
      cursor = await cursor.continue();
    }
    return out;
  }

  async dropOutbox(_spaceId: string, keys: readonly number[]): Promise<void> {
    const db = await this.db;
    const tx = db.transaction('outbox', 'readwrite');
    for (const k of keys) await tx.store.delete(k);
    await tx.done;
  }

  async replaceOutbox(spaceId: string, entries: readonly OutboxEntry[]): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['cells', 'outbox'], 'readwrite');
    for (const e of entries) {
      await tx.objectStore('outbox').put({ space: spaceId, op: e.op }, e.key);
      // Метка новой записи меньше старой (та была из будущего): перезаписываем без сравнения.
      await tx.objectStore('cells').put({ space: spaceId, key: cellKey(e.op.table, e.op.record, e.op.field), op: e.op });
    }
    await tx.done;
  }

  async cursor(spaceId: string): Promise<number> {
    const db = await this.db;
    return ((await db.get('meta', `cursor:${spaceId}`)) as number | undefined) ?? 0;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await (await this.db).get('meta', key)) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await (await this.db).put('meta', value, key);
  }

  /** Стереть данные одного пространства (например, после исключения из общего проекта). */
  async clearSpace(spaceId: string): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['cells', 'outbox', 'meta'], 'readwrite');
    await tx.objectStore('cells').delete(IDBKeyRange.bound([spaceId, ''], [spaceId, '\uffff']));
    let cursor = await tx.objectStore('outbox').index('space').openCursor(spaceId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.objectStore('meta').delete(`cursor:${spaceId}`);
    await tx.done;
  }

  /** Стереть всё: при выходе из аккаунта. */
  async clear(): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(['cells', 'outbox', 'meta'], 'readwrite');
    await Promise.all([tx.objectStore('cells').clear(), tx.objectStore('outbox').clear(), tx.objectStore('meta').clear()]);
    await tx.done;
  }
}

// ---------- ключи на устройстве ----------

async function deviceKey(store: IdbStore): Promise<CryptoKey> {
  const existing = await store.getMeta<CryptoKey>('deviceKey');
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await store.setMeta('deviceKey', key);
  return key;
}

export async function sealLocal(store: IdbStore, data: unknown): Promise<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }> {
  const key = await deviceKey(store);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(data));
  return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain) };
}

export async function openLocal<T>(store: IdbStore, sealed: { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }): Promise<T> {
  const key = await deviceKey(store);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Зашифровать ключом устройства в одну строку base64 (iv ‖ шифротекст): для push-напоминаний. */
export async function sealLocalB64(store: IdbStore, data: unknown): Promise<string> {
  const { iv, data: ct } = await sealLocal(store, data);
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  let s = '';
  for (const b of out) s += String.fromCharCode(b);
  return btoa(s);
}
