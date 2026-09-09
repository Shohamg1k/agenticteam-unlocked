import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = Number(process.env.AGENTIC_PORT ?? 4400);

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the packaged app can load the build from file://
  // as well as from the core service.
  base: './',
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${SERVER_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 4_000,
    rollupOptions: {
      output: {
        // Monaco is most of the bundle. Splitting it keeps a change to the app
        // from invalidating 3MB of editor on every deploy.
        manualChunks: {
          monaco: ['monaco-editor'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  // Monaco's language workers are large; letting Vite prebundle them makes the
  // first dev start much slower for no benefit.
  optimizeDeps: { exclude: ['monaco-editor'] },
});
