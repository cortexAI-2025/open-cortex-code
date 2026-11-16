import { defineConfig } from 'vite';

const suppressKnownBuildWarnings = process.env.SUPPRESS_KNOWN_BUILD_WARNINGS === '1';

export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 3000, strictPort: true, allowedHosts: ['.manus.computer', 'localhost', '127.0.0.1'] },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      onLog(level, log, defaultHandler) {
        const source = log.id ?? log.loc?.file ?? '';
        const isLucideUseClientWarning =
          level === 'warn' &&
          log.code === 'MODULE_LEVEL_DIRECTIVE' &&
          source.includes('lucide-react') &&
          /(?:Icon|context)\.mjs$/.test(source);

        if (suppressKnownBuildWarnings && isLucideUseClientWarning)
          return;
        defaultHandler(level, log);
      },
    },
  },
  // Le frontend appelle seulement le connecteur loopback explicitement choisi, jamais un proxy Vite.
  worker: { format: 'es' },
});
