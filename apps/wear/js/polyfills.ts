/**
 * Чего нет в QuickJS, но нужно ядру: TextEncoder/TextDecoder, Intl.DateTimeFormat (только пояса и formatToParts),
 * crypto.getRandomValues, URL (origin и pathname), fetch и console. Пояса и случайные байты берутся у приложения
 * (java.time и SecureRandom). Ставится только то, чего нет: в Node и браузере остаются родные реализации.
 */
import { fromHex, host } from './host.ts';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

class Utf8Encoder {
  readonly encoding = 'utf-8';
  encode(s = ''): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      // Одиночная половинка суррогатной пары кодируется как U+FFFD, как в TextEncoder.
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
}

class Utf8Decoder {
  readonly encoding = 'utf-8';
  private readonly fatal: boolean;
  constructor(_label = 'utf-8', options: { fatal?: boolean } = {}) {
    this.fatal = options.fatal === true;
  }
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return '';
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let s = '';
    const bad = (): string => {
      if (this.fatal) throw new TypeError('The encoded data was not valid utf-8');
      return '�';
    };
    for (let i = 0; i < b.length; ) {
      const c = b[i]!;
      let need = 0;
      let cp = 0;
      let min = 0;
      if (c < 0x80) {
        s += String.fromCharCode(c);
        i++;
        continue;
      } else if (c >= 0xc2 && c <= 0xdf) [need, cp, min] = [1, c & 31, 0x80];
      else if (c >= 0xe0 && c <= 0xef) [need, cp, min] = [2, c & 15, 0x800];
      else if (c >= 0xf0 && c <= 0xf4) [need, cp, min] = [3, c & 7, 0x10000];
      else {
        s += bad();
        i++;
        continue;
      }
      let ok = i + need < b.length;
      for (let k = 1; ok && k <= need; k++) {
        const d = b[i + k];
        if (d === undefined || (d & 0xc0) !== 0x80) ok = false;
        else cp = (cp << 6) | (d & 63);
      }
      if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        s += bad();
        i++;
        continue;
      }
      s += String.fromCodePoint(cp);
      i += need + 1;
    }
    return s;
  }
}

interface Part {
  type: string;
  value: string;
}

/** Intl.DateTimeFormat для dates.ts: formatToParts в формате en-US с hourCycle h23 и resolvedOptions().timeZone. */
function DateTimeFormat(this: unknown, _locale?: string, options: { timeZone?: string } = {}): unknown {
  if (!(this instanceof DateTimeFormat)) return new (DateTimeFormat as unknown as new (l?: string, o?: { timeZone?: string }) => unknown)(_locale, options);
  const tz = options.timeZone ?? host().defaultZone();
  if (host().zone(0, tz) === null) throw new RangeError(`Invalid time zone specified: ${tz}`);
  (this as { tz: string }).tz = tz;
  return this;
}
DateTimeFormat.prototype.formatToParts = function (this: { tz: string }, d: Date | number = Date.now()): Part[] {
  const s = host().zone(+d, this.tz)!;
  const [date, time] = s.split(' ') as [string, string];
  const [year, month, day] = date.split('-') as [string, string, string];
  const [hour, minute, second] = time.split(':') as [string, string, string];
  const lit = (value: string): Part => ({ type: 'literal', value });
  return [
    { type: 'month', value: month },
    lit('/'),
    { type: 'day', value: day },
    lit('/'),
    { type: 'year', value: year },
    lit(', '),
    { type: 'hour', value: hour },
    lit(':'),
    { type: 'minute', value: minute },
    lit(':'),
    { type: 'second', value: second },
  ];
};
DateTimeFormat.prototype.format = function (this: { formatToParts(d?: Date | number): Part[] }, d?: Date | number): string {
  return this.formatToParts(d).map((p) => p.value).join('');
};
DateTimeFormat.prototype.resolvedOptions = function (this: { tz: string }) {
  return { locale: 'en-US', calendar: 'gregory', numberingSystem: 'latn', timeZone: this.tz };
};

/** Только то, что нужно для адреса сервера: протокол, хост и путь. */
class MiniUrl {
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly origin: string;
  constructor(input: string) {
    const m = /^(https?:)\/\/([^/?#@\s]+)([^?#\s]*)/i.exec(input);
    if (!m) throw new TypeError(`Invalid URL: ${input}`);
    this.protocol = m[1]!.toLowerCase();
    this.host = m[2]!.toLowerCase();
    this.hostname = this.host.replace(/:\d+$/, '');
    this.pathname = m[3] || '/';
    this.origin = `${this.protocol}//${this.host}`;
  }
  toString(): string {
    return this.origin + this.pathname;
  }
}

interface HostResponse {
  status?: number;
  body?: string;
  error?: string;
}

/** fetch поверх синхронного запроса приложения: движок и так работает в своём потоке. */
function hostFetch(input: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
  try {
    if (init.body !== undefined && typeof init.body !== 'string') throw new TypeError('only text bodies are supported');
    const raw = JSON.parse(host().http(init.method ?? 'GET', input, JSON.stringify(init.headers ?? {}), (init.body as string | undefined) ?? null)) as HostResponse;
    if (raw.error !== undefined || raw.status === undefined) return Promise.reject(new TypeError(raw.error ?? 'network error'));
    const status = raw.status;
    const body = raw.body ?? '';
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body) as unknown,
      text: async () => body,
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

export function installPolyfills(): void {
  if (typeof g.TextEncoder !== 'function') g.TextEncoder = Utf8Encoder;
  if (typeof g.TextDecoder !== 'function') g.TextDecoder = Utf8Decoder;
  if (typeof g.Intl !== 'object' || g.Intl === null) g.Intl = { DateTimeFormat };
  const c = g.crypto as { getRandomValues?: unknown } | undefined;
  if (!c || typeof c.getRandomValues !== 'function') {
    g.crypto = {
      getRandomValues<T extends ArrayBufferView>(arr: T): T {
        new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(fromHex(host().randomHex(arr.byteLength)));
        return arr;
      },
    };
  }
  if (typeof g.URL !== 'function') g.URL = MiniUrl;
  if (typeof g.fetch !== 'function') g.fetch = hostFetch;
  if (typeof g.console !== 'object' || g.console === null) {
    const log = (...args: unknown[]) => host().log(args.map(String).join(' '));
    g.console = { log, info: log, warn: log, error: log, debug: log };
  }
}

/** Для тестов: те же реализации, без установки в globalThis. */
export const testing = { Utf8Encoder, Utf8Decoder, DateTimeFormat, MiniUrl, hostFetch };
