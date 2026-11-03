import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { LeadStore } from './leadStore.js';

/**
 * Datenschutz: Leads in „Verloren“ nach `LOST_DELETE_DAYS` Tagen löschen (Vertrag `shared/leads.ts`). Läuft beim Start
 * und danach alle 6 Stunden – nur im echten Betrieb (`scheduleBackups`), nicht in Tests.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;

export function purgeLostLeads(config: Config, leads: LeadStore, log: FastifyBaseLogger, now = Date.now()): number {
  const days = config.retention.lostDeleteDays;
  if (days === null) return 0;
  const count = leads.purgeLost(now - days * DAY_MS, now);
  if (count) log.info({ count, days }, 'Verlorene Leads gelöscht (Datenschutz)');
  return count;
}

export function scheduleRetention(config: Config, leads: LeadStore, log: FastifyBaseLogger): () => void {
  const run = () => {
    try {
      purgeLostLeads(config, leads, log);
    } catch (error) {
      log.error({ err: error }, 'Löschen verlorener Leads fehlgeschlagen');
    }
  };
  run();
  const timer = setInterval(run, EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
