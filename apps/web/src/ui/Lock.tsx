/**
 * Блокировка приложения PIN-кодом и отпечатком: экран ввода и раздел настроек.
 * Блокировка закрывает экран на этом устройстве; задачи продолжают синхронизироваться.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { LOCK_TIMEOUTS, MAX_PIN_FAILURES } from '#core';
import { controller } from '../controller.ts';
import { useAppState } from '../hooks.ts';
import { biometryAvailable } from '../platform.ts';

function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.ceil(s / 60)} мин` : `${s} с`;
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
            ? `Неверный PIN. Следующая попытка через ${waitText(r.config.blockedUntil - Date.now())}. Осталось попыток: ${r.left}.`
            : `Неверный PIN. Осталось попыток: ${r.left}.`,
        );
      if (r.kind === 'blocked') setMsg(`Слишком много ошибок. Подождите ${waitText(r.waitMs)}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth lock">
      <form className="auth-card" onSubmit={submit}>
        <h1>Dela заблокирована</h1>
        <label>
          PIN-код
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            aria-label="PIN-код"
          />
        </label>
        {msg && (
          <p className="error" role="alert">
            {msg}
          </p>
        )}
        <button className="primary" disabled={busy || pin.length < 4}>
          Разблокировать
        </button>
        {biometric && (
          <button type="button" onClick={() => void controller.unlockWithBiometry()}>
            Отпечаток пальца
          </button>
        )}
        <button
          type="button"
          className="link"
          onClick={() => {
            if (confirm('Выйти из аккаунта? Данные на этом устройстве будут стёрты, войти можно снова с паролем.')) void controller.logout();
          }}
        >
          Забыли PIN? Выйти и войти с паролем
        </button>
      </form>
    </div>
  );
}

const TIMEOUT_LABEL: Record<number, string> = { 0: 'Сразу', 1: 'Через 1 минуту', 5: 'Через 5 минут', 15: 'Через 15 минут', 60: 'Через час' };

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
    if (pin !== repeat) return setMsg('PIN-коды не совпадают.');
    try {
      await controller.setPin(pin, lockEnabled ? current : undefined);
      reset(lockEnabled ? 'PIN изменён.' : 'Блокировка включена.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Не получилось.');
    }
  };

  return (
    <section className="settings">
      <h2>Блокировка приложения</h2>
      <p className="muted">
        PIN-код закрывает Dela на этом устройстве при запуске и после возвращения из фона. У каждого устройства свой PIN. После {MAX_PIN_FAILURES} неверных
        попыток подряд данные устройства стираются, и войти можно только с паролем.
      </p>
      {!lockEnabled && (
        <form className="row" onSubmit={savePin}>
          {pinInput('Новый PIN, 4-8 цифр', pin, setPin)}
          {pinInput('PIN ещё раз', repeat, setRepeat)}
          <button disabled={pin.length < 4}>Включить</button>
        </form>
      )}
      {lockEnabled && config && (
        <>
          <label className="row">
            <span>Блокировать</span>
            <select value={config.timeoutMin} onChange={(e) => void controller.updateLock({ timeoutMin: Number(e.target.value) })} aria-label="Когда блокировать">
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
              Разблокировать отпечатком пальца
            </label>
          )}
          {mode === 'idle' && (
            <div className="row">
              <button onClick={() => controller.lockNow()}>Заблокировать сейчас</button>
              <button onClick={() => setMode('change')}>Сменить PIN</button>
              <button onClick={() => setMode('disable')}>Отключить</button>
            </div>
          )}
          {mode === 'change' && (
            <form className="row" onSubmit={savePin}>
              {pinInput('Текущий PIN', current, setCurrent)}
              {pinInput('Новый PIN', pin, setPin)}
              {pinInput('Новый PIN ещё раз', repeat, setRepeat)}
              <button>Сохранить</button>
              <button type="button" onClick={() => reset(null)}>
                Отмена
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
                  reset('Блокировка отключена.');
                } catch {
                  setMsg('PIN неверный.');
                }
              }}
            >
              {pinInput('Текущий PIN', current, setCurrent)}
              <button>Отключить блокировку</button>
              <button type="button" onClick={() => reset(null)}>
                Отмена
              </button>
            </form>
          )}
        </>
      )}
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}
