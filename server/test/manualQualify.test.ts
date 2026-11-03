import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDOFF_STATUSES, MANUAL_QUALIFY_STATUSES, type ManualQualifyResponse, type NewLeadCard, type RunSnapshot } from '../../shared/leadSearch.js';
import { mockApp, startBody, waitForEnd } from './helpers.js';

async function finishedRun(app: ReturnType<typeof mockApp>): Promise<RunSnapshot> {
  const response = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  assert.equal(response.statusCode, 202, response.body);
  return waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id);
}

const qualify = (app: ReturnType<typeof mockApp>, runId: string, leadId: string) =>
  app.inject({ method: 'POST', url: `/api/lead-search/runs/${runId}/leads/${encodeURIComponent(leadId)}/qualify` });

test('Von Hand qualifizieren: abgelehnter Lead geht bei der Übergabe mit', async () => {
  const app = mockApp();
  const run = await finishedRun(app);
  const rejected = run.leads.find((lead) => lead.status === 'rejected')!;
  const before = run.leads.filter((lead) => HANDOFF_STATUSES.includes(lead.status)).length;

  const response = await qualify(app, run.id, rejected.id);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as ManualQualifyResponse;
  assert.equal(body.lead.status, 'qualified');
  assert.equal(body.lead.manual, true);
  assert.equal(body.lead.note, 'Von Hand qualifiziert');
  assert.match(body.card.reason, /^Von Hand qualifiziert – KI: /);
  assert.equal(body.card.providerId, rejected.id);

  const handoff = (await app.inject({ method: 'POST', url: `/api/lead-search/runs/${run.id}/handoff` })).json() as { leads: NewLeadCard[] };
  assert.equal(handoff.leads.length, before + 1);
  assert.ok(handoff.leads.some((card) => card.providerId === rejected.id));
  await app.close();
});

test('Von Hand qualifizieren: auch ohne Profilabruf (Vorprüfung, zurückgestellt) – Karte nur mit Suchdaten', async () => {
  const app = mockApp();
  const run = await finishedRun(app);
  for (const status of ['screened_out', 'deferred'] as const) {
    const lead = run.leads.find((entry) => entry.status === status && !entry.profile)!;
    assert.ok(lead, status);
    const response = await qualify(app, run.id, lead.id);
    assert.equal(response.statusCode, 200, response.body);
    const { card } = response.json() as ManualQualifyResponse;
    assert.equal(card.headline, lead.hit.headline);
    assert.equal(card.company, '');
    assert.equal(card.category, 'sonstiges');
  }
  await app.close();
});

test('Von Hand qualifizieren: Dubletten, Vernetzte und Qualifizierte nicht; unbekannt → 404', async () => {
  const app = mockApp();
  const run = await finishedRun(app);
  for (const lead of run.leads.filter((entry) => !MANUAL_QUALIFY_STATUSES.includes(entry.status))) {
    assert.equal((await qualify(app, run.id, lead.id)).statusCode, 400, lead.status);
  }
  assert.equal((await qualify(app, run.id, 'gibt-es-nicht')).statusCode, 404);
  assert.equal((await qualify(app, '00000000-0000-4000-8000-000000000000', 'x')).statusCode, 404);
  await app.close();
});

test('Lauf meldet seine KI-Kosten (Simulation: Beispielwerte)', async () => {
  const app = mockApp();
  const run = await finishedRun(app);
  assert.ok((run.costEur ?? 0) > 0, String(run.costEur));
  await app.close();
});
