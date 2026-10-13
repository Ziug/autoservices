import react from '@vitejs/plugin-react';
import {VitePWA} from 'vite-plugin-pwa';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      scope: '/',
      injectRegister: null,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,webp,png,jpg,jpeg,avif,json,woff2}'],
        globIgnores: ['**/owner/**', '**/tenants/*/manifest.webmanifest', '**/tenants/*/business.json'],
      },
      devOptions: {enabled: false},
    }),
  ],
  resolve: {alias: {'@': new URL('./src', import.meta.url).pathname}},
  build: {target: 'es2022', sourcemap: true},
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
