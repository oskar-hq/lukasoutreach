import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_OPEN_ROUTES, type AuthResponse, type InviteInfo } from '../../shared/auth.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { AccountStore } from '../src/auth/accounts.js';
import { INVITE_VALID_MS, InviteStore, RESET_VALID_MS, inviteLink } from '../src/auth/invites.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { tempDataDir } from './helpers.js';

function setup() {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: dataDir, AUTH_COOKIE_SECURE: 'false' });
  const app = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: true });
  return { app, invites: new InviteStore(db), accounts: new AccountStore(db) };
}

type App = ReturnType<typeof setup>['app'];

const post = (app: App, url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload, headers });
const check = (app: App, token: string) => post(app, '/api/auth/invite/check', { token });
const accept = (app: App, token: string, password = 'ein-langes-passwort', extra: object = {}) =>
  post(app, '/api/auth/invite/accept', { token, password, ...extra });

const ERIKA = { username: 'erika', name: 'Erika', role: 'founder' as const, founder: 'nick' as const, reset: false };

test('Einladungs-Routen sind ohne Sitzung erreichbar', () => {
  assert.ok(AUTH_OPEN_ROUTES.includes('/api/auth/invite/check'));
  assert.ok(AUTH_OPEN_ROUTES.includes('/api/auth/invite/accept'));
});

test('Link: Form, nur Hash gespeichert', () => {
  const { invites } = setup();
  const { token } = invites.create(ERIKA);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(inviteLink('https://crm.example.de', token), `https://crm.example.de/einladung#${token}`);
});

test('check verändert nichts; unbekannt, abgelaufen und benutzt → gleiche 404', async () => {
  const { app, invites } = setup();
  const now = Date.now();
  const { token, expiresAt } = invites.create(ERIKA, now);
  assert.equal(expiresAt, now + INVITE_VALID_MS);

  for (let i = 0; i < 2; i++) {
    const response = await check(app, token);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { username: 'erika', name: 'Erika', founder: 'nick', role: 'founder', expiresAt, accountExists: false } satisfies InviteInfo);
  }

  const expired = invites.create({ ...ERIKA, username: 'alt' }, now - INVITE_VALID_MS - 1000).token;
  const unknown = 'A'.repeat(43);
  const bodies = [];
  for (const candidate of [expired, unknown, 'kaputt']) {
    const response = await check(app, candidate);
    assert.equal(response.statusCode, 404, candidate);
    bodies.push(response.body);
  }
  assert.equal(new Set(bodies).size, 1, 'immer dieselbe Antwort');
  assert.equal(JSON.parse(bodies[0]).error.code, 'invite_invalid');

  assert.equal((await post(app, '/api/auth/invite/check', {})).statusCode, 400);
  assert.equal((await post(app, '/api/auth/invite/check', { token: 5 })).json().error.code, 'invalid_request');
});

test('accept: neues Konto, angemeldet, Link danach verbraucht, normaler Login klappt', async () => {
  const { app, invites, accounts } = setup();
  const { token } = invites.create(ERIKA);

  const weak = await accept(app, token, 'kurz');
  assert.equal(weak.statusCode, 400);
  assert.equal(weak.json().error.code, 'weak_password');
  assert.equal((await accept(app, token, 'x'.repeat(201))).json().error.code, 'weak_password');
  assert.equal((await check(app, token)).statusCode, 200, 'zu kurzes Passwort verbraucht den Link nicht');

  const ok = await accept(app, token, 'ein-langes-passwort', { remember: true });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { user: { username: 'erika', name: 'Erika', founder: 'nick', role: 'founder', onboarding: 'intro', founderNames: { nick: 'Erika' } } } satisfies AuthResponse);
  assert.match(String(ok.headers['set-cookie']), /cockpit_session=.+Max-Age=2592000/);
  const cookie = String(ok.headers['set-cookie']).split(';')[0];
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode, 200);
  assert.ok(accounts.exists('erika'));

  assert.equal((await accept(app, token)).statusCode, 404, 'nur einmal benutzbar');
  assert.equal((await check(app, token)).statusCode, 404);
  const login = await post(app, '/api/auth/login', { username: 'erika', password: 'ein-langes-passwort' });
  assert.equal(login.statusCode, 200);
});

test('accept: Reihenfolge – fehlende Angaben 400 vor allem anderen, ungültiger Link 404 vor Passwortlänge', async () => {
  const { app } = setup();
  const missing = await post(app, '/api/auth/invite/accept', { token: 'A'.repeat(43) });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.message, 'Bitte gib ein Passwort ein.');
  assert.equal((await post(app, '/api/auth/invite/accept', { password: 'ein-langes-passwort' })).statusCode, 400);
  const invalid = await accept(app, 'A'.repeat(43), 'kurz');
  assert.equal(invalid.statusCode, 404, 'ungültiger Link schlägt die Passwortprüfung');
});

test('Passwort vergessen (--reset): ersetzt nur das Passwort, beendet alle Sitzungen, kürzer gültig', async () => {
  const { app, invites, accounts } = setup();
  await accounts.save({ username: 'nick', name: 'Nick S.', founder: 'nick', role: 'founder' }, 'altes-passwort-123');
  const old = await post(app, '/api/auth/login', { username: 'nick', password: 'altes-passwort-123' });
  const oldCookie = String(old.headers['set-cookie']).split(';')[0];

  const now = Date.now();
  const { token, expiresAt } = invites.create({ username: 'nick', name: 'egal', role: 'founder', founder: 'johannes', reset: true }, now);
  assert.equal(expiresAt, now + RESET_VALID_MS);
  const info = (await check(app, token)).json() as InviteInfo;
  assert.equal(info.accountExists, true);
  assert.equal(info.name, 'Nick S.', 'Name und Gründer des bestehenden Kontos');
  assert.equal(info.founder, 'nick');

  const ok = await accept(app, token, 'neues-passwort-456');
  assert.equal(ok.statusCode, 200);
  assert.deepEqual((ok.json() as AuthResponse).user, { username: 'nick', name: 'Nick S.', founder: 'nick', role: 'founder', founderNames: { nick: 'Nick S.' } });
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: oldCookie } })).statusCode, 401, 'alte Sitzung beendet');
  assert.equal((await post(app, '/api/auth/login', { username: 'nick', password: 'altes-passwort-123' })).statusCode, 401);
  assert.equal((await post(app, '/api/auth/login', { username: 'nick', password: 'neues-passwort-456' })).statusCode, 200);
});

test('neuer Link und Widerruf machen offene Links desselben Namens ungültig', async () => {
  const { app, invites } = setup();
  const first = invites.create(ERIKA).token;
  const other = invites.create({ ...ERIKA, username: 'max' }).token;
  const second = invites.create(ERIKA).token;
  assert.equal((await check(app, first)).statusCode, 404);
  assert.equal((await check(app, second)).statusCode, 200);
  assert.equal(invites.revoke('erika'), 1);
  assert.equal((await check(app, second)).statusCode, 404);
  assert.equal((await check(app, other)).statusCode, 200, 'andere Namen bleiben');
});

test('zwei gleichzeitige accept: genau eins 200, das andere 404', async () => {
  const { app, invites } = setup();
  const { token } = invites.create(ERIKA);
  const results = await Promise.all([accept(app, token, 'passwort-eins-123'), accept(app, token, 'passwort-zwei-456')]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 404]);
});

test('Begrenzung: 10 ungültige Links je IP → 429, getrennt vom Login', async () => {
  const { app, invites } = setup();
  const valid = invites.create(ERIKA).token;
  for (let i = 0; i < 5; i++) assert.equal((await check(app, 'B'.repeat(43))).statusCode, 404);
  for (let i = 0; i < 5; i++) assert.equal((await accept(app, 'C'.repeat(43))).statusCode, 404);
  const blocked = await check(app, valid);
  assert.equal(blocked.statusCode, 429, 'auch ein gültiger Link wird während der Sperre nicht geprüft');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await accept(app, valid)).statusCode, 429);
  // Login hat eigene Zähler
  assert.equal((await post(app, '/api/auth/login', { username: 'x', password: 'y' })).statusCode, 401);
});
