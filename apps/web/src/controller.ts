/**
 * Состояние приложения: сессия, документ, синхронизация, связь между вкладками.
 *
 * Синхронизирует одна вкладка (держит Web Lock «dela-leader»), остальные получают изменения
 * через BroadcastChannel. Очередь исходящих общая — в IndexedDB.
 */
import {
  applyPinAttempt,
  widgetSnapshot,
  hashPin,
  isValidPin,
  lockAfterBackground,
  verifyPin,
  type LockConfig,
  type PinResult,
  ApiClient,
  ApiError,
  Doc,
  HybridClock,
  NetworkError,
  SyncEngine,
  changeAccountPassword,
  deleteAccountOnServer,
  rotateSpaceKey,
  ensurePersonalSpace,
  fingerprint,
  fromB64,
  newKey,
  sealSpaceKeyFor,
  spaceKeyOf,
  uuidv7,
  wrapSpaceKey,
  Workspace,
  type AccountKeys,
  type SpaceInfo,
  initCrypto,
  newNodeId,
  persistLocal,
  recoverAccount,
  welcomeTasks,
  remindersBetween,
  type Reminder,
  signIn,
  signUp,
  spaceKeys,
  toB64,
  type Op,
  type Session,
  type SyncStatus,
} from '#core';
import { IdbStore, openLocal, sealLocal, sealLocalB64 } from './storage.ts';
import { TZ } from './format.ts';
import { biometryUnlock, nativeNotify, onAppPauseResume, onWidgetCompleted, serverUrl, syncNativeReminders, takeWidgetCompleted, updateWidget } from './platform.ts';

function loadFired(): string[] {
  try {
    return JSON.parse(localStorage.getItem('firedReminders') ?? '[]') as string[];
  } catch {
    return [];
  }
}

function saveFired(fired: Set<string>): void {
  try {
    // Хватает последних 500: старые напоминания в окно поиска уже не попадут.
    localStorage.setItem('firedReminders', JSON.stringify([...fired].slice(-500)));
  } catch {
    // без localStorage повторный показ после перезагрузки возможен, это не страшно
  }
}

export type Phase = 'loading' | 'auth' | 'recovery' | 'ready';

export interface AppState {
  readonly phase: Phase;
  readonly email: string | null;
  readonly isAdmin: boolean;
  readonly status: SyncStatus;
  readonly recoveryKey: string | null;
  readonly notice: string | null;
  /** Экран закрыт PIN-кодом. */
  readonly locked: boolean;
  /** PIN-код задан на этом устройстве. */
  readonly lockEnabled: boolean;
}

interface StoredSession {
  readonly token: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly email: string;
  readonly isAdmin: boolean;
  readonly spaceId: string;
  readonly node: string;
  readonly sealed: { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };
}

interface SecretKeys {
  readonly masterKey: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly spaceKey: string;
  /** Ключи общих пространств: нужны, чтобы открыть приложение без сети. */
  readonly shared?: ReadonlyArray<{ readonly id: string; readonly key: string; readonly role: string; readonly v?: number }>;
}

type ChannelMessage = { type: 'ops'; space: string; ops: Op[] } | { type: 'sync' } | { type: 'logout' } | { type: 'spaces' };

const IDLE: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null };

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'устройство';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  return `${browser} · ${os}`;
}

export class Controller {
  readonly store = new IdbStore();
  readonly api = new ApiClient(serverUrl());
  doc: Workspace | null = null;
  private readonly engines = new Map<string, SyncEngine>();
  private readonly spaceKeyById = new Map<string, Uint8Array>();
  private readonly roles = new Map<string, string>();
  private stored: StoredSession | null = null;
  private secrets: SecretKeys | null = null;
  private clock: HybridClock | null = null;
  private clockOffset = 0;
  private state: AppState = { phase: 'loading', email: null, isAdmin: false, status: IDLE, recoveryKey: null, notice: null, locked: false, lockEnabled: false };
  private readonly listeners = new Set<() => void>();
  private docVersion = 0;
  private readonly docListeners = new Set<() => void>();
  private readonly channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dela') : null;
  private leader = false;
  private fromChannel = false;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private wsTimer: ReturnType<typeof setTimeout> | undefined;
  private stopFns: Array<() => void> = [];
  private reminderTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly fired = new Set<string>(loadFired());
  /** Показать напоминание внутри приложения (уведомление в интерфейсе). */
  onReminder: ((r: Reminder) => void) | null = null;

  // ---------- подписки для React ----------

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getDocVersion = (): number => this.docVersion;

  subscribeDoc = (fn: () => void): (() => void) => {
    this.docListeners.add(fn);
    return () => this.docListeners.delete(fn);
  };

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---------- запуск ----------

  async init(): Promise<void> {
    await initCrypto();
    this.channel?.addEventListener('message', (e: MessageEvent<ChannelMessage>) => this.onChannel(e.data));
    this.clockOffset = (await this.store.getMeta<number>('clockOffset')) ?? 0;
    const stored = await this.store.getMeta<StoredSession>('session');
    if (!stored) {
      this.set({ phase: 'auth' });
      return;
    }
    this.lock = (await this.store.getMeta<LockConfig>('lock')) ?? null;
    // Приложение открывается закрытым: задачи загружаются и синхронизируются, но экран ждёт PIN.
    if (this.lock) this.set({ locked: true, lockEnabled: true });
    this.watchBackground();
    try {
      const secrets = await openLocal<SecretKeys>(this.store, stored.sealed);
      await this.start(stored, secrets);
    } catch (err) {
      console.error('cannot restore session', err);
      await this.store.clear();
      this.set({ phase: 'auth', notice: 'Не удалось открыть сохранённую сессию. Войдите снова.' });
    }
  }

  async register(email: string, password: string, invite?: string): Promise<void> {
    const { session, recoveryKey } = await signUp(this.api, {
      email,
      password,
      deviceName: deviceName(),
      ...(invite ? { invite } : {}),
    });
    await this.persistAndStart(session);
    // Новый аккаунт начинается с нескольких задач: первая — подписаться на автора проекта.
    for (const t of welcomeTasks(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()))) this.doc?.createTask(t);
    this.set({ phase: 'recovery', recoveryKey });
  }

  async login(email: string, password: string, totp?: string): Promise<void> {
    const session = await signIn(this.api, { email, password, deviceName: deviceName(), ...(totp ? { totp } : {}) });
    await this.persistAndStart(session);
  }

  /** Забыт пароль: вход по ключу восстановления с новым паролем. */
  async recover(email: string, recoveryKey: string, newPassword: string): Promise<void> {
    const session = await recoverAccount(this.api, { email, recoveryKey, newPassword, deviceName: deviceName() });
    await this.persistAndStart(session);
  }

  /** Удалить аккаунт: сервер стирает аккаунт и личные задачи, устройство выходит и стирает свои данные. */
  async deleteAccount(password: string, totp?: string): Promise<void> {
    // Перед удалением отправляем изменения общих проектов: они остаются у других участников.
    for (const engine of this.engines.values()) {
      try {
        await engine.sync();
      } catch {
        // нет сети: удаление ниже тоже не пройдёт
      }
    }
    await deleteAccountOnServer(this.api, { password, ...(totp ? { totp } : {}) });
    await this.logout('Аккаунт удалён.');
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await changeAccountPassword(this.api, { currentPassword, newPassword });
  }

  /** Пользователь подтвердил, что сохранил ключ восстановления. */
  confirmRecovery(): void {
    this.set({ phase: 'ready', recoveryKey: null });
  }

  private async persistAndStart(session: Session): Promise<void> {
    const { spaceId, spaceKey } = await ensurePersonalSpace(this.api, session.keys);
    const secrets: SecretKeys = {
      masterKey: toB64(session.keys.masterKey),
      publicKey: toB64(session.keys.publicKey),
      secretKey: toB64(session.keys.secretKey),
      spaceKey: toB64(spaceKey),
    };
    const stored: StoredSession = {
      token: session.token,
      userId: session.userId,
      deviceId: session.deviceId,
      email: session.email,
      isAdmin: session.isAdmin,
      spaceId,
      node: newNodeId(),
      sealed: await sealLocal(this.store, secrets),
    };
    await this.store.setMeta('session', stored);
    await this.start(stored, secrets);
  }

  private async start(stored: StoredSession, secrets: SecretKeys): Promise<void> {
    this.api.token = stored.token;
    this.stored = stored;
    this.secrets = secrets;
    const now = () => Date.now() + this.clockOffset;
    const lastHlc = await this.store.getMeta<string>('hlc');
    this.clock = new HybridClock(stored.node, now, lastHlc);
    const doc = new Doc({ spaceId: stored.spaceId, clock: this.clock, now });
    doc.load(await this.store.loadCells(stored.spaceId));
    const ws = new Workspace(doc);
    this.doc = ws;
    this.attach(doc, fromB64(secrets.spaceKey));
    for (const sp of secrets.shared ?? []) {
      const shared = new Doc({ spaceId: sp.id, clock: this.clock, now, kind: 'shared' });
      shared.load(await this.store.loadCells(sp.id));
      this.roles.set(sp.id, sp.role);
      this.attach(shared, fromB64(sp.key), sp.v ?? 1);
      ws.addShared(shared);
    }

    this.stopFns.push(
      ws.subscribe((ops) => {
        this.docVersion++;
        this.scheduleRemindersSoon();
        for (const fn of this.docListeners) fn();
      }),
    );

    doc.ensureInbox();
    void this.refreshSpaces();
    this.docVersion++;
    this.set({ phase: this.state.phase === 'recovery' ? 'recovery' : 'ready', email: stored.email, isAdmin: stored.isAdmin, notice: null });
    void this.applyWidgetCompleted();
    if (!this.widgetListening) {
      this.widgetListening = true;
      void onWidgetCompleted(() => void this.applyWidgetCompleted());
    }
    this.becomeLeaderWhenPossible();
  }

  /** Подключить пространство: движок синхронизации, сохранение и пересылка изменений между вкладками. */
  private attach(doc: Doc, key: Uint8Array, keyVersion = 1): void {
    const spaceId = doc.spaceId;
    this.spaceKeyById.set(spaceId, key);
    this.keyVersionById.set(spaceId, keyVersion);
    const engine = new SyncEngine({
      api: this.api,
      store: this.store,
      doc,
      spaceId,
      keys: spaceKeys(key),
      keyVersion,
      onKeyRotated: () => void this.refreshSpaces(),
      onServerTime: (serverTime) => {
        this.clockOffset = serverTime - Date.now();
        void this.store.setMeta('clockOffset', this.clockOffset);
        this.clock?.rewind();
      },
      restamp: () => this.clock!.tick(),
      onStatus: () => this.updateStatus(),
      onUnauthorized: () => void this.logout('Сессия на этом устройстве завершена. Войдите снова.'),
    });
    this.engines.set(spaceId, engine);
    const stopPersist = persistLocal(doc, this.store, spaceId, () => {
      void this.store.setMeta('hlc', this.clock!.current());
      // Сразу показываем, что есть неотправленное: точное число придёт после синхронизации.
      this.set({ status: { ...this.state.status, pending: this.state.status.pending + 1 } });
      this.requestSync();
    });
    const stopForward = doc.subscribe((ops) => {
      // Изменения из этой вкладки (свои и полученные с сервера) пересылаем остальным вкладкам.
      if (!this.fromChannel && ops.length > 0) this.channel?.postMessage({ type: 'ops', space: spaceId, ops: [...ops] } satisfies ChannelMessage);
    });
    this.detachFns.set(spaceId, () => {
      stopPersist();
      stopForward();
      this.engines.delete(spaceId);
      this.spaceKeyById.delete(spaceId);
      this.keyVersionById.delete(spaceId);
    });
  }

  private readonly detachFns = new Map<string, () => void>();
  private readonly keyVersionById = new Map<string, number>();

  /** Пересоздать движок пространства с новым ключом: документ и очередь исходящих остаются. */
  private rekey(doc: Doc, key: Uint8Array, keyVersion: number): void {
    this.detachFns.get(doc.spaceId)?.();
    this.detachFns.delete(doc.spaceId);
    this.attach(doc, key, keyVersion);
  }

  /** Общий статус: худшее из состояний движков. */
  private updateStatus(): void {
    const all = [...this.engines.values()].map((e) => e.current);
    const rank = { error: 3, offline: 2, syncing: 1, idle: 0 } as const;
    const worst = all.reduce((a, b) => (rank[b.state] > rank[a.state] ? b : a), all[0] ?? IDLE);
    const lastSyncedAt = Math.max(0, ...all.map((x) => x.lastSyncedAt ?? 0)) || null;
    this.set({ status: { state: worst.state, pending: all.reduce((n, x) => n + x.pending, 0), lastSyncedAt, error: worst.error } });
  }

  /** Сверить общие пространства с сервером: новые подключить, исчезнувшие (исключили) убрать. */
  async refreshSpaces(): Promise<void> {
    const ws = this.doc;
    if (!ws || !this.secrets || !this.stored) return;
    let spaces: SpaceInfo[];
    try {
      spaces = (await this.api.spaces()).spaces;
    } catch {
      return;
    }
    const keys = this.accountKeys();
    const now = () => Date.now() + this.clockOffset;
    const current = new Set(spaces.filter((x) => x.kind === 'shared').map((x) => x.id));
    for (const sp of spaces) {
      if (sp.kind !== 'shared') continue;
      this.roles.set(sp.id, sp.role);
      const existing = ws.sharedDoc(sp.id);
      if (existing) {
        // Владелец сменил ключ (кого-то удалили из проекта): берём новый и шифруем им дальше.
        if ((sp.keyVersion ?? 1) !== this.keyVersionById.get(sp.id)) {
          try {
            this.rekey(existing, spaceKeyOf(sp, keys), sp.keyVersion ?? 1);
          } catch {
            // ключ не открылся: оставляем прежний движок
          }
        }
        continue;
      }
      let key: Uint8Array;
      try {
        key = spaceKeyOf(sp, keys);
      } catch {
        continue;
      }
      const doc = new Doc({ spaceId: sp.id, clock: this.clock!, now, kind: 'shared' });
      doc.load(await this.store.loadCells(sp.id));
      this.attach(doc, key, sp.keyVersion ?? 1);
      ws.addShared(doc);
    }
    for (const doc of ws.docs()) {
      if (doc.kind !== 'shared' || current.has(doc.spaceId)) continue;
      this.detachFns.get(doc.spaceId)?.();
      this.detachFns.delete(doc.spaceId);
      ws.removeShared(doc.spaceId);
      await this.store.clearSpace(doc.spaceId);
    }
    await this.saveSecrets();
    this.docVersion++;
    for (const fn of this.docListeners) fn();
    if (this.leader) void this.syncNow();
  }

  private accountKeys(): AccountKeys {
    const s = this.secrets!;
    return { masterKey: fromB64(s.masterKey), publicKey: fromB64(s.publicKey), secretKey: fromB64(s.secretKey) };
  }

  private async saveSecrets(): Promise<void> {
    if (!this.secrets || !this.stored || !this.doc) return;
    const shared = this.doc
      .docs()
      .filter((d) => d.kind === 'shared')
      .map((d) => ({
        id: d.spaceId,
        key: toB64(this.spaceKeyById.get(d.spaceId)!),
        role: this.roles.get(d.spaceId) ?? 'editor',
        v: this.keyVersionById.get(d.spaceId) ?? 1,
      }));
    this.secrets = { ...this.secrets, shared };
    this.stored = { ...this.stored, sealed: await sealLocal(this.store, this.secrets) };
    await this.store.setMeta('session', this.stored);
  }

  // ---------- общие проекты ----------

  roleIn(projectId: string): string {
    return this.roles.get(projectId) ?? 'owner';
  }

  /** Сделать личный проект общим. Возвращает id общего проекта. */
  async shareProject(projectId: string): Promise<string> {
    const ws = this.doc!;
    const spaceId = uuidv7();
    const key = newKey();
    await this.api.createSpace(spaceId, wrapSpaceKey(key, this.accountKeys().masterKey, spaceId), 'shared');
    const now = () => Date.now() + this.clockOffset;
    const doc = new Doc({ spaceId, clock: this.clock!, now, kind: 'shared' });
    this.roles.set(spaceId, 'owner');
    this.attach(doc, key);
    ws.shareProject(projectId, doc);
    await this.saveSecrets();
    this.requestSync();
    return spaceId;
  }

  members(spaceId: string) {
    return this.api.spaceMembers(spaceId);
  }

  /** Пригласить по адресу: ключ пространства запечатывается открытым ключом участника. Возвращает отпечаток его ключа. */
  async addMember(spaceId: string, email: string, role: 'editor' | 'viewer'): Promise<string> {
    const { userId, publicKey } = await this.api.userPublicKey(email);
    const key = this.spaceKeyById.get(spaceId);
    if (!key) throw new Error('unknown space');
    await this.api.addMember(spaceId, { userId, role, key: sealSpaceKeyFor(key, spaceId, fromB64(publicKey)) });
    return fingerprint(fromB64(publicKey));
  }

  async removeMember(spaceId: string, userId: string): Promise<void> {
    await this.api.removeMember(spaceId, userId);
    if (userId === this.stored?.userId) await this.refreshSpaces();
    else await this.rotateKey(spaceId);
  }

  /**
   * Новый ключ общего проекта после удаления участника: удалённый сохраняет то, что уже видел,
   * но новых изменений прочитать не сможет. Если кто-то успел отправить правку, догружаем и пробуем снова.
   */
  async rotateKey(spaceId: string): Promise<void> {
    const ws = this.doc;
    const doc = ws?.sharedDoc(spaceId);
    const engine = this.engines.get(spaceId);
    if (!doc || !engine || !this.stored) throw new Error('unknown space');
    for (let attempt = 0; attempt < 5; attempt++) {
      await engine.sync();
      const info = (await this.api.spaces()).spaces.find((s) => s.id === spaceId);
      if (!info) throw new Error('unknown space');
      try {
        const { key, keyVersion } = await rotateSpaceKey(this.api, {
          spaceId,
          ops: doc.replica.ops(),
          ownerId: this.stored.userId,
          masterKey: this.accountKeys().masterKey,
          keyVersion: info.keyVersion ?? 1,
          baseSeq: info.lastSeq,
        });
        this.rekey(doc, key, keyVersion);
        await this.saveSecrets();
        this.requestSync();
        return;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'stale') continue;
        throw err;
      }
    }
    throw new Error('rotation_busy');
  }

  get userId(): string | null {
    return this.stored?.userId ?? null;
  }

  // ---------- синхронизация ----------

  private becomeLeaderWhenPossible(): void {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    const lead = () => {
      this.leader = true;
      this.scheduleReminders();
      this.schedulePushSoon();
      this.connectWs();
      void this.syncNow();
      const interval = setInterval(() => void this.syncNow(), 60_000);
      const online = () => {
        // Сеть вернулась: переподключаемся сразу, не дожидаясь паузы между попытками.
        this.wsRetry = 0;
        clearTimeout(this.wsTimer);
        if (!this.ws) this.connectWs();
        void this.syncNow();
      };
      const visible = () => document.visibilityState === 'visible' && void this.syncNow();
      window.addEventListener('online', online);
      document.addEventListener('visibilitychange', visible);
      this.stopFns.push(() => {
        clearInterval(interval);
        window.removeEventListener('online', online);
        document.removeEventListener('visibilitychange', visible);
      });
    };
    if (!locks) {
      lead();
      return;
    }
    void locks.request('dela-leader', () => {
      lead();
      // Держим блокировку, пока вкладка открыта.
      return new Promise<void>((resolve) => this.stopFns.push(resolve));
    });
  }

  requestSync(): void {
    if (!this.leader) {
      this.channel?.postMessage({ type: 'sync' } satisfies ChannelMessage);
      return;
    }
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.syncNow(), 300);
  }

  async syncNow(): Promise<void> {
    if (!this.leader) return;
    for (const engine of [...this.engines.values()]) {
      try {
        await engine.sync();
      } catch (err) {
        if (!(err instanceof NetworkError) && !(err instanceof ApiError && err.status === 401)) console.error(err);
      }
    }
  }

  private connectWs(): void {
    if (!this.leader || !this.api.token || typeof WebSocket === 'undefined') return;
    const ws = new WebSocket(this.api.wsUrl());
    this.ws = ws;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: this.api.token })));
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type?: string };
        if (msg.type === 'ready') {
          this.wsRetry = 0;
          // Пока соединения не было, сигналы могли потеряться: забираем всё пропущенное.
          this.requestSync();
        }
        if (msg.type === 'changed') this.requestSync();
        if (msg.type === 'spaces') {
          void this.refreshSpaces();
          this.channel?.postMessage({ type: 'spaces' } satisfies ChannelMessage);
        }
      } catch {
        // не JSON — игнорируем
      }
    });
    ws.addEventListener('close', (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4001) {
        void this.logout('Сессия на этом устройстве завершена. Войдите снова.');
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** this.wsRetry++);
      clearTimeout(this.wsTimer);
      this.wsTimer = setTimeout(() => this.connectWs(), delay);
    });
  }

  private onChannel(msg: ChannelMessage): void {
    if (msg.type === 'ops' && this.doc) {
      const doc = this.doc.docs().find((d) => d.spaceId === msg.space);
      if (!doc) {
        void this.refreshSpaces();
        return;
      }
      this.fromChannel = true;
      try {
        doc.applyRemote(msg.ops);
      } finally {
        this.fromChannel = false;
      }
    } else if (msg.type === 'spaces') {
      void this.refreshSpaces();
    } else if (msg.type === 'sync') {
      if (this.leader) this.requestSync();
    } else if (msg.type === 'logout') {
      location.reload();
    }
  }

  // ---------- напоминания ----------

  /** Минуты до срока по умолчанию для задач со временем. */
  reminderDefaults(): number[] {
    try {
      const v = JSON.parse(localStorage.getItem('reminderDefaults') ?? '[0]') as unknown;
      return Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : [0];
    } catch {
      return [0];
    }
  }

  setReminderDefaults(offsets: number[]): void {
    try {
      localStorage.setItem('reminderDefaults', JSON.stringify(offsets));
    } catch {
      // без localStorage настройка действует до перезагрузки
    }
    this.scheduleReminders();
  }

  private remindersDebounce: ReturnType<typeof setTimeout> | undefined;
  private lastPushUpload = 0;

  private scheduleRemindersSoon(): void {
    clearTimeout(this.remindersDebounce);
    this.remindersDebounce = setTimeout(() => this.scheduleReminders(), 500);
    this.schedulePushSoon();
  }

  // ---------- push: напоминания при закрытом приложении ----------

  pushEnabled(): boolean {
    try {
      return localStorage.getItem('push') === '1';
    } catch {
      return false;
    }
  }

  async enablePush(): Promise<'ok' | 'denied' | 'unsupported'> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported';
    if ((await Notification.requestPermission()) !== 'granted') return 'denied';
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await this.api.pushKey();
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await this.api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys });
    try {
      localStorage.setItem('push', '1');
    } catch {
      // без localStorage расписание всё равно отправится в этот раз
    }
    await this.uploadPushSchedule();
    return 'ok';
  }

  async disablePush(): Promise<void> {
    try {
      localStorage.removeItem('push');
    } catch {
      // ничего
    }
    const reg = await navigator.serviceWorker?.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    await this.api.pushUnsubscribe();
  }

  private pushDebounce: ReturnType<typeof setTimeout> | undefined;

  private schedulePushSoon(): void {
    if (!this.pushEnabled()) return;
    clearTimeout(this.pushDebounce);
    this.pushDebounce = setTimeout(() => void this.uploadPushSchedule().catch(() => undefined), 3000);
  }

  /** Расписание на неделю: время открыто, текст зашифрован ключом этого устройства. */
  async uploadPushSchedule(): Promise<void> {
    if (!this.doc || !this.leader || !this.pushEnabled()) return;
    const now = Date.now();
    const list = remindersBetween(this.doc, now, now + 7 * 24 * 3600_000, TZ, this.reminderDefaults()).slice(0, 300);
    const entries = await Promise.all(
      list.map(async (r) => {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.key)));
        const id = [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const body = r.offset === 0 ? 'Пора' : `Через ${r.offset >= 60 ? `${r.offset / 60} ч` : `${r.offset} мин`}`;
        return { id, fireAt: r.at, payload: await sealLocalB64(this.store, { t: r.title || 'Задача', b: body, k: r.key, id: r.taskId }) };
      }),
    );
    await this.api.pushSchedule(entries);
  }

  /**
   * Напоминания показывает только синхронизирующая вкладка, иначе одно и то же
   * уведомление пришло бы из каждой открытой вкладки.
   */
  scheduleReminders(): void {
    clearTimeout(this.reminderTimer);
    if (!this.doc || !this.leader) return;
    const now = Date.now();
    // Раз в час расписание push обновляется: окно в неделю сдвигается.
    if (now - this.lastPushUpload > 3600_000) {
      this.lastPushUpload = now;
      this.schedulePushSoon();
    }
    // Пропущенные за последние 10 минут (вкладка спала) тоже показываем.
    const list = remindersBetween(this.doc, now - 10 * 60_000, now + 48 * 3600_000, TZ, this.reminderDefaults());
    for (const r of list) {
      if (r.at > now) break;
      if (this.fired.has(r.key)) continue;
      this.fired.add(r.key);
      saveFired(this.fired);
      void this.fire(r);
    }
    void this.syncPhoneReminders();
    const next = list.find((r) => r.at > now);
    // Не дольше часа: таймеры браузера в фоне неточны, пересчитываем регулярно.
    const delay = next ? Math.min(next.at - now, 3600_000) : 3600_000;
    this.reminderTimer = setTimeout(() => this.scheduleReminders(), Math.max(1000, delay));
  }

  /** Напоминание пришло через push, пока приложение открыто. */
  receivePushReminder(msg: { key: string; title: string; taskId: string }): void {
    if (this.fired.has(msg.key)) return;
    this.fired.add(msg.key);
    saveFired(this.fired);
    this.onReminder?.({ key: msg.key, taskId: msg.taskId, title: msg.title, at: Date.now(), dueAt: Date.now(), offset: 0 });
  }

  /** Телефон: снимок задач для виджета на главном экране. */
  private syncWidget(): void {
    if (!this.doc) return;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    void updateWidget(widgetSnapshot(this.doc, today, TZ, this.lock !== null)).catch((err) => console.error('widget update failed', err));
  }

  /** Отметки «выполнено» с виджета: применяются как обычное выполнение (повторы переносятся). */
  async applyWidgetCompleted(): Promise<void> {
    const ids = await takeWidgetCompleted().catch(() => [] as string[]);
    if (!this.doc || ids.length === 0) return;
    for (const id of ids) {
      const t = this.doc.task(id);
      if (t && t.completedAt === null) this.doc.completeTask(id);
    }
  }

  /** Телефон: расписание уведомлений Android на неделю вперёд. */
  private async syncPhoneReminders(): Promise<void> {
    if (!this.doc) return;
    this.syncWidget();
    const now = Date.now();
    const list = remindersBetween(this.doc, now, now + 7 * 24 * 3600_000, TZ, this.reminderDefaults());
    await syncNativeReminders(
      list.map((r) => ({
        key: r.key,
        at: r.at,
        title: r.title || 'Задача',
        body: r.offset === 0 ? 'Пора' : `Через ${r.offset >= 60 ? `${r.offset / 60} ч` : `${r.offset} мин`}`,
        taskId: r.taskId,
      })),
    ).catch((err) => console.error('native reminders failed', err));
  }

  private async fire(r: Reminder): Promise<void> {
    this.onReminder?.(r);
    const text = r.offset === 0 ? 'Пора' : `Через ${r.offset >= 60 ? `${r.offset / 60} ч` : `${r.offset} мин`}`;
    if (await nativeNotify(r.title || 'Задача', text).catch(() => false)) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const body = r.offset === 0 ? 'Пора' : `Через ${r.offset >= 60 ? `${r.offset / 60} ч` : `${r.offset} мин`}`;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(r.title || 'Задача', { body, tag: r.key, data: { taskId: r.taskId }, icon: '/icon-192.png' });
      else new Notification(r.title || 'Задача', { body, tag: r.key });
    } catch (err) {
      console.error('notification failed', err);
    }
  }

  // ---------- блокировка PIN-кодом ----------

  private lock: LockConfig | null = null;
  private hiddenAt: number | null = null;
  private watchingBackground = false;
  private biometryPrompt = false;
  private widgetListening = false;

  private watchBackground(): void {
    if (this.watchingBackground) return;
    this.watchingBackground = true;
    const hide = () => {
      // Системный запрос отпечатка на части телефонов ставит приложение на паузу: это не уход в фон.
      if (this.biometryPrompt) return;
      this.hiddenAt ??= Date.now();
      // «Сразу»: экран закрывается при уходе в фон, в списке недавних приложений задач не видно.
      if (this.lock && this.lock.timeoutMin === 0) this.set({ locked: true });
    };
    const show = () => {
      void this.applyWidgetCompleted();
      if (this.biometryPrompt) return;
      if (lockAfterBackground(this.lock, this.hiddenAt, Date.now())) this.set({ locked: true });
      this.hiddenAt = null;
    };
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? hide() : show()));
    // В WebView Android visibilitychange приходит не всегда: дублируем событиями оболочки.
    void onAppPauseResume(hide, show);
  }

  private async saveLock(config: LockConfig | null): Promise<void> {
    this.lock = config;
    if (config) await this.store.setMeta('lock', config);
    else await this.store.deleteMeta('lock');
    this.set({ lockEnabled: config !== null });
    // Виджет скрывает задачи при включённой блокировке: сообщаем ему сразу.
    this.syncWidget();
  }

  lockConfig(): LockConfig | null {
    return this.lock;
  }

  /** Задать или сменить PIN. Смена требует текущий PIN. */
  async setPin(pin: string, current?: string): Promise<void> {
    if (!isValidPin(pin)) throw new Error('PIN: от 4 до 8 цифр');
    if (this.lock && !(current !== undefined && verifyPin(this.lock.pinHash, current))) throw new Error('Текущий PIN неверный');
    await this.saveLock({ pinHash: hashPin(pin), timeoutMin: this.lock?.timeoutMin ?? 1, biometric: this.lock?.biometric ?? false, failures: 0, blockedUntil: 0 });
  }

  async disableLock(current: string): Promise<void> {
    if (!this.lock) return;
    if (!verifyPin(this.lock.pinHash, current)) throw new Error('PIN неверный');
    await this.saveLock(null);
    this.set({ locked: false });
  }

  async updateLock(patch: Partial<Pick<LockConfig, 'timeoutMin' | 'biometric'>>): Promise<void> {
    if (this.lock) await this.saveLock({ ...this.lock, ...patch });
  }

  lockNow(): void {
    if (this.lock) this.set({ locked: true });
  }

  /** Проверить PIN на экране блокировки. */
  async unlock(pin: string): Promise<PinResult> {
    if (!this.lock) {
      this.set({ locked: false });
      return { kind: 'ok', config: { pinHash: '', timeoutMin: 0, biometric: false, failures: 0, blockedUntil: 0 } };
    }
    const lock = this.lock;
    const result = applyPinAttempt(lock, Date.now(), () => verifyPin(lock.pinHash, pin));
    if (result.kind === 'wipe') {
      // Десять неверных PIN подряд: данные устройства стираются, войти можно только с паролем.
      for (const engine of this.engines.values()) {
        try {
          await engine.sync();
        } catch {
          // нет сети: неотправленное пропадёт вместе с данными устройства
        }
      }
      await this.logout('Слишком много неверных PIN-кодов. Данные на этом устройстве стёрты, войдите с паролем.');
      return result;
    }
    await this.saveLock(result.config);
    if (result.kind === 'ok') this.set({ locked: false });
    return result;
  }

  /** Разблокировать отпечатком: системный запрос на телефоне. Счётчик ошибок PIN при этом сбрасывается. */
  async unlockWithBiometry(): Promise<boolean> {
    if (!this.lock?.biometric || this.biometryPrompt) return false;
    this.biometryPrompt = true;
    let ok: boolean;
    try {
      ok = await biometryUnlock();
    } finally {
      this.biometryPrompt = false;
      this.hiddenAt = null;
    }
    if (!ok || !this.lock) return false;
    await this.saveLock({ ...this.lock, failures: 0, blockedUntil: 0 });
    this.set({ locked: false });
    return true;
  }

  // ---------- выход ----------

  async logout(notice: string | null = null): Promise<void> {
    // Перед выходом пробуем отправить всё, что осталось: после выхода данные устройства стираются.
    if (notice === null) {
      for (const engine of this.engines.values()) {
        try {
          await engine.sync();
        } catch {
          // нет сети: пользователь уже предупреждён в диалоге
        }
      }
    }
    try {
      if (this.api.token) await this.api.logout();
    } catch {
      // сервер недоступен или сессия уже закрыта
    }
    for (const fn of this.stopFns.splice(0)) fn();
    clearTimeout(this.wsTimer);
    clearTimeout(this.reminderTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    for (const fn of this.detachFns.values()) fn();
    this.detachFns.clear();
    this.engines.clear();
    this.doc = null;
    this.stored = null;
    this.secrets = null;
    this.api.token = null;
    await this.store.clear();
    this.channel?.postMessage({ type: 'logout' } satisfies ChannelMessage);
    this.leader = false;
    this.lock = null;
    this.set({ phase: 'auth', email: null, status: IDLE, notice, locked: false, lockEnabled: false });
  }

  /** Число операций, ещё не отправленных на сервер. */
  async pendingCount(): Promise<number> {
    if (!this.doc) return 0;
    let n = 0;
    for (const d of this.doc.docs()) n += (await this.store.outbox(d.spaceId, 10_000)).length;
    return n;
  }
}

export const controller = new Controller();
