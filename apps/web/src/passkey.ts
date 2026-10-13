/**
 * Passkey в браузере: создание и вход через WebAuthn с расширением PRF.
 * Секрет PRF остаётся на устройстве: на сервер уходят только подпись и открытые данные WebAuthn.
 */
import { passkeyPrfSalt } from '#core';
import { isNative } from './platform.ts';

const b64url = {
  encode(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array<ArrayBuffer> {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  },
};

/** Passkey доступны в браузере на домене сервера. В программе для Windows и на Android их нет. */
export function passkeysSupported(): boolean {
  return !isNative() && typeof window !== 'undefined' && 'PublicKeyCredential' in window && window.isSecureContext;
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

function prfFirst(cred: PublicKeyCredential): Uint8Array | null {
  const r = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  return r ? new Uint8Array(r) : null;
}

const prfExt = () => ({ prf: { eval: { first: passkeyPrfSalt() as BufferSource } } }) as AuthenticationExtensionsClientInputs;

/** Создать passkey по параметрам сервера. Возвращает ответ для сервера и секрет PRF. */
export async function createPasskey(options: Record<string, any>): Promise<{ response: unknown; prf: Uint8Array }> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...(options as PublicKeyCredentialCreationOptions),
    challenge: b64url.decode(options.challenge),
    user: { ...options.user, id: b64url.decode(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c: { id: string; transports?: AuthenticatorTransport[] }) => ({
      type: 'public-key',
      id: b64url.decode(c.id),
      ...(c.transports ? { transports: c.transports } : {}),
    })),
    extensions: prfExt(),
  };
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('cancelled');
  const att = cred.response as AuthenticatorAttestationResponse;
  let prf = prfFirst(cred);
  if (!prf) {
    const enabled = (cred.getClientExtensionResults() as PrfResults).prf?.enabled;
    if (!enabled) throw new Error('prf_unsupported');
    // Часть ключей отдаёт секрет PRF только при входе: спрашиваем его сразу этим же ключом.
    const got = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: options.rp?.id,
        allowCredentials: [{ type: 'public-key', id: cred.rawId }],
        userVerification: 'required',
        extensions: prfExt(),
      },
    })) as PublicKeyCredential | null;
    prf = got ? prfFirst(got) : null;
    if (!prf) throw new Error('prf_unsupported');
  }
  return {
    prf,
    response: {
      id: cred.id,
      rawId: b64url.encode(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      // Результаты расширений на сервер не отправляются: в них секрет PRF.
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url.encode(att.clientDataJSON),
        attestationObject: b64url.encode(att.attestationObject),
        transports: att.getTransports?.() ?? [],
      },
    },
  };
}

/** Войти по passkey: подпись для сервера и секрет PRF для ключа аккаунта. */
export async function getPasskey(options: Record<string, any>): Promise<{ response: unknown; prf: Uint8Array }> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: b64url.decode(options.challenge),
      rpId: options.rpId,
      userVerification: 'required',
      allowCredentials: [],
      extensions: prfExt(),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('cancelled');
  const prf = prfFirst(cred);
  if (!prf) throw new Error('prf_unsupported');
  const a = cred.response as AuthenticatorAssertionResponse;
  return {
    prf,
    response: {
      id: cred.id,
      rawId: b64url.encode(cred.rawId),
      type: cred.type,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url.encode(a.clientDataJSON),
        authenticatorData: b64url.encode(a.authenticatorData),
        signature: b64url.encode(a.signature),
        ...(a.userHandle ? { userHandle: b64url.encode(a.userHandle) } : {}),
      },
    },
  };
}
