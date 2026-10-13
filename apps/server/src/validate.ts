import { HTTPException } from 'hono/http-exception';

export function bad(message: string): never {
  throw new HTTPException(400, { message });
}

export function obj(v: unknown, name = 'body'): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(`${name} must be an object`);
  return v as Record<string, unknown>;
}

export function str(v: unknown, name: string, opts: { min?: number; max?: number; re?: RegExp } = {}): string {
  const { min = 1, max = 200, re } = opts;
  if (typeof v !== 'string') bad(`${name} must be a string`);
  if (v.length < min || v.length > max) bad(`${name} length must be ${min}..${max}`);
  if (re && !re.test(v)) bad(`${name} has invalid format`);
  return v;
}

export function optStr(v: unknown, name: string, opts: { min?: number; max?: number; re?: RegExp } = {}): string | undefined {
  return v === undefined || v === null ? undefined : str(v, name, opts);
}

export function int(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) bad(`${name} must be an integer ${min}..${max}`);
  return n;
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Строгий base64 (стандартный алфавит, с выравниванием). */
export function b64(v: unknown, name: string, opts: { bytes?: number; maxBytes?: number } = {}): Buffer {
  const s = str(v, name, { max: Math.ceil(((opts.bytes ?? opts.maxBytes ?? 1 << 20) * 4) / 3) + 4 });
  if (!B64_RE.test(s)) bad(`${name} must be base64`);
  const buf = Buffer.from(s, 'base64');
  if (opts.bytes !== undefined && buf.length !== opts.bytes) bad(`${name} must be ${opts.bytes} bytes`);
  if (opts.maxBytes !== undefined && buf.length > opts.maxBytes) bad(`${name} is too large`);
  return buf;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
