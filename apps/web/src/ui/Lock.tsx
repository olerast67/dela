/**
 * Блокировка приложения PIN-кодом и отпечатком: экран ввода и раздел настроек.
 * Блокировка закрывает экран на этом устройстве; задачи продолжают синхронизироваться.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { LOCK_TIMEOUTS, MAX_PIN_FAILURES } from '#core';
import { controller } from '../controller.ts';
import { useAppState } from '../hooks.ts';
import { biometryAvailable } from '../platform.ts';
import { tr } from '../i18n.ts';

function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? tr('{n} мин', { n: Math.ceil(s / 60) }) : tr('{s} с', { s: s });
}

export function LockScreen() {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const biometric = controller.lockConfig()?.biometric ?? false;

  useEffect(() => {
    // Отпечаток спрашивается сразу; отказ оставляет ввод PIN.
    if (biometric) void controller.unlockWithBiometry();
  }, [biometric]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await controller.unlock(pin);
      setPin('');
      if (r.kind === 'wrong')
        setMsg(
          r.config.blockedUntil > Date.now()
            ? tr('Неверный PIN. Следующая попытка через {n}. Осталось попыток: {left}.', { n: waitText(r.config.blockedUntil - Date.now()), left: r.left })
            : tr('Неверный PIN. Осталось попыток: {left}.', { left: r.left }),
        );
      if (r.kind === 'blocked') setMsg(tr('Слишком много ошибок. Подождите {n}.', { n: waitText(r.waitMs) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth lock">
      <form className="auth-card" onSubmit={submit}>
        <h1>{tr('Dela заблокирована')}</h1>
        <label>
          {tr('PIN-код')}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            aria-label={tr('PIN-код')}
          />
        </label>
        {msg && (
          <p className="error" role="alert">
            {msg}
          </p>
        )}
        <button className="primary" disabled={busy || pin.length < 4}>
          {tr('Разблокировать')}
        </button>
        {biometric && (
          <button type="button" onClick={() => void controller.unlockWithBiometry()}>
            {tr('Отпечаток пальца')}
          </button>
        )}
        <button
          type="button"
          className="link"
          onClick={() => {
            if (confirm(tr('Выйти из аккаунта? Данные на этом устройстве будут стёрты, войти можно снова с паролем.'))) void controller.logout();
          }}
        >
          {tr('Забыли PIN? Выйти и войти с паролем')}
        </button>
      </form>
    </div>
  );
}

const TIMEOUT_LABEL: Record<number, string> = { 0: tr('Сразу'), 1: tr('Через 1 минуту'), 5: tr('Через 5 минут'), 15: tr('Через 15 минут'), 60: tr('Через час') };

export function LockSettings() {
  const { lockEnabled } = useAppState();
  const config = controller.lockConfig();
  const [mode, setMode] = useState<'idle' | 'change' | 'disable'>('idle');
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [bio, setBio] = useState(false);

  useEffect(() => {
    void biometryAvailable().then(setBio);
  }, []);

  const reset = (text: string | null) => {
    setCurrent('');
    setPin('');
    setRepeat('');
    setMode('idle');
    setMsg(text);
  };

  const digits = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value.replace(/\D/g, ''));
  const pinInput = (label: string, value: string, set: (v: string) => void) => (
    <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} placeholder={label} aria-label={label} value={value} onChange={digits(set)} required />
  );

  const savePin = async (e: FormEvent) => {
    e.preventDefault();
    if (pin !== repeat) return setMsg(tr('PIN-коды не совпадают.'));
    try {
      await controller.setPin(pin, lockEnabled ? current : undefined);
      reset(lockEnabled ? tr('PIN изменён.') : tr('Блокировка включена.'));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : tr('Не получилось.'));
    }
  };

  return (
    <section className="settings">
      <h2>{tr('Блокировка приложения')}</h2>
      <p className="muted">
        {tr('PIN-код закрывает Dela на этом устройстве при запуске и после возвращения из фона. У каждого устройства свой PIN. После {n} неверных попыток подряд данные устройства стираются, и войти можно только с паролем.', { n: MAX_PIN_FAILURES })}
      </p>
      {!lockEnabled && (
        <form className="row" onSubmit={savePin}>
          {pinInput(tr('Новый PIN, 4-8 цифр'), pin, setPin)}
          {pinInput(tr('PIN ещё раз'), repeat, setRepeat)}
          <button disabled={pin.length < 4}>{tr('Включить')}</button>
        </form>
      )}
      {lockEnabled && config && (
        <>
          <label className="row">
            <span>{tr('Блокировать')}</span>
            <select value={config.timeoutMin} onChange={(e) => void controller.updateLock({ timeoutMin: Number(e.target.value) })} aria-label={tr('Когда блокировать')}>
              {LOCK_TIMEOUTS.map((t) => (
                <option key={t} value={t}>
                  {TIMEOUT_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          {bio && (
            <label className="checkline">
              <input type="checkbox" checked={config.biometric} onChange={(e) => void controller.updateLock({ biometric: e.target.checked })} />
              {tr('Разблокировать отпечатком пальца')}
            </label>
          )}
          {mode === 'idle' && (
            <div className="row">
              <button onClick={() => controller.lockNow()}>{tr('Заблокировать сейчас')}</button>
              <button onClick={() => setMode('change')}>{tr('Сменить PIN')}</button>
              <button onClick={() => setMode('disable')}>{tr('Отключить')}</button>
            </div>
          )}
          {mode === 'change' && (
            <form className="row" onSubmit={savePin}>
              {pinInput(tr('Текущий PIN'), current, setCurrent)}
              {pinInput(tr('Новый PIN'), pin, setPin)}
              {pinInput(tr('Новый PIN ещё раз'), repeat, setRepeat)}
              <button>{tr('Сохранить')}</button>
              <button type="button" onClick={() => reset(null)}>
                {tr('Отмена')}
              </button>
            </form>
          )}
          {mode === 'disable' && (
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await controller.disableLock(current);
                  reset(tr('Блокировка отключена.'));
                } catch {
                  setMsg(tr('PIN неверный.'));
                }
              }}
            >
              {pinInput(tr('Текущий PIN'), current, setCurrent)}
              <button>{tr('Отключить блокировку')}</button>
              <button type="button" onClick={() => reset(null)}>
                {tr('Отмена')}
              </button>
            </form>
          )}
        </>
      )}
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}
