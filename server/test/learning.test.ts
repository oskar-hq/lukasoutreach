import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE, type NewLeadCard, type RunSnapshot } from '../../shared/leadSearch.js';
import type { CreateLeadsResponse, LeadDetailResponse } from '../../shared/leads.js';
import type { LearningSummary } from '../../shared/learning.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { createLiveAdapter } from '../src/adapters/live/liveAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { LearningStore } from '../src/learning/learningStore.js';
import { queryPriority } from '../src/pipeline/searchMemory.js';
import { startFakeAnthropic, startFakeMeta, startFakeUnipile, systemText } from './fakeServers.js';
import { startBody, tempDataDir, waitForEnd } from './helpers.js';

/**
 * Lernen aus Lead-Qualität (Wunsch des Nutzers 13.10., `shared/learning.ts`): 👍/👎 am Lead, Ergebnisse automatisch,
 * Beispiele im Prompt der KI, Ertrag je Suchanfrage, Löschen mit dem Lead.
 */

const servers: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

function mockServer(dataDir = tempDataDir()) {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', DATA_DIR: dataDir });
  return buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false });
}
type App = ReturnType<typeof mockServer>;

/** Server und ein zweiter Blick auf dieselbe Datenbank (Beispiele für die KI). */
function setup() {
  const dataDir = tempDataDir();
  const server = mockServer(dataDir);
  return { server, learn: new LearningStore(openDatabase(dataDir)) };
}

function card(overrides: Partial<NewLeadCard> = {}): NewLeadCard {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    mode: 'live',
    providerId: 'ACoLEARN001',
    publicIdentifier: 'erika-muster',
    profileUrl: 'https://www.linkedin.com/in/erika-muster',
    firstName: 'Erika',
    lastName: 'Muster',
    headline: 'Geschäftsführerin · Muster Finanzplanung GmbH',
    position: 'Geschäftsführerin',
    company: 'Muster Finanzplanung GmbH',
    location: 'Köln',
    website: null,
    networkDistance: 2,
    category: 'kapitalanlage_vertrieb',
    confidence: 0.8,
    reason: '„Kapitalanlage“ in der Headline und Rolle „Geschäftsführerin“ – ohne KI eingestuft.',
    summary: 'Finanzplanung mit Kapitalanlagen.',
    metaAds: null,
    ...overrides,
  };
}

async function create(server: App, cards: NewLeadCard[]) {
  const response = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards, owner: 'nick' } });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as CreateLeadsResponse).created;
}

async function feedback(server: App, id: string, body: object | null, status = 200) {
  const response = await server.inject({ method: 'PATCH', url: `/api/leads/${id}`, payload: { feedback: body } });
  assert.equal(response.statusCode, status, response.body);
  return response.json() as LeadDetailResponse;
}

async function learning(server: App): Promise<LearningSummary> {
  const response = await server.inject({ method: 'GET', url: '/api/learning' });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LearningSummary;
}

test('👍/👎 am Lead: gespeichert, im Verlauf, als Beispiel für die KI – zurücknehmen löscht es', async () => {
  const { server, learn } = setup();
  const [lead] = await create(server, [card()]);
  assert.equal(lead.feedback ?? null, null);

  const bad = await feedback(server, lead.id, { verdict: 'bad', reason: 'finanzberater', note: 'Nur Versicherungen' });
  assert.deepEqual({ ...bad.lead.feedback, at: 0 }, { verdict: 'bad', source: 'manual', reason: 'finanzberater', note: 'Nur Versicherungen', outcome: null, at: 0 });
  assert.equal(bad.events.at(-1)?.title, 'Lead-Qualität: passt nicht · Finanz-/Versicherungsberater');

  const examples = learn.examplesText() ?? '';
  assert.match(examples, /passt nicht \(Finanz-\/Versicherungsberater\): Headline „Geschäftsführerin · Muster Finanzplanung GmbH“/);
  assert.match(examples, /Notiz: „Nur Versicherungen“/);
  assert.ok(!examples.includes('Erika'), 'ohne Namen');

  const summary = await learning(server);
  assert.deepEqual(summary.feedback, { good: 0, bad: 1, manual: 1, outcome: 0 });
  assert.equal(summary.examplesInUse, 1);
  assert.deepEqual(summary.badReasons, [{ reason: 'finanzberater', count: 1 }]);

  // Ungültig: Grund unbekannt, Notiz zu lang.
  await feedback(server, lead.id, { verdict: 'bad', reason: 'egal' }, 400);
  await feedback(server, lead.id, { verdict: 'bad', note: 'x'.repeat(201) }, 400);

  const cleared = await feedback(server, lead.id, null);
  assert.equal(cleared.lead.feedback, null);
  assert.equal(learn.examplesText(), null);
  assert.equal((await learning(server)).feedback.bad, 0);
  await server.close();
});

test('Ergebnisse zählen automatisch als „passt“ – von Hand geht vor', async () => {
  const { server, learn } = setup();
  const [meeting, manual] = await create(server, [card(), card({ providerId: 'ACoLEARN002', publicIdentifier: 'max-muster' })]);
  const act = (id: string, action: string) => server.inject({ method: 'POST', url: `/api/leads/${id}/events`, payload: { action } });
  // Termin vereinbart → „passt (Termin vereinbart)“ ohne Klick.
  await feedback(server, manual.id, { verdict: 'bad', reason: 'makler' });
  for (const id of [meeting.id, manual.id]) {
    for (const action of ['invite_sent', 'invite_accepted', 'message_sent', 'message_received', 'meeting_booked']) {
      assert.equal((await act(id, action)).statusCode, 200, action);
    }
  }
  const detail = (id: string) => server.inject({ method: 'GET', url: `/api/leads/${id}` }).then((r) => r.json() as LeadDetailResponse);
  const won = (await detail(meeting.id)).lead.feedback;
  assert.equal(won?.verdict, 'good');
  assert.equal(won?.source, 'outcome');
  assert.equal(won?.outcome, 'Termin vereinbart');
  // 👎 von Hand bleibt, auch mit Termin.
  assert.equal((await detail(manual.id)).lead.feedback?.verdict, 'bad');
  assert.match(learn.examplesText() ?? '', /passt \(Termin vereinbart\)/);

  // Zurücknehmen von Hand → jetzt gilt das Ergebnis.
  const back = await feedback(server, manual.id, null);
  assert.equal(back.lead.feedback?.source, 'outcome');
  assert.deepEqual((await learning(server)).feedback, { good: 2, bad: 0, manual: 0, outcome: 2 });
  await server.close();
});

test('Hinweis: Stichwort „ohne KI qualifizieren“ bringt mehrfach 👎 – die Software ändert nichts selbst', async () => {
  const server = mockServer();
  const leads = await create(server, [1, 2, 3].map((n) => card({ providerId: `ACoQUICK${n}`, publicIdentifier: `quick-${n}` })));
  await feedback(server, leads[0].id, { verdict: 'bad', reason: 'finanzberater' });
  assert.deepEqual((await learning(server)).hints, [], 'ein 👎 reicht nicht');
  await feedback(server, leads[1].id, { verdict: 'bad', reason: 'finanzberater' });
  const { hints } = await learning(server);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /^„Kapitalanlage“: 2 × passt nicht .*Ohne KI qualifizieren bei/);
  await server.close();
});

test('Datenschutz: Löschen des Leads löscht auch seine Rückmeldung', async () => {
  const { server, learn } = setup();
  const [lead] = await create(server, [card()]);
  await feedback(server, lead.id, { verdict: 'bad', reason: 'makler' });
  assert.equal((await server.inject({ method: 'DELETE', url: `/api/leads/${lead.id}` })).statusCode, 200);
  assert.equal(learn.feedbackFor('ACoLEARN001'), null);
  assert.equal((await learning(server)).feedback.bad, 0);
  await server.close();
});

test('Suchanfrage: „passt“ hebt sie, 👎 drückt sie', () => {
  const base = { hits: 30, fresh: 20, likely: 3, qualified: 1 };
  const plain = queryPriority(base);
  assert.ok(queryPriority({ ...base, good: 1 }) > plain);
  assert.ok(queryPriority({ ...base, bad: 2 }) < plain);
  assert.ok(queryPriority({ ...base, good: 1, bad: 1 }) > queryPriority({ ...base, bad: 1 }));
});

test('Live: Rückmeldung fließt in den nächsten Lauf – Beispiele im Prompt (mit Cache-Punkt) und Ertrag der Anfrage', async () => {
  const unipile = await startFakeUnipile({ people: 60 });
  const anthropic = await startFakeAnthropic();
  const meta = await startFakeMeta();
  servers.push(unipile, anthropic, meta);
  const dataDir = tempDataDir();
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    UNIPILE_DSN: unipile.baseUrl,
    UNIPILE_API_KEY: 'unipile-test-key',
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    META_ACCESS_TOKEN: 'meta-test-key',
    DATA_DIR: dataDir,
  });
  const adapter = createLiveAdapter(config, { pause: async () => {}, anthropicBaseURL: anthropic.baseUrl, metaBaseURL: meta.baseUrl });
  const app = buildApp({ config, adapter, logger: false, requireSession: false });
  const run = async (): Promise<RunSnapshot> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/lead-search/runs',
      payload: startBody({ known: [], checked: [], profile: { ...DEFAULT_SEARCH_PROFILE, maxResults: 4 } }),
    });
    assert.equal(response.statusCode, 202, response.body);
    return waitForEnd(app, (response.json() as { run: RunSnapshot }).run.id, 15_000);
  };
  const qualifyRequests = () => anthropic.requests.filter((request) => !systemText(request.body).includes('[cockpit:vorpruefung]'));

  // Erster Lauf: noch keine Rückmeldungen → nur die Regeln, ein Block mit Cache-Punkt.
  const first = await run();
  assert.equal(first.status, 'done');
  const firstSystem = (qualifyRequests()[0].body as { system: Array<{ text: string; cache_control?: unknown }> }).system;
  assert.equal(firstSystem.length, 1);
  assert.deepEqual(firstSystem[0].cache_control, { type: 'ephemeral' });

  // „Qualifizieren“ in der Ergebnisliste = 👍 (die KI lag daneben), auch ohne Profil.
  const waiting = first.leads.find((lead) => lead.status === 'deferred')!;
  assert.ok(waiting, 'zurückgestellter Treffer');
  const manual = await app.inject({ method: 'POST', url: `/api/lead-search/runs/${first.id}/leads/${encodeURIComponent(waiting.id)}/qualify` });
  assert.equal(manual.statusCode, 200, manual.body);
  const learn = new LearningStore(openDatabase(dataDir));
  assert.equal(learn.feedbackFor(waiting.id)?.verdict, 'good');

  // Übergeben, ein Lead 👎, einer 👍.
  const handoff = (await app.inject({ method: 'POST', url: `/api/lead-search/runs/${first.id}/handoff` })).json() as { leads: NewLeadCard[] };
  assert.ok(handoff.leads.length >= 2, String(handoff.leads.length));
  const created = (await app.inject({ method: 'POST', url: '/api/leads', payload: { cards: handoff.leads.slice(0, 2), owner: 'nick' } })).json() as CreateLeadsResponse;
  const [bad, good] = created.created;
  await app.inject({ method: 'PATCH', url: `/api/leads/${bad.id}`, payload: { feedback: { verdict: 'bad', reason: 'makler' } } });
  await app.inject({ method: 'PATCH', url: `/api/leads/${good.id}`, payload: { feedback: { verdict: 'good' } } });

  // Ertrag der Suchanfrage, die die beiden fand.
  const db = openDatabase(dataDir);
  const credited = db.prepare('SELECT SUM(good) AS good, SUM(bad) AS bad FROM search_queries').get() as { good: number; bad: number };
  assert.deepEqual({ ...credited }, { good: 2, bad: 1 }, 'zwei 👍 (Ergebnisliste + Lead), ein 👎');
  const summary = (await app.inject({ method: 'GET', url: '/api/learning' })).json() as LearningSummary;
  assert.ok(summary.topQueries[0].good >= 1);

  // Zweiter Lauf: Regeln + Beispiele, Cache-Punkt am Ende; Vorprüfung bekommt sie auch.
  const before = anthropic.requests.length;
  await run();
  const later = anthropic.requests.slice(before);
  const qualify = later.find((request) => !systemText(request.body).includes('[cockpit:vorpruefung]'));
  assert.ok(qualify, 'KI-Bewertung im zweiten Lauf');
  const system = (qualify.body as { system: Array<{ text: string; cache_control?: unknown }> }).system;
  assert.equal(system.length, 2);
  assert.equal(system[0].cache_control, undefined);
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral' });
  assert.match(system[1].text, /<beispiele>/);
  assert.match(system[1].text, /passt nicht \(Makler\)/);
  assert.match(system[1].text, new RegExp(`Headline „${bad.person.headline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}“`));
  assert.ok(!system[1].text.includes(bad.person.lastName), 'ohne Namen');
  const prescreen = later.find((request) => systemText(request.body).includes('[cockpit:vorpruefung]'));
  if (prescreen) assert.match(systemText(prescreen.body), /<beispiele>/);
  await app.close();
});
