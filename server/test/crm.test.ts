import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CrmStatusResponse } from '../../shared/crm.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse, LeadDetailResponse } from '../../shared/leads.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakeClose } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

const LIVE: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key', CRM_HANDOVER: 'on' };

function app(env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  return buildApp({ config: loadConfig({ ...base, ...env }), adapter: new MockAdapter(0), logger: false, requireSession: false });
}
type App = ReturnType<typeof app>;

const card = (overrides: Partial<NewLeadCard> = {}): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: 'ACoCRM001',
  publicIdentifier: 'erika-muster',
  profileUrl: 'https://www.linkedin.com/in/erika-muster',
  firstName: 'Erika',
  lastName: 'Muster',
  headline: 'Geschäftsführerin · Muster Wohnbau GmbH',
  position: 'Geschäftsführerin',
  company: 'Muster Wohnbau GmbH',
  location: 'Köln',
  website: 'https://www.muster-wohnbau.de',
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.88,
  reason: 'Entwickelt und verkauft selbst.',
  summary: 'Bauträger aus Köln.',
  metaAds: { state: 'none', advertiser: null, ads: 0, activeAds: 0, lastStop: null, foreignAds: 0, libraryUrl: null, note: null },
  ...overrides,
});

const post = (server: App, url: string, payload: object = {}) => server.inject({ method: 'POST', url, payload });

/** Lead bis „Antwort“ bringen: vernetzt, angeschrieben, geantwortet. */
async function repliedLead(server: App, overrides: Partial<NewLeadCard> = {}): Promise<CockpitLead> {
  const created = (await post(server, '/api/leads', { cards: [card(overrides)], owner: 'nick' })).json() as CreateLeadsResponse;
  const id = created.created[0].id;
  await post(server, `/api/leads/${id}/events`, { action: 'invite_accepted' });
  await post(server, `/api/leads/${id}/events`, { action: 'message_sent', text: 'Hallo Erika, kurze Frage …', label: 'G1' });
  const done = await post(server, `/api/leads/${id}/events`, { action: 'message_received', text: 'Klingt spannend, lass uns telefonieren.' });
  return (done.json() as LeadDetailResponse).lead;
}

test('Status: Simulation mock, live ohne Schlüssel off, mit Schlüssel live', async () => {
  const status = async (server: App) => (await server.inject({ method: 'GET', url: '/api/crm/status' })).json() as CrmStatusResponse;
  assert.deepEqual(await status(app()), { provider: 'close', mode: 'mock', handover: true });
  assert.equal((await status(app(LIVE))).mode, 'off');
  assert.equal((await status(app({ ...LIVE, CLOSE_API_KEY: 'x' }))).mode, 'live');
});

test('Übergabe ausgeschaltet (22.10.): im echten Betrieb Standard, Status sagt es, Übergabe 409 crm_off ohne Stufenwechsel', async () => {
  const status = async (server: App) => (await server.inject({ method: 'GET', url: '/api/crm/status' })).json() as CrmStatusResponse;
  const live = { ...LIVE, CRM_HANDOVER: undefined, CLOSE_API_KEY: 'x' };
  assert.equal((await status(app(live))).handover, false);
  const server = app({ CRM_HANDOVER: 'off' });
  assert.equal((await status(server)).handover, false);
  const lead = await repliedLead(server);
  const response = await post(server, `/api/leads/${lead.id}/handover`, {});
  assert.equal(response.statusCode, 409);
  assert.equal((response.json() as { error: { code: string; message: string } }).error.code, 'crm_off');
  assert.match((response.json() as { error: { message: string } }).error.message, /ausgeschaltet/);
  const after = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(after.lead.stage, 'replied');
});

test('Simulation: Übergabe ohne Netz, Stufe übergeben, Wiederholung mit clientId nur einmal', async () => {
  const server = app();
  const lead = await repliedLead(server, { mode: 'mock' });
  const first = await post(server, `/api/leads/${lead.id}/handover`, { note: 'Termin Do. 10 Uhr', clientId: 'h-1' });
  assert.equal(first.statusCode, 200, first.body);
  const detail = first.json() as LeadDetailResponse;
  assert.equal(detail.lead.stage, 'handed_over');
  assert.match(detail.lead.crm?.externalId ?? '', /^mock-close-/);
  assert.equal(detail.events.at(-1)?.title, 'An Close übergeben');
  assert.equal(detail.events.at(-1)?.text, 'Termin Do. 10 Uhr');
  const again = await post(server, `/api/leads/${lead.id}/handover`, { clientId: 'h-1' });
  assert.equal(again.json().duplicate, true);
  assert.equal(again.json().events.filter((event: { kind: string }) => event.kind === 'handed_over').length, 1);
  // Ohne clientId nochmal: Stufe passt nicht mehr.
  assert.equal((await post(server, `/api/leads/${lead.id}/handover`)).statusCode, 409);
});

test('Falsche Stufe: nichts in Close angelegt', async () => {
  const close = await startFakeClose();
  const server = app({ ...LIVE, CLOSE_API_KEY: 'close-test-key', CLOSE_BASE_URL: close.baseUrl });
  const created = (await post(server, '/api/leads', { cards: [card()], owner: 'nick' })).json() as CreateLeadsResponse;
  const response = await post(server, `/api/leads/${created.created[0].id}/handover`);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'invalid_transition');
  assert.equal(close.requests.length, 0);
  await close.close();
});

test('Live: Lead + Kontakt + Notiz in Close, genau wie dokumentiert', async (t) => {
  const close = await startFakeClose();
  t.after(() => close.close());
  const server = app({ ...LIVE, CLOSE_API_KEY: 'close-test-key', CLOSE_BASE_URL: close.baseUrl, CLOSE_STATUS_ID: 'stat_abc123' });
  const lead = await repliedLead(server);
  const response = await post(server, `/api/leads/${lead.id}/handover`, { note: 'Termin Do. 10 Uhr' });
  assert.equal(response.statusCode, 200, response.body);
  const detail = response.json() as LeadDetailResponse;
  assert.deepEqual(detail.lead.crm && { id: detail.lead.crm.externalId, url: detail.lead.crm.url }, { id: 'lead_test1', url: 'https://app.close.com/lead/lead_test1/' });

  const [create, note] = close.requests;
  assert.equal(create.path, '/api/v1/lead/');
  assert.equal(create.headers.authorization, `Basic ${Buffer.from('close-test-key:').toString('base64')}`);
  assert.deepEqual(create.body, {
    name: 'Muster Wohnbau GmbH',
    url: 'https://www.muster-wohnbau.de',
    description: 'Bauträger aus Köln. · Köln',
    status_id: 'stat_abc123',
    contacts: [{ name: 'Erika Muster', title: 'Geschäftsführerin', urls: [{ url: 'https://www.linkedin.com/in/erika-muster' }] }],
  });
  assert.equal(note.path, '/api/v1/activity/note/');
  const noteBody = note.body as { lead_id: string; note: string };
  assert.equal(noteBody.lead_id, 'lead_test1');
  assert.match(noteBody.note, /Notiz: Termin Do\. 10 Uhr/);
  assert.match(noteBody.note, /Einschätzung der Antwort: Interessiert/);
  assert.match(noteBody.note, /Erika, \d\d\.\d\d\.\d{4}: Klingt spannend/);
});

test('Live: Fehler verständlich, ohne Schlüssel im Text; Notiz-Fehler → trotzdem übergeben', async () => {
  for (const [status, code, http] of [[401, 'crm_auth', 502], [429, 'crm_rate_limited', 429], [500, 'crm_unavailable', 503]] as const) {
    const close = await startFakeClose({ leadStatus: status });
    const server = app({ ...LIVE, CLOSE_API_KEY: 'close-test-key', CLOSE_BASE_URL: close.baseUrl });
    const lead = await repliedLead(server);
    const response = await post(server, `/api/leads/${lead.id}/handover`);
    assert.equal(response.statusCode, http);
    assert.equal(response.json().error.code, code);
    assert.ok(!response.body.includes('close-test-key'));
    if (status === 429) assert.equal(response.headers['retry-after'], '7');
    const after = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
    assert.equal(after.lead.stage, 'replied');
    assert.equal(after.lead.crm ?? null, null);
    await close.close();
  }

  const close = await startFakeClose({ noteStatus: 500 });
  const server = app({ ...LIVE, CLOSE_API_KEY: 'close-test-key', CLOSE_BASE_URL: close.baseUrl });
  const lead = await repliedLead(server);
  const response = await post(server, `/api/leads/${lead.id}/handover`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().lead.stage, 'handed_over');
  assert.equal(response.json().events.at(-1).title, 'An Close übergeben – Notiz fehlt');
  await close.close();

  const off = app(LIVE);
  const offLead = await repliedLead(off);
  const refused = await post(off, `/api/leads/${offLead.id}/handover`);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, 'crm_off');
});

test('Live: erneute Übergabe nach „Wieder öffnen“ – kein zweiter Close-Lead, neue Notiz am bestehenden', async (t) => {
  const close = await startFakeClose();
  t.after(() => close.close());
  const server = app({ ...LIVE, CLOSE_API_KEY: 'close-test-key', CLOSE_BASE_URL: close.baseUrl });
  const lead = await repliedLead(server);
  assert.equal((await post(server, `/api/leads/${lead.id}/handover`, { note: 'Erste Übergabe' })).statusCode, 200);
  assert.equal((await post(server, `/api/leads/${lead.id}/events`, { action: 'reopened' })).statusCode, 200);
  const again = await post(server, `/api/leads/${lead.id}/handover`, { note: 'Zweite Übergabe' });
  assert.equal(again.statusCode, 200, again.body);
  const detail = again.json() as LeadDetailResponse;
  assert.equal(detail.lead.stage, 'handed_over');
  assert.equal(detail.lead.crm?.externalId, 'lead_test1');
  assert.equal(detail.events.at(-1)?.title, 'An Close übergeben');

  assert.deepEqual(close.requests.map((request) => request.path), ['/api/v1/lead/', '/api/v1/activity/note/', '/api/v1/activity/note/']);
  const second = close.requests[2].body as { lead_id: string; note: string };
  assert.equal(second.lead_id, 'lead_test1');
  assert.match(second.note, /Notiz: Zweite Übergabe/);
});
