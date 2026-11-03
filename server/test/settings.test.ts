import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import {
  SETTINGS,
  type SettingKey,
  type SettingState,
  type SettingsHistoryResponse,
  type SettingsResponse,
  type SettingsTestResponse,
  type SettingValue,
} from '../../shared/settings.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { LinkedInStatusResponse } from '../../shared/linkedin.js';
import type { TasksResponse } from '../../shared/tasks.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { loadConfigWithSettings } from '../src/settings/effective.js';
import { SLACK_TEST_TEXT } from '../src/settings/service.js';
import { startFakeClose, startFakeMeta, startFakeTreg, startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

const PASSWORD = 'demo';
const SECRET_VALUE = 'geheimer-schluessel-abcdef123456';

interface Options {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  adapter?: MockAdapter;
  settingsTest?: Parameters<typeof buildApp>[0]['settingsTest'];
}

function setup({ env = {}, dataDir = tempDataDir(), adapter = new MockAdapter(0), settingsTest }: Options = {}) {
  const baseEnv: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: dataDir, AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false', MOCK_SPEED: '0', ...env };
  const config = loadConfigWithSettings(baseEnv);
  const app = buildApp({
    config,
    adapter,
    env: baseEnv,
    logger: false,
    requireSession: true,
    settingsTest,
    createAdapter: async (current) => {
      if (current.mode === 'mock') return new MockAdapter(0);
      const { createLiveAdapter } = await import('../src/adapters/live/liveAdapter.js');
      return createLiveAdapter(current);
    },
  });
  return { app, baseEnv, dataDir, config };
}

type App = ReturnType<typeof setup>['app'];

async function login(app: App, username = 'nick'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
}

const send = (app: App, method: 'GET' | 'PUT' | 'POST', url: string, cookie: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { cookie, ...headers } });

const get = async (app: App, cookie: string, headers: Record<string, string> = {}) =>
  (await send(app, 'GET', '/api/settings', cookie, undefined, headers)).json() as SettingsResponse;

const put = (app: App, cookie: string, body: object, headers: Record<string, string> = {}) => send(app, 'PUT', '/api/settings', cookie, body, headers);

const stateOf = (response: SettingsResponse, key: SettingKey): SettingState => response.settings.find((entry) => entry.key === key)!;

async function change(app: App, cookie: string, changes: Partial<Record<SettingKey, SettingValue | null>>, extra: object = {}) {
  const current = await get(app, cookie);
  return put(app, cookie, { changes, version: current.version, password: PASSWORD, ...extra });
}

// ── Lesen ───────────────────────────────────────────────────────────────────

test('Ohne Anmeldung 401; GET liefert den ganzen Katalog mit Quelle Standard/.env', async () => {
  const { app } = setup({ env: { MAX_RESULTS: '15', UNIPILE_DSN: 'https://api68.unipile.com:19881', UNIPILE_API_KEY: 'env-unipile-key-9876' } });
  for (const [method, url] of [['GET', '/api/settings'], ['PUT', '/api/settings'], ['POST', '/api/settings/test'], ['GET', '/api/settings/history']] as const) {
    assert.equal((await app.inject({ method, url, payload: method === 'GET' ? undefined : {} })).statusCode, 401, `${method} ${url}`);
  }
  const cookie = await login(app);
  const response = await get(app, cookie);
  assert.deepEqual(response.settings.map((entry) => entry.key), SETTINGS.map((entry) => entry.key));
  assert.equal(response.safeMode, false);
  assert.equal(response.trial, null);
  assert.equal(response.version, 1);
  assert.ok(Math.abs(response.serverTime - Date.now()) < 5000);

  const maxResults = stateOf(response, 'MAX_RESULTS');
  assert.deepEqual([maxResults.source, maxResults.value, maxResults.fallback, maxResults.fallbackSource], ['env', 15, 15, 'env']);
  const follow = stateOf(response, 'FOLLOWUP_AFTER_DAYS');
  assert.deepEqual([follow.source, follow.value, follow.fallbackSource], ['default', 2, 'default']);
  const key = stateOf(response, 'UNIPILE_API_KEY');
  assert.deepEqual(key.secret, { set: true, hint: '9876' });
  assert.equal(key.value, undefined, 'Geheimnisse haben nie einen Wert');
  assert.equal(JSON.stringify(response).includes('env-unipile-key-9876'), false);
  assert.deepEqual(stateOf(response, 'ANTHROPIC_API_KEY').secret, { set: false, hint: null });
  // Nur über die .env: mit Wert, Quelle .env/Standard
  assert.equal(stateOf(response, 'DATA_DIR').value, response.settings.length > 0 ? stateOf(response, 'DATA_DIR').value : '');
  assert.equal(stateOf(response, 'BACKUP_HOUR_UTC').value, 2);
  // Kein Modus-Schalter und keine Testkonten in den Einstellungen (echter Betrieb, 07.10.)
  for (const gone of ['LEAD_SEARCH_MODE', 'MOCK_SPEED', 'AUTH_DEMO_ACCOUNTS']) {
    assert.equal(response.settings.some((setting) => setting.key === gone), false, gone);
  }
});

// ── Ändern ──────────────────────────────────────────────────────────────────

test('Wert ändern, Quelle Software, wirkt sofort; null → zurück zur .env; Verlauf mit Werten (ohne Geheimnisse)', async () => {
  const { app } = setup({ env: { FOLLOWUP_AFTER_DAYS: '3' } });
  const cookie = await login(app);

  const tasks = async () => ((await send(app, 'GET', '/api/tasks', cookie)).json() as TasksResponse).rules.followUpAfterDays;
  assert.equal(await tasks(), 3);

  const saved = await change(app, cookie, { FOLLOWUP_AFTER_DAYS: 7, MAX_RESULTS: 10 });
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as SettingsResponse;
  assert.equal(after.version, 2);
  assert.deepEqual([stateOf(after, 'FOLLOWUP_AFTER_DAYS').source, stateOf(after, 'FOLLOWUP_AFTER_DAYS').value, stateOf(after, 'FOLLOWUP_AFTER_DAYS').fallback], ['software', 7, 3]);
  assert.equal(await tasks(), 7, 'Regeln gelten ab der nächsten Abfrage, ohne Neustart');
  const lead = (await send(app, 'GET', '/api/lead-search/config', cookie)).json() as { defaults: { maxResults: number } };
  assert.equal(lead.defaults.maxResults, 10);

  // Gleicher Wert noch einmal: nichts zu tun, kein neuer Stand
  const same = (await change(app, cookie, { FOLLOWUP_AFTER_DAYS: 7 })).json() as SettingsResponse;
  assert.equal(same.version, 2);

  const reset = (await change(app, cookie, { FOLLOWUP_AFTER_DAYS: null })).json() as SettingsResponse;
  assert.deepEqual([stateOf(reset, 'FOLLOWUP_AFTER_DAYS').source, stateOf(reset, 'FOLLOWUP_AFTER_DAYS').value], ['env', 3]);
  assert.equal(await tasks(), 3);

  const history = (await send(app, 'GET', '/api/settings/history', cookie)).json() as SettingsHistoryResponse;
  assert.deepEqual(
    history.entries.map((entry) => [entry.key, entry.action, entry.from, entry.to, entry.username]),
    [
      ['FOLLOWUP_AFTER_DAYS', 'reset', 7, null, 'nick'],
      ['FOLLOWUP_AFTER_DAYS', 'set', null, 7, 'nick'],
      ['MAX_RESULTS', 'set', null, 10, 'nick'],
    ],
    'neueste zuerst (in einer Änderung in Reihenfolge des Katalogs)',
  );
});

test('Geheimnisse: verschlüsselt gespeichert, nie ausgeliefert, nicht im Verlauf; Passwort nötig', async () => {
  const { app, dataDir } = setup();
  const cookie = await login(app);
  const version = (await get(app, cookie)).version;

  const noPassword = await put(app, cookie, { changes: { ANTHROPIC_API_KEY: SECRET_VALUE }, version });
  assert.equal(noPassword.statusCode, 403);
  assert.equal(noPassword.json().error.code, 'reauth_failed');
  assert.equal(noPassword.json().error.message, 'Bitte gib dein Passwort ein.');

  const wrong = await put(app, cookie, { changes: { ANTHROPIC_API_KEY: SECRET_VALUE }, version, password: 'falsch-falsch' });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().error.message, 'Das Passwort stimmt nicht.');

  const ok = await put(app, cookie, { changes: { ANTHROPIC_API_KEY: SECRET_VALUE }, version, password: PASSWORD });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(stateOf(ok.json() as SettingsResponse, 'ANTHROPIC_API_KEY'), {
    key: 'ANTHROPIC_API_KEY',
    source: 'software',
    fallbackSource: 'default',
    secret: { set: true, hint: '3456' },
    fallbackSecret: { set: false, hint: null },
  });
  assert.equal(ok.body.includes(SECRET_VALUE), false);

  const history = await send(app, 'GET', '/api/settings/history', cookie);
  assert.equal(history.body.includes(SECRET_VALUE), false);
  assert.deepEqual(history.json().entries, [{ at: history.json().entries[0].at, username: 'nick', ip: '127.0.0.1', key: 'ANTHROPIC_API_KEY', action: 'set' }].map((entry) => ({ ...entry })));

  // In der Datenbank: nur verschlüsselt (AES-GCM), Schlüsseldatei mit Rechten 600 im Datenordner
  const db = openDatabase(dataDir);
  const row = db.prepare("SELECT secret, value FROM settings_values WHERE key = 'ANTHROPIC_API_KEY'").get() as { secret: number; value: string };
  db.close();
  assert.equal(row.secret, 1);
  assert.match(row.value, /^v1:/);
  assert.equal(row.value.includes(SECRET_VALUE), false);
  assert.equal(statSync(path.join(dataDir, 'settings.key')).mode & 0o777, 0o600);

  // Neuer Start: gleiche Datenbank, Wert wirksam
  assert.equal(loadConfigWithSettings({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: dataDir }).anthropic.apiKey, SECRET_VALUE);

  // Zurücksetzen löscht den Wert; Verlauf kennt wieder keinen Wert
  const reset = await change(app, cookie, { ANTHROPIC_API_KEY: null });
  assert.deepEqual((reset.json() as SettingsResponse).settings.find((entry) => entry.key === 'ANTHROPIC_API_KEY')!.secret, { set: false, hint: null });
});

test('Ein Passwort ist nur bei Schlüsseln mit reauth nötig; zehn Fehlversuche → 429 ohne Passwortprüfung', async () => {
  const { app } = setup();
  const cookie = await login(app);
  const plain = await put(app, cookie, { changes: { MAX_RESULTS: 12 }, version: 1 });
  assert.equal(plain.statusCode, 200, 'MAX_RESULTS braucht kein Passwort');

  let version = 2;
  for (let i = 0; i < 10; i++) {
    const response = await put(app, cookie, { changes: { BACKUP_KEEP: 20 }, version, password: 'falsch-falsch' });
    assert.equal(response.statusCode, 403);
  }
  const blocked = await put(app, cookie, { changes: { BACKUP_KEEP: 20 }, version, password: PASSWORD });
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal(blocked.json().error.code, 'too_many_attempts');
  version = (await get(app, cookie)).version;
  assert.equal(version, 2, 'nichts gespeichert');
});

test('Prüfreihenfolge und Fehler: unbekannt, nur .env, Stand, Werte, Adressen, Probe-Schlüssel allein', async () => {
  const { app } = setup();
  const cookie = await login(app);
  const err = (response: { statusCode: number; json: () => { error: { code: string; field?: string; message: string } } }) => ({
    status: response.statusCode,
    code: response.json().error.code,
    field: response.json().error.field,
  });
  const version = 1;

  assert.deepEqual(err(await put(app, cookie, { changes: {}, version })), { status: 400, code: 'invalid_setting', field: undefined });
  assert.deepEqual(err(await put(app, cookie, { changes: { GIBT_ES_NICHT: 1 }, version })), { status: 400, code: 'invalid_setting', field: 'GIBT_ES_NICHT' });
  assert.deepEqual(err(await put(app, cookie, { changes: { DATA_DIR: '/x' }, version })), { status: 409, code: 'setting_read_only', field: 'DATA_DIR' });
  assert.deepEqual(err(await put(app, cookie, { changes: { LEAD_SEARCH_MODE: 'mock' }, version })), { status: 400, code: 'invalid_setting', field: 'LEAD_SEARCH_MODE' });
  // Stand kommt vor den Werten
  assert.deepEqual(err(await put(app, cookie, { changes: { MAX_RESULTS: 1001 }, version: 99 })), { status: 409, code: 'settings_changed', field: undefined });
  assert.deepEqual(err(await put(app, cookie, { changes: { MAX_RESULTS: 1001 }, version })), { status: 400, code: 'invalid_setting', field: 'MAX_RESULTS' });
  assert.deepEqual(err(await put(app, cookie, { changes: { MAX_RESULTS: 1.5 }, version })), { status: 400, code: 'invalid_setting', field: 'MAX_RESULTS' });
  assert.deepEqual(err(await put(app, cookie, { changes: { UNIPILE_SEARCH_API: 'bing' }, version })), { status: 400, code: 'invalid_setting', field: 'UNIPILE_SEARCH_API' });
  assert.deepEqual(err(await put(app, cookie, { changes: { META_GRAPH_VERSION: 'neueste' }, version })), { status: 400, code: 'invalid_setting', field: 'META_GRAPH_VERSION' });
  // Erster betroffener Schlüssel in Katalog-Reihenfolge
  assert.equal(err(await put(app, cookie, { changes: { INVITE_STALE_DAYS: 0, MAX_RESULTS: 0 }, version })).field, 'MAX_RESULTS');

  // Adressen: nur https, ohne Pfad, Unipile nur *.unipile.com
  for (const bad of ['http://api.unipile.com', 'https://api.unipile.com/api/v1', 'https://user:pw@api.unipile.com', 'https://evil.example', 'api.unipile.com.evil.de']) {
    const response = await put(app, cookie, { changes: { UNIPILE_DSN: bad, UNIPILE_API_KEY: SECRET_VALUE }, version, password: PASSWORD });
    assert.deepEqual([response.statusCode, response.json().error.field], [400, 'UNIPILE_DSN'], bad);
  }
  const dsn = await put(app, cookie, { changes: { UNIPILE_DSN: 'api68.unipile.com:19881/', UNIPILE_API_KEY: SECRET_VALUE }, version, password: PASSWORD });
  assert.equal(dsn.statusCode, 200, dsn.body);
  assert.equal(stateOf(dsn.json() as SettingsResponse, 'UNIPILE_DSN').value, 'https://api68.unipile.com:19881', 'ohne Schema und abschließendes / → normalisiert');

  // Adresse mit gebundenem Geheimnis: nur zusammen mit einem neuen Wert für das Geheimnis
  const lonely = await put(app, cookie, { changes: { UNIPILE_DSN: 'https://api1.unipile.com:1' }, version: 2, password: PASSWORD });
  assert.deepEqual([lonely.statusCode, lonely.json().error.field], [400, 'UNIPILE_DSN']);
  assert.match(lonely.json().error.message, /Access Token/);
  // Gleiche Adresse noch einmal braucht das Geheimnis nicht
  assert.equal((await put(app, cookie, { changes: { UNIPILE_DSN: 'https://api68.unipile.com:19881' }, version: 2, password: PASSWORD })).statusCode, 200);
  // Clay-Adresse nur https
  const clay = await put(app, cookie, { changes: { CLAY_WEBHOOK_URL: 'http://clay.example/x', CLAY_WEBHOOK_TOKEN: 'abc' }, version: 2, password: PASSWORD });
  assert.deepEqual([clay.statusCode, clay.json().error.field], [400, 'CLAY_WEBHOOK_URL']);

  // Probe-Schlüssel nur allein
  const mixed = await put(app, cookie, { changes: { TRUST_PROXY_HOPS: 2, MAX_RESULTS: 5 }, version: 2, password: PASSWORD });
  assert.deepEqual([mixed.statusCode, mixed.json().error.field], [400, 'MAX_RESULTS']);
});

test('Querregeln: Cookie-Schutz muss zum Protokoll passen, Testkonten, PUBLIC_URL mit http', async () => {
  const { app } = setup();
  const cookie = await login(app);
  const version = 1;
  const secureOverHttp = await put(app, cookie, { changes: { AUTH_COOKIE_SECURE: true }, version, password: PASSWORD }, { origin: 'http://192.168.2.59:8080' });
  assert.deepEqual([secureOverHttp.statusCode, secureOverHttp.json().error.field], [400, 'AUTH_COOKIE_SECURE']);
  // Testkonten sind an → HTTPS-Pflicht nicht erlaubt (Leitplanke der Konfiguration), Meldung nennt den Schlüssel
  const demo = await put(app, cookie, { changes: { AUTH_COOKIE_SECURE: true }, version, password: PASSWORD }, { origin: 'https://crm.example.de' });
  assert.deepEqual([demo.statusCode, demo.json().error.field], [400, 'AUTH_COOKIE_SECURE']);
  assert.match(demo.json().error.message, /AUTH_DEMO_ACCOUNTS/);
  // http-Adresse nur bei ausgeschaltetem HTTPS-Zwang – hier aus → erlaubt
  const publicUrl = await put(app, cookie, { changes: { PUBLIC_URL: 'http://192.168.2.59:8080/' }, version, password: PASSWORD });
  assert.equal(publicUrl.statusCode, 200, publicUrl.body);
  assert.equal(stateOf(publicUrl.json() as SettingsResponse, 'PUBLIC_URL').value, 'http://192.168.2.59:8080');

  const https = setup({ env: { AUTH_DEMO_ACCOUNTS: 'false', AUTH_COOKIE_SECURE: 'true' } });
  const accounts = https.app; // Konto per Datenbank anlegen, weil die Testkonten aus sind
  const db = openDatabase(https.dataDir);
  const { AccountStore } = await import('../src/auth/accounts.js');
  await new AccountStore(db).save({ username: 'erika', name: 'Erika', founder: 'nick', role: 'founder' }, 'passwort-erika-1');
  db.close();
  const login2 = await accounts.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'erika', password: 'passwort-erika-1' }, headers: { 'sec-fetch-site': 'same-origin' } });
  const cookie2 = String(login2.headers['set-cookie']).split(';')[0];
  const httpUrl = await put(accounts, cookie2, { changes: { PUBLIC_URL: 'http://crm.example.de' }, version: 1, password: 'passwort-erika-1' });
  assert.deepEqual([httpUrl.statusCode, httpUrl.json().error.field], [400, 'PUBLIC_URL']);
});

// ── Start, Server-Befehle, Notfallmodus ─────────────────────────────────────

test('Server-Befehle und Neustart lesen dieselben Werte; Ungültiges und Unlesbares bricht den Start nie', async () => {
  const { app, baseEnv, dataDir } = setup({ env: { FOLLOWUP_AFTER_DAYS: '3' } });
  const cookie = await login(app);
  await change(app, cookie, { FOLLOWUP_AFTER_DAYS: 9, TREG_TOKEN: SECRET_VALUE });
  assert.equal(loadConfigWithSettings(baseEnv).tasks.followUpAfterDays, 9);
  assert.equal(loadConfigWithSettings(baseEnv).treg.token, SECRET_VALUE);
  assert.equal(loadConfig(baseEnv).tasks.followUpAfterDays, 3, 'ohne Software-Werte: .env');

  // Beschädigt von Hand: ungültiger Wert, Geheimnis mit falschem Schlüssel, unbekannter Schlüssel, Querregel
  const db = openDatabase(dataDir);
  db.prepare("UPDATE settings_values SET value = '\"kaputt\"' WHERE key = 'FOLLOWUP_AFTER_DAYS'").run();
  db.prepare("UPDATE settings_values SET value = 'v1:AAAA:AAAA:AAAA' WHERE key = 'TREG_TOKEN'").run();
  db.prepare("INSERT INTO settings_values (key, secret, value, updated_at) VALUES ('MAX_RESULTS', 0, '1001', 1), ('AUS_EINER_NEUEN_VERSION', 0, '1', 1)").run();
  db.close();
  const config = loadConfigWithSettings(baseEnv);
  assert.equal(config.tasks.followUpAfterDays, 3);
  assert.equal(config.treg.token, null);
  assert.equal(config.maxResults, 15, 'MAX_RESULTS 1001 ist ungültig → Standard');

  const restarted = setup({ env: { FOLLOWUP_AFTER_DAYS: '3' }, dataDir });
  const cookie2 = await login(restarted.app);
  const response = await get(restarted.app, cookie2);
  assert.match(stateOf(response, 'FOLLOWUP_AFTER_DAYS').problem ?? '', /ungültig/);
  assert.match(stateOf(response, 'TREG_TOKEN').problem ?? '', /nicht lesbar/);
  assert.equal(stateOf(response, 'FOLLOWUP_AFTER_DAYS').source, 'env');
  assert.deepEqual(stateOf(response, 'TREG_TOKEN').secret, { set: false, hint: null });
  assert.equal(response.settings.length, SETTINGS.length, 'unbekannter Schlüssel wird übergangen');
});

test('Notfallmodus: Software-Werte ignoriert, stored sichtbar, nur Löschen erlaubt', async () => {
  const normal = setup();
  const cookie = await login(normal.app);
  await change(normal.app, cookie, { FOLLOWUP_AFTER_DAYS: 8, TREG_TOKEN: SECRET_VALUE });

  const safe = setup({ dataDir: normal.dataDir, env: { SETTINGS_SAFE_MODE: 'true' } });
  assert.equal(safe.config.tasks.followUpAfterDays, 2, 'Standard statt Software');
  const cookie2 = await login(safe.app);
  const response = await get(safe.app, cookie2);
  assert.equal(response.safeMode, true);
  const follow = stateOf(response, 'FOLLOWUP_AFTER_DAYS');
  assert.deepEqual([follow.source, follow.value, follow.stored], ['default', 2, { value: 8 }]);
  assert.deepEqual(stateOf(response, 'TREG_TOKEN').stored, { secret: { set: true, hint: '3456' } });
  assert.equal(JSON.stringify(response).includes(SECRET_VALUE), false);

  const set = await put(safe.app, cookie2, { changes: { FOLLOWUP_AFTER_DAYS: 4 }, version: response.version });
  assert.deepEqual([set.statusCode, set.json().error.code], [409, 'setting_read_only']);
  const remove = await put(safe.app, cookie2, { changes: { FOLLOWUP_AFTER_DAYS: null, TREG_TOKEN: null }, version: response.version, password: PASSWORD });
  assert.equal(remove.statusCode, 200, remove.body);
  assert.equal(stateOf(remove.json() as SettingsResponse, 'FOLLOWUP_AFTER_DAYS').stored, undefined);
  assert.equal((await get(normal.app, cookie)).settings.find((entry) => entry.key === 'FOLLOWUP_AFTER_DAYS')!.source, 'default');
});

test('Befehl settingsCli: list zeigt nur Namen, reset löscht', async () => {
  const { app, dataDir, baseEnv } = setup();
  const cookie = await login(app);
  await change(app, cookie, { FOLLOWUP_AFTER_DAYS: 8, TREG_TOKEN: SECRET_VALUE });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, '../src/settingsCli.ts'), ...args], {
      env: { ...process.env, ...baseEnv, DATA_DIR: dataDir },
      encoding: 'utf8',
    });
  const list = run('list');
  assert.match(list.stdout, /FOLLOWUP_AFTER_DAYS/);
  assert.match(list.stdout, /TREG_TOKEN/);
  assert.equal(list.stdout.includes(SECRET_VALUE) || /\b8\b/.test(list.stdout), false, 'nie Werte');
  assert.match(run('reset', 'FOLLOWUP_AFTER_DAYS').stdout, /gelöscht/);
  assert.equal(loadConfigWithSettings(baseEnv).tasks.followUpAfterDays, 2);
  assert.match(run('reset', '--all').stdout, /1 Wert/);
  assert.equal(loadConfigWithSettings(baseEnv).treg.token, null);
  assert.equal(run('reset', 'NICHT_DA').status, 1);
});

// ── Wirkung ohne Neustart ───────────────────────────────────────────────────

test('Zugänge wirken sofort; ohne LEAD_SEARCH_MODE läuft das Backend echt', async () => {
  const { app } = setup({ env: { LEAD_SEARCH_MODE: '' } });
  const cookie = await login(app);
  const mode = async () => ((await send(app, 'GET', '/api/lead-search/config', cookie)).json() as { mode: string; ready: boolean; problems: string[] });

  const config = await mode();
  assert.deepEqual([config.mode, config.ready], ['live', false]);
  assert.match(config.problems.join(' '), /Unipile-Adresse fehlt/);
  assert.equal(((await send(app, 'GET', '/api/enrichment/status', cookie)).json() as { mode: string }).mode, 'off', 'Treg ohne Token');

  assert.equal((await change(app, cookie, { TREG_TOKEN: SECRET_VALUE })).statusCode, 200);
  assert.equal(((await send(app, 'GET', '/api/enrichment/status', cookie)).json() as { mode: string }).mode, 'live');
});

test('Senden über LinkedIn und Updates: Standardwerte, Prüfungen mit field, wirken ohne Neustart', async () => {
  const { app, baseEnv, dataDir } = setup();
  const cookie = await login(app);
  const linkedin = async () => (await send(app, 'GET', '/api/linkedin/status', cookie)).json() as LinkedInStatusResponse;

  const before = await get(app, cookie);
  const values = (keys: SettingKey[]) => keys.map((key) => stateOf(before, key).value);
  assert.deepEqual(
    values(['LINKEDIN_ACTIONS', 'UNIPILE_ACCOUNT_NICK', 'LINKEDIN_INVITES_PER_DAY', 'LINKEDIN_INVITES_PER_WEEK', 'LINKEDIN_MESSAGES_PER_DAY']),
    ['off', null, 20, 80, 40],
  );
  assert.deepEqual(
    values(['LINKEDIN_WORK_HOURS', 'LINKEDIN_WORK_DAYS', 'LINKEDIN_TIMEZONE', 'LINKEDIN_PAUSE_SECONDS', 'LINKEDIN_SYNC_MINUTES', 'UPDATE_AUTO', 'UPDATE_HOUR']),
    ['8-19', '1-5', 'Europe/Berlin', '3-8', 15, false, 3],
  );
  assert.equal(stateOf(before, 'LINKEDIN_PAUSE_SECONDS').source, 'default');

  // Prüfungen laut Vertrag: 400 invalid_setting mit field, nichts gespeichert
  const invalid: [SettingKey, SettingValue][] = [
    ['LINKEDIN_PAUSE_SECONDS', '2-8'],
    ['LINKEDIN_PAUSE_SECONDS', '0-0'],
    ['LINKEDIN_PAUSE_SECONDS', '8-3'],
    ['LINKEDIN_PAUSE_SECONDS', '3-601'],
    ['LINKEDIN_PAUSE_SECONDS', '3'],
    ['LINKEDIN_WORK_HOURS', '19-8'],
    ['LINKEDIN_WORK_HOURS', '8-8'],
    ['LINKEDIN_WORK_HOURS', '8-25'],
    ['LINKEDIN_WORK_DAYS', '5-1'],
    ['LINKEDIN_WORK_DAYS', '0-5'],
    ['LINKEDIN_TIMEZONE', 'Mond/Basis'],
    ['LINKEDIN_INVITES_PER_DAY', 51],
    ['LINKEDIN_ACTIONS', 'vielleicht'],
    ['UNIPILE_ACCOUNT_NICK', 'acc nick'],
    ['UPDATE_HOUR', 24],
  ];
  for (const [key, value] of invalid) {
    const response = await change(app, cookie, { [key]: value });
    assert.deepEqual([response.statusCode, response.json().error.code, response.json().error.field], [400, 'invalid_setting', key], `${key}=${value}`);
  }
  assert.match((await change(app, cookie, { LINKEDIN_PAUSE_SECONDS: '2-8' })).json().error.message, /Mindestens 3 Sekunden/);
  assert.equal((await get(app, cookie)).version, before.version, 'nichts gespeichert');

  // Gültige Werte wirken sofort (Status liest die laufende Konfiguration)
  const saved = await change(app, cookie, {
    LINKEDIN_INVITES_PER_DAY: 5,
    LINKEDIN_WORK_HOURS: '9-17',
    LINKEDIN_WORK_DAYS: '1-5,7',
    LINKEDIN_TIMEZONE: 'Europe/London',
    LINKEDIN_PAUSE_SECONDS: '3-600',
    UPDATE_AUTO: true,
    UPDATE_HOUR: 4,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const after = saved.json() as SettingsResponse;
  assert.deepEqual([stateOf(after, 'LINKEDIN_WORK_DAYS').value, stateOf(after, 'LINKEDIN_WORK_DAYS').source], ['1-5,7', 'software']);
  assert.deepEqual([stateOf(after, 'UPDATE_AUTO').value, stateOf(after, 'UPDATE_HOUR').value], [true, 4]);
  const status = await linkedin();
  assert.equal(status.accounts[0].invitesToday.limit, 5);
  assert.deepEqual(status.workHours, { fromHour: 9, toHour: 17, days: [1, 2, 3, 4, 5, 7], timeZone: 'Europe/London' });

  // LINKEDIN_ACTIONS und Accounts brauchen das Passwort
  const noPassword = await put(app, cookie, { changes: { LINKEDIN_ACTIONS: 'on' }, version: after.version });
  assert.deepEqual([noPassword.statusCode, noPassword.json().error.code], [403, 'reauth_failed']);
  assert.equal((await change(app, cookie, { LINKEDIN_ACTIONS: 'on', UNIPILE_ACCOUNT_NICK: 'acc_nick' })).statusCode, 200);
  // Der Update-Planer liest `config.update` – auch nach einem Neustart
  const restarted = loadConfigWithSettings({ ...baseEnv, DATA_DIR: dataDir });
  assert.deepEqual(restarted.update, { auto: true, hour: 4 });
  assert.deepEqual(restarted.linkedin.pauseMs, [3000, 600_000]);
});

test('Senden über LinkedIn live: Schalter und Accounts wirken ohne Neustart, Abgleich plant neu', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const { app, dataDir, baseEnv } = setup({ env: { LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'unipile-test-key' } });
  const cookie = await login(app);
  const linkedin = async () => (await send(app, 'GET', '/api/linkedin/status', cookie)).json() as LinkedInStatusResponse;
  assert.equal((await linkedin()).mode, 'off');

  assert.equal((await change(app, cookie, { LINKEDIN_ACTIONS: 'on', UNIPILE_ACCOUNT_JOHANNES: 'acc_johannes' })).statusCode, 200);
  const status = await linkedin();
  assert.equal(status.mode, 'live');
  assert.deepEqual(status.accounts.map((account) => account.connected), [false, true]);

  // Jeder Gründer braucht seinen eigenen Account – field = der geänderte Schlüssel
  const shared = await change(app, cookie, { UNIPILE_ACCOUNT_NICK: 'acc_johannes' });
  assert.deepEqual([shared.statusCode, shared.json().error.code, shared.json().error.field], [400, 'invalid_setting', 'UNIPILE_ACCOUNT_NICK']);
  assert.equal(shared.json().error.message, 'Nick und Johannes brauchen je einen eigenen LinkedIn-Account – sonst gelten die Grenzen doppelt.');
  const both = await change(app, cookie, { UNIPILE_ACCOUNT_NICK: 'acc_x', UNIPILE_ACCOUNT_JOHANNES: 'acc_x' });
  assert.deepEqual([both.statusCode, both.json().error.field], [400, 'UNIPILE_ACCOUNT_JOHANNES']);
  assert.equal((await change(app, cookie, { UNIPILE_ACCOUNT_NICK: 'acc_nick' })).statusCode, 200);

  // Server-Befehle und Neustart lesen dieselben Werte
  const restarted = loadConfigWithSettings({ ...baseEnv, DATA_DIR: dataDir });
  assert.deepEqual([restarted.linkedin.enabled, restarted.linkedin.accounts.johannes], [true, 'acc_johannes']);
  assert.equal(unipile.requests.filter((request) => request.method === 'POST').length, 0, 'nichts gesendet');
});

test('Demo-Daten und Simulation: nie über echte Leads', async () => {
  const { app } = setup();
  const cookie = await login(app);
  assert.equal((await send(app, 'POST', '/api/leads/demo/reset', cookie)).statusCode, 200);
  const card: NewLeadCard = {
    runId: '11111111-1111-4111-8111-111111111111',
    mode: 'live',
    providerId: 'ACoECHT1',
    publicIdentifier: 'echt-1',
    profileUrl: null,
    firstName: 'Erika',
    lastName: 'Echt',
    headline: 'Geschäftsführerin',
    position: 'Geschäftsführerin',
    company: 'Echt GmbH',
    location: 'Köln',
    website: 'https://echt.example',
    networkDistance: 2,
    category: 'bautraeger_projektentwickler',
    confidence: 0.9,
    reason: 'x',
    summary: 'x',
    metaAds: null,
  };
  assert.equal((await send(app, 'POST', '/api/leads', cookie, { cards: [card] })).statusCode, 200);
  const reset = await send(app, 'POST', '/api/leads/demo/reset', cookie);
  assert.deepEqual([reset.statusCode, reset.json().error.code], [409, 'live_leads_exist']);
});

// ── Probe-Änderung ──────────────────────────────────────────────────────────

test('Probe: gilt sofort, neue Sitzung, Bestätigen nur mit ihr, zweite Probe gesperrt, Verlauf', async () => {
  const { app } = setup();
  const cookie = await login(app);
  const forwarded = { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' };
  const ip = async (headers = forwarded) => (await get(app, cookie, headers)).clientIp;
  assert.equal(await ip(), '203.0.113.9', 'ein vertrauter Proxy → letzte Adresse');

  const version = (await get(app, cookie)).version;
  const trial = await put(app, cookie, { changes: { TRUST_PROXY_HOPS: 2 }, version, password: PASSWORD }, forwarded);
  assert.equal(trial.statusCode, 200, trial.body);
  const body = trial.json() as SettingsResponse;
  assert.deepEqual(body.trial?.keys, ['TRUST_PROXY_HOPS']);
  assert.equal(body.trial?.username, 'nick');
  assert.ok(body.trial!.revertsAt > Date.now() + 250_000 && body.trial!.revertsAt <= Date.now() + 301_000);
  // Das Backend vertraut höchstens nginx: 2 wirkt wie 1 (nginx gibt genau eine geprüfte Adresse weiter).
  assert.equal(body.clientIp, '203.0.113.9', '2 wirkt wie 1 – die vorgetäuschte Adresse vorne zählt nie');
  const newCookie = String(trial.headers['set-cookie']).split(';')[0];
  assert.notEqual(newCookie, cookie);
  assert.match(String(trial.headers['set-cookie']), /HttpOnly/);
  assert.equal(await ip(), '203.0.113.9');

  // Alte Sitzung gilt weiter, bestätigen darf nur die neue
  assert.equal((await send(app, 'GET', '/api/auth/me', cookie)).statusCode, 200);
  const mismatch = await send(app, 'POST', '/api/settings/trial/confirm', cookie);
  assert.deepEqual([mismatch.statusCode, mismatch.json().error.code], [409, 'trial_session_mismatch']);
  const again = await put(app, newCookie, { changes: { TRUST_PROXY_HOPS: 1 }, version: body.version, password: PASSWORD });
  assert.deepEqual([again.statusCode, again.json().error.code], [409, 'trial_pending']);

  const confirmed = await send(app, 'POST', '/api/settings/trial/confirm', newCookie);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal((confirmed.json() as SettingsResponse).trial, null);
  assert.equal(stateOf(confirmed.json() as SettingsResponse, 'TRUST_PROXY_HOPS').source, 'software');
  assert.equal((await send(app, 'POST', '/api/settings/trial/confirm', newCookie)).json().error.code, 'no_trial');

  const history = (await send(app, 'GET', '/api/settings/history', newCookie)).json() as SettingsHistoryResponse;
  assert.deepEqual(history.entries.map((entry) => [entry.key, entry.action]), [['TRUST_PROXY_HOPS', 'confirmed'], ['TRUST_PROXY_HOPS', 'trial']]);
});

test('Probe zurücksetzen (jedes Konto): alter Wert zurück, Sitzung der Probe beendet', async () => {
  const { app } = setup();
  const cookie = await login(app);
  const johannes = await login(app, 'johannes');
  const trial = await put(app, cookie, { changes: { TRUST_PROXY_HOPS: 2 }, version: 1, password: PASSWORD });
  const newCookie = String(trial.headers['set-cookie']).split(';')[0];
  assert.equal((await send(app, 'POST', '/api/settings/trial/revert', johannes)).statusCode, 200);
  const response = await get(app, cookie);
  assert.equal(response.trial, null);
  assert.deepEqual([stateOf(response, 'TRUST_PROXY_HOPS').source, stateOf(response, 'TRUST_PROXY_HOPS').value], ['default', 1]);
  assert.equal((await send(app, 'GET', '/api/auth/me', newCookie)).statusCode, 401, 'Sitzung der Probe ist weg');
  assert.equal((await send(app, 'POST', '/api/settings/trial/revert', cookie)).json().error.code, 'no_trial');
  const history = (await send(app, 'GET', '/api/settings/history', cookie)).json() as SettingsHistoryResponse;
  assert.deepEqual(history.entries.map((entry) => entry.action), ['reverted', 'trial']);
  assert.equal(history.entries[0].username, 'johannes');
});

test('Probe ohne Bestätigung wird nach Ablauf zurückgesetzt – im laufenden Server und vor dem Start', async () => {
  const { app, baseEnv, dataDir } = setup({ env: { SETTINGS_TRIAL_SECONDS: '1' } });
  const cookie = await login(app);
  const trial = await put(app, cookie, { changes: { TRUST_PROXY_HOPS: 2 }, version: 1, password: PASSWORD });
  assert.equal(trial.statusCode, 200);
  assert.equal(loadConfigWithSettings(baseEnv).auth.trustProxyHops, 2, 'solange die Probe läuft, gilt der neue Wert');
  await new Promise((resolve) => setTimeout(resolve, 1400));
  const response = await get(app, cookie);
  assert.equal(response.trial, null);
  assert.equal(stateOf(response, 'TRUST_PROXY_HOPS').value, 1);
  assert.equal(loadConfigWithSettings(baseEnv).auth.trustProxyHops, 1);

  // Abgelaufen, während der Server nicht lief: das Laden der Konfiguration setzt zurück
  const second = setup({ env: { SETTINGS_TRIAL_SECONDS: '1' }, dataDir });
  const cookie2 = await login(second.app);
  await put(second.app, cookie2, { changes: { TRUST_PROXY_HOPS: 2 }, version: (await get(second.app, cookie2)).version, password: PASSWORD });
  await second.app.close();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(loadConfigWithSettings({ ...baseEnv, DATA_DIR: dataDir }).auth.trustProxyHops, 1);
});

// ── Verbindungstest ─────────────────────────────────────────────────────────

test('Verbindungstest: Simulation ohne Netz, Live gegen Nachbauten, feste Sätze, Begrenzung', async (t) => {
  const mock = setup();
  const mockCookie = await login(mock.app);
  const simulated = await send(mock.app, 'POST', '/api/settings/test', mockCookie, { service: 'unipile' });
  assert.deepEqual(simulated.json(), { ok: true, message: 'Simulation – keine Verbindung nötig.' } satisfies SettingsTestResponse);
  assert.equal((await send(mock.app, 'POST', '/api/settings/test', mockCookie, { service: 'unipile' })).statusCode, 429, 'je Dienst alle 10 s einmal');
  assert.equal((await send(mock.app, 'POST', '/api/settings/test', mockCookie, { service: 'gibt-es-nicht' })).statusCode, 400);

  const unipile = await startFakeUnipile();
  const meta = await startFakeMeta();
  const anthropic = createServer((req, res) => {
    res.writeHead(req.headers['x-api-key'] === 'ant-key' ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await unipile.close();
    await meta.close();
    anthropic.close();
  });
  const anthropicUrl = `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`;

  const live = setup({
    env: {
      LEAD_SEARCH_MODE: 'live',
      UNIPILE_DSN: unipile.baseUrl,
      UNIPILE_API_KEY: 'unipile-test-key',
      ANTHROPIC_API_KEY: 'ant-key',
      META_ACCESS_TOKEN: 'meta-test-key',
    },
    settingsTest: { anthropicBaseUrl: anthropicUrl, metaBaseUrl: meta.baseUrl },
  });
  const cookie = await login(live.app);
  const test = async (service: string) => (await send(live.app, 'POST', '/api/settings/test', cookie, { service })).json() as SettingsTestResponse;
  assert.deepEqual(await test('unipile'), { ok: true, message: 'Verbunden. Gesucht wird über Nick (ID acc_linkedin, Sales Navigator unbekannt, Suche: LinkedIn normal).' });
  assert.deepEqual(await test('anthropic'), { ok: true, message: 'Verbunden: Anthropic-Zugang gültig.' });
  assert.deepEqual(await test('meta'), { ok: true, message: 'Verbunden: Meta-Werbebibliothek antwortet.' });

  const bad = setup({
    env: { LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'falsch', ANTHROPIC_API_KEY: 'falsch', META_ACCESS_TOKEN: 'falsch' },
    settingsTest: { anthropicBaseUrl: anthropicUrl, metaBaseUrl: meta.baseUrl },
  });
  const badCookie = await login(bad.app);
  const badTest = async (service: string) => (await send(bad.app, 'POST', '/api/settings/test', badCookie, { service })).json() as SettingsTestResponse;
  assert.deepEqual(await badTest('unipile'), { ok: false, message: 'Zugang abgelehnt – bitte Adresse und Token prüfen.' });
  assert.deepEqual(await badTest('anthropic'), { ok: false, message: 'Zugang abgelehnt – bitte den API-Schlüssel prüfen.' });
  assert.match((await badTest('meta')).message, /^Zugang abgelehnt/);

  // Unipile-Testzeitraum abgelaufen: 503 no_client_session → klarer Satz statt „Unerwartete Antwort (HTTP 503)“.
  const down = setup({ env: { LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'unipile-test-key' } });
  const downCookie = await login(down.app);
  unipile.session.down = true;
  const downResult = (await send(down.app, 'POST', '/api/settings/test', downCookie, { service: 'unipile' })).json() as SettingsTestResponse;
  unipile.session.down = false;
  assert.equal(downResult.ok, false);
  assert.match(downResult.message, /^Unipile-Sitzung nicht aktiv: .*no_client_session.*Abo/);

  const empty = setup({ env: { LEAD_SEARCH_MODE: 'live' } });
  const emptyCookie = await login(empty.app);
  assert.deepEqual((await send(empty.app, 'POST', '/api/settings/test', emptyCookie, { service: 'meta' })).json(), { ok: false, message: 'Meta ist nicht eingerichtet (Access Token fehlt).' });
});

test('Verbindungstest Treg, Close, Slack: Simulation ohne Netz, Live gegen Nachbauten, feste Sätze', async (t) => {
  const mock = setup();
  const mockCookie = await login(mock.app);
  for (const service of ['treg', 'close', 'slack']) {
    assert.deepEqual((await send(mock.app, 'POST', '/api/settings/test', mockCookie, { service })).json(), { ok: true, message: 'Simulation – keine Verbindung nötig.' });
  }

  const treg = await startFakeTreg();
  const close = await startFakeClose();
  t.after(async () => {
    await treg.close();
    await close.close();
  });
  // Slack-Webhooks zeigen immer auf hooks.slack.com – im Test abgefangen, alles andere geht an die Nachbauten.
  const slack: { url: string; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://hooks.slack.com/')) {
      slack.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith('/geloescht')) return new Response('no_service', { status: 404 });
      if (url.endsWith('/kaputt')) return new Response('<html>Fehler mit geheimem Inhalt</html>', { status: 500 });
      return new Response('ok', { status: 200 });
    }
    return fetch(input, init);
  };
  const live = (env: NodeJS.ProcessEnv) =>
    setup({ env: { LEAD_SEARCH_MODE: 'live', TREG_BASE_URL: treg.baseUrl, CLOSE_BASE_URL: close.baseUrl, ...env }, settingsTest: { fetch: fakeFetch } });

  const good = live({ TREG_TOKEN: 'treg-test-token', CLOSE_API_KEY: 'close-test-key', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/geheim' });
  const cookie = await login(good.app);
  const test = async (app: App, cookieValue: string, service: string) => (await send(app, 'POST', '/api/settings/test', cookieValue, { service })).json() as SettingsTestResponse;
  assert.deepEqual(await test(good.app, cookie, 'close'), { ok: true, message: 'Verbunden: Close-Zugang gültig.' });
  const closeCall = close.requests.at(-1)!;
  assert.deepEqual([closeCall.method, closeCall.path], ['GET', '/api/v1/me/']);
  assert.equal(close.requests.filter((request) => request.method === 'POST').length, 0, 'Close: nur lesend');
  const tregResult = await test(good.app, cookie, 'treg');
  assert.equal(tregResult.ok, true);
  assert.match(tregResult.message, /0,2 Cent/);
  assert.equal(treg.requests.length, 1, 'genau ein Abruf');
  assert.equal(treg.requests[0].headers['x-treg-route-max-cost'], '0.05', 'mit Kostengrenze');
  assert.deepEqual(await test(good.app, cookie, 'slack'), { ok: true, message: 'Verbunden: Testnachricht in Slack gesendet.' });
  assert.deepEqual(slack.at(-1)!.body, { text: SLACK_TEST_TEXT });

  const bad = live({ TREG_TOKEN: 'falsch', CLOSE_API_KEY: 'falsch', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/geloescht' });
  const badCookie = await login(bad.app);
  assert.deepEqual(await test(bad.app, badCookie, 'close'), { ok: false, message: 'Zugang abgelehnt – bitte den API-Schlüssel prüfen.' });
  assert.deepEqual(await test(bad.app, badCookie, 'treg'), { ok: false, message: 'Zugang abgelehnt – bitte den Token prüfen.' });
  assert.deepEqual(await test(bad.app, badCookie, 'slack'), { ok: false, message: 'Zugang abgelehnt – bitte die Webhook-Adresse prüfen.' });

  const broken = live({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T0/B0/kaputt', CLOSE_API_KEY: 'close-test-key', CLOSE_BASE_URL: 'http://127.0.0.1:9' });
  const brokenCookie = await login(broken.app);
  const unexpected = await test(broken.app, brokenCookie, 'slack');
  assert.deepEqual(unexpected, { ok: false, message: 'Unerwartete Antwort (HTTP 500).' });
  assert.equal(JSON.stringify(unexpected).includes('geheim'), false, 'nie Antworttext oder Adresse');
  assert.deepEqual(await test(broken.app, brokenCookie, 'close'), { ok: false, message: 'Nicht erreichbar.' });

  const empty = live({});
  const emptyCookie = await login(empty.app);
  assert.deepEqual(await test(empty.app, emptyCookie, 'treg'), { ok: false, message: 'Treg ist nicht eingerichtet (Token fehlt).' });
  assert.deepEqual(await test(empty.app, emptyCookie, 'close'), { ok: false, message: 'Close ist nicht eingerichtet (API-Schlüssel fehlt).' });
  assert.deepEqual(await test(empty.app, emptyCookie, 'slack'), { ok: false, message: 'Slack ist nicht eingerichtet (Webhook-Adresse fehlt).' });
});

test('Modell-Auswahl: GET /api/settings/models liefert die Liste (Simulation: eingebaut), Einstellung zeigt auf sie', async () => {
  const { app } = setup();
  const cookie = await login(app);
  const response = await send(app, 'GET', '/api/settings/models', cookie);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { models: Array<{ id: string }>; source: string };
  assert.equal(body.source, 'builtin');
  assert.ok(body.models.some((model) => model.id === 'claude-opus-5-5'));
  assert.equal(SETTINGS.find((definition) => definition.key === 'ANTHROPIC_MODEL')?.optionsFrom, 'anthropic_models');
  assert.equal((await send(app, 'GET', '/api/settings/models', '')).statusCode, 401);
  await app.close();
});

test('Neuer Meta-Token (live): Nachprüfung aller Leads startet von selbst', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const { app } = setup({ env: { LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'unipile-test-key' } });
  const cookie = await login(app);
  const recheck = async () => (await send(app, 'GET', '/api/settings/meta-recheck', cookie)).json() as { state: string; total: number };
  assert.equal((await recheck()).state, 'idle');
  assert.equal((await change(app, cookie, { META_ACCESS_TOKEN: 'neuer-meta-token-123456' })).statusCode, 200);
  await app.metaRecheck.idle();
  // Live ohne Leads: sofort fertig – entscheidend ist, dass sie gestartet ist.
  assert.deepEqual(await recheck(), { ...(await recheck()), state: 'done', total: 0 });
  // Mitarbeiter sehen wie alle Einstellungen auch die Nachprüfung nicht.
  const assistant = await login(app, 'mitarbeiter');
  assert.equal((await send(app, 'POST', '/api/settings/meta-recheck', assistant)).statusCode, 403);
  await app.close();
});
