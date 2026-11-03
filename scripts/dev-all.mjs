// Startet Frontend (Vite) und Backend (Fastify) gemeinsam für die lokale Entwicklung.
// Andere Ports (z. B. zweiter Agent auf demselben Rechner): API_PORT=8788 WEB_PORT=5174 npm run dev:all
import { spawn } from 'node:child_process';

const apiPort = process.env.API_PORT ?? '8787';
const windows = process.platform === 'win32';
// Eigene Prozessgruppe je Kind, damit beim Beenden auch Vite und tsx (Enkelprozesse von npm) mit beendet werden
// und die Ports wieder frei sind. Ohne Terminal-Eingabe: Hintergrund-Prozessgruppen dürfen nicht vom Terminal lesen.
const options = (env) => ({
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: windows,
  detached: !windows,
  env: { ...process.env, ...env },
});
const processes = [
  // Simulation ohne Netz, Testkonten nick/johannes (Passwort „demo“) und Cookie ohne HTTPS – nur lokal.
  // LEAD_SEARCH_MODE aus der Umgebung geht vor (Standard des Backends ist der echte Betrieb).
  spawn(
    'npm',
    ['run', 'server:dev'],
    options({ LEAD_SEARCH_MODE: process.env.LEAD_SEARCH_MODE ?? 'mock', PORT: apiPort, AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false' }),
  ),
  spawn('npm', ['run', 'dev'], options({ API_TARGET: `http://localhost:${apiPort}` })),
];

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of processes) {
    try {
      if (windows) child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // schon beendet
    }
  }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of processes) child.on('exit', (code) => code && code !== 0 && stop());
