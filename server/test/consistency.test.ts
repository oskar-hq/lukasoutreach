import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SEARCH_PROFILE, handoffCount, type NewLeadCard, type RunSnapshot } from '../../shared/leadSearch.js';
import type { CockpitLead, ConversationListResponse, CreateLeadsResponse, LeadListResponse } from '../../shared/leads.js';
import type { TasksResponse } from '../../shared/tasks.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { tempDataDir } from './helpers.js';

/**
 * Kundengespräch 25.10.: Was die Oberfläche zeigt, muss der Server so auch tun – Leads aus der Suche gehen nicht
 * verloren, Vernetzungsanfragen zählen auf jedem Weg gleich, Chats nennen den Account, über den sie laufen.
 */

function app(env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  return buildApp({ config: loadConfig({ ...base, ...env }), adapter: new MockAdapter(0), logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
}

type App = ReturnType<typeof app>;

const card = (i: number): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: `ACoKONS${i}`,
  publicIdentifier: `kons-${i}`,
  profileUrl: `https://www.linkedin.com/in/kons-${i}`,
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

async function createLeads(server: App, from: number, count: number, owner: 'nick' | 'johannes'): Promise<CockpitLead[]> {
  const cards = Array.from({ length: count }, (_, i) => card(from + i));
  const response = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards, owner } });
  assert.equal(response.statusCode, 200, response.body);
  const created = (response.json() as CreateLeadsResponse).created;
  assert.equal(created.length, count);
  return created;
}

const post = (server: App, url: string, payload: object = {}) => server.inject({ method: 'POST', url, payload });
const enter = (server: App, id: string) => post(server, `/api/leads/${id}/events`, { action: 'invite_sent' });
const send = (server: App, id: string) => post(server, `/api/leads/${id}/linkedin/invite`, {});
const tasks = async (server: App, owner: string) => (await server.inject({ method: 'GET', url: `/api/tasks?owner=${owner}` })).json() as TasksResponse;

test('Anfragen: Eintragen von Hand und Senden über LinkedIn zählen gegen dasselbe Tageslimit', async () => {
  const server = app({ LINKEDIN_INVITES_PER_DAY: '2', LINKEDIN_ACCOUNT_FALLBACK: 'off', LEAD_DISTRIBUTION: 'owner' });
  const [a, b, c, d] = await createLeads(server, 1, 4, 'nick');
  assert.equal((await enter(server, a.id)).statusCode, 200, 'von Hand eingetragen');
  assert.equal((await send(server, b.id)).statusCode, 200, 'über LinkedIn gesendet');
  // Vorher zählte das Senden nur sich selbst (1 von 2) und ließ eine dritte Anfrage durch.
  const third = await send(server, c.id);
  assert.equal(third.statusCode, 429, third.body);
  assert.equal(third.json().error.code, 'linkedin_limit');
  assert.equal((await enter(server, d.id)).statusCode, 429);
  const status = (await server.inject({ method: 'GET', url: '/api/linkedin/status' })).json() as { accounts: { founder: string; invitesToday: { used: number } }[] };
  assert.equal(status.accounts.find((account) => account.founder === 'nick')?.invitesToday.used, 2);
});

test('Tagesstapel „Alle“: Anfragen je Account und je Besitzer der Account der nächsten Anfrage', async () => {
  const server = app({ LINKEDIN_INVITES_PER_DAY: '1', LINKEDIN_ACCOUNT_FALLBACK: 'on', LEAD_DISTRIBUTION: 'owner' });
  const [first, second] = await createLeads(server, 10, 2, 'nick');
  await createLeads(server, 20, 1, 'johannes');
  assert.equal((await enter(server, first.id)).statusCode, 200);
  // Nicks Account ist voll → die zweite Anfrage für Nicks Lead geht über Johannes' Account.
  assert.equal((await enter(server, second.id)).statusCode, 200);
  const all = await tasks(server, 'all');
  assert.deepEqual(all.invitesToday, { nick: 2 }, 'je Besitzer – für „Neue Leads pro Tag“');
  assert.deepEqual(all.invitesByAccount, { nick: 1, johannes: 1 }, 'je Account – für das Limit');
  assert.deepEqual(all.inviteViaByOwner, { nick: null, johannes: null }, 'beide Accounts voll');
  assert.deepEqual(all.invitesPerDayByAccount, { nick: 1, johannes: 1 });
  // Die Karte für Johannes' Lead darf also nicht „2 von 1“ zeigen, sondern „gesperrt“ – und der Server sperrt wirklich.
  const johannesLead = all.tasks.find((task) => task.type === 'lead' && task.lead.owner === 'johannes');
  assert.ok(johannesLead);
  assert.equal((await enter(server, johannesLead.lead.id)).statusCode, 429);
});

test('Suche von Hand: Der Server speichert die Leads am Ende des Laufs – ohne Klick, ohne Browser', async () => {
  const server = app({ LEAD_DISTRIBUTION: 'owner' });
  const started = await post(server, '/api/lead-search/runs', { profile: DEFAULT_SEARCH_PROFILE, owner: 'johannes' });
  assert.equal(started.statusCode, 202, started.body);
  const id = (started.json() as { run: RunSnapshot }).run.id;
  let run: RunSnapshot;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    run = ((await server.inject({ method: 'GET', url: `/api/lead-search/runs/${id}` })).json() as { run: RunSnapshot }).run;
  } while (run.status === 'running');
  assert.equal(run.handedOff, true);
  // Qualifizierte plus markierte mit aktiven Meta-Ads (Entscheidung 07.10.) – wie „In den Tagesstapel“.
  const expected = handoffCount(run.leads);
  assert.ok(expected > 0);
  assert.equal(run.saved?.created.length, expected);
  assert.ok(run.saved?.created.every((entry) => entry.owner === 'johannes'));
  const leads = (await server.inject({ method: 'GET', url: '/api/leads?owner=johannes&stage=new' })).json() as LeadListResponse;
  const runLeads = leads.leads.filter((lead) => lead.origin.kind === 'search' && lead.origin.runId === id);
  assert.equal(runLeads.length, expected);
  // „In den Tagesstapel“ danach (ältere Oberfläche) legt nichts doppelt an.
  const handoff = (await post(server, `/api/lead-search/runs/${id}/handoff`)).json() as { leads: NewLeadCard[] };
  const again = (await post(server, '/api/leads', { cards: handoff.leads, owner: 'johannes' })).json() as CreateLeadsResponse;
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, expected);
  // Und alle stehen heute im Stapel (frisch aus der Suche – über dem Tageslimit).
  const stack = await tasks(server, 'johannes');
  for (const lead of runLeads) assert.ok(stack.tasks.some((task) => task.lead.id === lead.id), lead.id);
});

test('Chats: Account, über den der Chat läuft, und Zahl der Antworten', async () => {
  const server = app({ LINKEDIN_INVITES_PER_DAY: '1', LINKEDIN_ACCOUNT_FALLBACK: 'on', LEAD_DISTRIBUTION: 'owner' });
  const [own, switched] = await createLeads(server, 30, 2, 'nick');
  for (const lead of [own, switched]) {
    assert.equal((await enter(server, lead.id)).statusCode, 200);
    assert.equal((await post(server, `/api/leads/${lead.id}/events`, { action: 'invite_accepted' })).statusCode, 200);
    assert.equal((await post(server, `/api/leads/${lead.id}/events`, { action: 'message_sent', text: 'Hallo' })).statusCode, 200);
  }
  assert.equal((await post(server, `/api/leads/${switched.id}/events`, { action: 'message_received', text: 'Gern!' })).statusCode, 200);
  const list = ((await server.inject({ method: 'GET', url: '/api/conversations' })).json() as ConversationListResponse).conversations;
  const byId = new Map(list.map((entry) => [entry.lead.id, entry]));
  assert.equal(byId.get(own.id)?.account, 'nick');
  assert.equal(byId.get(own.id)?.replies, 0);
  assert.equal(byId.get(switched.id)?.lead.owner, 'nick');
  assert.equal(byId.get(switched.id)?.account, 'johannes', 'Anfrage ging über Johannes – der Chat auch');
  assert.equal(byId.get(switched.id)?.replies, 1);
});

test('Verlauf: Anfrage über den Account des anderen Gründers nennt ihn – eingetragen heißt nicht „über LinkedIn“', async () => {
  const server = app({ LINKEDIN_INVITES_PER_DAY: '1', LINKEDIN_ACCOUNT_FALLBACK: 'on', LEAD_DISTRIBUTION: 'owner' });
  const [first, second] = await createLeads(server, 40, 2, 'nick');
  assert.equal((await enter(server, first.id)).statusCode, 200);
  const switched = await enter(server, second.id);
  assert.equal(switched.statusCode, 200);
  const body = switched.json() as { lead: CockpitLead; events: { kind: string; title: string }[] };
  assert.equal(body.lead.linkedin?.sentBy, 'johannes');
  const title = body.events.find((event) => event.kind === 'invite_sent')?.title ?? '';
  assert.match(title, /über den Account von Johannes/);
  assert.doesNotMatch(title, /über LinkedIn/);
});
