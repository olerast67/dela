/**
 * Сборка пакета для npm: один файл dist/cli.js с ядром внутри. Node не снимает типы с .ts
 * внутри node_modules, поэтому исходники ядра в пакет не кладутся. Зависимости из package.json
 * остаются внешними и ставятся npm.
 */
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  logLevel: 'warn',
  build: {
    ssr: 'src/cli.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [/^@modelcontextprotocol\/sdk/, 'zod', 'libsodium-wrappers-sumo', /^node:/],
      output: { format: 'es', entryFileNames: 'cli.js' },
    },
  },
  plugins: [
    {
      name: 'dela-license',
      // Лицензия AGPL едет в пакете рядом со сборкой.
      closeBundle() {
        copyFileSync(new URL('../../LICENSE', import.meta.url), new URL('./LICENSE', import.meta.url));
      },
    },
  ],
});
