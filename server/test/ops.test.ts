import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { DashboardResponse } from '../../shared/dashboard.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CreateLeadsResponse, LeadDataExport } from '../../shared/leads.js';
import { DISK_LOW_BYTES, type BackupListResponse, type SettingsKeyResponse, type UpdateRun } from '../../shared/system.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { backupDir } from '../src/db/backup.js';
import { DATABASE_FILE, migrate, openDatabase } from '../src/db/database.js';
import { LeadStore } from '../src/leads/leadStore.js';
import { NOTICES, NotificationCenter } from '../src/notify/notifications.js';
import { BackupService, applyPendingRestore } from '../src/system/backups.js';
import { DiskMonitor, formatBytes, readDiskSpace } from '../src/system/disk.js';
import { UpdateService } from '../src/system/updates.js';
import { tempDataDir } from './helpers.js';

/**
 * Betrieb und Datenschutz (08.10.): Sicherung vor dem Update, Fehler nach dem Start des Updates, Speicherplatz,
 * Gesundheitsprüfung mit Datenbank, Schlüssel für Geheimnisse, Auskunft und Löschen eines Leads, anonyme
 * Dashboard-Zahlen gelöschter Leads.
 */

const PASSWORD = 'demo';
const quietLog = { info() {}, warn() {}, error() {} } as never;

function setup(env: NodeJS.ProcessEnv = {}) {
  const dataDir = tempDataDir();
  const baseEnv: NodeJS.ProcessEnv = {
    LEAD_SEARCH_MODE: 'mock',
    DATA_DIR: dataDir,
    AUTH_DEMO_ACCOUNTS: 'true',
    AUTH_COOKIE_SECURE: 'false',
    MOCK_SPEED: '0',
    UPDATER_TOKEN_FILE: path.join(dataDir, 'gibt-es-nicht.token'),
    MOCK_UPDATE_SECONDS: '0.05',
    ...env,
  };
  const app = buildApp({ config: loadConfig(baseEnv), adapter: new MockAdapter(0), env: baseEnv, logger: false, requireSession: true });
  return { app, dataDir };
}

type App = ReturnType<typeof setup>['app'];

async function login(app: App, username = 'nick'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
}

const req = (app: App, cookie: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });

const errorOf = (response: { statusCode: number; json: () => { error: { code: string } } }) => [response.statusCode, response.json().error.code];

const card = (overrides: Partial<NewLeadCard> = {}): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: 'ACoOPS0001',
  publicIdentifier: 'olga-ops',
  profileUrl: 'https://www.linkedin.com/in/olga-ops',
  firstName: 'Olga',
  lastName: 'Ops',
  headline: 'Geschäftsführerin · Ops Bau GmbH',
  position: 'Geschäftsführerin',
  company: 'Ops Bau GmbH',
  location: 'Köln',
  website: null,
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.9,
  reason: 'Passt.',
  summary: 'Bauträger.',
  metaAds: null,
  ...overrides,
});

async function fakeUpdater(overrides: Record<string, unknown> = {}) {
  const posts: string[] = [];
  const status: Record<string, unknown> = {
    current: { commit: 'a1b2c3d', title: 'Alt', date: 1 },
    latest: { commit: 'c0ffee1', title: 'Neu', date: 2 },
    behind: 1,
    changes: [{ commit: 'c0ffee1', title: 'Neu', date: 2 }],
    checkedAt: 1,
    running: false,
    lastRun: null,
    ...overrides,
  };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method === 'POST') posts.push(body);
    response.writeHead(request.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.method === 'POST' ? { ...status, running: true } : status));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts, status, close: () => server.close() };
}

// ── 1 · Sicherung vor jedem Update ───────────────────────────────────────────

test('Update: vorher wird die Datenbank gesichert (vor-update-…), in der Liste als „vor einem Update“', async () => {
  const fake = await fakeUpdater();
  const tokenDir = tempDataDir();
  const tokenFile = path.join(tokenDir, 'updater.token');
  writeFileSync(tokenFile, 'schluessel\n');
  const { app } = setup({ UPDATER_URL: fake.url, UPDATER_TOKEN_FILE: tokenFile });
  const nick = await login(app);
  try {
    const started = await req(app, nick, 'POST', '/api/system/update', { password: PASSWORD });
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(fake.posts.length, 1);
    const list = (await req(app, nick, 'GET', '/api/system/backups')).json() as BackupListResponse;
    const before = list.backups.filter((backup) => backup.kind === 'before_update');
    assert.equal(before.length, 1);
    assert.match(before[0].name, /^vor-update-\d{4}-\d{2}-\d{2}T.*\.db$/);
  } finally {
    fake.close();
    await app.close();
  }
});

test('Update: Sicherung vorher scheitert → Update startet nicht, klarer Satz (auch nachts)', async () => {
  const fake = await fakeUpdater();
  const dir = tempDataDir();
  const tokenFile = path.join(dir, 'updater.token');
  writeFileSync(tokenFile, 'x');
  const results: { result: string; reason?: string }[] = [];
  let now = Date.UTC(2026, 9, 6, 0, 30);
  const service = new UpdateService({
    mode: () => 'live',
    env: { UPDATER_TOKEN_FILE: tokenFile, UPDATER_URL: fake.url },
    settings: () => ({ enabled: true, hour: 3 }),
    runActive: () => false,
    log: quietLog,
    now: () => now,
    backupBeforeUpdate: () => {
      throw new Error('database or disk is full');
    },
    onAutoResult: (result, reason) => results.push({ result, reason }),
  });
  try {
    await assert.rejects(service.start('Nick'), (error: Error & { code?: string; status?: number }) => {
      assert.equal(error.code, 'backup_failed');
      assert.equal(error.status, 503);
      assert.match(error.message, /Sicherung der Datenbank vor dem Update hat nicht geklappt \(database or disk is full\) – das Update wurde nicht gestartet/);
      return true;
    });
    assert.equal(await service.autoTick(), 'waiting');
    now = Date.UTC(2026, 9, 6, 1, 0); // 03:00 Berlin
    assert.equal(await service.autoTick(), 'failed');
    assert.equal(results.at(-1)?.result, 'failed');
    assert.match(results.at(-1)?.reason ?? '', /das Update wurde nicht gestartet/);
    assert.equal(fake.posts.length, 0, 'nie an den Update-Dienst geschickt');
  } finally {
    service.close();
    fake.close();
  }
});

test('Update: Sicherung nur, wenn wirklich eins kommt – nicht, wenn schon eins läuft oder nichts neu ist', async () => {
  const fake = await fakeUpdater({ behind: 0, changes: [], latest: { commit: 'a1b2c3d', title: 'Alt', date: 1 } });
  const dir = tempDataDir();
  const tokenFile = path.join(dir, 'updater.token');
  writeFileSync(tokenFile, 'x');
  let backups = 0;
  const service = new UpdateService({
    mode: () => 'live',
    env: { UPDATER_TOKEN_FILE: tokenFile, UPDATER_URL: fake.url },
    settings: () => ({ enabled: false, hour: 3 }),
    runActive: () => false,
    log: quietLog,
    backupBeforeUpdate: () => `vor-update-${++backups}.db`,
  });
  const rejectsWith = (code: string) => assert.rejects(service.start('Nick'), (error: Error & { code?: string; status?: number }) => {
    assert.deepEqual([error.status, error.code], [409, code]);
    return true;
  });
  try {
    await rejectsWith('up_to_date');
    Object.assign(fake.status, { behind: 1, changes: [{ commit: 'c0ffee1', title: 'Neu', date: 2 }], running: true });
    await rejectsWith('update_running');
    Object.assign(fake.status, { running: false, lastRun: { startedAt: 1, finishedAt: null, ok: null, message: 'läuft', by: 'Nick' } });
    await rejectsWith('update_running');
    assert.equal(backups, 0, 'keine Sicherung ohne Update');
    assert.equal(fake.posts.length, 0);
    // Nur Bauen offen (behind 0, pendingBuild) zählt als Update.
    Object.assign(fake.status, { behind: 0, changes: [], pendingBuild: true, lastRun: null });
    assert.equal((await service.start('Nick')).state, 'running');
    assert.equal(backups, 1);
    assert.equal(fake.posts.length, 1);
  } finally {
    service.close();
    fake.close();
  }
});

test('Sicherungen vor einem Update: es bleiben die letzten 3, andere Arten unberührt', () => {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  const config = loadConfig({ DATA_DIR: dataDir, BACKUP_KEEP: '14' });
  let now = Date.UTC(2026, 9, 6, 10, 0);
  const backups = new BackupService({ db, config, now: () => now });
  backups.create('manual');
  for (let i = 0; i < 5; i++) {
    now += 60_000;
    backups.create('before_update');
  }
  const names = readdirSync(backupDir(dataDir)).sort();
  assert.equal(names.filter((name) => name.startsWith('vor-update-')).length, 3);
  assert.equal(names.filter((name) => name.startsWith('manuell-')).length, 1);
  assert.ok(names.includes('vor-update-2026-10-06T10-05-00Z.db'), 'die neueste bleibt');
  assert.ok(!names.includes('vor-update-2026-10-06T10-01-00Z.db'), 'die älteste ist weg');
  db.close();
});

// ── 2 · Nächtliches Update scheitert erst nach dem Start ─────────────────────

test('Update-Protokoll: gescheiterter nächtlicher Lauf wird einmal gemeldet, alte Läufe nicht', () => {
  const dir = tempDataDir();
  const tokenFile = path.join(dir, 'updater.token');
  writeFileSync(tokenFile, 'x');
  const stateFile = path.join(dir, 'updater-state.json');
  let now = Date.UTC(2026, 9, 6, 1, 10);
  const seen: { run: UpdateRun; auto: boolean }[] = [];
  const service = new UpdateService({
    mode: () => 'live',
    env: { UPDATER_TOKEN_FILE: tokenFile, UPDATER_URL: 'http://127.0.0.1:9' },
    settings: () => ({ enabled: true, hour: 3 }),
    runActive: () => false,
    log: quietLog,
    now: () => now,
    onRunFinished: (run, auto) => seen.push({ run, auto }),
  });
  assert.equal(service.watchLastRun(), 'none', 'noch kein Protokoll');
  const failed: UpdateRun = {
    startedAt: now - 5 * 60_000,
    finishedAt: now - 60_000,
    ok: false,
    message: 'Neue Version geholt, aber Bauen/Neustarten ging nicht: failed to build',
    by: 'Automatisch (nachts)',
  };
  writeFileSync(stateFile, JSON.stringify({ lastRun: { ...failed, finishedAt: null, ok: null }, checkedAt: 1 }));
  assert.equal(service.watchLastRun(), 'none', 'läuft noch');
  writeFileSync(stateFile, JSON.stringify({ lastRun: failed, checkedAt: 1 }));
  assert.equal(service.watchLastRun(), 'failed');
  assert.equal(service.watchLastRun(), 'none', 'nur einmal je Lauf');
  assert.deepEqual(seen, [{ run: failed, auto: true }]);

  // Danach von Hand erfolgreich → gemeldet (räumt die Meldung weg), nicht automatisch
  const ok: UpdateRun = { startedAt: now, finishedAt: now + 60_000, ok: true, message: 'Auf c0ffee1 aktualisiert.', by: 'Nick' };
  writeFileSync(stateFile, JSON.stringify({ lastRun: ok, checkedAt: 1 }));
  now += 2 * 60_000;
  assert.equal(service.watchLastRun(), 'done');
  assert.deepEqual(seen.at(-1), { run: ok, auto: false });

  // Neues Backend (Neustart) Tage später: alter Fehlschlag wird nicht erneut gemeldet
  const later = new UpdateService({
    mode: () => 'live',
    env: { UPDATER_TOKEN_FILE: tokenFile, UPDATER_URL: 'http://127.0.0.1:9' },
    settings: () => ({ enabled: false, hour: 3 }),
    runActive: () => false,
    log: quietLog,
    now: () => now + 3 * 24 * 3600_000,
    onRunFinished: () => assert.fail('zu alt'),
  });
  writeFileSync(stateFile, JSON.stringify({ lastRun: failed, checkedAt: 1 }));
  assert.equal(later.watchLastRun(), 'none');
});

test('Update-Protokoll: Meldung „Automatisches Update fehlgeschlagen“ entsteht einmal (mit Slack) und verschwindet nach Erfolg', () => {
  const db = openDatabase(tempDataDir());
  const slack: string[] = [];
  const center = new NotificationCenter({ db, log: quietLog, slack: (notification) => slack.push(notification.title) });
  // Wie in app.ts verdrahtet
  const onRunFinished = (run: UpdateRun, auto: boolean) => {
    if (run.ok) center.resolve('update:auto');
    else if (auto) center.raise({ ...NOTICES.updateFailed(`Das nächtliche Update ist beim Einspielen gescheitert: ${run.message}`), repeat: false });
  };
  const failed: UpdateRun = { startedAt: 1, finishedAt: 2, ok: false, message: 'Bauen ging nicht.', by: 'Automatisch (nachts)' };
  onRunFinished(failed, true);
  onRunFinished(failed, true);
  const list = center.list({ username: 'nick', founder: 'nick', role: 'founder', founders: [] } as never);
  assert.equal(list.notifications.length, 1);
  assert.equal(list.notifications[0].kind, 'update_failed');
  assert.equal(list.notifications[0].count, 1);
  assert.match(list.notifications[0].text, /beim Einspielen gescheitert: Bauen ging nicht\./);
  assert.deepEqual(slack, ['Automatisches Update fehlgeschlagen']);
  onRunFinished({ ...failed, ok: true, startedAt: 3 }, false);
  assert.equal(center.isEmpty(), true);
  db.close();
});

// ── 4 · Speicherplatz ────────────────────────────────────────────────────────

test('Speicherplatz: knapp unter 1 GB oder unter 10 %, Meldung kommt und geht', () => {
  const GB = 1024 ** 3;
  const fs = (freeGb: number, totalGb: number) => () => ({ bsize: 4096, bavail: (freeGb * GB) / 4096, blocks: (totalGb * GB) / 4096 });
  assert.equal(readDiskSpace('/', 1, fs(50, 100))?.low, false);
  assert.equal(readDiskSpace('/', 1, fs(0.5, 2))?.low, true, 'unter 1 GB');
  assert.equal(readDiskSpace('/', 1, fs(5, 100))?.low, true, 'unter 10 %');
  assert.equal(readDiskSpace('/', 1, () => {
    throw new Error('ENOENT');
  }), null);
  assert.equal(formatBytes(1.5 * GB), '1,5 GB');
  assert.equal(formatBytes(DISK_LOW_BYTES / 2), '512 MB');

  const db = openDatabase(tempDataDir());
  const center = new NotificationCenter({ db, log: quietLog });
  let free = 0.5;
  const monitor = new DiskMonitor({
    dir: () => '/',
    log: quietLog,
    statfs: () => fs(free, 100)(),
    onLow: (info) => center.raise(NOTICES.diskLow(formatBytes(info.freeBytes), Math.floor((info.freeBytes / info.totalBytes) * 100))),
    onOk: () => center.resolve('disk:low'),
  });
  monitor.check();
  monitor.check();
  const list = center.list({ username: 'nick', founder: 'nick', role: 'founder', founders: [] } as never);
  assert.equal(list.notifications.length, 1);
  assert.equal(list.notifications[0].kind, 'disk_low');
  assert.equal(list.notifications[0].count, 1, 'stündlich, aber nicht jedes Mal neu');
  assert.match(list.notifications[0].text, /512 MB frei \(0 %\)/);
  free = 50;
  monitor.check();
  assert.equal(center.isEmpty(), true);
  db.close();
});

test('Speicherplatz: steht in der Liste der Sicherungen', async () => {
  const { app } = setup();
  const nick = await login(app);
  const list = (await req(app, nick, 'GET', '/api/system/backups')).json() as BackupListResponse;
  assert.ok(list.disk, 'freier Platz da');
  assert.ok(list.disk.freeBytes > 0 && list.disk.totalBytes >= list.disk.freeBytes);
  assert.equal(typeof list.disk.low, 'boolean');
  await app.close();
});

// ── 5 · Gesundheitsprüfung ───────────────────────────────────────────────────

test('/api/health: ohne Anmeldung, fragt die Datenbank, 503 ohne Details, wenn sie nicht antwortet', async () => {
  const { app } = setup();
  const ok = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  const original = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function () {
    throw new Error('disk I/O error /data/cockpit.db');
  };
  try {
    const down = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(down.statusCode, 503);
    assert.deepEqual(down.json(), { ok: false });
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  await app.close();
});

// ── 6 · Schlüssel für Geheimnisse ────────────────────────────────────────────

test('Schlüssel für Geheimnisse: nur mit Passwort, Mitarbeiter gesperrt, höchstens 5-mal in 15 Minuten', async () => {
  const { app, dataDir } = setup();
  const nick = await login(app);
  const none = (await req(app, nick, 'POST', '/api/system/settings-key', { password: PASSWORD })).json() as SettingsKeyResponse;
  assert.equal(none.source, 'none');
  assert.equal(none.key, null);

  const key = Buffer.alloc(32, 7).toString('base64');
  writeFileSync(path.join(dataDir, 'settings.key'), `${key}\n`, { mode: 0o600 });
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/settings-key', {})), [403, 'reauth_failed']);
  assert.deepEqual(errorOf(await req(app, nick, 'POST', '/api/system/settings-key', { password: 'falsch' })), [403, 'reauth_failed']);
  const shown = await req(app, nick, 'POST', '/api/system/settings-key', { password: PASSWORD });
  assert.equal(shown.statusCode, 200);
  assert.equal(shown.headers['cache-control'], 'no-store');
  const body = shown.json() as SettingsKeyResponse;
  assert.deepEqual([body.source, body.key], ['file', key]);
  assert.match(body.message, /Passwort-Manager/);

  const anna = await login(app, 'mitarbeiter');
  assert.deepEqual(errorOf(await req(app, anna, 'POST', '/api/system/settings-key', { password: PASSWORD })), [403, 'not_allowed']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/system/settings-key', payload: { password: PASSWORD } })).statusCode, 401);

  for (let i = 0; i < 3; i++) assert.equal((await req(app, nick, 'POST', '/api/system/settings-key', { password: PASSWORD })).statusCode, 200);
  const limited = await req(app, nick, 'POST', '/api/system/settings-key', { password: PASSWORD });
  assert.deepEqual(errorOf(limited), [429, 'too_many_attempts']);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  await app.close();

  // Aus SETTINGS_KEY: nur der Hinweis, nie der Wert
  const env = setup({ SETTINGS_KEY: 'a'.repeat(64) });
  const cookie = await login(env.app);
  const fromEnv = (await req(env.app, cookie, 'POST', '/api/system/settings-key', { password: PASSWORD })).json() as SettingsKeyResponse;
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.key, null);
  assert.match(fromEnv.message, /SETTINGS_KEY/);
  assert.ok(!JSON.stringify(fromEnv).includes('a'.repeat(64)));
  await env.app.close();
});

// ── 8 · Auskunft und Löschen eines Leads (DSGVO) ─────────────────────────────

async function realLead(app: App, cookie: string) {
  const created = (await req(app, cookie, 'POST', '/api/leads', { cards: [card()], owner: 'nick' })).json() as CreateLeadsResponse;
  const lead = created.created[0];
  const act = async (body: object) => assert.equal((await req(app, cookie, 'POST', `/api/leads/${lead.id}/events`, body)).statusCode, 200);
  await act({ action: 'invite_sent' });
  await act({ action: 'invite_accepted' });
  await act({ action: 'message_sent', text: 'Hallo Olga, kurze Frage …', label: 'A' });
  await act({ action: 'message_received', text: 'Gern, ruf mich an.' });
  return lead;
}

test('Auskunft: alle Daten eines Leads als JSON-Datei, nur Gründer und Admins', async () => {
  const { app } = setup();
  const nick = await login(app);
  const lead = await realLead(app, nick);
  const response = await req(app, nick, 'GET', `/api/leads/${lead.id}/export`);
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-disposition']), new RegExp(`^attachment; filename="lead-${lead.id}-\\d{4}-\\d{2}-\\d{2}\\.json"$`));
  assert.match(String(response.headers['content-type']), /application\/json/);
  const data = response.json() as LeadDataExport;
  assert.equal(data.lead.id, lead.id);
  assert.equal(data.lead.person.lastName, 'Ops');
  assert.ok(data.events.some((event) => event.kind === 'message_received' && event.text === 'Gern, ruf mich an.'), 'Nachrichten enthalten');
  assert.deepEqual(Object.keys(data.related).sort(), ['autoSearchChecked', 'enrichmentRequests', 'linkedinActions', 'linkedinMessagesSeen', 'trackingList']);

  const admin = await login(app, 'admin');
  assert.equal((await req(app, admin, 'GET', `/api/leads/${lead.id}/export`)).statusCode, 200);
  const anna = await login(app, 'mitarbeiter');
  assert.deepEqual(errorOf(await req(app, anna, 'GET', `/api/leads/${lead.id}/export`)), [403, 'not_allowed']);
  assert.deepEqual(errorOf(await req(app, nick, 'GET', '/api/leads/gibt-es-nicht/export')), [404, 'not_found']);
  await app.close();
});

test('Löschen auf Wunsch: sofort weg mit Verlauf, Fingerabdruck bleibt, Mitarbeiter gesperrt, Dashboard zählt weiter', async () => {
  const { app, dataDir } = setup();
  const nick = await login(app);
  const lead = await realLead(app, nick);
  const sum = (dashboard: DashboardResponse) =>
    dashboard.days.nick.reduce((total, day) => total + day.requests + day.accepted + day.messaged + day.replies, 0);
  const before = (await req(app, nick, 'GET', '/api/dashboard')).json() as DashboardResponse;
  const templatesBefore = before.templates.nick;

  const anna = await login(app, 'mitarbeiter');
  assert.deepEqual(errorOf(await req(app, anna, 'DELETE', `/api/leads/${lead.id}`)), [403, 'not_allowed']);

  const deleted = await req(app, nick, 'DELETE', `/api/leads/${lead.id}`);
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json().deleted, true);
  assert.deepEqual(errorOf(await req(app, nick, 'GET', `/api/leads/${lead.id}`)), [404, 'not_found']);
  assert.deepEqual(errorOf(await req(app, nick, 'DELETE', `/api/leads/${lead.id}`)), [404, 'not_found']);

  const after = (await req(app, nick, 'GET', '/api/dashboard')).json() as DashboardResponse;
  assert.equal(sum(after), sum(before), 'Tageszahlen bleiben');
  assert.deepEqual(after.templates.nick, templatesBefore, 'Vorlagen-Statistik bleibt');
  assert.equal(after.pipeline.nick.replied, before.pipeline.nick.replied - 1, 'Pipeline zeigt nur noch vorhandene Leads');
  await app.close();

  // Direkt in der Datenbank: nichts Persönliches mehr, nur Fingerabdruck und anonyme Zahlen
  const db = new DatabaseSync(path.join(dataDir, DATABASE_FILE), { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM lead_events WHERE lead_id = ?').get(lead.id) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM deleted_leads').get() as { n: number }).n, 3, 'LinkedIn-ID, Profil-Name und Firma (seit 27.10.)');
  const archived = db.prepare('SELECT * FROM lead_events_archive').all() as Record<string, unknown>[];
  assert.deepEqual(archived.map((row) => row.kind), ['invite_sent', 'invite_accepted', 'message_sent', 'message_received']);
  const dump = JSON.stringify(archived);
  for (const secret of [lead.id, 'Olga', 'Hallo', 'Gern', 'ACoOPS0001']) assert.ok(!dump.includes(secret), `${secret} nicht im Archiv`);
  assert.equal(archived[2].label, 'A');
  db.close();
  const store = new LeadStore(openDatabase(dataDir));
  assert.equal(store.wasDeleted({ providerId: 'ACoOPS0001' }), true);
});

test('Löschen: Neben-Tabellen – gesehene Nachrichten und „schon geprüft“ weg, Firmendaten-Anfragen bleiben ohne Bezug (Credits)', () => {
  const db = openDatabase(tempDataDir());
  const store = new LeadStore(db);
  const now = Date.now();
  const [lead, other] = store.createFromCards([card(), card({ providerId: 'ACoOPS0002', publicIdentifier: 'olga-zwei' })], 'nick', now).created;
  for (const target of [lead, other]) {
    db.prepare('INSERT INTO linkedin_seen_messages (message_id, lead_id, at) VALUES (?, ?, ?)').run(`msg-${target.id}`, target.id, now);
    db.prepare('INSERT INTO enrichment_requests (lead_id, source, requested_at) VALUES (?, ?, ?)').run(target.id, 'manual', now);
    db.prepare('INSERT INTO auto_search_checked (founder, provider_id, checked_at) VALUES (?, ?, ?)').run('nick', target.person.providerId, now);
  }
  store.deleteLead(lead.id, now);
  const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  assert.equal(count('SELECT COUNT(*) AS n FROM linkedin_seen_messages WHERE lead_id = ?', lead.id), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM auto_search_checked WHERE provider_id = ?', 'ACoOPS0001'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM enrichment_requests WHERE lead_id = ?', lead.id), 0, 'kein Bezug mehr');
  assert.equal(count('SELECT COUNT(*) AS n FROM enrichment_requests'), 2, 'Anfrage zählt weiter fürs Tageslimit');
  // Der andere Lead bleibt unberührt.
  assert.equal(count('SELECT COUNT(*) AS n FROM linkedin_seen_messages WHERE lead_id = ?', other.id), 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM auto_search_checked WHERE provider_id = ?', 'ACoOPS0002'), 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM enrichment_requests WHERE lead_id = ?', other.id), 1);
  // Erneutes Vorschlagen verhindert der Fingerabdruck (Runner: „Früher kein Interesse“).
  assert.equal(store.wasDeleted({ providerId: 'ACoOPS0001' }), true);
  db.close();
});

test('Wiederherstellen: nach der Sicherung gelöschter Lead bleibt gelöscht, Fingerabdruck bleibt, Zahlen bleiben anonym', () => {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  const store = new LeadStore(db);
  const now = Date.now();
  const [lead, other] = store.createFromCards([card(), card({ providerId: 'ACoOPS0002', publicIdentifier: 'olga-zwei' })], 'nick', now).created;
  store.applyAction(lead.id, { action: 'invite_sent' }, 'nick', now);
  db.prepare('INSERT INTO linkedin_actions (id, founder, account_id, lead_id, kind, status, detail, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'a-olga', 'nick', 'acc', lead.id, 'invite', 'sent', null, '2026-10-06', now,
  );
  const backups = new BackupService({ db, config: loadConfig({ DATA_DIR: dataDir, LEAD_SEARCH_MODE: 'live' }), now: () => now });
  const backup = backups.create('manual');

  // Nach der Sicherung: Löschen auf Wunsch.
  store.deleteLead(lead.id, now + 1000);
  const archivedNow = (db.prepare('SELECT COUNT(*) AS n FROM lead_events_archive').get() as { n: number }).n;
  backups.prepareRestore(backup.name);
  db.close();
  assert.equal(applyPendingRestore(dataDir), true);

  const restored = openDatabase(dataDir);
  const count = (sql: string, ...params: string[]) => (restored.prepare(sql).get(...params) as { n: number }).n;
  const again = new LeadStore(restored);
  assert.equal(again.get(lead.id), null, 'gelöschter Lead kommt mit der Sicherung nicht zurück');
  assert.ok(again.get(other.id), 'anderer Lead bleibt');
  assert.equal(again.wasDeleted({ providerId: 'ACoOPS0001' }), true, 'Fingerabdruck bleibt');
  assert.equal(again.wasDeleted({ providerId: 'x', publicIdentifier: 'OLGA-OPS' }), true);
  assert.equal(count('SELECT COUNT(*) AS n FROM lead_events WHERE lead_id = ?', lead.id), 0, 'Verlauf weg');
  assert.equal(count('SELECT COUNT(*) AS n FROM linkedin_actions WHERE lead_id = ?', lead.id), 0, 'Bezug gelöst');
  assert.equal(count("SELECT COUNT(*) AS n FROM linkedin_actions WHERE id = 'a-olga'"), 1, 'LinkedIn-Aktion zählt weiter');
  assert.equal(count('SELECT COUNT(*) AS n FROM lead_events_archive'), archivedNow, 'Dashboard zählt die Ereignisse anonym weiter');
  const dump = JSON.stringify(restored.prepare('SELECT * FROM lead_events_archive').all());
  assert.ok(!dump.includes('Olga') && !dump.includes(lead.id));
  restored.close();
});

test('Löschen nach Frist: Dashboard behält die Zahlen gelöschter Leads (anonym)', () => {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  const store = new LeadStore(db);
  const now = Date.now();
  const DAY = 24 * 3600_000;
  const [lead] = store.createFromCards([card()], 'nick', now - 3 * DAY).created;
  store.applyAction(lead.id, { action: 'invite_sent' }, 'nick', now - 3 * DAY);
  store.applyAction(lead.id, { action: 'invite_accepted' }, 'nick', now - 2 * DAY);
  store.applyAction(lead.id, { action: 'message_sent', label: 'B' }, 'nick', now - 2 * DAY);
  store.applyAction(lead.id, { action: 'lost', text: 'Kein Interesse' }, 'nick', now - 2 * DAY);
  const app = buildApp({ config: loadConfig({ LEAD_SEARCH_MODE: 'live', DATA_DIR: dataDir }), adapter: new MockAdapter(0), logger: false, requireSession: false });
  const dashboard = async () => (await app.inject({ method: 'GET', url: '/api/dashboard' })).json() as DashboardResponse;
  return (async () => {
    const before = await dashboard();
    assert.equal(store.purgeLost(now - DAY, now), 1);
    assert.equal(store.get(lead.id), null);
    const after = await dashboard();
    assert.deepEqual(after.days, before.days);
    assert.deepEqual(after.templates, before.templates);
    assert.deepEqual(after.followUps, before.followUps);
    assert.equal(after.days.nick.reduce((total, day) => total + day.requests, 0), 1);
    await app.close();
    db.close();
  })();
});

test('Migration 22: Datenbank auf Stand 21 bekommt die anonyme Tabelle, Daten bleiben', () => {
  const dataDir = tempDataDir();
  mkdirSync(dataDir, { recursive: true });
  const old = new DatabaseSync(path.join(dataDir, DATABASE_FILE));
  migrate(old, 21);
  old.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'bleibt')").run();
  old.close();
  const db = openDatabase(dataDir);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 22, true);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lead_events_archive'").get());
  assert.deepEqual({ ...(db.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as object) }, { value: 'bleibt' });
  db.close();
});
