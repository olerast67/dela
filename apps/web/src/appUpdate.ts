/**
 * Обновление приложения для Android, поставленного APK из выпусков GitHub (не из магазина).
 * Версия берётся из latest.json последнего выпуска (тот же файл читает программа для Windows),
 * APK сверяется по SHA-256 из него же или из SHA256SUMS.txt. Сеть и установка — в плагине DelaUpdate:
 * из WebView файлы GitHub не прочитать (нет CORS), и плагин сам не пускает скачивание мимо выпусков Dela.
 */
import { nativePlugin, platform } from './platform.ts';

export const RELEASES = 'https://github.com/olerast67/dela/releases/';
export const LATEST_JSON = `${RELEASES}latest/download/latest.json`;
const SUMS = (version: string) => `${RELEASES}download/v${version}/SHA256SUMS.txt`;
const DAY = 24 * 60 * 60 * 1000;

/** Хосты, на которые GitHub переадресует скачивание файла выпуска. */
const ASSET_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/** Адрес, с которого можно начинать скачивание: только выпуски репозитория Dela по https. */
export function isReleaseUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // Путь сверяется после разбора URL: «..» и %2e%2e уже свёрнуты, логин и порт запрещены.
  return u.protocol === 'https:' && u.hostname === 'github.com' && u.port === '' && !u.username && !u.password && u.pathname.startsWith('/olerast67/dela/releases/');
}

/** Адрес переадресации при скачивании: выпуск Dela или хранилище файлов выпусков GitHub. */
export function isAllowedRedirect(url: string): boolean {
  if (isReleaseUrl(url)) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.port === '' && !u.username && !u.password && ASSET_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function parts(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

/** Сравнение семантических версий: >0 если a новее b. Версия с суффиксом (1.2.0-beta) старше 1.2.0 не бывает. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** Отладочная сборка (versionName с -debug) ставится рядом с обычной и не обновляется. */
export function isDebugVersion(v: string): boolean {
  return /-debug$/.test(v);
}

export interface ApkRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const apkName = (version: string) => `Dela-${version}-android.apk`;

/** Версия из latest.json; null, если файл не тот. */
export function latestVersion(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const v = (json as { version?: unknown }).version;
  return typeof v === 'string' && parts(v) ? v.replace(/^v/, '') : null;
}

/** APK для телефона из поля android в latest.json. Чужой адрес или кривая сумма — null. */
export function apkFromLatest(json: unknown): ApkRelease | null {
  const version = latestVersion(json);
  const a = (json as { android?: unknown } | null)?.android;
  if (!version || typeof a !== 'object' || a === null) return null;
  const { url, sha256 } = a as { url?: unknown; sha256?: unknown };
  if (typeof url !== 'string' || typeof sha256 !== 'string') return null;
  const sum = sha256.toLowerCase();
  if (!isReleaseUrl(url) || !HEX64.test(sum)) return null;
  return { version, url, sha256: sum };
}

/** APK телефона из SHA256SUMS.txt выпуска: строка «<sha256>  Dela-<версия>-android.apk» (часы и wear не подходят). */
export function apkFromSums(version: string, sums: string): ApkRelease | null {
  const name = apkName(version);
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (m && m[2] === name) return { version, url: `${RELEASES}download/v${version}/${name}`, sha256: m[1]!.toLowerCase() };
  }
  return null;
}

/** Запомненная найденная версия: проверяется так же, как latest.json, адрес и сумма могли испортиться. */
export function cachedRelease(raw: string | null): ApkRelease | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<ApkRelease> | null;
    return r ? apkFromLatest({ version: r.version, android: { url: r.url, sha256: r.sha256 } }) : null;
  } catch {
    return null;
  }
}

/** Пора ли проверять: при запуске, но не чаще раза в сутки. */
export function checkDue(now: number, last: number | null): boolean {
  return last === null || !(now - last < DAY) || last > now;
}

// ---------- плагин и настройки ----------

export interface DelaUpdatePlugin {
  info(): Promise<{ version: string; enabled: boolean }>;
  fetchText(o: { url: string }): Promise<{ text: string }>;
  download(o: { url: string; sha256: string; version: string }): Promise<void>;
  install(o: { version: string }): Promise<void>;
  addListener(event: 'progress', cb: (e: { done: number; total: number }) => void): Promise<{ remove(): Promise<void> }>;
}

const plugin = () => nativePlugin<DelaUpdatePlugin>('DelaUpdate');

const ENABLED_KEY = 'appUpdateCheck';
const LAST_KEY = 'appUpdateLast';
const FOUND_KEY = 'appUpdateFound';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // без localStorage проверка просто пройдёт при следующем запуске ещё раз
  }
}

/** Настройка «Проверять обновления», по умолчанию включена. */
export function updateCheckEnabled(): boolean {
  return read(ENABLED_KEY) !== '0';
}

export function setUpdateCheckEnabled(on: boolean): void {
  write(ENABLED_KEY, on ? null : '0');
}

/** Установленная версия и можно ли обновляться (не отладочная сборка и не сборка F-Droid). null — не Android. */
export async function appUpdateInfo(): Promise<{ version: string; enabled: boolean } | null> {
  if (platform() !== 'capacitor') return null;
  const p = (await plugin())?.p;
  if (!p) return null;
  const info = await p.info().catch(() => null);
  if (!info) return null;
  return { version: info.version, enabled: info.enabled && !isDebugVersion(info.version) };
}

async function fetchRelease(p: DelaUpdatePlugin): Promise<ApkRelease | null> {
  const latest: unknown = JSON.parse((await p.fetchText({ url: LATEST_JSON })).text);
  const fromJson = apkFromLatest(latest);
  if (fromJson) return fromJson;
  // Старые выпуски без поля android: сумма из SHA256SUMS.txt того же выпуска.
  const version = latestVersion(latest);
  if (!version) return null;
  return apkFromSums(version, (await p.fetchText({ url: SUMS(version) })).text);
}

export interface AndroidUpdate {
  readonly version: string;
  /** Скачать APK, сверить сумму и открыть системную установку. Ошибка с code: permission, checksum, network. */
  install(onProgress?: (share: number) => void): Promise<void>;
}

function asUpdate(r: ApkRelease): AndroidUpdate {
  return {
    version: r.version,
    async install(onProgress) {
      const p = (await plugin())?.p;
      if (!p) throw Object.assign(new Error('no plugin'), { code: 'failed' });
      const h = onProgress ? await p.addListener('progress', (e) => onProgress(e.total > 0 ? e.done / e.total : 0)) : null;
      try {
        await p.download({ url: r.url, sha256: r.sha256, version: r.version });
      } finally {
        void h?.remove();
      }
      await p.install({ version: r.version });
    },
  };
}

/**
 * Есть ли новая версия для телефона. force — кнопка в настройках: без учёта суток и выключателя.
 * Найденную версию помним: при следующем запуске в тот же день плашка покажется без сети.
 */
export async function checkAndroidUpdate(force = false, now = Date.now()): Promise<AndroidUpdate | null> {
  const info = await appUpdateInfo();
  if (!info?.enabled) return null;
  if (!force && !updateCheckEnabled()) return null;
  const lastRaw = read(LAST_KEY);
  const last = lastRaw === null ? null : Number(lastRaw);
  let found: ApkRelease | null = null;
  if (force || checkDue(now, Number.isFinite(last) ? last : null)) {
    const p = (await plugin())?.p;
    if (!p) return null;
    found = await fetchRelease(p);
    write(LAST_KEY, String(now));
    write(FOUND_KEY, found ? JSON.stringify(found) : null);
  } else {
    found = cachedRelease(read(FOUND_KEY));
  }
  return found && compareVersions(found.version, info.version) > 0 ? asUpdate(found) : null;
}

/** Сообщение об ошибке обновления по коду из плагина. */
export function updateErrorCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : 'failed';
}
