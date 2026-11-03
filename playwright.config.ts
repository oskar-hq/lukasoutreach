import { defineConfig, devices } from '@playwright/test';

// Eigene Ports, damit ein laufender Dev-Server (5173 / 8787) nicht stört.
// Laufen zwei Agents auf demselben Rechner, bekommt einer andere Ports: E2E_API_PORT=8792 E2E_WEB_PORT=4176
const API_PORT = Number(process.env.E2E_API_PORT ?? 8790);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4174);

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      // Backend im Mock-Modus, Verzögerungen auf 15 % verkürzt
      command: 'npx tsx src/index.ts',
      cwd: './server',
      url: `http://localhost:${API_PORT}/api/health`,
      // Eigener Datenordner, damit eine lokal hochgeladene Tracking-Liste die Tests nicht beeinflusst.
      // Testkonten für den Login (shared/auth.ts), Cookie ohne Secure, weil die Tests über http laufen.
      env: {
        LEAD_SEARCH_MODE: 'mock',
        MOCK_SPEED: '0.15',
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        DATA_DIR: '../test-results/e2e-data',
        AUTH_DEMO_ACCOUNTS: 'true',
        AUTH_COOKIE_SECURE: 'false',
        // LinkedIn-Simulation zählt über alle Tests (und Läufe am selben Tag) mit – Limits hier nicht im Weg.
        LINKEDIN_INVITES_PER_DAY: '10000',
        LINKEDIN_INVITES_PER_WEEK: '10000',
        LINKEDIN_MESSAGES_PER_DAY: '10000',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npm run build && npx vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
