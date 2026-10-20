import { describe, expect, it } from 'vitest';
import { splitTaskList } from '#core';
import { tr } from '../src/i18n.ts';
import { createRecognition, downloadError, ocrToQuickAdd, packFor, packState, speechToQuickAdd, type Recognized } from '../src/recognize.ts';
import type { ModelPack, RecognizeApi, RecognizerStatus, SharedMediaKind } from '../src/platform.ts';

function status(over: Partial<RecognizerStatus> = {}): RecognizerStatus {
  return {
    ocr: { ready: false, size: 7_974_826 },
    ru: { ready: false, size: 28_572_945 },
    en: { ready: false, size: 73_440_167 },
    ocrSupported: true,
    speechSupported: true,
    downloading: null,
    pending: null,
    ...over,
  };
}

describe('ocrToQuickAdd', () => {
  it('строка на задачу, пустые строки и шум отброшены', () => {
    expect(ocrToQuickAdd('Купить молоко\n\n  позвонить   маме \n|\n—\n\nзабрать посылку\n')).toBe('Купить молоко\nпозвонить маме\nзабрать посылку');
  });

  it('снимает значки, которые Tesseract видит на месте маркеров и галочек', () => {
    expect(ocrToQuickAdd('● хлеб\n☐ сыр\n✓ кефир\n» яйца')).toBe('хлеб\nсыр\nкефир\nяйца');
  });

  it('склеивает слово, перенесённое на следующую строку', () => {
    expect(ocrToQuickAdd('Записаться к стомато-\nлогу в пятницу\nОплатить счёт')).toBe('Записаться к стоматологу в пятницу\nОплатить счёт');
    // Через пустую строку и перед заглавной буквой это не перенос.
    expect(ocrToQuickAdd('Москва-\n\nпитер')).toBe('Москва-\nпитер');
    expect(ocrToQuickAdd('Ростов-\nДон')).toBe('Ростов-\nДон');
  });

  it('строчные пункты списка не склеиваются друг с другом', () => {
    expect(ocrToQuickAdd('купить хлеб\nвынести мусор')).toBe('купить хлеб\nвынести мусор');
  });

  it('результат разбирается быстрым добавлением как список, отметки и нумерация снимаются', () => {
    const lines = splitTaskList(ocrToQuickAdd('1. Купить хлеб завтра\n2. Позвонить маме\n- [x] Сделано'));
    expect(lines?.map((l) => l.text)).toEqual(['Купить хлеб завтра', 'Позвонить маме']);
  });

  it('одна строка остаётся одной задачей, пустая картинка — пустой текст', () => {
    expect(splitTaskList(ocrToQuickAdd('  Позвонить в банк  \n'))).toBeNull();
    expect(ocrToQuickAdd('\n \n.\n')).toBe('');
  });

  it('не больше 100 строк', () => {
    const many = Array.from({ length: 150 }, (_, i) => `Задача ${i}`).join('\n');
    expect(ocrToQuickAdd(many).split('\n')).toHaveLength(100);
  });
});

describe('speechToQuickAdd', () => {
  it('одна фраза с заглавной буквы', () => {
    expect(speechToQuickAdd('  позвонить маме\nзавтра в семь  ')).toBe('Позвонить маме завтра в семь');
  });

  it('английская модель пишет заглавными: текст переводится в строчные', () => {
    expect(speechToQuickAdd('CALL MOM TOMORROW I THINK AT SEVEN')).toBe('Call mom tomorrow I think at seven');
    expect(speechToQuickAdd("I'M BUYING MILK")).toBe("I'm buying milk");
  });

  it('пустой результат', () => {
    expect(speechToQuickAdd('   ')).toBe('');
  });
});

describe('модели', () => {
  it('картинке нужны языковые данные Tesseract', () => {
    expect(packFor('image', status(), 'ru')).toEqual({ pack: 'ocr', ready: false });
    expect(packFor('image', status({ ocr: { ready: true, size: 1 } }), 'ru')).toEqual({ pack: 'ocr', ready: true });
    expect(packFor('image', status({ ocrSupported: false }), 'ru')).toBeNull();
  });

  it('голосу — модель языка приложения, а если скачана только другая, то она', () => {
    expect(packFor('audio', status(), 'ru')).toEqual({ pack: 'ru', ready: false });
    expect(packFor('audio', status(), 'en')).toEqual({ pack: 'en', ready: false });
    expect(packFor('audio', status({ en: { ready: true, size: 1 } }), 'ru')).toEqual({ pack: 'en', ready: true });
    expect(packFor('audio', status({ ru: { ready: true, size: 1 }, en: { ready: true, size: 1 } }), 'en')).toEqual({ pack: 'en', ready: true });
    expect(packFor('audio', status({ speechSupported: false, ru: { ready: true, size: 1 } }), 'ru')).toBeNull();
  });

  it('состояние строки в настройках', () => {
    expect(packState('ru', status())).toBe('missing');
    expect(packState('ru', status({ downloading: 'ru' }))).toBe('downloading');
    expect(packState('en', status({ downloading: 'ru' }))).toBe('missing');
    expect(packState('ocr', status({ ocr: { ready: true, size: 1 } }))).toBe('ready');
    expect(packState('en', status({ speechSupported: false }))).toBe('unsupported');
    expect(packState('ocr', status({ speechSupported: false }))).toBe('missing');
  });

  it('ошибки скачивания', () => {
    expect(downloadError('cancelled')).toBeNull();
    // Язык тестов берётся из системы, поэтому сообщения сравниваются через tr().
    expect(downloadError('no_space')).toBe(tr('На телефоне не хватает места для модели.'));
    expect(downloadError('checksum')).toBe(tr('Скачанный файл не совпал с ожидаемым, он удалён. Попробуйте ещё раз.'));
    expect(downloadError(undefined)).toBe(tr('Не удалось скачать модель. Проверьте интернет и попробуйте ещё раз.'));
  });
});

/** Плагин Recognize без Android: результат распознавания задаёт тест. */
function fakeApi(st: RecognizerStatus) {
  const calls: string[] = [];
  let progress: ((e: { share: number }) => void) | null = null;
  let finish: ((r: { kind: SharedMediaKind; text: string }) => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  const api: RecognizeApi = {
    status: async () => st,
    download: async () => undefined,
    cancelDownload: async () => undefined,
    remove: async () => undefined,
    recognize: (o) => {
      calls.push(`recognize:${o.lang}`);
      return new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    },
    cancel: async () => {
      calls.push('cancel');
      fail?.(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    },
    discard: async () => {
      calls.push('discard');
    },
    addListener: (async (_event: string, cb: (e: { share: number }) => void) => {
      progress = cb;
      return { remove: async () => undefined };
    }) as RecognizeApi['addListener'],
  };
  return {
    api,
    calls,
    progress: (share: number) => progress?.({ share }),
    finish: (kind: SharedMediaKind, text: string) => finish?.({ kind, text }),
    fail: (code: string) => fail?.(Object.assign(new Error(code), { code })),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(st: RecognizerStatus, lang: 'ru' | 'en' = 'ru') {
  const fake = fakeApi(st);
  const rec = createRecognition(async () => fake.api, lang);
  const results: Recognized[] = [];
  const messages: string[] = [];
  rec.setHandlers((r) => results.push(r), (m) => messages.push(m));
  return { fake, rec, results, messages };
}

describe('распознавание присланного файла', () => {
  it('картинка: прогресс, потом текст для правки по строке на задачу', async () => {
    const { fake, rec, results } = setup(status({ ocr: { ready: true, size: 1 } }));
    const done = rec.shared('image');
    await tick();
    expect(rec.getState()).toEqual({ phase: 'working', kind: 'image', share: 0 });
    fake.progress(0.4);
    expect(rec.getState()).toEqual({ phase: 'working', kind: 'image', share: 0.4 });
    fake.finish('image', '● Купить хлеб\n\nПозвонить маме\n');
    await done;
    expect(rec.getState()).toEqual({ phase: 'idle' });
    expect(results).toEqual([{ kind: 'image', text: 'Купить хлеб\nПозвонить маме' }]);
  });

  it('голос: одна фраза, язык приложения уходит в плагин', async () => {
    const { fake, rec, results } = setup(status({ en: { ready: true, size: 1 } }), 'en');
    const done = rec.shared('audio');
    await tick();
    fake.finish('audio', 'BUY MILK TOMORROW');
    await done;
    expect(fake.calls).toEqual(['recognize:en']);
    expect(results).toEqual([{ kind: 'audio', text: 'Buy milk tomorrow' }]);
  });

  it('без модели файл ждёт; после скачивания распознаётся сам', async () => {
    const st = { ...status() };
    const { fake, rec, results } = setup(st);
    await rec.shared('audio');
    expect(rec.getState()).toEqual({ phase: 'need_model', kind: 'audio', pack: 'ru', size: 28_572_945 });
    expect(fake.calls).toEqual([]);
    Object.assign(st, { ru: { ready: true, size: 28_572_945 } });
    const done = rec.modelReady();
    await tick();
    expect(rec.getState().phase).toBe('working');
    fake.finish('audio', 'позвонить маме');
    await done;
    expect(results).toEqual([{ kind: 'audio', text: 'Позвонить маме' }]);
  });

  it('отказ от ожидающего файла удаляет его на телефоне', async () => {
    const { fake, rec } = setup(status());
    await rec.shared('image');
    await rec.dismiss();
    expect(rec.getState()).toEqual({ phase: 'idle' });
    expect(fake.calls).toEqual(['discard']);
    await rec.modelReady();
    expect(fake.calls).toEqual(['discard']);
  });

  it('отмена: результата и сообщения об ошибке нет', async () => {
    const { fake, rec, results, messages } = setup(status({ ocr: { ready: true, size: 1 } }));
    const done = rec.shared('image');
    await tick();
    await rec.cancel();
    expect(rec.getState()).toEqual({ phase: 'idle' });
    fake.finish('image', 'поздний результат');
    await done;
    expect(results).toEqual([]);
    expect(messages).toEqual([]);
    expect(fake.calls).toContain('cancel');
  });

  it('новый файл во время распознавания отменяет прежний', async () => {
    const { fake, rec, results } = setup(status({ ocr: { ready: true, size: 1 }, ru: { ready: true, size: 1 } }));
    const first = rec.shared('image');
    await tick();
    const second = rec.shared('audio');
    await first;
    await tick();
    expect(rec.getState()).toEqual({ phase: 'working', kind: 'audio', share: 0 });
    fake.finish('audio', 'вынести мусор');
    await second;
    expect(fake.calls).toEqual(['recognize:ru', 'cancel', 'recognize:ru']);
    expect(results).toEqual([{ kind: 'audio', text: 'Вынести мусор' }]);
  });

  it('ошибка и пустой результат — короткое сообщение', async () => {
    const { fake, rec, results, messages } = setup(status({ ocr: { ready: true, size: 1 }, ru: { ready: true, size: 1 } }));
    let done = rec.shared('audio');
    await tick();
    fake.fail('failed');
    await done;
    expect(messages).toEqual([tr('Не удалось распознать голосовое сообщение. Подходят ogg, opus, m4a, mp3 и wav.')]);
    done = rec.shared('image');
    await tick();
    fake.finish('image', ' \n | \n');
    await done;
    expect(messages[1]).toBe(tr('На картинке не нашлось текста.'));
    expect(results).toEqual([]);
  });

  it('телефон без библиотек: файл отбрасывается с объяснением', async () => {
    const { fake, rec, messages } = setup(status({ speechSupported: false }));
    await rec.shared('audio');
    expect(rec.getState()).toEqual({ phase: 'idle' });
    expect(fake.calls).toEqual(['discard']);
    expect(messages).toEqual([tr('Распознавание речи работает только на 64-битных телефонах.')]);
  });

  it('модели: pack у ожидающего файла — тот, что нужно скачать', async () => {
    const packs: ModelPack[] = [];
    for (const [kind, lang] of [['image', 'ru'], ['audio', 'ru'], ['audio', 'en']] as const) {
      const { rec } = setup(status(), lang);
      await rec.shared(kind);
      const s = rec.getState();
      if (s.phase === 'need_model') packs.push(s.pack);
    }
    expect(packs).toEqual(['ocr', 'ru', 'en']);
  });
});
