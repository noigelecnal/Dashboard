import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the BioPod API (python server.py, port 8080) is proxied under /api,
// so the dashboard talks to it the same way it does in the built app.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
})
