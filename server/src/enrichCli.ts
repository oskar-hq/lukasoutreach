import type { FastifyBaseLogger } from 'fastify';
import { loadConfigWithSettings } from './settings/effective.js';
import { openDatabase } from './db/database.js';
import { EnrichmentService } from './enrichment/service.js';
import { LeadStore } from './leads/leadStore.js';

/**
 * Firmendaten über Treg prüfen (ein Abruf, ca. 0,2 Cent):
 *   docker compose exec backend node dist/server/src/enrichCli.js test muster-wohnbau.de
 * Lokal: npm run enrich --prefix server -- test muster-wohnbau.de
 * Zeigt, was im Cockpit ankäme. Speichert nichts und zählt nicht zum Tageslimit.
 */

const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as FastifyBaseLogger;

async function main() {
  const [command, domain] = process.argv.slice(2);
  if (command !== 'test' || !domain) {
    console.log('Firmendaten prüfen\n\n  test <domain>   ein Abruf über Treg (z. B. test muster-wohnbau.de)\n');
    process.exit(command ? 1 : 0);
  }
  const config = loadConfigWithSettings();
  if (config.enrichmentProvider !== 'treg' || !config.treg.token) {
    console.error('Fehler: TREG_TOKEN fehlt in der .env (und ENRICHMENT_PROVIDER muss treg sein).');
    process.exit(1);
  }
  const db = openDatabase(config.dataDir);
  const service = new EnrichmentService({ config, db, leads: new LeadStore(db), log });
  const result = await service.probe(domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
  db.close();
  if ('error' in result) {
    console.error(`Fehler: ${result.error}`);
    process.exit(1);
  }
  const { values } = result;
  console.log(`Gefunden über: ${result.servedBy ?? 'unbekannt'}${result.chargedUsd !== null ? ` · Kosten: ${(result.chargedUsd * 100).toFixed(2).replace('.', ',')} Cent` : ''}`);
  const socials = Object.entries(values.socials).filter(([, url]) => url).map(([key, url]) => `${key}: ${url}`);
  console.log(`Mitarbeiter: ${values.employeesRange ?? values.employees ?? '–'}`);
  console.log(`Umsatz: ${values.revenue ?? '–'}`);
  console.log(`Tech-Stack: ${values.techStack.join(', ') || '–'}`);
  console.log(`Meta-Pixel: ${values.metaPixel === null ? 'unbekannt' : values.metaPixel ? 'ja' : 'nein'} · Google Tag Manager: ${values.googleTagManager === null ? 'unbekannt' : values.googleTagManager ? 'ja' : 'nein'}`);
  console.log(`Social-Profile: ${socials.length ? `\n  ${socials.join('\n  ')}` : '–'}`);
}

main().catch((error: unknown) => {
  console.error(`Fehler: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
