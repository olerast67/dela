import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { randomBytes } from 'node:crypto';
import { relative } from 'node:path';
import { exceedsDrift, isTimestamp, uuidv7, type AccountBundle, type Envelope } from '#core';
import { RateLimiter, fakeSalt, hashAuthSecret, newToken, safeEqual, sha256 } from './auth.ts';
import type { Config } from './config.ts';
import { tx, type Db } from './db.ts';
import { Hub, type HubSocket } from './hub.ts';
import { SqliteRelay } from './relay.ts';
import { generateVapid, isAllowedEndpoint, loadVapid, sendPush } from './webpush.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.ts';
import { EMAIL_RE, UUID_RE, b64, bad, int, obj, optStr, str } from './validate.ts';

export const VERSION = '0.1.1';

interface Auth {
  readonly userId: string;
  readonly deviceId: string;
  readonly isAdmin: boolean;
}

type AppEnv = { Variables: { auth: Auth } };

const MAX_ENVELOPES_PER_PUSH = 1000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SLOT_RE = /^[0-9a-f]{32}$/;
const DEFAULT_KDF = { alg: 'argon2id13', ops: 3, mem: 64 * 1024 * 1024 } as const;

function fail(status: 401 | 403 | 404 | 409 | 413 | 429, message: string, extra?: Record<string, unknown>): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error: message, ...extra }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

function parseBundle(v: unknown): AccountBundle {
  const b = obj(v, 'bundle');
  const kdf = obj(b.kdf, 'bundle.kdf');
  if (kdf.alg !== 'argon2id13') bad('bundle.kdf.alg must be argon2id13');
  return {
    kdf: {
      alg: 'argon2id13',
      ops: int(kdf.ops, 'bundle.kdf.ops', 1, 20),
      mem: int(kdf.mem, 'bundle.kdf.mem', 8192, 1024 * 1024 * 1024),
    },
    salt: b64(b.salt, 'bundle.salt', { bytes: 16 }).toString('base64'),
    masterByPassword: b64(b.masterByPassword, 'bundle.masterByPassword', { maxBytes: 256 }).toString('base64'),
    masterByRecovery: b64(b.masterByRecovery, 'bundle.masterByRecovery', { maxBytes: 256 }).toString('base64'),
    publicKey: b64(b.publicKey, 'bundle.publicKey', { bytes: 32 }).toString('base64'),
    secretKeyByMaster: b64(b.secretKeyByMaster, 'bundle.secretKeyByMaster', { maxBytes: 256 }).toString('base64'),
  };
}

function normEmail(v: unknown): string {
  return str(v, 'email', { max: 254, re: EMAIL_RE }).trim().toLowerCase();
}

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // Прокси дописывает адрес клиента в конец списка; значения левее мог прислать сам клиент.
    const forwarded = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean);
    const last = forwarded?.[forwarded.length - 1];
    if (last) return last;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'local';
}

const MAX_SCHEDULE = 300;
const SCHEDULE_HORIZON = 15 * 24 * 3600 * 1000;

export function createApp(db: Db, config: Config, now: () => number = Date.now, pushFetcher: typeof fetch = (i, init) => fetch(i, init)) {
  const app = new Hono<AppEnv>();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  const relay = new SqliteRelay(db);
  const hub = new Hub();
  const loginLimiter = new RateLimiter(10, 15 * 60_000, now);
  const ipLimiter = new RateLimiter(60, 15 * 60_000, now);

  const serverSecret = (() => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'server_secret'").get() as { value: Uint8Array } | undefined;
    if (row) return Buffer.from(row.value);
    const secret = randomBytes(32);
    db.prepare("INSERT INTO meta (key, value) VALUES ('server_secret', ?)").run(secret);
    return secret;
  })();

  const vapid = (() => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'vapid_private'").get() as { value: Uint8Array } | undefined;
    if (row) return loadVapid(Buffer.from(row.value).toString());
    const { privatePem } = generateVapid();
    db.prepare("INSERT INTO meta (key, value) VALUES ('vapid_private', ?)").run(Buffer.from(privatePem));
    return loadVapid(privatePem);
  })();

  // ---------- общие проверки ----------

  function createSession(userId: string, deviceName: string): { token: string; deviceId: string } {
    const deviceId = uuidv7(now());
    const token = newToken();
    const t = now();
    db.prepare('INSERT INTO devices (id, user_id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(
      deviceId,
      userId,
      deviceName,
      t,
      t,
    );
    db.prepare('INSERT INTO sessions (token_hash, device_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      sha256(token),
      deviceId,
      userId,
      t,
      t + config.sessionTtl,
    );
    return { token, deviceId };
  }

  function authenticate(token: string): Auth | undefined {
    const row = db
      .prepare(
        `SELECT s.user_id, s.device_id, s.expires_at, d.revoked_at, d.last_seen_at, u.is_admin
         FROM sessions s JOIN devices d ON d.id = s.device_id JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as
      | { user_id: string; device_id: string; expires_at: number; revoked_at: number | null; last_seen_at: number; is_admin: number }
      | undefined;
    const t = now();
    if (!row || row.revoked_at !== null || Number(row.expires_at) <= t) return undefined;
    if (t - Number(row.last_seen_at) > 60_000) {
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(t, row.device_id);
    }
    return { userId: row.user_id, deviceId: row.device_id, isAdmin: row.is_admin === 1 };
  }

  function membership(spaceId: string, userId: string): { role: string } {
    if (!UUID_RE.test(spaceId)) fail(404, 'not_found');
    const row = db.prepare('SELECT role FROM members WHERE space_id = ? AND user_id = ?').get(spaceId, userId) as
      | { role: string }
      | undefined;
    // Чужое пространство неотличимо от несуществующего.
    if (!row) fail(404, 'not_found');
    return row;
  }

  async function body(c: Context): Promise<Record<string, unknown>> {
    try {
      return obj(await c.req.json());
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      return bad('invalid JSON');
    }
  }

  // ---------- промежуточные слои ----------

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.res;
      return c.json({ error: err.message }, err.status);
    }
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // libsodium работает через WebAssembly.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        // Импорт из Todoist идёт из браузера напрямую, минуя сервер.
        connectSrc: ["'self'", 'https://api.todoist.com'],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Клиенты в оболочках Tauri и Capacitor загружаются не с сервера, поэтому API доступен с любого источника.
  // Вход идёт по токену в заголовке Authorization, cookie сервер не ставит, и чужой сайт без токена ничего не получит.
  app.use(
    '/api/*',
    cors({
      origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : '*',
      allowHeaders: ['content-type', 'authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    }),
  );
  app.use('/api/*', bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: 'body_too_large' }, 413) }));
  // Ответы API личные: браузер и прокси их не кэшируют.
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

  const requireAuth = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    const auth = m ? authenticate(m[1]!) : undefined;
    if (!auth) fail(401, 'unauthorized');
    c.set('auth', auth);
    await next();
  };

  // ---------- служебное ----------

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, serverTime: now() }));

  // ---------- вход ----------

  app.post('/api/auth/prelogin', async (c) => {
    const email = normEmail((await body(c)).email);
    const row = db.prepare('SELECT bundle FROM users WHERE email = ?').get(email) as { bundle: string } | undefined;
    if (row) {
      const bundle = JSON.parse(row.bundle) as AccountBundle;
      return c.json({ kdf: bundle.kdf, salt: bundle.salt });
    }
    return c.json({ kdf: DEFAULT_KDF, salt: fakeSalt(serverSecret, email).toString('base64') });
  });

  app.post('/api/auth/register', async (c) => {
    const b = await body(c);
    if (!ipLimiter.hit(`ip:${clientIp(c, config.trustProxy)}`)) fail(429, 'rate_limited');
    const email = normEmail(b.email);
    const authSecret = b64(b.authSecret, 'authSecret', { bytes: 32 });
    const recoveryAuth = b64(b.recoveryAuth, 'recoveryAuth', { bytes: 32 });
    const bundle = parseBundle(b.bundle);
    const deviceName = str(b.deviceName, 'deviceName', { max: 100 });
    const invite = optStr(b.invite, 'invite', { max: 100 });
    const authSalt = randomBytes(16);
    const authHash = await hashAuthSecret(authSecret, authSalt);
    const recoverySalt = randomBytes(16);
    const recoveryHash = await hashAuthSecret(recoveryAuth, recoverySalt);

    const result = tx(db, () => {
      const users = Number((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n);
      const isFirst = users === 0;
      // На новом сервере первым (администратором) может стать только адрес из DELA_ADMIN_EMAIL.
      if (isFirst && config.adminEmail && email !== config.adminEmail) fail(403, 'registration_closed');
      let inviteHash: Buffer | undefined;
      if (!isFirst && !config.openRegistration) {
        if (!invite) fail(403, 'invite_required');
        inviteHash = sha256(invite);
        const inv = db
          .prepare('SELECT expires_at, used_by FROM invites WHERE code_hash = ?')
          .get(inviteHash) as { expires_at: number; used_by: string | null } | undefined;
        if (!inv || inv.used_by !== null || Number(inv.expires_at) <= now()) fail(403, 'invalid_invite');
      }
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'email_taken');
      const userId = uuidv7(now());
      db.prepare(
        'INSERT INTO users (id, email, auth_salt, auth_hash, bundle, is_admin, created_at, recovery_salt, recovery_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(userId, email, authSalt, authHash, JSON.stringify(bundle), isFirst ? 1 : 0, now(), recoverySalt, recoveryHash);
      if (inviteHash) db.prepare('UPDATE invites SET used_by = ? WHERE code_hash = ?').run(userId, inviteHash);
      return { userId, isAdmin: isFirst, ...createSession(userId, deviceName) };
    });
    return c.json(result, 201);
  });

  app.post('/api/auth/login', async (c) => {
    const b = await body(c);
    const email = normEmail(b.email);
    const authSecret = b64(b.authSecret, 'authSecret', { bytes: 32 });
    const deviceName = str(b.deviceName, 'deviceName', { max: 100 });
    if (!ipLimiter.hit(`ip:${clientIp(c, config.trustProxy)}`) || !loginLimiter.hit(`login:${email}`)) fail(429, 'rate_limited');

    const row = db
      .prepare('SELECT id, auth_salt, auth_hash, bundle, is_admin, totp_secret, totp_enabled, totp_last FROM users WHERE email = ?')
      .get(email) as
      | {
          id: string;
          auth_salt: Uint8Array;
          auth_hash: Uint8Array;
          bundle: string;
          is_admin: number;
          totp_secret: string | null;
          totp_enabled: number;
          totp_last: number | null;
        }
      | undefined;
    // Для несуществующего адреса считаем хеш всё равно, чтобы время ответа не выдавало регистрацию.
    const hash = await hashAuthSecret(authSecret, row ? row.auth_salt : serverSecret.subarray(0, 16));
    if (!row || !safeEqual(hash, row.auth_hash)) fail(401, 'invalid_credentials');
    if (row.totp_enabled === 1 && row.totp_secret) {
      const code = typeof b.totp === 'string' ? b.totp.replace(/\s/g, '') : '';
      if (!code) fail(401, 'totp_required');
      const step = verifyTotp(row.totp_secret, code, now(), row.totp_last === null ? null : Number(row.totp_last));
      if (step === null) fail(401, 'invalid_totp');
      db.prepare('UPDATE users SET totp_last = ? WHERE id = ?').run(step, row.id);
    }

    const session = createSession(row.id, deviceName);
    return c.json({ userId: row.id, isAdmin: row.is_admin === 1, bundle: JSON.parse(row.bundle), ...session });
  });

  // ---------- восстановление по ключу ----------

  /** Проверить секрет восстановления. Для несуществующего адреса время ответа то же. */
  async function checkRecovery(c: Context, b: Record<string, unknown>) {
    const email = normEmail(b.email);
    const recoveryAuth = b64(b.recoveryAuth, 'recoveryAuth', { bytes: 32 });
    if (!ipLimiter.hit(`ip:${clientIp(c, config.trustProxy)}`) || !loginLimiter.hit(`recover:${email}`)) fail(429, 'rate_limited');
    const row = db.prepare('SELECT id, bundle, is_admin, recovery_salt, recovery_hash FROM users WHERE email = ?').get(email) as
      | { id: string; bundle: string; is_admin: number; recovery_salt: Uint8Array | null; recovery_hash: Uint8Array | null }
      | undefined;
    const hash = await hashAuthSecret(recoveryAuth, row?.recovery_salt ?? serverSecret.subarray(0, 16));
    if (!row || !row.recovery_hash || !safeEqual(hash, row.recovery_hash)) fail(401, 'invalid_credentials');
    return { row, bundle: JSON.parse(row.bundle) as AccountBundle };
  }

  // Шаг 1: пакет ключей отдаётся только после проверки секрета восстановления,
  // иначе его можно было бы скачать по адресу почты и перебирать пароль офлайн.
  app.post('/api/auth/recover/start', async (c) => {
    const { bundle } = await checkRecovery(c, await body(c));
    return c.json({ bundle });
  });

  // Шаг 2: новый пароль. Все прежние сессии закрываются.
  app.post('/api/auth/recover/finish', async (c) => {
    const b = await body(c);
    const { row, bundle: old } = await checkRecovery(c, b);
    const next = b64(b.newAuthSecret, 'newAuthSecret', { bytes: 32 });
    const bundle = parseBundle(b.bundle);
    const deviceName = str(b.deviceName, 'deviceName', { max: 100 });
    if (
      bundle.publicKey !== old.publicKey ||
      bundle.masterByRecovery !== old.masterByRecovery ||
      bundle.secretKeyByMaster !== old.secretKeyByMaster
    ) {
      bad('only the password wrapping may change');
    }
    const salt = randomBytes(16);
    const hash = await hashAuthSecret(next, salt);
    const session = tx(db, () => {
      db.prepare('UPDATE users SET auth_salt = ?, auth_hash = ?, bundle = ? WHERE id = ?').run(salt, hash, JSON.stringify(bundle), row.id);
      db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), row.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      return createSession(row.id, deviceName);
    });
    for (const d of db.prepare('SELECT id FROM devices WHERE user_id = ?').all(row.id) as Array<{ id: string }>) {
      if (d.id !== session.deviceId) hub.closeDevice(d.id);
    }
    return c.json({ userId: row.id, isAdmin: row.is_admin === 1, bundle, ...session });
  });

  app.post('/api/auth/logout', requireAuth, (c) => {
    const { deviceId } = c.get('auth');
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now(), deviceId);
    db.prepare('DELETE FROM sessions WHERE device_id = ?').run(deviceId);
    hub.closeDevice(deviceId);
    return c.json({ ok: true });
  });

  // ---------- аккаунт и устройства ----------

  app.get('/api/account', requireAuth, (c) => {
    const { userId, deviceId } = c.get('auth');
    const row = db.prepare('SELECT email, bundle, is_admin, totp_enabled FROM users WHERE id = ?').get(userId) as {
      email: string;
      bundle: string;
      is_admin: number;
      totp_enabled: number;
    };
    return c.json({
      userId,
      deviceId,
      email: row.email,
      isAdmin: row.is_admin === 1,
      totpEnabled: row.totp_enabled === 1,
      bundle: JSON.parse(row.bundle),
    });
  });

  // ---------- двухфакторный вход (TOTP) ----------

  /** Новый секрет. Включается только после подтверждения кодом. */
  app.post('/api/account/totp/setup', requireAuth, (c) => {
    const { userId } = c.get('auth');
    const row = db.prepare('SELECT email, totp_enabled FROM users WHERE id = ?').get(userId) as { email: string; totp_enabled: number };
    if (row.totp_enabled === 1) fail(409, 'totp_already_enabled');
    const secret = newTotpSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_last = NULL WHERE id = ?').run(secret, userId);
    return c.json({ secret, uri: otpauthUri(secret, row.email) });
  });

  async function checkTotp(c: Context<AppEnv>, requireEnabled: boolean): Promise<string> {
    const { userId } = c.get('auth');
    const b = await body(c);
    const code = str(b.code, 'code', { max: 10 }).replace(/\s/g, '');
    if (!loginLimiter.hit(`totp:${userId}`)) fail(429, 'rate_limited');
    const row = db.prepare('SELECT totp_secret, totp_enabled, totp_last FROM users WHERE id = ?').get(userId) as {
      totp_secret: string | null;
      totp_enabled: number;
      totp_last: number | null;
    };
    if (!row.totp_secret || (requireEnabled && row.totp_enabled !== 1)) bad('totp is not set up');
    const step = verifyTotp(row.totp_secret, code, now(), row.totp_last === null ? null : Number(row.totp_last));
    if (step === null) fail(401, 'invalid_totp');
    db.prepare('UPDATE users SET totp_last = ? WHERE id = ?').run(step, userId);
    return userId;
  }

  app.post('/api/account/totp/enable', requireAuth, async (c) => {
    const userId = await checkTotp(c, false);
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(userId);
    return c.json({ ok: true });
  });

  app.post('/api/account/totp/disable', requireAuth, async (c) => {
    const userId = await checkTotp(c, true);
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last = NULL WHERE id = ?').run(userId);
    return c.json({ ok: true });
  });

  app.put('/api/account/password', requireAuth, async (c) => {
    const { userId, deviceId } = c.get('auth');
    const b = await body(c);
    const current = b64(b.authSecret, 'authSecret', { bytes: 32 });
    const next = b64(b.newAuthSecret, 'newAuthSecret', { bytes: 32 });
    const bundle = parseBundle(b.bundle);
    if (!loginLimiter.hit(`password:${userId}`)) fail(429, 'rate_limited');
    const row = db.prepare('SELECT auth_salt, auth_hash, bundle FROM users WHERE id = ?').get(userId) as {
      auth_salt: Uint8Array;
      auth_hash: Uint8Array;
      bundle: string;
    };
    if (!safeEqual(await hashAuthSecret(current, row.auth_salt), row.auth_hash)) fail(401, 'invalid_credentials');
    if ((JSON.parse(row.bundle) as AccountBundle).publicKey !== bundle.publicKey) bad('public key cannot change');
    const salt = randomBytes(16);
    const hash = await hashAuthSecret(next, salt);
    tx(db, () => {
      db.prepare('UPDATE users SET auth_salt = ?, auth_hash = ?, bundle = ? WHERE id = ?').run(salt, hash, JSON.stringify(bundle), userId);
      // Остальные устройства входят заново с новым паролем.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND device_id != ?').run(userId, deviceId);
    });
    return c.json({ ok: true });
  });

  app.get('/api/devices', requireAuth, (c) => {
    const { userId, deviceId } = c.get('auth');
    const rows = db
      .prepare(
        'SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at',
      )
      .all(userId) as Array<{ id: string; name: string; created_at: number; last_seen_at: number }>;
    return c.json({
      devices: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: Number(r.created_at),
        lastSeenAt: Number(r.last_seen_at),
        current: r.id === deviceId,
      })),
    });
  });

  app.delete('/api/devices/:id', requireAuth, (c) => {
    const { userId } = c.get('auth');
    const id = c.req.param('id') ?? '';
    const res = db
      .prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(now(), id, userId);
    if (Number(res.changes) === 0) fail(404, 'not_found');
    db.prepare('DELETE FROM sessions WHERE device_id = ?').run(id);
    hub.closeDevice(id);
    return c.json({ ok: true });
  });

  app.post('/api/invites', requireAuth, (c) => {
    const { userId, isAdmin } = c.get('auth');
    if (!isAdmin) fail(403, 'forbidden');
    const code = randomBytes(16).toString('base64url');
    const expiresAt = now() + 7 * 24 * 3600 * 1000;
    db.prepare('INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256(code),
      userId,
      now(),
      expiresAt,
    );
    return c.json({ code, expiresAt }, 201);
  });

  // ---------- пространства и синхронизация ----------

  app.post('/api/spaces', requireAuth, async (c) => {
    const { userId } = c.get('auth');
    const b = await body(c);
    const id = str(b.id, 'id', { re: UUID_RE });
    const key = b64(b.key, 'key', { maxBytes: 256 }).toString('base64');
    const kind = b.kind === 'shared' ? 'shared' : 'personal';
    tx(db, () => {
      if (db.prepare('SELECT 1 FROM spaces WHERE id = ?').get(id)) fail(409, 'space_exists');
      if (kind === 'personal' && db.prepare("SELECT 1 FROM spaces WHERE created_by = ? AND kind = 'personal'").get(userId)) {
        fail(409, 'personal_space_exists');
      }
      db.prepare('INSERT INTO spaces (id, kind, created_by, created_at) VALUES (?, ?, ?, ?)').run(id, kind, userId, now());
      db.prepare("INSERT INTO members (space_id, user_id, role, key_kind, key) VALUES (?, ?, 'owner', 'wrapped', ?)").run(
        id,
        userId,
        key,
      );
    });
    return c.json({ id }, 201);
  });

  // ---------- общие пространства ----------

  const keyLookup = new RateLimiter(60, 3600_000, now);

  /** Открытый ключ пользователя по адресу: чтобы запечатать для него ключ пространства. */
  app.get('/api/users/public-key', requireAuth, (c) => {
    const { userId } = c.get('auth');
    if (!keyLookup.hit(`key:${userId}`)) fail(429, 'rate_limited');
    const email = normEmail(c.req.query('email'));
    const row = db.prepare('SELECT id, bundle FROM users WHERE email = ?').get(email) as { id: string; bundle: string } | undefined;
    if (!row) fail(404, 'not_found');
    return c.json({ userId: row.id, publicKey: (JSON.parse(row.bundle) as AccountBundle).publicKey });
  });

  function notifySpace(spaceId: string, extra: string[] = []): void {
    const members = (db.prepare('SELECT user_id FROM members WHERE space_id = ?').all(spaceId) as Array<{ user_id: string }>).map((r) => r.user_id);
    hub.notify([...members, ...extra], { type: 'spaces' });
  }

  app.get('/api/spaces/:id/members', requireAuth, (c) => {
    const { userId } = c.get('auth');
    const spaceId = c.req.param('id') ?? '';
    membership(spaceId, userId);
    const rows = db
      .prepare('SELECT m.user_id, m.role, u.email, u.bundle FROM members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.role, u.email')
      .all(spaceId) as Array<{ user_id: string; role: string; email: string; bundle: string }>;
    return c.json({
      members: rows.map((r) => ({ userId: r.user_id, role: r.role, email: r.email, publicKey: (JSON.parse(r.bundle) as AccountBundle).publicKey })),
    });
  });

  /** Добавить участника: владелец передаёт ключ пространства, запечатанный открытым ключом участника. */
  app.post('/api/spaces/:id/members', requireAuth, async (c) => {
    const { userId } = c.get('auth');
    const spaceId = c.req.param('id') ?? '';
    const { role } = membership(spaceId, userId);
    if (role !== 'owner') fail(403, 'forbidden');
    const space = db.prepare('SELECT kind FROM spaces WHERE id = ?').get(spaceId) as { kind: string };
    if (space.kind !== 'shared') bad('personal space cannot be shared');
    const b = await body(c);
    const memberId = str(b.userId, 'userId', { re: UUID_RE });
    const memberRole = b.role === 'viewer' ? 'viewer' : 'editor';
    const key = b64(b.key, 'key', { maxBytes: 256 }).toString('base64');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(memberId)) fail(404, 'not_found');
    db.prepare(
      `INSERT INTO members (space_id, user_id, role, key_kind, key) VALUES (?, ?, ?, 'sealed', ?)
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = excluded.role, key = excluded.key, key_kind = excluded.key_kind`,
    ).run(spaceId, memberId, memberRole, key);
    notifySpace(spaceId);
    return c.json({ ok: true }, 201);
  });

  /** Удалить участника (владелец) или выйти самому. Владелец выйти не может. */
  app.delete('/api/spaces/:id/members/:userId', requireAuth, (c) => {
    const { userId } = c.get('auth');
    const spaceId = c.req.param('id') ?? '';
    const target = c.req.param('userId') ?? '';
    const { role } = membership(spaceId, userId);
    if (target !== userId && role !== 'owner') fail(403, 'forbidden');
    const targetRole = (db.prepare('SELECT role FROM members WHERE space_id = ? AND user_id = ?').get(spaceId, target) as { role: string } | undefined)?.role;
    if (!targetRole) fail(404, 'not_found');
    if (targetRole === 'owner') bad('owner cannot leave; delete the project instead');
    db.prepare('DELETE FROM members WHERE space_id = ? AND user_id = ?').run(spaceId, target);
    notifySpace(spaceId, [target]);
    return c.json({ ok: true });
  });

  app.get('/api/spaces', requireAuth, (c) => {
    const { userId } = c.get('auth');
    const rows = db
      .prepare(
        `SELECT s.id, s.kind, s.last_seq, m.role, m.key_kind, m.key
         FROM members m JOIN spaces s ON s.id = m.space_id WHERE m.user_id = ? ORDER BY s.created_at`,
      )
      .all(userId) as Array<{ id: string; kind: string; last_seq: number; role: string; key_kind: string; key: string }>;
    return c.json({
      spaces: rows.map((r) => ({ id: r.id, kind: r.kind, role: r.role, keyKind: r.key_kind, key: r.key, lastSeq: Number(r.last_seq) })),
    });
  });

  app.post('/api/spaces/:id/push', requireAuth, async (c) => {
    const { userId } = c.get('auth');
    const spaceId = c.req.param('id') ?? '';
    const { role } = membership(spaceId, userId);
    if (role === 'viewer') fail(403, 'forbidden');
    const b = await body(c);
    if (!Array.isArray(b.envelopes)) bad('envelopes must be an array');
    if (b.envelopes.length > MAX_ENVELOPES_PER_PUSH) bad(`at most ${MAX_ENVELOPES_PER_PUSH} envelopes per push`);
    const t = now();
    const envelopes: Envelope<string>[] = b.envelopes.map((raw, i) => {
      const e = obj(raw, `envelopes[${i}]`);
      const slot = str(e.slot, 'slot', { re: SLOT_RE });
      const hlc = str(e.hlc, 'hlc', { max: 64 });
      if (!isTimestamp(hlc)) bad(`envelopes[${i}].hlc is invalid`);
      const payload = b64(e.payload, 'payload', { maxBytes: MAX_PAYLOAD_BYTES }).toString('base64');
      return { slot, hlc, payload };
    });
    if (envelopes.some((e) => exceedsDrift(e.hlc, t, config.maxClockDrift))) {
      fail(409, 'clock_drift', { serverTime: t });
    }
    const stored = Number((db.prepare('SELECT count(*) AS n FROM envelopes WHERE space_id = ?').get(spaceId) as { n: number }).n);
    if (stored + envelopes.length > config.maxRecordsPerSpace) fail(413, 'space_full');
    const { accepted, seq } = relay.push(spaceId, envelopes);
    if (accepted > 0) {
      const members = (db.prepare('SELECT user_id FROM members WHERE space_id = ?').all(spaceId) as Array<{ user_id: string }>).map(
        (r) => r.user_id,
      );
      hub.notify(members, { type: 'changed', space: spaceId, seq });
    }
    return c.json({ accepted, seq, serverTime: t });
  });

  app.get('/api/spaces/:id/pull', requireAuth, (c) => {
    const { userId } = c.get('auth');
    const spaceId = c.req.param('id') ?? '';
    membership(spaceId, userId);
    const since = int(c.req.query('since') ?? '0', 'since', 0, Number.MAX_SAFE_INTEGER);
    const limit = int(c.req.query('limit') ?? '500', 'limit', 1, 1000);
    return c.json({ ...relay.pull(spaceId, since, limit), serverTime: now() });
  });

  // ---------- Web Push ----------
  // Сервер хранит только время отправки и шифротекст: текст напоминания шифрует устройство своим ключом.

  app.get('/api/push/key', (c) => c.json({ publicKey: vapid.publicKey }));

  app.put('/api/push/subscription', requireAuth, async (c) => {
    const { deviceId } = c.get('auth');
    const b = await body(c);
    const endpoint = str(b.endpoint, 'endpoint', { max: 2000 });
    if (!isAllowedEndpoint(endpoint)) bad('unsupported push service');
    const keys = obj(b.keys, 'keys');
    const p256dh = str(keys.p256dh, 'keys.p256dh', { max: 200, re: /^[A-Za-z0-9_-]+$/ });
    const auth = str(keys.auth, 'keys.auth', { max: 100, re: /^[A-Za-z0-9_-]+$/ });
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) bad('invalid subscription keys');
    db.prepare(
      `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(deviceId, endpoint, p256dh, auth, now());
    return c.json({ ok: true });
  });

  app.delete('/api/push/subscription', requireAuth, (c) => {
    const { deviceId } = c.get('auth');
    db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM push_schedule WHERE device_id = ?').run(deviceId);
    return c.json({ ok: true });
  });

  /** Заменить расписание напоминаний устройства целиком. */
  app.put('/api/push/schedule', requireAuth, async (c) => {
    const { deviceId } = c.get('auth');
    const b = await body(c);
    if (!Array.isArray(b.entries)) bad('entries must be an array');
    if (b.entries.length > MAX_SCHEDULE) bad(`at most ${MAX_SCHEDULE} entries`);
    const t = now();
    const entries = b.entries.map((raw, i) => {
      const e = obj(raw, `entries[${i}]`);
      return {
        id: str(e.id, 'id', { max: 64, re: /^[A-Za-z0-9_-]+$/ }),
        fireAt: int(e.fireAt, 'fireAt', t - 3600_000, t + SCHEDULE_HORIZON),
        payload: b64(e.payload, 'payload', { maxBytes: 1024 }).toString('base64'),
      };
    });
    tx(db, () => {
      db.prepare('DELETE FROM push_schedule WHERE device_id = ?').run(deviceId);
      const ins = db.prepare('INSERT OR REPLACE INTO push_schedule (device_id, id, fire_at, payload) VALUES (?, ?, ?, ?)');
      for (const e of entries) ins.run(deviceId, e.id, e.fireAt, e.payload);
    });
    return c.json({ ok: true, count: entries.length });
  });

  /** Отправить наступившие напоминания. Вызывается по таймеру из main и напрямую из тестов. */
  async function pushTick(): Promise<{ sent: number; gone: number; failed: number }> {
    const t = now();
    const due = db
      .prepare(
        `SELECT s.device_id, s.id, s.payload, p.endpoint, p.p256dh, p.auth
         FROM push_schedule s JOIN push_subscriptions p ON p.device_id = s.device_id
         JOIN devices d ON d.id = s.device_id
         WHERE s.fire_at <= ? AND d.revoked_at IS NULL LIMIT 200`,
      )
      .all(t) as Array<{ device_id: string; id: string; payload: string; endpoint: string; p256dh: string; auth: string }>;
    let sent = 0;
    let gone = 0;
    let failed = 0;
    for (const r of due) {
      db.prepare('DELETE FROM push_schedule WHERE device_id = ? AND id = ?').run(r.device_id, r.id);
      try {
        const result = await sendPush(vapid, r, Buffer.from(JSON.stringify({ p: r.payload })), {
          subject: config.vapidSubject,
          ttl: 3600,
          fetcher: pushFetcher,
        });
        if (result === 'ok') sent++;
        else if (result === 'gone') {
          gone++;
          db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(r.device_id);
          db.prepare('DELETE FROM push_schedule WHERE device_id = ?').run(r.device_id);
        } else failed++;
      } catch {
        failed++;
      }
    }
    // Записи без подписки и просроченные больше чем на час больше не нужны.
    db.prepare('DELETE FROM push_schedule WHERE fire_at < ?').run(t - 3600_000);
    return { sent, gone, failed };
  }

  // ---------- WebSocket: сигнал «есть новое» ----------

  app.get(
    '/api/ws',
    upgradeWebSocket(() => {
      let authed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let socket: HubSocket | undefined;
      return {
        onOpen(_evt, ws) {
          socket = ws;
          // Токен приходит первым сообщением, а не в адресе: адреса попадают в логи прокси.
          timer = setTimeout(() => ws.close(4000, 'auth timeout'), 10_000);
        },
        onMessage(evt, ws) {
          if (authed) return;
          let msg: { type?: unknown; token?: unknown };
          try {
            msg = JSON.parse(String(evt.data));
          } catch {
            ws.close(4000, 'bad message');
            return;
          }
          const auth = msg.type === 'auth' && typeof msg.token === 'string' ? authenticate(msg.token) : undefined;
          if (!auth) {
            ws.close(4001, 'unauthorized');
            return;
          }
          authed = true;
          clearTimeout(timer);
          hub.add(auth.userId, auth.deviceId, ws);
          ws.send(JSON.stringify({ type: 'ready', serverTime: now() }));
        },
        onClose() {
          clearTimeout(timer);
          if (socket) hub.remove(socket);
        },
      };
    }),
  );

  // ---------- веб-клиент ----------

  if (config.webDir) {
    const root = relative(process.cwd(), config.webDir) || '.';
    app.use(
      '/assets/*',
      async (c, next) => {
        await next();
        if (c.res.ok) c.header('cache-control', 'public, max-age=31536000, immutable');
      },
    );
    app.use(
      '*',
      async (c, next) => {
        await next();
        const path = c.req.path;
        if (path === '/' || path.endsWith('.html') || path === '/sw.js' || path === '/registerSW.js' || path.endsWith('.webmanifest')) {
          c.header('cache-control', 'no-cache');
        }
      },
    );
    app.use('*', serveStatic({ root }));
    // Любой другой путь (кроме API) — это маршрут приложения: отдаём index.html.
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) return next();
      return serveStatic({ root, path: 'index.html' })(c, next);
    });
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  return { app, injectWebSocket, hub, pushTick };
}
