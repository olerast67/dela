import { describe, expect, it } from 'vitest';
import { isUuidv7, uuidv7 } from '../src/index.ts';

describe('uuidv7', () => {
  it('формат, версия и вариант', () => {
    for (let i = 0; i < 1000; i++) expect(isUuidv7(uuidv7())).toBe(true);
  });

  it('содержит время и сортируется по нему', () => {
    const a = uuidv7(1_760_000_000_000);
    const b = uuidv7(1_760_000_000_001);
    expect(a.slice(0, 13).replace('-', '')).toBe((1_760_000_000_000).toString(16).padStart(12, '0'));
    expect(a < b).toBe(true);
  });

  it('не повторяется', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(1)));
    expect(ids.size).toBe(10_000);
  });
});
