import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AccountInfo, AccountListResponse, AuthResponse, SetupInfo } from '../../shared/auth.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CreateLeadsResponse } from '../../shared/leads.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { AccountStore } from '../src/auth/accounts.js';
import { SETUP_TOKEN_FILE } from '../src/auth/setupToken.js';
import { loadConfig } from '../src/config.js';
import { DATABASE_FILE, migrate, openDatabase } from '../src/db/database.js';
import { tempDataDir } from './helpers.js';

/** Registrierung, Freigabe und Einarbeitung (Vertrag shared/auth.ts → „Registrierung und Einarbeitung“). */

/** Fester Einrichtungs-Schlüssel (SETUP_TOKEN) – `register` schickt ihn immer mit, ab dem zweiten Konto ohne Wirkung. */
const SETUP = 'test-einrichtung-schluessel';

function onboardingApp({ demo = false, dataDir = tempDataDir(), setupToken = SETUP as string | null, logger = false as boolean | object } = {}) {
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'mock',
    DATA_DIR: dataDir,
    AUTH_DEMO_ACCOUNTS: demo ? 'true' : 'false',
    AUTH_COOKIE_SECURE: 'false',
    MOCK_SPEED: '0',
    ...(setupToken ? { SETUP_TOKEN: setupToken } : {}),
  });
  return buildApp({ config, adapter: new MockAdapter(0), logger, requireSession: true });
}

type App = ReturnType<typeof onboardingApp>;

const PASSWORD = 'ein-sicheres-passwort';

const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];

const req = (app: App, cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const errorOf = (response: { statusCode: number; json: () => { error: { code: string } } }) => [response.statusCode, response.json().error.code];

async function register(app: App, username: string, name: string, ip = '10.0.0.1', setupToken: string | null = SETUP) {
  const payload = { username, name, password: PASSWORD, ...(setupToken === null ? {} : { setupToken }) };
  return app.inject({ method: 'POST', url: '/api/auth/register', payload, remoteAddress: ip });
}

async function setup(app: App): Promise<SetupInfo> {
  return (await app.inject({ method: 'GET', url: '/api/auth/setup' })).json() as SetupInfo;
}

const card = (i: number): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: `ACoONB${i}`,
  publicIdentifier: `onboarding-${i}`,
  profileUrl: `https://www.linkedin.com/in/onboarding-${i}`,
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
});

test('Erstes Konto: wird Gründer mit Einrichtung, danach keine Gründer-Registrierung mehr', async () => {
  const app = onboardingApp();
  assert.deepEqual(await setup(app), { firstAccount: true });

  const first = await register(app, ' Oskar ', 'Oskar');
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { user: { username: 'oskar', name: 'Oskar', founder: 'nick', role: 'founder', onboarding: 'setup', founderNames: { nick: 'Oskar' } } } satisfies AuthResponse);
  const cookie = cookieOf(first);
  assert.deepEqual(await setup(app), { firstAccount: false });

  // Sitzung gilt sofort für geschützte Routen.
  assert.equal((await req(app, cookie, 'GET', '/api/settings')).statusCode, 200);

  const done = await req(app, cookie, 'POST', '/api/auth/onboarding/done');
  assert.deepEqual(done.json(), { user: { username: 'oskar', name: 'Oskar', founder: 'nick', role: 'founder', founderNames: { nick: 'Oskar' } } });
  assert.deepEqual((await req(app, cookie, 'GET', '/api/auth/me')).json(), done.json());
  await app.close();
});

test('Weitere Registrierung wartet auf Freigabe: nur /api/auth/*, Anmeldung klappt', async () => {
  const app = onboardingApp();
  const founder = cookieOf(await register(app, 'oskar', 'Oskar'));

  const second = await register(app, 'anna', 'Anna');
  assert.deepEqual(second.json(), { user: { username: 'anna', name: 'Anna', founder: null, role: 'assistant', awaitingApproval: true, founderNames: { nick: 'Oskar' } } });
  const anna = cookieOf(second);
  assert.equal((await req(app, anna, 'GET', '/api/auth/me')).json().user.awaitingApproval, true);
  assert.deepEqual(errorOf(await req(app, anna, 'GET', '/api/leads')), [403, 'awaiting_approval']);
  assert.deepEqual(errorOf(await req(app, anna, 'GET', '/api/tasks')), [403, 'awaiting_approval']);
  assert.deepEqual(errorOf(await req(app, anna, 'POST', '/api/auth/onboarding/done')), [403, 'awaiting_approval']);

  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'anna', password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  assert.equal((login.json() as AuthResponse).user.awaitingApproval, true);

  // Gründer sieht die Registrierung zuerst in der Liste.
  const list = (await req(app, founder, 'GET', '/api/accounts')).json() as AccountListResponse;
  const entry = list.accounts[0];
  assert.equal(entry.username, 'anna');
  assert.equal(entry.awaitingApproval, true);
  assert.equal(typeof entry.registeredAt, 'number');
  await app.close();
});

test('Freigabe als Mitarbeiter für beide Gründer: Sitzung gilt weiter, Stapel und Leads beider Gründer', async () => {
  const app = onboardingApp();
  const founder = cookieOf(await register(app, 'oskar', 'Oskar'));
  const anna = cookieOf(await register(app, 'anna', 'Anna'));

  const approved = await req(app, founder, 'POST', '/api/accounts/anna/approve', { role: 'assistant', founder: 'nick', founders: ['johannes', 'nick', 'johannes'] });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.deepEqual(approved.json(), {
    username: 'anna',
    name: 'Anna',
    role: 'assistant',
    founder: 'nick',
    founders: ['nick', 'johannes'],
    demo: false,
    pending: false,
    inviteExpiresAt: null,
  } satisfies AccountInfo);

  const me = (await req(app, anna, 'GET', '/api/auth/me')).json() as AuthResponse;
  assert.deepEqual(me.user, { username: 'anna', name: 'Anna', founder: 'nick', role: 'assistant', founders: ['nick', 'johannes'], onboarding: 'intro', founderNames: { nick: 'Oskar' } });

  assert.equal((await req(app, anna, 'GET', '/api/tasks?owner=johannes')).statusCode, 200);
  assert.equal((await req(app, anna, 'GET', '/api/tasks?owner=nick')).statusCode, 200);
  const created = await req(app, anna, 'POST', '/api/leads', { cards: [card(1)], owner: 'johannes' });
  assert.equal(created.statusCode, 200, created.body);
  const lead = (created.json() as CreateLeadsResponse).created[0];
  const event = await req(app, anna, 'POST', `/api/leads/${lead.id}/events`, { action: 'skipped' });
  assert.notEqual(event.statusCode, 403, event.body);

  // Zweite Freigabe derselben Registrierung: gibt es nicht mehr.
  assert.deepEqual(errorOf(await req(app, founder, 'POST', '/api/accounts/anna/approve', { role: 'assistant', founder: 'nick' })), [404, 'not_found']);
  await app.close();
});

test('Mitarbeiter mit einem Gründer: ohne founders, anderer Gründer gesperrt', async () => {
  const app = onboardingApp();
  const founder = cookieOf(await register(app, 'oskar', 'Oskar'));
  const tom = cookieOf(await register(app, 'tom', 'Tom'));
  // Gründer gibt ohne Angabe frei → Mitarbeiter arbeitet für ihn.
  const approved = await req(app, founder, 'POST', '/api/accounts/tom/approve', { role: 'assistant' });
  assert.equal(approved.statusCode, 200, approved.body);
  const me = (await req(app, tom, 'GET', '/api/auth/me')).json() as AuthResponse;
  assert.deepEqual(me.user, { username: 'tom', name: 'Tom', founder: 'nick', role: 'assistant', onboarding: 'intro', founderNames: { nick: 'Oskar' } });
  assert.deepEqual(errorOf(await req(app, tom, 'GET', '/api/tasks?owner=johannes')), [403, 'not_allowed']);
  await app.close();
});

test('Freigabe als Admin und Gründer, Prüfungen 400/403/404', async () => {
  const app = onboardingApp();
  const founder = cookieOf(await register(app, 'oskar', 'Oskar'));
  const lea = cookieOf(await register(app, 'lea', 'Lea'));
  cookieOf(await register(app, 'ben', 'Ben'));

  assert.deepEqual(errorOf(await req(app, founder, 'POST', '/api/accounts/lea/approve', { role: 'admin', founder: 'nick' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await req(app, founder, 'POST', '/api/accounts/lea/approve', { role: 'chef' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await req(app, founder, 'POST', '/api/accounts/niemand/approve', { role: 'admin', founder: null })), [404, 'not_found']);
  // Wartende Konten dürfen nichts freigeben.
  assert.deepEqual(errorOf(await req(app, lea, 'POST', '/api/accounts/ben/approve', { role: 'admin', founder: null })), [403, 'awaiting_approval']);

  assert.equal((await req(app, founder, 'POST', '/api/accounts/lea/approve', { role: 'admin', founder: null })).statusCode, 200);
  assert.deepEqual(((await req(app, lea, 'GET', '/api/auth/me')).json() as AuthResponse).user, { username: 'lea', name: 'Lea', founder: null, role: 'admin', founderNames: { nick: 'Oskar' } });

  assert.equal((await req(app, founder, 'POST', '/api/accounts/ben/approve', { role: 'founder', founder: 'johannes' })).statusCode, 200);
  const ben = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ben', password: PASSWORD } });
  assert.deepEqual((ben.json() as AuthResponse).user, { username: 'ben', name: 'Ben', founder: 'johannes', role: 'founder', onboarding: 'intro', founderNames: { nick: 'Oskar', johannes: 'Ben' } });
  await app.close();
});

test('Ablehnen löscht Registrierung und Sitzungen, Name ist danach frei', async () => {
  const app = onboardingApp();
  const founder = cookieOf(await register(app, 'oskar', 'Oskar'));
  const spam = cookieOf(await register(app, 'spam', 'Spam'));
  assert.equal((await req(app, founder, 'DELETE', '/api/accounts/spam')).statusCode, 200);
  assert.deepEqual(errorOf(await req(app, spam, 'GET', '/api/auth/me')), [401, 'unauthorized']);
  const list = (await req(app, founder, 'GET', '/api/accounts')).json() as AccountListResponse;
  assert.equal(list.accounts.some((account) => account.username === 'spam'), false);
  assert.equal((await register(app, 'spam', 'Spam', '10.0.0.2')).statusCode, 200);
  await app.close();
});

test('Registrieren: 400, 409 und Sperre je IP', async () => {
  const app = onboardingApp();
  await register(app, 'oskar', 'Oskar', '10.0.0.9');
  const bad = (payload: object) => app.inject({ method: 'POST', url: '/api/auth/register', payload, remoteAddress: '10.0.0.3' });
  assert.deepEqual(errorOf(await bad({ username: 'ä', name: 'Ä', password: PASSWORD })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await bad({ username: 'neu', name: '  ', password: PASSWORD })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await bad({ username: 'neu', name: 'Neu', password: 'kurz' })), [400, 'weak_password']);
  assert.deepEqual(errorOf(await bad({ username: 'OSKAR', name: 'Oskar', password: PASSWORD })), [409, 'account_exists']);
  await register(app, 'eins', 'Eins', '10.0.0.3');
  assert.deepEqual(errorOf(await bad({ username: 'eins', name: 'Eins', password: PASSWORD })), [409, 'account_exists']);

  // 5 Registrierungen pro Stunde und IP.
  for (let i = 2; i <= 5; i++) assert.equal((await register(app, `nutzer${i}`, 'N', '10.0.0.4')).statusCode, 200);
  assert.equal((await register(app, 'nutzer6', 'N', '10.0.0.4')).statusCode, 200);
  const blocked = await register(app, 'nutzer7', 'N', '10.0.0.4');
  assert.deepEqual(errorOf(blocked), [429, 'too_many_attempts']);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  await app.close();
});

test('Zwei gleichzeitige erste Registrierungen: genau eine wird Gründer', async () => {
  const app = onboardingApp();
  const [a, b] = await Promise.all([register(app, 'erste', 'Erste', '10.0.1.1'), register(app, 'zweite', 'Zweite', '10.0.1.2')]);
  const users = [a, b].map((response) => (response.json() as AuthResponse).user);
  assert.equal(users.filter((user) => user.role === 'founder').length, 1);
  assert.equal(users.filter((user) => user.awaitingApproval).length, 1);
  await app.close();
});

test('Erstes Konto nur mit Einrichtungs-Link: ohne/falscher Schlüssel 403, zählt in der Sperre, keine Registrierung', async () => {
  const app = onboardingApp();
  await app.ready();
  assert.deepEqual(errorOf(await register(app, 'fremd', 'Fremd', '10.0.5.1', null)), [403, 'setup_required']);
  const wrong = await register(app, 'fremd', 'Fremd', '10.0.5.1', 'falsch');
  assert.deepEqual(errorOf(wrong), [403, 'setup_required']);
  assert.match(wrong.json().error.message, /docker compose logs backend \| grep Einrichtung/);
  // Kein Konto, keine wartende Registrierung – der Weg zum Gründer bleibt dem Link vorbehalten.
  assert.deepEqual(await setup(app), { firstAccount: true });
  for (let i = 0; i < 3; i++) await register(app, `fremd${i}`, 'Fremd', '10.0.5.1', 'falsch');
  assert.deepEqual(errorOf(await register(app, 'oskar', 'Oskar', '10.0.5.1')), [429, 'too_many_attempts'], 'Raten zählt wie Registrieren');
  const first = await register(app, 'oskar', 'Oskar', '10.0.5.2');
  assert.equal((first.json() as AuthResponse).user.role, 'founder');
  await app.close();
});

test('Einrichtungs-Schlüssel ohne SETUP_TOKEN: Zufall im Datenordner (600), Link im Protokoll, nach dem ersten Konto gelöscht', async () => {
  const dataDir = tempDataDir();
  const lines: string[] = [];
  const stream = { write: (line: string) => void lines.push(line) };
  const app = onboardingApp({ dataDir, setupToken: null, logger: { level: 'warn', stream } });
  await app.ready();
  const file = path.join(dataDir, SETUP_TOKEN_FILE);
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const token = readFileSync(file, 'utf8').trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const line = lines.find((entry) => entry.includes('Einrichtung:'));
  assert.ok(line?.includes(`/registrieren#setup=${token}`), 'Link mit Schlüssel im Protokoll');
  await app.close();

  // Neustart ohne Konto: derselbe Schlüssel gilt weiter.
  const again = onboardingApp({ dataDir, setupToken: null });
  await again.ready();
  assert.equal(readFileSync(file, 'utf8').trim(), token);
  assert.deepEqual(errorOf(await register(again, 'oskar', 'Oskar', '10.0.6.1', `${token}x`)), [403, 'setup_required']);
  assert.equal((await register(again, 'oskar', 'Oskar', '10.0.6.1', token)).statusCode, 200);
  assert.equal(existsSync(file), false, 'nach dem ersten Konto gelöscht');
  // Danach: Registrierungen warten auf Freigabe, der alte Schlüssel macht niemanden zum Gründer.
  const late = await register(again, 'spaet', 'Spät', '10.0.6.2', token);
  assert.equal((late.json() as AuthResponse).user.awaitingApproval, true);
  await again.close();
});

test('Einrichtungs-Schlüssel: fallen die Konten nach dem Start auf 0, entsteht er beim nächsten Aufruf neu (mit Link im Protokoll)', async () => {
  const dataDir = tempDataDir();
  const lines: string[] = [];
  const stream = { write: (line: string) => void lines.push(line) };
  const app = onboardingApp({ dataDir, setupToken: null, logger: { level: 'warn', stream } });
  await app.ready();
  const file = path.join(dataDir, SETUP_TOKEN_FILE);
  const first = readFileSync(file, 'utf8').trim();
  assert.equal((await register(app, 'oskar', 'Oskar', '10.0.7.1', first)).statusCode, 200);
  assert.equal(existsSync(file), false);

  // Alle Konten weg (z. B. von Hand gelöscht), der Server läuft weiter.
  const db = openDatabase(dataDir);
  new AccountStore(db).remove('oskar');
  db.close();
  lines.length = 0;
  assert.deepEqual(await setup(app), { firstAccount: true });
  assert.ok(existsSync(file), 'Schlüssel neu angelegt');
  const token = readFileSync(file, 'utf8').trim();
  assert.notEqual(token, first);
  assert.ok(lines.some((entry) => entry.includes(`/registrieren#setup=${token}`)), 'Link im Protokoll');
  // Weitere Aufrufe legen keinen neuen an und schreiben nicht erneut ins Protokoll.
  lines.length = 0;
  await setup(app);
  assert.equal(readFileSync(file, 'utf8').trim(), token);
  assert.equal(lines.filter((entry) => entry.includes('Einrichtung:')).length, 0);
  const again = await register(app, 'neu', 'Neu', '10.0.7.2', token);
  assert.equal((again.json() as AuthResponse).user.role, 'founder');
  await app.close();
});

test('Einrichtungs-Schlüssel: auch die Registrierung legt ihn an, wenn die Konten nach dem Start verschwinden', async () => {
  const dataDir = tempDataDir();
  const app = onboardingApp({ dataDir, setupToken: null });
  await app.ready();
  const file = path.join(dataDir, SETUP_TOKEN_FILE);
  assert.equal((await register(app, 'oskar', 'Oskar', '10.0.8.1', readFileSync(file, 'utf8').trim())).statusCode, 200);
  const db = openDatabase(dataDir);
  new AccountStore(db).remove('oskar');
  db.close();
  assert.deepEqual(errorOf(await register(app, 'fremd', 'Fremd', '10.0.8.2', null)), [403, 'setup_required']);
  assert.ok(existsSync(file), 'Link steht jetzt im Protokoll');
  assert.equal((await register(app, 'neu', 'Neu', '10.0.8.3', readFileSync(file, 'utf8').trim())).statusCode, 200);
  await app.close();
});

test('Mit Testkonten nie Gründer-Registrierung', async () => {
  const app = onboardingApp({ demo: true });
  await app.ready();
  assert.deepEqual(await setup(app), { firstAccount: false });
  const response = await register(app, 'neu', 'Neu');
  assert.equal((response.json() as AuthResponse).user.awaitingApproval, true);
  // Testkonto-Namen sind vergeben.
  assert.deepEqual(errorOf(await register(app, 'nick', 'Nick', '10.0.2.1')), [409, 'account_exists']);
  await app.close();
});

test('Einladung für mehrere Gründer: Liste und neues Konto mit founders', async () => {
  const app = onboardingApp();
  const founder = cookieOf(await register(app, 'oskar', 'Oskar'));
  const invite = await req(app, founder, 'POST', '/api/accounts/invite', { username: 'mia', name: 'Mia', role: 'assistant', founder: 'johannes', founders: ['nick'] });
  assert.equal(invite.statusCode, 200, invite.body);
  const list = (await req(app, founder, 'GET', '/api/accounts')).json() as AccountListResponse;
  assert.deepEqual(list.accounts.find((account) => account.username === 'mia')?.founders, ['johannes', 'nick']);
  const accepted = await app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token: invite.json().token, password: PASSWORD } });
  assert.deepEqual((accepted.json() as AuthResponse).user, {
    username: 'mia',
    name: 'Mia',
    founder: 'johannes',
    role: 'assistant',
    founders: ['johannes', 'nick'],
    onboarding: 'intro',
    founderNames: { nick: 'Oskar' },
  });
  // Registrieren mit dem Namen einer offenen Einladung geht nicht.
  await req(app, founder, 'POST', '/api/accounts/invite', { username: 'offen', name: 'Offen', role: 'admin', founder: null });
  assert.deepEqual(errorOf(await register(app, 'offen', 'Offen', '10.0.3.1')), [409, 'account_exists']);
  await app.close();
});

test('Migration (Stand 18 → 19): bestehende Konten ohne offene Einführung, Mitarbeiter mit einem Gründer', () => {
  const dataDir = tempDataDir();
  const old = new DatabaseSync(path.join(dataDir, DATABASE_FILE));
  migrate(old, 18);
  old.prepare("INSERT INTO users (username, name, role, founder, password_hash, created_at, updated_at) VALUES ('nick', 'Nick', 'founder', 'nick', 'h', 1, 1)").run();
  old.prepare("INSERT INTO users (username, name, role, founder, password_hash, created_at, updated_at) VALUES ('anna', 'Anna', 'assistant', 'nick', 'h', 1, 1)").run();
  old.close();
  const db = openDatabase(dataDir);
  const accounts = new AccountStore(db);
  assert.deepEqual(accounts.list(), [
    { username: 'nick', name: 'Nick', founder: 'nick', role: 'founder' },
    { username: 'anna', name: 'Anna', founder: 'nick', role: 'assistant' },
  ]);
  assert.equal(accounts.registrationCount(), 0);
  db.close();
});

test('Einrichtungs-Schlüssel: zu kurzer SETUP_TOKEN wird ignoriert (Warnung), ohne Konto gilt der Zufallsschlüssel', async () => {
  const dataDir = tempDataDir();
  const lines: string[] = [];
  const stream = { write: (line: string) => void lines.push(line) };
  const app = onboardingApp({ dataDir, setupToken: 'kurz', logger: { level: 'warn', stream } });
  await app.ready();
  assert.ok(lines.some((entry) => entry.includes('SETUP_TOKEN ist kürzer als 24 Zeichen')), 'Warnung beim Start');
  assert.ok(!lines.some((entry) => entry.includes('"kurz"') || entry.includes(' kurz ')), 'Wert nicht im Protokoll');
  const file = path.join(dataDir, SETUP_TOKEN_FILE);
  const token = readFileSync(file, 'utf8').trim();
  assert.deepEqual(errorOf(await register(app, 'oskar', 'Oskar', '10.0.8.1', 'kurz')), [403, 'setup_required']);
  assert.equal(((await register(app, 'oskar', 'Oskar', '10.0.8.1', token)).json() as AuthResponse).user.role, 'founder');
  await app.close();

  // Bestehender Server mit Konten und kurzem Wert (z. B. nach dem Auto-Update): startet trotzdem, nur Warnung.
  lines.length = 0;
  const again = onboardingApp({ dataDir, setupToken: 'kurz', logger: { level: 'warn', stream } });
  await again.ready();
  assert.ok(lines.some((entry) => entry.includes('SETUP_TOKEN ist kürzer')));
  assert.equal(existsSync(file), false);
  await again.close();
});
