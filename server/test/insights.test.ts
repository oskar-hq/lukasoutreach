import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE, type PipelineLead, type RunSnapshot } from '../../shared/leadSearch.js';
import { openDatabase } from '../src/db/database.js';
import { InsightsStore, buildReport } from '../src/learning/insights.js';
import { DbAccountUsage } from '../src/linkedin/accountUsage.js';
import { tempDataDir } from './helpers.js';

/** Optimierungs-Bericht (09.11.): automatische Läufe mit Gründer und Fehler, Abrufe je Zweck. */

function lead(id: string, status: PipelineLead['status'], fetched: boolean): PipelineLead {
  return {
    id,
    hit: { providerId: id, publicIdentifier: null, firstName: 'Erika', lastName: 'Geheim', headline: `Geschäftsführer · Firma ${id}`, location: null, networkDistance: 2, profileUrl: null },
    status,
    note: null,
    profile: fetched
      ? { headline: `Geschäftsführer · Firma ${id}`, position: 'Geschäftsführer', companyName: `Firma ${id}`, companyDescription: null, companyWebsite: null, companyIndustry: 'Finanzdienstleistungen' } as PipelineLead['profile']
      : null,
    qualification: status === 'rejected' ? { qualified: false, category: 'makler', confidence: 0.8, reason: 'Makler', summary: 'Makler' } : null,
    metaAds: null,
    prescreen: { fit: 'likely', reason: 'passt' },
  };
}

test('Bericht: automatischer Lauf ohne Ertrag mit Gründer, Suchbegriffen und Fehler – Abrufe je Zweck', () => {
  const db = openDatabase(tempDataDir());
  const now = Date.parse('2026-11-09T16:00:00Z');
  const usage = new DbAccountUsage(db, () => 'Europe/Berlin');
  usage.add('ACC1', 'profile', 3, now, 'lead_profile');
  usage.add('ACC1', 'profile', 2, now, 'lead_company');
  usage.add('ACC2', 'profile', 7, now, 'contact_profile');
  usage.add('ACC2', 'profile', 4, now, 'warmup');
  usage.add('ACC1', 'search', 50, now);
  assert.equal(usage.used('ACC1', 'profile', now), 5, 'Limit zählt weiter alles');

  const run: RunSnapshot = {
    id: 'run-auto-1',
    mode: 'live',
    profile: { ...DEFAULT_SEARCH_PROFILE, keywords: ['Finanzdienstleister'], maxResults: 25 },
    status: 'failed',
    phase: 'enrich',
    leads: [lead('A', 'rejected', true), lead('B', 'rejected', true), lead('C', 'deferred', false)],
    error: { code: 'rate_limit', title: 'Tageslimit aller LinkedIn-Accounts erreicht', message: 'Morgen geht es weiter.' },
    startedAt: now - 60_000,
    finishedAt: now,
    handedOff: false,
  };
  new InsightsStore(db, { now: () => now }).recordRun(run, new Map(), { auto: true, founder: 'nick' });

  const text = buildReport(db, {
    now,
    days: 7,
    timeZone: 'Europe/Berlin',
    usdToEur: 0.86,
    mode: 'live',
    settings: [],
    accountName: (id) => `Account ${id}`,
    efficiency: { days: 7, profileFetches: 16, qualified: 0, perQualified: null },
  });
  assert.match(text, /\| 2026-11-09 16:59 \| automatisch \| nick \| failed \(rate_limit\) \| 3 \| 0 \| 2 \| 0 \| 2 \| 1 \| 0 \| 0\/0 \|/);
  assert.match(text, /\| Finanzdienstleister \| Tageslimit aller LinkedIn-Accounts erreicht: Morgen geht es weiter\. \|/);
  assert.match(text, /## Automatische Suche je Tag und Gründer[\s\S]*\| 2026-11-09 \| nick \| 1 \| 1 \| 3 \| 2 \| 0 \| 0 \| rate_limit \|/);
  assert.match(text, /## Wohin die LinkedIn-Abrufe gingen[\s\S]*\| 2026-11-09 \| 3 \| 2 \| 7 \| 0 \| 4 \| 50 \|/);
  assert.match(text, /\| Account ACC2 \| 0 \| 0 \| 7 \| 0 \| 4 \| 0 \|/);
  assert.ok(!text.includes('Geheim'), 'keine Namen');
});
