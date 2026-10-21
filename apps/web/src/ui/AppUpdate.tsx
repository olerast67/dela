import { useEffect, useState } from 'react';
import { appUpdateInfo, checkAndroidUpdate, setUpdateCheckEnabled, updateCheckEnabled, updateErrorCode, type AndroidUpdate } from '../appUpdate.ts';
import { tr } from '../i18n.ts';
import { showToast } from './toast.tsx';

/** Текст ошибки обновления по коду плагина. */
function updateError(code: string): string {
  switch (code) {
    case 'permission':
      return tr('Разрешите Dela установку приложений на открывшемся экране и нажмите «Обновить» ещё раз.');
    case 'checksum':
      return tr('Скачанный файл не совпал с выпуском на GitHub, он удалён.');
    default:
      return tr('Не удалось скачать обновление. Нужна связь с GitHub.');
  }
}

/** Скачать и открыть установку; ход и ошибки — в плашке внизу. */
export async function installAndroidUpdate(u: AndroidUpdate, inSettings?: (text: string) => void): Promise<boolean> {
  const onMessage = inSettings ?? ((t: string) => showToast(t, undefined, 600_000));
  let shown = -1;
  onMessage(tr('Скачиваю версию {version}...', { version: u.version }));
  try {
    await u.install((share) => {
      // Плашка обновляется по 5%, чтобы не мигать.
      const pct = Math.floor(share * 20) * 5;
      if (pct === shown) return;
      shown = pct;
      onMessage(tr('Скачиваю версию {version}: {pct}%', { version: u.version, pct }));
    });
    const done = tr('Версия {version} скачана и проверена. Подтвердите установку.', { version: u.version });
    if (inSettings) inSettings(done);
    else showToast(done, undefined, 5000);
    return true;
  } catch (e) {
    const code = updateErrorCode(e);
    const text = updateError(code);
    if (code === 'permission' && !inSettings) showToast(text, { label: tr('Обновить'), run: () => void installAndroidUpdate(u) }, 120_000);
    else if (inSettings) inSettings(text);
    else showToast(text, undefined, 8000);
    return false;
  }
}

/** При запуске на Android: есть новая версия — плашка «Вышла версия X» с кнопкой «Обновить», как в программе для Windows. */
export async function offerAndroidUpdate(): Promise<void> {
  const u = await checkAndroidUpdate();
  if (u) showToast(tr('Вышла версия {version}', { version: u.version }), { label: tr('Обновить'), run: () => void installAndroidUpdate(u) }, 60_000);
}

/** Настройки на телефоне: версия, выключатель проверки и кнопка. В сборке F-Droid и отладочной раздела нет. */
export function AndroidUpdates() {
  const [info, setInfo] = useState<{ version: string; enabled: boolean } | null>(null);
  const [on, setOn] = useState(updateCheckEnabled);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void appUpdateInfo()
      .then(setInfo)
      .catch(() => undefined);
  }, []);
  if (!info?.enabled) return null;
  return (
    <section className="settings">
      <h2>{tr('Обновления')}</h2>
      <p className="muted">{tr('Установлена версия {version}. Новая версия скачивается с GitHub, сверяется по контрольной сумме выпуска, а Android ставит её, только если она подписана тем же ключом.', { version: info.version })}</p>
      <label className="checkline">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setUpdateCheckEnabled(e.target.checked);
            setOn(e.target.checked);
          }}
        />
        {tr('Проверять обновления')}
      </label>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const u = await checkAndroidUpdate(true);
            if (!u) setMsg(tr('Установлена последняя версия.'));
            else await installAndroidUpdate(u, setMsg);
          } catch {
            setMsg(tr('Не удалось проверить обновления. Нужна связь с GitHub.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr('Проверить обновления')}
      </button>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}
