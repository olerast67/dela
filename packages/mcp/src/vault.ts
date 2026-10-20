/**
 * Файл сессии dela-mcp: токен, ключи аккаунта и пространств, кэш задач. Всё зашифровано AES-256-GCM
 * ключом этого компьютера. Ключ лежит в системном хранилище: DPAPI на Windows, связка ключей на macOS,
 * Secret Service (secret-tool) на Linux. Без хранилища — отдельный файл с правами 600.
 *
 * Нативных модулей нет: к хранилищу обращаются системные программы, секрет идёт через stdin, а не в аргументах.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Keystore = 'dpapi' | 'keychain' | 'secret-service' | 'file';

const SERVICE = 'dela-mcp';
const ACCOUNT = 'local-key';
const AAD = Buffer.from('dela-mcp session v1');

interface SealedFile {
  readonly v: 1;
  readonly keystore: Keystore;
  /** Ключ, зашифрованный DPAPI (только Windows): без входа в эту учётную запись Windows не открывается. */
  readonly dpapi?: string;
  readonly iv: string;
  readonly data: string;
}

/** Папка настроек: %APPDATA%\dela-mcp на Windows, иначе ~/.config/dela-mcp. DELA_MCP_HOME — для тестов. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DELA_MCP_HOME) return env.DELA_MCP_HOME;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'dela-mcp');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dela-mcp');
}

function run(cmd: string, args: readonly string[], input?: string): string {
  return execFileSync(cmd, args, { input: input ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 20_000 });
}

function powershell(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell.exe';
}

// Дополнительная энтропия DPAPI: блоб открывается только с ней, то есть этой программой.
const DPAPI = (fn: 'Protect' | 'Unprotect') =>
  `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
  `$e=[Text.Encoding]::UTF8.GetBytes('${SERVICE}'); ` +
  `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${fn}($b,$e,'CurrentUser')))`;

function dpapi(fn: 'Protect' | 'Unprotect', b64: string): string {
  return run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', DPAPI(fn)], b64).trim();
}

/** Положить ключ в системное хранилище и прочитать обратно: хранилище, которое не вернуло ключ, не годится. */
function storeKey(key: Buffer, dir: string): { keystore: Keystore; dpapi?: string } {
  const hex = key.toString('hex');
  const forced = process.env.DELA_MCP_KEYSTORE === 'file';
  try {
    if (!forced && process.platform === 'win32') {
      const blob = dpapi('Protect', key.toString('base64'));
      if (dpapi('Unprotect', blob) === key.toString('base64')) return { keystore: 'dpapi', dpapi: blob };
    } else if (!forced && process.platform === 'darwin') {
      // security -i читает команду из stdin: ключ не виден в списке процессов.
      run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${hex}\n`);
      if (readKeystore('keychain') === hex) return { keystore: 'keychain' };
    } else if (!forced && process.platform === 'linux') {
      run('secret-tool', ['store', '--label=Dela MCP', 'service', SERVICE, 'account', ACCOUNT], hex);
      if (readKeystore('secret-service') === hex) return { keystore: 'secret-service' };
    }
  } catch {
    // хранилища нет или оно заперто: ниже файл с ключом
  }
  const path = join(dir, 'key');
  writeFileSync(path, hex, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { keystore: 'file' };
}

function readKeystore(kind: 'keychain' | 'secret-service'): string {
  return kind === 'keychain'
    ? run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']).trim()
    : run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]).trim();
}

function loadKey(file: SealedFile, dir: string): Buffer {
  let hex: string;
  switch (file.keystore) {
    case 'dpapi':
      return Buffer.from(dpapi('Unprotect', file.dpapi ?? ''), 'base64');
    case 'keychain':
    case 'secret-service':
      hex = readKeystore(file.keystore);
      break;
    case 'file':
      hex = readFileSync(join(dir, 'key'), 'utf8').trim();
      break;
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('local key not found');
  return key;
}

export class Vault {
  readonly dir: string;
  private key: Buffer | null = null;
  private meta: { keystore: Keystore; dpapi?: string } | null = null;

  constructor(dir: string = configDir()) {
    this.dir = dir;
  }

  get path(): string {
    return join(this.dir, 'session.json');
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  get keystore(): Keystore | null {
    return this.meta?.keystore ?? null;
  }

  /** Отметка файла (время и размер): по ней видно, что файл записал другой процесс или новый вход. */
  private stamp(): string | null {
    try {
      const st = statSync(this.path);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  private lastStamp: string | null = null;
  /** Растёт с каждым чтением и записью через этот объект: так сессия видит, что файл после неё переписан. */
  generation = 0;

  /** Файл изменён не этим объектом после его последнего чтения или записи. */
  changedOutside(): boolean {
    return this.stamp() !== this.lastStamp;
  }

  /** Прочитать и расшифровать файл сессии. */
  read<T>(): T {
    const stamp = this.stamp();
    const file = JSON.parse(readFileSync(this.path, 'utf8')) as SealedFile;
    if (file.v !== 1) throw new Error('unknown session file version');
    const data = Buffer.from(file.data, 'base64');
    const open = (key: Buffer): T => {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
      d.setAAD(AAD);
      d.setAuthTag(data.subarray(data.length - 16));
      return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8')) as T;
    };
    let value: T | undefined;
    // Ключ из памяти подходит, пока файл не перезаписан новым входом; иначе он берётся из хранилища заново.
    if (this.key && this.meta?.keystore === file.keystore && this.meta.dpapi === file.dpapi) {
      try {
        value = open(this.key);
      } catch {
        value = undefined;
      }
    }
    if (value === undefined) {
      this.key = loadKey(file, this.dir);
      value = open(this.key);
    }
    this.meta = { keystore: file.keystore, ...(file.dpapi ? { dpapi: file.dpapi } : {}) };
    this.lastStamp = stamp;
    this.generation++;
    return value;
  }

  /** Зашифровать и записать. Первая запись создаёт ключ и кладёт его в хранилище. */
  write(value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!this.key || !this.meta) {
      this.key = randomBytes(32);
      this.meta = storeKey(this.key, this.dir);
    }
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(AAD);
    const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final(), c.getAuthTag()]);
    const file: SealedFile = { v: 1, ...this.meta, iv: iv.toString('base64'), data: data.toString('base64') };
    // Через временный файл: оборванная запись не портит сессию.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.lastStamp = this.stamp();
    this.generation++;
  }

  /** Стереть сессию, файл ключа и запись в хранилище. */
  remove(): void {
    let keystore = this.meta?.keystore;
    if (!keystore && this.exists()) {
      try {
        keystore = (JSON.parse(readFileSync(this.path, 'utf8')) as SealedFile).keystore;
      } catch {
        // испорченный файл всё равно удаляется
      }
    }
    rmSync(this.path, { force: true });
    rmSync(join(this.dir, 'key'), { force: true });
    try {
      if (keystore === 'keychain') run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
      if (keystore === 'secret-service') run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
    } catch {
      // записи уже нет
    }
    this.key = null;
    this.meta = null;
    this.lastStamp = null;
    this.generation++;
  }
}
