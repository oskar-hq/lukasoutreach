import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewLeadCard, RunSnapshot } from '../../shared/leadSearch.js';
import { companyDomainKey, companyKeys, companyNameKey } from '../src/leads/companyKey.js';
import { mockApp, startBody, waitForEnd } from './helpers.js';

/** Firmen-Dubletten (Wunsch des Nutzers 27.10.): je Firma ein Lead – auch wenn die Person eine andere ist. */

test('Firmenschlüssel: ohne Rechtsform, Satzzeichen und Groß-/Kleinschreibung; Selbstständige zählen nicht', () => {
  assert.equal(companyNameKey('Vossberg Anlageimmobilien GmbH'), 'vossberg anlageimmobilien');
  assert.equal(companyNameKey('VOSSBERG Anlageimmobilien GmbH & Co. KG'), 'vossberg anlageimmobilien');
  assert.equal(companyNameKey('Müller & Söhne Finanz AG'), 'muller und sohne finanz');
  assert.equal(companyNameKey('Selbstständig'), null);
  assert.equal(companyNameKey('AG'), null);
  assert.equal(companyDomainKey('https://www.vossberg-anlageimmobilien.de/team'), 'vossberg-anlageimmobilien.de');
  assert.equal(companyDomainKey('linkedin.com/company/x'), null);
  assert.deepEqual(companyKeys({ name: 'X GmbH', website: null }), [], 'zu kurz');
});

const card = (overrides: Partial<NewLeadCard>): NewLeadCard => ({
  runId: 'run-company',
  mode: 'live',
  providerId: 'ACoOTHER1',
  publicIdentifier: 'andere-person',
  profileUrl: 'https://www.linkedin.com/in/andere-person',
  firstName: 'Andrea',
  lastName: 'Anders',
  headline: 'Vertriebsleiterin',
  position: 'Vertriebsleiterin',
  company: 'Vossberg Anlageimmobilien GmbH',
  location: 'Hamburg',
  website: null,
  networkDistance: 2,
  category: 'kapitalanlage_vertrieb',
  confidence: 0.9,
  reason: 'passt',
  summary: 'passt',
  metaAds: null,
  ...overrides,
});

test('Lauf: Kontakt einer Firma, die schon im Cockpit steht (auch verloren), fliegt als Dublette raus', async () => {
  const app = mockApp();
  const created = await app.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card({})], owner: 'johannes' } });
  assert.equal(created.statusCode, 200, created.body);
  const lead = created.json().created[0] as { id: string };
  // Abgelehnt: der Lead steht als „Verloren“ im Cockpit – die Firma bleibt gesperrt.
  const lost = await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'lost', reason: 'Kein Interesse' } });
  assert.ok(lost.statusCode < 300, lost.body);

  const response = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  const run = await waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id);
  const henrik = run.leads.find((entry) => entry.hit.lastName === 'Vossberg')!;
  assert.equal(henrik.status, 'duplicate');
  assert.match(henrik.note ?? '', /^Gleiche Firma schon im Cockpit · Andrea Anders · Johannes/);
  await app.close();
});
