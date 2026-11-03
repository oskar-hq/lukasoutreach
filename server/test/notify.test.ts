import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewLeadCard, RunSnapshot } from '../../shared/leadSearch.js';
import type { CreateLeadsResponse } from '../../shared/leads.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { MOCK_LEADS } from '../src/adapters/mock/mockData.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { LeadStore } from '../src/leads/leadStore.js';
import { definitionOf, validateValue } from '../src/settings/validate.js';
import { startBody, tempDataDir, waitForEnd } from './helpers.js';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/geheim123';
const LIVE: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key' };
const DAY = 24 * 60 * 60 * 1000;

const card = (overrides: Partial<NewLeadCard> = {}): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: 'ACoNOTIFY1',
  publicIdentifier: 'erika-muster',
  profileUrl: 'https://www.linkedin.com/in/erika-muster',
  firstName: 'Erika',
  lastName: 'Muster',
  headline: 'Geschäftsführerin',
  position: 'Geschäftsführerin',
  company: 'Muster & Söhne <GmbH>',
  location: 'Köln',
  website: 'https://www.muster.de',
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.88,
  reason: 'Entwickelt selbst.',
  summary: 'Bauträger.',
  metaAds: { state: 'none', advertiser: null, ads: 0, activeAds: 0, lastStop: null, foreignAds: 0, libraryUrl: null, note: null },
  ...overrides,
});

function slackApp(env: NodeJS.ProcessEnv) {
  const calls: Array<{ url: string; body: { text: string } }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const config = loadConfig({ DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', ...env });
  const app = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false, slackTest: { fetch: fakeFetch } });
  return { app, calls };
}

const post = (app: ReturnType<typeof buildApp>, url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload });

test('Slack: live bei neuer Antwort genau eine Nachricht, Text entschärft, Adresse nie im Text', async () => {
  const { app, calls } = slackApp({ ...LIVE, SLACK_WEBHOOK_URL: WEBHOOK, PUBLIC_URL: 'https://crm.example.de' });
  const lead = ((await post(app, '/api/leads', { cards: [card()], owner: 'nick' })).json() as CreateLeadsResponse).created[0];
  await post(app, `/api/leads/${lead.id}/events`, { action: 'invite_accepted' });
  await post(app, `/api/leads/${lead.id}/events`, { action: 'message_sent', text: 'Hallo' });
  assert.equal(calls.length, 0, 'nur Antworten lösen Slack aus');
  await post(app, `/api/leads/${lead.id}/events`, { action: 'message_received', text: 'Gern <b>Termin</b>?' });
  await app.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WEBHOOK);
  const text = calls[0].body.text;
  assert.match(text, /Neue Antwort an Nick:\* Erika Muster \(Muster &amp; Söhne &lt;GmbH&gt;\)/);
  assert.match(text, /> Gern &lt;b&gt;Termin&lt;\/b&gt;\?/);
  assert.match(text, /Einschätzung: Interessiert/);
  assert.match(text, /<https:\/\/crm\.example\.de\|Im Cockpit öffnen>/);
  assert.ok(!text.includes('geheim123'));
});

test('Slack: nichts in der Simulation, ohne Webhook und beim Demo-Reset', async () => {
  const mock = slackApp({ LEAD_SEARCH_MODE: 'mock', SLACK_WEBHOOK_URL: WEBHOOK });
  await mock.app.ready();
  await post(mock.app, '/api/leads/demo/reset');
  const lead = ((await post(mock.app, '/api/leads', { cards: [card({ mode: 'mock' })], owner: 'nick' })).json() as CreateLeadsResponse).created[0];
  await post(mock.app, `/api/leads/${lead.id}/events`, { action: 'invite_accepted' });
  await post(mock.app, `/api/leads/${lead.id}/events`, { action: 'message_received', text: 'Hallo' });
  await mock.app.close();
  assert.equal(mock.calls.length, 0);

  const off = slackApp(LIVE);
  const offLead = ((await post(off.app, '/api/leads', { cards: [card()], owner: 'nick' })).json() as CreateLeadsResponse).created[0];
  await post(off.app, `/api/leads/${offLead.id}/events`, { action: 'invite_accepted' });
  await post(off.app, `/api/leads/${offLead.id}/events`, { action: 'message_received', text: 'Hallo' });
  await off.app.close();
  assert.equal(off.calls.length, 0);
});

test('Slack-Adresse: nur https://hooks.slack.com/… (Einstellungen und .env)', () => {
  assert.equal(validateValue(definitionOf('SLACK_WEBHOOK_URL')!, WEBHOOK).ok, true);
  assert.equal(validateValue(definitionOf('SLACK_WEBHOOK_URL')!, 'https://evil.example/hooks.slack.com/x').ok, false);
  assert.throws(() => loadConfig({ SLACK_WEBHOOK_URL: 'http://hooks.slack.com/x' }), /hooks\.slack\.com/);
  assert.throws(() => loadConfig({ LOST_DELETE_DAYS: '0' }), /LOST_DELETE_DAYS/);
  assert.equal(loadConfig({ LOST_DELETE_DAYS: 'off' }).retention.lostDeleteDays, null);
  assert.equal(loadConfig({}).retention.lostDeleteDays, 30);
});

test('Löschen: echte verlorene Leads nach der Frist weg (mit Verlauf), Demo-Leads bleiben, nie wieder vorgeschlagen', async () => {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  const store = new LeadStore(db);
  store.resetDemo();
  const demoLost = store.list({ stages: ['lost'] }).leads.length;
  // Ein Treffer der simulierten Suche, der nicht schon als Demo-Lead im Cockpit steht.
  const target = MOCK_LEADS.find((lead) => !store.findByProviderId(lead.hit.providerId))!.hit;
  const now = Date.now();
  const [old, fresh] = store.createFromCards(
    [card({ providerId: target.providerId, publicIdentifier: target.publicIdentifier ?? null }), card({ providerId: 'ACoFRESH01', publicIdentifier: 'frisch' })],
    'nick',
    now - 40 * DAY,
  ).created;
  store.applyAction(old.id, { action: 'lost', text: 'Kein Interesse' }, 'nick', now - 31 * DAY);
  store.applyAction(fresh.id, { action: 'lost' }, 'nick', now - 5 * DAY);

  assert.equal(store.purgeLost(now - 30 * DAY, now), 1);
  assert.equal(store.get(old.id), null);
  assert.deepEqual(store.events(old.id), []);
  assert.ok(store.get(fresh.id), 'noch in der Frist');
  assert.equal(store.list({ stages: ['lost'] }).leads.length, demoLost + 1, 'Demo-Leads bleiben');
  assert.equal(store.wasDeleted({ providerId: target.providerId }), true);
  assert.equal(store.wasDeleted({ providerId: 'anders', publicIdentifier: target.publicIdentifier?.toUpperCase() }), Boolean(target.publicIdentifier));
  assert.equal(store.wasDeleted({ providerId: 'ACoFRESH01' }), false);
  // Keine Klartext-Daten im Fingerabdruck.
  const rows = db.prepare('SELECT fingerprint FROM deleted_leads').all() as Array<{ fingerprint: string }>;
  assert.ok(rows.every((row) => !row.fingerprint.includes(target.providerId)));
  db.close();

  // Die Lead-Suche meldet den gelöschten Lead als Dublette.
  const app = buildApp({ config: loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: dataDir }), adapter: new MockAdapter(0), logger: false, requireSession: false });
  const started = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody({ known: [] }) });
  const run = await waitForEnd(app, (started.json() as { run: RunSnapshot }).run.id);
  const hit = run.leads.find((lead) => lead.id === target.providerId);
  assert.equal(hit?.status, 'duplicate');
  assert.equal(hit?.note, 'Früher kein Interesse – Lead wurde gelöscht');
  await app.close();
});

test('Löschen: wieder geöffnete Leads bleiben; erneut verloren zählt die Frist ab dem letzten „Verloren“', () => {
  const store = new LeadStore(openDatabase(tempDataDir()));
  const now = Date.now();
  const [reopened, lostAgain] = store.createFromCards(
    [card({ providerId: 'ACoREOPEN01', publicIdentifier: 'reopen-1' }), card({ providerId: 'ACoREOPEN02', publicIdentifier: 'reopen-2' })],
    'nick',
    now - 60 * DAY,
  ).created;
  for (const lead of [reopened, lostAgain]) {
    store.applyAction(lead.id, { action: 'lost' }, 'nick', now - 40 * DAY);
    store.applyAction(lead.id, { action: 'reopened' }, 'nick', now - 35 * DAY);
  }
  store.applyAction(lostAgain.id, { action: 'lost' }, 'nick', now - 10 * DAY);
  assert.equal(store.purgeLost(now - 30 * DAY, now), 0);
  assert.equal(store.get(reopened.id)?.stage, 'new');
  assert.equal(store.get(lostAgain.id)?.stage, 'lost');
  assert.equal(store.purgeLost(now - 5 * DAY, now), 1, 'nach der Frist ab dem letzten „Verloren“');
  assert.equal(store.get(lostAgain.id), null);
});
