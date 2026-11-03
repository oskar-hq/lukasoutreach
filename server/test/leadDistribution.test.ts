import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthFounderId } from '../../shared/auth.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { ConversationListResponse, CreateLeadsResponse, LeadDetailResponse, LeadListResponse } from '../../shared/leads.js';
import type { SettingsResponse } from '../../shared/settings.js';
import type { TasksResponse } from '../../shared/tasks.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { leadDistributionPool, loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { LeadStore } from '../src/leads/leadStore.js';
import { tempDataDir } from './helpers.js';

/** Neue Leads auf beide Gründer verteilen (`LEAD_DISTRIBUTION`, Vertrag shared/leads.ts → `LeadDistribution`). */

const NOW = Date.UTC(2026, 9, 5, 8, 0);
const BOTH = ['nick', 'johannes'] as const;

const card = (i: number): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'mock',
  providerId: `ACoSPLIT${i}`,
  publicIdentifier: `verteilt-${i}`,
  profileUrl: `https://www.linkedin.com/in/verteilt-${i}`,
  firstName: `Vorname${i}`,
  lastName: `Nachname${i}`,
  headline: 'Geschäftsführer',
  position: 'Geschäftsführer',
  company: `Firma ${i} GmbH`,
  location: 'Hamburg',
  website: null,
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.9,
  reason: 'Test',
  summary: 'Test',
  metaAds: null,
});
const cards = (from: number, count: number) => Array.from({ length: count }, (_, i) => card(from + i));

function store(pool: readonly AuthFounderId[] = BOTH) {
  return new LeadStore(openDatabase(tempDataDir()), { ownerPool: () => pool });
}

// ── Regel im Store ──────────────────────────────────────────────────────────

test('balanced: leerer Stapel → abwechselnd, der Suchende zuerst; searchedBy und Verlauf beim anderen', () => {
  const leads = store();
  const { created } = leads.createFromCards(cards(1, 5), 'johannes', NOW, null);
  assert.deepEqual(created.map((lead) => lead.owner), ['johannes', 'nick', 'johannes', 'nick', 'johannes']);
  for (const lead of created) {
    const origin = leads.get(lead.id)!.origin;
    assert.equal(origin.kind, 'search');
    if (origin.kind !== 'search') continue;
    assert.equal(origin.searchedBy, lead.owner === 'johannes' ? undefined : 'johannes');
    const event = leads.events(lead.id).find((entry) => entry.kind === 'created')!;
    assert.equal(event.by, 'johannes', 'gefunden hat der Suchende');
    assert.equal(event.title, lead.owner === 'nick' ? 'Über die Lead-Suche gefunden · verteilt an Nick' : 'Über die Lead-Suche gefunden');
  }
});

test('balanced: offener Rückstand (Stufe new) wird zuerst ausgeglichen, andere Stufen zählen nicht', () => {
  const db = openDatabase(tempDataDir());
  const leads = new LeadStore(db, { ownerPool: () => BOTH });
  // Nick hat 4 Leads, einer davon schon angefragt → Rückstand 3, Johannes 0.
  const own = new LeadStore(db);
  const old = own.createFromCards(cards(100, 4), 'nick', NOW - 1000, null).created;
  assert.ok(old.every((lead) => lead.owner === 'nick'));
  leads.applyAction(old[0].id, { action: 'invite_sent' }, 'nick', NOW - 500);

  const { created } = leads.createFromCards(cards(1, 5), 'nick', NOW, null);
  // 3 an Johannes (bis 3:3), dann Gleichstand → zuerst der Suchende, dann wieder Johannes.
  assert.deepEqual(created.map((lead) => lead.owner), ['johannes', 'johannes', 'johannes', 'nick', 'johannes']);
  const backlog = (owner: AuthFounderId) => leads.list({ owner, stages: ['new'], limit: 1000 }).total;
  assert.deepEqual([backlog('nick'), backlog('johannes')], [4, 4]);
});

test('balanced: Dubletten behalten ihren Besitzer und zählen nicht für die Verteilung', () => {
  const leads = store();
  const [first] = leads.createFromCards([card(1)], 'johannes', NOW, null).created;
  assert.equal(first.owner, 'johannes');
  const result = leads.createFromCards([card(1), card(2), card(2), card(3)], 'johannes', NOW, null);
  // Rückstand 0:1 → Nick zuerst, dann Gleichstand → Johannes; die doppelte Karte ist danach eine Dublette.
  assert.deepEqual(result.created.map((lead) => lead.owner), ['nick', 'johannes']);
  assert.deepEqual(
    result.skipped.map((entry) => [entry.providerId, entry.owner]),
    [[card(1).providerId, 'johannes'], [card(2).providerId, 'nick']],
  );
});

test('owner bzw. nur ein Account: alle Leads beim Suchenden, ohne searchedBy', () => {
  for (const pool of [[], ['nick']] as AuthFounderId[][]) {
    const leads = store(pool);
    const { created } = leads.createFromCards(cards(1, 4), 'johannes', NOW, null);
    assert.ok(created.every((lead) => lead.owner === 'johannes'), `Pool ${pool.join(',')}`);
    assert.ok(created.every((lead) => lead.origin.kind === 'search' && lead.origin.searchedBy === undefined));
  }
  // Ohne Optionen (ältere Aufrufer, Server-Befehle) wie bisher.
  const plain = new LeadStore(openDatabase(tempDataDir()));
  assert.ok(plain.createFromCards(cards(1, 3), 'nick', NOW, null).created.every((lead) => lead.owner === 'nick'));
});

// ── Konfiguration ───────────────────────────────────────────────────────────

test('leadDistributionPool: nur balanced mit zwei verschiedenen Accounts; ungültiger Wert verhindert den Start', () => {
  // Echter Betrieb: es zählen die eingetragenen Accounts.
  const pool = (env: NodeJS.ProcessEnv) => leadDistributionPool(loadConfig({ LEAD_SEARCH_MODE: 'live', DATA_DIR: tempDataDir(), ...env }));
  const accounts = { UNIPILE_ACCOUNT_NICK: 'accNick', UNIPILE_ACCOUNT_JOHANNES: 'accJohannes' };
  assert.equal(loadConfig({ LEAD_SEARCH_MODE: 'mock' }).leadDistribution, 'owner', 'Standard');
  assert.deepEqual(pool(accounts), []);
  assert.deepEqual(pool({ ...accounts, LEAD_DISTRIBUTION: 'balanced' }), ['nick', 'johannes']);
  assert.deepEqual(pool({ LEAD_DISTRIBUTION: 'balanced', UNIPILE_ACCOUNT_JOHANNES: 'accJohannes' }), [], 'nur ein Account');
  assert.deepEqual(pool({ LEAD_DISTRIBUTION: 'balanced', UNIPILE_ACCOUNT_NICK: 'same', UNIPILE_ACCOUNT_JOHANNES: 'same' }), [], 'derselbe Account');
  // Simulation ohne Zuordnung: beide wie beim Senden (`mock-<gründer>`, 25.10.).
  assert.deepEqual(leadDistributionPool(loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), LEAD_DISTRIBUTION: 'balanced' })), ['nick', 'johannes']);
  assert.throws(() => loadConfig({ LEAD_SEARCH_MODE: 'mock', LEAD_DISTRIBUTION: 'zufall' }), /LEAD_DISTRIBUTION muss "owner" oder "balanced" sein/);
});

// ── Über die HTTP-API ───────────────────────────────────────────────────────

function sessionApp(extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    LEAD_SEARCH_MODE: 'mock',
    DATA_DIR: tempDataDir(),
    AUTH_DEMO_ACCOUNTS: 'true',
    AUTH_COOKIE_SECURE: 'false',
    MOCK_SPEED: '0',
    UNIPILE_ACCOUNT_NICK: 'accNick',
    UNIPILE_ACCOUNT_JOHANNES: 'accJohannes',
    ...extra,
  };
  // `env` auch an buildApp: Einstellungen aus der Software legen sich über diese Umgebung.
  return buildApp({ config: loadConfig(env), env, adapter: new MockAdapter(0), logger: false, requireSession: true });
}
type App = ReturnType<typeof sessionApp>;

async function login(app: App, username: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'demo' } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
}
const req = (app: App, cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function backlog(app: App, cookie: string): Promise<Record<AuthFounderId, number>> {
  const count = async (owner: AuthFounderId) => ((await req(app, cookie, 'GET', `/api/leads?owner=${owner}&stage=new&limit=1`)).json() as LeadListResponse).total;
  return { nick: await count('nick'), johannes: await count('johannes') };
}

/** Erwartete Besitzer nach der Regel (wenigster Rückstand, Gleichstand → Suchender). */
function expectedOwners(start: Record<AuthFounderId, number>, searcher: AuthFounderId, count: number): AuthFounderId[] {
  const counts = { ...start };
  const other: AuthFounderId = searcher === 'nick' ? 'johannes' : 'nick';
  return Array.from({ length: count }, () => {
    const pick = counts[other] < counts[searcher] ? other : searcher;
    counts[pick]++;
    return pick;
  });
}

test('Einstellung: Standard owner (Simulation unverändert), in der Software auf balanced → Übergabe verteilt sofort', async () => {
  const app = sessionApp();
  const johannes = await login(app, 'johannes');
  const settings = (await req(app, johannes, 'GET', '/api/settings')).json() as SettingsResponse;
  const state = settings.settings.find((entry) => entry.key === 'LEAD_DISTRIBUTION');
  assert.deepEqual([state?.value, state?.source], ['owner', 'default']);

  const before = (await req(app, johannes, 'POST', '/api/leads', { cards: cards(1, 4) })).json() as CreateLeadsResponse;
  assert.ok(before.created.every((lead) => lead.owner === 'johannes'), 'owner: wie bisher');

  const bad = await req(app, johannes, 'PUT', '/api/settings', { changes: { LEAD_DISTRIBUTION: 'zufall' } });
  assert.equal(bad.statusCode, 400, bad.body);
  const saved = await req(app, johannes, 'PUT', '/api/settings', { changes: { LEAD_DISTRIBUTION: 'balanced' } });
  assert.equal(saved.statusCode, 200, saved.body);

  const start = await backlog(app, johannes);
  const { created } = (await req(app, johannes, 'POST', '/api/leads', { cards: cards(10, 6) })).json() as CreateLeadsResponse;
  assert.deepEqual(created.map((lead) => lead.owner), expectedOwners(start, 'johannes', 6));
  assert.ok(created.some((lead) => lead.owner === 'nick'), 'Nick bekommt seinen Anteil');

  // Jeder Gründer sieht seinen Anteil im eigenen Tagesstapel (von Hand übergeben = immer dabei).
  for (const founder of BOTH) {
    const tasks = (await req(app, johannes, 'GET', `/api/tasks?owner=${founder}`)).json() as TasksResponse;
    const mine = created.filter((lead) => lead.owner === founder).map((lead) => lead.id);
    const inStack = tasks.tasks.filter((task) => task.type === 'lead').map((task) => task.lead.id);
    assert.ok(mine.every((id) => inStack.includes(id)), `Stapel von ${founder}`);
  }
  const moved = created.find((lead) => lead.owner === 'nick')!;
  const detail = (await req(app, johannes, 'GET', `/api/leads/${moved.id}`)).json() as LeadDetailResponse;
  assert.deepEqual(detail.lead.origin, { kind: 'search', runId: card(1).runId, mode: 'mock', searchedBy: 'johannes' });
  await app.close();
});

test('Chats: ohne owner alle Gründer – auch für Mitarbeiter, mit lead.owner je Chat', async () => {
  const app = sessionApp();
  const anna = await login(app, 'mitarbeiter');
  const response = await req(app, anna, 'GET', '/api/conversations');
  assert.equal(response.statusCode, 200, response.body);
  const owners = new Set((response.json() as ConversationListResponse).conversations.map((item) => item.lead.owner));
  assert.deepEqual([...owners].sort(), ['johannes', 'nick']);
  await app.close();
});
