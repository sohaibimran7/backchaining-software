import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiPort = process.env.PORT ?? '8787';

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(root, '../shared') },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
  build: {
    outDir: path.resolve(root, '../dist/web'),
    emptyOutDir: true,
  },
});
