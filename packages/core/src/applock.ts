/**
 * Блокировка приложения PIN-кодом: правила, без хранения и интерфейса.
 * Состояние лежит на устройстве и не синхронизируется: у каждого телефона и компьютера свой PIN.
 */

export interface LockConfig {
  /** Хеш PIN (hashPin). */
  readonly pinHash: string;
  /** Через сколько минут в фоне приложение блокируется; 0 — сразу. */
  readonly timeoutMin: number;
  /** Разблокировка отпечатком или лицом (только в приложении для телефона). */
  readonly biometric: boolean;
  /** Неверных попыток подряд. */
  readonly failures: number;
  /** До какого момента ввод PIN закрыт после серии ошибок (мс). */
  readonly blockedUntil: number;
}

export const LOCK_TIMEOUTS = [0, 1, 5, 15, 60] as const;

/** После стольких неверных PIN подряд данные устройства стираются, нужен вход с паролем. */
export const MAX_PIN_FAILURES = 10;

export const PIN_RE = /^\d{4,8}$/;

export function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin);
}

/** Пауза после очередной ошибки: первые 4 попытки без паузы, дальше 30 с, 1 мин, 5 мин... */
export function failureDelayMs(failures: number): number {
  if (failures < 5) return 0;
  const steps = [30_000, 60_000, 300_000, 900_000];
  return steps[Math.min(failures - 5, steps.length - 1)]!;
}

export type PinResult =
  | { readonly kind: 'ok'; readonly config: LockConfig }
  | { readonly kind: 'wrong'; readonly config: LockConfig; readonly left: number }
  | { readonly kind: 'blocked'; readonly config: LockConfig; readonly waitMs: number }
  | { readonly kind: 'wipe' };

/**
 * Применить результат проверки PIN. verify вызывается, только если ввод сейчас не закрыт паузой:
 * так серия попыток не сокращает паузу.
 */
export function applyPinAttempt(config: LockConfig, now: number, verify: () => boolean): PinResult {
  if (config.blockedUntil > now) return { kind: 'blocked', config, waitMs: config.blockedUntil - now };
  if (verify()) return { kind: 'ok', config: { ...config, failures: 0, blockedUntil: 0 } };
  const failures = config.failures + 1;
  if (failures >= MAX_PIN_FAILURES) return { kind: 'wipe' };
  const next = { ...config, failures, blockedUntil: now + failureDelayMs(failures) };
  return { kind: 'wrong', config: next, left: MAX_PIN_FAILURES - failures };
}

/** Нужно ли заблокировать приложение после возвращения из фона. */
export function lockAfterBackground(config: LockConfig | null, hiddenAt: number | null, now: number): boolean {
  if (!config || hiddenAt === null) return false;
  return now - hiddenAt >= config.timeoutMin * 60_000;
}
