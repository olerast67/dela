import { beforeAll, describe, expect, it } from 'vitest';

// Как в WebView на телефоне: Android объявил плагин Ping с одним методом ping.
beforeAll(() => {
  const Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    PluginHeaders: [{ name: 'Ping', methods: [{ name: 'ping', rtype: 'promise' }] }],
    nativePromise: async (plugin: string, method: string) => `${plugin}.${method}`,
  };
  // platform() смотрит в window, @capacitor/core — в globalThis и по androidBridge узнаёт Android.
  Object.assign(globalThis, { Capacitor, androidBridge: {}, window: { Capacitor } });
});

const HANG = 'не завершился';
const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<string>((r) => setTimeout(() => r(HANG), 200))]);

describe('плагины Capacitor', () => {
  it('nativePlugin отдаёт прокси в обёртке, и await её завершается', async () => {
    const { nativePlugin } = await import('../src/platform.ts');
    const w = await within(nativePlugin<{ ping(): Promise<string> }>('Ping'));
    expect(w).not.toBe(HANG);
    expect(await (w as { p: { ping(): Promise<string> } }).p.ping()).toBe('Ping.ping');
  });

  it('сам прокси из async-функции не возвращается никогда: поэтому нужна обёртка', async () => {
    const { nativePlugin } = await import('../src/platform.ts');
    const p = (await nativePlugin<object>('Ping'))!.p;
    const unwrapped = async () => p;
    const swallow = (e: unknown) => e;
    process.on('unhandledRejection', swallow);
    try {
      expect(await within(unwrapped())).toBe(HANG);
    } finally {
      process.off('unhandledRejection', swallow);
    }
  });
});
