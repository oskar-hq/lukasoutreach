import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE, type RunSnapshot, type SearchHit, type SearchProfile } from '../../shared/leadSearch.js';
import { classicQueries, createLiveAdapter } from '../src/adapters/live/liveAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { SearchMemory, queryPriority } from '../src/pipeline/searchMemory.js';
import { startBody, tempDataDir, waitForEnd } from './helpers.js';
import { startFakeAnthropic, startFakeMeta, systemText, startFakeUnipile, type FakeUnipileOptions } from './fakeServers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

/** Ein Stichwort, eine Position: Reihenfolge der Anfragen ist leicht zu prüfen. */
const PROFILE: SearchProfile = { keywords: ['Bauträger'], positions: ['Geschäftsführer'], region: 'Deutschland', maxResults: 5 };

async function adapterSetup(options: FakeUnipileOptions = {}) {
  const unipile = await startFakeUnipile({ people: 1000, ...options });
  servers.push(unipile);
  const dataDir = tempDataDir();
  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'unipile-test-key', DATA_DIR: dataDir });
  const adapter = createLiveAdapter(config, { pause: async () => {} });
  const memory = new SearchMemory(openDatabase(dataDir));
  const search = (maxHits: number, profile = PROFILE) => {
    const ctx = { signal: new AbortController().signal, runId: 'r', profile };
    return adapter.search(profile, { maxHits, onHits: () => {}, memory }, ctx);
  };
  const searches = () => unipile.requests.filter((request) => request.path === '/api/v1/linkedin/search');
  return { unipile, memory, search, searches };
}

const ids = (hits: SearchHit[]) => hits.map((hit) => hit.providerId);

test('Suchanfragen: Stichwort × Position, dann Stichwort im Firmennamen, dann je Bundesland', () => {
  const queries = classicQueries(PROFILE);
  assert.equal(queries.length, 2 + 16);
  assert.equal(queries[0].label, 'Bauträger · Geschäftsführer · Deutschland');
  assert.equal(queries[1].label, 'Firma „Bauträger“ · Geschäftsführer · Deutschland');
  assert.equal(queries[2].label, 'Bauträger · Geschäftsführer · Bayern');
  assert.equal(new Set(queries.map((query) => query.key)).size, queries.length, 'Schlüssel eindeutig');
  // Region ohne Teilregionen: nur die beiden Anfragen
  assert.equal(classicQueries({ ...PROFILE, region: 'München' }).length, 2);
  // Standardprofil: 24 Kombinationen × (Land, Firma, 16 Bundesländer)
  assert.equal(classicQueries(DEFAULT_SEARCH_PROFILE).length, 24 * 18);
});

test('Ertrag: Unbekanntes vor Ausgelaugtem, Qualifiziertes vor allem', () => {
  const none = { hits: 0, fresh: 0, likely: 0, qualified: 0 };
  assert.equal(queryPriority(null), 1);
  assert.equal(queryPriority(none), 1);
  const stale = queryPriority({ hits: 30, fresh: 0, likely: 0, qualified: 0 });
  const fresh = queryPriority({ hits: 30, fresh: 30, likely: 0, qualified: 0 });
  const good = queryPriority({ hits: 30, fresh: 30, likely: 6, qualified: 2 });
  assert.ok(stale < fresh && fresh < 1 && good > 1, `${stale} ${fresh} ${good}`);
});

test('Nächster Lauf blättert weiter, statt wieder ab Seite 1 dieselben Personen zu liefern', async () => {
  const { memory, search, searches } = await adapterSetup();
  const first = await search(10);
  assert.deepEqual(ids(first).slice(0, 2), ['ACoTEST1', 'ACoTEST2']);
  const key = classicQueries(PROFILE)[0].key;
  assert.equal(memory.query(key, Date.now())?.cursor, '10');
  // Die Anfrage war ergiebig (KI-Vorprüfung, Qualifizierung) → kommt vor allen unbekannten wieder dran.
  memory.addYield(new Map([[key, { likely: 4, qualified: 1 }]]), Date.now());
  const second = await search(10);
  assert.equal(searches().length, 2);
  assert.equal(searches()[1].query.get('cursor'), '10', 'weiter mit dem gespeicherten Cursor');
  assert.equal(ids(second)[0], 'ACoTEST11');
  assert.equal(ids(second).filter((id) => ids(first).includes(id)).length, 0, 'niemand doppelt');
  assert.equal(memory.query(key, Date.now())?.pages, 2);
});

test('Ohne Ertrag kommen erst die übrigen Anfragen dran – Firmenname, dann Bundesländer', async () => {
  const { search, searches } = await adapterSetup({ regions: true });
  await search(40);
  const bodies = searches().map((request) => request.body as { keywords?: string; advanced_keywords: object; location: string[] });
  assert.equal(bodies.length, 4);
  assert.deepEqual(bodies[0].location, ['101282230']);
  assert.deepEqual(bodies[1].advanced_keywords, { title: 'Geschäftsführer', company: 'Bauträger' });
  assert.equal(bodies[1].keywords, undefined);
  assert.deepEqual(bodies[2].location, ['loc-Bayern']);
  assert.deepEqual(bodies[3].location, ['loc-Baden-Württemberg']);
  assert.ok(searches().every((request) => !request.query.get('cursor')));
});

test('Bundesland, das LinkedIn nicht kennt, wird übersprungen (kein Abbruch, keine Suche im ganzen Land)', async () => {
  const { search, searches } = await adapterSetup();
  const hits = await search(40);
  // Fake kennt nur „Deutschland“: Land + Firma, danach ein Land-Block weiter per Cursor.
  assert.ok(hits.length >= 20);
  assert.ok(searches().every((request) => (request.body as { location: string[] }).location[0] === '101282230'));
});

test('Abgelaufener Cursor aus einem früheren Lauf: Anfrage fängt vorne an, der Lauf geht weiter', async () => {
  const { memory, search, searches } = await adapterSetup({ badCursor: 'alt' });
  const key = classicQueries(PROFILE)[0].key;
  memory.savePage(key, 'x', { cursor: 'alt', hits: 10, fresh: 10, exhausted: false }, Date.now());
  memory.addYield(new Map([[key, { likely: 5, qualified: 2 }]]), Date.now());
  const hits = await search(10);
  assert.equal(searches()[0].query.get('cursor'), 'alt');
  assert.equal(searches()[1].query.get('cursor'), null);
  assert.equal(hits.length, 10);
  assert.equal(memory.query(key, Date.now())?.cursor, '10');
});

test('Ausgeschöpfte Anfrage ruht 30 Tage, dann fängt sie vorne an', async () => {
  const dataDir = tempDataDir();
  const memory = new SearchMemory(openDatabase(dataDir));
  const day = 24 * 60 * 60 * 1000;
  memory.savePage('k', 'K', { cursor: null, hits: 3, fresh: 3, exhausted: true }, 0);
  assert.notEqual(memory.query('k', 10 * day)?.exhaustedAt, null);
  const later = memory.query('k', 31 * day);
  assert.equal(later?.exhaustedAt, null);
  assert.equal(later?.pages, 0);
  assert.equal(later?.hits, 3, 'Ertrag bleibt');
});

async function liveApp(people: number, env: Record<string, string> = {}) {
  const unipile = await startFakeUnipile({ people });
  const anthropic = await startFakeAnthropic();
  const meta = await startFakeMeta();
  servers.push(unipile, anthropic, meta);
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    UNIPILE_DSN: unipile.baseUrl,
    UNIPILE_API_KEY: 'unipile-test-key',
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    META_ACCESS_TOKEN: 'meta-test-key',
    DATA_DIR: tempDataDir(),
    ...env,
  });
  const adapter = createLiveAdapter(config, { pause: async () => {}, anthropicBaseURL: anthropic.baseUrl, metaBaseURL: meta.baseUrl });
  const app = buildApp({ config, adapter, logger: false, requireSession: false });
  const run = async (maxResults = 5): Promise<RunSnapshot> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/lead-search/runs',
      payload: startBody({ known: [], checked: [], profile: { ...DEFAULT_SEARCH_PROFILE, maxResults } }),
    });
    assert.equal(response.statusCode, 202, response.body);
    return waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id, 15_000);
  };
  const fetched = () => unipile.requests.filter((request) => /^\/api\/v1\/users\/ACo/.test(request.path)).map((request) => request.path.split('/').pop()!);
  const searches = () => unipile.requests.filter((request) => request.path === '/api/v1/linkedin/search').length;
  const prescreens = () =>
    anthropic.requests.filter((request) => systemText(request.body).includes('[cockpit:vorpruefung]')).length;
  return { app, config, run, fetched, searches, prescreens };
}

test('Live: geprüfte Profile aus früheren Läufen (auch von Hand) zählen nicht – auch ohne Liste aus dem Browser', async () => {
  const { app, run, fetched } = await liveApp(30);
  const first = await run();
  assert.equal(first.status, 'done');
  const decided = first.leads.filter((lead) => lead.profile && ['qualified', 'ads_active', 'rejected'].includes(lead.status)).map((lead) => lead.id);
  assert.ok(decided.length > 0);
  const second = await run();
  for (const id of decided) {
    const lead = second.leads.find((entry) => entry.id === id);
    if (lead) assert.ok(lead.status === 'duplicate', `${id}: ${lead.status}`);
  }
  // Der zweite Lauf ruft keines der schon entschiedenen Profile noch einmal ab.
  for (const id of decided) assert.equal(fetched().filter((entry) => entry === id).length, 1, id);
  await app.close();
});

test('Startdialog: Suchtreffer gelten wie eingestellt (mindestens Profile pro Lauf), keine Verdopplung', async () => {
  const { app, run } = await liveApp(1000, { SEARCH_HITS_PER_RUN: '50' });
  const first = await run(50);
  assert.deepEqual(first.searchPlan, { hits: 50, backlog: 0, newHits: 50 });
  assert.ok(first.leads.length <= 50, String(first.leads.length));
  const config = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json() as { backlog?: number };
  assert.equal(config.backlog, first.leads.filter((lead) => lead.status === 'deferred').length);
  await app.close();
});

test('Warteliste größer als die Trefferzahl: der Lauf nimmt nur so viele, der Rest wartet weiter', async () => {
  const { app, config, run, searches, prescreens } = await liveApp(1000);
  const first = await run(3);
  const deferred = first.leads.filter((lead) => lead.status === 'deferred').map((lead) => lead.id);
  assert.ok(deferred.length > 30, String(deferred.length));
  config.searchHits = 20;
  const before = searches();
  const prescreensBefore = prescreens();
  const second = await run(3);
  // Die Warteliste ist schon vorgeprüft – die KI sieht sie nicht noch einmal (kostet nichts).
  assert.equal(prescreens(), prescreensBefore, 'keine neue Vorprüfung');
  assert.ok(second.leads.every((lead) => lead.prescreen), 'Vorprüfung aus der Warteliste übernommen');
  assert.deepEqual(second.searchPlan, { hits: 20, backlog: 20, newHits: 0 });
  assert.equal(searches(), before, 'keine neue Suchseite');
  assert.equal(second.leads.length, 20);
  const waiting = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json() as { backlog?: number };
  assert.equal(waiting.backlog, deferred.length - 3);
  await app.close();
});

test('Live: zurückgestellte Treffer (Limit erreicht) kommen beim nächsten Lauf zuerst dran', async () => {
  const { app, run, fetched, searches } = await liveApp(1000);
  const first = await run(3);
  const deferred = first.leads.filter((lead) => lead.status === 'deferred').map((lead) => lead.id);
  assert.ok(deferred.length > 10, String(deferred.length));
  assert.deepEqual(first.searchPlan, { hits: 400, backlog: 0, newHits: 400 });
  const before = fetched().length;
  const searchesBefore = searches();
  const second = await run(3);
  // Die Warteliste zählt zu den Suchtreffern: neu gesucht wird nur, was bis 400 fehlt (Wunsch des Nutzers 12.10.).
  assert.deepEqual(second.searchPlan, { hits: 400, backlog: deferred.length, newHits: Math.max(0, 400 - deferred.length) });
  if (second.searchPlan!.newHits === 0) assert.equal(searches(), searchesBefore, 'keine neue Suchseite');
  const secondFetched = fetched().slice(before);
  assert.equal(secondFetched.length, 3);
  // Die Profile des zweiten Laufs stammen aus der Warteliste – nicht aus neuen Suchseiten.
  for (const id of secondFetched) assert.ok(deferred.includes(id), id);
  for (const id of deferred) assert.ok(second.leads.some((lead) => lead.id === id), `${id} wieder im Lauf`);
  // Erledigte sind raus aus der Warteliste: Ein dritter Lauf ruft sie nicht noch einmal ab.
  const third = await run(3);
  assert.equal(third.status, 'done');
  for (const id of secondFetched) assert.equal(fetched().filter((entry) => entry === id).length, 1, id);
  await app.close();
});
