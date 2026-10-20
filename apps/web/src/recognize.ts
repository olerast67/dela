/**
 * Задача из картинки или голосового сообщения, присланных через «Поделиться» на Android.
 * Распознаёт телефон (Tesseract и sherpa-onnx в плагине Recognize), здесь — что с результатом делать:
 * текст открывается в быстром добавлении для правки, задачи без подтверждения не создаются.
 * Пока идёт распознавание, интерфейс работает; его можно отменить.
 */
import { LANG, tr, type Lang } from './i18n.ts';
import type { ModelPack, RecognizeApi, RecognizerStatus, SharedMediaKind } from './platform.ts';

/** Значки списков, которые Tesseract видит на месте маркеров и галочек. «-», «*», «•» и нумерацию снимает splitTaskList. */
const OCR_BULLET = /^[●○◦▪▫■□☐☑☒✓✔✗✘·°©®»>]+\s*/u;

/**
 * Текст с картинки для быстрого добавления: по строке на задачу. Пустые строки и шум без букв и цифр
 * отбрасываются, маркеры списков снимаются, слово с переносом на следующую строку склеивается.
 */
export function ocrToQuickAdd(raw: string): string {
  const out: string[] = [];
  let gap = true;
  for (const source of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const line = source.replace(/[\s ]+/g, ' ').trim().replace(OCR_BULLET, '');
    if (!line) {
      gap = true;
      continue;
    }
    // Одиночная буква или чёрточка — это пятно на фото, а не задача.
    if ((line.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && !gap && /\p{L}[-‐­]$/u.test(prev) && /^\p{Ll}/u.test(line)) {
      out[out.length - 1] = prev.slice(0, -1) + line;
      continue;
    }
    out.push(line);
    gap = false;
  }
  return out.slice(0, 100).join('\n');
}

/** Голосовое сообщение для быстрого добавления: одна фраза с заглавной буквы. */
export function speechToQuickAdd(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Английская модель (LibriSpeech) пишет заглавными: переводим в строчные.
  if (!/\p{Ll}/u.test(s)) s = s.toLowerCase().replace(/(^| )i(?=$| |')/g, '$1I');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Какая модель нужна присланному файлу. Голос распознаётся моделью языка приложения, а если скачана
 * только другая — ею. null — на этом телефоне распознавание недоступно.
 */
export function packFor(kind: SharedMediaKind, st: RecognizerStatus, lang: Lang): { readonly pack: ModelPack; readonly ready: boolean } | null {
  if (kind === 'image') return st.ocrSupported ? { pack: 'ocr', ready: st.ocr.ready } : null;
  if (!st.speechSupported) return null;
  const first: ModelPack = lang === 'en' ? 'en' : 'ru';
  const second: ModelPack = first === 'en' ? 'ru' : 'en';
  if (st[first].ready) return { pack: first, ready: true };
  if (st[second].ready) return { pack: second, ready: true };
  return { pack: first, ready: false };
}

export type PackState = 'unsupported' | 'missing' | 'downloading' | 'ready';

/** Состояние модели для строки в настройках. */
export function packState(pack: ModelPack, st: RecognizerStatus): PackState {
  if (!(pack === 'ocr' ? st.ocrSupported : st.speechSupported)) return 'unsupported';
  if (st.downloading === pack) return 'downloading';
  return st[pack].ready ? 'ready' : 'missing';
}

/** Размер модели для подписи: «27 МБ». */
export function sizeMb(bytes: number): string {
  return tr('{n} МБ', { n: Math.max(1, Math.round(bytes / 1024 / 1024)) });
}

/** Сообщение об ошибке скачивания модели по коду из плагина; null — отменено пользователем. */
export function downloadError(code: string | undefined): string | null {
  switch (code) {
    case 'cancelled':
      return null;
    case 'no_space':
      return tr('На телефоне не хватает места для модели.');
    case 'checksum':
      return tr('Скачанный файл не совпал с ожидаемым, он удалён. Попробуйте ещё раз.');
    case 'busy':
      return tr('Сейчас уже скачивается другая модель.');
    default:
      return tr('Не удалось скачать модель. Проверьте интернет и попробуйте ещё раз.');
  }
}

export type RecognizeState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'working'; readonly kind: SharedMediaKind; readonly share: number }
  /** Модель не скачана: файл ждёт, пока её скачают в настройках. */
  | { readonly phase: 'need_model'; readonly kind: SharedMediaKind; readonly pack: ModelPack; readonly size: number };

export interface Recognized {
  readonly kind: SharedMediaKind;
  /** Текст для быстрого добавления: у картинки по строке на задачу, у голоса одна фраза. */
  readonly text: string;
}

export interface Recognition {
  getState(): RecognizeState;
  subscribe(fn: () => void): () => void;
  /** Куда отдать результат и короткие сообщения (ошибки, «текст не найден»). */
  setHandlers(onResult: ((r: Recognized) => void) | null, onMessage: ((text: string) => void) | null): void;
  /** Прислали картинку или голосовое: распознать или попросить скачать модель. */
  shared(kind: SharedMediaKind): Promise<void>;
  /** Отменить распознавание. */
  cancel(): Promise<void>;
  /** Отказаться от файла, который ждёт модель. */
  dismiss(): Promise<void>;
  /** Модель скачана в настройках: если файл её ждал, распознать его. */
  modelReady(): Promise<void>;
}

function codeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

export function createRecognition(getApi: () => Promise<RecognizeApi | null>, lang: Lang = LANG): Recognition {
  let state: RecognizeState = { phase: 'idle' };
  const listeners = new Set<() => void>();
  let onResult: ((r: Recognized) => void) | null = null;
  let onMessage: ((text: string) => void) | null = null;
  // Номер запуска: результат отменённого или заменённого распознавания не показывается.
  let run = 0;

  const set = (next: RecognizeState) => {
    state = next;
    for (const fn of listeners) fn();
  };
  const say = (text: string) => onMessage?.(text);

  async function start(api: RecognizeApi, kind: SharedMediaKind): Promise<void> {
    const id = ++run;
    let st: RecognizerStatus;
    try {
      st = await api.status();
    } catch {
      if (id === run) set({ phase: 'idle' });
      say(kind === 'image' ? tr('Не удалось распознать картинку.') : tr('Не удалось распознать голосовое сообщение.'));
      return;
    }
    if (id !== run) return;
    const need = packFor(kind, st, lang);
    if (!need) {
      set({ phase: 'idle' });
      await api.discard().catch(() => undefined);
      say(kind === 'image' ? tr('Распознавание текста на этом телефоне недоступно.') : tr('Распознавание речи работает только на 64-битных телефонах.'));
      return;
    }
    if (!need.ready) {
      set({ phase: 'need_model', kind, pack: need.pack, size: st[need.pack].size });
      return;
    }
    set({ phase: 'working', kind, share: 0 });
    const sub = await api
      .addListener('progress', (e) => {
        if (id === run && state.phase === 'working') set({ ...state, share: Math.min(1, Math.max(0, e.share)) });
      })
      .catch(() => null);
    try {
      const r = await api.recognize({ lang });
      if (id !== run) return;
      set({ phase: 'idle' });
      const text = r.kind === 'image' ? ocrToQuickAdd(r.text) : speechToQuickAdd(r.text);
      if (text) onResult?.({ kind: r.kind, text });
      else say(r.kind === 'image' ? tr('На картинке не нашлось текста.') : tr('В сообщении не удалось разобрать слова.'));
    } catch (e) {
      if (id !== run) return;
      set({ phase: 'idle' });
      const code = codeOf(e);
      if (code === 'cancelled' || code === 'no_media') return;
      say(kind === 'image' ? tr('Не удалось распознать картинку.') : tr('Не удалось распознать голосовое сообщение. Подходят ogg, opus, m4a, mp3 и wav.'));
    } finally {
      void sub?.remove();
    }
  }

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setHandlers(result, message) {
      onResult = result;
      onMessage = message;
    },
    async shared(kind) {
      const api = await getApi();
      if (!api) return;
      // Новый файл заменил прежний: прежнее распознавание больше не нужно.
      if (state.phase === 'working') await api.cancel().catch(() => undefined);
      await start(api, kind);
    },
    async cancel() {
      run++;
      set({ phase: 'idle' });
      await (await getApi())?.cancel().catch(() => undefined);
    },
    async dismiss() {
      run++;
      set({ phase: 'idle' });
      await (await getApi())?.discard().catch(() => undefined);
    },
    async modelReady() {
      if (state.phase !== 'need_model') return;
      const api = await getApi();
      if (api) await start(api, state.kind);
    },
  };
}
