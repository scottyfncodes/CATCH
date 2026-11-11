import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 5173 },
  preview: { port: 4173 },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
  },
});
