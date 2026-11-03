import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Das Backend (server/) läuft lokal auf Port 8787 – /api wird dorthin weitergeleitet (auch Server-Sent Events).
const apiProxy = {
  '/api': { target: process.env.API_TARGET ?? 'http://localhost:8787', changeOrigin: true },
  // MCP-Server für die Claude-App und seine OAuth-Metadaten (shared/mcp.ts)
  '/mcp': { target: process.env.API_TARGET ?? 'http://localhost:8787', changeOrigin: true },
  '/.well-known/oauth-': { target: process.env.API_TARGET ?? 'http://localhost:8787', changeOrigin: true },
};

// Sicherheits-Header wie in nginx.conf – die E2E-Tests laufen gegen `vite preview` und prüfen so die CSP mit.
// Ändern: immer an beiden Stellen. Nicht im Dev-Server (Vite spielt dort Skripte inline ein).
const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // WEB_PORT: anderer Port, wenn zwei Agents auf demselben Rechner arbeiten
  server: { host: true, port: Number(process.env.WEB_PORT ?? 5173), proxy: apiProxy },
  preview: { host: true, port: 4173, proxy: apiProxy, headers: securityHeaders },
  build: {
    chunkSizeWarningLimit: 1200,
  },
});
