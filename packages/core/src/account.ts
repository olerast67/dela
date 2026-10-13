/** Регистрация, вход и личное пространство поверх ApiClient и шифрования. */
import type { ApiClient, SessionInfo, SpaceInfo } from './client.ts';
import {
  DEFAULT_KDF,
  changePassword,
  createAccount,
  openAccountWithRecovery,
  parseRecoveryKey,
  recoveryAuthSecret,
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
    recoveryAuth: toB64(acc.recoveryAuth),
    bundle: acc.bundle,
    deviceName: input.deviceName,
    ...(input.invite ? { invite: input.invite } : {}),
  });
  api.token = info.token;
  return { session: { ...info, email, bundle: acc.bundle, keys: acc.keys }, recoveryKey: acc.recoveryKey };
}

export async function signIn(
  api: ApiClient,
  input: { email: string; password: string; deviceName: string; totp?: string },
): Promise<Session> {
  const email = normalizeEmail(input.email);
  const pre = await api.prelogin(email);
  const { authSecret, kek } = derivePasswordKeys(input.password, fromB64(pre.salt), pre.kdf);
  const res = await api.login({ email, authSecret: toB64(authSecret), deviceName: input.deviceName, ...(input.totp ? { totp: input.totp } : {}) });
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

/** Вход по ключу восстановления с новым паролем. Все прежние сессии закрываются. */
export async function recoverAccount(
  api: ApiClient,
  input: { email: string; recoveryKey: string; newPassword: string; deviceName: string; kdf?: KdfParams },
): Promise<Session> {
  const email = normalizeEmail(input.email);
  const recoveryAuth = toB64(recoveryAuthSecret(parseRecoveryKey(input.recoveryKey)));
  const { bundle } = await api.recoverStart({ email, recoveryAuth });
  const keys = openAccountWithRecovery(bundle, input.recoveryKey);
  const changed = changePassword(bundle, keys, input.newPassword, input.kdf ?? DEFAULT_KDF);
  const res = await api.recoverFinish({
    email,
    recoveryAuth,
    newAuthSecret: toB64(changed.authSecret),
    bundle: changed.bundle,
    deviceName: input.deviceName,
  });
  api.token = res.token;
  const { bundle: _b, ...info } = res;
  return { ...info, email, bundle: changed.bundle, keys };
}

/** Смена пароля. Неверный текущий пароль обнаруживается на устройстве, до запроса к серверу. */
/** Удалить аккаунт на сервере: нужен пароль (и код TOTP, если он включён). */
export async function deleteAccountOnServer(api: ApiClient, input: { password: string; totp?: string }): Promise<void> {
  const { bundle } = await api.account();
  const { authSecret } = derivePasswordKeys(input.password, fromB64(bundle.salt), bundle.kdf);
  await api.deleteAccount({ authSecret: toB64(authSecret), ...(input.totp ? { totp: input.totp } : {}) });
}

export async function changeAccountPassword(
  api: ApiClient,
  input: { currentPassword: string; newPassword: string; kdf?: KdfParams },
): Promise<void> {
  const { bundle } = await api.account();
  const current = derivePasswordKeys(input.currentPassword, fromB64(bundle.salt), bundle.kdf);
  const keys = openAccount(bundle, current.kek);
  const changed = changePassword(bundle, keys, input.newPassword, input.kdf ?? bundle.kdf);
  await api.changePassword({ authSecret: toB64(current.authSecret), newAuthSecret: toB64(changed.authSecret), bundle: changed.bundle });
}
