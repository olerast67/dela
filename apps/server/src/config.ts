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
    ...overrides,
  };
}
