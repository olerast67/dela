/** Регистрация, вход и личное пространство поверх ApiClient и шифрования. */
import type { ApiClient, SessionInfo, SpaceInfo } from './client.ts';
import {
  DEFAULT_KDF,
  createAccount,
  derivePasswordKeys,
  fromB64,
  newKey,
  openAccount,
  openSealedSpaceKey,
  toB64,
  unwrapSpaceKey,
  wrapSpaceKey,
  type AccountBundle,
  type AccountKeys,
  type KdfParams,
} from './crypto.ts';
import { uuidv7 } from './uuid.ts';

export interface Session extends SessionInfo {
  readonly email: string;
  readonly bundle: AccountBundle;
  readonly keys: AccountKeys;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function signUp(
  api: ApiClient,
  input: { email: string; password: string; deviceName: string; invite?: string; kdf?: KdfParams },
): Promise<{ session: Session; recoveryKey: string }> {
  const email = normalizeEmail(input.email);
  const acc = createAccount(input.password, input.kdf ?? DEFAULT_KDF);
  const info = await api.register({
    email,
    authSecret: toB64(acc.authSecret),
    bundle: acc.bundle,
    deviceName: input.deviceName,
    ...(input.invite ? { invite: input.invite } : {}),
  });
  api.token = info.token;
  return { session: { ...info, email, bundle: acc.bundle, keys: acc.keys }, recoveryKey: acc.recoveryKey };
}

export async function signIn(
  api: ApiClient,
  input: { email: string; password: string; deviceName: string },
): Promise<Session> {
  const email = normalizeEmail(input.email);
  const pre = await api.prelogin(email);
  const { authSecret, kek } = derivePasswordKeys(input.password, fromB64(pre.salt), pre.kdf);
  const res = await api.login({ email, authSecret: toB64(authSecret), deviceName: input.deviceName });
  const keys = openAccount(res.bundle, kek);
  api.token = res.token;
  const { bundle, ...info } = res;
  return { ...info, email, bundle, keys };
}

export function spaceKeyOf(space: SpaceInfo, keys: AccountKeys): Uint8Array {
  return space.keyKind === 'wrapped' ? unwrapSpaceKey(space.key, keys.masterKey, space.id) : openSealedSpaceKey(space.key, space.id, keys);
}

/** Личное пространство пользователя; создаётся при первом входе. */
export async function ensurePersonalSpace(api: ApiClient, keys: AccountKeys): Promise<{ spaceId: string; spaceKey: Uint8Array }> {
  const { spaces } = await api.spaces();
  const own = spaces.find((s) => s.kind === 'personal' && s.role === 'owner');
  if (own) return { spaceId: own.id, spaceKey: spaceKeyOf(own, keys) };
  const spaceId = uuidv7();
  const spaceKey = newKey();
  await api.createSpace(spaceId, wrapSpaceKey(spaceKey, keys.masterKey, spaceId));
  return { spaceId, spaceKey };
}
