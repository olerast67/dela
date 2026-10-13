import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const api = process.env.DELA_DEV_API ?? 'http://localhost:8787';

export default defineConfig({
  root: import.meta.dirname,
  // DELA_BASE: подпапка сайта (демо на GitHub Pages собирается с /dela/demo/).
  base: process.env.DELA_BASE ?? '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Dela',
        short_name: 'Dela',
        description: 'Encrypted task manager that works offline',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#F6F3EC',
        theme_color: '#2E7D5B',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // Код открыт, но карты исходников раздували бы APK и установщик.
    sourcemap: false,
  },
});
