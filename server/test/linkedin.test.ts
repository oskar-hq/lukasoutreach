import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse, LeadDetailResponse } from '../../shared/leads.js';
import type { LinkedInAccountsResponse, LinkedInStatusResponse, LinkedInSyncResponse } from '../../shared/linkedin.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { ROLE_MESSAGES } from '../src/auth/roles.js';
import { liveWarnings, loadConfig, replaceConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { localTime, secondsUntilMidnight, stableNumber, withinWorkHours } from '../src/linkedin/guard.js';
import { profileIdentifier } from '../src/linkedin/routes.js';
import { LinkedInService } from '../src/linkedin/service.js';
import { startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

const LIVE: NodeJS.ProcessEnv = {
  LEAD_SEARCH_MODE: 'live',
  UNIPILE_API_KEY: 'unipile-test-key',
  LINKEDIN_ACTIONS: 'on',
  UNIPILE_ACCOUNT_NICK: 'acc_nick',
  LINKEDIN_PAUSE_SECONDS: '0-0',
  LINKEDIN_WORK_HOURS: '0-24',
  LINKEDIN_WORK_DAYS: '1-7',
};

function app(env: NodeJS.ProcessEnv = {}, requireSession = false) {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  return buildApp({ config: loadConfig({ ...base, ...env }), adapter: new MockAdapter(0), logger: false, requireSession, linkedinTest: { minPauseMs: 0 } });
}

type App = ReturnType<typeof app>;

const card = (i: number, overrides: Partial<NewLeadCard> = {}): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: `ACoTEST${i}`,
  publicIdentifier: `person-${i}`,
  profileUrl: `https://www.linkedin.com/in/person-${i}`,
  firstName: `Vorname${i}`,
  lastName: `Nachname${i}`,
  headline: 'Geschäftsführer',
  position: 'Geschäftsführer',
  company: `Firma ${i} GmbH`,
  location: 'Hamburg',
  website: null,
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.9,
  reason: 'Test',
  summary: 'Test',
  metaAds: null,
  ...overrides,
});

async function createLeads(server: App, cards: NewLeadCard[], owner: 'nick' | 'johannes' = 'nick'): Promise<CockpitLead[]> {
  const response = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards, owner } });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as CreateLeadsResponse).created;
}

const post = (server: App, url: string, payload: object = {}, headers: Record<string, string> = {}) =>
  server.inject({ method: 'POST', url, payload, headers });
const invite = (server: App, id: string, payload: object = {}, headers?: Record<string, string>) => post(server, `/api/leads/${id}/linkedin/invite`, payload, headers);
const message = (server: App, id: string, text: string, label?: string) => post(server, `/api/leads/${id}/linkedin/message`, { text, label });
const sync = async (server: App) => (await post(server, '/api/linkedin/sync')).json() as LinkedInSyncResponse;
const status = async (server: App) => (await server.inject({ method: 'GET', url: '/api/linkedin/status' })).json() as LinkedInStatusResponse;

// ── Schutzgrenzen ───────────────────────────────────────────────────────────

test('Arbeitszeit und Tag in Europe/Berlin', () => {
  const config = loadConfig({}).linkedin;
  assert.deepEqual(config.workHours, { fromHour: 8, toHour: 19, days: [1, 2, 3, 4, 5], timeZone: 'Europe/Berlin' });
  const mondayMorning = Date.UTC(2026, 9, 5, 7, 30); // Mo 05.10.2026, 9:30 Uhr in Berlin (Sommerzeit)
  assert.equal(localTime(mondayMorning, 'Europe/Berlin').day, '2026-10-05');
  assert.equal(withinWorkHours(config, mondayMorning), true);
  assert.equal(withinWorkHours(config, Date.UTC(2026, 9, 5, 17, 30)), false, '19:30 Uhr');
  assert.equal(withinWorkHours(config, Date.UTC(2026, 9, 4, 9)), false, 'Sonntag');
  assert.equal(secondsUntilMidnight(Date.UTC(2026, 9, 5, 21, 0), 'Europe/Berlin'), 3600, '23 Uhr in Berlin');
});

test('Konfiguration: Standard aus, Spannen geprüft', () => {
  assert.equal(loadConfig({ LEAD_SEARCH_MODE: 'live' }).linkedin.enabled, false, 'live erst mit LINKEDIN_ACTIONS=on');
  assert.equal(loadConfig({}).linkedin.enabled, false, 'Standard ist der echte Betrieb – auch dann erst mit LINKEDIN_ACTIONS=on');
  assert.equal(loadConfig({ LEAD_SEARCH_MODE: 'mock' }).linkedin.enabled, true, 'Simulation');
  assert.throws(() => loadConfig({ LINKEDIN_WORK_HOURS: '19-8' }), /LINKEDIN_WORK_HOURS/);
  assert.throws(() => loadConfig({ LINKEDIN_WORK_DAYS: '0-5' }), /LINKEDIN_WORK_DAYS/);
  assert.deepEqual(loadConfig({ LINKEDIN_WORK_DAYS: '1-3,5,7' }).linkedin.workHours.days, [1, 2, 3, 5, 7]);
  assert.throws(() => loadConfig({ LINKEDIN_WORK_DAYS: '5-1' }), /LINKEDIN_WORK_DAYS/);
  assert.deepEqual(loadConfig({}).update, { auto: false, hour: 3 });
  assert.throws(() => loadConfig({ UPDATE_HOUR: '24' }), /UPDATE_HOUR/);
  assert.throws(() => loadConfig({ LINKEDIN_TIMEZONE: 'Mond/Basis' }), /Zeitzone/);
  assert.deepEqual(loadConfig({}).linkedin.pauseMs, [3000, 8000]);
});

// ── Simulation ──────────────────────────────────────────────────────────────

test('Simulation: Status, Anfrage, Abgleich (2 von 3 angenommen), Erstnachricht, Antwort', async () => {
  const server = app();
  const before = await status(server);
  assert.equal(before.mode, 'mock');
  assert.deepEqual(
    before.accounts.map((account) => [account.founder, account.connected, account.invitesToday]),
    [
      ['nick', true, { used: 0, limit: 20 }],
      ['johannes', true, { used: 0, limit: 20 }],
    ],
  );
  assert.equal(before.withinWorkHours, true);

  const leads = await createLeads(server, [1, 2, 3, 4, 5, 6].map((i) => card(i)));
  for (const lead of leads) {
    const response = await invite(server, lead.id, { message: 'Hallo!' });
    assert.equal(response.statusCode, 200, response.body);
    const { lead: after, events } = response.json() as LeadDetailResponse;
    assert.equal(after.stage, 'invited');
    assert.match(after.linkedin!.invitationId!, /^mock-inv-/);
    assert.equal(events.at(-1)!.title, 'Vernetzungsanfrage gesendet von Nick · über LinkedIn');
    assert.equal(events.at(-1)!.text, 'Hallo!');
  }
  assert.equal((await status(server)).accounts[0].invitesToday.used, 6);

  const accepting = leads.filter((lead) => stableNumber(lead.id) % 3 !== 0).map((lead) => lead.id);
  const first = await sync(server);
  assert.deepEqual(first.accepted.sort(), [...accepting].sort());
  assert.deepEqual((await sync(server)).accepted, [], 'kein zweites Mal');

  for (const id of accepting) {
    const response = await message(server, id, 'Danke fürs Vernetzen!', 'A');
    assert.equal(response.statusCode, 200, response.body);
    const { lead } = response.json() as LeadDetailResponse;
    assert.equal(lead.stage, 'contacted');
    assert.equal(lead.template, 'A');
    assert.match(lead.linkedin!.chatId!, /^mock-chat-/);
  }
  const replying = accepting.filter((id) => stableNumber(id) % 3 === 0);
  assert.deepEqual((await sync(server)).replied.sort(), [...replying].sort());
  assert.deepEqual((await sync(server)).replied, []);
});

test('Prüfungen: falsche Stufe, zu lange Notiz, leerer Text, unbekannter Lead, Tageslimit', async () => {
  const server = app({ LINKEDIN_INVITES_PER_DAY: '1', LINKEDIN_ACCOUNT_FALLBACK: 'off' });
  const [a, b] = await createLeads(server, [card(1), card(2)]);
  const wrong = await message(server, a.id, 'Hallo');
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json().error.code, 'invalid_transition');
  assert.equal((await invite(server, a.id, { message: 'x'.repeat(301) })).statusCode, 400);
  assert.equal((await message(server, a.id, '   ')).statusCode, 400);
  assert.equal((await invite(server, 'gibt-es-nicht')).statusCode, 404);

  assert.equal((await invite(server, a.id)).statusCode, 200);
  const limited = await invite(server, b.id);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'linkedin_limit');
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await server.inject({ method: 'GET', url: `/api/leads/${b.id}` })).json().lead.stage, 'new', 'nichts verändert');
});

test('Account-Wechsel beim Senden: eigener Account voll → Anfrage über den Account des anderen, dort zählt sie', async () => {
  const server = app({ LINKEDIN_INVITES_PER_DAY: '1' });
  const [a, b, c] = await createLeads(server, [card(1), card(2), card(3)]);
  assert.equal((await invite(server, a.id)).statusCode, 200);
  const switched = await invite(server, b.id);
  assert.equal(switched.statusCode, 200, switched.body);
  assert.equal(switched.json().lead.linkedin.sentBy, 'johannes');
  assert.equal(switched.json().lead.owner, 'nick');
  const accounts = (await status(server)).accounts;
  assert.equal(accounts.find((entry) => entry.founder === 'johannes')?.invitesToday.used, 1);
  assert.equal(accounts.find((entry) => entry.founder === 'nick')?.invitesToday.used, 1);
  // Beide voll: wie bisher 429 (Limit des eigenen Accounts).
  const limited = await invite(server, c.id);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'linkedin_limit');
});

test('Mit Anmeldung: Lead des anderen Gründers geht über dessen Account (18.10.), Status braucht Sitzung', async () => {
  const server = app({ AUTH_DEMO_ACCOUNTS: 'true' }, true);
  assert.equal((await server.inject({ method: 'GET', url: '/api/linkedin/status' })).statusCode, 401);
  const login = await post(server, '/api/auth/login', { username: 'nick', password: 'demo' });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const created = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card(1)], owner: 'johannes' }, headers: { cookie } });
  const lead = (created.json() as CreateLeadsResponse).created[0];
  // Nick erledigt Johannes' Aufgabe unter „Alle“: gesendet über Johannes' Account, gebucht für Johannes, „von Nick“.
  const response = await invite(server, lead.id, {}, { cookie });
  assert.equal(response.statusCode, 200, response.body);
  const detail = response.json() as LeadDetailResponse;
  assert.equal(detail.lead.owner, 'johannes');
  assert.equal(detail.lead.stage, 'invited');
  assert.equal(detail.lead.linkedin?.sentBy, 'johannes');
  const sent = detail.events.find((event) => event.kind === 'invite_sent');
  assert.equal(sent?.by, 'johannes');
  assert.equal(sent?.actor, 'Nick');
  const used = (await server.inject({ method: 'GET', url: '/api/linkedin/status', headers: { cookie } })).json() as LinkedInStatusResponse;
  assert.equal(used.accounts.find((account) => account.founder === 'johannes')?.invitesToday.used, 1);
  assert.equal(used.accounts.find((account) => account.founder === 'nick')?.invitesToday.used, 0);
});

// ── Live (nachgebauter Unipile-Server) ──────────────────────────────────────

test('Live ohne LINKEDIN_ACTIONS: aus; ohne Account des Gründers: 409', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const off = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl, LINKEDIN_ACTIONS: 'false' });
  assert.equal((await status(off)).mode, 'off');
  const [lead] = await createLeads(off, [card(1)]);
  const response = await invite(off, lead.id);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'linkedin_off');

  const on = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const st = await status(on);
  assert.equal(st.mode, 'live');
  assert.deepEqual(st.accounts.map((account) => account.connected), [true, false]);
  const [johannes] = await createLeads(on, [card(2)], 'johannes');
  const noAccount = await invite(on, johannes.id);
  assert.equal(noAccount.json().error.code, 'linkedin_no_account');
  assert.match(noAccount.json().error.message, /Johannes.*Einstellungen → Senden über LinkedIn/);
  assert.equal(unipile.requests.filter((request) => request.method === 'POST').length, 0, 'nichts gesendet');
});

test('Live: Anfrage → angenommen → Erstnachricht → Follow-up → Antwort, genau wie dokumentiert', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(3)]);

  const sent = await invite(server, lead.id, { message: 'Hallo Vorname3' });
  assert.equal(sent.statusCode, 200, sent.body);
  const inviteRequest = unipile.requests.find((request) => request.path === '/api/v1/users/invite')!;
  assert.equal(inviteRequest.method, 'POST');
  assert.equal(inviteRequest.headers['x-api-key'], 'unipile-test-key');
  assert.deepEqual(inviteRequest.body, { provider_id: 'ACoTEST3', account_id: 'acc_nick', message: 'Hallo Vorname3' });
  assert.equal((sent.json() as LeadDetailResponse).lead.linkedin?.invitationId, `inv-${unipile.requests.length}`);

  // Noch nicht angenommen → nichts.
  assert.deepEqual((await sync(server)).accepted, []);
  const acceptedAt = Date.now();
  unipile.linkedin.relations = [{ member_id: 'ACoTEST3', public_identifier: 'person-3', created_at: acceptedAt }];
  const synced = await sync(server);
  assert.deepEqual(synced, { accepted: [lead.id], replied: [], problems: ['Johannes: kein LinkedIn-Account eingetragen.'], syncedAt: synced.syncedAt });
  const relationsRequest = unipile.requests.find((request) => request.path === '/api/v1/users/relations')!;
  assert.equal(relationsRequest.query.get('account_id'), 'acc_nick');
  let current = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(current.lead.stage, 'connected');
  assert.equal(current.events.at(-1)!.title, 'Vernetzungsanfrage angenommen · über LinkedIn');
  assert.equal(current.events.at(-1)!.at, acceptedAt);

  const first = await message(server, lead.id, 'Danke fürs Vernetzen!', 'B');
  assert.equal(first.statusCode, 200, first.body);
  const chatRequest = unipile.requests.find((request) => request.method === 'POST' && request.path === '/api/v1/chats')!;
  assert.deepEqual(chatRequest.body, { account_id: 'acc_nick', text: 'Danke fürs Vernetzen!', attendees_ids: 'ACoTEST3' });
  assert.equal((first.json() as LeadDetailResponse).lead.linkedin?.chatId, 'chat-1');

  const followUp = await message(server, lead.id, 'Kurze Erinnerung');
  assert.equal(followUp.statusCode, 200);
  const followRequest = unipile.requests.at(-1)!;
  assert.equal(followRequest.path, '/api/v1/chats/chat-1/messages');
  assert.deepEqual(followRequest.body, { text: 'Kurze Erinnerung' });
  current = followUp.json() as LeadDetailResponse;
  assert.equal(current.lead.followUpsSent, 1);

  const old = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const now = new Date().toISOString();
  unipile.linkedin.messages['chat-1'] = [
    { id: 'm-own', text: 'Kurze Erinnerung', is_sender: 1, timestamp: now, sender_id: 'acc' },
    { id: 'm-old', text: 'Alte Nachricht von früher', is_sender: 0, timestamp: old, sender_id: 'ACoTEST3' },
    { id: 'm-reply', text: 'Klingt gut, gerne Donnerstag.', is_sender: 0, timestamp: now, sender_id: 'ACoTEST3' },
  ];
  assert.deepEqual((await sync(server)).replied, [lead.id]);
  assert.deepEqual((await sync(server)).replied, [], 'jede Antwort nur einmal');
  current = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(current.lead.stage, 'replied');
  const received = current.events.filter((event) => event.kind === 'message_received');
  assert.deepEqual(received.map((event) => event.text), ['Klingt gut, gerne Donnerstag.'], 'nur Antworten seit Beginn der Unterhaltung');

  const st = await status(server);
  assert.deepEqual([st.accounts[0].invitesToday.used, st.accounts[0].messagesToday.used], [1, 2]);
  assert.ok(st.lastSyncAt);
});

test('Live: gemerkter Chat bei Unipile unbekannt (404) → Follow-up geht über das Profil, neuer Chat gemerkt', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(3)]);
  assert.equal((await invite(server, lead.id)).statusCode, 200);
  unipile.linkedin.relations = [{ member_id: 'ACoTEST3', public_identifier: 'person-3', created_at: Date.now() }];
  await sync(server);
  assert.equal((await message(server, lead.id, 'Danke fürs Vernetzen!', 'B')).statusCode, 200);

  unipile.linkedin.failNext = { status: 404, type: 'errors/resource_not_found' };
  const before = unipile.requests.length;
  const followUp = await message(server, lead.id, 'Kurze Erinnerung');
  assert.equal(followUp.statusCode, 200, followUp.body);
  const calls = unipile.requests.slice(before).map((request) => `${request.method} ${request.path}`);
  assert.deepEqual(calls, ['POST /api/v1/chats/chat-1/messages', 'POST /api/v1/chats']);
  assert.deepEqual(unipile.requests.at(-1)!.body, { account_id: 'acc_nick', text: 'Kurze Erinnerung', attendees_ids: 'ACoTEST3' });
  const current = followUp.json() as LeadDetailResponse;
  assert.equal(current.lead.linkedin?.chatId, 'chat-2');
  assert.equal(current.lead.followUpsSent, 1);
  assert.equal((await status(server)).accounts[0].pausedUntil, null);

  // Andere Fehler beim gemerkten Chat bleiben Fehler – kein zweiter Versuch über das Profil.
  unipile.linkedin.failNext = { status: 422, type: 'errors/invalid_recipient' };
  const count = unipile.requests.length;
  const rejected = await message(server, lead.id, 'Noch eine');
  assert.equal(rejected.statusCode, 409);
  assert.equal(unipile.requests.length, count + 1);
});

test('Live: Limit von LinkedIn pausiert den Account, nichts verändert; Ablehnung pausiert nicht', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [a, b] = await createLeads(server, [card(1), card(2)]);

  unipile.linkedin.failNext = { status: 422, type: 'errors/already_invited_recently' };
  const rejected = await invite(server, a.id);
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error.code, 'linkedin_rejected');
  assert.match(rejected.json().error.message, /schon eingeladen/);
  assert.equal((await status(server)).accounts[0].pausedUntil, null);

  unipile.linkedin.failNext = { status: 429, type: 'errors/too_many_requests' };
  const limited = await invite(server, a.id);
  assert.equal(limited.statusCode, 503);
  assert.equal(limited.json().error.code, 'linkedin_paused');
  assert.equal(Number(limited.headers['retry-after']), 24 * 3600);
  const lead = (await server.inject({ method: 'GET', url: `/api/leads/${a.id}` })).json() as LeadDetailResponse;
  assert.equal(lead.lead.stage, 'new');
  assert.equal(lead.events.some((event) => event.kind === 'invite_sent'), false);

  const st = await status(server);
  assert.ok(st.accounts[0].pausedUntil! > Date.now());
  assert.equal(st.accounts[0].pauseReason, 'LinkedIn meldet ein Limit.');
  assert.equal(st.accounts[0].invitesToday.used, 0, 'Fehlversuche zählen nicht');

  const invites = () => unipile.requests.filter((request) => request.path === '/api/v1/users/invite').length;
  const before = invites();
  const paused = await invite(server, b.id);
  assert.equal(paused.statusCode, 503);
  assert.equal(invites(), before, 'während der Pause wird Unipile gar nicht gefragt');
});

test('Live: 503 no_client_session (Unipile-Abo abgelaufen) pausiert nicht und nennt den Grund', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [a] = await createLeads(server, [card(1)]);

  unipile.linkedin.failNext = { status: 503, type: 'errors/no_client_session' };
  const failed = await invite(server, a.id);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().error.code, 'linkedin_error');
  assert.match(failed.json().error.message, /keine Sitzung \(no_client_session\)/);
  assert.doesNotMatch(failed.json().error.message, /Limit/);
  assert.equal((await status(server)).accounts[0].pausedUntil, null, 'kein Limit-Verdacht, keine Pause');

  // Ein anderer 5xx bleibt vorsichtig (Pause), nennt aber Unipile statt LinkedIn als Quelle.
  unipile.linkedin.failNext = { status: 500, type: 'errors/unexpected_error' };
  const serverError = await invite(server, a.id);
  assert.equal(serverError.json().error.code, 'linkedin_paused');
  assert.match(serverError.json().error.message, /^Unipile meldet einen Serverfehler/);
});

test('Live: außerhalb der Arbeitszeit nichts senden', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const hour = localTime(Date.now(), 'Europe/Berlin').hour;
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl, LINKEDIN_WORK_HOURS: hour < 12 ? '20-23' : '1-4' });
  const [lead] = await createLeads(server, [card(1)]);
  const response = await invite(server, lead.id);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'linkedin_outside_hours');
  assert.equal((await status(server)).withinWorkHours, false);
  assert.equal(unipile.requests.filter((request) => request.method === 'POST').length, 0);
});

test('Live: zwei Klicks gleichzeitig → genau eine Anfrage', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(1)]);
  const results = await Promise.all([invite(server, lead.id), invite(server, lead.id)]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal(unipile.requests.filter((request) => request.path === '/api/v1/users/invite').length, 1);
});

test('Live: gleiche clientId zweimal → einmal gesendet, Wiederholung mit duplicate', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(1)]);
  const sent = () => unipile.requests.filter((request) => request.path === '/api/v1/users/invite').length;

  // Gleichzeitig: der zweite wartet in der Schlange und merkt dort, dass schon gesendet ist.
  const [first, second] = await Promise.all([invite(server, lead.id, { clientId: 'inv-1' }), invite(server, lead.id, { clientId: 'inv-1' })]);
  assert.deepEqual([first.statusCode, second.statusCode], [200, 200]);
  assert.deepEqual([first.json().duplicate, second.json().duplicate].sort(), [true, undefined]);
  // Später noch einmal (z. B. nach Netzfehler wiederholt) → wieder nur der Stand.
  const later = await invite(server, lead.id, { clientId: 'inv-1' });
  assert.equal(later.statusCode, 200);
  assert.equal(later.json().duplicate, true);
  assert.equal(sent(), 1);
  assert.equal(later.json().events.filter((event: { kind: string }) => event.kind === 'invite_sent').length, 1);
  // Andere Kennung, falsche Stufe → wie bisher 409, nichts gesendet.
  assert.equal((await invite(server, lead.id, { clientId: 'inv-2' })).statusCode, 409);
  assert.equal(sent(), 1);
});

// ── Einrichten in der Oberfläche (statt linkedinCli) ────────────────────────

const accounts = async (server: App, headers: Record<string, string> = {}) => server.inject({ method: 'GET', url: '/api/linkedin/accounts', headers });
const testInvite = (server: App, payload: object, headers?: Record<string, string>) => post(server, '/api/linkedin/test-invite', payload, headers);
const resume = (server: App, founder: string, headers?: Record<string, string>) => post(server, '/api/linkedin/resume', { founder }, headers);

test('Profil-Kennung aus Link oder Kennung', () => {
  assert.equal(profileIdentifier('https://www.linkedin.com/in/max-muster/'), 'max-muster');
  assert.equal(profileIdentifier('linkedin.com/in/max-muster?trk=x'), 'max-muster');
  assert.equal(profileIdentifier('https://de.linkedin.com/in/m%C3%BCller'), 'müller');
  assert.equal(profileIdentifier(' ACoTEST9 '), 'ACoTEST9');
  assert.equal(profileIdentifier('https://example.com/in/max'), null);
  assert.equal(profileIdentifier('max muster'), null);
  assert.equal(profileIdentifier('https://www.linkedin.com/in/'), null);
});

test('Einrichten (Simulation): drei erfundene Accounts, Test-Anfrage sendet nichts, Pause aufheben', async () => {
  const server = app();
  const list = await accounts(server);
  assert.equal(list.statusCode, 200);
  // Such-Reihenfolge (21.10.): Scraping-Accounts vorn, Gründer zuletzt.
  assert.deepEqual(
    (list.json() as LinkedInAccountsResponse).accounts.map(({ id, name, assignedTo, searching, warmup }) => ({ id, name, assignedTo, searching, warmup })),
    [
      { id: 'mock-scraper', name: 'Scraping-Account (Simulation)', assignedTo: null, searching: false, warmup: false },
      { id: 'mock-nick', name: 'Nick (Simulation)', assignedTo: 'nick', searching: true, warmup: false },
      { id: 'mock-johannes', name: 'Johannes (Simulation)', assignedTo: 'johannes', searching: false, warmup: false },
    ],
  );

  const sent = await testInvite(server, { founder: 'nick', profile: 'https://www.linkedin.com/in/kollege', message: 'Hallo' });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(sent.json(), { ok: true, message: 'Simulation – nichts gesendet.' });
  assert.equal((await status(server)).accounts[0].invitesToday.used, 0, 'zählt in der Simulation nicht');

  const invalid = [
    { founder: 'nick' },
    { founder: 'nick', profile: '' },
    { founder: 'nick', profile: 'https://example.com/in/kollege' },
    { founder: 'nick', profile: 'kollege', message: 'x'.repeat(301) },
    { founder: 'oskar', profile: 'kollege' },
    { profile: 'kollege' },
  ];
  for (const body of invalid) {
    const response = await testInvite(server, body);
    assert.deepEqual([response.statusCode, response.json().error.code], [400, 'invalid_request'], JSON.stringify(body));
  }

  const resumed = await resume(server, 'johannes');
  assert.equal(resumed.statusCode, 200);
  assert.equal((resumed.json() as LinkedInStatusResponse).mode, 'mock');
  assert.equal((await resume(server, 'oskar')).statusCode, 400);
});

test('Einrichten live: Accounts von Unipile mit Zuordnung, Test-Anfrage über Unipile, Pause aufheben', async (t) => {
  const unipile = await startFakeUnipile({
    accounts: [
      { object: 'Account', type: 'WHATSAPP', id: 'acc_whatsapp', name: 'Telefon' },
      { object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick Beispiel' },
      { object: 'Account', type: 'LINKEDIN', id: 'acc_neu' },
    ],
  });
  t.after(() => unipile.close());

  // Ohne Unipile-Zugang: 409 linkedin_off; falscher Schlüssel: 503 linkedin_error (ohne Schlüssel in der Meldung)
  const noUnipile = await accounts(app({ LEAD_SEARCH_MODE: 'live' }));
  assert.deepEqual([noUnipile.statusCode, noUnipile.json().error.code], [409, 'linkedin_off']);
  assert.match(noUnipile.json().error.message, /Einstellungen → LinkedIn \(Unipile\)/);
  const wrongKey = await accounts(app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'falsch-geheim' }));
  assert.deepEqual([wrongKey.statusCode, wrongKey.json().error.code], [503, 'linkedin_error']);
  assert.equal(wrongKey.body.includes('falsch-geheim'), false);

  // Braucht nur den Unipile-Zugang, nicht LINKEDIN_ACTIONS
  const off = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl, LINKEDIN_ACTIONS: 'off' });
  const list = (await accounts(off)).json() as LinkedInAccountsResponse;
  assert.deepEqual(
    list.accounts.map(({ id, name, assignedTo, searching, warmup }) => ({ id, name, assignedTo, searching, warmup })),
    [
      { id: 'acc_neu', name: 'LinkedIn-Account ohne Namen', assignedTo: null, searching: false, warmup: false },
      { id: 'acc_nick', name: 'Nick Beispiel', assignedTo: 'nick', searching: true, warmup: false },
    ],
  );
  const offInvite = await testInvite(off, { founder: 'nick', profile: 'ACoTEST9' });
  assert.deepEqual([offInvite.statusCode, offInvite.json().error.code], [409, 'linkedin_off']);
  assert.match(offInvite.json().error.message, /Einstellungen → Senden über LinkedIn/);
  assert.doesNotMatch(offInvite.json().error.message, /\.env/);

  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const noAccount = await testInvite(server, { founder: 'johannes', profile: 'ACoTEST9' });
  assert.deepEqual([noAccount.statusCode, noAccount.json().error.code], [409, 'linkedin_no_account']);
  assert.match(noAccount.json().error.message, /Johannes.*Einstellungen → Senden über LinkedIn/);

  const sent = await testInvite(server, { founder: 'nick', profile: 'https://www.linkedin.com/in/ACoTEST9', message: ' Hallo Kollege ' });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(sent.json(), { ok: true, message: 'Anfrage an Vorname9 Nachname9 gesendet.' });
  const posted = unipile.requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/users/invite');
  assert.equal(posted.length, 1, 'genau eine Anfrage');
  assert.deepEqual(posted[0].body, { provider_id: 'ACoTEST9', account_id: 'acc_nick', message: 'Hallo Kollege' });
  assert.equal((await status(server)).accounts[0].invitesToday.used, 1, 'zählt zum Tageslimit');

  // Limit von LinkedIn → pausiert; Pause aufheben → wieder frei
  unipile.linkedin.failNext = { status: 429, type: 'errors/too_many_requests' };
  const limited = await testInvite(server, { founder: 'nick', profile: 'ACoTEST8' });
  assert.deepEqual([limited.statusCode, limited.json().error.code], [503, 'linkedin_paused']);
  assert.ok((await status(server)).accounts[0].pausedUntil! > Date.now());
  const paused = await testInvite(server, { founder: 'nick', profile: 'ACoTEST8' });
  assert.equal(paused.statusCode, 503);
  assert.ok(Number(paused.headers['retry-after']) > 0);
  const resumed = await resume(server, 'nick');
  assert.equal(resumed.statusCode, 200);
  assert.deepEqual([(resumed.json() as LinkedInStatusResponse).accounts[0].pausedUntil, (resumed.json() as LinkedInStatusResponse).accounts[0].pauseReason], [null, null]);
  assert.equal((await resume(server, 'nick')).statusCode, 200, 'keine Pause → unverändert 200');
  assert.equal((await testInvite(server, { founder: 'nick', profile: 'ACoTEST8' })).statusCode, 200);
});

test('Einrichten: Rechte – Accounts und Test-Anfrage nur Admin und Gründer; Pause aufheben auch der Mitarbeiter für seinen Gründer', async () => {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', AUTH_DEMO_ACCOUNTS: 'true' };
  const server = buildApp({ config: loadConfig(base), adapter: new MockAdapter(0), logger: false, requireSession: true });
  const login = async (username: string) => {
    const response = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'demo' } });
    return { cookie: String(response.headers['set-cookie']).split(';')[0] };
  };
  const anna = await login('mitarbeiter');
  const nick = await login('nick');
  const admin = await login('admin');

  assert.equal((await accounts(server)).statusCode, 401);
  const denied = await accounts(server, anna);
  assert.deepEqual([denied.statusCode, denied.json().error.code, denied.json().error.message], [403, 'not_allowed', ROLE_MESSAGES.linkedinSetup]);
  assert.equal((await testInvite(server, { founder: 'nick', profile: 'kollege' }, anna)).statusCode, 403);
  assert.equal((await accounts(server, nick)).statusCode, 200);
  assert.equal((await accounts(server, admin)).statusCode, 200, 'Liste auch für Admins');
  // Test-Anfrage: nur der Gründer über seinen eigenen Account; Admins senden nie über LinkedIn
  assert.equal((await testInvite(server, { founder: 'nick', profile: 'kollege' }, nick)).statusCode, 200);
  const foreignInvite = await testInvite(server, { founder: 'johannes', profile: 'kollege' }, nick);
  assert.deepEqual([foreignInvite.statusCode, foreignInvite.json().error.code, foreignInvite.json().error.message], [403, 'not_allowed', ROLE_MESSAGES.linkedinOwnAccount]);
  const adminInvite = await testInvite(server, { founder: 'nick', profile: 'kollege' }, admin);
  assert.deepEqual([adminInvite.statusCode, adminInvite.json().error.code, adminInvite.json().error.message], [403, 'not_allowed', ROLE_MESSAGES.linkedinTestInvite]);

  assert.equal((await resume(server, 'nick', anna)).statusCode, 200, 'Mitarbeiter für seinen Gründer');
  const foreign = await resume(server, 'johannes', anna);
  assert.deepEqual([foreign.statusCode, foreign.json().error.code], [403, 'not_allowed']);
  assert.equal((await resume(server, 'johannes', nick)).statusCode, 200);
  assert.equal((await resume(server, 'johannes', admin)).statusCode, 200);
});

test('Abgleich im Hintergrund plant neu, wenn sich Einstellungen ändern', () => {
  const env: NodeJS.ProcessEnv = { ...LIVE, UNIPILE_DSN: 'https://api1.unipile.com:13111', DATA_DIR: tempDataDir() };
  const config = loadConfig(env);
  const db = openDatabase(config.dataDir);
  const log = { info() {}, warn() {}, error() {} } as unknown as ConstructorParameters<typeof LinkedInService>[0]['log'];
  const service = new LinkedInService({ config, db, leads: null as unknown as ConstructorParameters<typeof LinkedInService>[0]['leads'], log });
  try {
    service.replanSync();
    assert.equal(service.plannedSyncMinutes, null, 'nur im echten Start');
    service.startBackgroundSync();
    assert.equal(service.plannedSyncMinutes, 15);
    replaceConfig(config, loadConfig({ ...env, LINKEDIN_SYNC_MINUTES: '5' }));
    service.replanSync();
    assert.equal(service.plannedSyncMinutes, 5);
    replaceConfig(config, loadConfig({ ...env, LINKEDIN_SYNC_MINUTES: '0' }));
    service.replanSync();
    assert.equal(service.plannedSyncMinutes, null, '0 = aus');
    // Von Hand senden (LINKEDIN_ACTIONS aus): angenommene Anfragen werden trotzdem geprüft (nur lesend, 11.10.).
    replaceConfig(config, loadConfig({ ...env, LINKEDIN_ACTIONS: 'off' }));
    service.replanSync();
    assert.equal(service.plannedSyncMinutes, 15, 'von Hand senden – Abgleich bleibt');
    assert.equal(service.status().watching, true);
    replaceConfig(config, loadConfig({ ...env, LINKEDIN_ACTIONS: 'off', UNIPILE_API_KEY: '' }));
    service.replanSync();
    assert.equal(service.plannedSyncMinutes, null, 'ohne Unipile kein Abgleich');
    assert.equal(service.status().watching, false);
    replaceConfig(config, loadConfig(env));
    service.replanSync();
    assert.equal(service.plannedSyncMinutes, 15, 'wieder an');
  } finally {
    service.close();
    db.close();
  }
  assert.equal(service.plannedSyncMinutes, null);
});

test('Test-Anfrage läuft durch die Warteschlange des Gründers: zwei gleichzeitig → Limit hält, Pause gilt', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const sent = () => unipile.requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/users/invite').length;

  // Tageslimit 1: die zweite merkt in der Warteschlange, dass das Limit erreicht ist
  const limited = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl, LINKEDIN_INVITES_PER_DAY: '1' });
  const both = await Promise.all([testInvite(limited, { founder: 'nick', profile: 'ACoTEST8' }), testInvite(limited, { founder: 'nick', profile: 'ACoTEST9' })]);
  assert.deepEqual(both.map((response) => response.statusCode).sort(), [200, 429]);
  assert.equal(sent(), 1, 'genau eine Anfrage');
  assert.equal((await status(limited)).accounts[0].invitesToday.used, 1);

  // Pause auch zwischen Test-Anfragen und Senden im Cockpit
  const before = sent();
  const paced = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl, LINKEDIN_PAUSE_SECONDS: '1-1' });
  const [lead] = await createLeads(paced, [card(1)]);
  const started = Date.now();
  const results = await Promise.all([testInvite(paced, { founder: 'nick', profile: 'ACoTEST8' }), invite(paced, lead.id)]);
  assert.deepEqual(results.map((response) => response.statusCode), [200, 200]);
  assert.ok(Date.now() - started >= 950, 'zweite Aktion wartet die Pause ab');
  assert.equal(sent() - before, 2);
});

test('Live: Pause unter 3 s aus der .env wird auf 3 s angehoben', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const base: NodeJS.ProcessEnv = { DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', ...LIVE, UNIPILE_DSN: unipile.baseUrl };
  assert.equal(base.LINKEDIN_PAUSE_SECONDS, '0-0');
  // Ohne Test-Untergrenze – wie im echten Server
  const server = buildApp({ config: loadConfig(base), adapter: new MockAdapter(0), logger: false, requireSession: false });
  const started = Date.now();
  const results = await Promise.all([testInvite(server, { founder: 'nick', profile: 'ACoTEST8' }), testInvite(server, { founder: 'nick', profile: 'ACoTEST9' })]);
  assert.deepEqual(results.map((response) => response.statusCode), [200, 200]);
  assert.ok(Date.now() - started >= 2950, 'mindestens 3 s zwischen zwei Aktionen');
});

test('Gleicher LinkedIn-Account für beide Gründer: Hinweis statt Absturz, live wird nicht gesendet', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const env = { ...LIVE, UNIPILE_DSN: unipile.baseUrl, UNIPILE_ACCOUNT_JOHANNES: 'acc_nick' };
  const config = loadConfig({ ...env, DATA_DIR: tempDataDir() });
  assert.match(liveWarnings(config).join(' '), /eigenen LinkedIn-Account/);
  const server = app(env);
  const [lead] = await createLeads(server, [card(1)]);
  const response = await invite(server, lead.id);
  assert.deepEqual([response.statusCode, response.json().error.code], [409, 'linkedin_no_account']);
  assert.match(response.json().error.message, /eigenen LinkedIn-Account/);
  assert.equal((await testInvite(server, { founder: 'nick', profile: 'ACoTEST8' })).statusCode, 409);
  assert.equal(unipile.requests.filter((request) => request.method === 'POST').length, 0, 'nichts gesendet');
});

test('Test-LinkedIn-Account: prüfen und speichern, genau eine Test-Nachricht, auch ohne LINKEDIN_ACTIONS', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, LINKEDIN_ACTIONS: 'off', UNIPILE_DSN: unipile.baseUrl });
  const chats = () => unipile.requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/chats');

  // Ohne gespeicherten Test-Account geht nichts raus.
  assert.deepEqual((await server.inject({ method: 'GET', url: '/api/linkedin/test-profile' })).json(), { profile: null });
  const none = await post(server, '/api/linkedin/test-message', { founder: 'nick', text: 'Test' });
  assert.deepEqual([none.statusCode, none.json().error.code], [409, 'linkedin_rejected']);

  // Prüfen: Name und Überschrift zur Kontrolle, gespeichert.
  const checked = await server.inject({ method: 'PUT', url: '/api/linkedin/test-profile', payload: { founder: 'nick', profile: 'https://www.linkedin.com/in/ACoTEST100' } });
  assert.equal(checked.statusCode, 200, checked.body);
  const profile = checked.json().profile;
  assert.deepEqual([profile.name, profile.providerId, profile.connected, profile.profileUrl], ['Vorname100 Nachname100', 'ACoTEST100', true, 'https://www.linkedin.com/in/person-100']);
  assert.equal((await server.inject({ method: 'GET', url: '/api/linkedin/test-profile' })).json().profile.name, 'Vorname100 Nachname100');
  assert.equal(chats().length, 0, 'Prüfen sendet nichts');

  const sent = await post(server, '/api/linkedin/test-message', { founder: 'nick', text: 'Test nach dem Update' });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.match(sent.json().message, /^Test-Nachricht an Vorname100 Nachname100 gesendet/);
  assert.equal(chats().length, 1);
  assert.equal((chats()[0].body as Record<string, string>).attendees_ids, 'ACoTEST100');
  // Höchstens eine pro Minute
  const again = await post(server, '/api/linkedin/test-message', { founder: 'nick', text: 'Noch einmal' });
  assert.deepEqual([again.statusCode, again.json().error.code], [429, 'linkedin_limit']);
  assert.equal(chats().length, 1);

  // Kein Kontakt 1. Grades: gespeichert mit Hinweis, Nachricht wird nicht versucht.
  const other = app({ ...LIVE, LINKEDIN_ACTIONS: 'off', UNIPILE_DSN: unipile.baseUrl });
  const stranger = await other.inject({ method: 'PUT', url: '/api/linkedin/test-profile', payload: { founder: 'nick', profile: 'ACoTEST5' } });
  assert.equal(stranger.json().profile.connected, false);
  const refused = await post(other, '/api/linkedin/test-message', { founder: 'nick', text: 'Test' });
  assert.deepEqual([refused.statusCode, refused.json().error.code], [409, 'linkedin_rejected']);
  assert.match(refused.json().error.message, /Kontakte 1\. Grades/);
  assert.equal(chats().length, 1, 'nichts gesendet');

  // Simulation: sendet nichts.
  const mock = app();
  await mock.inject({ method: 'PUT', url: '/api/linkedin/test-profile', payload: { founder: 'nick', profile: 'kollege' } });
  const simulated = await post(mock, '/api/linkedin/test-message', { founder: 'nick', text: 'Test' });
  assert.equal(simulated.json().message, 'Test – an Test-Kontakt wurde nichts gesendet.');
});

test('Test-LinkedIn-Account: Test-Vernetzungsanfrage nur an Nicht-Kontakte, genau eine, auch ohne LINKEDIN_ACTIONS', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const invites = () => unipile.requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/users/invite');

  // Noch kein Kontakt: Anfrage geht raus (mit Notiz), zweite innerhalb einer Minute nicht.
  const server = app({ ...LIVE, LINKEDIN_ACTIONS: 'off', UNIPILE_DSN: unipile.baseUrl });
  const none = await post(server, '/api/linkedin/test-connect', { founder: 'nick' });
  assert.deepEqual([none.statusCode, none.json().error.code], [409, 'linkedin_rejected'], 'ohne Test-Account nichts');
  await server.inject({ method: 'PUT', url: '/api/linkedin/test-profile', payload: { founder: 'nick', profile: 'ACoTEST5' } });
  const sent = await post(server, '/api/linkedin/test-connect', { founder: 'nick', message: 'Test' });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.match(sent.json().message, /^Test-Vernetzungsanfrage an Vorname5 Nachname5 gesendet/);
  assert.equal(invites().length, 1);
  assert.deepEqual(invites()[0].body, { provider_id: 'ACoTEST5', account_id: 'acc_nick', message: 'Test' });
  const again = await post(server, '/api/linkedin/test-connect', { founder: 'nick' });
  assert.deepEqual([again.statusCode, again.json().error.code], [429, 'linkedin_limit']);

  // Schon Kontakt 1. Grades: keine Anfrage.
  const other = app({ ...LIVE, LINKEDIN_ACTIONS: 'off', UNIPILE_DSN: unipile.baseUrl });
  await other.inject({ method: 'PUT', url: '/api/linkedin/test-profile', payload: { founder: 'nick', profile: 'ACoTEST100' } });
  const refused = await post(other, '/api/linkedin/test-connect', { founder: 'nick' });
  assert.deepEqual([refused.statusCode, refused.json().error.code], [409, 'linkedin_rejected']);
  assert.match(refused.json().error.message, /schon ein Kontakt/);
  assert.equal(invites().length, 1, 'nichts gesendet');

  // Simulation: sendet nichts.
  const mock = app();
  await mock.inject({ method: 'PUT', url: '/api/linkedin/test-profile', payload: { founder: 'nick', profile: 'kollege' } });
  assert.equal((await post(mock, '/api/linkedin/test-connect', { founder: 'nick' })).json().message, 'Test – an Test-Kontakt wurde keine Anfrage gesendet.');
});

test('Such-Account: UNIPILE_ACCOUNT_ID bestimmt, welcher Account in der Liste „sucht“', async () => {
  const list = (await accounts(app({ UNIPILE_ACCOUNT_ID: 'mock-johannes' }))).json() as LinkedInAccountsResponse;
  assert.deepEqual(
    list.accounts.map((account) => [account.id, account.searching]),
    [
      ['mock-scraper', false],
      ['mock-nick', false],
      ['mock-johannes', true],
    ],
  );
});

test('Von Hand senden (LINKEDIN_ACTIONS aus): Abgleich erkennt angenommene Anfragen trotzdem – sendet nichts', async (t) => {
  // Nicks Account muss bei Unipile verbunden sein – sonst pausiert sein Stapel (17.10.).
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const server = app({ ...LIVE, LINKEDIN_ACTIONS: 'off', UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(3)]);
  // Auf LinkedIn selbst gesendet, im Cockpit eingetragen.
  const entered = await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'invite_sent' } });
  assert.equal(entered.statusCode, 200, entered.body);
  assert.equal((await status(server)).watching, true);

  unipile.linkedin.relations = [{ member_id: 'ACoTEST3', public_identifier: 'person-3', created_at: Date.now() }];
  const synced = await sync(server);
  assert.deepEqual(synced.accepted, [lead.id]);
  const current = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(current.lead.stage, 'connected');
  assert.equal(unipile.requests.filter((request) => request.method === 'POST').length, 0, 'nichts gesendet');

  // Ohne Unipile-Zugang: kein Abgleich, ehrlicher Hinweis.
  const bare = app({ ...LIVE, LINKEDIN_ACTIONS: 'off', UNIPILE_API_KEY: '' });
  assert.equal((await status(bare)).watching, false);
  assert.match((await sync(bare)).problems[0], /Unipile ist nicht eingerichtet/);
});
