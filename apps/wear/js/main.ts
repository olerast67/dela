/**
 * Точка входа сборки для QuickJS на часах. Приложение ставит globalThis.__host, затем исполняет сборку
 * и зовёт DelaWear.call(имя, аргументы JSON); ответ — строка JSON через Promise.
 */
import './install.ts';
import { host } from './host.ts';
import { createWear } from './wear.ts';

const h = host();
const wear = createWear({
  deviceName: h.deviceName(),
  log: (msg) => h.log(msg),
  file: {
    exists: () => h.vaultExists(),
    read: () => h.vaultRead(),
    write: (json) => h.vaultWrite(json),
    remove: () => h.vaultRemove(),
  },
});

(globalThis as Record<string, unknown>).DelaWear = {
  call: async (name: string, args: string): Promise<string> => JSON.stringify(await wear.call(name, JSON.parse(args || '{}') as Record<string, unknown>)),
};
