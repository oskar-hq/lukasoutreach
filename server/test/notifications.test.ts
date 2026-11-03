import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthResponse, CreateInviteResponse } from '../../shared/auth.js';
import { DEFAULT_SEARCH_PROFILE, type SearchProfile } from '../../shared/leadSearch.js';
import type { NotificationListResponse } from '../../shared/notifications.js';
import { createLiveAdapter } from '../src/adapters/live/liveAdapter.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { NOTICES, NotificationCenter } from '../src/notify/notifications.js';
import { AdapterError, type RunContext, type SearchOptions } from '../src/pipeline/adapter.js';
import { startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

/** Neuigkeiten vom Programm (Vertrag shared/notifications.ts) und Gründernamen aus den Konten (`AuthUser.founderNames`). */

const PASSWORD = 'ein-sicheres-passwort';
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/geheim123';
/** Einrichtungs-Schlüssel für das erste Konto (SETUP_TOKEN). */
const SETUP = 'test-einrichtung-schluessel-1234';

/** Suche scheitert immer mit einem fatalen Zugangsfehler – wie ein abgelehnter Unipile-Schlüssel. */
class RejectedKeyAdapter extends MockAdapter {
  override async search(_profile: SearchProfile, _options: SearchOptions, _ctx: RunContext): Promise<never> {
    throw new AdapterError('auth', 'Zugang abgelehnt', 'Unipile hat den API-Schlüssel nicht angenommen. Prüf ihn unter Einstellungen → LinkedIn (Unipile).', true);
  }
}

function app({ demo = true, adapter = new MockAdapter(0), env = {} as NodeJS.ProcessEnv } = {}) {
  const calls: string[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)).text);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'mock',
    DATA_DIR: tempDataDir(),
    AUTH_DEMO_ACCOUNTS: demo ? 'true' : 'false',
    AUTH_COOKIE_SECURE: 'false',
    MOCK_SPEED: '0',
    SETUP_TOKEN: SETUP,
    ...env,
  });
  return { app: buildApp({ config, adapter, logger: false, requireSession: true, slackTest: { fetch: fakeFetch } }), calls };
}

type App = ReturnType<typeof app>['app'];

const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];

async function login(app: App, username: string, password = 'demo'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(response.statusCode, 200, response.body);
  return cookieOf(response);
}

const req = (app: App, cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function list(app: App, cookie: string): Promise<NotificationListResponse> {
  const response = await req(app, cookie, 'GET', '/api/notifications');
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as NotificationListResponse;
}

test('Neuigkeiten: Registrierung sehen nur Gründer und Admins, Freigabe räumt sie weg', async () => {
  const { app: server } = app();
  await server.ready();
  const register = await server.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'lena', name: 'Lena Berg', password: PASSWORD } });
  assert.equal(register.statusCode, 200, register.body);

  const nick = await login(server, 'nick');
  const founderView = await list(server, nick);
  const registration = founderView.notifications.find((item) => item.kind === 'registration');
  assert.ok(registration, 'Gründer sieht die Registrierung');
  assert.equal(registration.title, 'Lena Berg hat sich registriert');
  assert.deepEqual(registration.target, { view: 'accounts' });
  assert.equal(registration.unread, true);
  assert.ok((await list(server, await login(server, 'admin'))).notifications.some((item) => item.kind === 'registration'));

  const anna = await login(server, 'mitarbeiter');
  assert.ok(!(await list(server, anna)).notifications.some((item) => item.kind === 'registration'), 'Mitarbeiter sieht keine Registrierungen');

  // Freigeben → Meldung verschwindet beim nächsten Abruf.
  const approve = await req(server, nick, 'POST', '/api/accounts/lena/approve', { role: 'assistant', founder: 'nick' });
  assert.equal(approve.statusCode, 200, approve.body);
  assert.ok(!(await list(server, nick)).notifications.some((item) => item.kind === 'registration'));
  await server.close();
});

test('Neuigkeiten: Beispiele der Simulation, gesehen gilt je Konto', async () => {
  const { app: server } = app();
  await server.ready();
  const nick = await login(server, 'nick');
  const johannes = await login(server, 'johannes');
  // Die Simulation bringt zwei Beispiel-Meldungen mit.
  const first = await list(server, nick);
  assert.equal(first.unread, 2);
  assert.deepEqual(first.notifications.map((item) => item.kind), ['search_failed', 'backup_failed']);

  const seen = await req(server, nick, 'POST', '/api/notifications/seen');
  assert.equal(seen.statusCode, 200);
  assert.equal((seen.json() as NotificationListResponse).unread, 0);
  assert.equal((await list(server, johannes)).unread, 2, 'Johannes hat noch nichts gesehen');
  assert.equal((await list(server, nick)).unread, 0, 'bleibt gesehen');
  await server.close();
});

test('Neuigkeiten: NotificationCenter fasst zusammen, filtert Mitarbeiter nach Gründer und schickt Slack gedrosselt', () => {
  const db = openDatabase(tempDataDir());
  let now = 1_000_000;
  const slack: string[] = [];
  const log = { info() {}, warn() {}, error() {} } as unknown as import('fastify').FastifyBaseLogger;
  const center = new NotificationCenter({ db, log, slack: (item) => slack.push(item.title), now: () => now });
  const nick = { username: 'nick', founder: 'nick' as const, role: 'founder' as const };
  const anna = { username: 'anna', founder: 'nick' as const, role: 'assistant' as const };
  const ben = { username: 'ben', founder: 'johannes' as const, role: 'assistant' as const };

  center.raise(NOTICES.linkedinPaused('nick', 'Nick', now + 3_600_000, 'LinkedIn meldet ein Limit.'));
  assert.equal(center.list(nick).unread, 1);
  assert.equal(center.list(anna).notifications.length, 1, 'Anna arbeitet für Nick');
  assert.equal(center.list(ben).notifications.length, 0, 'Ben arbeitet nur für Johannes');
  assert.deepEqual(slack, ['LinkedIn für Nick pausiert']);

  center.markSeen('nick');
  now += 60_000;
  center.raise(NOTICES.linkedinPaused('nick', 'Nick', now + 3_600_000, 'LinkedIn meldet ein Limit.'));
  const again = center.list(nick);
  assert.equal(again.notifications.length, 1, 'zusammengefasst');
  assert.equal(again.notifications[0].count, 2);
  assert.equal(again.unread, 1, 'Wiederholung ist wieder neu');
  assert.equal(slack.length, 1, 'Slack erst nach 12 Stunden wieder');
  now += 12 * 60 * 60 * 1000;
  center.raise(NOTICES.linkedinPaused('nick', 'Nick', now + 3_600_000, 'LinkedIn meldet ein Limit.'));
  assert.equal(slack.length, 2);

  // Registrierungen: nie für Mitarbeiter, `repeat: false` zählt nicht hoch.
  center.raise(NOTICES.registration('lena', 'Lena'));
  center.raise(NOTICES.registration('lena', 'Lena'));
  assert.equal(center.list(nick).notifications.find((item) => item.kind === 'registration')?.count, 1);
  assert.ok(!center.list(anna).notifications.some((item) => item.kind === 'registration'));

  // Behoben → weg; nach 14 Tagen ohne Wiederholung ebenfalls.
  center.resolve('linkedin:pause:nick');
  assert.ok(!center.list(nick).notifications.some((item) => item.kind === 'linkedin_paused'));
  now += 15 * 24 * 60 * 60 * 1000;
  assert.equal(center.list(nick).notifications.length, 0);
  db.close();
});

test('Neuigkeiten: abgebrochene automatische Suche meldet sich mit Gründername und passendem Ziel', async () => {
  const adapter = new RejectedKeyAdapter(0);
  const { app: server } = app({ adapter });
  await server.ready();
  const nick = await login(server, 'nick');
  await req(server, nick, 'POST', '/api/notifications/seen');
  // Beispiel-Meldungen der Simulation weg, damit nur der echte Fehler zählt.
  await server.inject({ method: 'POST', url: '/api/leads/demo/reset', headers: { cookie: nick } });
  const saved = await req(server, nick, 'PUT', '/api/auto-search/nick', { enabled: false, days: [1], time: '07:00', profile: { ...DEFAULT_SEARCH_PROFILE } });
  assert.equal(saved.statusCode, 200, saved.body);
  const started = await req(server, nick, 'POST', '/api/auto-search/nick/run');
  assert.equal(started.statusCode, 202, started.body);

  let failed;
  for (let i = 0; i < 100 && !failed; i++) {
    failed = (await list(server, nick)).notifications.find((item) => item.kind === 'search_failed' && item.title.startsWith('Automatische Lead-Suche für Nick'));
    if (!failed) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(failed, 'Meldung nach abgebrochenem Lauf');
  assert.equal(failed.founder, 'nick');
  assert.equal(failed.needsFounder, true);
  assert.match(failed.text, /Unipile hat den API-Schlüssel nicht angenommen/);
  assert.deepEqual(failed.target, { view: 'settings', section: 'unipile' });
  await server.close();
});

test('Gründernamen: kommen aus den Gründer-Konten, auch in Sätzen des Servers', async () => {
  const { app: server } = app({ demo: false });
  await server.ready();
  // Erstes Konto wird Gründer (Platz „nick“) – mit eigenem Namen.
  const first = await server.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'lena', name: 'Lena', password: PASSWORD, setupToken: SETUP } });
  assert.equal(first.statusCode, 200, first.body);
  const lena = cookieOf(first);
  assert.deepEqual((first.json() as AuthResponse).user.founderNames, { nick: 'Lena' });

  // Mitarbeiterin per Link – mit eigenem Namen statt des Namens aus der Einladung.
  const invite = await req(server, lena, 'POST', '/api/accounts/invite', { username: 'mara', name: 'M.', role: 'assistant', founder: 'nick' });
  assert.equal(invite.statusCode, 200, invite.body);
  const { token } = invite.json() as CreateInviteResponse;
  const tooLong = await server.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: PASSWORD, name: 'x'.repeat(61) } });
  assert.equal(tooLong.statusCode, 400);
  const accepted = await server.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: PASSWORD, name: '  Mara Stein ' } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const mara = cookieOf(accepted);
  const me = (await req(server, mara, 'GET', '/api/auth/me')).json() as AuthResponse;
  assert.equal(me.user.name, 'Mara Stein');
  assert.deepEqual(me.user.founderNames, { nick: 'Lena' });

  // Sätze des Servers mit dem Namen aus dem Konto (Platz „johannes“ ohne Konto: „Johannes“).
  const denied = await req(server, mara, 'GET', '/api/tasks?owner=johannes');
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.message, 'Als Mitarbeiter arbeitest du nur für Lena – das hier gehört Johannes.');
  await server.close();
});

test('Neuigkeiten: Registrierung geht live an Slack, ohne Webhook-Adresse im Text', async () => {
  const { app: server, calls } = app({ env: { LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key', SLACK_WEBHOOK_URL: WEBHOOK, PUBLIC_URL: 'https://crm.example.de' } });
  await server.ready();
  const register = await server.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'lena', name: 'Lena <Berg>', password: PASSWORD } });
  assert.equal(register.statusCode, 200, register.body);
  await server.close();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\*Lena &lt;Berg&gt; hat sich registriert\*/);
  assert.match(calls[0], /<https:\/\/crm\.example\.de\|Im Cockpit öffnen>/);
  assert.ok(!calls[0].includes('geheim123'));
});

test('Unipile-Prüfung: abgelaufener Testzeitraum meldet sich einmal (Glocke + Slack), verschwindet wieder', async (t) => {
  const unipile = await startFakeUnipile({ sessionDown: true });
  t.after(() => unipile.close());
  const slack: string[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    slack.push(JSON.parse(String(init?.body)).text);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    UNIPILE_DSN: unipile.baseUrl,
    UNIPILE_API_KEY: 'unipile-test-key',
    DATA_DIR: tempDataDir(),
    AUTH_DEMO_ACCOUNTS: 'true',
    AUTH_COOKIE_SECURE: 'false',
    SETUP_TOKEN: SETUP,
    SLACK_WEBHOOK_URL: WEBHOOK,
  });
  const server = buildApp({ config, adapter: createLiveAdapter(config), logger: false, requireSession: true, slackTest: { fetch: fakeFetch } });
  t.after(() => server.close());
  await server.ready();
  const accountCalls = () => unipile.requests.filter((request) => request.path === '/api/v1/accounts').length;

  const nick = await login(server, 'nick');
  assert.equal((await server.unipileWatch.check())?.state, 'unreachable');
  // Ein einzelner Aussetzer meldet noch nichts.
  assert.equal((await list(server, nick)).notifications.some((item) => item.kind === 'unipile_down'), false);
  assert.equal((await server.unipileWatch.check())?.state, 'unreachable');
  assert.equal(accountCalls(), 2, 'je Prüfung genau eine Anfrage (Account-Liste)');
  assert.equal(unipile.requests.some((request) => request.method !== 'GET'), false, 'nur lesend');
  // Gründer und Admins sehen die Meldung, Mitarbeiter nicht.
  assert.ok((await list(server, await login(server, 'admin'))).notifications.some((item) => item.kind === 'unipile_down'));
  assert.equal((await list(server, await login(server, 'mitarbeiter'))).notifications.some((item) => item.kind === 'unipile_down'), false);
  const down = (await list(server, nick)).notifications.filter((item) => item.kind === 'unipile_down');
  assert.equal(down.length, 1);
  assert.equal(down[0].count, 1, 'nicht bei jeder Prüfung neu');
  assert.match(down[0].text, /no_client_session/);
  assert.deepEqual(down[0].target, { view: 'settings', section: 'unipile' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(slack.filter((text) => text.includes('no_client_session')).length, 1, 'Slack genau einmal');

  unipile.session.down = false;
  assert.equal((await server.unipileWatch.check())?.state, 'ok');
  assert.equal((await list(server, nick)).notifications.some((item) => item.kind === 'unipile_down'), false);
});

test('Unipile-Prüfung: in der Simulation und ohne Token keine Anfrage', async () => {
  const { app: server } = app();
  await server.ready();
  assert.equal(await server.unipileWatch.check(), null);
  const noKey = app({ env: { LEAD_SEARCH_MODE: 'live' } }).app;
  await noKey.ready();
  assert.equal(await noKey.unipileWatch.check(), null);
});
