import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: 'previously-public-entry',
    transformIndexHtml: {
      order: 'pre',
      handler(html) { return mode === 'public' ? html.replace('/src/app/main.tsx', '/src/app/public-main.tsx') : html; },
    },
  }],
  build: {
    outDir: mode === 'public' ? 'dist-public' : 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  server: { port: 4318, strictPort: true },
}));
