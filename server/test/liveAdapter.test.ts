import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE, funnelOf, type RunSnapshot } from '../../shared/leadSearch.js';
import {
  PROFILE_PAUSE_MS,
  buildSearchBody,
  maxSearchRequests,
  pickLocation,
  searchCombinations,
  createLiveAdapter,
  orJoin,
  toAdapterError,
  type PauseFn,
} from '../src/adapters/live/liveAdapter.js';
import { UnipileHttpError } from '../src/adapters/live/unipileClient.js';
import { AdapterError } from '../src/pipeline/adapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { randomBetween } from '../src/lib/sleep.js';
import { countBy, startBody, tempDataDir, waitForEnd } from './helpers.js';
import {
  startFakeAnthropic,
  startFakeMeta,
  startFakeUnipile,
  type FakeAnthropicOptions,
  type FakeMetaOptions,
  type FakeUnipileOptions,
  systemText,
} from './fakeServers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

async function liveSetup(
  unipileOptions: FakeUnipileOptions = {},
  anthropicOptions: FakeAnthropicOptions = {},
  env: NodeJS.ProcessEnv = {},
  metaOptions: FakeMetaOptions = {},
) {
  const unipile = await startFakeUnipile(unipileOptions);
  const anthropic = await startFakeAnthropic(anthropicOptions);
  const meta = await startFakeMeta(metaOptions);
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
  const pauses: Array<{ min: number; max: number }> = [];
  const pause: PauseFn = async (range) => {
    pauses.push(range);
  };
  const adapter = createLiveAdapter(config, {
    pause,
    anthropicBaseURL: anthropic.baseUrl,
    metaBaseURL: meta.baseUrl,
    now: () => new Date('2026-10-02T10:00:00Z'),
  });
  const app = buildApp({ config, adapter, logger: false, requireSession: false });
  const run = async (maxResults = 15): Promise<RunSnapshot> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/lead-search/runs',
      payload: startBody({ known: [], profile: { ...DEFAULT_SEARCH_PROFILE, maxResults } }),
    });
    assert.equal(response.statusCode, 202, response.body);
    return waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id, 15_000);
  };
  const profileFetches = () => unipile.requests.filter((r) => /^\/api\/v1\/users\/ACo/.test(r.path));
  return { app, run, unipile, anthropic, meta, pauses, profileFetches };
}

test('Suchanfrage: klassisch mit Titel-Filter, Region-ID und nur 2./3. Grad', () => {
  assert.equal(orJoin(['Kapitalanlage', 'Bauträger']), 'Kapitalanlage OR Bauträger');
  assert.equal(orJoin(['Real Estate', 'CEO']), '"Real Estate" OR CEO');
  assert.deepEqual(buildSearchBody('classic', DEFAULT_SEARCH_PROFILE, '101282230'), {
    api: 'classic',
    category: 'people',
    keywords: 'Kapitalanlage OR Immobilienvertrieb OR Finanzdienstleister OR Finanzvertrieb',
    advanced_keywords: { title: 'Geschäftsführer OR Inhaber OR Gründer OR Gesellschafter OR CEO OR Vorstand' },
    location: ['101282230'],
    network_distance: [2, 3],
  });
  const salesNav = buildSearchBody('sales_navigator', DEFAULT_SEARCH_PROFILE, '42') as Record<string, unknown>;
  assert.equal(salesNav.api, 'sales_navigator');
  assert.deepEqual(salesNav.location, { include: ['42'] });
  assert.deepEqual(salesNav.network_distance, [2, 3]);
});

test('Klassische Suche: alle Kombinationen aus Stichwort und Position, wichtigste zuerst', () => {
  const combos = searchCombinations(DEFAULT_SEARCH_PROFILE);
  assert.equal(combos.length, 24);
  assert.equal(new Set(combos.map((c) => `${c.position}|${c.keyword}`)).size, 24);
  assert.deepEqual(combos.slice(0, 6), [
    { position: 'Geschäftsführer', keyword: 'Kapitalanlage' },
    { position: 'Geschäftsführer', keyword: 'Immobilienvertrieb' },
    { position: 'Inhaber', keyword: 'Kapitalanlage' },
    { position: 'Geschäftsführer', keyword: 'Finanzdienstleister' },
    { position: 'Inhaber', keyword: 'Immobilienvertrieb' },
    { position: 'Gründer', keyword: 'Kapitalanlage' },
  ]);
});

test('Pausen zwischen Profilabrufen liegen zwischen 3 und 8 Sekunden', () => {
  assert.deepEqual(PROFILE_PAUSE_MS, { min: 3000, max: 8000 });
  assert.equal(randomBetween(PROFILE_PAUSE_MS.min, PROFILE_PAUSE_MS.max, () => 0), 3000);
  assert.equal(randomBetween(PROFILE_PAUSE_MS.min, PROFILE_PAUSE_MS.max, () => 0.999999), 8000);
});

test('Live-Lauf: Suche, Dubletten, Anreicherung, KI – mit Limit und Pausen', async () => {
  const { run, unipile, anthropic, meta, pauses, profileFetches } = await liveSetup();
  const result = await run(15);

  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.equal(result.mode, 'live');
  assert.deepEqual(funnelOf(result.leads), { found: 30, unique: 26, screened: 26, enriched: 14, fit: 9, qualified: 6 });
  assert.deepEqual(countBy(result.leads, (lead) => lead.status), {
    qualified: 6,
    ads_active: 3,
    rejected: 5,
    invited: 3,
    connected: 1,
    deferred: 12,
  });
  assert.equal(result.leads.find((lead) => lead.id === 'ACoTEST3')?.status, 'invited', 'offene Anfrage laut Suche');
  assert.equal(result.leads.find((lead) => lead.id === 'ACoTEST5')?.status, 'invited', 'offene Anfrage laut /users/invite/sent');
  assert.equal(result.leads.find((lead) => lead.id === 'ACoTEST7')?.status, 'invited', 'offene Anfrage laut Profil');
  assert.equal(result.leads.find((lead) => lead.id === 'ACoTEST4')?.status, 'connected');

  // Höchstens 15 Profilabrufe, zwischen ihnen Pausen von 3–8 s
  assert.equal(profileFetches().length, 15);
  assert.equal(pauses.filter((p) => p.min === 3000 && p.max === 8000).length, 14);

  // Anfragen wie dokumentiert
  for (const request of unipile.requests) assert.equal(request.headers['x-api-key'], 'unipile-test-key');
  // Klassische Suche: je eine einfache Anfrage pro Stichwort + Position, ohne ODER-Logik, unbekannte Anfragen zuerst.
  // Der Fake hat nur 30 Personen (Kombinationen 1–3 je ein Block, danach leer): Nach 12 Seiten ohne neuen Treffer
  // gelten die unbekannten Anfragen als gesättigt, die ergiebigen blättern weiter (nur Bekannte) bis zum Ende.
  const searches = unipile.requests.filter((r) => r.path === '/api/v1/linkedin/search');
  assert.equal(searches.length, 18);
  assert.equal(searches.slice(0, 15).filter((r) => r.query.get('cursor')).length, 0, 'erst unbekannte Anfragen');
  assert.deepEqual(searches.slice(15).map((r) => r.query.get('cursor')), ['10', '20', '20']);
  assert.equal(searches[0].query.get('account_id'), 'acc_linkedin');
  assert.equal(searches[0].query.get('limit'), '10');
  assert.equal(searches[0].query.get('cursor'), null);
  assert.deepEqual(searches[0].body, {
    api: 'classic',
    category: 'people',
    keywords: 'Kapitalanlage',
    advanced_keywords: { title: 'Geschäftsführer' },
    location: ['101282230'],
    network_distance: [2, 3],
  });
  const pairs = searches.map((r) => {
    const body = r.body as { keywords: string; advanced_keywords: { title: string } };
    return `${body.advanced_keywords.title}+${body.keywords}`;
  });
  assert.deepEqual(pairs.slice(0, 4), [
    'Geschäftsführer+Kapitalanlage',
    'Geschäftsführer+Immobilienvertrieb',
    'Inhaber+Kapitalanlage',
    'Geschäftsführer+Finanzdienstleister',
  ]);
  assert.ok(searches.every((r) => !JSON.stringify(r.body).includes(' OR ')), 'keine ODER-Verknüpfung');
  assert.equal(pauses.filter((p) => p.min === 2000).length, 17, 'Pause zwischen den Suchanfragen');
  const parameters = unipile.requests.find((r) => r.path === '/api/v1/linkedin/search/parameters');
  assert.equal(parameters?.query.get('type'), 'LOCATION');
  assert.equal(parameters?.query.get('keywords'), 'Deutschland');
  const profile = profileFetches()[0];
  assert.equal(profile.query.get('notify'), 'false');
  assert.equal(profile.query.get('linkedin_sections'), 'experience');

  // Anreicherung: aktuelle Position + Firmenprofil
  const lead = result.leads.find((entry) => entry.id === 'ACoTEST6');
  assert.equal(lead?.profile?.position, 'Geschäftsführer');
  assert.equal(lead?.profile?.companyName, 'Kapital Invest 6 GmbH');
  assert.equal(lead?.profile?.companyWebsite, 'https://firma-6.example');
  assert.equal(lead?.profile?.companyDescription, 'Beschreibung von Kapital Invest 6 GmbH.');

  // KI-Vorprüfung: eine Anfrage für alle 27 neuen Treffer (ACoTEST7 zeigt erst das Profil als offene Anfrage), vor dem ersten Profilabruf
  const isPrescreen = (r: { body: unknown }) => systemText(r.body).includes('[cockpit:vorpruefung]');
  assert.equal(anthropic.requests.filter(isPrescreen).length, 1);
  assert.ok(isPrescreen(anthropic.requests[0]));
  assert.equal(((anthropic.requests[0].body as { messages: Array<{ content: string }> }).messages[0].content.match(/^\d+\. Name:/gm) ?? []).length, 27);
  assert.ok(result.leads.filter((entry) => entry.status !== 'duplicate' && entry.status !== 'invited' && entry.status !== 'connected').every((entry) => entry.prescreen?.fit === 'likely'));

  // KI-Anfrage: strukturierte Ausgabe, Modell aus der Konfiguration
  const qualifying = anthropic.requests.filter((r) => !isPrescreen(r));
  assert.equal(qualifying.length, 14);
  const llm = qualifying[0].body as {
    model: string;
    system: unknown;
    output_config: { format: { type: string; schema: { properties: Record<string, unknown> } }; effort: string };
  };
  assert.equal(llm.model, 'claude-opus-5-5');
  assert.equal(llm.output_config.format.type, 'json_schema');
  assert.deepEqual(Object.keys(llm.output_config.format.schema.properties).sort(), ['category', 'confidence', 'hiringRole', 'qualified', 'reason', 'summary']);
  assert.equal(llm.output_config.effort, 'low');
  assert.match(systemText(llm), /ausgewogen auslegen/);
  assert.ok(!/Unter 0.6/.test(systemText(llm)), 'Schwelle legt die Einstellung fest, nicht der Prompt');
  assert.equal(qualifying[0].headers['x-api-key'], 'anthropic-test-key');

  // Meta-Werbebibliothek: nur für Leads, die die KI qualifiziert hat
  const companyOf = (id: string) => result.leads.find((entry) => entry.id === id)?.profile?.companyName ?? '';
  const active = result.leads.filter((entry) => entry.status === 'ads_active');
  assert.ok(active.every((entry) => /^Kapital Invest \d*[02468] GmbH$/.test(companyOf(entry.id))), 'aktive eigene Anzeige');
  assert.ok(active.every((entry) => entry.note === 'Aktive Meta-Ads (1) – von Hand prüfen' && entry.metaAds?.foreignAds === 1));
  const bau = result.leads.filter((entry) => entry.profile?.companyName?.startsWith('Bau Projekt') && entry.status === 'qualified');
  assert.ok(bau.length > 0);
  for (const entry of bau) {
    assert.equal(entry.metaAds?.state, 'stopped');
    assert.equal(entry.metaAds?.lastStop, '2026-06-15');
    assert.equal(entry.metaAds?.ads, 2);
    assert.equal(entry.metaAds?.advertiser, entry.profile?.companyName);
    assert.match(entry.metaAds?.libraryUrl ?? '', /country=DE&view_all_page_id=20\d+&search_type=page&media_type=all$/);
    assert.equal(entry.note, null);
  }
  const noAds = result.leads.filter((entry) => entry.metaAds?.state === 'none');
  assert.ok(noAds.length > 0 && noAds.every((entry) => /^Kapital Invest \d*[13579] GmbH$/.test(companyOf(entry.id))));
  assert.ok(noAds.every((entry) => entry.status === 'qualified' && entry.metaAds?.note === 'Nur Fremdtreffer (1 Anzeige anderer Werbetreibender)'));
  assert.ok(result.leads.filter((entry) => entry.status === 'rejected').every((entry) => entry.metaAds === null));

  const terms = meta.requests.map((r) => r.query.get('search_terms'));
  assert.ok(terms.every((term) => term && !/Makler/.test(term)), 'Aussortierte kosten keine Abfrage');
  // Ohne eigenen Treffer zusätzlich die Website-Domain
  for (const entry of noAds) assert.ok(terms.includes(`firma-${entry.id.replace('ACoTEST', '')}.example`));
  // Firma ohne aktive Anzeigen: zusätzlich der private Name der Person (15.10.).
  const withoutActive = result.leads.filter((entry) => entry.metaAds && entry.metaAds.state !== 'active');
  assert.ok(withoutActive.length > 0);
  for (const entry of withoutActive) assert.ok(terms.includes(`${entry.hit.firstName} ${entry.hit.lastName}`));
  assert.equal(meta.requests.length, 9 + noAds.length + withoutActive.length);
  const first = meta.requests[0];
  assert.match(first.path, /^\/v26\.0\/ads_archive$/);
  assert.equal(first.query.get('access_token'), 'meta-test-key');
  assert.equal(first.query.get('ad_type'), 'ALL');
  assert.equal(first.query.get('ad_reached_countries'), '["DE"]');
  assert.equal(first.query.get('ad_active_status'), 'ALL');
  assert.equal(first.query.get('search_type'), 'KEYWORD_UNORDERED');
  assert.match(first.query.get('search_terms') ?? '', /^(Kapital Invest|Bau Projekt) \d+$/, 'Firmenname ohne Rechtsform');
  assert.deepEqual(first.query.get('fields')?.split(','), [
    'id',
    'page_id',
    'page_name',
    'ad_delivery_start_time',
    'ad_delivery_stop_time',
    'ad_creative_link_captions',
  ]);
  assert.equal(first.query.get('limit'), '100');
});

test('Meta-Token abgelaufen: Lauf läuft weiter, Leads bleiben qualifiziert („Meta nicht geprüft“), Token taucht nirgends auf', async () => {
  // Wunsch des Nutzers 12.10.: Meta-Ads sind Zusatzwissen für die Nachricht – wegen Meta fliegt keiner raus.
  const { run, meta } = await liveSetup({}, {}, { META_ACCESS_TOKEN: 'abgelaufen-123' });
  const result = await run();
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.equal(result.error, null);
  assert.doesNotMatch(JSON.stringify(result), /abgelaufen-123/);
  const qualified = result.leads.filter((lead) => lead.status === 'qualified');
  assert.ok(qualified.length > 0);
  for (const lead of qualified) {
    assert.equal(lead.metaAds?.state, 'unchecked');
    assert.match(lead.metaAds?.note ?? '', /Meta-Token ungültig oder abgelaufen – Meta-Ads in diesem Lauf nicht geprüft/);
  }
  // Nach dem ersten Fehler fragt der Lauf Meta nicht weiter.
  assert.ok(meta.requests.length <= 2, String(meta.requests.length));
});

test('Meta-Limit (#4) und fehlende Rechte (#10): Lauf läuft weiter, Meta bleibt ungeprüft', async () => {
  const limited = await (await liveSetup({}, {}, {}, { error: { status: 400, code: 4, message: 'Application request limit reached' } })).run();
  assert.equal(limited.status, 'done');
  assert.ok(limited.leads.some((lead) => lead.status === 'qualified' && /Meta-Limit erreicht/.test(lead.metaAds?.note ?? '')));
  const denied = await (await liveSetup({}, {}, {}, { error: { status: 400, code: 10, message: 'Application does not have permission for this action' } })).run();
  assert.equal(denied.status, 'done');
  assert.ok(denied.leads.some((lead) => lead.status === 'qualified' && /Kein Zugriff auf die Meta-Werbebibliothek/.test(lead.metaAds?.note ?? '')));
});

test('Meta-Serverfehler betrifft nur den einen Lead: bleibt qualifiziert, aber „nicht geprüft“', async () => {
  const { run } = await liveSetup({}, {}, {}, { error: { status: 500, code: 2, message: 'Service temporarily unavailable' } });
  const result = await run();
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  const qualified = result.leads.filter((lead) => lead.status === 'qualified');
  assert.equal(qualified.length, 9);
  assert.ok(qualified.every((lead) => lead.metaAds?.state === 'unchecked' && /Service temporarily unavailable/.test(lead.note ?? '')));
  assert.ok(qualified.every((lead) => lead.metaAds?.libraryUrl?.includes('q=')), 'Link zum Selbst-Nachsehen');
});

test('Live ohne META_ACCESS_TOKEN: Hinweis vorab, Qualifizierte bleiben „Meta-Ads nicht geprüft“', async () => {
  const { app, run, meta } = await liveSetup({}, {}, { META_ACCESS_TOKEN: '' });
  const info = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(info.ready, true);
  assert.equal(info.metaAds, false);
  assert.match(info.warnings[0], /Meta-Token \(Einstellungen/);
  const result = await run(5);
  assert.equal(result.status, 'done');
  assert.equal(meta.requests.length, 0);
  const qualified = result.leads.filter((lead) => lead.status === 'qualified');
  assert.ok(qualified.length > 0);
  assert.ok(qualified.every((lead) => lead.metaAds?.state === 'unchecked' && lead.note === 'META_ACCESS_TOKEN fehlt – Meta-Ads nicht geprüft'));
});

test('META_GRAPH_VERSION: „26“, „v26.0“ und „26.0“ sind gleich, Unsinn wird abgelehnt', () => {
  assert.equal(loadConfig({}).meta.graphVersion, 'v26.0');
  assert.equal(loadConfig({ META_GRAPH_VERSION: '27' }).meta.graphVersion, 'v27.0');
  assert.equal(loadConfig({ META_GRAPH_VERSION: 'v25.0' }).meta.graphVersion, 'v25.0');
  assert.throws(() => loadConfig({ META_GRAPH_VERSION: 'neueste' }), /META_GRAPH_VERSION/);
});

test('Limit-Fehler von Unipile (429) bricht den Lauf ab – verständliche Meldung, keine weiteren Abrufe', async () => {
  const { run, profileFetches } = await liveSetup({ failProfile: { at: 3, status: 429 } });
  const result = await run(15);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'rate_limit');
  assert.equal(result.error?.title, 'LinkedIn-Limit erreicht');
  assert.match(result.error?.message ?? '', /abgebrochen/);
  assert.equal(profileFetches().length, 3);
  // Was vor dem Fehler fertig wurde, bleibt erhalten und übergebbar.
  assert.equal(result.leads.find((lead) => lead.id === 'ACoTEST1')?.status, 'qualified');
  assert.ok(result.leads.every((lead) => !['found', 'unique', 'enriching', 'enriched', 'qualifying'].includes(lead.status)));
});

test('Fehler 500 beim Profilabruf bricht vorsichtshalber ab – als Unipile-Fehler, nicht als LinkedIn-Ablehnung', async () => {
  const { run, profileFetches } = await liveSetup({ failProfile: { at: 2, status: 500, type: 'errors/unexpected_error' } });
  const result = await run(15);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.title, 'Unipile meldet einen Fehler');
  assert.doesNotMatch(result.error?.message ?? '', /^LinkedIn/);
  assert.equal(profileFetches().length, 2);
});

test('503 no_client_session (Unipile-Testzeitraum abgelaufen): klare Meldung statt Limit-Verdacht', async () => {
  const { run, app, profileFetches } = await liveSetup({ sessionDown: true });
  const result = await run(15);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'auth');
  assert.equal(result.error?.title, 'Unipile-Sitzung nicht aktiv');
  assert.match(result.error?.message ?? '', /no_client_session/);
  assert.match(result.error?.message ?? '', /Abo/);
  assert.doesNotMatch(result.error?.message ?? '', /Limit/);
  assert.equal(profileFetches().length, 0);
  // Auch der Account-Status nennt den Grund.
  const config = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json() as { account: { state: string; message: string } | null };
  assert.equal(config.account?.state, 'unreachable');
  assert.match(config.account?.message ?? '', /keine Sitzung \(no_client_session\)/);
});

test('toAdapterError: no_client_session auch am Text erkannt, sonst 5xx ohne „LinkedIn hat … abgelehnt“', () => {
  const byType = toAdapterError(new UnipileHttpError(503, 'errors/no_client_session', null, '/accounts'), 'setup') as AdapterError;
  assert.equal(byType.title, 'Unipile-Sitzung nicht aktiv');
  assert.equal(byType.fatal, true);
  const byDetail = toAdapterError(new UnipileHttpError(503, null, 'No client session is currently running', '/accounts'), 'search') as AdapterError;
  assert.equal(byDetail.title, 'Unipile-Sitzung nicht aktiv');
  const other = toAdapterError(new UnipileHttpError(503, 'errors/service_unavailable', null, '/linkedin/search'), 'search') as AdapterError;
  assert.equal(other.title, 'Unipile meldet einen Fehler');
  assert.equal(other.fatal, true);
});

test('Auth-Fehler von Unipile bricht vor jedem Profilabruf ab', async () => {
  const { run, profileFetches } = await liveSetup({ searchStatus: 401 });
  const result = await run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'auth');
  assert.equal(result.error?.title, 'Unipile-Zugang abgelehnt');
  assert.equal(profileFetches().length, 0);
});

test('falscher Unipile-Key → Auth-Fehler', async () => {
  const unipile = await startFakeUnipile();
  const anthropic = await startFakeAnthropic();
  servers.push(unipile, anthropic);
  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'falsch', ANTHROPIC_API_KEY: 'x', DATA_DIR: tempDataDir() });
  const app = buildApp({ config, adapter: createLiveAdapter(config, { pause: async () => {}, anthropicBaseURL: anthropic.baseUrl }), logger: false, requireSession: false });
  const started = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody({ known: [] }) });
  const result = await waitForEnd(app, started.json().run.id);
  assert.equal(result.error?.code, 'auth');
});

test('Auth-Fehler von Anthropic bricht den Lauf ab', async () => {
  const { run, profileFetches } = await liveSetup({}, { status: 401 });
  const result = await run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.title, 'Anthropic-Zugang abgelehnt');
  assert.ok(profileFetches().length < 15, `nach dem Fehler keine weiteren Profile (${profileFetches().length})`);
});

test('Anthropic-Guthaben leer: verständliche Meldung statt Roh-JSON, Lauf bricht ab, kein Profil wird gelesen', async () => {
  const { run, profileFetches } = await liveSetup(
    {},
    {
      status: 400,
      errorType: 'invalid_request_error',
      errorMessage: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    },
  );
  const result = await run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'auth');
  assert.equal(result.error?.title, 'Anthropic-Guthaben aufgebraucht');
  assert.match(result.error?.message ?? '', /Plans & Billing Guthaben auf/);
  assert.ok(!(result.error?.message ?? '').includes('{'), 'kein Roh-JSON');
  // Die Vorprüfung scheitert zuerst – ohne Guthaben werden keine Profile mehr abgerufen.
  assert.equal(profileFetches().length, 0);
  // Was nicht mehr bearbeitet wurde, ist zurückgestellt (kommt beim nächsten Lauf zuerst dran).
  assert.ok(result.leads.some((lead) => lead.status === 'deferred'));
});

test('ungültige KI-Ausgabe betrifft nur den einen Lead', async () => {
  const { run } = await liveSetup({}, { brokenFor: 'Makler 2' });
  const result = await run();
  assert.equal(result.status, 'done');
  const broken = result.leads.find((lead) => lead.id === 'ACoTEST2');
  assert.equal(broken?.status, 'failed');
  assert.equal(broken?.note, 'KI-Ausgabe ungültig – Lead nicht bewertet');
  assert.equal(funnelOf(result.leads).fit, 9);
});

test('Modell kommt aus ANTHROPIC_MODEL; Haiku ohne effort', async () => {
  const { run, anthropic } = await liveSetup({}, {}, { ANTHROPIC_MODEL: 'claude-haiku-4-5' });
  await run(3);
  const body = anthropic.requests[0].body as { model: string; output_config: Record<string, unknown> };
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal('effort' in body.output_config, false);
});

test('Live-Modus ohne Schlüssel: Oberfläche bekommt verständliche Hinweise, Start wird abgelehnt', async () => {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', DATA_DIR: tempDataDir() });
  const app = buildApp({ config, adapter: createLiveAdapter(config), logger: false, requireSession: false });
  const info = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(info.mode, 'live');
  assert.equal(info.ready, false);
  assert.equal(info.problems.length, 2, 'Unipile-DSN und -Key sind Pflicht');
  assert.equal(info.warnings.length, 1, 'Anthropic-Key fehlt nur als Hinweis');
  assert.deepEqual(info.live, { searchApi: 'classic', model: 'claude-opus-5-5' });
  assert.equal(info.metaAds, false);
  const start = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  assert.equal(start.statusCode, 400);
  assert.match(start.json().error.message, /Unipile-Token fehlt/);
  // Keine Schlüssel in der Antwort
  assert.doesNotMatch(JSON.stringify(info), /key-|sk-ant/);
});

test('MAX_RESULTS aus der Umgebung wird auf 1000 begrenzt (seit 11.10. statt 25)', () => {
  assert.equal(loadConfig({ MAX_RESULTS: '80' }).maxResults, 80);
  assert.equal(loadConfig({ MAX_RESULTS: '5000' }).maxResults, 1000);
  assert.equal(loadConfig({ MAX_RESULTS: '0' }).maxResults, 1);
  assert.equal(loadConfig({}).maxResults, 15);
});

test('Account-Prüfung: ohne LinkedIn-Account ist die Live-Suche gesperrt, mit Account sofort startklar', async () => {
  const accounts: object[] = [{ object: 'Account', type: 'WHATSAPP', id: 'acc_whatsapp' }];
  const { app, run, profileFetches } = await liveSetup({ accounts });

  const before = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(before.ready, false);
  assert.equal(before.account.state, 'missing');
  assert.match(before.account.message, /Unipile-Dashboard/);

  // Wird trotzdem gestartet: sauberer Abbruch, keine LinkedIn-Aufrufe
  const failed = await run();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.title, 'Kein LinkedIn-Account verbunden');
  assert.equal(profileFetches().length, 0);

  // Account wird im Unipile-Dashboard verbunden – erst „verbindet“, dann startklar, ohne Neustart
  accounts.push({ object: 'Account', type: 'LINKEDIN', id: 'acc_new', name: 'Nick Muster', sources: [{ id: 's', status: 'CONNECTING' }] });
  const connecting = (await app.inject({ method: 'GET', url: '/api/lead-search/config?refresh=1' })).json();
  assert.equal(connecting.account.state, 'connecting');
  assert.equal(connecting.ready, false);

  (accounts[1] as { sources: Array<{ status: string }> }).sources[0].status = 'OK';
  const cached = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(cached.account.state, 'connecting', 'ohne refresh aus dem Zwischenspeicher');
  const ready = (await app.inject({ method: 'GET', url: '/api/lead-search/config?refresh=1' })).json();
  assert.deepEqual(ready.account, { state: 'ok', name: 'Nick Muster', message: '' });
  assert.equal(ready.ready, true);

  const result = await run(3);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.equal(profileFetches().length, 3);
});

test('Account-Prüfung: Neu-Verbinden nötig, falsche UNIPILE_ACCOUNT_ID, falscher Key', async () => {
  const reconnect = await liveSetup({
    accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_li', name: 'Nick', sources: [{ id: 's', status: 'CREDENTIALS' }] }],
  });
  const one = (await reconnect.app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(one.account.state, 'reconnect');
  assert.equal(one.ready, false);

  const wrongId = await liveSetup({}, {}, { UNIPILE_ACCOUNT_ID: 'gibt_es_nicht' });
  const two = (await wrongId.app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(two.account.state, 'missing');
  assert.match(two.account.message, /gibt_es_nicht/);

  const wrongKey = await liveSetup({}, {}, { UNIPILE_API_KEY: 'falsch' });
  const three = (await wrongKey.app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(three.account.state, 'unreachable');
  assert.match(three.account.message, /Einstellungen → LinkedIn \(Unipile\)/);
  assert.equal(three.ready, false);
});

test('Simulation: keine Account-Prüfung', async () => {
  const { mockApp } = await import('./helpers.js');
  const info = (await mockApp().inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(info.account, null);
  assert.equal(info.ready, true);
});

test('Live ohne ANTHROPIC_API_KEY: Leads werden gefunden und angereichert, aber nicht bewertet', async () => {
  const { app, run, anthropic, profileFetches } = await liveSetup({}, {}, { ANTHROPIC_API_KEY: '' });
  const info = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json();
  assert.equal(info.ready, true);
  assert.match(info.warnings[0], /nicht von der KI bewertet/);

  const result = await run(5);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.equal(profileFetches().length, 5);
  assert.equal(anthropic.requests.length, 0);
  const unrated = result.leads.filter((lead) => lead.status === 'unrated');
  assert.equal(unrated.length, 4, '5 Profile, davon eines mit offener Anfrage laut Profil');
  assert.ok(unrated.every((lead) => lead.profile?.companyName && lead.note?.includes('ANTHROPIC_API_KEY')));
  assert.deepEqual(funnelOf(result.leads), { found: 30, unique: 26, screened: 26, enriched: 4, fit: 0, qualified: 0 });
});

test('Sales Navigator mit schon geprüften Profilen: volle Seite statt Mini-Seiten', async () => {
  const unipile = await startFakeUnipile({ people: 60 });
  servers.push(unipile);
  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'unipile-test-key', UNIPILE_SEARCH_API: 'sales_navigator', DATA_DIR: tempDataDir() });
  const adapter = createLiveAdapter(config, { pause: async () => {} });
  const skip = new Set(['ACoTEST1', 'ACoTEST2', 'ACoTEST3', 'ACoTEST4', 'ACoTEST5']);
  const ctx = { signal: new AbortController().signal, runId: 'r1', profile: DEFAULT_SEARCH_PROFILE };
  const hits = await adapter.search(DEFAULT_SEARCH_PROFILE, { maxHits: 3, onHits: () => {}, skip }, ctx);
  const searches = unipile.requests.filter((request) => request.path === '/api/v1/linkedin/search');
  assert.deepEqual(searches.map((request) => request.query.get('limit')), ['25'], 'eine volle Seite');
  assert.deepEqual(hits.filter((hit) => !skip.has(hit.providerId)).map((hit) => hit.providerId), ['ACoTEST6', 'ACoTEST7', 'ACoTEST8']);
  assert.equal(hits.filter((hit) => skip.has(hit.providerId)).length, 5);

  // Ohne skip bleibt es bei genau so vielen Treffern wie nötig.
  unipile.requests.length = 0;
  await adapter.search(DEFAULT_SEARCH_PROFILE, { maxHits: 3, onHits: () => {} }, { ...ctx, runId: 'r2' });
  assert.deepEqual(unipile.requests.filter((request) => request.path === '/api/v1/linkedin/search').map((request) => request.query.get('limit')), ['3']);
});

test('KI-Vorprüfung: klar Unpassendes ohne Profilabruf raus, „passt vermutlich“ zuerst angereichert', async () => {
  // Firma 10–19 unklar, Firma 2/6/8 klar falsch, Rest passt vermutlich.
  const judge = (headline: string) => (/Firma (2|6|8)$/.test(headline) ? 'no' : /Firma 1\d$/.test(headline) ? 'maybe' : 'likely');
  const { run, profileFetches } = await liveSetup({}, { prescreen: judge });
  const result = await run(10);
  assert.equal(result.status, 'done', JSON.stringify(result.error));

  const screened = result.leads.filter((lead) => lead.status === 'screened_out');
  assert.deepEqual(screened.map((lead) => lead.id).sort(), ['ACoTEST2', 'ACoTEST6', 'ACoTEST8']);
  assert.ok(screened.every((lead) => lead.profile === null && lead.note === 'Vorprüfung: Versicherungsvertrieb – keine Immobilienfirma'));
  const fetched = profileFetches().map((request) => request.path.replace('/api/v1/users/', ''));
  assert.ok(screened.every((lead) => !fetched.includes(lead.id)), 'kein Profilabruf für Aussortierte');
  // Erst alle „likely“ (1, 7, 8, 9, 20 …), „maybe“ (10–19) erst danach.
  const order = fetched.map((id) => Number(id.replace('ACoTEST', '')));
  const firstMaybe = order.findIndex((i) => i >= 10 && i <= 19);
  assert.ok(firstMaybe === -1 || order.slice(firstMaybe).every((i) => i >= 10 && i <= 19), `Reihenfolge ${order.join(',')}`);
  assert.equal(funnelOf(result.leads).screened, funnelOf(result.leads).unique - 3);
});

test('KI-Vorprüfung fällt aus: Lauf geht ohne sie weiter (nichts aussortiert)', async () => {
  const { run, profileFetches } = await liveSetup({}, { prescreenStatus: 500 });
  const result = await run(5);
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.equal(result.leads.filter((lead) => lead.status === 'screened_out').length, 0);
  assert.ok(result.leads.every((lead) => !lead.prescreen));
  assert.equal(profileFetches().length, 5);
});

test('Region: passender Ort statt blind des ersten Vorschlags (auch deutsch/englisch)', () => {
  const items = [
    { id: '1', title: 'Deutschlandsberg, Steiermark, Österreich' },
    { id: '2', title: 'Germany' },
    { id: '3', title: 'Deutschland' },
  ];
  assert.equal(pickLocation(items, 'Deutschland')?.id, '3');
  assert.equal(pickLocation(items.slice(0, 2), 'Deutschland')?.id, '2', 'englischer Name');
  assert.equal(pickLocation([{ id: '9', title: 'Hamburg, Germany' }, { id: '8', title: 'Hamburg und Umgebung' }], 'hamburg')?.id, '9', 'beginnt mit');
  assert.equal(pickLocation([{ id: '7', title: 'Metropolregion Rhein-Neckar' }], 'Rhein-Neckar')?.id, '7', 'sonst der erste');
  assert.equal(pickLocation([], 'Deutschland'), undefined);
});

test('Suchanfragen pro Lauf: so viele wie für die Trefferzahl nötig, höchstens 200', () => {
  assert.equal(maxSearchRequests(40, 10), 8);
  assert.equal(maxSearchRequests(400, 10), 80);
  assert.equal(maxSearchRequests(1000, 10), 200);
  assert.equal(maxSearchRequests(400, 25), 32);
  assert.equal(maxSearchRequests(5, 25), 4);
});

test('Klassische Suche mit vielen Treffern: alle Kombinationen reihum, Obergrenze an Anfragen', async () => {
  const unipile = await startFakeUnipile({ people: 1000 });
  servers.push(unipile);
  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', UNIPILE_DSN: unipile.baseUrl, UNIPILE_API_KEY: 'unipile-test-key', DATA_DIR: tempDataDir() });
  const adapter = createLiveAdapter(config, { pause: async () => {} });
  const ctx = { signal: new AbortController().signal, runId: 'r1', profile: DEFAULT_SEARCH_PROFILE };
  const hits = await adapter.search(DEFAULT_SEARCH_PROFILE, { maxHits: 400, onHits: () => {} }, ctx);
  const searches = unipile.requests.filter((request) => request.path === '/api/v1/linkedin/search');
  // Der Fake liefert je Suchanfrage einen eigenen Block: 24 Kombinationen + 16 mit Stichwort im Firmennamen = 400.
  assert.equal(searches.length, 40);
  assert.equal(hits.length, 400);
  assert.deepEqual((searches[24].body as { advanced_keywords: object }).advanced_keywords, { title: 'Geschäftsführer', company: 'Kapitalanlage' });
  assert.equal(new Set(hits.map((hit) => hit.providerId)).size, hits.length, 'keine Doppelten');
  // Alle 24 Kombinationen kommen dran, bevor eine Kombination zweimal blättert.
  const firstPages = searches.slice(0, 24).map((request) => JSON.stringify(request.body));
  assert.equal(new Set(firstPages).size, 24);
  assert.ok(searches.slice(0, 24).every((request) => !request.query.get('cursor')));
});
