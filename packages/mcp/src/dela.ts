/**
 * Клиент Dela без браузера: вход, ключи, документы пространств и синхронизация, как в apps/web/src/controller.ts.
 * Сессия и кэш лежат в зашифрованном файле (vault.ts) вместо IndexedDB.
 */
import { hostname, platform } from 'node:os';
import {
  ApiClient,
  ApiError,
  Doc,
  HybridClock,
  NetworkError,
  SyncEngine,
  Workspace,
  ensurePersonalSpace,
  fingerprint,
  fromB64,
  initCrypto,
  isBoxedSpaceKey,
  newNodeId,
  openBoxedSpaceKey,
  signIn,
  spaceKeyOf,
  spaceKeys,
  toB64,
  type AccountKeys,
  type Fetcher,
  type SpaceInfo,
} from '../../core/src/index.ts';
import { FileSyncStore, type StoreData } from './store.ts';
import type { Vault } from './vault.ts';

export interface SavedSession {
  readonly v: 1;
  readonly server: string;
  readonly email: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly spaceId: string;
  readonly keys: { readonly masterKey: string; readonly publicKey: string; readonly secretKey: string; readonly spaceKey: string };
  /** Ключи общих пространств: нужны, чтобы работать с кэшем без сети. */
  readonly shared: ReadonlyArray<{ readonly id: string; readonly key: string; readonly role: string; readonly v: number }>;
  readonly store?: StoreData;
  readonly hlc?: string;
  readonly clockOffset?: number;
}

/** Устройство отозвано в настройках Dela или сессия закрыта сервером. */
export class SessionRevokedError extends Error {
  constructor() {
    super('This device was signed out of Dela. Run `npx dela-mcp login` again.');
    this.name = 'SessionRevokedError';
  }
}

export class NotLoggedInError extends Error {
  constructor() {
    super('Not signed in to Dela. Run `npx dela-mcp login` in a terminal first.');
    this.name = 'NotLoggedInError';
  }
}

/** Имя устройства в списке устройств Dela: по нему его узнают и отзывают. */
export function deviceName(): string {
  const os = platform() === 'win32' ? 'Windows' : platform() === 'darwin' ? 'macOS' : platform() === 'linux' ? 'Linux' : platform();
  const host = hostname().slice(0, 40);
  return host ? `Dela MCP · ${os} · ${host}` : `Dela MCP · ${os}`;
}

/** Адрес сервера: без схемы считается https, хвостовые / убираются. */
export function normalizeServer(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  if (!s) throw new Error('Server address is empty.');
  const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Войти паролем (и кодом TOTP) и сохранить сессию нового устройства в файл. */
export async function login(
  vault: Vault,
  input: { server: string; email: string; password: string; totp?: string; fetcher?: Fetcher; deviceName?: string },
): Promise<SavedSession> {
  await initCrypto();
  const server = normalizeServer(input.server);
  const api = new ApiClient(server, input.fetcher);
  const session = await signIn(api, {
    email: input.email,
    password: input.password,
    deviceName: input.deviceName ?? deviceName(),
    ...(input.totp ? { totp: input.totp } : {}),
  });
  const { spaceId, spaceKey } = await ensurePersonalSpace(api, session.keys);
  const saved: SavedSession = {
    v: 1,
    server,
    email: session.email,
    userId: session.userId,
    deviceId: session.deviceId,
    token: session.token,
    spaceId,
    keys: {
      masterKey: toB64(session.keys.masterKey),
      publicKey: toB64(session.keys.publicKey),
      secretKey: toB64(session.keys.secretKey),
      spaceKey: toB64(spaceKey),
    },
    shared: [],
  };
  // Прежняя сессия на этом компьютере закрывается: одно устройство в списке, а не по одному на каждый вход.
  if (vault.exists()) await revokeSaved(vault, input.fetcher);
  vault.write(saved);
  return saved;
}

/** Отозвать сохранённое устройство на сервере (если получится) и стереть файл. */
async function revokeSaved(vault: Vault, fetcher?: Fetcher): Promise<boolean> {
  let revoked = false;
  try {
    const old = vault.read<SavedSession>();
    const api = new ApiClient(old.server, fetcher);
    api.token = old.token;
    await api.logout();
    revoked = true;
  } catch {
    // сервер недоступен или сессия уже закрыта
  }
  vault.remove();
  return revoked;
}

export type Role = 'owner' | 'editor' | 'viewer';

export interface SyncReport {
  /** Сервер недоступен: ответ собран из кэша, изменения уйдут при следующей связи. */
  readonly offline: boolean;
  /** Сколько изменений ещё не отправлено. */
  readonly pending: number;
}

export class Dela {
  readonly ws: Workspace;
  readonly api: ApiClient;
  private saved: SavedSession;
  private readonly vault: Vault;
  private readonly store: FileSyncStore;
  private readonly clock: HybridClock;
  private clockOffset: number;
  private readonly engines = new Map<string, SyncEngine>();
  private readonly detach = new Map<string, () => void>();
  private readonly keyById = new Map<string, { key: Uint8Array; v: number }>();
  private readonly roles = new Map<string, Role>();
  private unauthorized = false;
  /** Сессия закрыта (отозвана или выход): объект больше не используется. */
  closed = false;
  /** Поколение файла сессии, которое записал или прочитал этот объект. */
  private generation = 0;
  private rotated = false;
  private readonly log: (msg: string) => void;

  private constructor(vault: Vault, saved: SavedSession, fetcher: Fetcher | undefined, log: (msg: string) => void) {
    this.vault = vault;
    this.saved = saved;
    this.log = log;
    this.api = new ApiClient(saved.server, fetcher);
    this.api.token = saved.token;
    this.store = new FileSyncStore(saved.store);
    this.generation = vault.generation;
    this.clockOffset = saved.clockOffset ?? 0;
    const now = () => Date.now() + this.clockOffset;
    // Свой узел часов на каждый запуск: два процесса с одним файлом сессии не выдадут одинаковых меток.
    this.clock = new HybridClock(newNodeId(), now, saved.hlc);
    const personal = new Doc({ spaceId: saved.spaceId, clock: this.clock, now });
    personal.load(this.store.cellsSync(saved.spaceId));
    this.ws = new Workspace(personal);
    this.ws.setActor(saved.userId);
    this.attach(personal, fromB64(saved.keys.spaceKey), 1);
    for (const sp of saved.shared) {
      const doc = new Doc({ spaceId: sp.id, clock: this.clock, now, kind: 'shared' });
      doc.load(this.store.cellsSync(sp.id));
      this.roles.set(sp.id, sp.role as Role);
      this.attach(doc, fromB64(sp.key), sp.v);
      this.ws.addShared(doc);
    }
  }

  /** Открыть сохранённую сессию. */
  static async open(vault: Vault, options: { fetcher?: Fetcher; log?: (msg: string) => void } = {}): Promise<Dela> {
    await initCrypto();
    if (!vault.exists()) throw new NotLoggedInError();
    const saved = vault.read<SavedSession>();
    return new Dela(vault, saved, options.fetcher, options.log ?? ((m) => process.stderr.write(`${m}\n`)));
  }

  get email(): string {
    return this.saved.email;
  }

  get server(): string {
    return this.saved.server;
  }

  get userId(): string {
    return this.saved.userId;
  }

  /** Роль в проекте: личные проекты свои, в общих — как выдал владелец. */
  role(projectId: string): Role {
    return this.ws.isShared(projectId) ? (this.roles.get(projectId) ?? 'viewer') : 'owner';
  }

  private accountKeys(): AccountKeys {
    const k = this.saved.keys;
    return { masterKey: fromB64(k.masterKey), publicKey: fromB64(k.publicKey), secretKey: fromB64(k.secretKey) };
  }

  /** Подключить пространство: движок синхронизации и запись локальных изменений в очередь. */
  private attach(doc: Doc, key: Uint8Array, keyVersion: number): void {
    const spaceId = doc.spaceId;
    this.keyById.set(spaceId, { key, v: keyVersion });
    const engine = new SyncEngine({
      api: this.api,
      store: this.store,
      doc,
      spaceId,
      keys: spaceKeys(key),
      keyVersion,
      onKeyRotated: () => (this.rotated = true),
      onServerTime: (serverTime) => {
        this.clockOffset = serverTime - Date.now();
        this.clock.rewind();
      },
      restamp: () => this.clock.tick(),
      onUnauthorized: () => (this.unauthorized = true),
    });
    this.engines.set(spaceId, engine);
    const stop = doc.subscribe((ops, origin) => {
      if (origin !== 'local') return;
      this.store.saveLocalSync(spaceId, ops);
      doc.acknowledge(ops);
    });
    this.detach.set(spaceId, () => {
      stop();
      this.engines.delete(spaceId);
      this.keyById.delete(spaceId);
    });
  }

  private rekey(doc: Doc, key: Uint8Array, keyVersion: number): void {
    this.detach.get(doc.spaceId)?.();
    this.detach.delete(doc.spaceId);
    this.attach(doc, key, keyVersion);
  }

  /** Закреплённый ключ (запись в личном пространстве, общая для всех устройств пользователя). */
  private pin(id: string): string | undefined {
    const v = this.ws.personal.replica.get('pin', id)?.public_key;
    return typeof v === 'string' ? v : undefined;
  }

  /**
   * Открыть ключ общего пространства так же, как веб-клиент: ключ от владельца закрепляется при первом
   * получении, ключ от другого отправителя не принимается.
   */
  private openSpaceKey(sp: SpaceInfo, keys: AccountKeys): Uint8Array {
    if (sp.keyKind === 'wrapped') return spaceKeyOf(sp, keys);
    const version = sp.keyVersion ?? 1;
    if (!isBoxedSpaceKey(sp.key)) {
      if (version > 1) throw new Error('unsigned_space_key');
      return spaceKeyOf(sp, keys);
    }
    const { key, sender } = openBoxedSpaceKey(sp.key, sp.id, version, keys);
    const senderB64 = toB64(sender);
    const pinned = this.pin(`${sp.id}:owner`);
    if (pinned === undefined) this.ws.personal.write([['pin', `${sp.id}:owner`, 'public_key', senderB64]], { undoable: false });
    else if (pinned !== senderB64) {
      this.log(`dela-mcp: shared project ${sp.id} skipped: its key came from an unknown sender (${fingerprint(sender)}). Check it in the Dela app.`);
      throw new Error('space_key_sender_changed');
    }
    return key;
  }

  /** Сверить общие пространства с сервером: новые подключить, сменившие ключ переключить, исчезнувшие убрать. */
  private async refreshSpaces(): Promise<void> {
    const spaces = (await this.api.spaces()).spaces;
    const keys = this.accountKeys();
    const now = () => Date.now() + this.clockOffset;
    const current = new Set(spaces.filter((s) => s.kind === 'shared').map((s) => s.id));
    for (const sp of spaces) {
      if (sp.kind !== 'shared') continue;
      this.roles.set(sp.id, sp.role);
      const existing = this.ws.sharedDoc(sp.id);
      if (existing) {
        if ((sp.keyVersion ?? 1) !== this.keyById.get(sp.id)?.v) {
          try {
            this.rekey(existing, this.openSpaceKey(sp, keys), sp.keyVersion ?? 1);
          } catch {
            // ключ не открылся: остаётся прежний движок
          }
        }
        continue;
      }
      let key: Uint8Array;
      try {
        key = this.openSpaceKey(sp, keys);
      } catch {
        continue;
      }
      const doc = new Doc({ spaceId: sp.id, clock: this.clock, now, kind: 'shared' });
      doc.load(this.store.cellsSync(sp.id));
      this.attach(doc, key, sp.keyVersion ?? 1);
      this.ws.addShared(doc);
    }
    for (const doc of this.ws.docs()) {
      if (doc.kind !== 'shared' || current.has(doc.spaceId)) continue;
      this.detach.get(doc.spaceId)?.();
      this.detach.delete(doc.spaceId);
      this.ws.removeShared(doc.spaceId);
      this.store.clearSpace(doc.spaceId);
    }
  }

  /** Отправить своё и забрать новое по всем пространствам; сохранить кэш. */
  async sync(): Promise<SyncReport> {
    let offline = false;
    try {
      for (let round = 0; round < 3; round++) {
        this.rotated = false;
        try {
          await this.refreshSpaces();
        } catch (err) {
          if (err instanceof NetworkError) {
            offline = true;
            break;
          }
          throw err;
        }
        for (const engine of [...this.engines.values()]) {
          try {
            await engine.sync();
          } catch (err) {
            // Ключ общего проекта сменился: новый берётся на следующем круге, очередь остаётся.
            if (err instanceof ApiError && err.code === 'key_rotated') continue;
            throw err;
          }
          if (engine.current.state === 'offline') offline = true;
        }
        if (!this.rotated || offline) break;
      }
    } catch (err) {
      if (this.unauthorized || (err instanceof ApiError && err.status === 401)) {
        // Устройство отозвано: расшифрованный кэш на диске больше не нужен (если файл не заменён новым входом).
        if (!this.stale) this.vault.remove();
        this.closed = true;
        throw new SessionRevokedError();
      }
      this.save();
      throw err;
    }
    // Личные «Входящие» создаются, только когда сервер уже прочитан: иначе вход перезаписал бы чужую запись.
    if (!offline) this.ws.personal.ensureInbox();
    this.save();
    return { offline, pending: this.store.pendingCount() };
  }

  /** Записать сессию и кэш в файл. */
  save(): void {
    // Файл заменил новый вход или другой процесс: старая сессия его не перезаписывает.
    if (this.closed || this.stale) return;
    const shared = this.ws
      .docs()
      .filter((d) => d.kind === 'shared')
      .map((d) => ({ id: d.spaceId, key: toB64(this.keyById.get(d.spaceId)!.key), role: this.roles.get(d.spaceId) ?? 'viewer', v: this.keyById.get(d.spaceId)!.v }));
    this.saved = { ...this.saved, shared, store: this.store.dump(), hlc: this.clock.current(), clockOffset: this.clockOffset };
    this.vault.write(this.saved);
    this.generation = this.vault.generation;
  }

  /** Файл сессии переписан после этого объекта (новый вход, выход или другой процесс): нужно открыть заново. */
  get stale(): boolean {
    return this.closed || this.vault.generation !== this.generation || this.vault.changedOutside();
  }

  /** Выйти: отправить оставшееся, отозвать устройство на сервере, стереть файл. Возвращает, удалось ли отозвать. */
  async logout(): Promise<boolean> {
    for (const engine of this.engines.values()) {
      try {
        await engine.sync();
      } catch {
        // нет сети или сессия уже закрыта
      }
    }
    let revoked = false;
    try {
      await this.api.logout();
      revoked = true;
    } catch (err) {
      revoked = err instanceof ApiError && err.status === 401;
    }
    this.closed = true;
    this.vault.remove();
    return revoked;
  }
}

/** Выйти без открытия документов: файл может не расшифроваться (например, другой пользователь Windows). */
export async function logout(vault: Vault, fetcher?: Fetcher): Promise<{ hadSession: boolean; revoked: boolean }> {
  if (!vault.exists()) return { hadSession: false, revoked: false };
  try {
    const dela = await Dela.open(vault, fetcher ? { fetcher } : {});
    return { hadSession: true, revoked: await dela.logout() };
  } catch {
    return { hadSession: true, revoked: await revokeSaved(vault, fetcher) };
  }
}
