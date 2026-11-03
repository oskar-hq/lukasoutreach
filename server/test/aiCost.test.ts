import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardResponse } from '../../shared/dashboard.js';
import type { RunSnapshot } from '../../shared/leadSearch.js';
import { costUsd, priceOf } from '../src/ai/usage.js';
import { openDatabase } from '../src/db/database.js';
import { mockApp, startBody, tempDataDir, waitForEnd } from './helpers.js';

test('Kosten je Aufruf: Listenpreise je Modell, Cache-Lesen/-Schreiben, unbekanntes Modell teuer geschätzt', () => {
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: 1_000_000 }), 4);
  assert.equal(costUsd('claude-opus-5-5', { output_tokens: 1_000_000 }), 20);
  assert.equal(costUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 12);
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 1_000_000 }), 0.1);
  assert.equal(costUsd('claude-haiku-4-5', { input_tokens: 1_000_000 }), 1);
  assert.equal(costUsd('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 }), 0.2);
  assert.equal(costUsd('claude-opus-5-5', { cache_creation_input_tokens: 1_000_000 }), 5);
  assert.equal(priceOf('claude-opus-4-8').input, 5);
  assert.equal(priceOf('irgendwas').input, 10);
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: null, output_tokens: undefined }), 0);
});

test('Dashboard: KI-Kosten (Simulation mit Beispielwerten), jeder Lauf zählt dazu, Reset setzt zurück', async () => {
  const app = mockApp(undefined, { AI_USD_EUR_RATE: '0.9' });
  const load = async () => ((await app.inject({ method: 'GET', url: '/api/dashboard' })).json() as DashboardResponse).aiCost!;
  const before = await load();
  // Beispielwerte: 21 Tage × 21 Aufrufe.
  assert.equal(before.calls, 21 * 21);
  assert.equal(before.usdToEur, 0.9);
  assert.ok(before.totalEur > 5 && before.totalEur < 20, String(before.totalEur));
  assert.ok(before.monthEur > 0 && before.periodEur > 0);
  assert.deepEqual(Object.keys(before.byPurpose).sort(), ['assistant', 'conversation', 'prescreen', 'qualify', 'suggest']);
  const sum = Object.values(before.byPurpose).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - before.totalEur) < 0.05);

  const started = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  const run = await waitForEnd(app, (started.json() as { run: RunSnapshot }).run.id);
  assert.equal(run.status, 'done');
  const after = await load();
  assert.ok(after.calls > before.calls, 'Vorprüfung und Einstufungen gezählt');
  assert.ok(after.byPurpose.qualify > before.byPurpose.qualify);

  await app.inject({ method: 'POST', url: '/api/leads/demo/reset' });
  assert.equal((await load()).calls, 21 * 21);
  await app.close();
});

test('Durchschnitt je qualifiziertem und je abgeschlossenem Lead – live bei jedem Abruf', async () => {
  const dataDir = tempDataDir();
  const app = mockApp(undefined, { DATA_DIR: dataDir });
  const load = async () => ((await app.inject({ method: 'GET', url: '/api/dashboard' })).json() as DashboardResponse).aiCost!;
  const before = await load();
  // Simulation: alle Demo-Leads zählen als qualifiziert, noch keiner übergeben.
  assert.ok(before.leads > 0);
  assert.equal(before.closedLeads, 0);
  assert.equal(before.perClosedEur, null);
  assert.ok(Math.abs(before.perQualifiedEur! - before.totalEur / before.leads) <= 0.01, String(before.perQualifiedEur));

  // Zwei Leads übergeben → Kosten je Abschluss = alle Kosten ÷ 2.
  const db = openDatabase(dataDir);
  db.exec("UPDATE leads SET stage = 'handed_over' WHERE id IN (SELECT id FROM leads ORDER BY id LIMIT 2)");
  db.close();
  const after = await load();
  assert.equal(after.closedLeads, 2);
  assert.ok(Math.abs(after.perClosedEur! - after.totalEur / 2) <= 0.01, String(after.perClosedEur));
  await app.close();
});

test('AI_USD_EUR_RATE muss sinnvoll sein', () => {
  assert.throws(() => mockApp(undefined, { AI_USD_EUR_RATE: '0' }), /AI_USD_EUR_RATE/);
});
