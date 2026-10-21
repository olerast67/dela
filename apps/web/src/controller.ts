/**
 * Состояние приложения: сессия, документ, синхронизация, связь между вкладками.
 *
 * Синхронизирует одна вкладка (держит Web Lock «dela-leader»), остальные получают изменения
 * через BroadcastChannel. Очередь исходящих общая — в IndexedDB.
 */
import {
  applyPinAttempt,
  openAccountWithPasskey,
  wrapMasterForPasskey,
  widgetSnapshot,
  WIDGET_TASK_LIMIT,
  type WidgetSnapshot,
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
  passwordProof,
  ensurePersonalSpace,
  fingerprint,
  fromB64,
  newKey,
  boxSpaceKeyFor,
  isBoxedSpaceKey,
  openBoxedSpaceKey,
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
  alarmTasks,
  placeZones,
  digestsBetween,
  isTime,
  type Reminder,
  signIn,
  signUp,
  spaceKeys,
  toB64,
  type Op,
  type Session,
  type SyncStatus,
  phonePushKey,
  signingKeys,
  signComment,
  verifyComment,
  type SigningKeys,
  type CommentSigned,
  type Comment,
} from '#core';
import { IdbStore, openLocal, sealLocal, sealLocalB64 } from './storage.ts';
import { TZ } from './format.ts';
import { createPasskey, getPasskey } from './passkey.ts';
import { loadPomodoro, onPomodoroChange, pomodoroSettings } from './pomodoro.ts';
import { clearCalendars } from './calendars.ts';
import { biometryUnlock, nativePushSubscribe, nativePushUnsubscribe, platform, nativeNotify, onAppPauseResume, onWidgetCompleted, serverUrl, syncNativePlaces, syncNativeReminders, takeWidgetCompleted, updateWidget } from './platform.ts';
import { LANG, tn, tr } from './i18n.ts';
import { isQuickWindow } from './viewWindow.ts';

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

/** Утренняя сводка этого устройства: включена ли и во сколько. */
export interface MorningDigest {
  readonly on: boolean;
  readonly time: string;
}

/** «Сегодня 5 задач, просрочено 2». */
function digestText(today: number, overdue: number): string {
  if (today > 0 && overdue > 0) return tr('Сегодня {tasks}, просрочено {n}', { tasks: tn(today, 'задача', 'задачи', 'задач'), n: overdue });
  if (today > 0) return tr('Сегодня {tasks}', { tasks: tn(today, 'задача', 'задачи', 'задач') });
  return tr('Просрочено {tasks}', { tasks: tn(overdue, 'задача', 'задачи', 'задач') });
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
  /** Работа без сервера: задачи только в этом браузере (демо). */
  readonly local: boolean;
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
  /** Без сервера: синхронизации, push и WebSocket нет. */
  readonly local?: boolean;
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
            : tr('устройство');
  // В приложениях для телефона и Windows движок браузера пользователю ничего не говорит.
  if (platform() !== 'web') return tr('Приложение Dela · {os}', { os: os });
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : tr('Браузер');
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
  private state: AppState = { phase: 'loading', email: null, isAdmin: false, status: IDLE, recoveryKey: null, notice: null, locked: false, lockEnabled: false, local: false };
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
  /** Таймер помодоро запущен, на паузе или снят: пересчитать уведомление об окончании. */
  private readonly pomodoroWatch = onPomodoroChange(() => this.pomodoroChanged());
  private lastPomodoroAlert: Reminder | null = null;

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
      // Демо на GitHub Pages: сразу открываем приложение без сервера.
      if (import.meta.env.VITE_DEMO === '1') {
        await this.startLocal();
        return;
      }
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
      this.set({ phase: 'auth', notice: tr('Не удалось открыть сохранённую сессию. Войдите снова.') });
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
    for (const t of welcomeTasks(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()), LANG)) this.doc?.createTask(t);
    this.set({ phase: 'recovery', recoveryKey });
  }

  async login(email: string, password: string, totp?: string): Promise<void> {
    const session = await signIn(this.api, { email, password, deviceName: deviceName(), ...(totp ? { totp } : {}) });
    await this.persistAndStart(session);
  }

  /** Вход по passkey: подпись проверяет сервер, ключ аккаунта открывает секрет PRF на устройстве. */
  async loginWithPasskey(): Promise<void> {
    const { challengeId, options } = await this.api.passkeyLoginOptions();
    const { response, prf } = await getPasskey(options);
    const res = await this.api.passkeyLogin({ challengeId, response, deviceName: deviceName() });
    const keys = openAccountWithPasskey(res.bundle, res.wrappedMaster, prf);
    this.api.token = res.token;
    await this.persistAndStart({ token: res.token, userId: res.userId, deviceId: res.deviceId, isAdmin: res.isAdmin, email: res.email, bundle: res.bundle, keys });
  }

  /** Добавить passkey к аккаунту: мастер-ключ оборачивается секретом PRF и хранится на сервере в таком виде. */
  async addPasskey(name: string, password: string, totp?: string): Promise<void> {
    const authSecret = await passwordProof(this.api, password);
    const { options } = await this.api.passkeyRegisterOptions({ authSecret, ...(totp ? { totp } : {}) });
    const { response, prf } = await createPasskey(options);
    await this.api.passkeyRegister({ response, name, wrappedMaster: wrapMasterForPasskey(this.accountKeys().masterKey, prf) });
  }

  /** Забыт пароль: вход по ключу восстановления с новым паролем. */
  async recover(email: string, recoveryKey: string, newPassword: string, totp?: string): Promise<void> {
    const session = await recoverAccount(this.api, { email, recoveryKey, newPassword, deviceName: deviceName(), ...(totp ? { totp } : {}) });
    await this.persistAndStart(session);
  }

  /** Удалить аккаунт: сервер стирает аккаунт и личные задачи, устройство выходит и стирает свои данные. */
  /** Аккаунт удаляется: отказ в доступе от закрытой сервером сессии не должен перехватить выход. */
  private deletingAccount = false;

  async deleteAccount(password: string, totp?: string): Promise<void> {
    // Перед удалением отправляем изменения общих проектов: они остаются у других участников.
    for (const engine of this.engines.values()) {
      try {
        await engine.sync();
      } catch {
        // нет сети: удаление ниже тоже не пройдёт
      }
    }
    this.deletingAccount = true;
    try {
      await deleteAccountOnServer(this.api, { password, ...(totp ? { totp } : {}) });
    } catch (err) {
      this.deletingAccount = false;
      throw err;
    }
    await this.logout(tr('Аккаунт удалён.'));
    this.deletingAccount = false;
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

  /**
   * Попробовать без сервера: ключи создаются на устройстве, задачи шифруются и лежат только в этом браузере.
   * Перенести их на сервер можно экспортом и импортом.
   */
  async startLocal(): Promise<void> {
    const secrets: SecretKeys = {
      masterKey: toB64(newKey()),
      publicKey: toB64(newKey()),
      secretKey: toB64(newKey()),
      spaceKey: toB64(newKey()),
    };
    const stored: StoredSession = {
      token: '',
      userId: uuidv7(),
      deviceId: 'local',
      email: tr('Без сервера'),
      isAdmin: false,
      spaceId: uuidv7(),
      node: newNodeId(),
      sealed: await sealLocal(this.store, secrets),
      local: true,
    };
    await this.store.setMeta('session', stored);
    await this.start(stored, secrets);
    for (const t of welcomeTasks(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()), LANG)) this.doc?.createTask(t);
  }

  private async start(stored: StoredSession, secrets: SecretKeys): Promise<void> {
    this.api.token = stored.token;
    this.stored = stored;
    this.secrets = secrets;
    const now = () => Date.now() + this.clockOffset;
    const lastHlc = await this.store.getMeta<string>('hlc');
    this.clock = new HybridClock(stored.node, now, lastHlc);
    void this.ensureSignKey().catch(() => undefined);
    void this.refreshPhonePushKey().catch(() => undefined);
    const doc = new Doc({ spaceId: stored.spaceId, clock: this.clock, now });
    doc.load(await this.store.loadCells(stored.spaceId));
    const ws = new Workspace(doc);
    this.doc = ws;
    ws.setActor(stored.userId);
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
    this.set({ phase: this.state.phase === 'recovery' ? 'recovery' : 'ready', email: stored.email, isAdmin: stored.isAdmin, notice: null, local: stored.local === true });
    void this.applyWidgetCompleted();
    if (!this.widgetListening) {
      this.widgetListening = true;
      void onWidgetCompleted(() => void this.applyWidgetCompleted());
    }
    // Всплывающая строка не синхронизирует и не напоминает: это делает главное окно, оно живёт и скрытым в трее.
    if (typeof location === 'undefined' || !isQuickWindow(location.search)) this.becomeLeaderWhenPossible();
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
      onUnauthorized: () => {
        if (!this.deletingAccount) void this.logout(tr('Сессия на этом устройстве завершена. Войдите снова.'));
      },
    });
    this.engines.set(spaceId, engine);
    const stopPersist = persistLocal(doc, this.store, spaceId, () => {
      // Без сервера отправлять некуда: очередь исходящих сразу очищается, данные уже в хранилище.
      if (this.stored?.local) {
        void this.store.outbox(spaceId, 5000).then((batch) => this.store.dropOutbox(spaceId, batch.map((e) => e.key)));
        return;
      }
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
    if (!ws || !this.secrets || !this.stored || this.stored.local) return;
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
            this.rekey(existing, this.openSpaceKey(sp, keys), sp.keyVersion ?? 1);
          } catch {
            // ключ не открылся или пришёл не от владельца: оставляем прежний движок, предупреждение в keyWarnings
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
    for (const id of current) void this.loadMembers(id).catch(() => undefined);
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

  /** Участники общих проектов: адреса для подписи комментариев и исполнителей. */
  private readonly memberCache = new Map<string, ReadonlyArray<{ userId: string; email: string; signKey: string | null }>>();

  async loadMembers(spaceId: string): Promise<ReadonlyArray<{ userId: string; email: string; signKey: string | null }>> {
    const { members } = await this.api.spaceMembers(spaceId);
    const list = members.map((m) => ({ userId: m.userId, email: m.email, signKey: m.signPublicKey ?? null }));
    this.memberCache.set(spaceId, list);
    // Ключ подписи участника закрепляется при первом появлении: подменённый позже ключ не пройдёт проверку.
    for (const m of list) {
      if (m.signKey && m.userId !== this.userId && this.pin(`sig:${m.userId}`) === undefined) this.setKeyPin(`sig:${m.userId}`, m.signKey);
    }
    if (this.roles.get(spaceId) === 'owner') void this.rotateIfMemberLeft(spaceId, new Set(list.map((m) => m.userId)));
    this.docVersion++;
    for (const fn of this.docListeners) fn();
    return list;
  }

  cachedMembers(spaceId: string): ReadonlyArray<{ userId: string; email: string; signKey: string | null }> {
    return this.memberCache.get(spaceId) ?? [];
  }

  memberEmail(spaceId: string, userId: string): string | null {
    return this.memberCache.get(spaceId)?.find((m) => m.userId === userId)?.email ?? null;
  }

  // ---------- подписи комментариев ----------

  private signCache: { master: Uint8Array; keys: SigningKeys } | null = null;

  private signKeys(): SigningKeys {
    const master = this.accountKeys().masterKey;
    if (!this.signCache || this.signCache.master !== master) this.signCache = { master, keys: signingKeys(master) };
    return this.signCache.keys;
  }

  /** Подпись нового комментария ключом этого пользователя. */
  commentSigner(): (c: CommentSigned) => string {
    return (c) => signComment(this.signKeys().secretKey, c);
  }

  /**
   * Ключ подписи на сервере не совпадает с выведенным из мастер-ключа: «missing», если его ещё нет и сессия старая,
   * «other», если там чужой ключ. В обоих случаях нужен пароль.
   */
  signKeyMismatch: false | 'missing' | 'other' = false;

  private async ensureSignKey(): Promise<void> {
    if (!this.stored || this.stored.local) return;
    const mine = toB64(this.signKeys().publicKey);
    const account = await this.api.account();
    if (account.signPublicKey === mine) return;
    try {
      await this.api.setSignKey({ signPublicKey: mine });
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'sign_key_mismatch' || err.code === 'sign_key_password')) {
        this.signKeyMismatch = err.code === 'sign_key_mismatch' ? 'other' : 'missing';
        this.docVersion++;
        for (const fn of this.docListeners) fn();
      }
    }
  }

  /** Вернуть свой ключ подписи на сервер: нужен пароль (и код TOTP, если он включён). */
  async fixSignKey(password: string, totp?: string): Promise<void> {
    const authSecret = await passwordProof(this.api, password);
    await this.api.setSignKey({ signPublicKey: toB64(this.signKeys().publicKey), authSecret, ...(totp ? { totp } : {}) });
    this.signKeyMismatch = false;
    this.docVersion++;
    for (const fn of this.docListeners) fn();
  }

  /**
   * Проверка подписи комментария. «unsigned»: комментарий без подписи (старая версия Dela);
   * «unknown»: ключ автора ещё не загружен; «bad»: подпись не сходится или ключ автора сменился.
   */
  commentStatus(spaceId: string, c: Comment): 'ok' | 'unsigned' | 'unknown' | 'bad' {
    if (!c.author) return 'unsigned';
    let key: string | null;
    // Этот клиент подписывает каждый свой комментарий: «мой» комментарий без подписи написал кто-то другой.
    if (c.author === this.userId && !c.sig) return 'bad';
    if (c.author === this.userId) key = toB64(this.signKeys().publicKey);
    else {
      const pinned = this.pin(`sig:${c.author}`) ?? null;
      const current = this.memberCache.get(spaceId)?.find((m) => m.userId === c.author)?.signKey ?? null;
      if (pinned && current && pinned !== current) return 'bad';
      key = pinned ?? current;
    }
    if (!c.sig) return 'unsigned';
    if (!key) return 'unknown';
    const signed: CommentSigned = { spaceId, id: c.id, taskId: c.taskId, author: c.author, createdAt: c.createdAt, text: c.text, file: c.file };
    return verifyComment(key, c.sig, signed) ? 'ok' : 'bad';
  }

  // ---------- закреплённые ключи (против подмены сервером) ----------

  /** Запись в личном пространстве: зашифрована и есть на всех устройствах пользователя. */
  private pin(id: string): string | undefined {
    const v = this.doc?.personal.replica.get('pin', id)?.public_key;
    return typeof v === 'string' ? v : undefined;
  }

  private setKeyPin(id: string, publicKey: string): void {
    this.doc?.personal.write([['pin', id, 'public_key', publicKey]], { undoable: false });
  }

  /** Ключ проекта пришёл не от закреплённого владельца: отпечаток отправителя по пространству. */
  private readonly keyWarnings = new Map<string, string>();

  keyWarning(spaceId: string): string | null {
    return this.keyWarnings.get(spaceId) ?? null;
  }

  /**
   * Открыть ключ общего пространства. Ключ от владельца подтверждён отправителем: при первом получении
   * его открытый ключ закрепляется, дальше ключ от другого отправителя не принимается. Анонимно
   * запечатанный ключ принимается только в первой версии (так приглашали до 0.4.1).
   */
  private openSpaceKey(sp: SpaceInfo, keys: AccountKeys): Uint8Array {
    if (sp.keyKind === 'wrapped') return spaceKeyOf(sp, keys);
    const version = sp.keyVersion ?? 1;
    if (!isBoxedSpaceKey(sp.key)) {
      if (version > 1) {
        this.keyWarnings.set(sp.id, 'unsigned');
        throw new Error('unsigned_space_key');
      }
      return spaceKeyOf(sp, keys);
    }
    const { key, sender } = openBoxedSpaceKey(sp.key, sp.id, version, keys);
    const senderB64 = toB64(sender);
    const pinned = this.pin(`${sp.id}:owner`);
    if (pinned === undefined) this.setKeyPin(`${sp.id}:owner`, senderB64);
    else if (pinned !== senderB64) {
      this.keyWarnings.set(sp.id, fingerprint(sender));
      throw new Error('space_key_sender_changed');
    }
    this.keyWarnings.delete(sp.id);
    return key;
  }

  /** Пользователь сверил отпечаток нового владельца и доверяет ему (например, прежний владелец удалил аккаунт). */
  async trustSpaceSender(spaceId: string): Promise<void> {
    const sp = (await this.api.spaces()).spaces.find((s) => s.id === spaceId);
    if (!sp || !isBoxedSpaceKey(sp.key)) return;
    const { sender } = openBoxedSpaceKey(sp.key, sp.id, sp.keyVersion ?? 1, this.accountKeys());
    this.setKeyPin(`${spaceId}:owner`, toB64(sender));
    this.keyWarnings.delete(spaceId);
    await this.refreshSpaces();
  }

  /**
   * Участник вышел сам, удалил аккаунт или прошлая смена ключа не удалась: у него остался ключ проекта.
   * Закреплённый ключ ушедшего участника остаётся, пока ключ проекта не сменён, поэтому смена повторяется.
   */
  private async rotateIfMemberLeft(spaceId: string, present: ReadonlySet<string>): Promise<void> {
    const ws = this.doc;
    if (!ws || this.rotating.has(spaceId)) return;
    const prefix = `${spaceId}:`;
    const departed = [...ws.personal.replica.all('pin').entries()]
      .filter(([id, rec]) => id.startsWith(prefix) && !id.endsWith(':owner') && typeof rec.public_key === 'string' && !present.has(id.slice(prefix.length)))
      .map(([id]) => id);
    if (departed.length === 0) return;
    this.rotating.add(spaceId);
    try {
      await this.rotateKey(spaceId);
      ws.personal.write(
        departed.map((id) => ['pin', id, 'public_key', null] as const),
        { undoable: false },
      );
    } catch {
      // нет сети или нужны подтверждения участников: повторим при следующем обновлении
    } finally {
      this.rotating.delete(spaceId);
    }
  }

  private readonly rotating = new Set<string>();

  /** Владелец подтверждает участников, чьи ключи ещё не закреплены (или сменились), сверив отпечатки. */
  pinMembers(spaceId: string, members: ReadonlyArray<{ userId: string; publicKey: string }>): void {
    for (const m of members) this.setKeyPin(`${spaceId}:${m.userId}`, m.publicKey);
  }

  /** Пригласить по адресу: ключ проекта шифруется для участника ключом владельца. Возвращает отпечаток ключа участника. */
  async addMember(spaceId: string, email: string, role: 'editor' | 'viewer'): Promise<string> {
    const { userId, publicKey } = await this.api.userPublicKey(email);
    const key = this.spaceKeyById.get(spaceId);
    if (!key) throw new Error('unknown space');
    if (userId === this.stored?.userId) throw new Error('self_invite');
    const version = this.keyVersionById.get(spaceId) ?? 1;
    await this.api.addMember(spaceId, { userId, role, key: boxSpaceKeyFor(key, spaceId, version, fromB64(publicKey), this.accountKeys()) });
    // Ключ участника, который владелец видит сейчас (и сверяет отпечаток), закрепляется для будущих смен ключа.
    this.setKeyPin(`${spaceId}:${userId}`, publicKey);
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
    // Одна смена ключа на пространство за раз: ручная и автоматическая не должны отменять друг друга.
    const running = this.rotations.get(spaceId);
    if (running) return running;
    const p = this.rotateKeyNow(spaceId).finally(() => this.rotations.delete(spaceId));
    this.rotations.set(spaceId, p);
    return p;
  }

  private readonly rotations = new Map<string, Promise<void>>();

  private async rotateKeyNow(spaceId: string): Promise<void> {
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
          account: this.accountKeys(),
          pinned: (userId) => this.pin(`${spaceId}:${userId}`),
          keyVersion: info.keyVersion ?? 1,
          // Сколько журнала загружено на этом устройстве: всё, что пришло позже, сервер не даст удалить.
          baseSeq: await this.store.cursor(spaceId),
        });
        this.rekey(doc, key, keyVersion);
        await this.saveSecrets();
        this.requestSync();
        return;
      } catch (err) {
        // stale: пришли новые правки; not_found: смену перебила другая (другое устройство владельца). Пробуем заново.
        if (err instanceof ApiError && (err.code === 'stale' || (err.code === 'not_found' && attempt < 4))) continue;
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
    if (!this.leader || this.stored?.local) return;
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
        if (!this.deletingAccount) void this.logout(tr('Сессия на этом устройстве завершена. Войдите снова.'));
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
    // Минуты до срока этого телефона нужны и другим устройствам: они составляют для него расписание.
    this.schedulePushSoon();
  }

  /** Утренняя сводка хранится на устройстве, как и минуты напоминаний: у телефона и компьютера она своя. */
  morningDigest(): MorningDigest {
    try {
      const v = JSON.parse(localStorage.getItem('morningDigest') ?? 'null') as Partial<MorningDigest> | null;
      return { on: v?.on === true, time: typeof v?.time === 'string' && isTime(v.time) ? v.time : '08:00' };
    } catch {
      return { on: false, time: '08:00' };
    }
  }

  setMorningDigest(value: MorningDigest): void {
    try {
      localStorage.setItem('morningDigest', JSON.stringify(value));
    } catch {
      // без localStorage настройка действует до перезагрузки
    }
    this.scheduleReminders();
    this.schedulePushSoon();
  }

  /**
   * Напоминания задач и утренние сводки этого устройства в [from, to), по времени.
   * Сводка — синтетическое напоминание без задачи (taskId пустой): по нажатию открывается «Сегодня».
   */
  private alerts(from: number, to: number, offsets: number[], pomodoro = false): Reminder[] {
    const list = remindersBetween(this.doc!, from, to, TZ, offsets);
    const digest = this.morningDigest();
    const extra: Reminder[] = [];
    if (digest.on) {
      extra.push(
        ...digestsBetween(this.doc!, from, to, TZ, digest.time).map(
          (d): Reminder => ({ key: d.key, taskId: '', at: d.at, title: digestText(d.today, d.overdue), dueAt: d.at, offset: 0 }),
        ),
      );
    }
    // Конец помодоро только для этого устройства: в расписание push на сервер он не уходит.
    const pomo = pomodoro ? this.pomodoroAlert() : null;
    if (pomo && pomo.at >= from && pomo.at < to) extra.push(pomo);
    if (extra.length === 0) return list;
    return [...list, ...extra].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  }

  /** Уведомление об окончании работы или перерыва; ключ меняется после паузы, чтобы уведомление пришло снова. */
  private pomodoroAlert(): Reminder | null {
    const s = loadPomodoro();
    if (!s || s.endsAt === null) return null;
    const title = s.phase === 'work' ? tr('Перерыв {n} мин', { n: pomodoroSettings().rest }) : tr('Перерыв окончен');
    return { key: `pomodoro:${s.id}:${s.phase}:${s.endsAt}`, taskId: s.taskId, at: s.endsAt, title, dueAt: s.endsAt, offset: 0 };
  }

  /**
   * Таймер снимается, как только перерыв кончился, и уведомление пропало бы из расписания,
   * не успев сработать: такое наступившее уведомление показываем сразу.
   */
  private pomodoroChanged(): void {
    const prev = this.lastPomodoroAlert;
    this.lastPomodoroAlert = this.doc ? this.pomodoroAlert() : null;
    if (prev && this.leader && prev.at <= Date.now() && !this.fired.has(prev.key)) {
      this.fired.add(prev.key);
      saveFired(this.fired);
      void this.fire(prev);
    }
    this.scheduleReminders();
  }

  /** Текст уведомления под заголовком. */
  private bodyOf(r: Reminder): string {
    if (!r.taskId) return tr('Утренняя сводка');
    if (r.key.startsWith('pomodoro:')) {
      const title = this.doc?.task(r.taskId)?.title || tr('Задача');
      return r.key.includes(':work:') ? tr('Помодоро закончен: {title}', { title }) : title;
    }
    return r.offset === 0 ? tr('Пора') : tr('Через {n}', { n: r.offset >= 60 ? tr('{n} ч', { n: r.offset / 60 }) : tr('{offset} мин', { offset: r.offset }) });
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

  /**
   * Ключ текста напоминаний для телефона: его знают веб-часть, нативная служба push и другие устройства аккаунта
   * (выводят из главного ключа), но не сервер.
   */
  private phoneKey(deviceId: string): Uint8Array {
    return phonePushKey(this.accountKeys().masterKey, deviceId);
  }

  /**
   * Телефон с push, включённым до 0.6.0, хранил случайный ключ текста. Ключ меняется на выведенный из главного,
   * а подписка помечается как телефонная: так другие устройства могут класть напоминания в её расписание.
   */
  private async refreshPhonePushKey(): Promise<void> {
    if (platform() !== 'capacitor' || !this.pushEnabled() || !this.stored || this.stored.local) return;
    try {
      if (localStorage.getItem('pushKey') === '2') return;
    } catch {
      return;
    }
    const { publicKey } = await this.api.pushKey();
    const sub = await nativePushSubscribe(publicKey, toB64(this.phoneKey(this.stored.deviceId)));
    if (!sub) return;
    await this.api.pushSubscribe({ ...sub, kind: 'phone' });
    localStorage.setItem('pushKey', '2');
    await this.uploadPushSchedule();
  }

  /** base64(iv ‖ AES-GCM) ключом телефона: так текст расшифровывает нативная служба UnifiedPush. */
  private async sealForPhone(raw: Uint8Array, value: unknown): Promise<string> {
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))));
    const all = new Uint8Array(iv.length + ct.length);
    all.set(iv);
    all.set(ct, iv.length);
    return toB64(all);
  }

  async enablePush(): Promise<'ok' | 'denied' | 'unsupported' | 'no_distributor'> {
    if (platform() === 'capacitor') {
      const { publicKey } = await this.api.pushKey();
      const sub = await nativePushSubscribe(publicKey, toB64(this.phoneKey(this.stored!.deviceId)));
      if (!sub) return 'no_distributor';
      await this.api.pushSubscribe({ ...sub, kind: 'phone' });
      try {
        localStorage.setItem('push', '1');
        localStorage.setItem('pushKey', '2');
      } catch {
        // без localStorage расписание всё равно отправится в этот раз
      }
      await this.uploadPushSchedule();
      return 'ok';
    }
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
    if (platform() === 'capacitor') {
      await nativePushUnsubscribe();
      await this.api.pushUnsubscribe();
      return;
    }
    const reg = await navigator.serviceWorker?.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    await this.api.pushUnsubscribe();
  }

  private pushDebounce: ReturnType<typeof setTimeout> | undefined;

  private schedulePushSoon(): void {
    if (!this.stored || this.stored.local) return;
    clearTimeout(this.pushDebounce);
    this.pushDebounce = setTimeout(() => void this.uploadPushSchedule().catch(() => undefined), 3000);
  }

  /**
   * Расписание на неделю: время открыто, текст зашифрован. Своё расписание отправляет устройство с включённым push,
   * а расписание телефонов аккаунта обновляет любое устройство: задача, добавленная на компьютере,
   * напомнит о себе на телефоне, даже если приложение там закрыто.
   */
  async uploadPushSchedule(): Promise<void> {
    if (!this.doc || !this.leader || !this.stored || this.stored.local) return;
    const self = this.stored.deviceId;
    if (this.pushEnabled()) {
      const offsets = this.reminderDefaults();
      const seal = platform() === 'capacitor' ? (c: unknown) => this.sealForPhone(this.phoneKey(self), c) : (c: unknown) => sealLocalB64(this.store, c);
      await this.api.pushSchedule(await this.pushEntries(offsets, seal, true), { offsets });
    }
    for (const phone of await this.pushPhones()) {
      if (phone.deviceId === self) continue;
      const key = this.phoneKey(phone.deviceId);
      // Утренняя сводка — настройка самого телефона: другие устройства её не знают и в его расписание не кладут.
      const entries = await this.pushEntries(phone.offsets ?? [0], (c) => this.sealForPhone(key, c), false);
      await this.api.pushSchedule(entries, { device: phone.deviceId }).catch(() => undefined);
    }
  }

  private async pushEntries(
    offsets: number[],
    seal: (content: unknown) => Promise<string>,
    own: boolean,
  ): Promise<Array<{ id: string; fireAt: number; payload: string }>> {
    if (!this.doc) return [];
    const now = Date.now();
    const to = now + 7 * 24 * 3600_000;
    const list = (own ? this.alerts(now, to, offsets) : remindersBetween(this.doc, now, to, TZ, offsets)).slice(0, 300);
    return Promise.all(
      list.map(async (r) => {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.key)));
        const id = [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
        const body = this.bodyOf(r);
        // Сервер принимает до 1 КБ на напоминание: длинное название обрезается, иначе отклонилось бы всё расписание.
        // У сводки нет задачи: флаг today открывает «Сегодня» (service worker и служба push на Android).
        // Флаг a: служба push на Android звонит будильником, если он ещё не стоит в телефоне (задачу добавили на другом устройстве).
        const content = r.taskId
          ? { t: (r.title || tr('Задача')).slice(0, 200), b: body, k: r.key, id: r.taskId, ...(r.alarm ? { a: true } : {}) }
          : { t: r.title, b: body, k: r.key, today: true };
        return { id, fireAt: r.at, payload: await seal(content) };
      }),
    );
  }

  private phonesCache: { at: number; list: Array<{ deviceId: string; offsets: number[] | null }> } | null = null;

  /** Телефоны аккаунта с push; список обновляется раз в 10 минут. */
  private async pushPhones(): Promise<Array<{ deviceId: string; offsets: number[] | null }>> {
    if (this.phonesCache && Date.now() - this.phonesCache.at < 10 * 60_000) return this.phonesCache.list;
    const list = await this.api.pushDevices().then((r) => r.devices, () => this.phonesCache?.list ?? []);
    this.phonesCache = { at: Date.now(), list };
    return list;
  }

  /**
   * Напоминания показывает только синхронизирующая вкладка, иначе одно и то же
   * уведомление пришло бы из каждой открытой вкладки.
   */
  scheduleReminders(): void {
    clearTimeout(this.reminderTimer);
    if (!this.doc || !this.leader) return;
    this.lastPomodoroAlert = this.pomodoroAlert();
    const now = Date.now();
    // Раз в час расписание push обновляется: окно в неделю сдвигается.
    if (now - this.lastPushUpload > 3600_000) {
      this.lastPushUpload = now;
      this.schedulePushSoon();
    }
    // Пропущенные за последние 10 минут (вкладка спала) тоже показываем.
    const list = this.alerts(now - 10 * 60_000, now + 48 * 3600_000, this.reminderDefaults(), true);
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

  /** Напоминание пришло через push, пока приложение открыто. Пустой taskId — утренняя сводка. */
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
    void updateWidget(widgetSnapshot(this.doc, today, TZ, this.lock !== null, WIDGET_TASK_LIMIT, tr('Входящие'), LANG)).catch((err) => console.error('widget update failed', err));
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
    void syncNativePlaces(placeZones(this.doc.personal)).catch((err) => console.error('native places failed', err));
    const now = Date.now();
    const list = this.alerts(now, now + 7 * 24 * 3600_000, this.reminderDefaults(), true);
    await syncNativeReminders(
      list.map((r) => ({
        key: r.key,
        at: r.at,
        title: r.title || tr('Задача'),
        body: this.bodyOf(r),
        taskId: r.taskId || null,
        ...(r.alarm ? { alarm: true } : {}),
      })),
      alarmTasks(this.doc),
    ).catch((err) => console.error('native reminders failed', err));
  }

  private async fire(r: Reminder): Promise<void> {
    // Внутри приложения конец помодоро показывает сам таймер.
    if (!r.key.startsWith('pomodoro:')) this.onReminder?.(r);
    const body = this.bodyOf(r);
    if (await nativeNotify(r.title || tr('Задача'), body).catch(() => false)) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      // Сводка без задачи: нажатие открывает «Сегодня».
      const data = r.taskId ? { taskId: r.taskId } : { today: true };
      if (reg) await reg.showNotification(r.title || tr('Задача'), { body, tag: r.key, data, icon: '/icon-192.png' });
      else new Notification(r.title || tr('Задача'), { body, tag: r.key });
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
    if (!isValidPin(pin)) throw new Error(tr('PIN: от 4 до 8 цифр'));
    if (this.lock && !(current !== undefined && verifyPin(this.lock.pinHash, current))) throw new Error(tr('Текущий PIN неверный'));
    await this.saveLock({ pinHash: hashPin(pin), timeoutMin: this.lock?.timeoutMin ?? 1, biometric: this.lock?.biometric ?? false, failures: 0, blockedUntil: 0 });
  }

  async disableLock(current: string): Promise<void> {
    if (!this.lock) return;
    if (!verifyPin(this.lock.pinHash, current)) throw new Error(tr('PIN неверный'));
    await this.saveLock(null);
    this.set({ locked: false });
  }

  async updateLock(patch: Partial<Pick<LockConfig, 'timeoutMin' | 'biometric'>>): Promise<void> {
    if (this.lock) await this.saveLock({ ...this.lock, ...patch });
  }

  /**
   * Всплывающая строка: перечитать PIN из базы при каждом показе — его могли задать или снять в главном окне.
   * Строка не открывается PIN-кодом: при заданном PIN она всегда закрыта.
   */
  async reloadLock(): Promise<void> {
    if (this.state.phase !== 'ready') return;
    this.lock = (await this.store.getMeta<LockConfig>('lock')) ?? null;
    this.set({ locked: this.lock !== null, lockEnabled: this.lock !== null });
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
      await this.logout(tr('Слишком много неверных PIN-кодов. Данные на этом устройстве стёрты, войдите с паролем.'));
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
    // Кеш календарей по подпискам: события не должны пережить выход из аккаунта.
    await clearCalendars().catch(() => undefined);
    // Телефон: снять напоминания и зоны мест, очистить виджет, чтобы названия задач и координаты не остались после выхода.
    await syncNativeReminders([]).catch(() => undefined);
    await syncNativePlaces([]).catch(() => undefined);
    await updateWidget({ v: 1, lock: false, lang: LANG, projects: [], tasks: [] } satisfies WidgetSnapshot).catch(() => undefined);
    this.channel?.postMessage({ type: 'logout' } satisfies ChannelMessage);
    this.leader = false;
    this.lock = null;
    this.set({ phase: 'auth', email: null, status: IDLE, notice, locked: false, lockEnabled: false, local: false });
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
