/**
 * Голосовой ввод задачи. По умолчанию звук распознаётся на устройстве моделью sherpa-onnx (телефон Android
 * и программа для Windows) и никуда не уходит. Без скачанной модели телефон предлагает её скачать или,
 * если пользователь сам выберет, системное распознавание Android, которое может отправлять звук в облако.
 * В браузере голосового ввода нет: модель слишком велика для страницы.
 */
import { tr } from './i18n.ts';
import type { Platform, VoiceSupport } from './platform.ts';
import { speechToQuickAdd } from './recognize.ts';

/** Как слушать по нажатию на микрофон: модель на устройстве, системное распознавание или предложить скачать модель. */
export type VoiceMode = 'offline' | 'system' | 'need_model';

/** null — кнопки микрофона нет. */
export function voiceMode(s: VoiceSupport | null, systemChosen: boolean): VoiceMode | null {
  if (!s) return null;
  if (s.offlineSupported && s.offlineReady) return 'offline';
  // На 32-битном телефоне модель не скачать: остаётся только системное распознавание.
  if (s.system && (systemChosen || !s.offlineSupported)) return 'system';
  if (s.offlineSupported) return 'need_model';
  return null;
}

const SYSTEM_KEY = 'dela.voiceSystem';

/** Пользователь выбрал системное распознавание вместо скачивания модели. Скачанная модель всё равно важнее. */
export function systemVoiceChosen(): boolean {
  try {
    return localStorage.getItem(SYSTEM_KEY) === '1';
  } catch {
    return false;
  }
}

export function chooseSystemVoice(): void {
  try {
    localStorage.setItem(SYSTEM_KEY, '1');
  } catch {
    // без localStorage предложение скачать модель появится снова
  }
}

/** Сказанное в поле быстрого добавления: с заглавной буквы в пустом поле, через пробел после набранного. */
export function appendSpeech(prev: string, said: string): string {
  const s = speechToQuickAdd(said);
  if (!s) return prev;
  const p = prev.trim();
  if (!p) return s;
  // Продолжение фразы: заглавная не нужна, кроме «I» в английском.
  return `${p} ${/^I\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1)}`;
}

/** Сообщение об ошибке записи по коду; null — показывать нечего (отменено, уже идёт запись). */
export function voiceError(code: string | undefined, where: Platform): string | null {
  switch (code) {
    case 'cancelled':
    case 'busy':
      return null;
    case 'permission':
      return tr('Нет доступа к микрофону. Разрешите его Dela в настройках Android.');
    case 'no_mic':
      return where === 'tauri'
        ? tr('Не удалось включить микрофон. Проверьте, что он подключён и что в параметрах Windows классическим приложениям разрешён доступ к микрофону.')
        : tr('Не удалось включить микрофон. Возможно, его занимает другое приложение.');
    case 'no_model':
      return tr('Модель речи не скачана.');
    case 'unsupported':
      return tr('Распознавание речи на этом устройстве недоступно.');
    default:
      return tr('Не удалось распознать речь.');
  }
}
