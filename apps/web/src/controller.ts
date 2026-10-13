/**
 * Состояние приложения: сессия, документ, синхронизация, связь между вкладками.
 *
 * Синхронизирует одна вкладка (держит Web Lock «dela-leader»), остальные получают изменения
 * через BroadcastChannel. Очередь исходящих общая — в IndexedDB.
 */
import {
  ApiClient,
  ApiError,
  Doc,
  HybridClock,
  NetworkError,
  SyncEngine,
  changeAccountPassword,
  ensurePersonalSpace,
  fromB64,
  initCrypto,
  newNodeId,
  persistLocal,
  recoverAccount,
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
import { IdbStore, openLocal, sealLocal } from './storage.ts';
import { TZ } from './format.ts';

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
}

type ChannelMessage = { type: 'ops'; ops: Op[] } | { type: 'sync' } | { type: 'logout' };

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
  readonly api = new ApiClient('');
  doc: Doc | null = null;
  private engine: SyncEngine | null = null;
  private clock: HybridClock | null = null;
  private clockOffset = 0;
  private state: AppState = { phase: 'loading', email: null, isAdmin: false, status: IDLE, recoveryKey: null, notice: null };
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
    this.set({ phase: 'recovery', recoveryKey });
  }

  async login(email: string, password: string): Promise<void> {
    const session = await signIn(this.api, { email, password, deviceName: deviceName() });
    await this.persistAndStart(session);
  }

  /** Забыт пароль: вход по ключу восстановления с новым паролем. */
  async recover(email: string, recoveryKey: string, newPassword: string): Promise<void> {
    const session = await recoverAccount(this.api, { email, recoveryKey, newPassword, deviceName: deviceName() });
    await this.persistAndStart(session);
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
    const now = () => Date.now() + this.clockOffset;
    const lastHlc = await this.store.getMeta<string>('hlc');
    this.clock = new HybridClock(stored.node, now, lastHlc);
    const doc = new Doc({ spaceId: stored.spaceId, clock: this.clock, now });
    doc.load(await this.store.loadCells(stored.spaceId));
    this.doc = doc;

    this.engine = new SyncEngine({
      api: this.api,
      store: this.store,
      doc,
      spaceId: stored.spaceId,
      keys: spaceKeys(fromB64(secrets.spaceKey)),
      onServerTime: (serverTime) => {
        this.clockOffset = serverTime - Date.now();
        void this.store.setMeta('clockOffset', this.clockOffset);
        this.clock?.rewind();
      },
      restamp: () => this.clock!.tick(),
      onStatus: (status) => this.set({ status }),
      onUnauthorized: () => void this.logout('Сессия на этом устройстве завершена. Войдите снова.'),
    });

    this.stopFns.push(
      persistLocal(doc, this.store, stored.spaceId, () => {
        void this.store.setMeta('hlc', this.clock!.current());
        // Сразу показываем, что есть неотправленное: точное число придёт после синхронизации.
        this.set({ status: { ...this.state.status, pending: this.state.status.pending + 1 } });
        this.requestSync();
      }),
      doc.subscribe((ops, origin) => {
        this.docVersion++;
        this.scheduleRemindersSoon();
        for (const fn of this.docListeners) fn();
        // Изменения из этой вкладки (свои и полученные с сервера) пересылаем остальным вкладкам.
        if (!this.fromChannel) this.channel?.postMessage({ type: 'ops', ops: [...ops] } satisfies ChannelMessage);
        void origin;
      }),
    );

    doc.ensureInbox();
    this.docVersion++;
    this.set({ phase: this.state.phase === 'recovery' ? 'recovery' : 'ready', email: stored.email, isAdmin: stored.isAdmin, notice: null });
    this.becomeLeaderWhenPossible();
  }

  // ---------- синхронизация ----------

  private becomeLeaderWhenPossible(): void {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    const lead = () => {
      this.leader = true;
      this.scheduleReminders();
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
    if (!this.engine || !this.leader) return;
    try {
      await this.engine.sync();
    } catch (err) {
      if (!(err instanceof NetworkError) && !(err instanceof ApiError && err.status === 401)) console.error(err);
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
      this.fromChannel = true;
      try {
        this.doc.applyRemote(msg.ops);
      } finally {
        this.fromChannel = false;
      }
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

  private scheduleRemindersSoon(): void {
    clearTimeout(this.remindersDebounce);
    this.remindersDebounce = setTimeout(() => this.scheduleReminders(), 500);
  }

  /**
   * Напоминания показывает только синхронизирующая вкладка, иначе одно и то же
   * уведомление пришло бы из каждой открытой вкладки.
   */
  scheduleReminders(): void {
    clearTimeout(this.reminderTimer);
    if (!this.doc || !this.leader) return;
    const now = Date.now();
    // Пропущенные за последние 10 минут (вкладка спала) тоже показываем.
    const list = remindersBetween(this.doc, now - 10 * 60_000, now + 48 * 3600_000, TZ, this.reminderDefaults());
    for (const r of list) {
      if (r.at > now) break;
      if (this.fired.has(r.key)) continue;
      this.fired.add(r.key);
      saveFired(this.fired);
      void this.fire(r);
    }
    const next = list.find((r) => r.at > now);
    // Не дольше часа: таймеры браузера в фоне неточны, пересчитываем регулярно.
    const delay = next ? Math.min(next.at - now, 3600_000) : 3600_000;
    this.reminderTimer = setTimeout(() => this.scheduleReminders(), Math.max(1000, delay));
  }

  private async fire(r: Reminder): Promise<void> {
    this.onReminder?.(r);
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

  // ---------- выход ----------

  async logout(notice: string | null = null): Promise<void> {
    // Перед выходом пробуем отправить всё, что осталось: после выхода данные устройства стираются.
    if (this.engine && notice === null) {
      try {
        await this.engine.sync();
      } catch {
        // нет сети: пользователь уже предупреждён в диалоге
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
    this.engine = null;
    this.doc = null;
    this.api.token = null;
    await this.store.clear();
    this.channel?.postMessage({ type: 'logout' } satisfies ChannelMessage);
    this.leader = false;
    this.set({ phase: 'auth', email: null, status: IDLE, notice });
  }

  /** Число операций, ещё не отправленных на сервер. */
  async pendingCount(): Promise<number> {
    if (!this.doc) return 0;
    return (await this.store.outbox(this.doc.spaceId, 10_000)).length;
  }
}

export const controller = new Controller();
