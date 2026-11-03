import { MockAdapter } from './adapters/mock/mockAdapter.js';
import { buildApp } from './app.js';
import { liveProblems, loadConfig, type Config } from './config.js';
import type { LeadSearchAdapter } from './pipeline/adapter.js';
import { loadConfigWithSettings } from './settings/effective.js';
import { applyPendingRestore } from './system/backups.js';

// Wiederherstellen einer Sicherung (Vertrag shared/system.ts): die geprüfte Kopie einsetzen, bevor irgendetwas die
// Datenbank öffnet.
if (applyPendingRestore(loadConfig(process.env).dataDir)) console.log('Sicherung wiederhergestellt.');

// Einstellungen aus der Software (Datenordner) liegen über der .env; ohne sie gilt die .env wie bisher.
const config = loadConfigWithSettings(process.env);

async function createAdapter(current: Config): Promise<LeadSearchAdapter> {
  if (current.mode === 'mock') return new MockAdapter(current.mockSpeed);
  const { createLiveAdapter } = await import('./adapters/live/liveAdapter.js');
  return createLiveAdapter(current);
}

// Pflicht-Sitzung ist Standard (requireSession): ohne Anmeldung antworten alle /api-Routen außer AUTH_OPEN_ROUTES mit 401.
// Neustart nach dem Wiederherstellen: sauber beenden (Datenbank schließen), Docker (`restart: unless-stopped`) startet
// das Backend wieder. Hängt das Schließen, nach 10 s hart beenden.
const restartProcess = () => {
  app.log.warn('Neustart nach dem Wiederherstellen einer Sicherung');
  setTimeout(() => process.exit(0), 10_000).unref();
  void app.close().finally(() => process.exit(0));
};
const app = buildApp({ config, adapter: await createAdapter(config), createAdapter, env: process.env, scheduleBackups: true, restartProcess });

if (config.mode === 'live') {
  const problems = liveProblems(config);
  if (problems.length) app.log.warn({ problems }, 'Die Lead-Suche ist noch nicht vollständig eingerichtet');
}

await app.listen({ port: config.port, host: config.host });
app.log.info(`Lead-Suche im Modus "${config.mode}" bereit`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
