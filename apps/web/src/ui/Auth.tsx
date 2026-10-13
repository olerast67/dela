import { useState, type FormEvent } from 'react';
import { ApiError, NetworkError } from '#core';
import { controller } from '../controller.ts';
import { useAppState } from '../hooks.ts';

const ERRORS: Record<string, string> = {
  invalid_credentials: 'Неверный адрес или пароль.',
  rate_limited: 'Слишком много попыток. Подождите несколько минут.',
  invite_required: 'Регистрация на этом сервере только по приглашению.',
  invalid_invite: 'Приглашение неверное, использовано или истекло.',
  email_taken: 'Этот адрес уже зарегистрирован. Войдите.',
};

function message(err: unknown): string {
  if (err instanceof NetworkError) return 'Нет связи с сервером.';
  if (err instanceof ApiError) return ERRORS[err.code] ?? `Ошибка сервера: ${err.code}`;
  return 'Что-то пошло не так. Попробуйте ещё раз.';
}

export function AuthScreen() {
  const { notice } = useAppState();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [invite, setInvite] = useState(() => new URLSearchParams(location.search).get('invite') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'register') {
      if (password.length < 10) return setError('Пароль должен быть не короче 10 символов.');
      if (password !== repeat) return setError('Пароли не совпадают.');
    }
    setBusy(true);
    // Даём браузеру отрисовать «Подождите…»: вычисление ключа из пароля занимает около секунды.
    await new Promise((r) => setTimeout(r, 30));
    try {
      if (mode === 'login') await controller.login(email, password);
      else await controller.register(email, password, invite.trim() || undefined);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width="48" height="48" />
        <h1>{mode === 'login' ? 'Вход в Dela' : 'Новый аккаунт Dela'}</h1>
        <p className="muted">
          {mode === 'login'
            ? 'Задачи шифруются на устройстве, сервер видит только шифротекст.'
            : 'Пароль не уходит на сервер: из него на устройстве получаются ключи шифрования.'}
        </p>
        {notice && <p className="notice">{notice}</p>}
        <label>
          Электронная почта
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Пароль
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mode === 'register' && (
          <>
            <label>
              Пароль ещё раз
              <input type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </label>
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
          {busy ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Создать аккаунт' : 'У меня уже есть аккаунт'}
        </button>
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
        <label className="check">
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
