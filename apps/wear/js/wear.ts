/**
 * Логика часов поверх ядра: вход, синхронизация, «Сегодня», выполнение и напоминания.
 * Клиент тот же, что у dela-mcp (packages/mcp/src/dela.ts): своё устройство в списке устройств,
 * ключи и кэш в файле сессии, который приложение шифрует ключом из Android Keystore.
 * Все ответы — JSON-объекты; ошибка — {error: код}.
 */
import { ApiError, NetworkError, localDate, remindersBetween, today as todayIn, type Fetcher, type TaskView } from '../../../packages/core/src/index.ts';
import { Dela, NotLoggedInError, SessionRevokedError, login } from '../../../packages/mcp/src/dela.ts';
import type { Vault } from '../../../packages/mcp/src/vault.ts';

/** Файл сессии на устройстве: приложение хранит его зашифрованным. */
export interface SessionFile {
  exists(): boolean;
  read(): string | null;
  write(json: string): void;
  remove(): void;
}

/** Тот же интерфейс, что у Vault из dela-mcp; файл пишет только этот движок, поэтому чужих изменений нет. */
class WatchVault {
  generation = 0;
  private readonly file: SessionFile;
  constructor(file: SessionFile) {
    this.file = file;
  }
  exists(): boolean {
    return this.file.exists();
  }
  read<T>(): T {
    const s = this.file.read();
    if (s === null) throw new NotLoggedInError();
    this.generation++;
    return JSON.parse(s) as T;
  }
  write(value: unknown): void {
    this.file.write(JSON.stringify(value));
    this.generation++;
  }
  remove(): void {
    this.file.remove();
    this.generation++;
  }
  changedOutside(): boolean {
    return false;
  }
}

export interface WearOptions {
  readonly file: SessionFile;
  readonly deviceName: string;
  readonly fetcher?: Fetcher;
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}

export interface Item {
  readonly id: string;
  readonly title: string;
  readonly project: string | null;
  readonly inbox: boolean;
  /** Дата срока у пользователя. */
  readonly date: string;
  readonly time: string | null;
  readonly priority: number;
  readonly recurring: boolean;
  readonly overdue: boolean;
  /** Общий проект, где у пользователя только просмотр. */
  readonly readOnly: boolean;
}

export interface Snapshot {
  readonly signedIn: true;
  readonly email: string;
  readonly server: string;
  readonly date: string;
  readonly tz: string;
  readonly offline: boolean;
  readonly pending: number;
  readonly overdue: Item[];
  readonly today: Item[];
  /** Напоминания на ближайшие двое суток: приложение ставит их будильниками AlarmManager. */
  readonly reminders: Array<{ key: string; taskId: string; at: number; title: string; alarm: boolean }>;
}

/** Напоминания расписываются на столько вперёд; периодическая синхронизация чаще. */
export const REMINDER_WINDOW = 48 * 3600_000;

/** Адрес сервера: без схемы — https; http только для localhost и адреса компьютера из эмулятора. */
export function watchServer(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '10.0.2.2'].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string {
  if (err instanceof NotLoggedInError || err instanceof SessionRevokedError) return 'signed_out';
  if (err instanceof ApiError) return err.code;
  if (err instanceof NetworkError) return 'network';
  return 'internal';
}

export function createWear(o: WearOptions) {
  const vault = new WatchVault(o.file) as unknown as Vault;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  let dela: Dela | null = null;
  let offline = false;
  let pending = 0;

  async function open(): Promise<Dela> {
    if (!dela || dela.stale) dela = await Dela.open(vault, { ...(o.fetcher ? { fetcher: o.fetcher } : {}), log });
    return dela;
  }

  /** Синхронизация; без сети ответ собирается из кэша. Отозванное устройство — ошибка signed_out. */
  async function sync(d: Dela): Promise<void> {
    try {
      const r = await d.sync();
      offline = r.offline;
      pending = r.pending;
    } catch (err) {
      if (err instanceof SessionRevokedError) {
        dela = null;
        throw err;
      }
      offline = true;
      log(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function snapshot(d: Dela): Snapshot {
    const ws = d.ws;
    const tz = ws.personal.timeZone;
    const t = now();
    const date = todayIn(tz, t);
    const item = (task: TaskView, overdue: boolean): Item => {
      const p = ws.project(task.projectId);
      return {
        id: task.id,
        title: task.title,
        project: p && !p.isInbox ? p.name : null,
        inbox: p?.isInbox ?? false,
        date: task.due ? localDate(task.due, tz) : date,
        time: task.due?.time ?? null,
        priority: task.priority,
        recurring: task.recurrence !== null,
        overdue,
        readOnly: d.role(task.projectId) === 'viewer',
      };
    };
    const view = ws.today(date, tz);
    return {
      signedIn: true,
      email: d.email,
      server: d.server,
      date,
      tz,
      offline,
      pending,
      overdue: view.overdue.map((x) => item(x, true)),
      today: view.today.map((x) => item(x, false)),
      reminders: remindersBetween(ws, t, t + REMINDER_WINDOW, tz).map((r) => ({ key: r.key, taskId: r.taskId, at: r.at, title: r.title, alarm: r.alarm === true })),
    };
  }

  const methods: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    async status() {
      if (!vault.exists()) return { signedIn: false };
      const d = await open();
      return { signedIn: true, email: d.email, server: d.server };
    },

    async login(a) {
      const server = watchServer(String(a.server ?? ''));
      if (!server) return { error: 'bad_server' };
      const totp = typeof a.totp === 'string' && a.totp.trim() ? a.totp.trim() : undefined;
      await login(vault, {
        server,
        email: String(a.email ?? ''),
        password: String(a.password ?? ''),
        deviceName: o.deviceName,
        ...(totp ? { totp } : {}),
        ...(o.fetcher ? { fetcher: o.fetcher } : {}),
      });
      dela = null;
      const d = await open();
      await sync(d);
      return snapshot(d);
    },

    /** «Сегодня» из кэша, без сети: для мгновенного показа при запуске. */
    async today() {
      return snapshot(await open());
    },

    async sync() {
      const d = await open();
      await sync(d);
      return snapshot(d);
    },

    /** Выполнить задачу: повторяющаяся переносится на следующий раз, как в приложении. */
    async complete(a) {
      const d = await open();
      const id = String(a.id ?? '');
      const task = d.ws.task(id);
      if (!task) return { error: 'not_found' };
      if (d.role(task.projectId) === 'viewer') return { error: 'read_only' };
      if (task.completedAt === null) d.ws.completeTask(id);
      d.save();
      await sync(d);
      return snapshot(d);
    },

    async logout() {
      if (!vault.exists()) return { signedIn: false };
      try {
        const d = await open();
        await d.logout();
      } catch {
        vault.remove();
      }
      dela = null;
      return { signedIn: false };
    },
  };

  let queue: Promise<unknown> = Promise.resolve();

  /** Вызовы идут по одному: приложение может позвать движок из экрана, фоновой работы и уведомления. */
  function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      const fn = methods[name];
      if (!fn) return { error: 'unknown_method' };
      try {
        return (await fn(args)) as Record<string, unknown>;
      } catch (err) {
        const code = errorCode(err);
        if (code === 'signed_out') dela = null;
        if (code === 'internal') log(`${name} failed: ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)}`);
        return { error: code, ...(err instanceof Error ? { message: err.message } : {}) };
      }
    };
    const p = queue.then(run, run);
    queue = p;
    return p;
  }

  return { call };
}
