/** Вопросы в терминале: обычный ввод и скрытый (пароль не отображается и не попадает в историю). */
import { createInterface, type Interface } from 'node:readline';

// Без терминала (ответы из канала) одна читалка на все вопросы: иначе первая заберёт строки следующих.
let piped: { rl: Interface; lines: string[]; waiters: Array<(line: string | null) => void>; closed: boolean } | null = null;

function pipedLine(): Promise<string | null> {
  if (!piped) {
    const state = { rl: createInterface({ input: process.stdin, terminal: false }), lines: [] as string[], waiters: [] as Array<(l: string | null) => void>, closed: false };
    state.rl.on('line', (line) => {
      const w = state.waiters.shift();
      if (w) w(line);
      else state.lines.push(line);
    });
    state.rl.on('close', () => {
      state.closed = true;
      for (const w of state.waiters.splice(0)) w(null);
    });
    piped = state;
  }
  const p = piped;
  if (p.lines.length) return Promise.resolve(p.lines.shift()!);
  if (p.closed) return Promise.resolve(null);
  return new Promise((resolve) => p.waiters.push(resolve));
}

export async function ask(question: string): Promise<string> {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    const line = await pipedLine();
    if (line === null) throw new Error('No input.');
    return line.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((resolve) => rl.question('', (a) => resolve(a.trim())));
  } finally {
    rl.close();
  }
}

/** Скрытый ввод: символы не выводятся. Без терминала читается строка как есть. */
export function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export function closePrompts(): void {
  piped?.rl.close();
}
