import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the static build works from any container path (DeWEB / TapeKit).
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/v1': gateway,
      '/demo': gateway,
      '/internal': gateway,
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
