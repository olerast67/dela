import { useState, type FormEvent } from 'react';
import { ApiError, DecryptError, NetworkError } from '#core';
import { controller } from '../controller.ts';
import { isNative, normalizeServerUrl, serverUrl, setServerUrl } from '../platform.ts';
import { useAppState } from '../hooks.ts';
import { passkeysSupported } from '../passkey.ts';

const ERRORS: Record<string, string> = {
  invalid_credentials: 'Неверный адрес или пароль.',
  totp_required: 'Введите код из приложения-аутентификатора.',
  invalid_totp: 'Код не подошёл. Проверьте время на телефоне и введите новый код.',
  rate_limited: 'Слишком много попыток. Подождите несколько минут.',
  invite_required: 'Регистрация на этом сервере только по приглашению.',
  registration_closed: 'Регистрация на этом сервере закрыта.',
  invalid_invite: 'Приглашение неверное, использовано или истекло.',
  email_taken: 'Этот адрес уже зарегистрирован. Войдите.',
  passkeys_disabled: 'На этом сервере вход по passkey выключен: администратору нужно задать DELA_PUBLIC_URL.',
  challenge_expired: 'Время на вход вышло. Попробуйте ещё раз.',
};

function message(err: unknown): string {
  if (err instanceof NetworkError) return 'Нет связи с сервером.';
  if (err instanceof ApiError) return ERRORS[err.code] ?? `Ошибка сервера: ${err.code}`;
  if (err instanceof SyntaxError) return 'Ключ восстановления введён с ошибкой: проверьте символы.';
  if (err instanceof DecryptError) return 'Ключ не подходит к этому аккаунту.';
  if (err instanceof Error && err.message === 'prf_unsupported')
    return 'Этот passkey не умеет PRF, без него ключи шифрования не открыть. Подойдут Google Password Manager, iCloud Keychain, Windows Hello на Windows 11 и ключи FIDO2.';
  if (err instanceof Error && (err.name === 'NotAllowedError' || err.message === 'cancelled')) return 'Вход по passkey отменён.';
  return 'Что-то пошло не так. Попробуйте ещё раз.';
}

export function AuthScreen() {
  const { notice } = useAppState();
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('login');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [totp, setTotp] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [invite, setInvite] = useState(() => new URLSearchParams(location.search).get('invite') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState(() => serverUrl());
  const native = isNative();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (native) {
      const url = normalizeServerUrl(server);
      if (!url) return setError('Укажите адрес сервера Dela, например tasks.example.com. Нужен HTTPS.');
      try {
        await fetch(`${url}/api/health`).then((r) => {
          if (!r.ok) throw new Error();
        });
      } catch {
        return setError(`По адресу ${url} не отвечает сервер Dela.`);
      }
      setServerUrl(url);
      controller.api.baseUrl = url;
    }
    if (mode !== 'login') {
      if (password.length < 10) return setError('Пароль должен быть не короче 10 символов.');
      if (password !== repeat) return setError('Пароли не совпадают.');
    }
    setBusy(true);
    // Даём браузеру отрисовать «Подождите…»: вычисление ключа из пароля занимает около секунды.
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (mode === 'login') await controller.login(email, password, needTotp ? totp : undefined);
      else if (mode === 'recover') await controller.recover(email, recoveryKey, password);
      else await controller.register(email, password, invite.trim() || undefined);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'totp_required' || err.code === 'invalid_totp')) setNeedTotp(true);
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width="48" height="48" />
        <h1>{mode === 'login' ? 'Вход в Dela' : mode === 'recover' ? 'Новый пароль по ключу' : 'Новый аккаунт Dela'}</h1>
        <p className="muted">
          {mode === 'login'
            ? 'Задачи шифруются на устройстве, сервер видит только шифротекст.'
            : mode === 'recover'
              ? 'Ключ восстановления выдавался при регистрации. С ним можно задать новый пароль, задачи сохранятся. Остальные устройства придётся подключить заново.'
              : 'Пароль не уходит на сервер: из него на устройстве получаются ключи шифрования.'}
        </p>
        {notice && <p className="notice">{notice}</p>}
        {native && (
          <label>
            Сервер
            <input inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="tasks.example.com" required value={server} onChange={(e) => setServer(e.target.value)} />
          </label>
        )}
        <label>
          Электронная почта
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === 'recover' && (
          <label>
            Ключ восстановления
            <input autoComplete="off" spellCheck={false} required value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} />
          </label>
        )}
        <label>
          {mode === 'recover' ? 'Новый пароль' : 'Пароль'}
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mode === 'login' && needTotp && (
          <label>
            Код из приложения-аутентификатора
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus />
          </label>
        )}
        {mode !== 'login' && (
          <label>
            Пароль ещё раз
            <input type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </label>
        )}
        {mode === 'register' && (
          <>
            <label>
              Код приглашения <span className="muted">(если сервер его просит)</span>
              <input value={invite} onChange={(e) => setInvite(e.target.value)} />
            </label>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Подождите…' : mode === 'login' ? 'Войти' : mode === 'recover' ? 'Задать пароль и войти' : 'Создать аккаунт'}
        </button>
        {mode === 'login' && passkeysSupported() && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await controller.loginWithPasskey();
              } catch (err) {
                setError(message(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Войти по passkey
          </button>
        )}
        {mode === 'login' && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode('recover');
              setError(null);
            }}
          >
            Забыли пароль?
          </button>
        )}
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Создать аккаунт' : 'Вернуться ко входу'}
        </button>
        {!isNative() && (
          <button type="button" className="link muted-link" onClick={() => void controller.startLocal()}>
            Попробовать без сервера: задачи останутся только в этом браузере
          </button>
        )}
      </form>
    </main>
  );
}

export function RecoveryScreen() {
  const { recoveryKey } = useAppState();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <main className="auth">
      <div className="auth-card">
        <h1>Сохраните ключ восстановления</h1>
        <p>
          Если вы забудете пароль, войти и расшифровать задачи можно будет только с этим ключом. Сервер не может восстановить доступ: у него нет ваших
          ключей.
        </p>
        <code className="recovery-key">{recoveryKey}</code>
        <div className="row">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(recoveryKey ?? '');
              setCopied(true);
            }}
          >
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
          <button type="button" onClick={() => window.print()}>
            Распечатать
          </button>
        </div>
        <label className="checkline">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Ключ сохранён в надёжном месте
        </label>
        <button className="primary" disabled={!saved} onClick={() => controller.confirmRecovery()}>
          Продолжить
        </button>
      </div>
    </main>
  );
}
