import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse, LeadDetailResponse } from '../../shared/leads.js';
import { ACCOUNT_PAUSED_MESSAGE, type TasksResponse } from '../../shared/tasks.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

/**
 * Nicks LinkedIn-Account nicht verbunden (17.10., Wunsch des Nutzers): Nick hat keine Aufgaben, seine neuen Leads
 * übernimmt Johannes im Rahmen seines Tageslimits; Erstnachrichten warten auf Nick.
 */

const servers: Array<{ close: () => Promise<void> }> = [];
after(() => Promise.all(servers.map((server) => server.close())));

/** Bei Unipile ist nur Johannes verbunden – Nicks Account fehlt (gesperrt, getrennt). */
async function setup(env: NodeJS.ProcessEnv = {}) {
  const unipile = await startFakeUnipile({
    accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_johannes', name: 'Johannes', sources: [{ id: 's1', status: 'OK' }] }],
  });
  servers.push(unipile);
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    DATA_DIR: tempDataDir(),
    UNIPILE_DSN: unipile.baseUrl,
    UNIPILE_API_KEY: 'unipile-test-key',
    UNIPILE_ACCOUNT_NICK: 'acc_nick',
    UNIPILE_ACCOUNT_JOHANNES: 'acc_johannes',
    NEW_LEADS_PER_DAY: '3',
    ...env,
  });
  const app = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false });
  after(() => app.close());
  return app;
}

type App = Awaited<ReturnType<typeof setup>>;

const card = (i: number): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: `ACoPAUSE${i}`,
  publicIdentifier: `pause-${i}`,
  profileUrl: `https://www.linkedin.com/in/pause-${i}`,
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

async function createLeads(app: App, cards: NewLeadCard[], owner: 'nick' | 'johannes'): Promise<CockpitLead[]> {
  const response = await app.inject({ method: 'POST', url: '/api/leads', payload: { cards, owner } });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as CreateLeadsResponse).created;
}

const tasks = async (app: App, owner: string) => {
  const response = await app.inject({ method: 'GET', url: `/api/tasks?owner=${owner}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as TasksResponse;
};

test('Nicks Account nicht verbunden: Nick hat keine Aufgaben, seine neuen Leads stehen unter „Alle“ bei Johannes (im Rahmen des Limits)', async () => {
  const app = await setup();
  const nickLeads = await createLeads(app, [1, 2, 3, 4, 5].map(card), 'nick');
  const [own] = await createLeads(app, [card(9)], 'johannes');

  const nick = await tasks(app, 'nick');
  assert.deepEqual(nick.tasks, []);
  assert.deepEqual(nick.counts, { reply: 0, followup: 0, first: 0, lead: 0 });
  assert.deepEqual(nick.accountPaused, ['nick']);
  assert.match(ACCOUNT_PAUSED_MESSAGE, /nicht verbunden/);

  const johannes = await tasks(app, 'johannes');
  assert.deepEqual(johannes.accountPaused, ['nick']);
  // „Meine“ (24.10.): nur Johannes' eigene Aufgaben – Nicks Leads übernimmt er nur unter „Alle“.
  assert.equal(johannes.counts.lead, 1);
  assert.ok(johannes.tasks.every((task) => !task.adoptedFrom));
  assert.equal(johannes.rules.inviteAccounts, 1);
  assert.equal(johannes.inviteVia, 'johannes');

  // „Alle“: Limit 3 – zuerst Johannes' eigener Lead, dann zwei von Nick; kein Ausweichen auf Nicks Account.
  const all = await tasks(app, 'all');
  assert.deepEqual(all.accountPaused, ['nick']);
  assert.equal(all.counts.lead, 3);
  assert.equal(all.tasks.filter((task) => task.lead.id === own.id && !task.adoptedFrom).length, 1);
  const adopted = all.tasks.filter((task) => task.adoptedFrom === 'nick');
  assert.equal(adopted.length, 2);
  assert.ok(adopted.every((task) => nickLeads.some((lead) => lead.id === task.lead.id)));
  assert.match(adopted[0].reason, /übernommen von Nick/);
  assert.ok(adopted.every((task) => task.lead.owner === 'johannes'), "im Stapel schon Johannes' Lead");

  // Anfrage für einen übernommenen Lead: geht über Johannes, Johannes wird Besitzer.
  const response = await app.inject({ method: 'POST', url: `/api/leads/${adopted[0].lead.id}/events`, payload: { action: 'invite_sent' } });
  assert.equal(response.statusCode, 200, response.body);
  const detail = response.json() as LeadDetailResponse;
  assert.equal(detail.lead.owner, 'johannes');
  assert.equal(detail.lead.stage, 'invited');
  assert.ok(detail.events.some((event) => event.kind === 'owner_changed'));
  // Die Anfrage zählt auf Johannes' Limit: ein Platz weniger frei.
  const after = await tasks(app, 'all');
  assert.equal(after.counts.lead, 2);
  assert.equal((await tasks(app, 'johannes')).invitesByAccount?.johannes, 1);
});

test('Johannes am Tageslimit: Nicks neue Leads warten, Anfrage wird abgelehnt', async () => {
  const app = await setup({ NEW_LEADS_PER_DAY: '20', LINKEDIN_INVITES_PER_DAY: '1' });
  const [mine] = await createLeads(app, [card(9)], 'johannes');
  const [waiting] = await createLeads(app, [card(1)], 'nick');
  const first = await app.inject({ method: 'POST', url: `/api/leads/${mine.id}/events`, payload: { action: 'invite_sent' } });
  assert.equal(first.statusCode, 200, first.body);
  const blocked = await app.inject({ method: 'POST', url: `/api/leads/${waiting.id}/events`, payload: { action: 'invite_sent' } });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'invite_limit');
  const lead = (await app.inject({ method: 'GET', url: `/api/leads/${waiting.id}` })).json() as LeadDetailResponse;
  assert.equal(lead.lead.owner, 'nick', 'bleibt bei Nick, bis ein Account frei ist');
  assert.equal(lead.lead.stage, 'new');
});

test('Erstnachrichten von Nick warten – weder bei Nick noch bei Johannes', async () => {
  // Vor der Sperre (noch kein Account zugeordnet): Nick hat angefragt, die Person hat angenommen.
  const dataDir = tempDataDir();
  const before = await setup({ DATA_DIR: dataDir, UNIPILE_ACCOUNT_NICK: '', UNIPILE_ACCOUNT_JOHANNES: '' });
  const [lead] = await createLeads(before, [card(1)], 'nick');
  for (const action of ['invite_sent', 'invite_accepted']) {
    const response = await before.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action } });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal((await tasks(before, 'nick')).counts.first, 1);
  await before.close();

  // Jetzt: Nicks Account getrennt.
  const app = await setup({ DATA_DIR: dataDir });
  assert.deepEqual((await tasks(app, 'nick')).tasks, []);
  assert.ok(!(await tasks(app, 'johannes')).tasks.some((task) => task.lead.id === lead.id));
  assert.ok(!(await tasks(app, 'all')).tasks.some((task) => task.lead.id === lead.id));
});

test('Kein Account zugeordnet oder Unipile nicht erreichbar: nichts pausiert; nur Nick leer: Nick pausiert', async () => {
  // Niemand zugeordnet (Senden von Hand ohne Unipile, wie bisher).
  const none = await setup({ UNIPILE_ACCOUNT_NICK: '', UNIPILE_ACCOUNT_JOHANNES: '' });
  await createLeads(none, [card(1)], 'nick');
  const open = await tasks(none, 'nick');
  assert.equal(open.counts.lead, 1);
  assert.equal(open.accountPaused, undefined);

  // Unipile nicht erreichbar: lieber weiterarbeiten als wegen einer Störung alles anhalten.
  const down = await setup({ UNIPILE_DSN: 'http://127.0.0.1:9' });
  await createLeads(down, [card(1)], 'nick');
  assert.equal((await tasks(down, 'nick')).counts.lead, 1);

  // Nur Johannes zugeordnet, Nick leer: Nick pausiert.
  const unassigned = await setup({ UNIPILE_ACCOUNT_NICK: '' });
  await createLeads(unassigned, [card(1)], 'nick');
  assert.deepEqual((await tasks(unassigned, 'nick')).accountPaused, ['nick']);
  assert.equal((await tasks(unassigned, 'johannes')).tasks[0]?.adoptedFrom, undefined, '„Meine“ übernimmt nichts');
  assert.equal((await tasks(unassigned, 'all')).tasks[0]?.adoptedFrom, 'nick');
});

test('Echt senden: Lead von Nick (Account getrennt) geht per Klick über Johannes, Johannes wird Besitzer', async () => {
  const app = await setup({ LINKEDIN_ACTIONS: 'on', LINKEDIN_PAUSE_SECONDS: '0-0', LINKEDIN_WORK_HOURS: '0-24', LINKEDIN_WORK_DAYS: '1-7' });
  const [lead] = await createLeads(app, [card(1)], 'nick');
  const response = await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/linkedin/invite`, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  const detail = response.json() as LeadDetailResponse;
  assert.equal(detail.lead.owner, 'johannes');
  assert.equal(detail.lead.linkedin?.sentBy, 'johannes');
  assert.equal(detail.lead.stage, 'invited');
});
