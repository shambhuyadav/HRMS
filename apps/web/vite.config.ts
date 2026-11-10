import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Development server proxies API calls to the local API (apps/api/src/server.ts on port 3000).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:3000',
      '/dev': 'http://127.0.0.1:3000',
      '/sign-in': 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'jsdom',
    // jsdom file reads and debounced searches slow down when every page suite runs in parallel; a genuine hang still fails.
    testTimeout: 20000,
  },
} as never);
