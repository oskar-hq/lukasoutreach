import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE, type RunSnapshot } from '../../shared/leadSearch.js';
import { createLiveAdapter, scrapeAccounts, searchAccounts } from '../src/adapters/live/liveAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { AccountPrefsStore } from '../src/linkedin/accountPrefs.js';
import { DbAccountUsage, FOUNDER_SCRAPE_LIMITS, MemoryAccountUsage, UNIPILE_LIMITS } from '../src/linkedin/accountUsage.js';
import { startBody, tempDataDir, waitForEnd } from './helpers.js';
import { startFakeUnipile } from './fakeServers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

/** Nick und Johannes (Gründer) plus zwei reine Scraping-Accounts – alle bei Unipile startklar. */
const FOUR_ACCOUNTS = [
  { object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] },
  { object: 'Account', type: 'LINKEDIN', id: 'acc_johannes', name: 'Johannes', sources: [{ id: 's2', status: 'OK' }] },
  { object: 'Account', type: 'LINKEDIN', id: 'acc_scrape1', name: 'Scraper 1', sources: [{ id: 's3', status: 'OK' }] },
  { object: 'Account', type: 'LINKEDIN', id: 'acc_scrape2', name: 'Scraper 2', sources: [{ id: 's4', status: 'OK' }] },
];
const ALL = FOUR_ACCOUNTS.map((account) => account.id);
const NOW = Date.parse('2026-10-09T08:00:00Z');

async function setup(
  prefill: (usage: DbAccountUsage, prefs: AccountPrefsStore) => void = () => {},
  downAccounts?: Record<string, number>,
  fetchCompany = false,
) {
  const unipile = await startFakeUnipile({ accounts: FOUR_ACCOUNTS, downAccounts });
  servers.push(unipile);
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  const usage = new DbAccountUsage(db, () => 'Europe/Berlin');
  prefill(usage, new AccountPrefsStore(db));
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    UNIPILE_DSN: unipile.baseUrl,
    UNIPILE_API_KEY: 'unipile-test-key',
    UNIPILE_ACCOUNT_NICK: 'acc_nick',
    UNIPILE_ACCOUNT_JOHANNES: 'acc_johannes',
    UNIPILE_FETCH_COMPANY: fetchCompany ? 'true' : 'false',
    DATA_DIR: dataDir,
  });
  const adapter = createLiveAdapter(config, { pause: async () => {}, now: () => new Date(NOW) });
  const app = buildApp({ config, adapter, logger: false, requireSession: false });
  after(() => {
    db.close();
    return app.close();
  });
  const run = async (maxResults: number): Promise<RunSnapshot> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/lead-search/runs',
      payload: startBody({ known: [], profile: { ...DEFAULT_SEARCH_PROFILE, maxResults } }),
    });
    assert.equal(response.statusCode, 202, response.body);
    return waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id, 15_000);
  };
  const profileFetches = () => unipile.requests.filter((r) => /^\/api\/v1\/users\/ACo/.test(r.path));
  const perAccount = (requests: typeof unipile.requests) =>
    Object.fromEntries(ALL.map((id) => [id, requests.filter((r) => r.query.get('account_id') === id).length]));
  const companyFetches = () => unipile.requests.filter((r) => /^\/api\/v1\/linkedin\/company\//.test(r.path));
  return { run, unipile, usage, profileFetches, companyFetches, perAccount };
}

test('Profilabrufe und Suche zuerst über die reinen Scraping-Accounts, reihum – die Gründer-Accounts bleiben geschont', async () => {
  const { run, unipile, usage, profileFetches, perAccount } = await setup();
  const result = await run(8);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.equal(profileFetches().length, 8);
  assert.deepEqual(perAccount(profileFetches()), { acc_nick: 0, acc_johannes: 0, acc_scrape1: 4, acc_scrape2: 4 });
  assert.equal(usage.used('acc_scrape1', 'profile', NOW), 4);
  const searches = unipile.requests.filter((r) => r.path === '/api/v1/linkedin/search');
  assert.ok(searches.length > 0 && searches.every((r) => r.query.get('account_id')?.startsWith('acc_scrape')));
});

test('Eingestellte Reihenfolge und eigene Grenzen (21.10.): erst der vordere Account bis zu seiner Grenze, dann der nächste', async () => {
  const { run, unipile, profileFetches, perAccount } = await setup((_usage, prefs) => {
    prefs.setOrder(['acc_scrape2', 'acc_scrape1']);
    prefs.setLimits('acc_scrape2', { profilesPerDay: 3 });
  });
  const result = await run(8);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.deepEqual(perAccount(profileFetches()), { acc_nick: 0, acc_johannes: 0, acc_scrape1: 5, acc_scrape2: 3 });
  const searches = unipile.requests.filter((r) => r.path === '/api/v1/linkedin/search');
  assert.equal(searches[0].query.get('account_id'), 'acc_scrape2', 'Suche beginnt beim vorderen Account');
});

test('Gründer-Account nach ganz oben (22.10.): er sucht und scrapt zuerst bis zu seiner Grenze, dann die nächsten', async () => {
  const { run, unipile, profileFetches, perAccount } = await setup((_usage, prefs) => {
    prefs.setOrder(['acc_nick', 'acc_scrape1', 'acc_scrape2', 'acc_johannes']);
    prefs.setLimits('acc_nick', { profilesPerDay: 3 });
  });
  const result = await run(8);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.deepEqual(perAccount(profileFetches()), { acc_nick: 3, acc_johannes: 0, acc_scrape1: 5, acc_scrape2: 0 });
  const searches = unipile.requests.filter((r) => r.path === '/api/v1/linkedin/search');
  assert.ok(searches.length > 0 && searches.every((r) => r.query.get('account_id') === 'acc_nick'), 'Suche bleibt beim Gründer vorn');
});

test('Gründer-Accounts erst, wenn die Scraping-Accounts voll sind – und nur bis zum halben Limit', async () => {
  const { run, profileFetches, perAccount } = await setup((usage) => {
    usage.add('acc_scrape1', 'profile', UNIPILE_LIMITS.profilesPerDay, NOW);
    usage.add('acc_scrape2', 'profile', UNIPILE_LIMITS.profilesPerDay, NOW);
    usage.add('acc_nick', 'profile', FOUNDER_SCRAPE_LIMITS.profilesPerDay - 2, NOW);
    usage.add('acc_johannes', 'profile', FOUNDER_SCRAPE_LIMITS.profilesPerDay, NOW);
  });
  const result = await run(10);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.deepEqual(perAccount(profileFetches()), { acc_nick: 2, acc_johannes: 0, acc_scrape1: 0, acc_scrape2: 0 });
});

test('Account fällt aus (22.10.): Limit bzw. keine Antwort → der nächste Account sucht und scrapt weiter, der Lauf läuft durch', async () => {
  const { run, unipile, profileFetches, perAccount } = await setup(
    (_usage, prefs) => prefs.setOrder(['acc_scrape1', 'acc_scrape2']),
    { acc_scrape1: 429 },
  );
  const result = await run(8);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  const ok = profileFetches().filter((request) => request.query.get('account_id') !== 'acc_scrape1');
  assert.equal(ok.length, 8);
  assert.deepEqual(perAccount(ok), { acc_nick: 0, acc_johannes: 0, acc_scrape1: 0, acc_scrape2: 8 });
  const searches = unipile.requests.filter((r) => r.path === '/api/v1/linkedin/search');
  assert.equal(searches[0].query.get('account_id'), 'acc_scrape1', 'erst der vordere');
  assert.equal(searches.at(-1)!.query.get('account_id'), 'acc_scrape2', 'dann der nächste');
});

test('Firmenseiten (02.11.): nie über die Gründer-Accounts, sondern von unten in der Such-Reihenfolge – deren Grenzen bleiben ganz für Personen', async () => {
  const { run, usage, profileFetches, companyFetches, perAccount } = await setup(
    (_usage, prefs) => {
      prefs.setOrder(['acc_nick', 'acc_johannes', 'acc_scrape1', 'acc_scrape2']);
      prefs.setLimits('acc_nick', { profilesPerDay: 4 });
      prefs.setLimits('acc_johannes', { profilesPerDay: 4 });
      prefs.setLimits('acc_scrape2', { profilesPerDay: 3 });
    },
    undefined,
    true,
  );
  const result = await run(8);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  // Personenprofile: erst Nick und Johannes bis zu ihrer Grenze – ohne dass Firmenseiten davon etwas wegnehmen.
  assert.deepEqual(perAccount(profileFetches()), { acc_nick: 4, acc_johannes: 4, acc_scrape1: 0, acc_scrape2: 0 });
  // Firmenseiten: erst der unterste Account bis zu seiner Grenze, dann der darüber; nie ein Gründer.
  assert.deepEqual(perAccount(companyFetches()), { acc_nick: 0, acc_johannes: 0, acc_scrape1: 5, acc_scrape2: 3 });
  assert.equal(usage.used('acc_nick', 'profile', NOW), 4);
  assert.equal(usage.used('acc_scrape2', 'profile', NOW), 3);
});

test('Firmenseiten nie weglassen (02.11.): alle Scraping-Accounts voll → kein Lauf, auch wenn die Gründer noch frei sind', async () => {
  const { run, profileFetches, companyFetches } = await setup(
    (usage) => {
      usage.add('acc_scrape1', 'profile', UNIPILE_LIMITS.profilesPerDay, NOW);
      usage.add('acc_scrape2', 'profile', UNIPILE_LIMITS.profilesPerDay, NOW);
    },
    undefined,
    true,
  );
  const result = await run(4);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'rate_limit');
  assert.equal(profileFetches().length, 0, 'kein Profil ohne Platz für die Firmenseite');
  assert.equal(companyFetches().length, 0);
});

test('Firmenseiten nie weglassen: wird ihr Platz im Lauf knapp, liest die Suche kein weiteres Profil und stoppt – der Rest wartet', async () => {
  // Scraper 2 (unten) fällt bei Firmenseiten aus, Scraper 1 darf nur noch 2 – also 2 Leads, dann Schluss.
  const { run, profileFetches, companyFetches, perAccount } = await setup(
    (_usage, prefs) => {
      prefs.setOrder(['acc_nick', 'acc_johannes', 'acc_scrape1', 'acc_scrape2']);
      prefs.setLimits('acc_scrape1', { profilesPerDay: 2 });
    },
    { acc_scrape2: 429 },
    true,
  );
  const result = await run(6);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.title, 'Tageslimit für Firmenseiten erreicht');
  assert.deepEqual(perAccount(profileFetches()), { acc_nick: 2, acc_johannes: 0, acc_scrape1: 0, acc_scrape2: 0 });
  const companiesOk = companyFetches().filter((r) => r.query.get('account_id') === 'acc_scrape1');
  assert.equal(companiesOk.length, 2, 'jedes gelesene Profil hat seine Firmenseite');
  const deferred = result.leads.filter((lead) => lead.status === 'deferred');
  assert.ok(deferred.length >= 4, `Rest auf der Warteliste: ${deferred.length}`);
  assert.ok(deferred.some((lead) => lead.note === 'Tageslimit erreicht – beim nächsten Lauf dran'));
});

test('Firmenseiten nie weglassen: Profil gelesen, aber jede Firmenseite scheitert am Limit → der Lead wartet auf den nächsten Lauf', async () => {
  const { run, profileFetches, companyFetches } = await setup(
    (_usage, prefs) => prefs.setOrder(['acc_nick', 'acc_johannes', 'acc_scrape1', 'acc_scrape2']),
    { acc_scrape1: 429, acc_scrape2: 429 },
    true,
  );
  const result = await run(3);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'rate_limit');
  assert.equal(profileFetches().length, 1);
  assert.equal(companyFetches().length, 2, 'erst unten, dann der Account darüber');
  assert.ok(result.leads.every((lead) => lead.status !== 'failed' && lead.status !== 'qualified' && lead.status !== 'enriched'));
  assert.ok(result.leads.some((lead) => lead.note === 'Tageslimit erreicht – beim nächsten Lauf dran'));
});

test('Alle Accounts fallen aus: erst dann bricht der Lauf ab – mit dem Grund', async () => {
  const { run } = await setup(() => {}, { acc_scrape1: 503, acc_scrape2: 429, acc_nick: 429, acc_johannes: 500 });
  const result = await run(5);
  assert.equal(result.status, 'failed');
  assert.match(result.error?.message ?? '', /Auch die anderen Such-Accounts sind gerade ausgefallen oder am Limit \(4 pausiert\)/);
});

test('Tageslimit: nie mehr als 100 Profile je Account – der Rest wartet auf den nächsten Lauf', async () => {
  const { run, profileFetches, perAccount } = await setup((usage) => {
    usage.add('acc_nick', 'profile', FOUNDER_SCRAPE_LIMITS.profilesPerDay - 1, NOW);
    usage.add('acc_johannes', 'profile', FOUNDER_SCRAPE_LIMITS.profilesPerDay, NOW);
    usage.add('acc_scrape1', 'profile', UNIPILE_LIMITS.profilesPerDay, NOW);
    usage.add('acc_scrape2', 'profile', UNIPILE_LIMITS.profilesPerDay - 1, NOW);
  });
  const result = await run(10);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.deepEqual(perAccount(profileFetches()), { acc_nick: 1, acc_johannes: 0, acc_scrape1: 0, acc_scrape2: 1 });
  assert.ok(result.leads.some((lead) => lead.status === 'deferred' && lead.note === 'Tageslimit der LinkedIn-Accounts erreicht – beim nächsten Lauf dran'));
});

test('Alle Accounts am Tageslimit: Lauf startet gar nicht erst eine Suche', async () => {
  const { run, unipile } = await setup((usage) => {
    for (const id of ALL) usage.add(id, 'profile', UNIPILE_LIMITS.profilesPerDay, NOW);
  });
  const result = await run(5);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'rate_limit');
  assert.equal(result.error?.title, 'Tageslimit aller LinkedIn-Accounts erreicht');
  assert.equal(unipile.requests.filter((r) => r.path === '/api/v1/linkedin/search').length, 0);
});

test('Suchtreffer: Account mit vollem Suchlimit sucht nicht mehr, ein anderer übernimmt (Gründer zuletzt, halbes Limit)', async () => {
  const limit = UNIPILE_LIMITS.searchResultsPerDay.classic;
  const founderLimit = FOUNDER_SCRAPE_LIMITS.searchResultsPerDay.classic;
  const { run, unipile, usage, perAccount } = await setup((counts) => {
    counts.add('acc_scrape1', 'search', limit - 5, NOW);
    counts.add('acc_scrape2', 'search', limit, NOW);
    counts.add('acc_nick', 'search', founderLimit - 5, NOW);
  });
  const result = await run(3);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  const searches = unipile.requests.filter((r) => r.path === '/api/v1/linkedin/search');
  assert.ok(searches.length > 0);
  assert.deepEqual(perAccount(searches), { acc_nick: 0, acc_johannes: searches.length, acc_scrape1: 0, acc_scrape2: 0 });
  assert.ok(usage.used('acc_johannes', 'search', NOW) <= founderLimit);
});

test('Suchlimit aller Accounts erreicht: verständlicher Abbruch statt Überschreitung', async () => {
  const limit = UNIPILE_LIMITS.searchResultsPerDay.classic;
  const { run, unipile } = await setup((usage) => {
    for (const id of ALL) usage.add(id, 'search', limit, NOW);
  });
  const result = await run(3);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'rate_limit');
  assert.match(result.error?.message ?? '', /1\.000 je Scraping-Account, die Hälfte bei den Accounts der Gründer/);
  assert.equal(unipile.requests.filter((r) => r.path === '/api/v1/linkedin/search').length, 0);
});

test('Reine Scraping-Accounts: ihre Kontakte und Anfragen werden nie geladen (nur die der Gründer)', async () => {
  const { run, unipile } = await setup();
  await run(4);
  const lists = unipile.requests.filter((r) => r.path === '/api/v1/users/relations' || r.path === '/api/v1/users/invite/sent');
  assert.ok(lists.some((r) => r.query.get('account_id') === 'acc_nick'));
  assert.ok(lists.some((r) => r.query.get('account_id') === 'acc_johannes'));
  assert.ok(!lists.some((r) => r.query.get('account_id')?.startsWith('acc_scrape')));
  // Gesendet wird ohnehin nichts – und nie über einen Scraping-Account.
  assert.ok(!unipile.requests.some((r) => r.method === 'POST' && r.path !== '/api/v1/linkedin/search' && r.query.get('account_id')?.startsWith('acc_scrape')));
});

test('Account-Auswahl: alle startklaren, UNIPILE_ACCOUNT_ID zuerst; Sales Navigator sucht nur mit Lizenz', () => {
  const nav = { id: 'nav', type: 'LINKEDIN', sources: [{ status: 'OK' }], connection_params: { im: { premiumFeatures: ['sales_navigator'] } } };
  const plain = { id: 'plain', type: 'LINKEDIN', sources: [{ status: 'OK' }], connection_params: { im: { premiumFeatures: [] } } };
  const broken = { id: 'broken', type: 'LINKEDIN', sources: [{ status: 'CREDENTIALS' }] };
  const mail = { id: 'mail', type: 'GOOGLE', sources: [{ status: 'OK' }] };
  const ids = (accounts: { id?: string }[]) => accounts.map((account) => account.id);
  assert.deepEqual(ids(scrapeAccounts([plain, broken, nav, mail], null)), ['plain', 'nav']);
  assert.deepEqual(ids(scrapeAccounts([plain, nav], 'nav')), ['nav', 'plain']);
  assert.deepEqual(ids(searchAccounts([plain, nav], null, 'classic')), ['plain', 'nav']);
  assert.deepEqual(ids(searchAccounts([plain, nav], null, 'sales_navigator')), ['nav']);
});

test('Zähler: je Tag (deutsche Zeit) und Account getrennt, auch in der Datenbank', () => {
  const memory = new MemoryAccountUsage();
  memory.add('a', 'profile', 3, NOW);
  assert.equal(memory.used('a', 'profile', NOW), 3);
  assert.equal(memory.used('a', 'search', NOW), 0);
  assert.equal(memory.used('b', 'profile', NOW), 0);
  assert.equal(memory.used('a', 'profile', NOW + 24 * 60 * 60 * 1000), 0, 'neuer Tag');

  const db = openDatabase(tempDataDir());
  const stored = new DbAccountUsage(db, () => 'Europe/Berlin');
  stored.add('a', 'profile', 2, NOW);
  stored.add('a', 'profile', 1, NOW);
  // 23:30 deutscher Zeit (21:30 UTC) ist noch derselbe Tag, 00:30 schon der nächste.
  assert.equal(stored.used('a', 'profile', Date.parse('2026-10-09T21:30:00Z')), 3);
  assert.equal(stored.used('a', 'profile', Date.parse('2026-10-09T22:30:00Z')), 0);
  db.close();
});

test('Vernetzen und Nachrichten: feste Obergrenzen laut Unipile, auch über die .env nicht höher', () => {
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    LINKEDIN_INVITES_PER_DAY: '500',
    LINKEDIN_INVITES_PER_WEEK: '999',
    LINKEDIN_MESSAGES_PER_DAY: '300',
    DATA_DIR: tempDataDir(),
  });
  assert.equal(config.linkedin.invitesPerDay, UNIPILE_LIMITS.invitesPerDay);
  assert.equal(config.linkedin.invitesPerWeek, UNIPILE_LIMITS.invitesPerWeek);
  assert.equal(config.linkedin.messagesPerDay, UNIPILE_LIMITS.messagesPerDay);
  const lower = loadConfig({ LEAD_SEARCH_MODE: 'live', LINKEDIN_INVITES_PER_DAY: '15', DATA_DIR: tempDataDir() });
  assert.equal(lower.linkedin.invitesPerDay, 15, 'niedriger geht');
});

test('Nicks Account bei Unipile getrennt: Suche läuft trotzdem weiter, nichts wird zurückgestellt, nichts über Nick', async () => {
  const unipile = await startFakeUnipile({ accounts: FOUR_ACCOUNTS.filter((account) => account.id !== 'acc_nick') });
  servers.push(unipile);
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    UNIPILE_DSN: unipile.baseUrl,
    UNIPILE_API_KEY: 'unipile-test-key',
    UNIPILE_ACCOUNT_NICK: 'acc_nick',
    UNIPILE_ACCOUNT_JOHANNES: 'acc_johannes',
    UNIPILE_FETCH_COMPANY: 'false',
    DATA_DIR: tempDataDir(),
  });
  const adapter = createLiveAdapter(config, { pause: async () => {}, now: () => new Date(NOW) });
  const app = buildApp({ config, adapter, logger: false, requireSession: false });
  after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody({ known: [], profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 4 } }) });
  const result = await waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id, 15_000);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.ok(!result.leads.some((lead) => /nicht prüfbar/.test(lead.note ?? '')), 'keine zurückgestellten Leads wegen Nick');
  assert.equal(unipile.requests.filter((r) => /^\/api\/v1\/users\/ACo/.test(r.path)).length, 4);
  assert.ok(!unipile.requests.some((r) => r.query.get('account_id') === 'acc_nick'));
  assert.ok(adapter.setupWarnings().some((warning) => /Kontakte von Nick werden gerade nicht geprüft \(Account bei Unipile nicht verbunden\)/.test(warning)));
});
