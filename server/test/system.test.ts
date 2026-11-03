import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { BackupInfo, BackupListResponse, RestoreResponse, UpdateStatusResponse } from '../../shared/system.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { backupDir } from '../src/db/backup.js';
import { DATABASE_FILE } from '../src/db/database.js';
import { RESTORE_FILE, applyPendingRestore } from '../src/system/backups.js';
import { UPDATER_NOT_RESPONDING_REASON, UPDATER_RESTARTING_REASON, UPDATER_UNAVAILABLE_REASON, UpdateService } from '../src/system/updates.js';
import { tempDataDir } from './helpers.js';

const PASSWORD = 'demo';

function setup(env: NodeJS.ProcessEnv = {}, options: { restart?: () => void } = {}) {
  const dataDir = tempDataDir();
  const baseEnv: NodeJS.ProcessEnv = {
    LEAD_SEARCH_MODE: 'mock',
    DATA_DIR: dataDir,
    AUTH_DEMO_ACCOUNTS: 'true',
    AUTH_COOKIE_SECURE: 'false',
    MOCK_SPEED: '0',
    // Kein Update-Dienst in Tests (Standardpfad /shared/… gibt es hier nicht – sicherheitshalber umbiegen).
    UPDATER_TOKEN_FILE: path.join(dataDir, 'gibt-es-nicht.token'),
    MOCK_UPDATE_SECONDS: '0.05',
    ...env,
  };
  const app = buildApp({ config: loadConfig(baseEnv), adapter: new MockAdapter(0), env: baseEnv, logger: false, requireSession: true, restartProcess: options.restart });
  return { app, dataDir };
}

type App = ReturnType<typeof setup>['app'];

async function login(app: App, username = 'nick'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
}

const req = (app: App, cookie: string, method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { cookie, ...headers } });

const errorOf = (response: { statusCode: number; json: () => { error: { code: string } } }) => [response.statusCode, response.json().error.code];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Sicherungen ─────────────────────────────────────────────────────────────

test('Sicherungen: anlegen, auflisten, Arten, nächster Termin', async () => {
  const { app, dataDir } = setup({ BACKUP_HOUR_UTC: '2', BACKUP_KEEP: '5' });
  const nick = await login(app);
  const empty = (await req(app, nick, 'GET', '/api/system/backups')).json() as BackupListResponse;
  assert.deepEqual(empty.backups, []);
  assert.equal(empty.keep, 5);
  assert.equal(empty.lastError, null);
  assert.ok(empty.nextAt! > Date.now() && empty.nextAt! <= Date.now() + 24 * 3600_000);

  const created = await req(app, nick, 'POST', '/api/system/backups');
  assert.equal(created.statusCode, 200, created.body);
  const info = created.json() as BackupInfo;
  assert.match(info.name, /^manuell-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/);
  assert.equal(info.kind, 'manual');
  assert.ok(info.size > 0);
  assert.ok(Math.abs(info.createdAt - Date.now()) < 5000);

  // Geplante (wie bisher „cockpit-…“) und vor dem Wiederherstellen werden erkannt; fremde Dateien nicht gelistet.
  writeFileSync(path.join(backupDir(dataDir), 'cockpit-2026-10-01T02-00-00Z.db'), 'x');
  writeFileSync(path.join(backupDir(dataDir), 'vor-wiederherstellen-2026-10-02T08-00-00Z.db'), 'x');
  writeFileSync(path.join(backupDir(dataDir), '.versteckt.db'), 'x');
  writeFileSync(path.join(backupDir(dataDir), 'notiz.txt'), 'x');
  const list = (await req(app, nick, 'GET', '/api/system/backups')).json() as BackupListResponse;
  assert.deepEqual(
    list.backups.map((backup) => [backup.name.split('-')[0], backup.kind]),
    [['manuell', 'manual'], ['vor', 'before_restore'], ['cockpit', 'scheduled']],
    'neueste zuerst',
  );
  assert.equal(list.backups[2].createdAt, Date.UTC(2026, 9, 1, 2));

  // Ausgeschaltet → kein Termin
  const off = setup({ BACKUP_HOUR_UTC: 'off' });
  const cookie = await login(off.app);
  assert.equal(((await req(off.app, cookie, 'GET', '/api/system/backups')).json() as BackupListResponse).nextAt, null);
  await off.app.close();
  await app.close();
});

test('Sicherungen: Herunterladen nur mit Passwort, Namen geprüft, Fehlversuche begrenzt', async () => {
  const { app, dataDir } = setup();
  const nick = await login(app);
  const info = (await req(app, nick, 'POST', '/api/system/backups')).json() as BackupInfo;
  const url = `/api/system/backups/${info.name}/download`;

  assert.deepEqual(errorOf(await req(app, nick, 'POST', url, {})), [403, 'reauth_failed']);
  assert.deepEqual(errorOf(await req(app, nick, 'POST', url, { password: 'falsch' })), [403, 'reauth_failed']);
  const ok = await req(app, nick, 'POST', url, { password: PASSWORD });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.equal(ok.headers['content-disposition'], `attachment; filename="${info.name}"`);
  assert.deepEqual(ok.rawPayload, readFileSync(path.join(backupDir(dataDir), info.name)));

  for (const bad of ['..%2Fcockpit.db', '.cockpit.db', 'cockpit.db.restore', 'gibt-es-nicht.db', '%2Fetc%2Fpasswd.db']) {
    assert.deepEqual(errorOf(await req(app, nick, 'POST', `/api/system/backups/${bad}/download`, { password: PASSWORD })), [404, 'not_found'], bad);
  }

  // 10 Fehlversuche je IP in 15 Minuten (wie Login und Einstellungen) → 429 mit Retry-After, auch mit richtigem Passwort.
  for (let i = 0; i < 9; i++) await req(app, nick, 'POST', url, { password: 'falsch' });
  const blocked = await req(app, nick, 'POST', url, { password: PASSWORD });
  assert.deepEqual(errorOf(blocked), [429, 'too_many_attempts']);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  await app.close();
});

test('Sicherungen: Mitarbeiter gesperrt, ohne Sitzung 401', async () => {
  const { app } = setup();
  const anna = await login(app, 'mitarbeiter');
  for (const [method, url] of [
    ['GET', '/api/system/backups'],
    ['POST', '/api/system/backups'],
    ['GET', '/api/system/update'],
    ['POST', '/api/system/update/check'],
    ['POST', '/api/system/update'],
  ] as const) {
    assert.deepEqual(errorOf(await req(app, anna, method, url, {})), [403, 'not_allowed'], url);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/system/backups' })).statusCode, 401);
  const admin = await login(app, 'admin');
  assert.equal((await req(app, admin, 'GET', '/api/system/backups')).statusCode, 200);
  await app.close();
});

test('Wiederherstellen in der Simulation: 202 mit Hinweis, nichts geändert, kein Neustart', async () => {
  let restarted = 0;
  const { app, dataDir } = setup({}, { restart: () => restarted++ });
  const nick = await login(app);
  const info = (await req(app, nick, 'POST', '/api/system/backups')).json() as BackupInfo;
  const response = await req(app, nick, 'POST', `/api/system/backups/${info.name}/restore`, { password: PASSWORD });
  assert.equal(response.statusCode, 202, response.body);
  const body = response.json() as RestoreResponse;
  assert.equal(body.safetyBackup, null);
  assert.match(body.message, /^Simulation: .*nichts geändert/);
  assert.equal(restarted, 0);
  assert.ok(!existsSync(path.join(dataDir, RESTORE_FILE)));
  assert.equal(readdirSync(backupDir(dataDir)).length, 1);
  assert.deepEqual(errorOf(await req(app, nick, 'POST', `/api/system/backups/${info.name}/restore`, { password: 'falsch' })), [403, 'reauth_failed']);
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/backups/nein.db/restore', { password: PASSWORD })), [404, 'not_found']);
  await app.close();
});

test('Wiederherstellen live: prüfen, Stand vorher sichern, bereitlegen, neu starten, beim Start einsetzen', async () => {
  let restarted = 0;
  const { app, dataDir } = setup({ LEAD_SEARCH_MODE: 'live' }, { restart: () => restarted++ });
  const nick = await login(app);
  const info = (await req(app, nick, 'POST', '/api/system/backups')).json() as BackupInfo;

  // Nach der Sicherung ändert sich die Datenbank (zweite Verbindung, WAL).
  const side = new DatabaseSync(path.join(dataDir, DATABASE_FILE));
  side.exec('CREATE TABLE nach_der_sicherung (x INTEGER)');
  // LinkedIn-Schutz nach der Sicherung: eine gesendete Anfrage und eine Pause – beides muss das Wiederherstellen überstehen.
  side.prepare("INSERT INTO linkedin_actions (id, founder, account_id, lead_id, kind, status, detail, day, at) VALUES ('a-neu', 'nick', 'acc', 'l1', 'invite', 'sent', NULL, '2026-10-06', 1)").run();
  side.prepare("INSERT INTO linkedin_pauses (founder, paused_until, reason) VALUES ('johannes', 9999999999999, 'Limit erreicht')").run();
  side.close();

  // Kaputte Sicherung → 400, nichts angelegt
  writeFileSync(path.join(backupDir(dataDir), 'kaputt.db'), 'keine Datenbank');
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/backups/kaputt.db/restore', { password: PASSWORD })), [400, 'invalid_backup']);
  assert.equal(restarted, 0);
  assert.ok(!existsSync(path.join(dataDir, RESTORE_FILE)));
  assert.ok(!readdirSync(backupDir(dataDir)).some((name) => name.startsWith('vor-wiederherstellen-')));

  const response = await req(app, nick, 'POST', `/api/system/backups/${info.name}/restore`, { password: PASSWORD });
  assert.equal(response.statusCode, 202, response.body);
  const body = response.json() as RestoreResponse;
  assert.match(body.message, /^Sicherung vom \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} wird eingespielt – das Cockpit startet neu\. Danach meldest du dich neu an\.$/);
  assert.match(body.safetyBackup!, /^vor-wiederherstellen-.*\.db$/);
  assert.equal(restarted, 1, 'Neustart nach der Antwort');
  assert.ok(existsSync(path.join(dataDir, RESTORE_FILE)));
  // Weitere Wiederherstellung oder Sicherung bis zum Neustart gesperrt
  assert.deepEqual(errorOf(await req(app, nick, 'POST', `/api/system/backups/${info.name}/restore`, { password: PASSWORD })), [409, 'busy']);
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/backups')), [409, 'busy']);
  await app.close();

  // Start: Kopie einsetzen → Tabelle von nach der Sicherung ist weg, Sicherung des Stands vorher hat sie noch.
  assert.equal(applyPendingRestore(dataDir), true);
  assert.equal(applyPendingRestore(dataDir), false, 'nur einmal');
  const restored = new DatabaseSync(path.join(dataDir, DATABASE_FILE), { readOnly: true });
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'nach_der_sicherung'").get()?.n, 0);
  assert.deepEqual({ ...restored.prepare("SELECT id, founder, status FROM linkedin_actions WHERE id = 'a-neu'").get() }, { id: 'a-neu', founder: 'nick', status: 'sent' });
  assert.deepEqual({ ...restored.prepare('SELECT founder, reason FROM linkedin_pauses').get() }, { founder: 'johannes', reason: 'Limit erreicht' });
  assert.equal((restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  restored.close();
  const safety = new DatabaseSync(path.join(backupDir(dataDir), body.safetyBackup!), { readOnly: true });
  assert.equal(safety.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'nach_der_sicherung'").get()?.n, 1);
  safety.close();

  // Danach startet die App normal mit der eingesetzten Datenbank.
  const after = buildApp({ config: loadConfig({ LEAD_SEARCH_MODE: 'live', DATA_DIR: dataDir, AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false' }), adapter: new MockAdapter(0), logger: false });
  const cookie = await login(after);
  assert.equal(((await req(after, cookie, 'GET', '/api/system/backups')).json() as BackupListResponse).backups.length, 3, 'von Hand, kaputt.db, vor dem Wiederherstellen');
  await after.close();
});

// ── Updates: Simulation ─────────────────────────────────────────────────────

test('Updates in der Simulation: Status, Prüfen (höchstens alle 10 s), Update mit Passwort, danach aktuell', async () => {
  const { app } = setup({ UPDATE_AUTO: 'true', UPDATE_HOUR: '4', MOCK_UPDATE_SECONDS: '1' });
  const nick = await login(app);
  const status = (await req(app, nick, 'GET', '/api/system/update')).json() as UpdateStatusResponse;
  assert.equal(status.simulated, true);
  assert.equal(status.available, true);
  assert.equal(status.reason, null);
  assert.equal(status.current?.commit, 'a1b2c3d');
  assert.equal(status.latest?.commit, 'c0ffee1');
  assert.equal(status.behind, 2);
  assert.deepEqual(status.changes.map((change) => change.title), ['Übergabe an Close', 'Lead-Suche: Firmendaten schneller anreichern']);
  assert.equal(status.state, 'idle');
  assert.equal(status.lastRun, null);
  assert.equal(status.checkedAt, null);
  assert.deepEqual(status.auto, { enabled: true, hour: 4 });
  assert.ok(status.nextAutoAt! > Date.now());
  const berlinHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(status.nextAutoAt!));
  assert.equal(berlinHour, 4);

  const checked = await req(app, nick, 'POST', '/api/system/update/check');
  assert.equal(checked.statusCode, 200);
  assert.ok((checked.json() as UpdateStatusResponse).checkedAt! > 0);
  const tooSoon = await req(app, nick, 'POST', '/api/system/update/check');
  assert.deepEqual(errorOf(tooSoon), [429, 'too_many_attempts']);
  assert.ok(Number(tooSoon.headers['retry-after']) >= 1);

  // Ohne Passwort – ein Klick genügt.
  const started = await req(app, nick, 'POST', '/api/system/update', {});
  assert.equal(started.statusCode, 202, started.body);
  const running = started.json() as UpdateStatusResponse;
  assert.equal(running.state, 'running');
  assert.equal(running.lastRun?.by, 'Nick');
  assert.equal(running.lastRun?.ok, null);
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/update', { password: PASSWORD })), [409, 'update_running']);

  let done = (await req(app, nick, 'GET', '/api/system/update')).json() as UpdateStatusResponse;
  for (let i = 0; i < 60 && done.state === 'running'; i++) {
    await sleep(50);
    done = (await req(app, nick, 'GET', '/api/system/update')).json() as UpdateStatusResponse;
  }
  assert.equal(done.state, 'done');
  assert.equal(done.behind, 0);
  assert.equal(done.current?.commit, 'c0ffee1');
  assert.deepEqual(done.changes, []);
  assert.equal(done.lastRun?.ok, true);
  assert.match(done.lastRun!.message, /^Auf c0ffee1 aktualisiert\./);
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/update', { password: PASSWORD })), [409, 'up_to_date']);
  await app.close();
});

test('Updates: während einer Lead-Suche → 409 busy (auch in der Simulation)', async () => {
  const service = new UpdateService({
    mode: () => 'mock',
    env: { UPDATER_TOKEN_FILE: path.join(tempDataDir(), 'kein.token') },
    settings: () => ({ enabled: false, hour: 3 }),
    runActive: () => true,
    log: { info() {}, warn() {} } as never,
  });
  await assert.rejects(service.start('Nick'), (error: Error & { status?: number; code?: string }) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'busy');
    assert.match(error.message, /Lead-Suche/);
    return true;
  });
  assert.equal((await service.status()).pendingBuild, false, 'Simulation: nie pendingBuild');
});

test('Updates nachts: zur Stunde (deutsche Zeit), bei laufender Suche eine Stunde später, nur wenn es Neues gibt', async () => {
  const dataDir = tempDataDir();
  let busy = true;
  let now = Date.UTC(2026, 9, 6, 0, 30); // 02:30 in Berlin (Sommerzeit)
  const logs: string[] = [];
  const log = { info: (msg: string) => logs.push(msg), warn: (_o: unknown, msg: string) => logs.push(msg) } as never;
  const service = new UpdateService({
    mode: () => 'mock',
    env: { UPDATER_TOKEN_FILE: path.join(dataDir, 'kein.token'), MOCK_UPDATE_SECONDS: '0' },
    settings: () => ({ enabled: true, hour: 3 }),
    runActive: () => busy,
    log,
    now: () => now,
  });
  assert.equal(service.nextAutoAt(), Date.UTC(2026, 9, 6, 1, 0), '03:00 Berlin = 01:00 UTC');
  assert.equal(await service.autoTick(), 'waiting');
  now = Date.UTC(2026, 9, 6, 1, 0);
  assert.equal(await service.autoTick(), 'busy');
  assert.equal(service.nextAutoAt(), Date.UTC(2026, 9, 6, 2, 0), 'eine Stunde später');
  now = Date.UTC(2026, 9, 6, 2, 0);
  busy = false;
  assert.equal(await service.autoTick(), 'started');
  assert.equal(service.nextAutoAt(), Date.UTC(2026, 9, 7, 1, 0), 'morgen wieder');
  await sleep(20);
  const status = await service.status();
  assert.equal(status.lastRun?.by, 'Automatisch (nachts)');
  assert.equal(status.behind, 0);
  now = Date.UTC(2026, 9, 7, 1, 0);
  assert.equal(await service.autoTick(), 'up_to_date', 'nichts Neues → nichts tun');
  service.close();

  const off = new UpdateService({ mode: () => 'mock', env: {}, settings: () => ({ enabled: false, hour: 3 }), runActive: () => false, log });
  assert.equal(off.nextAutoAt(), null);
  assert.equal(await off.autoTick(), 'off');
});

// ── Updates: echter Update-Dienst (nachgebaut) ──────────────────────────────

async function fakeUpdater(handler: (req: IncomingMessage, body: string) => { status: number; body: unknown }) {
  const seen: { method: string; url: string; auth: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({ method: request.method!, url: request.url!, auth: String(request.headers.authorization), body });
    const result = handler(request, body);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}

const updaterStatus = (overrides: object = {}) => ({
  current: { commit: 'a1b2c3d', title: 'Alt', date: 1 },
  latest: { commit: 'c0ffee1', title: 'Neu', date: 2 },
  behind: 1,
  changes: [{ commit: 'c0ffee1', title: 'Neu', date: 2 }],
  checkedAt: 123,
  running: false,
  lastRun: null,
  ...overrides,
});

test('Updates mit Update-Dienst: Schlüssel, Status, Update, Fehler übersetzt; eigener Commit aus APP_COMMIT', async () => {
  let reply: { status: number; body: unknown } = { status: 200, body: updaterStatus() };
  // Vor dem Update fragt das Backend den Stand ab (GET) – ohne eigene Antwort dafür gilt `reply`.
  let statusReply: { status: number; body: unknown } | null = null;
  const fake = await fakeUpdater((request) => (request.method === 'GET' && statusReply ? statusReply : reply));
  const tokenDir = tempDataDir();
  const tokenFile = path.join(tokenDir, 'updater.token');
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(tokenFile, 'test-schluessel\n');
  // Auch im Mock-Modus echt, sobald der Dienst eingerichtet ist (Testserver mit Simulation).
  const { app } = setup({ UPDATER_URL: fake.url, UPDATER_TOKEN_FILE: tokenFile, APP_COMMIT: 'beefcafe1234567', APP_COMMIT_TITLE: 'Gebaut', APP_COMMIT_DATE: '5' });
  const nick = await login(app);
  try {
    const status = (await req(app, nick, 'GET', '/api/system/update')).json() as UpdateStatusResponse;
    assert.equal(status.simulated, false);
    assert.equal(status.available, true);
    assert.deepEqual(status.current, { commit: 'beefcaf', title: 'Gebaut', date: 5 }, 'laufender Stand weicht vom Ordner ab → laufender zählt');
    assert.equal(status.behind, 1);
    assert.equal(status.checkedAt, 123);
    assert.equal(fake.seen[0].url, '/status?fetch=0');
    assert.equal(fake.seen[0].auth, 'Bearer test-schluessel');

    await req(app, nick, 'POST', '/api/system/update/check');
    assert.equal(fake.seen.at(-1)!.url, '/status?fetch=1');

    statusReply = { status: 200, body: updaterStatus() };
    reply = { status: 202, body: updaterStatus({ running: true, lastRun: { startedAt: 1, finishedAt: null, ok: null, message: 'läuft', by: 'Nick' } }) };
    const started = await req(app, nick, 'POST', '/api/system/update', { password: PASSWORD });
    assert.equal(started.statusCode, 202);
    assert.equal((started.json() as UpdateStatusResponse).state, 'running');
    assert.equal(fake.seen.at(-2)!.url, '/status?fetch=1', 'vorher frisch geprüft');
    assert.deepEqual(JSON.parse(fake.seen.at(-1)!.body), { by: 'Nick' });

    reply = { status: 409, body: { error: { code: 'up_to_date', message: 'Die Software ist schon aktuell.' } } };
    assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/update', { password: PASSWORD })), [409, 'up_to_date']);
    reply = { status: 502, body: { error: { code: 'git_failed', message: 'Bei GitHub nachsehen ging nicht: x' } } };
    const failed = await req(app, nick, 'POST', '/api/system/update', { password: PASSWORD });
    assert.deepEqual(errorOf(failed), [503, 'updater_unavailable']);
    assert.match(failed.json().error.message, /GitHub/);
    statusReply = null;
    reply = { status: 200, body: updaterStatus({ running: false, lastRun: { startedAt: 1, finishedAt: 2, ok: false, message: 'kaputt', by: 'Nick' } }) };
    assert.equal(((await req(app, nick, 'GET', '/api/system/update')).json() as UpdateStatusResponse).state, 'failed');

    // Bauen gescheitert: nichts Neues, aber erneut einspielbar
    reply = { status: 200, body: updaterStatus({ behind: 0, changes: [], pendingBuild: true }) };
    assert.equal(((await req(app, nick, 'GET', '/api/system/update')).json() as UpdateStatusResponse).pendingBuild, true);

    // Falscher Schlüssel (401 vom Dienst) → nicht verfügbar, aber nicht „noch nicht eingerichtet“ (Schlüssel ist da)
    reply = { status: 401, body: { error: { code: 'unauthorized', message: 'nein' } } };
    const denied = (await req(app, nick, 'GET', '/api/system/update')).json() as UpdateStatusResponse;
    assert.equal(denied.available, false);
    assert.notEqual(denied.reason, UPDATER_UNAVAILABLE_REASON);
  } finally {
    fake.close();
    await app.close();
  }
});

test('Updates ohne Update-Dienst (live): nicht verfügbar mit Satz, Prüfen und Update → 503', async () => {
  const { app } = setup({ LEAD_SEARCH_MODE: 'live', APP_COMMIT: 'abcdef0123' });
  const nick = await login(app);
  const status = (await req(app, nick, 'GET', '/api/system/update')).json() as UpdateStatusResponse;
  assert.equal(status.available, false);
  assert.equal(status.simulated, false);
  assert.equal(status.reason, UPDATER_UNAVAILABLE_REASON);
  assert.equal(status.current?.commit, 'abcdef0');
  assert.equal(status.state, 'idle');
  assert.deepEqual(status.auto, { enabled: false, hour: 3 });
  assert.equal(status.nextAutoAt, null);
  const check = await req(app, nick, 'POST', '/api/system/update/check');
  assert.deepEqual(errorOf(check), [503, 'updater_unavailable']);
  assert.equal(check.json().error.message, UPDATER_UNAVAILABLE_REASON);
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/update', { password: PASSWORD })), [503, 'updater_unavailable']);

  // Schlüssel da (war schon eingerichtet), Dienst aber nicht erreichbar → kein Hinweis auf die Einrichtung
  const dataDir = tempDataDir();
  writeFileSync(path.join(dataDir, 'updater.token'), 'x');
  const down = setup({ LEAD_SEARCH_MODE: 'live', UPDATER_TOKEN_FILE: path.join(dataDir, 'updater.token'), UPDATER_URL: 'http://127.0.0.1:9' });
  const cookie = await login(down.app);
  assert.equal(((await req(down.app, cookie, 'GET', '/api/system/update')).json() as UpdateStatusResponse).reason, UPDATER_NOT_RESPONDING_REASON);
  await down.app.close();
  await app.close();
});

test('Updates: Dienst kurz weg → „startet gerade neu“ statt Shell-Hinweis; Zustand aus dem Protokoll', async () => {
  const dir = tempDataDir();
  const tokenFile = path.join(dir, 'updater.token');
  writeFileSync(tokenFile, 'x');
  const stateFile = path.join(dir, 'updater-state.json');
  let now = Date.UTC(2026, 9, 6, 10, 0);
  const service = (env: NodeJS.ProcessEnv = {}) =>
    new UpdateService({
      mode: () => 'live',
      env: { UPDATER_TOKEN_FILE: tokenFile, UPDATER_URL: 'http://127.0.0.1:9', ...env },
      settings: () => ({ enabled: false, hour: 3 }),
      runActive: () => false,
      log: { info() {}, warn() {} } as never,
      now: () => now,
    });

  // Lauf noch offen (Backend wurde mitten im Update neu gestartet)
  writeFileSync(stateFile, JSON.stringify({ lastRun: { startedAt: now - 60_000, finishedAt: null, ok: null, message: 'läuft', by: 'Nick' }, checkedAt: 5 }));
  let status = await service().status();
  assert.equal(status.reason, UPDATER_RESTARTING_REASON);
  assert.equal(status.state, 'running');
  assert.equal(status.checkedAt, 5);

  // Eben fertig geworden (< 15 min), Dienst baut sich neu
  writeFileSync(stateFile, JSON.stringify({ lastRun: { startedAt: now - 300_000, finishedAt: now - 60_000, ok: true, message: 'Auf c0ffee1 aktualisiert.', by: 'Nick' }, checkedAt: 5 }));
  status = await service().status();
  assert.equal(status.reason, UPDATER_RESTARTING_REASON);
  assert.equal(status.state, 'done');
  assert.equal(status.lastRun?.message, 'Auf c0ffee1 aktualisiert.');

  // Lange her → „antwortet gerade nicht“, nie die Shell
  now += 3600_000;
  status = await service().status();
  assert.equal(status.reason, UPDATER_NOT_RESPONDING_REASON);
  const s = service();
  await assert.rejects(s.check(), (error: Error & { code?: string }) => error.code === 'updater_unavailable' && error.message === UPDATER_NOT_RESPONDING_REASON);
});

test('Updates: nachts auch bei pendingBuild (ohne neue Commits)', async () => {
  let posted = 0;
  const fake = await fakeUpdater((request) => {
    if (request.method === 'POST') {
      posted++;
      return { status: 202, body: updaterStatus({ behind: 0, changes: [], pendingBuild: true, running: true }) };
    }
    return { status: 200, body: updaterStatus({ behind: 0, changes: [], pendingBuild: true }) };
  });
  const dir = tempDataDir();
  writeFileSync(path.join(dir, 'updater.token'), 'x');
  let now = Date.UTC(2026, 9, 6, 1, 0);
  const service = new UpdateService({
    mode: () => 'live',
    env: { UPDATER_TOKEN_FILE: path.join(dir, 'updater.token'), UPDATER_URL: fake.url },
    settings: () => ({ enabled: true, hour: 3 }),
    runActive: () => false,
    log: { info() {}, warn() {} } as never,
    now: () => now,
  });
  try {
    now = Date.UTC(2026, 9, 6, 0, 0);
    assert.equal(service.nextAutoAt(), Date.UTC(2026, 9, 6, 1, 0));
    now = Date.UTC(2026, 9, 6, 1, 0);
    assert.equal(await service.autoTick(), 'started');
    assert.equal(posted, 1);
  } finally {
    fake.close();
  }
});
