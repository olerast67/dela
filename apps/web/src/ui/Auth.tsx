import { useState, type FormEvent } from 'react';
import { ApiError, DecryptError, NetworkError } from '#core';
import { controller } from '../controller.ts';
import { isNative, normalizeServerUrl, serverUrl, setServerUrl } from '../platform.ts';
import { useAppState } from '../hooks.ts';
import { passkeysSupported } from '../passkey.ts';
import { tr } from '../i18n.ts';

const ERRORS: Record<string, string> = {
  invalid_credentials: tr('Неверный адрес или пароль.'),
  totp_required: tr('Введите код из приложения-аутентификатора.'),
  invalid_totp: tr('Код не подошёл. Проверьте время на телефоне и введите новый код.'),
  rate_limited: tr('Слишком много попыток. Подождите несколько минут.'),
  invite_required: tr('Регистрация на этом сервере только по приглашению.'),
  registration_closed: tr('Регистрация на этом сервере закрыта.'),
  invalid_invite: tr('Приглашение неверное, использовано или истекло.'),
  email_taken: tr('Этот адрес уже зарегистрирован. Войдите.'),
  passkeys_disabled: tr('На этом сервере вход по passkey выключен: администратору нужно задать DELA_PUBLIC_URL.'),
  challenge_expired: tr('Время на вход вышло. Попробуйте ещё раз.'),
};

function message(err: unknown): string {
  if (err instanceof NetworkError) return tr('Нет связи с сервером.');
  if (err instanceof ApiError) return ERRORS[err.code] ?? tr('Ошибка сервера: {code}', { code: err.code });
  if (err instanceof SyntaxError) return tr('Ключ восстановления введён с ошибкой: проверьте символы.');
  if (err instanceof DecryptError) return tr('Ключ не подходит к этому аккаунту.');
  if (err instanceof Error && err.message === 'prf_unsupported')
    return tr('Этот passkey не умеет PRF, без него ключи шифрования не открыть. Подойдут Google Password Manager, iCloud Keychain, Windows Hello на Windows 11 и ключи FIDO2.');
  if (err instanceof Error && (err.name === 'NotAllowedError' || err.message === 'cancelled')) return tr('Вход по passkey отменён.');
  return tr('Что-то пошло не так. Попробуйте ещё раз.');
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
      if (!url) return setError(tr('Укажите адрес сервера Dela, например tasks.example.com. Нужен HTTPS.'));
      try {
        await fetch(`${url}/api/health`).then((r) => {
          if (!r.ok) throw new Error();
        });
      } catch {
        return setError(tr('По адресу {url} не отвечает сервер Dela.', { url: url }));
      }
      setServerUrl(url);
      controller.api.baseUrl = url;
    }
    if (mode !== 'login') {
      if (password.length < 10) return setError(tr('Пароль должен быть не короче 10 символов.'));
      if (password !== repeat) return setError(tr('Пароли не совпадают.'));
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
        <h1>{mode === 'login' ? tr('Вход в Dela') : mode === 'recover' ? tr('Новый пароль по ключу') : tr('Новый аккаунт Dela')}</h1>
        <p className="muted">
          {mode === 'login'
            ? tr('Задачи шифруются на устройстве, сервер видит только шифротекст.')
            : mode === 'recover'
              ? tr('Ключ восстановления выдавался при регистрации. С ним можно задать новый пароль, задачи сохранятся. Остальные устройства придётся подключить заново.')
              : tr('Пароль не уходит на сервер: из него на устройстве получаются ключи шифрования.')}
        </p>
        {notice && <p className="notice">{notice}</p>}
        {native && (
          <label>
            {tr('Сервер')}
            <input inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="tasks.example.com" required value={server} onChange={(e) => setServer(e.target.value)} />
          </label>
        )}
        <label>
          {tr('Электронная почта')}
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === 'recover' && (
          <label>
            {tr('Ключ восстановления')}
            <input autoComplete="off" spellCheck={false} required value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} />
          </label>
        )}
        <label>
          {mode === 'recover' ? tr('Новый пароль') : tr('Пароль')}
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
            {tr('Код из приложения-аутентификатора')}
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus />
          </label>
        )}
        {mode !== 'login' && (
          <label>
            {tr('Пароль ещё раз')}
            <input type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </label>
        )}
        {mode === 'register' && (
          <>
            <label>
              {tr('Код приглашения')} <span className="muted">{tr('(если сервер его просит)')}</span>
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
          {busy ? tr('Подождите…') : mode === 'login' ? tr('Войти') : mode === 'recover' ? tr('Задать пароль и войти') : tr('Создать аккаунт')}
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
            {tr('Войти по passkey')}
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
            {tr('Забыли пароль?')}
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
          {mode === 'login' ? tr('Создать аккаунт') : tr('Вернуться ко входу')}
        </button>
        {!isNative() && (
          <button type="button" className="link muted-link" onClick={() => void controller.startLocal()}>
            {tr('Попробовать без сервера: задачи останутся только в этом браузере')}
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
        <h1>{tr('Сохраните ключ восстановления')}</h1>
        <p>
          {tr('Если вы забудете пароль, войти и расшифровать задачи можно будет только с этим ключом. Сервер не может восстановить доступ: у него нет ваших ключей.')}
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
            {copied ? tr('Скопировано') : tr('Скопировать')}
          </button>
          <button type="button" onClick={() => window.print()}>
            {tr('Распечатать')}
          </button>
        </div>
        <label className="checkline">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {tr('Ключ сохранён в надёжном месте')}
        </label>
        <button className="primary" disabled={!saved} onClick={() => controller.confirmRecovery()}>
          {tr('Продолжить')}
        </button>
      </div>
    </main>
  );
}
