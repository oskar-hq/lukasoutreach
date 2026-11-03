import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE, funnelOf, type LeadSearchConfig, type RunSnapshot } from '../../shared/leadSearch.js';
import {
  RELATIONS_TTL_MS,
  SENT_INVITATIONS_TTL_MS,
  accountWarnings,
  unipileTestResult,
  createLiveAdapter,
  pickLinkedinAccount,
  type PauseFn,
} from '../src/adapters/live/liveAdapter.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { MOCK_LEADS } from '../src/adapters/mock/mockData.js';
import { buildApp } from '../src/app.js';
import { liveWarnings, loadConfig } from '../src/config.js';
import { networkVerdict } from '../src/pipeline/runner.js';
import { DEMO_KNOWN, mockApp, startBody, tempDataDir, waitForEnd } from './helpers.js';
import { startFakeUnipile, type FakeUnipileOptions } from './fakeServers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

/** Such-Account (Nick, mit Sales Navigator) und Johannes' normaler Account – beide bei Unipile verbunden. */
const TWO_ACCOUNTS = [
  { object: 'Account', type: 'LINKEDIN', id: 'acc_linkedin', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] },
  { object: 'Account', type: 'LINKEDIN', id: 'acc_johannes', name: 'Johannes', sources: [{ id: 's2', status: 'OK' }] },
];

async function setup(unipileOptions: FakeUnipileOptions = {}, env: NodeJS.ProcessEnv = {}) {
  const unipile = await startFakeUnipile({ accounts: TWO_ACCOUNTS, ...unipileOptions });
  servers.push(unipile);
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    UNIPILE_DSN: unipile.baseUrl,
    UNIPILE_API_KEY: 'unipile-test-key',
    UNIPILE_ACCOUNT_ID: 'acc_linkedin',
    UNIPILE_ACCOUNT_NICK: 'acc_linkedin',
    UNIPILE_ACCOUNT_JOHANNES: 'acc_johannes',
    UNIPILE_FETCH_COMPANY: 'false',
    DATA_DIR: tempDataDir(),
    ...env,
  });
  const pauses: Array<{ min: number; max: number }> = [];
  const pause: PauseFn = async (range) => {
    pauses.push(range);
  };
  const clock = { now: Date.parse('2026-10-09T08:00:00Z') };
  const adapter = createLiveAdapter(config, { pause, now: () => new Date(clock.now) });
  const app = buildApp({ config, adapter, logger: false, requireSession: false });
  const run = async (maxResults = 5): Promise<RunSnapshot> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/lead-search/runs',
      payload: startBody({ known: [], profile: { ...DEFAULT_SEARCH_PROFILE, maxResults } }),
    });
    assert.equal(response.statusCode, 202, response.body);
    return waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id, 15_000);
  };
  const requestsTo = (path: string, accountId: string) =>
    unipile.requests.filter((r) => r.path === `/api/v1${path}` && r.query.get('account_id') === accountId);
  const lead = (result: RunSnapshot, id: string) => result.leads.find((entry) => entry.id === id);
  return { app, run, unipile, pauses, clock, requestsTo, lead };
}

test('Kontakt nur bei Johannes (anderer Gründer): nicht neu – „Bereits vernetzt mit Johannes“', async () => {
  const { run, unipile, pauses, requestsTo, lead } = await setup();
  // 150 Kontakte → zwei Seiten; ACoTEST1 per Provider-ID, ACoTEST2 nur per öffentlicher Kennung.
  unipile.linkedin.relationsByAccount.acc_johannes = [
    { member_id: 'ACoTEST1', public_identifier: 'someone-else' },
    ...Array.from({ length: 148 }, (_, k) => ({ member_id: `ACoFILL${k}`, public_identifier: `fill-${k}` })),
    { member_id: 'ACoOTHERID', public_identifier: 'Person-2' },
  ];
  unipile.linkedin.invitationsByAccount.acc_johannes = [{ invited_user_id: 'ACoTEST6', invited_user_public_id: 'person-6' }];

  const result = await run();
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  assert.equal(lead(result, 'ACoTEST1')?.status, 'connected');
  assert.equal(lead(result, 'ACoTEST1')?.note, 'Bereits vernetzt mit Johannes');
  assert.equal(lead(result, 'ACoTEST2')?.status, 'connected', 'Abgleich über die öffentliche Kennung, ohne Groß/klein');
  assert.equal(lead(result, 'ACoTEST6')?.status, 'invited');
  assert.equal(lead(result, 'ACoTEST6')?.note, 'Vernetzungsanfrage von Johannes bereits offen');
  // Bisherige Prüfungen des Such-Accounts bleiben.
  assert.equal(lead(result, 'ACoTEST4')?.note, 'Bereits vernetzt');
  // Seit 17.10. werden auch Nicks Anfragen als Gründer-Account geladen (gescraped wird reihum über alle Accounts).
  assert.equal(lead(result, 'ACoTEST5')?.note, 'Vernetzungsanfrage von Nick bereits offen');
  // Diese Personen kosten keinen Profilabruf.
  for (const id of ['ACoTEST1', 'ACoTEST2', 'ACoTEST6']) {
    assert.ok(!unipile.requests.some((r) => r.path === `/api/v1/users/${id}`), `${id} nicht abgerufen`);
  }

  // Kontakte seitenweise mit Cursor; seit 17.10. auch für Nick, obwohl er mitsucht (Suche reihum über alle Accounts).
  const relations = requestsTo('/users/relations', 'acc_johannes');
  assert.equal(relations.length, 2);
  assert.equal(relations[0].query.get('cursor'), null);
  assert.equal(relations[1].query.get('cursor'), '100');
  assert.equal(relations[0].query.get('limit'), '100');
  assert.equal(requestsTo('/users/relations', 'acc_linkedin').length, 1);
  assert.equal(requestsTo('/users/invite/sent', 'acc_johannes').length, 1);
  assert.ok(pauses.some((p) => p.min === 1000 && p.max === 2500), 'Pause zwischen den Seiten');
});

test('Zwischenspeicher: zweiter Lauf innerhalb der Frist lädt Kontakte und Anfragen nicht neu', async () => {
  const { run, unipile, clock, requestsTo, lead } = await setup();
  unipile.linkedin.relationsByAccount.acc_johannes = [{ member_id: 'ACoTEST1', public_identifier: 'person-1' }];
  unipile.linkedin.invitationsByAccount.acc_johannes = [];

  const first = await run();
  assert.equal(lead(first, 'ACoTEST1')?.status, 'connected');
  assert.equal(requestsTo('/users/relations', 'acc_johannes').length, 1);
  assert.equal(requestsTo('/users/invite/sent', 'acc_johannes').length, 1);

  // Der zweite Lauf findet niemanden mehr (Suchgedächtnis: der Fake hat nur 30 Personen, alle schon gesehen) –
  // geprüft wird hier nur, dass die Listen nicht neu geladen werden.
  clock.now += 30 * 60 * 1000;
  await run();
  assert.equal(requestsTo('/users/relations', 'acc_johannes').length, 1, 'keine neue Kontaktliste');
  assert.equal(requestsTo('/users/invite/sent', 'acc_johannes').length, 1, 'keine neue Anfragenliste');

  // Nach 1 h die Anfragen, nach 12 h auch die Kontakte frisch.
  clock.now += SENT_INVITATIONS_TTL_MS;
  await run();
  assert.equal(requestsTo('/users/relations', 'acc_johannes').length, 1);
  assert.equal(requestsTo('/users/invite/sent', 'acc_johannes').length, 2);
  clock.now += RELATIONS_TTL_MS;
  await run();
  assert.equal(requestsTo('/users/relations', 'acc_johannes').length, 2);
});

test('Sales-Navigator-Treffer (andere ID, ohne Kennung): Kontakt von Johannes wird nach dem Profilabruf erkannt', async () => {
  const { run, unipile, lead } = await setup({ salesNavigatorIds: true }, { UNIPILE_SEARCH_API: 'sales_navigator' });
  unipile.linkedin.relationsByAccount.acc_johannes = [{ member_id: 'ACoTEST1', public_identifier: 'person-1' }];
  unipile.linkedin.invitationsByAccount.acc_johannes = [{ invited_user_id: 'ACoNOPE', invited_user_public_id: 'person-2' }];

  const result = await run();
  assert.equal(result.status, 'done', JSON.stringify(result.error));
  const first = lead(result, 'ACwSN1');
  assert.equal(first?.status, 'connected');
  assert.equal(first?.note, 'Bereits vernetzt mit Johannes (im Profil erkannt)');
  assert.equal(lead(result, 'ACwSN2')?.status, 'invited');
  assert.equal(lead(result, 'ACwSN2')?.note, 'Vernetzungsanfrage von Johannes bereits offen (im Profil erkannt)');
  // Offene Anfrage des Such-Accounts (ACoTEST5 laut /users/invite/sent) ebenfalls über die Profil-ID erkannt.
  assert.equal(lead(result, 'ACwSN5')?.status, 'invited');
  assert.ok(unipile.requests.some((r) => r.path === '/api/v1/users/ACwSN1'), 'Profil wurde abgerufen');
});

test('Johannes nicht prüfbar (keine Unipile-Sitzung): neue Leads werden zurückgestellt, nicht als neu gezählt', async () => {
  const { app, run, unipile, requestsTo } = await setup();
  unipile.linkedin.failAccount.acc_johannes = { status: 503, type: 'errors/no_client_session' };

  const result = await run();
  assert.equal(result.status, 'done', 'die Suche selbst läuft durch');
  const deferred = result.leads.filter((entry) => entry.status === 'deferred');
  assert.ok(deferred.length > 0);
  for (const entry of deferred) assert.match(entry.note ?? '', /^Kontakte von Johannes nicht prüfbar \(keine aktive Unipile-Sitzung.*\) – beim nächsten Lauf dran$/);
  assert.equal(result.leads.filter((entry) => entry.status === 'unique' || entry.profile).length, 0, 'kein Profilabruf');
  assert.equal(funnelOf(result.leads).enriched, 0);
  // Bekannte Dubletten des Such-Accounts bleiben, was sie sind.
  assert.equal(result.leads.find((entry) => entry.id === 'ACoTEST4')?.status, 'connected');

  // Die Oberfläche zeigt den Hinweis unter „warnings“.
  const config = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json() as LeadSearchConfig;
  assert.ok(config.warnings.some((warning) => /Kontakte von Johannes konnten beim letzten Lauf nicht geprüft werden/.test(warning)), config.warnings.join(' | '));

  // Fehler werden nicht zwischengespeichert: Ist der Account wieder da, prüft der nächste Lauf neu.
  delete unipile.linkedin.failAccount.acc_johannes;
  unipile.linkedin.relationsByAccount.acc_johannes = [];
  const before = requestsTo('/users/relations', 'acc_johannes').length;
  const second = await run();
  assert.equal(requestsTo('/users/relations', 'acc_johannes').length, before + 1);
  assert.ok(second.leads.some((entry) => entry.status === 'qualified' || entry.status === 'unrated'));
  const after = (await app.inject({ method: 'GET', url: '/api/lead-search/config' })).json() as LeadSearchConfig;
  assert.ok(!after.warnings.some((warning) => /Kontakte von Johannes/.test(warning)));
});

test('Gründer-Account bei Unipile nicht verbunden: keine Anfrage dafür, Suche läuft trotzdem weiter (Entscheidung 17.10.)', async () => {
  const { run, unipile } = await setup({}, { UNIPILE_ACCOUNT_JOHANNES: 'acc_weg' });
  const result = await run();
  assert.equal(result.status, 'done');
  assert.ok(!result.leads.some((entry) => /nicht prüfbar/.test(entry.note ?? '')));
  assert.ok(!unipile.requests.some((r) => r.query.get('account_id') === 'acc_weg'));
});

test('Zwei LinkedIn-Accounts ohne UNIPILE_ACCOUNT_ID: keine Warnung mehr (Suche über alle), Sales Navigator bevorzugt', () => {
  const nav = { id: 'acc_nav', type: 'LINKEDIN', name: 'Nick', sources: [{ status: 'OK' }], connection_params: { im: { premiumFeatures: ['sales_navigator'] } } };
  const plain = { id: 'acc_plain', type: 'LINKEDIN', name: 'Johannes', sources: [{ status: 'OK' }], connection_params: { im: { premiumFeatures: [] } } };
  assert.equal(pickLinkedinAccount([plain, nav], null, 'sales_navigator')?.id, 'acc_nav');
  assert.equal(pickLinkedinAccount([plain, nav], null, 'classic')?.id, 'acc_plain');

  assert.deepEqual(accountWarnings([plain, nav], null, 'sales_navigator'), []);
  assert.deepEqual(accountWarnings([plain, nav], null, 'classic'), []);
  assert.deepEqual(accountWarnings([plain, nav], 'acc_nav', 'sales_navigator'), []);
  assert.deepEqual(accountWarnings([plain], null, 'classic'), []);
  const noNavigator = accountWarnings([plain, nav], 'acc_plain', 'sales_navigator');
  assert.equal(noNavigator.length, 1);
  assert.match(noNavigator[0], /„Johannes“ hat laut Unipile aber kein Sales Navigator/);
  // Ohne Angaben zu Premium-Funktionen keine Vermutung.
  assert.deepEqual(accountWarnings([{ id: 'x', type: 'LINKEDIN', sources: [] }], 'x', 'sales_navigator'), []);

  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', UNIPILE_SEARCH_API: 'sales_navigator', DATA_DIR: tempDataDir() });
  assert.match(liveWarnings(config).join(' '), /Sales Navigator, aber UNIPILE_ACCOUNT_ID ist leer/);
});

test('Abgleich: Provider-ID oder öffentliche Kennung, ohne Groß/klein; vernetzt vor Anfrage, Fehler zuletzt', () => {
  const name = (id: string) => (id === 'nick' ? 'Nick' : 'Johannes');
  const networks = [
    { founder: 'nick' as const, connected: new Set(['acoaa1']), invited: new Set(['jana-x']), error: null },
    { founder: 'johannes' as const, connected: new Set<string>(), invited: new Set(['acoaa1']), error: null },
  ];
  assert.deepEqual(networkVerdict(networks, ['ACoAA1', null], name), { status: 'connected', note: 'Bereits vernetzt mit Nick' });
  assert.deepEqual(networkVerdict(networks, ['ACoAA9', 'Jana-X'], name), { status: 'invited', note: 'Vernetzungsanfrage von Nick bereits offen' });
  assert.equal(networkVerdict(networks, ['ACoAA9', undefined], name), null);
  const failing = [...networks, { founder: 'johannes' as const, connected: new Set<string>(), invited: new Set<string>(), error: 'Testfehler' }];
  assert.equal(networkVerdict(failing, ['ACoAA1'], name)?.status, 'connected', 'ein sicherer Treffer geht vor');
  assert.equal(networkVerdict(failing, ['ACoAA9'], name)?.status, 'deferred');
});

test('Simulation: Standard lässt den Trichter unverändert (40 → 33 → 15 → 7 → 5)', async () => {
  const app = mockApp();
  const response = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  const run = await waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id);
  assert.deepEqual(funnelOf(run.leads), { found: 40, unique: 33, screened: 31, enriched: 15, fit: 7, qualified: 5 });
});

test('Simulation mit eigenem Gründer-Netz: vernetzt, Anfrage offen, nicht prüfbar', async () => {
  const known = new Set<string>(DEMO_KNOWN.map((entry) => entry.providerId));
  const fresh = MOCK_LEADS.filter((entry) => !entry.openInvitation && !known.has(entry.hit.providerId));
  const [a, b] = fresh;
  const app = mockApp(
    new MockAdapter(0, {
      founderNetworks: [{ founder: 'nick', connected: [a.hit.providerId], invited: [b.hit.publicIdentifier!.toUpperCase()] }],
    }),
  );
  const response = await app.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  const run = await waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id);
  const byId = (id: string) => run.leads.find((entry) => entry.id === id);
  assert.equal(byId(a.hit.providerId)?.status, 'connected');
  assert.equal(byId(a.hit.providerId)?.note, 'Bereits vernetzt mit Nick');
  assert.equal(byId(b.hit.providerId)?.status, 'invited');
  assert.equal(byId(b.hit.providerId)?.note, 'Vernetzungsanfrage von Nick bereits offen');
  assert.equal(funnelOf(run.leads).unique, 31);

  const failingApp = mockApp(new MockAdapter(0, { founderNetworks: [{ founder: 'johannes', error: 'Account getrennt' }] }));
  const failing = await failingApp.inject({ method: 'POST', url: '/api/lead-search/runs', payload: startBody() });
  const failed = await waitForEnd(failingApp, (failing.json() as { run: RunSnapshot }).run.id);
  assert.equal(failed.status, 'done');
  assert.equal(failed.leads.filter((entry) => entry.status === 'deferred').length, 33);
  assert.ok(failed.leads.filter((entry) => entry.status === 'deferred').every((entry) => entry.note === 'Kontakte von Johannes nicht prüfbar (Account getrennt) – beim nächsten Lauf dran'));
  assert.equal(failed.leads.filter((entry) => entry.profile).length, 0);
});

test('Verbindungstest nennt den Such-Account mit ID und Sales Navigator, nicht einfach den ersten Account', () => {
  const items = [
    { id: 'nick-id', type: 'LINKEDIN', name: 'Nick Ehrlich', connection_params: { im: { premiumFeatures: ['sales_navigator'] } }, sources: [{ status: 'OK' }] },
    { id: 'jo-id', type: 'LINKEDIN', name: 'Johannes Stahr', connection_params: { im: { premiumFeatures: [] } }, sources: [{ status: 'OK' }] },
  ];
  const result = unipileTestResult(items, 'jo-id', 'sales_navigator');
  assert.equal(result.ok, false, 'Sales Navigator eingestellt, Such-Account ohne → Warnung');
  assert.match(result.message, /Gesucht wird über Johannes Stahr \(ID jo-id, ohne Sales Navigator/);
  assert.match(result.message, /Weitere LinkedIn-Accounts: Nick Ehrlich \(ID nick-id, mit Sales Navigator\)/);

  const good = unipileTestResult(items, 'nick-id', 'sales_navigator');
  assert.equal(good.ok, true);
  assert.match(good.message, /Gesucht wird über Nick Ehrlich \(ID nick-id, mit Sales Navigator, Suche: Sales Navigator\)/);

  const missing = unipileTestResult(items, 'gibt-es-nicht', 'classic');
  assert.equal(missing.ok, false);
  assert.match(missing.message, /nicht verbunden\. Verbunden sind: Nick Ehrlich \(ID nick-id\), Johannes Stahr \(ID jo-id\)/);
});
