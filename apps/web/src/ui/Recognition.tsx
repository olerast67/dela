import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { tr } from '../i18n.ts';
import { platform, recognizeApi, type ModelPack, type RecognizerStatus } from '../platform.ts';
import { createRecognition, downloadError, packState, sizeMb, type RecognizeState } from '../recognize.ts';
import { IconX } from './icons.tsx';

/** Распознавание присланных картинок и голосовых сообщений; одно на приложение. */
export const recognition = createRecognition(recognizeApi);

export function useRecognition(): RecognizeState {
  return useSyncExternalStore(recognition.subscribe, recognition.getState);
}

/** Настройки открыли из плашки «нужна модель»: раздел моделей прокручивается в вид. */
let scrollToModels = false;

export function openModelSettings(): void {
  scrollToModels = true;
  location.hash = '#/settings';
}

/**
 * Плашка вверху экрана: идёт распознавание (с прогрессом и отменой) или нужна модель.
 * Интерфейс под ней работает как обычно.
 */
export function RecognizeBar() {
  const state = useRecognition();
  if (state.phase === 'idle') return null;
  if (state.phase === 'working') {
    return (
      <div className="recognize-bar" role="status">
        <span>{state.kind === 'image' ? tr('Распознаю текст на картинке…') : tr('Распознаю голосовое сообщение…')}</span>
        <div className="file-progress">
          <progress value={state.share} max={1} aria-label={tr('Распознавание')} />
          <span className="muted">{Math.round(state.share * 100)}%</span>
          <button type="button" className="small" onClick={() => void recognition.cancel()}>
            {tr('Отмена')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="recognize-bar" role="status">
      <div className="recognize-bar-head">
        <span>
          {state.kind === 'image'
            ? tr('Чтобы распознать текст на картинке, скачайте языковые данные ({size}). Это нужно один раз, дальше всё работает без интернета.', { size: sizeMb(state.size) })
            : tr('Чтобы распознать голосовое сообщение, скачайте модель распознавания речи ({size}). Это нужно один раз, дальше всё работает без интернета.', { size: sizeMb(state.size) })}
        </span>
        <button type="button" className="icon small" aria-label={tr('Закрыть')} onClick={() => void recognition.dismiss()}>
          <IconX />
        </button>
      </div>
      <div className="row">
        <button type="button" className="primary" onClick={openModelSettings}>
          {tr('Открыть настройки')}
        </button>
      </div>
    </div>
  );
}

const PACKS: ReadonlyArray<readonly [ModelPack, string]> = [
  ['ocr', tr('Текст на картинках: русский и английский')],
  ['ru', tr('Голос: русский')],
  ['en', tr('Голос: английский')],
];

/** Программа для Windows: только модели речи для голосового ввода. */
const DESKTOP_PACKS = PACKS.filter(([pack]) => pack !== 'ocr');

/** Настройки на телефоне и в программе для Windows: скачать и удалить модели распознавания. */
export function RecognitionSettings() {
  const [st, setSt] = useState<RecognizerStatus | null>(null);
  const [progress, setProgress] = useState<{ pack: ModelPack; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = useRecognition();
  const ref = useRef<HTMLElement>(null);

  const refresh = () =>
    void recognizeApi()
      .then((a) => a?.p.status())
      .then((s) => s && setSt(s))
      .catch(() => undefined);

  useEffect(() => {
    if (platform() === 'web') return;
    refresh();
    let off: { remove(): Promise<void> } | null = null;
    let cancelled = false;
    void recognizeApi()
      .then((a) => a?.p.addListener('modelProgress', (e) => setProgress(e)))
      .then((h) => {
        if (!h) return;
        if (cancelled) void h.remove();
        else off = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void off?.remove();
    };
  }, []);

  useEffect(() => {
    if (st && scrollToModels) {
      scrollToModels = false;
      ref.current?.scrollIntoView({ block: 'start' });
    }
  }, [st !== null]);

  if (platform() === 'web' || !st) return null;
  const desktop = platform() === 'tauri';

  const download = async (pack: ModelPack) => {
    const api = (await recognizeApi())?.p;
    if (!api) return;
    setError(null);
    setSt({ ...st, downloading: pack });
    setProgress({ pack, done: 0, total: st[pack].size });
    try {
      await api.download({ pack });
      // Присланный файл ждал эту модель: распознаём сразу.
      void recognition.modelReady();
    } catch (e) {
      setError(downloadError(typeof e === 'object' && e && 'code' in e ? String(e.code) : undefined, platform() === 'tauri'));
    } finally {
      setProgress(null);
      refresh();
    }
  };

  const remove = async (pack: ModelPack) => {
    await (await recognizeApi())?.p.remove({ pack }).catch(() => undefined);
    refresh();
  };

  return (
    <section className="settings" ref={ref}>
      <h2>{desktop ? tr('Голосовой ввод') : tr('Распознавание на телефоне')}</h2>
      <p className="muted">
        {desktop
          ? tr(
              'Задачу можно сказать голосом: кнопка с микрофоном в быстром добавлении и во всплывающей строке (Ctrl+Shift+Space). Речь распознаётся на этом компьютере, звук никуда не отправляется. Модель скачивается один раз с Hugging Face и сверяется по контрольной сумме.',
            )
          : tr(
              'Картинку или голосовое сообщение можно отправить в Dela через «Поделиться», а задачу сказать голосом кнопкой с микрофоном в быстром добавлении: текст распознаётся на телефоне, звук и файлы никуда не отправляются. Модели скачиваются один раз: языковые данные Tesseract с GitHub, модели речи sherpa-onnx с Hugging Face; каждый файл сверяется по контрольной сумме.',
            )}
      </p>
      {waiting.phase === 'need_model' && <p className="notice">{waiting.kind === 'image' ? tr('Картинка ждёт распознавания: скачайте модель для текста.') : tr('Голосовое сообщение ждёт распознавания: скачайте модель речи.')}</p>}
      {(desktop ? DESKTOP_PACKS : PACKS).map(([pack, label]) => {
        const state = packState(pack, st);
        const p = progress?.pack === pack ? progress : null;
        return (
          <div key={pack} className="trash-row model-row">
            <span>
              {label}
              <br />
              <span className="muted">
                {state === 'unsupported'
                  ? desktop
                    ? tr('Недоступно: не найдены библиотеки распознавания, переустановите Dela')
                    : pack === 'ocr'
                      ? tr('Недоступно на этом телефоне')
                      : tr('Недоступно на этом телефоне: нужен 64-битный процессор ARM')
                  : state === 'ready'
                    ? tr('Скачано, {size}', { size: sizeMb(st[pack].size) })
                    : sizeMb(st[pack].size)}
              </span>
            </span>
            {state === 'downloading' && (
              <div className="file-progress">
                <progress value={p ? p.done / Math.max(1, p.total) : 0} max={1} aria-label={tr('Скачивание модели')} />
                <span className="muted">{p ? Math.round((p.done / Math.max(1, p.total)) * 100) : 0}%</span>
                <button type="button" className="small" onClick={() => void recognizeApi().then((a) => a?.p.cancelDownload())}>
                  {tr('Отмена')}
                </button>
              </div>
            )}
            {state === 'missing' && (
              <button type="button" disabled={st.downloading != null} onClick={() => void download(pack)}>
                {tr('Скачать')}
              </button>
            )}
            {state === 'ready' && (
              <button type="button" className="danger" onClick={() => void remove(pack)}>
                {tr('Удалить')}
              </button>
            )}
          </div>
        );
      })}
      {error && <p className="notice">{error}</p>}
    </section>
  );
}
