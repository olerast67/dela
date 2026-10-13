import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // scrypt и Argon2id в тестах сервера под нагрузкой не укладываются в 5 секунд по умолчанию.
    testTimeout: 30_000,
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
