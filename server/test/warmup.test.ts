import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { LinkedInAccountsResponse, LinkedInStatusResponse, LinkedInWarmupResponse } from '../../shared/linkedin.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { MemoryAccountUsage } from '../src/linkedin/accountUsage.js';
import { WarmupService } from '../src/linkedin/warmup.js';
import { startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

/** Accounts aufwärmen (Wunsch des Nutzers 21.10.). */

const LIVE: NodeJS.ProcessEnv = {
  LEAD_SEARCH_MODE: 'live',
  UNIPILE_API_KEY: 'unipile-test-key',
  LINKEDIN_ACTIONS: 'on',
  UNIPILE_ACCOUNT_NICK: 'acc_nick',
  // acc_nick steht versehentlich mit drin – Gründer-Accounts wärmt die Automatik nie auf.
  UNIPILE_WARMUP_ACCOUNTS: 'acc_warm,acc_nick',
  LINKEDIN_PAUSE_SECONDS: '0-0',
  LINKEDIN_WORK_HOURS: '0-24',
  LINKEDIN_WORK_DAYS: '1-7',
};

const silent = { info() {}, warn() {} } as unknown as FastifyBaseLogger;
const HOUR = 3600_000;
/** 21.10.2026, 00:30 deutsche Zeit – der ganze Test bleibt im selben Kalendertag. */
const START = Date.parse('2026-10-20T22:30:00Z');

const card = (i: number): NewLeadCard => ({
  runId: 'run-1',
  mode: 'mock',
  providerId: `ACoTEST${i}`,
  publicIdentifier: `person-${i}`,
  profileUrl: `https://www.linkedin.com/in/person-${i}`,
  firstName: `Vorname${i}`,
  lastName: `Nachname${i}`,
  headline: 'Geschäftsführer',
  position: 'Geschäftsführer',
  company: `Firma ${i}`,
  location: 'Hamburg',
  website: null,
  networkDistance: 2,
  category: 'kapitalanlage_vertrieb',
  confidence: 0.9,
  reason: 'passt',
  summary: 'passt',
  metaAds: null,
});

async function setup(env: NodeJS.ProcessEnv, leads: number[], tracking: string[]) {
  const unipile = await startFakeUnipile();
  const dataDir = tempDataDir();
  const config = loadConfig({ DATA_DIR: dataDir, MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', ...LIVE, UNIPILE_DSN: unipile.baseUrl, ...env });
  const server = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
  await server.ready();
  if (leads.length) {
    const created = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: leads.map(card), owner: 'nick' } });
    assert.equal(created.statusCode, 200, created.body);
  }
  const db = openDatabase(dataDir);
  for (const key of tracking) db.prepare('INSERT INTO tracking_profiles (key, setter, sheet, status) VALUES (?, NULL, ?, NULL)').run(key, 'Blatt 1');
  const warmup = new WarmupService({ config, db, log: silent, usage: new MemoryAccountUsage(), random: () => 0, minPauseMs: 0 });
  const invites = () => unipile.requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/users/invite');
  const close = async () => {
    warmup.close();
    await server.close();
    db.close();
    await unipile.close();
  };
  return { unipile, server, db, warmup, invites, close };
}

test('Aufwärmen: über den Tag verteilt, Anlauf 6 am Tag, nur der Scraping-Account, ohne Notiz', async (t) => {
  const { warmup, invites, close } = await setup({}, [1, 2, 3, 4, 5, 6, 9, 10], []);
  t.after(close);
  assert.deepEqual(warmup.accounts(), ['acc_warm']);

  // Erste Runde lost nur den Start aus – noch nichts gesendet.
  await warmup.tick(START);
  assert.equal(invites().length, 0);
  for (let now = START; now < START + 22 * HOUR; now += 20 * 60_000) await warmup.tick(now);

  assert.equal(invites().length, 6, 'Woche 1: höchstens 6');
  for (const request of invites()) {
    assert.equal((request.body as { account_id: string }).account_id, 'acc_warm');
    assert.equal((request.body as { message?: string }).message, undefined);
  }
  const times = new Set(invites().map((request) => request.body));
  assert.equal(times.size, 6, 'jede Person nur einmal');
  const status = warmup.status(START + 22 * HOUR);
  assert.equal(status.mode, 'live');
  assert.deepEqual(
    status.accounts.map(({ id, sentToday, limitToday, sentTotal }) => ({ id, sentToday, limitToday, sentTotal })),
    [{ id: 'acc_warm', sentToday: 6, limitToday: 6, sentTotal: 6 }],
  );
  assert.equal(status.poolLeft, 2);
});

test('Aufwärmen: Tracking-Liste über das Profil, schon vernetzt/angefragt wird übersprungen', async (t) => {
  const { warmup, invites, unipile, close } = await setup({}, [], ['id:ACoTEST7', 'id:ACoTEST100', 'id:ACoTEST8']);
  t.after(close);
  // Reihenfolge der Tracking-Liste ist zufällig – über den Tag sind alle drei dran.
  for (let now = START; now < START + 22 * HOUR; now += 20 * 60_000) await warmup.tick(now);
  assert.equal(invites().length, 1);
  assert.equal((invites()[0].body as { provider_id: string }).provider_id, 'ACoTEST8');
  const profiles = unipile.requests.filter((request) => request.method === 'GET' && request.path.startsWith('/api/v1/users/ACoTEST'));
  assert.equal(profiles.length, 3);
  assert.ok(profiles.every((request) => request.query.get('notify') === 'false'));
  assert.equal(warmup.status(START).poolLeft, 0);
});

test('Aufwärmen: Limit von LinkedIn pausiert nur diesen Account, die Person bleibt frei; ohne LINKEDIN_ACTIONS nichts', async (t) => {
  const { warmup, invites, unipile, close } = await setup({}, [1, 2], []);
  t.after(close);
  await warmup.tick(START);
  unipile.linkedin.failNext = { status: 429, type: 'errors/too_many_requests' };
  await warmup.tick(START);
  const status = warmup.status(START);
  assert.ok(status.accounts[0].pausedUntil! > START);
  assert.equal(status.accounts[0].sentToday, 0);
  assert.equal(status.poolLeft, 2, 'Person nicht verbraucht');
  await warmup.tick(START + HOUR);
  assert.equal(invites().length, 1, 'während der Pause wird nichts gesendet');

  const off = await setup({ LINKEDIN_ACTIONS: 'off' }, [1], []);
  t.after(off.close);
  await off.warmup.tick(START);
  await off.warmup.tick(START);
  assert.equal(off.invites().length, 0);
  assert.equal(off.warmup.status(START).mode, 'off');
});

test('Aufwärmen: Anlauf 6 → 10 → 14 → eingestellter Wert, höchstens 17', async (t) => {
  const { warmup, db, close } = await setup({ LINKEDIN_WARMUP_PER_DAY: '12' }, [], []);
  t.after(close);
  assert.equal(warmup.limitToday('acc_warm', START), 6);
  db.prepare("INSERT INTO warmup_invites (target_key, account_id, source, provider_id, status, detail, at, day) VALUES ('in:x', 'acc_warm', 'lead', 'X', 'sent', NULL, ?, '2026-10-01')").run(START - 8 * 24 * HOUR);
  assert.equal(warmup.limitToday('acc_warm', START), 10);
  assert.equal(warmup.limitToday('acc_warm', START + 7 * 24 * HOUR), 12, 'Woche 3: 14, aber eingestellt sind 12');
  assert.equal(loadConfig({ LEAD_SEARCH_MODE: 'mock', LINKEDIN_WARMUP_PER_DAY: '40' }).linkedin.warmupPerDay, 17);
});

test('Aufwärmen in der Oberfläche: Accounts tragen „warmup“, Stand per GET', async () => {
  const server = buildApp({
    config: loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', UNIPILE_WARMUP_ACCOUNTS: 'mock-scraper' }),
    adapter: new MockAdapter(0),
    logger: false,
    requireSession: false,
  });
  await server.ready();
  const accounts = (await server.inject({ method: 'GET', url: '/api/linkedin/accounts' })).json() as LinkedInAccountsResponse;
  assert.deepEqual(accounts.accounts.map((account) => [account.id, account.warmup]), [['mock-scraper', true], ['mock-nick', false], ['mock-johannes', false]]);
  const status = (await server.inject({ method: 'GET', url: '/api/linkedin/warmup' })).json() as LinkedInWarmupResponse;
  assert.equal(status.mode, 'mock');
  assert.deepEqual(status.accounts.map((account) => [account.id, account.sentToday, account.limitToday]), [['mock-scraper', 0, 6]]);
  await server.close();
});

test('Grenzen je Account und Such-Reihenfolge (21.10.): speichern, prüfen, wirken auf Gründer und Aufwärmen', async () => {
  const server = buildApp({
    config: loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', UNIPILE_WARMUP_ACCOUNTS: 'mock-scraper' }),
    adapter: new MockAdapter(0),
    logger: false,
    requireSession: false,
  });
  await server.ready();
  const put = (url: string, payload: object) => server.inject({ method: 'PUT', url, payload });
  const list = async () => ((await server.inject({ method: 'GET', url: '/api/linkedin/accounts' })).json() as LinkedInAccountsResponse).accounts;

  // Scraping-Accounts vorn (nach Platz), Gründer zuletzt; Standardgrenzen sichtbar.
  let accounts = await list();
  assert.deepEqual(accounts.map((account) => account.id), ['mock-scraper', 'mock-nick', 'mock-johannes']);
  assert.deepEqual(accounts[0].limitDefaults, { profilesPerDay: 100, searchResultsPerDay: 1000, invitesPerDay: 17 });
  assert.deepEqual(accounts[1].limitDefaults, { profilesPerDay: 50, searchResultsPerDay: 500, invitesPerDay: 20 });

  assert.equal((await put('/api/linkedin/accounts/mock-scraper/limits', { profilesPerDay: 101 })).statusCode, 400);
  assert.equal((await put('/api/linkedin/accounts/mock-scraper/limits', { invitesPerDay: -1 })).statusCode, 400);
  const saved = await put('/api/linkedin/accounts/mock-scraper/limits', { invitesPerDay: 3, searchResultsPerDay: 400 });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json(), { profilesPerDay: null, searchResultsPerDay: 400, invitesPerDay: 3 });
  assert.equal((await put('/api/linkedin/accounts/mock-nick/limits', { invitesPerDay: 12 })).statusCode, 200);

  accounts = await list();
  assert.deepEqual(accounts[0].limits, { profilesPerDay: null, searchResultsPerDay: 400, invitesPerDay: 3 });
  // Aufwärmen: Anlauf 6, aber am Account 3 eingestellt.
  const warmup = (await server.inject({ method: 'GET', url: '/api/linkedin/warmup' })).json() as LinkedInWarmupResponse;
  assert.equal(warmup.accounts[0].limitToday, 3);
  // Gründer: eigene Grenze statt LINKEDIN_INVITES_PER_DAY.
  const status = (await server.inject({ method: 'GET', url: '/api/linkedin/status' })).json() as LinkedInStatusResponse;
  assert.equal(status.accounts.find((account) => account.founder === 'nick')!.invitesToday.limit, 12);

  // Reihenfolge speichern: Position je Scraping-Account.
  assert.equal((await put('/api/linkedin/accounts/order', { ids: ['mock-scraper'] })).statusCode, 200);
  assert.equal((await put('/api/linkedin/accounts/order', { ids: ['../x'] })).statusCode, 400);
  accounts = await list();
  assert.equal(accounts[0].position, 0);
  assert.equal(accounts[1].position, null);
  await server.close();
});

test('Aufwärmen (27.10.): beide Zielgruppen gemischt – je zur Hälfte Finanzdienstleister und Kapitalanlage', async (t) => {
  const { server, warmup, invites, close } = await setup({}, [], []);
  t.after(close);
  const cards = [1, 2, 3, 4, 5, 6].map((i) => ({ ...card(i), category: i > 3 ? 'finanzdienstleister' : 'kapitalanlage_vertrieb' }));
  const created = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards, owner: 'nick' } });
  assert.equal(created.statusCode, 200, created.body);
  // random() = 0 → jede Runde zieht zuerst einen Finanzdienstleister; sind die aufgebraucht, die übrigen.
  for (let now = START; now < START + 22 * HOUR; now += 20 * 60_000) await warmup.tick(now);
  const sent = invites().map((request) => (request.body as { provider_id: string }).provider_id);
  assert.equal(sent.length, 6);
  assert.deepEqual(sent.slice(0, 3).sort(), ['ACoTEST4', 'ACoTEST5', 'ACoTEST6']);
  assert.deepEqual(sent.slice(3).sort(), ['ACoTEST1', 'ACoTEST2', 'ACoTEST3']);
});
