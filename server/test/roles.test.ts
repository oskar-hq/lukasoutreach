import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AccountListResponse, AuthResponse, CreateInviteResponse, InviteInfo } from '../../shared/auth.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse, LeadDetailResponse } from '../../shared/leads.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { AccountStore } from '../src/auth/accounts.js';
import { InviteStore } from '../src/auth/invites.js';
import { ROLE_MESSAGES } from '../src/auth/roles.js';
import { loadConfig } from '../src/config.js';
import { DATABASE_FILE, migrate, openDatabase } from '../src/db/database.js';
import { tempDataDir } from './helpers.js';

/** Rollen und Konten (Vertrag shared/auth.ts → „Rollen und Rechte“). Testkonten: nick, johannes, admin, mitarbeiter. */

function roleApp(dataDir = tempDataDir()) {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: dataDir, AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false', MOCK_SPEED: '0' });
  return buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: true });
}

type App = ReturnType<typeof roleApp>;

async function login(app: App, username: string, password = 'demo'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(response.statusCode, 200, `${username}: ${response.body}`);
  return String(response.headers['set-cookie']).split(';')[0];
}

const req = (app: App, cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const card = (i: number): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: `ACoROLE${i}`,
  publicIdentifier: `rolle-${i}`,
  profileUrl: `https://www.linkedin.com/in/rolle-${i}`,
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

async function createLead(app: App, cookie: string, i: number, owner: 'nick' | 'johannes'): Promise<CockpitLead> {
  const response = await req(app, cookie, 'POST', '/api/leads', { cards: [card(i)], owner });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as CreateLeadsResponse).created[0];
}

const errorOf = (response: { statusCode: number; json: () => { error: { code: string; message: string } } }) => [response.statusCode, response.json().error.code];

// ── Anmeldung ───────────────────────────────────────────────────────────────

test('Testkonten: Rolle und Gründer bei Login und me', async () => {
  const app = roleApp();
  const expected = {
    nick: { username: 'nick', name: 'Nick', founder: 'nick', role: 'founder' },
    johannes: { username: 'johannes', name: 'Johannes', founder: 'johannes', role: 'founder' },
    admin: { username: 'admin', name: 'Admin', founder: null, role: 'admin' },
    mitarbeiter: { username: 'mitarbeiter', name: 'Anna', founder: 'nick', role: 'assistant' },
  } as const;
  for (const [username, user] of Object.entries(expected)) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'demo' } });
    // Jede Antwort von /api/auth/* trägt die Namen der Gründer (aus den Testkonten).
    const withNames = { ...user, founderNames: { nick: 'Nick', johannes: 'Johannes' } };
    assert.deepEqual(response.json(), { user: withNames } satisfies AuthResponse);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    assert.deepEqual((await req(app, cookie, 'GET', '/api/auth/me')).json(), { user: withNames });
  }
});

// ── Migration ───────────────────────────────────────────────────────────────

test('Migration: alte Datenbank (Stand 10) → Rollen, founder nullable, actor; idempotent', () => {
  const dataDir = tempDataDir();
  const old = new DatabaseSync(path.join(dataDir, DATABASE_FILE));
  migrate(old, 10);
  old.prepare("INSERT INTO users (username, name, founder, password_hash, created_at, updated_at) VALUES ('nick', 'Nick', 'nick', 'hash', 1, 2)").run();
  old.prepare("INSERT INTO invitations (id_hash, username, name, founder, reset, created_at, expires_at) VALUES ('h', 'erika', 'Erika', 'johannes', 0, 1, 9999999999999)").run();
  old
    .prepare(
      `INSERT INTO leads (id, provider_id, owner, stage, search_text, person, company, origin, created_at, updated_at, last_activity_at)
       VALUES ('l1', 'p1', 'nick', 'new', '', '{}', '{}', '{"kind":"tracking","sheet":null,"setter":null}', 1, 1, 1)`,
    )
    .run();
  old.prepare("INSERT INTO lead_events (id, lead_id, kind, at, by, title) VALUES ('e1', 'l1', 'created', 1, 'nick', 'Alt')").run();
  old.close();

  for (let round = 0; round < 2; round++) {
    const db = openDatabase(dataDir);
    // Mindestens Stand 12 (Rollen) – spätere Migrationen kommen obendrauf.
    assert.ok((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 12);
    const accounts = new AccountStore(db);
    assert.deepEqual(accounts.list(), [{ username: 'nick', name: 'Nick', founder: 'nick', role: 'founder' }]);
    assert.equal(accounts.findStored('nick')?.passwordHash, 'hash');
    const invite = new InviteStore(db).unused()[0];
    assert.deepEqual([invite.username, invite.role, invite.founder], ['erika', 'founder', 'johannes']);
    assert.deepEqual({ ...db.prepare('SELECT by, actor FROM lead_events').get() }, { by: 'nick', actor: null });
    if (round === 0) {
      // Admin ohne Gründer geht jetzt; die Datenbank selbst lehnt unpassende Paare ab.
      accounts.saveHash({ username: 'oskar', name: 'Oskar', founder: null, role: 'admin' }, 'hash');
      assert.throws(() => db.prepare("INSERT INTO users (username, name, role, founder, password_hash, created_at, updated_at) VALUES ('x', 'X', 'admin', 'nick', 'h', 1, 1)").run());
      assert.throws(() => db.prepare("INSERT INTO users (username, name, role, founder, password_hash, created_at, updated_at) VALUES ('y', 'Y', 'assistant', NULL, 'h', 1, 1)").run());
      assert.throws(() => accounts.saveHash({ username: 'z', name: 'Z', founder: 'nick', role: 'admin' }, 'hash'), /keinem Gründer/);
      db.prepare("DELETE FROM users WHERE username = 'oskar'").run();
    }
    db.close();
  }
});

// ── /api/accounts ───────────────────────────────────────────────────────────

test('Konten sehen: Admin und Gründer alle (+ offene Einladungen), Mitarbeiter 403', async () => {
  const app = roleApp();
  const admin = await login(app, 'admin');
  const nick = await login(app, 'nick');
  const anna = await login(app, 'mitarbeiter');

  const invited = await req(app, nick, 'POST', '/api/accounts/invite', { username: 'Bernd ', name: 'Bernd', role: 'assistant' });
  assert.equal(invited.statusCode, 200, invited.body);
  const { token, username, expiresAt } = invited.json() as CreateInviteResponse;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(username, 'bernd');

  const all = (await req(app, admin, 'GET', '/api/accounts')).json() as AccountListResponse;
  assert.deepEqual(
    all.accounts.map((a) => [a.username, a.role, a.founder, a.demo, a.pending]),
    [
      ['admin', 'admin', null, true, false],
      ['johannes', 'founder', 'johannes', true, false],
      ['nick', 'founder', 'nick', true, false],
      ['bernd', 'assistant', 'nick', false, true],
      ['mitarbeiter', 'assistant', 'nick', true, false],
    ],
  );
  assert.equal(all.accounts.find((a) => a.username === 'bernd')!.inviteExpiresAt, expiresAt);

  // Gründer sehen alle Konten wie ein Admin
  const own = (await req(app, nick, 'GET', '/api/accounts')).json() as AccountListResponse;
  assert.deepEqual(own, all);
  const johannes = (await req(app, await login(app, 'johannes'), 'GET', '/api/accounts')).json() as AccountListResponse;
  assert.deepEqual(johannes, all);

  const denied = await req(app, anna, 'GET', '/api/accounts');
  assert.deepEqual(errorOf(denied), [403, 'not_allowed']);
  assert.equal(denied.json().error.message, ROLE_MESSAGES.accounts);
  assert.deepEqual(errorOf(await req(app, anna, 'POST', '/api/accounts/invite', { username: 'x1', name: 'X', role: 'assistant' })), [403, 'not_allowed']);
  assert.deepEqual(errorOf(await req(app, anna, 'DELETE', '/api/accounts/nick')), [403, 'not_allowed']);
  assert.equal((await app.inject({ method: 'GET', url: '/api/accounts' })).statusCode, 401);
});

test('Einladen: Gründer jede Rolle, Admin keine Gründer; Prüfungen 400/403/409', async () => {
  const app = roleApp();
  const admin = await login(app, 'admin');
  const nick = await login(app, 'nick');
  const invite = (cookie: string, body: object) => req(app, cookie, 'POST', '/api/accounts/invite', body);

  // Admin
  assert.equal((await invite(admin, { username: 'oskar', name: 'Oskar', role: 'admin' })).statusCode, 200);
  assert.equal((await invite(admin, { username: 'oskar2', name: 'Oskar', role: 'admin', founder: null })).statusCode, 200);
  // Gründer-Konten legen nur Gründer an (Sicherheitsprüfung 08.10.).
  const founderByAdmin = await invite(admin, { username: 'gruender', name: 'Neu', role: 'founder', founder: 'johannes' });
  assert.deepEqual(errorOf(founderByAdmin), [403, 'not_allowed']);
  assert.match(founderByAdmin.json().error.message, /nur Gründer/);
  assert.equal((await invite(admin, { username: 'hilfe', name: 'Hilfe', role: 'assistant', founder: 'johannes' })).statusCode, 200);
  assert.deepEqual(errorOf(await invite(admin, { username: 'ohne', name: 'Ohne', role: 'founder' })), [403, 'not_allowed']);
  assert.deepEqual(errorOf(await invite(admin, { username: 'ohne', name: 'Ohne', role: 'admin', founder: 'nick' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await invite(admin, { username: 'ohne', name: 'Ohne' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await invite(admin, { username: 'ohne', name: '   ', role: 'admin' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await invite(admin, { username: 'ohne', name: 'x'.repeat(61), role: 'admin' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await invite(admin, { username: 'ä', name: 'Ä', role: 'admin' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await invite(admin, { username: 'ohne', name: 'Ohne', role: 'chef' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await invite(admin, { name: 'Ohne', role: 'admin' })), [400, 'invalid_request']);
  // Vergeben: Testkonto oder echtes Konto
  assert.deepEqual(errorOf(await invite(admin, { username: 'nick', name: 'Nick', role: 'assistant', founder: 'nick' })), [409, 'account_exists']);

  // Gründer: jede Rolle, auch für den anderen Gründer
  const other = await invite(nick, { username: 'anna3', name: 'Anna Drei', role: 'assistant', founder: 'johannes' });
  assert.equal(other.statusCode, 200, other.body);
  assert.equal((await invite(nick, { username: 'boss', name: 'Boss', role: 'admin' })).statusCode, 200);
  assert.equal((await invite(nick, { username: 'boss2', name: 'Boss', role: 'founder', founder: 'johannes' })).statusCode, 200);
  assert.deepEqual(errorOf(await invite(nick, { username: 'ohne', name: 'Ohne', role: 'founder' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await invite(nick, { username: 'ohne', name: 'Ohne', role: 'admin', founder: 'nick' })), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await invite(nick, { username: 'johannes', name: 'J', role: 'founder', founder: 'johannes' })), [409, 'account_exists']);
  // Offene Einladung desselben Namens (hier eines Admins) wird ersetzt
  const replaced = await invite(nick, { username: 'oskar', name: 'Oskar', role: 'assistant', founder: 'nick' });
  assert.equal(replaced.statusCode, 200, replaced.body);
  // Mitarbeiter ohne Gründer-Angabe: arbeitet für den einladenden Gründer (abwärtsverträglich)
  const ok = await invite(nick, { username: 'anna2', name: 'Anna Zwei', role: 'assistant', founder: null });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(errorOf(await invite(admin, { username: 'anna4', name: 'Anna', role: 'assistant' })), [400, 'invalid_request'], 'Admin: Gründer Pflicht');

  // Einladung annehmen: Konto mit Rolle aus der Einladung
  const { token } = ok.json() as CreateInviteResponse;
  const info = (await app.inject({ method: 'POST', url: '/api/auth/invite/check', payload: { token } })).json() as InviteInfo;
  assert.deepEqual([info.username, info.name, info.role, info.founder, info.accountExists], ['anna2', 'Anna Zwei', 'assistant', 'nick', false]);
  const accepted = await app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: 'ein-langes-passwort' } });
  assert.deepEqual((accepted.json() as AuthResponse).user, { username: 'anna2', name: 'Anna Zwei', founder: 'nick', role: 'assistant', onboarding: 'intro', founderNames: { nick: 'Nick', johannes: 'Johannes' } });
  assert.deepEqual(errorOf(await invite(nick, { username: 'anna2', name: 'Anna', role: 'assistant' })), [409, 'account_exists']);

  // Admin-Einladung annehmen
  const adminToken = ((await invite(admin, { username: 'chefin', name: 'Chefin', role: 'admin' })).json() as CreateInviteResponse).token;
  const adminInfo = (await app.inject({ method: 'POST', url: '/api/auth/invite/check', payload: { token: adminToken } })).json() as InviteInfo;
  assert.deepEqual([adminInfo.role, adminInfo.founder], ['admin', null]);
  const chefin = await app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token: adminToken, password: 'ein-langes-passwort' } });
  assert.deepEqual((chefin.json() as AuthResponse).user, { username: 'chefin', name: 'Chefin', founder: null, role: 'admin', founderNames: { nick: 'Nick', johannes: 'Johannes' } });
  const cookie = String(chefin.headers['set-cookie']).split(';')[0];
  assert.equal((await req(app, cookie, 'GET', '/api/accounts')).statusCode, 200);
});

test('Passwort neu setzen (reset): Admin und Gründer alle; neuer Link macht alten ungültig', async () => {
  const app = roleApp();
  const admin = await login(app, 'admin');
  const nick = await login(app, 'nick');
  const johannes = await login(app, 'johannes');
  const reset = (cookie: string, username: string, extra: object = {}) => req(app, cookie, 'POST', '/api/accounts/invite', { username, reset: true, ...extra });
  const check = (token: string) => app.inject({ method: 'POST', url: '/api/auth/invite/check', payload: { token } });

  // Mitarbeiter von Nick anlegen
  const created = ((await req(app, nick, 'POST', '/api/accounts/invite', { username: 'lena', name: 'Lena', role: 'assistant' })).json() as CreateInviteResponse).token;
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token: created, password: 'ein-langes-passwort' } })).statusCode, 200);

  assert.deepEqual(errorOf(await reset(nick, 'gibtsnicht')), [404, 'not_found']);
  assert.deepEqual(errorOf(await reset(admin, 'mitarbeiter')), [400, 'invalid_request'], 'Testkonto');

  const first = await reset(johannes, 'lena', { role: 'admin', name: 'Ignoriert' });
  assert.equal(first.statusCode, 200, first.body);
  const firstToken = (first.json() as CreateInviteResponse).token;
  const info = (await check(firstToken)).json() as InviteInfo;
  assert.deepEqual([info.name, info.role, info.founder, info.accountExists], ['Lena', 'assistant', 'nick', true], 'Name, Rolle, Gründer bleiben');

  const second = await reset(admin, 'lena');
  assert.equal(second.statusCode, 200);
  assert.equal((await check(firstToken)).statusCode, 404, 'alter Link ungültig');
  const list = (await req(app, admin, 'GET', '/api/accounts')).json() as AccountListResponse;
  const lena = list.accounts.find((a) => a.username === 'lena')!;
  assert.deepEqual([lena.pending, lena.inviteExpiresAt], [false, (second.json() as CreateInviteResponse).expiresAt]);
});

test('Entfernen: eigenes Konto und Testkonten 400, unbekannt 404; beendet Sitzungen und widerruft Links', async () => {
  const app = roleApp();
  const admin = await login(app, 'admin');
  const nick = await login(app, 'nick');
  const johannes = await login(app, 'johannes');
  const remove = (cookie: string, username: string) => req(app, cookie, 'DELETE', `/api/accounts/${username}`);

  const token = ((await req(app, nick, 'POST', '/api/accounts/invite', { username: 'lena', name: 'Lena', role: 'assistant' })).json() as CreateInviteResponse).token;
  const accepted = await app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: 'ein-langes-passwort' } });
  const lena = String(accepted.headers['set-cookie']).split(';')[0];
  assert.equal((await req(app, lena, 'GET', '/api/auth/me')).statusCode, 200);
  const resetToken = ((await req(app, nick, 'POST', '/api/accounts/invite', { username: 'lena', reset: true })).json() as CreateInviteResponse).token;

  assert.deepEqual(errorOf(await remove(nick, 'nick')), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await remove(admin, 'admin')), [400, 'invalid_request']);
  assert.deepEqual(errorOf(await remove(admin, 'mitarbeiter')), [400, 'invalid_request'], 'Testkonto');
  assert.deepEqual(errorOf(await remove(admin, 'gibtsnicht')), [404, 'not_found']);

  const removed = await remove(johannes, 'lena');
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), { ok: true });
  assert.equal((await req(app, lena, 'GET', '/api/auth/me')).statusCode, 401, 'Sitzung beendet');
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/invite/check', payload: { token: resetToken } })).statusCode, 404, 'Link widerrufen');
  assert.deepEqual(errorOf(await remove(nick, 'lena')), [404, 'not_found']);

  // Offene Einladung zurückziehen (Konto gibt es noch nicht)
  const pending = ((await req(app, admin, 'POST', '/api/accounts/invite', { username: 'neu', name: 'Neu', role: 'assistant', founder: 'johannes' })).json() as CreateInviteResponse).token;
  assert.equal((await remove(nick, 'neu')).statusCode, 200, 'auch Mitarbeiter des anderen Gründers');
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/invite/check', payload: { token: pending } })).statusCode, 404);

});

test('Entfernen: nie das letzte eingelöste Konto mit Kontenverwaltung (Admin oder Gründer)', async () => {
  const app = roleApp();
  const admin = await login(app, 'admin');
  const nick = await login(app, 'nick');
  const remove = (cookie: string, username: string) => req(app, cookie, 'DELETE', `/api/accounts/${username}`);
  const create = async (body: object) => {
    const token = ((await req(app, nick, 'POST', '/api/accounts/invite', body)).json() as CreateInviteResponse).token;
    const accepted = await app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: 'ein-langes-passwort' } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    return String(accepted.headers['set-cookie']).split(';')[0];
  };

  const f2 = await create({ username: 'f2', name: 'F2', role: 'founder', founder: 'nick' });
  await create({ username: 'hilfe', name: 'Hilfe', role: 'assistant', founder: 'nick' });
  // Einziges echtes Konto mit Kontenverwaltung – Testkonten und Mitarbeiter zählen nicht
  const last = await remove(nick, 'f2');
  assert.deepEqual(errorOf(last), [400, 'invalid_request']);
  assert.match(last.json().error.message, /letzte Konto/);
  // Offene Einladungen zählen auch nicht
  await req(app, admin, 'POST', '/api/accounts/invite', { username: 'offen', name: 'Offen', role: 'admin' });
  assert.deepEqual(errorOf(await remove(admin, 'f2')), [400, 'invalid_request']);
  // Mitarbeiter darf man entfernen
  assert.equal((await remove(nick, 'hilfe')).statusCode, 200);

  // Mit einem zweiten eingelösten Admin geht es – dann ist der Admin der letzte
  const o2 = await create({ username: 'o2', name: 'O2', role: 'admin' });
  assert.equal((await remove(f2, 'o2')).statusCode, 200, 'Gründer entfernt Admin');
  await create({ username: 'o3', name: 'O3', role: 'admin' });
  assert.equal((await remove(admin, 'f2')).statusCode, 200);
  assert.deepEqual(errorOf(await remove(nick, 'o3')), [400, 'invalid_request']);
  assert.equal((await req(app, o2, 'GET', '/api/auth/me')).statusCode, 401);
});

// ── Rechte an anderen Routen ────────────────────────────────────────────────

test('Mitarbeiter: Einstellungen 403, Vorlagen nur lesen', async () => {
  const app = roleApp();
  const anna = await login(app, 'mitarbeiter');
  for (const [method, url] of [
    ['GET', '/api/settings'],
    ['PUT', '/api/settings'],
    ['GET', '/api/settings/history'],
    ['POST', '/api/settings/test'],
    ['POST', '/api/settings/trial/confirm'],
    ['PUT', '/api/templates/G1'],
    ['POST', '/api/templates/G1/reset'],
    // Kodierte Adresse trifft dieselbe Route – darf die Prüfung nicht umgehen.
    ['GET', '/%61pi/settings'],
    ['GET', '/api/%73ettings'],
  ] as const) {
    const response = await req(app, anna, method, url, method === 'GET' ? undefined : { text: 'Hallo {{vorname}}' });
    assert.deepEqual(errorOf(response), [403, 'not_allowed'], `${method} ${url}`);
  }
  assert.equal((await req(app, anna, 'GET', '/api/settings')).json().error.message, ROLE_MESSAGES.settings);
  assert.equal((await req(app, anna, 'PUT', '/api/templates/G1', { text: 'x' })).json().error.message, ROLE_MESSAGES.templates);
  assert.equal((await req(app, anna, 'GET', '/api/templates')).statusCode, 200);

  // Gründer und Admin dürfen
  for (const user of ['nick', 'admin']) {
    const cookie = await login(app, user);
    assert.equal((await req(app, cookie, 'GET', '/api/settings')).statusCode, 200, user);
    assert.equal((await req(app, cookie, 'PUT', '/api/templates/G1', { text: 'Hallo {{vorname}}' })).statusCode, 200, user);
  }
  // Ohne Sitzung bleibt es 401, auch kodiert
  assert.equal((await app.inject({ method: 'GET', url: '/%61pi/settings' })).statusCode, 401);
});

test('Admin: kein LinkedIn-Senden, Tagesstapel nur mit owner, Ereignisse für den Gründer des Leads mit actor', async () => {
  const app = roleApp();
  const admin = await login(app, 'admin');
  const nick = await login(app, 'nick');
  const lead = await createLead(app, nick, 1, 'nick');

  for (const url of [`/api/leads/${lead.id}/linkedin/invite`, `/api/leads/${lead.id}/linkedin/message`]) {
    const response = await req(app, admin, 'POST', url, { text: 'Hallo' });
    assert.deepEqual(errorOf(response), [403, 'not_allowed'], url);
    assert.equal(response.json().error.message, ROLE_MESSAGES.linkedin);
  }

  assert.deepEqual(errorOf(await req(app, admin, 'GET', '/api/tasks')), [400, 'invalid_request']);
  assert.equal((await req(app, admin, 'GET', '/api/tasks?owner=nick')).statusCode, 200);
  assert.equal((await req(app, nick, 'GET', '/api/tasks')).statusCode, 200, 'Gründer ohne owner wie bisher');

  const booked = await req(app, admin, 'POST', `/api/leads/${lead.id}/events`, { action: 'invite_sent' });
  assert.equal(booked.statusCode, 200, booked.body);
  const event = (booked.json() as LeadDetailResponse).events.at(-1)!;
  assert.deepEqual([event.kind, event.by, event.actor, event.title], ['invite_sent', 'nick', 'Admin', 'Vernetzungsanfrage gesendet von Nick']);

  const moved = await req(app, admin, 'PATCH', `/api/leads/${lead.id}`, { owner: 'johannes' });
  const changed = (moved.json() as LeadDetailResponse).events.at(-1)!;
  assert.deepEqual([changed.kind, changed.by, changed.actor], ['owner_changed', 'nick', 'Admin']);

  assert.deepEqual(errorOf(await req(app, admin, 'POST', '/api/leads', { cards: [card(9)] })), [400, 'invalid_request'], 'Admin muss owner angeben');
});

test('Mitarbeiter sendet über LinkedIn mit dem Account seines Gründers; actor an Ereignissen', async () => {
  const app = roleApp();
  const nick = await login(app, 'nick');
  const anna = await login(app, 'mitarbeiter');
  const own = await createLead(app, nick, 1, 'nick');
  const foreign = await createLead(app, nick, 2, 'johannes');

  const sent = await req(app, anna, 'POST', `/api/leads/${own.id}/linkedin/invite`, { message: 'Hallo!' });
  assert.equal(sent.statusCode, 200, sent.body);
  const { lead, events } = sent.json() as LeadDetailResponse;
  assert.equal(lead.linkedin!.sentBy, 'nick');
  assert.match(lead.linkedin!.invitationId!, /^mock-inv-/);
  const event = events.at(-1)!;
  assert.deepEqual([event.by, event.actor, event.title], ['nick', 'Anna', 'Vernetzungsanfrage gesendet von Nick · über LinkedIn']);
  const status = (await req(app, nick, 'GET', '/api/linkedin/status')).json() as { accounts: Array<{ founder: string; invitesToday: { used: number } }> };
  assert.equal(status.accounts.find((a) => a.founder === 'nick')!.invitesToday.used, 1, 'zählt beim Account von Nick');

  const foreignSend = await req(app, anna, 'POST', `/api/leads/${foreign.id}/linkedin/invite`, {});
  assert.deepEqual(errorOf(foreignSend), [403, 'not_allowed']);
  assert.equal(foreignSend.json().error.message, 'Als Mitarbeiter arbeitest du nur für Nick – das hier gehört Johannes.');

  // Gründer bucht für sich selbst: actor leer; „created“ vom Gründer für sich ebenfalls
  const note = await req(app, nick, 'POST', `/api/leads/${own.id}/events`, { action: 'note', text: 'Notiz' });
  const noted = (note.json() as LeadDetailResponse).events;
  assert.deepEqual([noted.at(-1)!.by, noted.at(-1)!.actor], ['nick', null]);
  assert.equal(noted[0].kind, 'created');
  assert.equal(noted[0].actor, null);
  assert.equal(noted[1].actor, null, 'KI-Einschätzung ist automatisch');
  // Mitarbeiter bucht von Hand: Anzeigename
  const annaNote = (await req(app, anna, 'POST', `/api/leads/${own.id}/events`, { action: 'note', text: 'Von Anna' })).json() as LeadDetailResponse;
  assert.deepEqual([annaNote.events.at(-1)!.by, annaNote.events.at(-1)!.actor], ['nick', 'Anna']);
  // Gründer legt Leads für den anderen Gründer an: „created“ zählt für Johannes, actor Nick
  const foreignEvents = ((await req(app, nick, 'GET', `/api/leads/${foreign.id}`)).json() as LeadDetailResponse).events;
  assert.deepEqual([foreignEvents[0].by, foreignEvents[0].actor], ['johannes', 'Nick']);

  // Automatisch (Abgleich in der Simulation): ohne actor
  await req(app, nick, 'POST', '/api/linkedin/sync');
  const after = (await req(app, nick, 'GET', `/api/leads/${own.id}`)).json() as LeadDetailResponse;
  for (const automatic of after.events.filter((e) => e.kind === 'invite_accepted')) assert.equal(automatic.actor, null);

  // Demo-Leads (Simulation) ohne actor
  const list = (await req(app, nick, 'GET', '/api/leads?limit=2000')).json() as { leads: CockpitLead[] };
  const demo = list.leads.find((l) => l.origin.kind === 'demo');
  assert.ok(demo, 'Simulation legt Demo-Leads an');
  {
    const demoEvents = ((await req(app, nick, 'GET', `/api/leads/${demo!.id}`)).json() as LeadDetailResponse).events;
    assert.ok(demoEvents.every((e) => e.actor === null));
  }
});

test('Mitarbeiter nur für den eigenen Gründer: Stapel, Übergabe und schreibende Lead-Routen fremder Leads 403', async () => {
  const app = roleApp();
  const nick = await login(app, 'nick');
  const anna = await login(app, 'mitarbeiter');
  const own = await createLead(app, nick, 1, 'nick');
  const foreign = await createLead(app, nick, 2, 'johannes');

  assert.equal((await req(app, anna, 'GET', '/api/tasks')).statusCode, 200);
  assert.equal((await req(app, anna, 'GET', '/api/tasks?owner=nick')).statusCode, 200);
  assert.deepEqual(errorOf(await req(app, anna, 'GET', '/api/tasks?owner=johannes')), [403, 'not_allowed']);

  assert.deepEqual(errorOf(await req(app, anna, 'POST', '/api/leads', { cards: [card(3)], owner: 'johannes' })), [403, 'not_allowed']);
  const handed = await req(app, anna, 'POST', '/api/leads', { cards: [card(4)] });
  assert.equal(handed.statusCode, 200, handed.body);
  const created = (handed.json() as CreateLeadsResponse).created[0];
  assert.equal(created.owner, 'nick', 'ohne owner: Gründer des Mitarbeiters');

  const writes = [
    ['POST', `/api/leads/${foreign.id}/events`, { action: 'note', text: 'x' }],
    ['PATCH', `/api/leads/${foreign.id}`, { nextStep: 'x' }],
    ['POST', `/api/leads/${foreign.id}/snooze`, {}],
    ['DELETE', `/api/leads/${foreign.id}/snooze`, undefined],
    ['POST', `/api/leads/${foreign.id}/enrich`, {}],
    ['POST', `/api/leads/${foreign.id}/linkedin/invite`, {}],
    ['POST', `/api/leads/${foreign.id}/linkedin/message`, { text: 'Hallo' }],
  ] as const;
  for (const [method, url, payload] of writes) {
    assert.deepEqual(errorOf(await req(app, anna, method, url, payload)), [403, 'not_allowed'], `${method} ${url}`);
  }
  assert.equal(((await req(app, nick, 'GET', `/api/leads/${foreign.id}`)).json() as LeadDetailResponse).events.length, 2, 'nichts gebucht');

  // Lesen bleibt erlaubt, auch fremde Leads
  assert.equal((await req(app, anna, 'GET', `/api/leads/${foreign.id}`)).statusCode, 200);
  assert.equal((await req(app, anna, 'GET', '/api/leads?owner=johannes')).statusCode, 200);
  // Eigene Leads: erlaubt
  assert.equal((await req(app, anna, 'POST', `/api/leads/${own.id}/snooze`, {})).statusCode, 200);
  assert.equal((await req(app, anna, 'DELETE', `/api/leads/${own.id}/snooze`)).statusCode, 200);
  assert.equal((await req(app, anna, 'PATCH', `/api/leads/${own.id}`, { nextStep: 'Anrufen' })).statusCode, 200);
  // Unbekannter Lead: 404 wie bisher
  assert.equal((await req(app, anna, 'POST', '/api/leads/gibt-es-nicht/events', { action: 'note' })).statusCode, 404);
  // Gründer dürfen weiter auf fremden Leads buchen (wie bisher)
  assert.equal((await req(app, nick, 'POST', `/api/leads/${foreign.id}/events`, { action: 'note', text: 'ok' })).statusCode, 200);
});

test('Mitarbeiter: Tracking-Liste und Simulation zurücksetzen 403, lesen erlaubt', async () => {
  const app = roleApp();
  const anna = await login(app, 'mitarbeiter');
  const put = await app.inject({ method: 'PUT', url: '/api/lead-search/tracking', headers: { cookie: anna, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
  assert.deepEqual(errorOf(put), [403, 'not_allowed']);
  assert.equal(put.json().error.message, ROLE_MESSAGES.tracking);
  assert.deepEqual(errorOf(await req(app, anna, 'DELETE', '/api/lead-search/tracking')), [403, 'not_allowed']);
  const reset = await req(app, anna, 'POST', '/api/leads/demo/reset', {});
  assert.deepEqual(errorOf(reset), [403, 'not_allowed']);
  assert.equal(reset.json().error.message, ROLE_MESSAGES.demoReset);
  assert.equal((await req(app, anna, 'GET', '/api/lead-search/tracking')).statusCode, 200);

  const nick = await login(app, 'nick');
  assert.equal((await req(app, nick, 'DELETE', '/api/lead-search/tracking')).statusCode, 200);
  assert.equal((await req(app, nick, 'POST', '/api/leads/demo/reset', {})).statusCode, 200);
});

test('Abgelaufene Einladungen: als pending sichtbar, neuer Link ersetzt, Entfernen räumt auf', async () => {
  const dataDir = tempDataDir();
  const app = roleApp(dataDir);
  const admin = await login(app, 'admin');
  const db = openDatabase(dataDir);
  const invites = new InviteStore(db);
  const past = Date.now() - 8 * 24 * 60 * 60 * 1000;
  invites.create({ username: 'alt', name: 'Alt', role: 'assistant', founder: 'nick', reset: false }, past);
  invites.create({ username: 'weg', name: 'Weg', role: 'founder', founder: 'johannes', reset: false }, past);
  // Eingelöste und widerrufene erscheinen nicht
  invites.create({ username: 'zurueck', name: 'Zurück', role: 'admin', founder: null, reset: false }, past);
  invites.discard('zurueck');

  const list = async () => ((await req(app, admin, 'GET', '/api/accounts')).json() as AccountListResponse).accounts;
  const alt = (await list()).find((a) => a.username === 'alt')!;
  assert.equal(alt.pending, true);
  assert.ok(alt.inviteExpiresAt! < Date.now(), 'Ablauf in der Vergangenheit');
  assert.equal((await list()).some((a) => a.username === 'zurueck'), false);
  // Gründer sieht abgelaufene Einladungen
  const nickList = ((await req(app, await login(app, 'nick'), 'GET', '/api/accounts')).json() as AccountListResponse).accounts;
  assert.ok(nickList.some((a) => a.username === 'alt' && a.pending));

  // Neuer Link für den Namen funktioniert und ersetzt den alten
  const renewed = await req(app, admin, 'POST', '/api/accounts/invite', { username: 'alt', name: 'Alt Neu', role: 'assistant', founder: 'nick' });
  assert.equal(renewed.statusCode, 200, renewed.body);
  const now = (await list()).find((a) => a.username === 'alt')!;
  assert.deepEqual([now.name, now.pending, now.inviteExpiresAt], ['Alt Neu', true, (renewed.json() as CreateInviteResponse).expiresAt]);

  // Entfernen räumt auch abgelaufene weg
  assert.equal((await req(app, admin, 'DELETE', '/api/accounts/weg')).statusCode, 200);
  assert.equal((await list()).some((a) => a.username === 'weg'), false);
  assert.equal(invites.latestUnused('weg'), null);
  assert.deepEqual(errorOf(await req(app, admin, 'DELETE', '/api/accounts/weg')), [404, 'not_found']);
  db.close();
});

test('Gründer erledigt Aufgaben des anderen Gründers („Alle“): Tagesstapel beider, gebucht für den Besitzer mit actor', async () => {
  const app = roleApp();
  const nick = await login(app, 'nick');
  const foreign = await createLead(app, nick, 3, 'johannes');

  // owner=all: Aufgaben beider Gründer (ohne owner bleibt es der eigene Stapel)
  assert.equal(((await req(app, nick, 'GET', '/api/tasks')).json() as { owner: string }).owner, 'nick');
  const all = (await req(app, nick, 'GET', '/api/tasks?owner=all')).json() as { owner: string | null; tasks: Array<{ lead: { id: string } }> };
  assert.equal(all.owner, null);
  assert.ok(all.tasks.some((task) => task.lead.id === foreign.id), 'Lead von Johannes im Stapel „Alle“');
  // Mitarbeiter nur für Nick: „Alle“ nicht
  const anna = await login(app, 'mitarbeiter');
  assert.deepEqual(errorOf(await req(app, anna, 'GET', '/api/tasks?owner=all')), [403, 'not_allowed']);

  // Eintragen für Johannes: by = Johannes, actor = Nick, Titel mit Johannes
  const booked = await req(app, nick, 'POST', `/api/leads/${foreign.id}/events`, { action: 'invite_sent' });
  assert.equal(booked.statusCode, 200, booked.body);
  const event = (booked.json() as LeadDetailResponse).events.at(-1)!;
  assert.deepEqual([event.by, event.actor, event.title], ['johannes', 'Nick', 'Vernetzungsanfrage gesendet von Johannes']);
  const noted = (await req(app, nick, 'PATCH', `/api/leads/${foreign.id}`, { nextStep: 'Termin vorschlagen' })).json() as LeadDetailResponse;
  assert.deepEqual([noted.events.at(-1)!.by, noted.events.at(-1)!.actor], ['johannes', 'Nick']);
});
