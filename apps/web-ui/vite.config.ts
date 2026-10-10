import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `just dev web-ui` serves the app on :5173 and proxies the API to a
// document-service on :8000 (`just up` or `just dev document-service`), so the
// browser sees one origin and needs no CORS.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/documents': apiTarget,
    },
  },
});
