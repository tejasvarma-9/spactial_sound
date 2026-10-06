import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';

export default defineConfig({
  resolve: {
    // Point local workspace packages directly to their TypeScript source so
    // engine/common changes are picked up instantly without rebuilding or
    // clearing Vite's pre-bundle cache.
    alias: {
      '@spatial-soundscape/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
      '@spatial-soundscape/common': fileURLToPath(new URL('../common/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    // Only pre-bundle third-party deps — local packages are now aliased to source.
    exclude: ['@spatial-soundscape/engine', '@spatial-soundscape/common'],
    include: ['yjs', 'y-protocols/sync.js', 'y-protocols/awareness.js'],
  },
});
