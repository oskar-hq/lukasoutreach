import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AccountListResponse, CreateInviteResponse } from '../../shared/auth.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse } from '../../shared/leads.js';
import { NOTIFICATION_LIMIT, type NotificationListResponse } from '../../shared/notifications.js';
import type { BackupInfo } from '../../shared/system.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp, trustedProxyHops } from '../src/app.js';
import { InviteStore } from '../src/auth/invites.js';
import { loadConfig } from '../src/config.js';
import { backupDir } from '../src/db/backup.js';
import { DATABASE_FILE, openDatabase } from '../src/db/database.js';
import { NOTICES, NotificationCenter } from '../src/notify/notifications.js';
import { RESTORE_FILE, applyPendingRestore } from '../src/system/backups.js';
import { LeadStore } from '../src/leads/leadStore.js';
import { webUrlProblem } from '../src/leads/routes.js';
import { safeHref } from '../../src/lib/safeHref.js';
import { tempDataDir } from './helpers.js';

/** Befunde der Sicherheitsprüfung vom 08.10. (README → „Sicherheit“). */

const PASSWORD = 'ein-sicheres-passwort';
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/geheim123';

function secApp(env: NodeJS.ProcessEnv = {}, dataDir = tempDataDir(), restartProcess?: () => void) {
  const calls: string[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)).text);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'mock',
    DATA_DIR: dataDir,
    AUTH_DEMO_ACCOUNTS: 'true',
    AUTH_COOKIE_SECURE: 'false',
    MOCK_SPEED: '0',
    ...env,
  });
  return { app: buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: true, slackTest: { fetch: fakeFetch }, restartProcess }), calls, dataDir };
}

type App = ReturnType<typeof secApp>['app'];

const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];

async function login(app: App, username: string, password = 'demo'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(response.statusCode, 200, `${username}: ${response.body}`);
  return cookieOf(response);
}

const req = (app: App, cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const errorOf = (response: { statusCode: number; json: () => { error: { code: string } } }) => [response.statusCode, response.json().error.code];

const card = (i: number, overrides: Partial<NewLeadCard> = {}): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: `ACoSEC${i}`,
  publicIdentifier: `sicher-${i}`,
  profileUrl: `https://www.linkedin.com/in/sicher-${i}`,
  firstName: `Vorname${i}`,
  lastName: `Nachname${i}`,
  headline: 'Geschäftsführer',
  position: 'Geschäftsführer',
  company: `Firma ${i} GmbH`,
  location: 'Hamburg',
  website: 'firma.de',
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.9,
  reason: 'Test',
  summary: 'Test',
  metaAds: null,
  ...overrides,
});

async function createLead(app: App, cookie: string, i: number, owner: 'nick' | 'johannes'): Promise<CockpitLead> {
  const response = await req(app, cookie, 'POST', '/api/leads', { cards: [card(i)], owner });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as CreateLeadsResponse).created[0];
}

// ── H1: Client-IP hinter Caddy und nginx ─────────────────────────────────────

test('H1: Backend vertraut höchstens einem Proxy – TRUST_PROXY_HOPS=2 aus alter .env liefert die echte IP', async () => {
  assert.equal(trustedProxyHops(loadConfig({ TRUST_PROXY_HOPS: '2' })), 1);
  assert.equal(trustedProxyHops(loadConfig({ TRUST_PROXY_HOPS: '0' })), 0);
  for (const hops of ['1', '2']) {
    const { app } = secApp({ TRUST_PROXY_HOPS: hops });
    // nginx (neu) schickt genau eine, geprüfte Adresse.
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `x${attempt}`, password: 'falsch' }, headers: { 'x-forwarded-for': '203.0.113.7' } });
      assert.equal(response.statusCode, 401);
    }
    // Vorgetäuschte Adresse vorne in der Kette hilft nicht – auch nicht mit TRUST_PROXY_HOPS=2.
    const spoofed = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nick', password: 'demo' }, headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.7' } });
    assert.equal(spoofed.statusCode, 429, `TRUST_PROXY_HOPS=${hops}`);
    await app.close();
  }
});

test('H1: nginx gibt nur eine geprüfte Adresse weiter, Frontend standardmäßig nur auf 127.0.0.1', () => {
  const nginx = readFileSync(new URL('../../nginx.conf', import.meta.url), 'utf8');
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/);
  assert.match(nginx, /real_ip_header X-Forwarded-For;/);
  assert.match(nginx, /real_ip_recursive off;/);
  // Keine öffentlichen Netze als vertraute Proxys.
  const trusted = [...nginx.matchAll(/set_real_ip_from ([^;]+);/g)].map((match) => match[1]);
  assert.deepEqual(trusted, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']);
  const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /"\$\{WEB_BIND:-127\.0\.0\.1:8080\}:80"/);
});

// ── H2: Gründer-Konten und Neuigkeiten zu Kontoänderungen ───────────────────

test('H2: Admin legt keine Gründer an, je Gründer höchstens ein Gründer-Konto (Einladen, Einlösen, Freigeben)', async () => {
  const { app } = secApp();
  const nick = await login(app, 'nick');
  const admin = await login(app, 'admin');
  const invite = (cookie: string, body: object) => req(app, cookie, 'POST', '/api/accounts/invite', body);
  const accept = (token: string) => app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: PASSWORD } });

  assert.deepEqual(errorOf(await invite(admin, { username: 'neuer.chef', name: 'Chef', role: 'founder', founder: 'nick' })), [403, 'not_allowed']);
  // Admins laden weiter Admins und Mitarbeiter ein.
  assert.equal((await invite(admin, { username: 'admin2', name: 'Admin 2', role: 'admin' })).statusCode, 200);
  assert.equal((await invite(admin, { username: 'hilfe', name: 'Hilfe', role: 'assistant', founder: 'nick' })).statusCode, 200);

  // Gründer lädt einen Gründer für „johannes“ ein → offene Einladung belegt den Platz.
  const first = await invite(nick, { username: 'jo', name: 'Jo', role: 'founder', founder: 'johannes' });
  assert.equal(first.statusCode, 200, first.body);
  const second = await invite(nick, { username: 'jo2', name: 'Jo 2', role: 'founder', founder: 'johannes' });
  assert.deepEqual(errorOf(second), [409, 'account_exists']);
  assert.match(second.json().error.message, /schon ein Gründer-Konto/);
  // Neuer Link für denselben Namen bleibt möglich.
  const renewed = await invite(nick, { username: 'jo', name: 'Jo', role: 'founder', founder: 'johannes' });
  assert.equal(renewed.statusCode, 200, renewed.body);
  assert.equal((await accept((renewed.json() as CreateInviteResponse).token)).statusCode, 200);
  assert.deepEqual(errorOf(await invite(nick, { username: 'jo3', name: 'Jo 3', role: 'founder', founder: 'johannes' })), [409, 'account_exists']);

  // Registrierung als zweiten Gründer für „johannes“ freigeben → 409; Admin darf gar keine Gründer freigeben.
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'eva', name: 'Eva', password: PASSWORD }, remoteAddress: '10.9.0.1' });
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/accounts/eva/approve', { role: 'founder', founder: 'johannes' })), [409, 'account_exists']);
  assert.deepEqual(errorOf(await req(app, admin, 'POST', '/api/accounts/eva/approve', { role: 'founder', founder: 'nick' })), [403, 'not_allowed']);
  assert.equal((await req(app, admin, 'POST', '/api/accounts/eva/approve', { role: 'assistant', founder: 'nick' })).statusCode, 200);
  await app.close();
});

test('H2: Alte Gründer-Einladung (von vor der Regel) wird beim Einlösen abgelehnt, wenn der Platz belegt ist', async () => {
  const dataDir = tempDataDir();
  const { app } = secApp({ DATA_DIR: dataDir });
  await app.ready();
  const nick = await login(app, 'nick');
  // Zwei Gründer-Einladungen für „johannes“ – so, wie sie vor der Regel (z. B. von einem Admin) entstehen konnten.
  const db = openDatabase(dataDir);
  const store = new InviteStore(db);
  const old = store.create({ username: 'alt', name: 'Alt', role: 'founder', founder: 'johannes', reset: false });
  const other = store.create({ username: 'jo', name: 'Jo', role: 'founder', founder: 'johannes', reset: false });
  db.close();
  const accept = (token: string) => app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: PASSWORD } });
  assert.equal((await accept(other.token)).statusCode, 200);
  const refused = await accept(old.token);
  assert.deepEqual(errorOf(refused), [409, 'account_exists']);
  assert.match(refused.json().error.message, /schon ein Gründer-Konto \(jo\)/);
  // Nach dem Entfernen des anderen Kontos klappt derselbe Link (er wurde nicht verbraucht). Vorher ein Admin-Konto,
  // weil das letzte Konto mit Kontenverwaltung bleiben muss.
  const chef = await req(app, nick, 'POST', '/api/accounts/invite', { username: 'chef', name: 'Chef', role: 'admin' });
  assert.equal((await accept((chef.json() as CreateInviteResponse).token)).statusCode, 200);
  assert.equal((await req(app, nick, 'DELETE', '/api/accounts/jo')).statusCode, 200);
  assert.equal((await accept(old.token)).statusCode, 200);
  await app.close();
});

test('H2: Jede Kontoänderung landet bei allen Gründern (nicht bei Admins/Mitarbeitern), mit Namen des Handelnden', async () => {
  const { app } = secApp();
  const nick = await login(app, 'nick');
  const johannes = await login(app, 'johannes');
  const admin = await login(app, 'admin');
  const anna = await login(app, 'mitarbeiter');
  const changes = async (cookie: string) => ((await req(app, cookie, 'GET', '/api/notifications')).json() as NotificationListResponse).notifications.filter((item) => item.kind === 'account_change');

  assert.equal((await req(app, admin, 'POST', '/api/accounts/invite', { username: 'boss', name: 'Boss', role: 'admin' })).statusCode, 200);
  // Passwort-Link für einen anderen Gründer: erlaubt (Wiederherstellung), aber gemeldet.
  const created = await req(app, admin, 'POST', '/api/accounts/invite', { username: 'kim', name: 'Kim', role: 'assistant', founder: 'nick' });
  const accepted = await app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token: (created.json() as CreateInviteResponse).token, password: PASSWORD } });
  assert.equal(accepted.statusCode, 200);
  assert.equal((await req(app, johannes, 'POST', '/api/accounts/invite', { username: 'kim', reset: true })).statusCode, 200);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'eva', name: 'Eva', password: PASSWORD }, remoteAddress: '10.9.0.2' });
  assert.equal((await req(app, nick, 'POST', '/api/accounts/eva/approve', { role: 'assistant', founder: 'nick' })).statusCode, 200);
  assert.equal((await req(app, admin, 'DELETE', '/api/accounts/eva')).statusCode, 200);

  const forNick = await changes(nick);
  assert.deepEqual(forNick.map((item) => item.title).sort(), ['Konto entfernt', 'Neues Konto eingeladen', 'Neues Konto eingeladen', 'Passwort-Link erzeugt', 'Registrierung freigegeben'].sort());
  assert.ok(forNick.some((item) => item.text.startsWith('Admin (admin) hat einen Einladungslink für Boss (boss, Admin)')));
  assert.ok(forNick.some((item) => item.text.startsWith('Johannes (johannes) hat einen Link „Passwort neu setzen“ für Kim (kim, Mitarbeiter (Nick))')));
  assert.equal((await changes(johannes)).length, 5);
  assert.equal((await changes(admin)).length, 0, 'Admins sehen (und verbergen) diese Meldungen nicht');
  assert.equal((await changes(anna)).length, 0);
  await app.close();
});

test('H2: Kontoänderung geht live zusätzlich an Slack', async () => {
  const { app, calls } = secApp({ LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key', SLACK_WEBHOOK_URL: WEBHOOK });
  await app.ready();
  const admin = await login(app, 'admin');
  assert.equal((await req(app, admin, 'POST', '/api/accounts/invite', { username: 'nick', reset: true })).statusCode, 400, 'Testkonto: kein Link');
  assert.equal((await req(app, admin, 'POST', '/api/accounts/invite', { username: 'hilfe', name: 'Hilfe', role: 'assistant', founder: 'nick' })).statusCode, 200);
  await app.close();
  const slack = calls.filter((text) => text.includes('Neues Konto eingeladen'));
  assert.equal(slack.length, 1);
  assert.match(slack[0], /Admin \(admin\) hat einen Einladungslink für Hilfe \(hilfe, Mitarbeiter \(Nick\)\)/);
});

// ── M1 steht in onboarding.test.ts (Einrichtungs-Link). ──────────────────────

// ── L1: nur http(s)-Adressen ─────────────────────────────────────────────────

test('L1: Lead-Adressen nur http(s) oder ohne Schema – javascript:/data: werden nie gespeichert', async () => {
  for (const ok of ['', 'firma.de', 'www.firma.de/kontakt', 'https://www.linkedin.com/in/x', 'HTTP://firma.de']) assert.equal(webUrlProblem(ok), null, ok);
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'https://', 'file:///etc/passwd']) {
    assert.ok(webUrlProblem(bad), bad);
  }
  const { app } = secApp();
  const nick = await login(app, 'nick');
  // Gefährliches Schema in der Profil-Adresse sieht nach Angriff aus → 400.
  for (const profileUrl of ['javascript:alert(document.cookie)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x']) {
    const response = await req(app, nick, 'POST', '/api/leads', { cards: [card(1, { profileUrl })], owner: 'nick' });
    assert.deepEqual(errorOf(response), [400, 'invalid_request'], profileUrl);
  }
  // Website und Werbebibliothek: gefährlich oder seltsam → null, die Übergabe klappt trotzdem.
  const ads = (libraryUrl: string) => ({ state: 'active' as const, advertiser: null, ads: 1, activeAds: 1, lastStop: null, foreignAds: 0, libraryUrl, note: null });
  const response = await req(app, nick, 'POST', '/api/leads', {
    owner: 'nick',
    cards: [
      card(3, { website: 'javascript:alert(1)' }),
      card(4, { metaAds: ads('data:text/html,<script>x</script>') }),
      card(5, { website: 'www.a.de, www.b.de' }),
      card(6, { website: 'firma.de:8080' }),
      card(7, { profileUrl: 'mailto:a@b.de', website: 'https://ok.example/x' }),
      card(8, { profileUrl: 'linkedin.com/in/ohne schema' }),
    ],
  });
  assert.equal(response.statusCode, 200, response.body);
  const created = (response.json() as CreateLeadsResponse).created;
  assert.equal(created.length, 6, 'eine seltsame Website lehnt nicht den ganzen Stapel ab');
  const by = (i: number) => created.find((lead) => lead.person.providerId === `ACoSEC${i}`)!;
  assert.equal(by(3).company.website, null);
  assert.equal(by(4).metaAds?.libraryUrl, null);
  assert.equal(by(5).company.website, null);
  assert.equal(by(6).company.website, null);
  assert.equal(by(7).person.profileUrl, null);
  assert.equal(by(7).company.website, 'https://ok.example/x');
  assert.equal(by(8).person.profileUrl, null);
  assert.equal((await req(app, nick, 'POST', '/api/leads', { cards: [card(2)], owner: 'nick' })).statusCode, 200);
  await app.close();
});

test('L1: automatische Suche speichert ebenfalls nur sichere Adressen (createFromCards)', () => {
  const db = openDatabase(tempDataDir());
  const store = new LeadStore(db);
  const ads = { state: 'active' as const, advertiser: null, ads: 1, activeAds: 1, lastStop: null, foreignAds: 0, libraryUrl: 'javascript:x', note: null };
  const { created } = store.createFromCards([card(1, { profileUrl: 'javascript:alert(1)', website: 'data:text/html,x', metaAds: ads }), card(2)], 'nick');
  assert.equal(created.length, 2);
  assert.equal(created[0].person.profileUrl, null);
  assert.equal(created[0].company.website, null);
  assert.equal(created[0].metaAds?.libraryUrl, null);
  assert.equal(created[1].person.profileUrl, 'https://www.linkedin.com/in/sicher-2');
  assert.equal(created[1].company.website, 'firma.de');
  db.close();
});

test('L1: Oberfläche setzt Links nur für http(s) (safeHref)', () => {
  assert.equal(safeHref('https://www.linkedin.com/in/x'), 'https://www.linkedin.com/in/x');
  assert.equal(safeHref('http://firma.de'), 'http://firma.de');
  assert.equal(safeHref('www.firma.de'), 'https://www.firma.de');
  for (const bad of [null, undefined, '', '  ', 'javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', '\u0001javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'mailto:a@b.de']) {
    assert.equal(safeHref(bad), undefined, String(bad));
  }
});

// ── L2: Mitarbeiter übergeben nicht an fremde Gründer ───────────────────────

test('L2: Mitarbeiter kann eigenen Lead nicht einem fremden Gründer geben, Gründer schon', async () => {
  const { app } = secApp();
  const nick = await login(app, 'nick');
  const anna = await login(app, 'mitarbeiter');
  const lead = await createLead(app, nick, 3, 'nick');
  const moved = await req(app, anna, 'PATCH', `/api/leads/${lead.id}`, { owner: 'johannes' });
  assert.deepEqual(errorOf(moved), [403, 'not_allowed']);
  assert.match(moved.json().error.message, /gehört Johannes/);
  assert.equal((await req(app, anna, 'PATCH', `/api/leads/${lead.id}`, { owner: 'nick', nextStep: 'Anrufen' })).statusCode, 200);
  assert.equal((await req(app, nick, 'PATCH', `/api/leads/${lead.id}`, { owner: 'johannes' })).statusCode, 200);
  await app.close();
});

// ── L3: Board-Spalten nur Gründer und Admin ──────────────────────────────────

test('L3: Board-Spalten ändern nur Gründer und Admin, lesen alle', async () => {
  const { app } = secApp();
  const anna = await login(app, 'mitarbeiter');
  const admin = await login(app, 'admin');
  assert.equal((await req(app, anna, 'GET', '/api/board/columns')).statusCode, 200);
  assert.deepEqual(errorOf(await req(app, anna, 'POST', '/api/board/columns', { name: 'Heiß' })), [403, 'not_allowed']);
  const created = await req(app, admin, 'POST', '/api/board/columns', { name: 'Heiß' });
  assert.equal(created.statusCode, 201, created.body);
  const id = (created.json() as { id: string }).id;
  assert.deepEqual(errorOf(await req(app, anna, 'PATCH', `/api/board/columns/${id}`, { name: 'Kalt' })), [403, 'not_allowed']);
  assert.deepEqual(errorOf(await req(app, anna, 'DELETE', `/api/board/columns/${id}`)), [403, 'not_allowed']);
  assert.deepEqual(errorOf(await req(app, anna, 'PUT', '/api/board/columns/order', { order: [] })), [403, 'not_allowed']);
  assert.deepEqual(errorOf(await req(app, anna, 'PATCH', '/api/board/columns/stage/replied', { name: 'x' })), [403, 'not_allowed']);
  assert.equal((await req(app, admin, 'DELETE', `/api/board/columns/${id}`)).statusCode, 200);
  await app.close();
});

// ── L4: Registrieren zählt vor der Namensprüfung ─────────────────────────────

test('L4: Anmeldenamen durchprobieren zählt in der Sperre (auch vergebene Namen)', async () => {
  const { app } = secApp();
  for (let i = 0; i < 5; i++) {
    const taken = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'nick', name: 'Nick', password: PASSWORD }, remoteAddress: '10.8.0.1' });
    assert.deepEqual(errorOf(taken), [409, 'account_exists']);
  }
  const blocked = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'johannes', name: 'J', password: PASSWORD }, remoteAddress: '10.8.0.1' });
  assert.deepEqual(errorOf(blocked), [429, 'too_many_attempts']);
  await app.close();
});

// ── L7: große Bodys nur für die Tracking-Liste ───────────────────────────────

test('L7: 20 MB nur beim Upload der Tracking-Liste, sonst gilt 1 MB auch für rohe Bytes', async () => {
  const { app } = secApp();
  const nick = await login(app, 'nick');
  const big = Buffer.alloc(2 * 1024 * 1024, 1);
  const other = await app.inject({ method: 'POST', url: '/api/board/columns', headers: { cookie: nick, 'content-type': 'application/octet-stream' }, payload: big });
  assert.equal(other.statusCode, 413);
  const upload = await app.inject({ method: 'PUT', url: '/api/lead-search/tracking', headers: { cookie: nick, 'content-type': 'application/octet-stream' }, payload: big });
  assert.notEqual(upload.statusCode, 413, 'Upload-Route nimmt große Dateien an (hier: kein gültiges Excel → 400)');
  assert.equal(upload.statusCode, 400);
  const accounts = await req(app, nick, 'GET', '/api/accounts');
  assert.equal((accounts.json() as AccountListResponse).accounts.length > 0, true);
  await app.close();
});

// ── Sicherheitsprüfung 09.10. ────────────────────────────────────────────────

const LIVE = { LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key', SLACK_WEBHOOK_URL: WEBHOOK };
const statusCounts = (responses: { statusCode: number }[]) => {
  const counts: Record<number, number> = {};
  for (const response of responses) counts[response.statusCode] = (counts[response.statusCode] ?? 0) + 1;
  return counts;
};

test('S1: 30 gleichzeitige falsche Logins – nur 10 werden geprüft, der Rest 429; richtiges Passwort klappt danach von anderer IP', async () => {
  const { app } = secApp();
  const wrong = () => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nick', password: 'falsch' }, remoteAddress: '10.7.0.1' });
  const responses = await Promise.all(Array.from({ length: 30 }, wrong));
  assert.deepEqual(statusCounts(responses), { 401: 10, 429: 20 });
  // Gesperrt ist die IP – mit richtigem Passwort von dort ebenfalls 429.
  const sameIp = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nick', password: 'demo' }, remoteAddress: '10.7.0.1' });
  assert.deepEqual(errorOf(sameIp), [429, 'too_many_attempts']);
  const other = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nick', password: 'demo' }, remoteAddress: '10.7.0.2' });
  assert.equal(other.statusCode, 200, other.body);
  await app.close();
});

test('S1: richtiges Passwort mitten in parallelen Fehlversuchen klappt und zählt nicht als Fehlversuch', async () => {
  const { app } = secApp();
  const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nick', password }, remoteAddress: '10.7.1.1' });
  const responses = await Promise.all([login('falsch'), login('falsch'), login('demo'), login('falsch'), login('falsch')]);
  assert.deepEqual(responses.map((response) => response.statusCode), [401, 401, 200, 401, 401]);
  // 4 Fehlversuche gezählt, der richtige nicht: noch 6 bis zur Sperre.
  for (let i = 0; i < 6; i++) assert.equal((await login('falsch')).statusCode, 401);
  assert.equal((await login('falsch')).statusCode, 429);
  await app.close();
});

test('S1: Passwort-Abfragen (Herunterladen, Einstellungen) halten der Sperre auch parallel stand', async () => {
  const { app } = secApp();
  const nick = await login(app, 'nick');
  const info = (await req(app, nick, 'POST', '/api/system/backups')).json() as BackupInfo;
  const download = () => req(app, nick, 'POST', `/api/system/backups/${info.name}/download`, { password: 'falsch' });
  assert.deepEqual(statusCounts(await Promise.all(Array.from({ length: 30 }, download))), { 403: 10, 429: 20 });

  const { app: second } = secApp();
  const johannes = await login(second, 'johannes');
  const put = () => second.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: johannes }, payload: { changes: { BACKUP_KEEP: 20 }, password: 'falsch-falsch' } });
  assert.deepEqual(statusCounts(await Promise.all(Array.from({ length: 30 }, put))), { 403: 10, 429: 20 });
  await app.close();
  await second.close();
});

test('S1/S3: Schlüssel für Geheimnisse – parallel höchstens 5 Anzeigen; jede Anzeige meldet sich bei allen Gründern und in Slack', async () => {
  const { app, calls, dataDir } = secApp(LIVE);
  await app.ready();
  writeFileSync(path.join(dataDir, 'settings.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
  const nick = await login(app, 'nick');
  const view = () => req(app, nick, 'POST', '/api/system/settings-key', { password: 'demo' });
  assert.deepEqual(statusCounts(await Promise.all(Array.from({ length: 10 }, view))), { 200: 5, 429: 5 });

  const johannes = await login(app, 'johannes');
  const admin = await login(app, 'admin');
  const seen = async (cookie: string) =>
    ((await req(app, cookie, 'GET', '/api/notifications')).json() as NotificationListResponse).notifications.filter((item) => item.title === 'Schlüssel für Geheimnisse angezeigt');
  const forJohannes = await seen(johannes);
  assert.equal(forJohannes.length, 5);
  assert.equal(forJohannes[0].kind, 'account_change');
  assert.match(forJohannes[0].text, /^Nick \(nick\) hat sich den Schlüssel für Geheimnisse anzeigen lassen/);
  assert.equal((await seen(admin)).length, 0, 'nur Gründer');
  await app.close();
  const slack = calls.filter((text) => text.includes('Schlüssel für Geheimnisse angezeigt'));
  assert.equal(slack.length, 5);
  assert.ok(slack.every((text) => text.includes('Nick (nick)')));
  assert.ok(!slack.some((text) => text.includes(Buffer.alloc(32, 7).toString('base64'))), 'nie der Schlüssel selbst');
});

test('S3: Sicherung herunterladen meldet sich bei allen Gründern und in Slack (falsches Passwort nicht)', async () => {
  const { app, calls } = secApp(LIVE);
  await app.ready();
  const johannes = await login(app, 'johannes');
  const info = (await req(app, johannes, 'POST', '/api/system/backups')).json() as BackupInfo;
  const url = `/api/system/backups/${info.name}/download`;
  assert.equal((await req(app, johannes, 'POST', url, { password: 'falsch' })).statusCode, 403);
  assert.equal((await req(app, johannes, 'POST', url, { password: 'demo' })).statusCode, 200);
  const nick = await login(app, 'nick');
  const items = ((await req(app, nick, 'GET', '/api/notifications')).json() as NotificationListResponse).notifications.filter((item) => item.title === 'Sicherung heruntergeladen');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'account_change');
  assert.ok(items[0].text.startsWith('Johannes (johannes) hat die Sicherung vom '));
  assert.ok(items[0].text.includes(info.name));
  await app.close();
  assert.equal(calls.filter((text) => text.includes('Sicherung heruntergeladen') && text.includes('Johannes (johannes)')).length, 1);
});

test('S2: Wiederherstellen bringt keine entfernten Konten, alten Passwörter, Sitzungen oder Einladungen zurück; Meldung + Slack nach dem Start', async () => {
  let restarted = 0;
  const { app, dataDir } = secApp(LIVE, tempDataDir(), () => restarted++);
  await app.ready();
  const nick = await login(app, 'nick');
  const side = () => new DatabaseSync(path.join(dataDir, DATABASE_FILE));
  // Stand der Sicherung: Konto „alt“ mit altem Passwort, Sitzung, Einladung, Registrierung.
  let db = side();
  db.exec(`
    INSERT INTO users (username, name, role, founder, password_hash, created_at, updated_at) VALUES ('alt', 'Alt', 'assistant', 'nick', 'alter-hash', 1, 1);
    INSERT INTO users (username, name, role, founder, password_hash, created_at, updated_at) VALUES ('kim', 'Kim', 'assistant', 'nick', 'kim-alt', 1, 1);
    INSERT INTO sessions (id_hash, username, remember, created_at, last_seen_at, expires_at) VALUES ('s-alt', 'alt', 0, 1, 1, 9999999999999);
    INSERT INTO invitations (id_hash, username, name, role, founder, reset, created_at, expires_at, used_at) VALUES ('i-alt', 'kim', 'Kim', 'assistant', 'nick', 1, 1, 9999999999999, NULL);
    INSERT INTO registrations (username, name, password_hash, created_at) VALUES ('reg-alt', 'Reg Alt', 'h', 1);
  `);
  db.close();
  const info = (await req(app, nick, 'POST', '/api/system/backups')).json() as BackupInfo;
  // Danach: „alt“ entfernt (mit Meldung), Kims Passwort geändert, neue Sitzung und Registrierung.
  assert.equal((await req(app, nick, 'DELETE', '/api/accounts/alt')).statusCode, 200);
  db = side();
  db.exec(`
    UPDATE users SET password_hash = 'kim-neu', updated_at = 2 WHERE username = 'kim';
    DELETE FROM registrations;
    INSERT INTO registrations (username, name, password_hash, created_at) VALUES ('reg-neu', 'Reg Neu', 'h', 2);
    INSERT INTO sessions (id_hash, username, remember, created_at, last_seen_at, expires_at) VALUES ('s-kim', 'kim', 0, 2, 2, 9999999999999);
  `);
  db.close();

  const restore = await req(app, nick, 'POST', `/api/system/backups/${info.name}/restore`, { password: 'demo' });
  assert.equal(restore.statusCode, 202, restore.body);
  assert.equal(restarted, 1);
  await app.close();
  assert.equal(applyPendingRestore(dataDir), true);

  db = side();
  const all = (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
  assert.deepEqual(all('SELECT username, password_hash FROM users ORDER BY username'), [{ username: 'kim', password_hash: 'kim-neu' }], 'jetzige Konten und Passwörter');
  assert.deepEqual(all('SELECT username FROM registrations'), [{ username: 'reg-neu' }]);
  assert.deepEqual(all('SELECT id_hash FROM sessions'), [], 'alle melden sich neu an');
  assert.deepEqual(all('SELECT id_hash FROM invitations'), [], 'keine alten Links');
  const notices = all("SELECT key, title, text, audience, slack_at FROM notifications WHERE kind = 'account_change' ORDER BY created_at") as { key: string; title: string; text: string; audience: string; slack_at: number | null }[];
  assert.ok(notices.some((row) => row.title === 'Konto entfernt' && row.text.includes('Alt (alt')), 'Spur der Kontoänderung bleibt');
  const restored = notices.find((row) => row.key.startsWith('restore:'));
  assert.equal(restored?.title, 'Sicherung wiederhergestellt von Nick');
  assert.equal(restored?.audience, 'founders');
  assert.equal(restored?.slack_at, null, 'Slack erst nach dem Neustart');
  db.close();
  assert.ok(!readFileSync(path.join(backupDir(dataDir), restore.json().safetyBackup)).includes('restore:'), 'Sicherung des Stands vorher unverändert');

  // Start mit der eingespielten Datenbank: Meldung bei den Gründern, Slack einmal nachgeholt.
  const { app: after, calls } = secApp(LIVE, dataDir);
  await after.ready();
  const johannes = await login(after, 'johannes');
  const list = (await req(after, johannes, 'GET', '/api/notifications')).json() as NotificationListResponse;
  assert.ok(list.notifications.some((item) => item.title === 'Sicherung wiederhergestellt von Nick' && item.unread));
  await after.close();
  assert.equal(calls.filter((text) => text.includes('Sicherung wiederhergestellt von Nick')).length, 1);
  const { app: again, calls: callsAgain } = secApp(LIVE, dataDir);
  await again.ready();
  await again.close();
  assert.equal(callsAgain.filter((text) => text.includes('Sicherung wiederhergestellt')).length, 0, 'nur einmal');
  assert.equal(RESTORE_FILE.endsWith('.restore'), true);
});

test('S6: ungelesene Kontoänderungen bleiben sichtbar, auch wenn mehr als NOTIFICATION_LIMIT andere Meldungen da sind', () => {
  const db = openDatabase(tempDataDir());
  let now = Date.now() - 60_000;
  const log = { info: () => undefined, error: () => undefined } as unknown as ConstructorParameters<typeof NotificationCenter>[0]['log'];
  const center = new NotificationCenter({ db, log, now: () => now });
  const by = { username: 'admin', name: 'Admin' };
  center.raise(NOTICES.accountChange({ action: 'invited', by, username: 'boss', name: 'Boss', role: 'admin', founder: null }));
  now += 1;
  center.raise(NOTICES.securityAction('settings_key', by));
  for (let i = 0; i < NOTIFICATION_LIMIT + 10; i++) {
    now += 1;
    center.raise({ key: `test:${i}`, kind: 'search_failed', severity: 'error', title: `Lauf ${i}`, text: 'x' });
  }
  const founder = { username: 'nick', founder: 'nick' as const, role: 'founder' as const };
  const list = center.list(founder);
  assert.equal(list.notifications.length, NOTIFICATION_LIMIT + 2);
  assert.deepEqual(
    list.notifications.filter((item) => item.kind === 'account_change').map((item) => item.title),
    ['Schlüssel für Geheimnisse angezeigt', 'Neues Konto eingeladen'],
  );
  assert.equal(list.notifications.filter((item) => item.kind !== 'account_change').length, NOTIFICATION_LIMIT);
  // Admins sehen Gründer-Meldungen nie – für sie gilt nur die Grenze.
  assert.equal(center.list({ username: 'admin', founder: null, role: 'admin' }).notifications.length, NOTIFICATION_LIMIT);
  // Gesehen: dann wieder nur die neuesten N.
  now += 1;
  center.markSeen('nick');
  assert.equal(center.list(founder).notifications.length, NOTIFICATION_LIMIT);
  db.close();
});
