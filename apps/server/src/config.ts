import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Собранный веб-клиент рядом с сервером в репозитории или в образе. */
const BUNDLED_WEB = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  /** Путь к базе; ':memory:' для тестов. */
  readonly dbPath: string;
  /** Открытая регистрация. По умолчанию после первого пользователя только по приглашениям. */
  readonly openRegistration: boolean;
  /** На сколько мс метка операции может опережать часы сервера. */
  readonly maxClockDrift: number;
  /** Срок жизни сессии устройства, мс. */
  readonly sessionTtl: number;
  /** Каталог собранного веб-клиента; пусто, если сервер отдаёт только API. */
  readonly webDir: string;
  /** Разрешённые источники для CORS при разработке веб-клиента отдельно от сервера. */
  readonly corsOrigins: readonly string[];
  /** Сколько ежедневных снимков базы хранить; 0 — не делать. */
  readonly backupKeep: number;
  /** Контакт для push-сервисов (VAPID sub): mailto: или https:. */
  readonly vapidSubject: string;
  /**
   * Сервер стоит за обратным прокси (Caddy, nginx): адрес клиента берётся из последнего
   * значения X-Forwarded-For. Без прокси включать нельзя: заголовок подделывается.
   */
  readonly trustProxy: boolean;
  /** Адрес, которым может зарегистрироваться первый пользователь (администратор). */
  readonly adminEmail: string;
  /** Предел числа записей (ячеек) в одном пространстве. */
  readonly maxRecordsPerSpace: number;
  /** Сколько байт файлов может лежать в одном пространстве. */
  readonly maxFileBytesPerSpace: number;
  /** Предел одного файла (открытый текст), байт. */
  readonly maxFileBytes: number;
  /** Свои распространители UnifiedPush: имена хостов через запятую в DELA_PUSH_HOSTS. */
  readonly pushHosts: readonly string[];
  /** Хосты календарей iCal, которые браузеру можно загружать напрямую (connect-src в CSP). */
  readonly calendarHosts: readonly string[];
  /** Адрес, с которого открывают веб-клиент (https://tasks.example.com): нужен для passkey. */
  readonly publicUrl: string;
  /** Сколько общих проектов может создать один пользователь. */
  readonly maxSharedSpaces: number;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DELA_DATA_DIR ?? './data';
  return {
    port: Number(env.DELA_PORT ?? env.PORT ?? 8080),
    host: env.DELA_HOST ?? '0.0.0.0',
    dataDir,
    dbPath: env.DELA_DB_PATH ?? join(dataDir, 'dela.sqlite'),
    openRegistration: bool(env.DELA_OPEN_REGISTRATION, false),
    maxClockDrift: Number(env.DELA_MAX_CLOCK_DRIFT_MS ?? 60_000),
    sessionTtl: Number(env.DELA_SESSION_TTL_DAYS ?? 180) * 24 * 3600 * 1000,
    webDir: env.DELA_WEB_DIR ?? (existsSync(join(BUNDLED_WEB, 'index.html')) ? BUNDLED_WEB : ''),
    corsOrigins: (env.DELA_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    backupKeep: Number(env.DELA_BACKUP_KEEP ?? 7),
    vapidSubject: env.DELA_VAPID_SUBJECT ?? 'https://github.com/olerast67/dela',
    trustProxy: bool(env.DELA_TRUST_PROXY, false),
    adminEmail: (env.DELA_ADMIN_EMAIL ?? '').trim().toLowerCase(),
    maxRecordsPerSpace: Number(env.DELA_MAX_RECORDS_PER_SPACE ?? 500_000),
    maxFileBytesPerSpace: Number(env.DELA_MAX_FILE_MB_PER_SPACE ?? 1024) * 1024 * 1024,
    maxFileBytes: Number(env.DELA_MAX_FILE_MB ?? 100) * 1024 * 1024,
    maxSharedSpaces: Number(env.DELA_MAX_SHARED_SPACES ?? 200),
    publicUrl: (env.DELA_PUBLIC_URL ?? '').replace(/\/+$/, ''),
    pushHosts: (env.DELA_PUSH_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    calendarHosts: (env.DELA_CALENDAR_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+$/.test(h)),
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: '',
    dbPath: ':memory:',
    openRegistration: false,
    maxClockDrift: 60_000,
    sessionTtl: 24 * 3600 * 1000,
    webDir: '',
    corsOrigins: [],
    backupKeep: 0,
    vapidSubject: 'mailto:test@dela.test',
    trustProxy: false,
    adminEmail: '',
    maxRecordsPerSpace: 500_000,
    maxFileBytesPerSpace: 1024 * 1024 * 1024,
    maxFileBytes: 100 * 1024 * 1024,
    pushHosts: [],
    calendarHosts: [],
    publicUrl: 'http://localhost',
    maxSharedSpaces: 200,
    ...overrides,
  };
}
