/* SCRATCH REVIEW HARNESS CONFIG — delete with the zzreview/ directory. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    host: '127.0.0.1',
    fs: { strict: false, allow: [root, resolve(root, '../../../..'), 'C:/Users/Mr Dashi/Downloads/plaspool'] },
  },
});
