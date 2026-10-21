import { describe, expect, it } from 'vitest';
import { tr } from '../src/i18n.ts';
import type { VoiceSupport } from '../src/platform.ts';
import { appendSpeech, voiceError, voiceMode } from '../src/voice.ts';

function support(over: Partial<VoiceSupport> = {}): VoiceSupport {
  return { offlineSupported: true, offlineReady: false, modelSize: 28_572_945, system: true, ...over };
}

describe('voiceMode', () => {
  it('в браузере кнопки нет', () => {
    expect(voiceMode(null, false)).toBeNull();
  });

  it('скачанная модель важнее системного распознавания, даже если его выбирали', () => {
    expect(voiceMode(support({ offlineReady: true }), true)).toBe('offline');
  });

  it('без модели по умолчанию предлагается скачать её, а не облако', () => {
    expect(voiceMode(support(), false)).toBe('need_model');
  });

  it('системное распознавание — только по выбору пользователя', () => {
    expect(voiceMode(support(), true)).toBe('system');
  });

  it('на 32-битном телефоне модель не скачать: остаётся системное, а без него кнопки нет', () => {
    expect(voiceMode(support({ offlineSupported: false }), false)).toBe('system');
    expect(voiceMode(support({ offlineSupported: false, system: false }), false)).toBeNull();
  });

  it('на компьютере без модели — предложение скачать', () => {
    expect(voiceMode(support({ system: false }), false)).toBe('need_model');
    expect(voiceMode(support({ system: false }), true)).toBe('need_model');
  });
});

describe('appendSpeech', () => {
  it('в пустом поле — с заглавной', () => {
    expect(appendSpeech('', 'позвонить маме завтра')).toBe('Позвонить маме завтра');
  });

  it('после набранного — через пробел, со строчной', () => {
    expect(appendSpeech('Купить ', 'Молоко и хлеб')).toBe('Купить молоко и хлеб');
  });

  it('английская модель пишет заглавными: переводится в строчные, I остаётся', () => {
    expect(appendSpeech('', 'CALL MOM TOMORROW')).toBe('Call mom tomorrow');
    expect(appendSpeech('Note', "I'LL BUY MILK")).toBe("Note I'll buy milk");
  });

  it('пустая фраза не меняет поле', () => {
    expect(appendSpeech('Задача', '  ')).toBe('Задача');
  });
});

describe('voiceError', () => {
  it('отмена и повторное нажатие без сообщения', () => {
    expect(voiceError('cancelled', 'tauri')).toBeNull();
    expect(voiceError('busy', 'capacitor')).toBeNull();
  });

  it('микрофон: свой совет для Windows и Android', () => {
    expect(voiceError('no_mic', 'tauri')).toContain('Windows');
    expect(voiceError('permission', 'capacitor')).toBe(tr('Нет доступа к микрофону. Разрешите его Dela в настройках Android.'));
  });

  it('неизвестная ошибка', () => {
    expect(voiceError(undefined, 'tauri')).toBe(tr('Не удалось распознать речь.'));
  });
});
