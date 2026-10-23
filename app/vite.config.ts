import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Local AI backend (app/server/ai-server.ts). Same-origin for the
      // browser; the Unlayer key never leaves the backend process.
      '/api': { target: 'http://127.0.0.1:5198', changeOrigin: false },
    },
  },
})
