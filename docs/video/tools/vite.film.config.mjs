// Vite for frame capture: same project, no HMR, so edits elsewhere never reload a page mid-render.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../..', import.meta.url));
export default defineConfig({
  root, configFile: false, plugins: [react()],
  cacheDir: fileURLToPath(new URL('../../../../review/video/.vite-film', import.meta.url)),
  server: { host: '127.0.0.1', port: 4330, strictPort: true, hmr: false },
});
