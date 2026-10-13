/** HTTP-клиент API сервера Dela. Работает в браузере, Node и React Native. */
import type { AccountBundle, KdfParams } from './crypto.ts';
import type { Envelope, PullResult } from './relay.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    const code = typeof body.error === 'string' ? body.error : `http_${status}`;
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Нет связи с сервером. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('network unavailable', { cause });
    this.name = 'NetworkError';
  }
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionInfo {
  readonly token: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly isAdmin: boolean;
}

export interface SpaceInfo {
  readonly id: string;
  readonly kind: 'personal' | 'shared';
  readonly role: 'owner' | 'editor' | 'viewer';
  readonly keyKind: 'wrapped' | 'sealed';
  readonly key: string;
  readonly lastSeq: number;
  /** Версия ключа пространства (растёт при смене ключа). Старые серверы её не присылают. */
  readonly keyVersion?: number;
}

export interface DeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly current: boolean;
}

export class ApiClient {
  private base: string;
  token: string | null = null;
  private readonly fetcher: Fetcher;

  constructor(baseUrl: string, fetcher?: Fetcher) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  get baseUrl(): string {
    return this.base;
  }

  set baseUrl(url: string) {
    this.base = url.replace(/\/+$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetcher(this.baseUrl + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new NetworkError(err);
    }
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  health(): Promise<{ ok: boolean; version: string; serverTime: number }> {
    return this.call('GET', '/api/health');
  }

  prelogin(email: string): Promise<{ kdf: KdfParams; salt: string }> {
    return this.call('POST', '/api/auth/prelogin', { email });
  }

  register(input: {
    email: string;
    authSecret: string;
    recoveryAuth: string;
    bundle: AccountBundle;
    deviceName: string;
    invite?: string;
  }): Promise<SessionInfo> {
    return this.call('POST', '/api/auth/register', input);
  }

  login(input: { email: string; authSecret: string; deviceName: string; totp?: string }): Promise<SessionInfo & { bundle: AccountBundle }> {
    return this.call('POST', '/api/auth/login', input);
  }

  recoverStart(input: { email: string; recoveryAuth: string }): Promise<{ bundle: AccountBundle }> {
    return this.call('POST', '/api/auth/recover/start', input);
  }

  recoverFinish(input: {
    email: string;
    recoveryAuth: string;
    newAuthSecret: string;
    bundle: AccountBundle;
    deviceName: string;
  }): Promise<SessionInfo & { bundle: AccountBundle }> {
    return this.call('POST', '/api/auth/recover/finish', input);
  }

  logout(): Promise<{ ok: true }> {
    return this.call('POST', '/api/auth/logout', {});
  }

  account(): Promise<{ userId: string; deviceId: string; email: string; isAdmin: boolean; totpEnabled: boolean; bundle: AccountBundle }> {
    return this.call('GET', '/api/account');
  }

  totpSetup(): Promise<{ secret: string; uri: string }> {
    return this.call('POST', '/api/account/totp/setup', {});
  }

  totpEnable(code: string): Promise<{ ok: true }> {
    return this.call('POST', '/api/account/totp/enable', { code });
  }

  totpDisable(code: string): Promise<{ ok: true }> {
    return this.call('POST', '/api/account/totp/disable', { code });
  }

  changePassword(input: { authSecret: string; newAuthSecret: string; bundle: AccountBundle }): Promise<{ ok: true }> {
    return this.call('PUT', '/api/account/password', input);
  }

  deleteAccount(input: { authSecret: string; totp?: string }): Promise<{ ok: true }> {
    return this.call('POST', '/api/account/delete', input);
  }

  devices(): Promise<{ devices: DeviceInfo[] }> {
    return this.call('GET', '/api/devices');
  }

  revokeDevice(id: string): Promise<{ ok: true }> {
    return this.call('DELETE', `/api/devices/${encodeURIComponent(id)}`);
  }

  createInvite(): Promise<{ code: string; expiresAt: number }> {
    return this.call('POST', '/api/invites', {});
  }

  spaces(): Promise<{ spaces: SpaceInfo[] }> {
    return this.call('GET', '/api/spaces');
  }

  createSpace(id: string, key: string, kind: 'personal' | 'shared' = 'personal'): Promise<{ id: string }> {
    return this.call('POST', '/api/spaces', { id, key, kind });
  }

  userPublicKey(email: string): Promise<{ userId: string; publicKey: string }> {
    return this.call('GET', `/api/users/public-key?email=${encodeURIComponent(email)}`);
  }

  spaceMembers(spaceId: string): Promise<{ members: Array<{ userId: string; role: 'owner' | 'editor' | 'viewer'; email: string; publicKey: string }> }> {
    return this.call('GET', `/api/spaces/${spaceId}/members`);
  }

  addMember(spaceId: string, input: { userId: string; role: 'editor' | 'viewer'; key: string }): Promise<{ ok: true }> {
    return this.call('POST', `/api/spaces/${spaceId}/members`, input);
  }

  removeMember(spaceId: string, userId: string): Promise<{ ok: true }> {
    return this.call('DELETE', `/api/spaces/${spaceId}/members/${encodeURIComponent(userId)}`);
  }

  push(spaceId: string, envelopes: readonly Envelope<string>[], keyVersion = 1): Promise<{ accepted: number; seq: number; serverTime: number }> {
    return this.call('POST', `/api/spaces/${spaceId}/push`, { envelopes, keyVersion });
  }

  rotateSpace(
    spaceId: string,
    input: { keyVersion: number; baseSeq: number; keys: ReadonlyArray<{ userId: string; key: string }>; envelopes: readonly Envelope<string>[] },
  ): Promise<{ ok: true; keyVersion: number; seq: number }> {
    return this.call('POST', `/api/spaces/${spaceId}/rotate`, input);
  }

  pull(spaceId: string, since: number, limit = 500): Promise<PullResult<string> & { serverTime: number }> {
    return this.call('GET', `/api/spaces/${spaceId}/pull?since=${since}&limit=${limit}`);
  }

  pushKey(): Promise<{ publicKey: string }> {
    return this.call('GET', '/api/push/key');
  }

  pushSubscribe(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<{ ok: true }> {
    return this.call('PUT', '/api/push/subscription', subscription);
  }

  pushUnsubscribe(): Promise<{ ok: true }> {
    return this.call('DELETE', '/api/push/subscription');
  }

  pushSchedule(entries: ReadonlyArray<{ id: string; fireAt: number; payload: string }>): Promise<{ ok: true; count: number }> {
    return this.call('PUT', '/api/push/schedule', { entries });
  }

  /** Адрес WebSocket для сигналов «есть новое». */
  wsUrl(): string {
    const base = this.baseUrl || (typeof location !== 'undefined' ? location.origin : '');
    return base.replace(/^http/, 'ws') + '/api/ws';
  }
}
