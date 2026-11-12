import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 3000, strictPort: true, allowedHosts: ['.manus.computer', 'localhost', '127.0.0.1'] },
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1500 },
  // Le frontend appelle seulement le connecteur loopback explicitement choisi, jamais un proxy Vite.
  worker: { format: 'es' },
});
