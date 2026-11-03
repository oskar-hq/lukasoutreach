import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthResponse } from '../../shared/auth.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { AccountStore } from '../src/auth/accounts.js';
import { SESSION_COOKIE } from '../src/auth/auth.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { LoginLimiter } from '../src/auth/rateLimit.js';
import { IDLE_TIMEOUT_MS, REMEMBER_MS, SessionStore } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { tempDataDir } from './helpers.js';

const DEMO_ENV = { AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false' };

function authApp(env: NodeJS.ProcessEnv = DEMO_ENV, dataDir = tempDataDir()) {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: dataDir, ...env });
  return buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: true });
}

type App = ReturnType<typeof authApp>;

function login(app: App, body: object, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: body, headers });
}

/** „cockpit_session=…“ aus dem Set-Cookie-Header – für den Cookie-Header der nächsten Anfrage. */
function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = String(response.headers['set-cookie']);
  assert.match(header, new RegExp(`^${SESSION_COOKIE}=`));
  return header.split(';')[0];
}

test('ohne Sitzung: geschützte Routen 401, offene Routen erreichbar', async () => {
  const app = authApp();
  const config = await app.inject({ method: 'GET', url: '/api/lead-search/config' });
  assert.equal(config.statusCode, 401);
  assert.deepEqual(config.json(), { error: { code: 'unauthorized', message: 'Bitte melde dich an.' } });

  const events = await app.inject({ method: 'GET', url: '/api/lead-search/runs/00000000-0000-4000-8000-000000000000/events' });
  assert.equal(events.statusCode, 401, 'auch die Server-Sent Events sind geschützt');

  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode, 200, 'Abmelden auch ohne Sitzung');
  // Seiten außerhalb von /api sind nicht Sache des Backends
  assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 404);
});

test('Testkonto: Login setzt Sitzungs-Cookie, danach sind me und geschützte Routen erreichbar', async () => {
  const app = authApp();
  const response = await login(app, { username: '  Nick ', password: 'demo' });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { user: { username: 'nick', name: 'Nick', founder: 'nick', role: 'founder', founderNames: { nick: 'Nick', johannes: 'Johannes' } } } satisfies AuthResponse);

  const header = String(response.headers['set-cookie']);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.doesNotMatch(header, /Max-Age/, 'ohne „angemeldet bleiben“ ein Sitzungs-Cookie');
  assert.doesNotMatch(header, /Secure/, 'AUTH_COOKIE_SECURE=false');
  assert.doesNotMatch(header, /Domain/);

  const cookie = sessionCookie(response);
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal((me.json() as AuthResponse).user.founder, 'nick');

  const config = await app.inject({ method: 'GET', url: '/api/lead-search/config', headers: { cookie } });
  assert.equal(config.statusCode, 200);
});

test('„angemeldet bleiben“: Cookie 30 Tage', async () => {
  const app = authApp();
  const response = await login(app, { username: 'johannes', password: 'demo', remember: true });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['set-cookie']), new RegExp(`Max-Age=${REMEMBER_MS / 1000}`));
});

test('falsches Passwort und unbekannter Name: gleiche Antwort; fehlende Angaben: 400', async () => {
  const app = authApp();
  const wrong = await login(app, { username: 'nick', password: 'falsch' });
  const unknown = await login(app, { username: 'niemand', password: 'falsch' });
  for (const response of [wrong, unknown]) {
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: { code: 'invalid_credentials', message: 'Name oder Passwort ist falsch.' } });
    assert.equal(response.headers['set-cookie'], undefined);
  }
  for (const body of [{}, { username: 'nick' }, { username: '   ', password: 'demo' }, { username: 'nick', password: '' }]) {
    const response = await login(app, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.json().error.code, 'invalid_request');
  }
});

test('Begrenzung je IP: nach 10 Fehlversuchen 429 mit Retry-After – auch mit richtigem Passwort', async () => {
  const app = authApp();
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await login(app, { username: `raten${attempt}`, password: 'x' })).statusCode, 401);
  }
  const blocked = await login(app, { username: 'nick', password: 'demo' });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'too_many_attempts');
  assert.match(blocked.json().error.message, /Bitte warte 15 Minuten/);
  const retryAfter = Number(blocked.headers['retry-after']);
  assert.ok(retryAfter > 800 && retryAfter <= 900, `Retry-After ${retryAfter}`);
});

test('LoginLimiter: Sperre je Name, Erfolg setzt den Namen zurück, Fenster läuft ab', () => {
  const limiter = new LoginLimiter({ max: 100, windowMs: 1000 }, { max: 3, windowMs: 60_000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) limiter.failure(`10.0.0.${i}`, 'nick', t0);
  assert.equal(limiter.retryAfter('10.0.0.99', 'nick', t0), 60, 'Name gesperrt – egal von welcher IP');
  assert.equal(limiter.retryAfter('10.0.0.99', 'johannes', t0), 0);
  assert.equal(limiter.retryAfter('10.0.0.99', 'nick', t0 + 60_000), 0, 'Fenster abgelaufen');

  for (let i = 0; i < 2; i++) limiter.failure('10.0.0.1', 'johannes', t0);
  limiter.success('johannes');
  limiter.failure('10.0.0.1', 'johannes', t0);
  assert.equal(limiter.retryAfter('10.0.0.1', 'johannes', t0), 0, 'Zähler nach Erfolg zurückgesetzt');
});

test('Abmelden beendet die Sitzung und löscht das Cookie', async () => {
  const app = authApp();
  const cookie = sessionCookie(await login(app, { username: 'nick', password: 'demo' }));
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.json(), { ok: true });
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 401);
  assert.match(String(me.headers['set-cookie']), /Max-Age=0/, 'unbekannte Sitzung → Cookie löschen');
});

test('Login vergibt immer eine neue Sitzungs-ID und beendet die mitgeschickte alte', async () => {
  const app = authApp();
  const first = sessionCookie(await login(app, { username: 'nick', password: 'demo' }));
  const second = sessionCookie(await login(app, { username: 'nick', password: 'demo' }, { cookie: first }));
  assert.notEqual(first, second);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second } })).statusCode, 200);
});

test('Anfragen fremder Seiten (Sec-Fetch-Site) werden abgelehnt', async () => {
  const app = authApp();
  const crossSite = await login(app, { username: 'nick', password: 'demo' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.json().error.code, 'forbidden');
  const sameOrigin = await login(app, { username: 'nick', password: 'demo' }, { 'sec-fetch-site': 'same-origin' });
  assert.equal(sameOrigin.statusCode, 200);
});

test('echtes Konto: Login, Secure-Cookie, Sitzung übersteht Neustart, Passwortwechsel beendet Sitzungen', async () => {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  const accounts = new AccountStore(db);
  await accounts.save({ username: 'nick', name: 'Nick', founder: 'nick', role: 'founder' }, 'richtig-langes-passwort');

  const app = authApp({}, dataDir);
  assert.equal((await login(app, { username: 'nick', password: 'demo' })).statusCode, 401, 'ohne Schalter keine Testkonten');
  const response = await login(app, { username: 'nick', password: 'richtig-langes-passwort' });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['set-cookie']), /Secure/, 'Secure ist Standard');
  const cookie = sessionCookie(response);
  await app.close();

  const restarted = authApp({}, dataDir);
  assert.equal((await restarted.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode, 200);

  await accounts.save({ username: 'nick', name: 'Nick', founder: 'nick', role: 'founder' }, 'ganz-neues-passwort');
  assert.equal(new SessionStore(db).deleteForUser('nick'), 1);
  assert.equal((await restarted.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode, 401);

  assert.ok(accounts.remove('nick'));
  db.close();
});

test('echtes Konto überdeckt das gleichnamige Testkonto', async () => {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  await new AccountStore(db).save({ username: 'nick', name: 'Nick S.', founder: 'nick', role: 'founder' }, 'richtig-langes-passwort');
  db.close();
  const app = authApp(DEMO_ENV, dataDir);
  assert.equal((await login(app, { username: 'nick', password: 'demo' })).statusCode, 401);
  const response = await login(app, { username: 'nick', password: 'richtig-langes-passwort' });
  assert.equal((response.json() as AuthResponse).user.name, 'Nick S.');
});

test('Sitzungen: 12 h ohne Anfrage abgelaufen, Anfragen verlängern; „angemeldet bleiben“ fest 30 Tage', () => {
  const sessions = new SessionStore(openDatabase(tempDataDir()));
  const t0 = 1_000_000_000;
  const short = sessions.create('nick', false, t0);
  assert.ok(sessions.get(short, t0 + IDLE_TIMEOUT_MS - 1000));
  assert.ok(sessions.get(short, t0 + 2 * IDLE_TIMEOUT_MS - 2000), 'durch die Anfrage verlängert');
  assert.equal(sessions.get(short, t0 + 4 * IDLE_TIMEOUT_MS), null);

  const long = sessions.create('nick', true, t0);
  assert.ok(sessions.get(long, t0 + REMEMBER_MS - 1000));
  assert.equal(sessions.get(long, t0 + REMEMBER_MS + 1), null, 'verlängert sich nicht');
});

test('Passwort-Hash: scrypt, mit Salz, prüfbar', async () => {
  const hash = await hashPassword('geheimes-passwort');
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(hash, await hashPassword('geheimes-passwort'), 'eigenes Salz je Hash');
  assert.equal(await verifyPassword('geheimes-passwort', hash), true);
  assert.equal(await verifyPassword('falsch', hash), false);
  assert.equal(await verifyPassword('egal', 'kaputt'), false);
});

test('Konfiguration: Testkonten nur mit AUTH_COOKIE_SECURE=false, Proxys als feste Zahl', () => {
  assert.throws(() => loadConfig({ AUTH_DEMO_ACCOUNTS: 'true' }), /AUTH_COOKIE_SECURE=false/);
  const defaults = loadConfig({});
  assert.deepEqual(defaults.auth, { publicUrl: null, demoAccounts: false, cookieSecure: true, trustProxyHops: 1, setupToken: null, setupTokenIgnored: false });
  assert.equal(loadConfig({ SETUP_TOKEN: ' fester-schluessel-mit-24-zeichen ' }).auth.setupToken, 'fester-schluessel-mit-24-zeichen');
  assert.equal(loadConfig({ PUBLIC_URL: 'https://crm.example.de/' }).auth.publicUrl, 'https://crm.example.de');
  assert.equal(loadConfig({ TRUST_PROXY_HOPS: '2' }).auth.trustProxyHops, 2);
});

test('Konfiguration: SETUP_TOKEN unter 24 Zeichen wird ignoriert statt den Start abzubrechen', () => {
  assert.deepEqual(
    { setupToken: loadConfig({ SETUP_TOKEN: 'kurz' }).auth.setupToken, ignored: loadConfig({ SETUP_TOKEN: 'kurz' }).auth.setupTokenIgnored },
    { setupToken: null, ignored: true },
  );
  assert.equal(loadConfig({ SETUP_TOKEN: 'a'.repeat(23) }).auth.setupToken, null);
  assert.equal(loadConfig({ SETUP_TOKEN: 'a'.repeat(24) }).auth.setupToken, 'a'.repeat(24));
  assert.equal(loadConfig({ SETUP_TOKEN: 'a'.repeat(24) }).auth.setupTokenIgnored, false);
  // Leer = Zufallsschlüssel im Datenordner (wie bisher).
  assert.equal(loadConfig({ SETUP_TOKEN: '  ' }).auth.setupToken, null);
});

test('Client-IP hinter dem Proxy: Sperre gilt je echter IP, nicht für alle hinter nginx', async () => {
  const app = authApp({ ...DEMO_ENV, TRUST_PROXY_HOPS: '1' });
  const from = (ip: string) => ({ 'x-forwarded-for': ip });
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await login(app, { username: `raten${attempt}`, password: 'x' }, from('203.0.113.7'))).statusCode, 401);
  }
  assert.equal((await login(app, { username: 'nick', password: 'demo' }, from('203.0.113.7'))).statusCode, 429);
  assert.equal((await login(app, { username: 'nick', password: 'demo' }, from('198.51.100.2'))).statusCode, 200);
  // Vorgetäuschte Adresse vorne in der Kette zählt nicht: vertraut wird nur der letzte Eintrag (von nginx gesetzt).
  assert.equal((await login(app, { username: 'nick', password: 'demo' }, from('198.51.100.9, 203.0.113.7'))).statusCode, 429);
});
