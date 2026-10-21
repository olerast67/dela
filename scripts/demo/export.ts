/**
 * Выгрузка демо-аккаунта для вызова «прочитай мою задачу»: всё, что сервер хранит о нём, кроме того,
 * что дало бы перебор пароля офлайн или раскрыло других людей. Запускается на сервере рядом с базой,
 * открывает её только на чтение. Зависит только от node:sqlite: файл можно скопировать в контейнер.
 *
 *   node export.ts --db /data/dela.sqlite (--email ADDR | --user ID) [--out dela-challenge.json | --out -]
 *
 * Перед записью файла выгрузка проверяется (checkExport); при любой находке файл не пишется.
 * Таблицы и колонки: TABLE_POLICY ниже и docs/challenge.md.
 */
import { DatabaseSync } from 'node:sqlite';
import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Версия схемы, для которой составлен список таблиц. Новая миграция — пересмотреть TABLE_POLICY. */
export const KNOWN_SCHEMA = 14;

/** Что из каждой таблицы попадает в выгрузку. Таблица, которой здесь нет, останавливает выгрузку. */
export const TABLE_POLICY: Readonly<Record<string, string>> = {
  meta: 'нет: секрет сервера (поддельные соли) и ключи VAPID',
  users:
    'частично: id, created_at, is_admin, открытые ключи (bundle.publicKey, sign_key), bundle.secretKeyByMaster и параметры kdf. ' +
    'Нет: почта (заменена на «demo»), auth_salt/auth_hash, recovery_salt/recovery_hash, bundle.salt, bundle.masterByPassword, ' +
    'bundle.masterByRecovery (перебор пароля офлайн), totp_* (секрет TOTP)',
  devices: 'частично: число устройств и их времена created_at/last_seen_at/revoked_at; id и имена заменены на device-N',
  sessions: 'нет: хеши токенов',
  invites: 'нет: приглашения и их авторы',
  spaces:
    'да для пространств, где демо-аккаунт единственный участник: id, kind, created_at, last_seq, key_version, sync_bytes (сумма длин шифротекста); ' +
    'created_by только как «свой/чужой»',
  members: 'да для тех же пространств: role, key_kind, key (ключ пространства, обёрнутый мастер-ключом)',
  envelopes: 'да для тех же пространств: seq, slot, hlc, payload (шифротекст)',
  push_subscriptions: 'нет: адреса push-сервисов устройств',
  push_schedule: 'нет: расписание напоминаний устройств (время и отдельно зашифрованный текст)',
  passkeys: 'нет: ключи WebAuthn и мастер-ключ, обёрнутый секретом PRF',
  files: 'да для тех же пространств: id, size, parts, complete, created_at, шифротекст; created_by только как «свой/чужой»',
  file_parts: 'да для файлов выше: шифротекст частей',
  rotations: 'нет: незаконченная смена ключа живёт до 30 минут',
  rotation_envelopes: 'нет: то же',
};

/** Колонки, для которых составлено правило. Новая колонка останавливает выгрузку. */
export const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  devices: ['id', 'user_id', 'name', 'created_at', 'last_seen_at', 'revoked_at'],
  envelopes: ['space_id', 'slot', 'hlc', 'payload', 'seq'],
  file_parts: ['space_id', 'file_id', 'idx', 'data'],
  files: ['space_id', 'id', 'size', 'created_by', 'created_at', 'data', 'parts', 'complete', 'touched_at'],
  invites: ['code_hash', 'created_by', 'created_at', 'expires_at', 'used_by', 'used_at'],
  members: ['space_id', 'user_id', 'role', 'key_kind', 'key'],
  meta: ['key', 'value'],
  passkeys: ['id', 'user_id', 'name', 'public_key', 'counter', 'transports', 'wrapped_master', 'created_at', 'last_used_at'],
  push_schedule: ['device_id', 'id', 'fire_at', 'payload'],
  push_subscriptions: ['device_id', 'endpoint', 'p256dh', 'auth', 'created_at', 'kind', 'offsets'],
  rotation_envelopes: ['rotation_id', 'slot', 'hlc', 'payload'],
  rotations: ['id', 'space_id', 'key_version', 'created_at'],
  sessions: ['token_hash', 'device_id', 'user_id', 'created_at', 'expires_at'],
  spaces: ['id', 'kind', 'created_by', 'created_at', 'last_seq', 'key_version', 'sync_bytes'],
  users: [
    'id', 'email', 'auth_salt', 'auth_hash', 'bundle', 'is_admin', 'created_at', 'recovery_salt', 'recovery_hash',
    'totp_secret', 'totp_enabled', 'totp_last', 'recovery_totp', 'sign_key',
  ],
};

export function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>).map((c) => String(c.name));
}

export interface ChallengeEnvelope {
  readonly seq: number;
  readonly slot: string;
  readonly hlc: string;
  readonly payload: string;
}

export interface ChallengeFile {
  readonly id: string;
  readonly size: number;
  readonly parts: number;
  readonly complete: boolean;
  readonly createdAt: number;
  readonly uploadedBySelf: boolean;
  /** Шифротекст файла формата v1 (одним куском) или части v2 по порядку. */
  readonly data: readonly string[];
}

export interface ChallengeSpace {
  readonly id: string;
  readonly kind: 'personal' | 'shared';
  readonly createdAt: number;
  readonly createdBySelf: boolean;
  readonly role: string;
  readonly lastSeq: number;
  readonly keyVersion: number;
  /** Сумма длин шифротекста в журнале (квота сервера): видна серверу и так. */
  readonly syncBytes: number;
  readonly keyKind: string;
  readonly key: string;
  readonly envelopes: readonly ChallengeEnvelope[];
  readonly files: readonly ChallengeFile[];
}

export interface ChallengeSummary {
  readonly spaces: number;
  readonly spacesByKind: Readonly<Record<string, number>>;
  readonly sharedSpacesWithOthersSkipped: number;
  /** Записей (ячеек) в журнале сейчас: по одной на слот. */
  readonly envelopes: number;
  /** Сколько операций сервер принял за всё время (last_seq): разница — перезаписанные ячейки. */
  readonly acceptedOps: number;
  readonly overwritten: number;
  /** Вид записи (задача, проект, ...) и имя поля зашифрованы вместе со значением: серверу не видны. */
  readonly recordKinds: null;
  readonly payloadBytes: {
    readonly total: number;
    readonly min: number;
    readonly median: number;
    readonly max: number;
    /** Длина шифротекста → число записей. Длина = 40 + 64·k: открытый текст дополнен до 64 байт. */
    readonly histogram: Readonly<Record<string, number>>;
  };
  readonly hlc: {
    readonly first: string | null;
    readonly last: string | null;
    /** Операций по дням (UTC) по физическому времени метки. */
    readonly byDay: Readonly<Record<string, number>>;
    /** Разных id узлов в метках: сколько экземпляров клиента писали. */
    readonly nodes: number;
  };
  readonly devices: number;
  readonly devicesActive: number;
  readonly files: number;
  readonly fileBytes: number;
}

export interface ChallengeExport {
  readonly format: 'dela-challenge/1';
  readonly exportedAt: number;
  readonly schemaVersion: number;
  readonly account: {
    readonly id: string;
    readonly email: 'demo';
    readonly createdAt: number;
    readonly isAdmin: boolean;
    readonly kdf: { readonly alg: string; readonly ops: number; readonly mem: number };
    readonly publicKey: string;
    readonly secretKeyByMaster: string;
    readonly signKey: string | null;
  };
  readonly devices: ReadonlyArray<{ readonly name: string; readonly createdAt: number; readonly lastSeenAt: number; readonly revokedAt: number | null }>;
  readonly spaces: readonly ChallengeSpace[];
  readonly summary: ChallengeSummary;
}

export interface ExportTarget {
  readonly email?: string;
  readonly userId?: string;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

type Row = Record<string, unknown>;

const b64 = (v: unknown): string => Buffer.from(v as Uint8Array).toString('base64');
const num = (v: unknown): number => Number(v);

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map((r) => String(r.name));
}

export function exportChallenge(db: DatabaseSync, target: ExportTarget, options: { now?: number; allowSchema?: boolean } = {}): ChallengeExport {
  const version = num((db.prepare('PRAGMA user_version').get() as Row).user_version);
  if (version !== KNOWN_SCHEMA && !options.allowSchema) {
    throw new ExportError(`схема базы v${version}, список таблиц составлен для v${KNOWN_SCHEMA}: пересмотрите TABLE_POLICY`);
  }
  const unknown = tables(db).filter((t) => !(t in TABLE_POLICY));
  if (unknown.length > 0) throw new ExportError(`таблицы без правила выгрузки: ${unknown.join(', ')}`);
  for (const t of tables(db)) {
    const extra = columnsOf(db, t).filter((c) => !TABLE_COLUMNS[t]?.includes(c));
    if (extra.length > 0) throw new ExportError(`колонки без правила выгрузки: ${t}.${extra.join(`, ${t}.`)}`);
  }

  const cols = 'id, bundle, is_admin, created_at, sign_key, totp_enabled';
  const user = (
    target.userId !== undefined
      ? db.prepare(`SELECT ${cols} FROM users WHERE id = ?`).get(target.userId)
      : db.prepare(`SELECT ${cols} FROM users WHERE email = ?`).get((target.email ?? '').trim().toLowerCase())
  ) as Row | undefined;
  if (!user) throw new ExportError('пользователь не найден');
  // Демо-аккаунт с TOTP не выгружается: при нём вызов зависел бы от второго фактора, а не от шифрования.
  if (num(user.totp_enabled) === 1) throw new ExportError('у аккаунта включён TOTP: выключите его перед выгрузкой');
  const userId = String(user.id);
  const bundle = JSON.parse(String(user.bundle)) as { kdf: { alg: string; ops: number; mem: number }; publicKey: string; secretKeyByMaster: string };

  const devices = (db.prepare('SELECT created_at, last_seen_at, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at, id').all(userId) as Row[]).map((d, i) => ({
    name: `device-${i + 1}`,
    createdAt: num(d.created_at),
    lastSeenAt: num(d.last_seen_at),
    revokedAt: d.revoked_at === null ? null : num(d.revoked_at),
  }));

  const memberships = db
    .prepare(
      `SELECT s.id, s.kind, s.created_by, s.created_at, s.last_seq, s.key_version, s.sync_bytes, m.role, m.key_kind, m.key,
              (SELECT count(*) FROM members x WHERE x.space_id = s.id) AS members
       FROM spaces s JOIN members m ON m.space_id = s.id AND m.user_id = ?
       ORDER BY s.created_at, s.id`,
    )
    .all(userId) as Row[];
  const envelopesOf = db.prepare('SELECT seq, slot, hlc, payload FROM envelopes WHERE space_id = ? ORDER BY seq');
  const filesOf = db.prepare('SELECT id, size, parts, complete, created_by, created_at, data FROM files WHERE space_id = ? ORDER BY created_at, id');
  const partsOf = db.prepare('SELECT data FROM file_parts WHERE space_id = ? AND file_id = ? ORDER BY idx');

  const spaces: ChallengeSpace[] = [];
  let skipped = 0;
  for (const s of memberships) {
    // Общее пространство с другими участниками — их данные: не выгружаем.
    if (num(s.members) !== 1) {
      skipped++;
      continue;
    }
    const id = String(s.id);
    const envelopes = (envelopesOf.all(id) as Row[]).map((e) => ({ seq: num(e.seq), slot: String(e.slot), hlc: String(e.hlc), payload: b64(e.payload) }));
    const files = (filesOf.all(id) as Row[]).map((f): ChallengeFile => {
      const parts = num(f.parts);
      return {
        id: String(f.id),
        size: num(f.size),
        parts,
        complete: num(f.complete) === 1,
        createdAt: num(f.created_at),
        uploadedBySelf: f.created_by === userId,
        data: parts > 0 ? (partsOf.all(id, String(f.id)) as Row[]).map((p) => b64(p.data)) : [b64(f.data)],
      };
    });
    spaces.push({
      id,
      kind: s.kind === 'shared' ? 'shared' : 'personal',
      createdAt: num(s.created_at),
      createdBySelf: s.created_by === userId,
      role: String(s.role),
      lastSeq: num(s.last_seq),
      keyVersion: num(s.key_version),
      syncBytes: num(s.sync_bytes),
      keyKind: String(s.key_kind),
      key: String(s.key),
      envelopes,
      files,
    });
  }

  const base = {
    format: 'dela-challenge/1' as const,
    exportedAt: options.now ?? Date.now(),
    schemaVersion: version,
    account: {
      id: userId,
      email: 'demo' as const,
      createdAt: num(user.created_at),
      isAdmin: num(user.is_admin) === 1,
      kdf: { alg: String(bundle.kdf.alg), ops: num(bundle.kdf.ops), mem: num(bundle.kdf.mem) },
      publicKey: String(bundle.publicKey),
      secretKeyByMaster: String(bundle.secretKeyByMaster),
      signKey: user.sign_key === null ? null : String(user.sign_key),
    },
    devices,
    spaces,
  };
  return { ...base, summary: summarize(base.spaces, devices, skipped) };
}

const HLC_RE = /^(\d{15})-[0-9a-z]{4}-([0-9a-f]{16})$/;

export function summarize(spaces: readonly ChallengeSpace[], devices: ChallengeExport['devices'], skipped: number): ChallengeSummary {
  const sizes: number[] = [];
  const histogram: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  const nodes = new Set<string>();
  let first: number | null = null;
  let last: number | null = null;
  const byKind: Record<string, number> = {};
  let files = 0;
  let fileBytes = 0;
  for (const s of spaces) {
    byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    for (const e of s.envelopes) {
      const len = Buffer.from(e.payload, 'base64').length;
      sizes.push(len);
      histogram[len] = (histogram[len] ?? 0) + 1;
      const m = HLC_RE.exec(e.hlc);
      if (!m) continue;
      const wall = Number(m[1]);
      nodes.add(m[2]!);
      first = first === null ? wall : Math.min(first, wall);
      last = last === null ? wall : Math.max(last, wall);
      const day = new Date(wall).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }
    for (const f of s.files) {
      files++;
      fileBytes += f.size;
    }
  }
  sizes.sort((a, b) => a - b);
  const envelopes = sizes.length;
  const acceptedOps = spaces.reduce((n, s) => n + s.lastSeq, 0);
  const sortedDays = Object.fromEntries(Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)));
  return {
    spaces: spaces.length,
    spacesByKind: byKind,
    sharedSpacesWithOthersSkipped: skipped,
    envelopes,
    acceptedOps,
    overwritten: acceptedOps - envelopes,
    recordKinds: null,
    payloadBytes: {
      total: sizes.reduce((a, b) => a + b, 0),
      min: sizes[0] ?? 0,
      median: sizes[Math.floor(sizes.length / 2)] ?? 0,
      max: sizes[sizes.length - 1] ?? 0,
      histogram,
    },
    hlc: {
      first: first === null ? null : new Date(first).toISOString(),
      last: last === null ? null : new Date(last).toISOString(),
      byDay: sortedDays,
      nodes: nodes.size,
    },
    devices: devices.length,
    devicesActive: devices.filter((d) => d.revokedAt === null).length,
    files,
    fileBytes,
  };
}

// ---------- проверка ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLOT_RE = /^[0-9a-f]{32}$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Конверт: nonce 24 + тег 16 + открытый текст, дополненный до 64 байт. */
const ENVELOPE_OVERHEAD = 40;
const PAD_BLOCK = 64;

/** Похоже ли на шифротекст: строгий base64 и байты, которые не читаются как текст UTF-8. */
function ciphertextProblem(value: string, minBytes: number): string | null {
  if (!B64_RE.test(value)) return 'не base64';
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minBytes) return `короче ${minBytes} байт`;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'читается как текст UTF-8';
  } catch {
    return null;
  }
}

/** Допустимые строки по имени поля; любое другое строковое поле — находка. */
const STRING_RULES: Readonly<Record<string, (v: string) => string | null>> = {
  format: (v) => (v === 'dela-challenge/1' ? null : 'неизвестный формат'),
  id: (v) => (UUID_RE.test(v) ? null : 'не id'),
  email: (v) => (v === 'demo' ? null : 'почта не заменена'),
  alg: (v) => (/^argon2id\d+$/.test(v) ? null : 'неизвестный алгоритм'),
  publicKey: (v) => (B64_RE.test(v) && Buffer.from(v, 'base64').length === 32 ? null : 'не открытый ключ'),
  signKey: (v) => (B64_RE.test(v) && Buffer.from(v, 'base64').length === 32 ? null : 'не открытый ключ'),
  secretKeyByMaster: (v) => ciphertextProblem(v, 48),
  key: (v) => ciphertextProblem(v, 48),
  name: (v) => (/^device-\d+$/.test(v) ? null : 'имя устройства не заменено'),
  kind: (v) => (v === 'personal' || v === 'shared' ? null : 'неизвестный вид'),
  role: (v) => (['owner', 'editor', 'viewer'].includes(v) ? null : 'неизвестная роль'),
  keyKind: (v) => (v === 'wrapped' || v === 'sealed' ? null : 'неизвестный вид ключа'),
  slot: (v) => (SLOT_RE.test(v) ? null : 'не слот'),
  hlc: (v) => (HLC_RE.test(v) ? null : 'не метка HLC'),
  payload: (v) => {
    const p = ciphertextProblem(v, ENVELOPE_OVERHEAD + PAD_BLOCK);
    if (p) return p;
    return (Buffer.from(v, 'base64').length - ENVELOPE_OVERHEAD) % PAD_BLOCK === 0 ? null : 'длина не 40 + 64·k';
  },
  data: (v) => ciphertextProblem(v, 40),
};

/**
 * Проверить выгрузку по базе: нет почты и id других людей и пространств, нет материала для перебора пароля,
 * каждое строковое поле — известного вида, значения — шифротекст. Возвращает список находок (пусто — можно публиковать).
 */
export function checkExport(db: DatabaseSync, data: ChallengeExport): string[] {
  const problems: string[] = [];
  const { summary: _summary, ...published } = data;
  const text = JSON.stringify(published);
  const lower = text.toLowerCase();
  const self = data.account.id;
  const included = new Set(data.spaces.map((s) => s.id));

  const users = db.prepare('SELECT id, email, bundle, auth_salt, auth_hash, recovery_salt, recovery_hash, totp_secret FROM users').all() as Row[];
  users.forEach((u, i) => {
    if (lower.includes(String(u.email).toLowerCase())) problems.push(`почта пользователя №${i + 1}`);
    if (u.id !== self && text.includes(String(u.id))) problems.push(`id другого пользователя №${i + 1}`);
    const bundle = JSON.parse(String(u.bundle)) as Record<string, unknown>;
    for (const k of ['salt', 'masterByPassword', 'masterByRecovery']) {
      if (typeof bundle[k] === 'string' && text.includes(bundle[k] as string)) problems.push(`bundle.${k} пользователя №${i + 1}`);
    }
    for (const k of ['auth_salt', 'auth_hash', 'recovery_salt', 'recovery_hash']) {
      if (u[k] == null) continue;
      const buf = Buffer.from(u[k] as Uint8Array);
      if (text.includes(buf.toString('base64')) || lower.includes(buf.toString('hex'))) problems.push(`${k} пользователя №${i + 1}`);
    }
    if (typeof u.totp_secret === 'string' && u.totp_secret && text.includes(u.totp_secret)) problems.push(`секрет TOTP пользователя №${i + 1}`);
  });
  for (const s of db.prepare('SELECT id FROM spaces').all() as Row[]) {
    if (!included.has(String(s.id)) && text.includes(String(s.id))) problems.push('id чужого пространства');
  }
  for (const d of db.prepare('SELECT id FROM devices').all() as Row[]) if (text.includes(String(d.id))) problems.push('id устройства');
  for (const p of db.prepare('SELECT id FROM passkeys').all() as Row[]) if (text.includes(String(p.id))) problems.push('id passkey');
  for (const p of db.prepare('SELECT endpoint FROM push_subscriptions').all() as Row[]) if (text.includes(String(p.endpoint))) problems.push('адрес push-подписки');
  for (const m of db.prepare('SELECT value FROM meta').all() as Row[]) {
    const buf = Buffer.from(m.value as Uint8Array);
    if (buf.length >= 8 && (text.includes(buf.toString('base64')) || lower.includes(buf.toString('hex')))) problems.push('служебный секрет сервера');
  }

  // Каждое строковое поле — известного вида.
  const walk = (v: unknown, path: string, key: string): void => {
    if (typeof v === 'string') {
      const rule = STRING_RULES[key];
      const p = rule ? rule(v) : `неизвестное строковое поле${v.length > 24 ? ', похоже на текст' : ''}`;
      if (p) problems.push(`${path}: ${p}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, k);
  };
  walk(published, '', '');
  return problems;
}

/** Сводка для страницы вызова. */
export function formatSummary(s: ChallengeSummary): string {
  const hist = Object.entries(s.payloadBytes.histogram)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([len, n]) => `  ${len} байт: ${n}`)
    .join('\n');
  const days = Object.entries(s.hlc.byDay)
    .map(([d, n]) => `  ${d}: ${n}`)
    .join('\n');
  return [
    'Что атакующий видит в открытом виде',
    `Пространств: ${s.spaces} (${Object.entries(s.spacesByKind).map(([k, n]) => `${k}: ${n}`).join(', ')}); общих с другими людьми пропущено: ${s.sharedSpacesWithOthersSkipped}`,
    `Записей в журнале: ${s.envelopes}; операций принято за всё время: ${s.acceptedOps} (перезаписано ячеек: ${s.overwritten})`,
    'Виды записей (задача, проект, ...): серверу не видны, вид и имя поля зашифрованы вместе со значением',
    `Шифротекст: всего ${s.payloadBytes.total} байт, от ${s.payloadBytes.min} до ${s.payloadBytes.max}, медиана ${s.payloadBytes.median}`,
    'Распределение длин (40 + 64·k байт):',
    hist,
    `Метки HLC: первая ${s.hlc.first ?? 'нет'}, последняя ${s.hlc.last ?? 'нет'}; узлов-писателей: ${s.hlc.nodes}`,
    'Операций по дням (UTC):',
    days,
    `Устройств: ${s.devices} (активных: ${s.devicesActive}); файлов: ${s.files}, ${s.fileBytes} байт`,
  ].join('\n');
}

// ---------- командная строка ----------

function main(): void {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    if (!k.startsWith('--') || argv[i + 1] === undefined) throw new ExportError(`непонятные аргументы: ${argv.join(' ')}`);
    args.set(k.slice(2), argv[i + 1]!);
  }
  const dbPath = args.get('db');
  if (!dbPath || (!args.has('email') && !args.has('user'))) {
    console.error('node export.ts --db /data/dela.sqlite (--email ADDR | --user ID) [--out dela-challenge.json | --out -]');
    process.exit(2);
  }
  const out = args.get('out') ?? 'dela-challenge.json';
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const email = args.get('email');
    const userId = args.get('user');
    const data = exportChallenge(db, { ...(email !== undefined ? { email } : {}), ...(userId !== undefined ? { userId } : {}) });
    const problems = checkExport(db, data);
    if (problems.length > 0) {
      console.error(`Проверка не прошла, файл не записан (${problems.length}):`);
      for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
      process.exit(1);
    }
    const json = `${JSON.stringify(data, null, 1)}\n`;
    if (out === '-') {
      // Выгрузка в stdout (из контейнера с read-only диском), сводка в stderr.
      process.stdout.write(json);
      console.error(`${formatSummary(data.summary)}\n\nПроверка пройдена.`);
      return;
    }
    writeFileSync(`${out}.tmp`, json);
    renameSync(`${out}.tmp`, out);
    console.log(formatSummary(data.summary));
    console.log(`\nПроверка пройдена. Выгрузка: ${resolve(out)}`);
  } finally {
    db.close();
  }
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  }
}
