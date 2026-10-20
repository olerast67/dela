/**
 * Сборка ядра для часов: один файл IIFE для QuickJS. libsodium заменён мостом к libsodium приложения
 * (sodium.ts), node:os — заглушкой. Gradle собирает его перед сборкой APK (задача bundleCore)
 * и кладёт в assets из app/build/generated/dela-js.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  logLevel: 'warn',
  resolve: {
    alias: {
      'libsodium-wrappers-sumo': here('./sodium.ts'),
      'node:os': here('./os.ts'),
    },
  },
  build: {
    outDir: process.env.DELA_WEAR_JS_OUT ?? here('../app/build/generated/dela-js'),
    emptyOutDir: true,
    // QuickJS понимает ES2023, но синтаксис попроще ему быстрее разбирать.
    target: 'es2020',
    minify: true,
    sourcemap: false,
    lib: {
      entry: here('./main.ts'),
      formats: ['iife'],
      name: 'DelaWearBundle',
      fileName: () => 'dela-wear.js',
    },
  },
});
