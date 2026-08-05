import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // shared-types builds to CommonJS for the API, and rollup cannot see named
      // exports through the `Object.defineProperty(exports, ...)` that tsc emits —
      // the build fails with "X is not exported by dist/index.js". Point the browser
      // build at the source instead, the same way api-client is consumed.
      '@model-trainer/shared-types': fileURLToPath(
        new URL('../../packages/shared-types/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
