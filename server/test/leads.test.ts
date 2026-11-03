import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse, LeadDetailResponse, LeadListResponse } from '../../shared/leads.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DEMO_SEED } from '../src/leads/demoSeed.js';
import { tempDataDir } from './helpers.js';

function app(mode: 'mock' | 'live' = 'mock', dataDir = tempDataDir()) {
  const config = loadConfig({ LEAD_SEARCH_MODE: mode, DATA_DIR: dataDir });
  return buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false });
}

type App = ReturnType<typeof app>;

function card(overrides: Partial<NewLeadCard> = {}): NewLeadCard {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    mode: 'mock',
    providerId: 'ACoTEST001',
    publicIdentifier: 'erika-muster',
    profileUrl: 'https://www.linkedin.com/in/erika-muster',
    firstName: 'Erika',
    lastName: 'Muster',
    headline: 'Geschäftsführerin · Muster Wohnbau GmbH',
    position: 'Geschäftsführerin',
    company: 'Muster Wohnbau GmbH',
    location: 'Köln',
    website: 'https://muster-wohnbau.de',
    networkDistance: 2,
    category: 'bautraeger_projektentwickler',
    confidence: 0.88,
    reason: 'Entwickelt eigene Wohnprojekte und verkauft die Einheiten selbst.',
    summary: 'Bauträger aus Köln mit Eigenvertrieb.',
    metaAds: null,
    ...overrides,
  };
}

async function create(server: App, body: object) {
  const response = await server.inject({ method: 'POST', url: '/api/leads', payload: body });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as CreateLeadsResponse;
}

async function act(server: App, id: string, body: object, status = 200) {
  const response = await server.inject({ method: 'POST', url: `/api/leads/${id}/events`, payload: body });
  assert.equal(response.statusCode, status, response.body);
  return response.json() as LeadDetailResponse;
}

async function list(server: App, query = '') {
  const response = await server.inject({ method: 'GET', url: `/api/leads${query}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as LeadListResponse;
}

test('Simulation: leere Datenbank bekommt die 30 Demo-Leads, sortiert nach ältester Aktivität', async () => {
  const server = app('mock');
  const { leads, total } = await list(server);
  assert.equal(total, 30);
  assert.equal(leads.length, 30);
  assert.equal(leads.filter((lead) => lead.owner === 'nick').length, 15);
  const counts: Record<string, number> = {};
  for (const lead of leads) counts[lead.stage] = (counts[lead.stage] ?? 0) + 1;
  assert.deepEqual(counts, { new: 10, connected: 6, contacted: 8, replied: 6 });
  for (let i = 1; i < leads.length; i++) assert.ok(leads[i - 1].lastActivityAt <= leads[i].lastActivityAt);
  assert.ok(leads.every((lead) => lead.origin.kind === 'demo'));

  const replied = leads.find((lead) => lead.person.lastName === 'Brehm') as CockpitLead;
  const detail = (await server.inject({ method: 'GET', url: `/api/leads/${replied.id}` })).json() as LeadDetailResponse;
  assert.deepEqual(
    detail.events.map((event) => event.kind),
    ['created', 'assessed', 'invite_sent', 'invite_accepted', 'message_sent', 'message_received'],
  );
  assert.ok(detail.events.every((event) => event.at <= Date.now()));
  assert.equal(replied.template, 'G1', 'alte Vorlage A heißt in den Demo-Daten jetzt G1');
  assert.ok(replied.lastReplyAt && replied.lastContactAt && replied.lastReplyAt > replied.lastContactAt);
});

test('Live: keine Demo-Leads, Demo-Reset nicht verfügbar', async () => {
  const server = app('live');
  assert.equal((await list(server)).total, 0);
  assert.equal((await server.inject({ method: 'POST', url: '/api/leads/demo/reset' })).statusCode, 404);
});

test('Filter: Gründer, Stufen und Freitext', async () => {
  const server = app('mock');
  const johannes = await list(server, '?owner=johannes&stage=new,connected');
  assert.ok(johannes.total > 0);
  assert.ok(johannes.leads.every((lead) => lead.owner === 'johannes' && ['new', 'connected'].includes(lead.stage)));
  const byName = await list(server, '?q=brehm%20hamburg');
  assert.equal(byName.total, 1);
  assert.equal(byName.leads[0].person.firstName, 'Tobias');
  const paged = await list(server, '?limit=5&offset=5');
  assert.equal(paged.leads.length, 5);
  assert.equal(paged.total, 30);
  assert.equal((await server.inject({ method: 'GET', url: '/api/leads?stage=unbekannt' })).statusCode, 400);
});

test('Übergabe aus der Lead-Suche: legt Leads an, Dubletten je providerId werden übersprungen', async () => {
  const server = app('live');
  const first = await create(server, { cards: [card()], owner: 'johannes' });
  assert.equal(first.created.length, 1);
  const lead = first.created[0];
  assert.equal(lead.stage, 'new');
  assert.equal(lead.owner, 'johannes');
  assert.equal(lead.company.website, 'https://muster-wohnbau.de');
  assert.deepEqual(lead.origin, { kind: 'search', runId: card().runId, mode: 'mock' });

  const again = await create(server, { cards: [card(), card({ providerId: 'ACoTEST002', firstName: 'Max' })], owner: 'nick' });
  assert.equal(again.created.length, 1);
  assert.deepEqual(again.skipped, [{ providerId: 'ACoTEST001', leadId: lead.id, owner: 'johannes' }]);

  const missingOwner = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card({ providerId: 'X' })] } });
  assert.equal(missingOwner.statusCode, 400, 'ohne Anmeldung muss owner angegeben werden');
});

test('Aktionen schalten die Stufe weiter: Anfrage → vernetzt → Erstnachricht → Follow-up → Antwort → Termin → übergeben', async () => {
  const server = app('live');
  const { created } = await create(server, { cards: [card()], owner: 'nick' });
  const id = created[0].id;

  assert.equal((await act(server, id, { action: 'invite_sent' })).lead.stage, 'invited');
  assert.equal((await act(server, id, { action: 'invite_accepted' })).lead.stage, 'connected');
  let detail = await act(server, id, { action: 'message_sent', text: 'Hallo Erika …', label: 'B' });
  assert.equal(detail.lead.stage, 'contacted');
  assert.equal(detail.lead.template, 'B');
  assert.equal(detail.events.at(-1)?.title, 'Erstnachricht · Vorlage B gesendet');
  detail = await act(server, id, { action: 'message_sent', text: 'Kurze Erinnerung …', label: 'A' });
  assert.equal(detail.lead.followUpsSent, 1);
  assert.equal(detail.events.at(-1)?.title, 'Follow-up 1 · Variante A gesendet');
  detail = await act(server, id, { action: 'message_received', text: 'Gern, Donnerstag?' });
  assert.equal(detail.lead.stage, 'replied');
  assert.ok(detail.lead.lastReplyAt);
  assert.equal((await act(server, id, { action: 'meeting_booked', text: 'Do. 10 Uhr' })).lead.stage, 'meeting');
  detail = await act(server, id, { action: 'handed_over' });
  assert.equal(detail.lead.stage, 'handed_over');
  assert.deepEqual(
    detail.events.map((event) => event.kind),
    ['created', 'assessed', 'invite_sent', 'invite_accepted', 'message_sent', 'message_sent', 'message_received', 'meeting_booked', 'handed_over'],
  );
  assert.ok(detail.events.every((event) => event.by === 'nick' || event.kind === 'assessed'));
});

test('unpassende Aktion → 409, unbekannter Lead → 404, ungültige Anfrage → 400', async () => {
  const server = app('live');
  const { created } = await create(server, { cards: [card()], owner: 'nick' });
  const id = created[0].id;
  const conflict = await server.inject({ method: 'POST', url: `/api/leads/${id}/events`, payload: { action: 'message_sent', text: 'zu früh' } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'invalid_transition');
  assert.match(conflict.json().error.message, /Nachricht gesendet.*Neu/);
  await act(server, 'gibt-es-nicht', { action: 'note', text: 'x' }, 404);
  await act(server, id, { action: 'fliegen' }, 400);

  assert.equal((await act(server, id, { action: 'lost', text: 'Kein Interesse' })).lead.stage, 'lost');
  await act(server, id, { action: 'lost' }, 409);
  assert.equal((await act(server, id, { action: 'note', text: 'Später nochmal probieren' })).lead.stage, 'lost');
});

test('Zuständigkeit und nächster Schritt ändern', async () => {
  const server = app('live');
  const { created } = await create(server, { cards: [card()], owner: 'nick' });
  const response = await server.inject({ method: 'PATCH', url: `/api/leads/${created[0].id}`, payload: { owner: 'johannes', nextStep: 'Case Study schicken' } });
  assert.equal(response.statusCode, 200, response.body);
  const detail = response.json() as LeadDetailResponse;
  assert.equal(detail.lead.owner, 'johannes');
  assert.equal(detail.lead.nextStep, 'Case Study schicken');
  assert.equal(detail.events.at(-1)?.kind, 'owner_changed');
  assert.equal((await server.inject({ method: 'PATCH', url: `/api/leads/${created[0].id}`, payload: {} })).statusCode, 400);
});

test('Leads überleben einen Neustart; Demo-Reset stellt den Ausgangszustand her', async () => {
  const dataDir = tempDataDir();
  const first = app('mock', dataDir);
  const lead = (await list(first, '?stage=new&limit=1')).leads[0];
  await act(first, lead.id, { action: 'invite_sent' });
  await first.close();

  const second = app('mock', dataDir);
  assert.equal((await list(second, '?stage=invited')).total, 1, 'Datenbank bleibt, kein erneutes Anlegen');
  const reset = await second.inject({ method: 'POST', url: '/api/leads/demo/reset' });
  assert.deepEqual(reset.json(), { count: DEMO_SEED.length });
  assert.equal((await list(second, '?stage=invited')).total, 0);
});

test('angemeldeter Nutzer wird zuständig und steht im Verlauf', async () => {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', DATA_DIR: tempDataDir(), AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false' });
  const server = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: true });
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'johannes', password: 'demo' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  assert.equal((await server.inject({ method: 'GET', url: '/api/leads' })).statusCode, 401, 'ohne Sitzung gesperrt');

  const response = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card()] }, headers: { cookie } });
  const { created } = response.json() as CreateLeadsResponse;
  assert.equal(created[0].owner, 'johannes');
  const events = await server.inject({ method: 'POST', url: `/api/leads/${created[0].id}/events`, payload: { action: 'invite_sent' }, headers: { cookie } });
  assert.equal((events.json() as LeadDetailResponse).events.at(-1)?.title, 'Vernetzungsanfrage gesendet von Johannes');
});

test('Eigene Board-Spalten: anlegen, umbenennen, Lead hinein und zurück, löschen bringt Leads in ihre Stufe zurück', async () => {
  const server = app();
  await server.ready();
  const created = await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: '  Meeting Close ' } });
  assert.equal(created.statusCode, 201, created.body);
  const column = created.json() as { id: string; name: string; position: number };
  assert.deepEqual([column.name, column.position], ['Meeting Close', 0]);
  assert.equal((await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: 'meeting close' } })).statusCode, 400, 'doppelt');
  assert.equal((await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: '' } })).statusCode, 400);
  const second = (await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: 'Warten auf Vertrag' } })).json() as { position: number };
  assert.equal(second.position, 1);

  const renamed = await server.inject({ method: 'PATCH', url: `/api/board/columns/${column.id}`, payload: { name: 'Close-Termin' } });
  assert.equal(renamed.json().name, 'Close-Termin');

  const lead = ((await server.inject({ method: 'GET', url: '/api/leads?limit=1' })).json() as LeadListResponse).leads[0];
  const moved = await server.inject({ method: 'PATCH', url: `/api/leads/${lead.id}`, payload: { boardColumn: column.id } });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal((moved.json() as LeadDetailResponse).lead.boardColumn, column.id);
  assert.equal((moved.json() as LeadDetailResponse).lead.stage, lead.stage, 'Stufe bleibt');
  assert.equal((await server.inject({ method: 'PATCH', url: `/api/leads/${lead.id}`, payload: { boardColumn: 'gibt-es-nicht' } })).statusCode, 400);

  const deleted = await server.inject({ method: 'DELETE', url: `/api/board/columns/${column.id}` });
  assert.deepEqual((deleted.json() as { columns: { name: string }[] }).columns.map((entry) => entry.name), ['Warten auf Vertrag']);
  const after = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(after.lead.boardColumn, undefined, 'zurück in der Spalte der Stufe');
  await server.close();
});

test('Board frei anordnen: Stufen und eigene Spalten verschieben, Stufen umbenennen und zurücksetzen', async () => {
  const server = app();
  await server.ready();
  type Board = { columns: { id: string; name: string }[]; layout: { order: string[]; stageNames: Record<string, string> } };
  const board = async () => (await server.inject({ method: 'GET', url: '/api/board/columns' })).json() as Board;
  const initial = await board();
  assert.deepEqual(initial.layout.order, ['stage:new', 'stage:invited', 'stage:connected', 'stage:contacted', 'stage:replied', 'stage:meeting', 'stage:handed_over', 'stage:lost']);
  assert.deepEqual(initial.layout.stageNames, {});

  // Eigene Spalte „Follow-up“ zwischen Antwort und Termin.
  const follow = (await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: 'Follow-up' } })).json() as { id: string };
  assert.equal((await board()).layout.order.at(-1), `custom:${follow.id}`, 'neue Spalte hinten');
  const order = ['stage:new', 'stage:invited', 'stage:connected', 'stage:contacted', 'stage:replied', `custom:${follow.id}`, 'stage:meeting', 'stage:handed_over', 'stage:lost'];
  const put = await server.inject({ method: 'PUT', url: '/api/board/columns/order', payload: { order } });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual((put.json() as Board).layout.order, order);
  assert.equal((await server.inject({ method: 'PUT', url: '/api/board/columns/order', payload: { order: ['stage:new', 'stage:new'] } })).statusCode, 400, 'doppelt');
  assert.equal((await server.inject({ method: 'PUT', url: '/api/board/columns/order', payload: { order: ['custom:gibt-es-nicht'] } })).statusCode, 400, 'unbekannt');

  // Stufe umbenennen – nur die Anzeige; leer = Standardname.
  const renamed = await server.inject({ method: 'PATCH', url: '/api/board/columns/stage/replied', payload: { name: '  Im Gespräch ' } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.deepEqual((renamed.json() as Board).layout.stageNames, { replied: 'Im Gespräch' });
  assert.equal((await server.inject({ method: 'PATCH', url: '/api/board/columns/stage/gibt-es-nicht', payload: { name: 'x' } })).statusCode, 404);
  const reset = (await server.inject({ method: 'PATCH', url: '/api/board/columns/stage/replied', payload: { name: null } })).json() as Board;
  assert.deepEqual(reset.layout.stageNames, {});

  // Gelöschte Spalte fällt aus der Reihenfolge, der Rest bleibt.
  const deleted = (await server.inject({ method: 'DELETE', url: `/api/board/columns/${follow.id}` })).json() as Board;
  assert.deepEqual(deleted.layout.order, order.filter((key) => !key.startsWith('custom:')));
  await server.close();
});

test('Board ohne Abgeschlossene: columns=1 liefert verlorene Leads in eigenen Spalten mit, Stufen-Filter sonst wie gehabt', async () => {
  const server = app();
  await server.ready();
  const column = (await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: 'Meeting Close' } })).json() as { id: string };
  const lead = ((await server.inject({ method: 'GET', url: '/api/leads?stage=new&limit=1' })).json() as LeadListResponse).leads[0];
  assert.equal((await server.inject({ method: 'PATCH', url: `/api/leads/${lead.id}`, payload: { boardColumn: column.id } })).statusCode, 200);
  await act(server, lead.id, { action: 'lost' });
  const open = 'stage=new,invited,connected,contacted,replied,meeting';
  const ids = async (query: string) => (await list(server, query)).leads.map((entry) => entry.id);
  assert.ok(!(await ids(`?${open}&limit=2000`)).includes(lead.id), 'ohne columns=1 fehlt der verlorene Lead');
  const withColumns = await list(server, `?${open}&columns=1&limit=2000`);
  const found = withColumns.leads.find((entry) => entry.id === lead.id);
  assert.equal(found?.stage, 'lost');
  assert.equal(found?.boardColumn, column.id);
  assert.ok(withColumns.leads.every((entry) => entry.stage !== 'lost' || entry.boardColumn), 'sonst keine verlorenen');
  assert.equal((await server.inject({ method: 'GET', url: '/api/leads?columns=ja' })).statusCode, 400);
  await server.close();
});

test('Chats: Leads mit Nachrichten, neueste zuerst, letzte Nachricht und „Antwort offen“', async () => {
  const server = app();
  await server.ready();
  const { conversations } = (await server.inject({ method: 'GET', url: '/api/conversations?owner=nick' })).json() as {
    conversations: { lead: CockpitLead; lastMessage: { from: string; at: number; text: string }; awaitingReply: boolean; messageCount: number }[];
  };
  assert.ok(conversations.length > 0);
  assert.ok(conversations.every((entry) => entry.lead.owner === 'nick'));
  for (let i = 1; i < conversations.length; i++) assert.ok(conversations[i - 1].lastMessage.at >= conversations[i].lastMessage.at);
  const replied = conversations.find((entry) => entry.lead.stage === 'replied');
  assert.ok(replied && replied.awaitingReply && replied.lastMessage.from === 'lead' && replied.lastMessage.text.length > 0);

  // Neue eigene Nachricht: Chat rückt nach oben, keine Antwort mehr offen.
  await server.inject({ method: 'POST', url: `/api/leads/${replied.lead.id}/events`, payload: { action: 'message_sent', text: 'Gern, Donnerstag passt!' } });
  const after = (await server.inject({ method: 'GET', url: '/api/conversations?owner=nick' })).json().conversations[0];
  assert.deepEqual([after.lead.id, after.lastMessage.from, after.lastMessage.text, after.awaitingReply], [replied.lead.id, 'founder', 'Gern, Donnerstag passt!', false]);
  assert.equal(after.messageCount, replied.messageCount + 1);
  await server.close();
});

test('Antwort im Termin: Stufe bleibt „Termin“, Antwort und lastReplyAt werden trotzdem gebucht', async () => {
  const server = app('live');
  const { created } = await create(server, { cards: [card()], owner: 'nick' });
  const id = created[0].id;
  await act(server, id, { action: 'invite_accepted' });
  await act(server, id, { action: 'message_sent', text: 'Hallo', label: 'A' });
  await act(server, id, { action: 'meeting_booked' });
  const detail = await act(server, id, { action: 'message_received', text: 'Passt Donnerstag noch?' });
  assert.equal(detail.lead.stage, 'meeting');
  assert.ok(detail.lead.lastReplyAt);
  assert.equal(detail.events.at(-1)?.kind, 'message_received');
});

test('Wieder öffnen: Stufe aus dem Verlauf, späte Antwort aus „Verloren“/„Übergeben“, sonst 409', async () => {
  const server = app('live');
  const { created } = await create(server, {
    cards: ['A', 'B', 'C', 'D', 'E'].map((suffix) => card({ providerId: `ACoREOPEN${suffix}`, publicIdentifier: `reopen-${suffix}` })),
    owner: 'nick',
  });
  const [fresh, invited, connected, contacted, replied] = created.map((lead) => lead.id);
  await act(server, invited, { action: 'invite_sent' });
  await act(server, connected, { action: 'invite_accepted' });
  await act(server, contacted, { action: 'invite_accepted' });
  await act(server, contacted, { action: 'message_sent', text: 'Hallo', label: 'A' });
  await act(server, replied, { action: 'invite_accepted' });
  await act(server, replied, { action: 'message_sent', text: 'Hallo', label: 'A' });
  await act(server, replied, { action: 'message_received', text: 'Danke' });

  // Nur aus Endstufen.
  await act(server, fresh, { action: 'reopened' }, 409);
  const expected: Record<string, string> = { [fresh]: 'new', [invited]: 'invited', [connected]: 'connected', [contacted]: 'contacted', [replied]: 'replied' };
  for (const id of created.map((lead) => lead.id)) {
    await act(server, id, { action: 'lost' });
    const detail = await act(server, id, { action: 'reopened' });
    assert.equal(detail.lead.stage, expected[id]);
    assert.equal(detail.events.at(-1)?.kind, 'reopened');
    assert.match(detail.events.at(-1)?.title ?? '', /^Wieder geöffnet · /);
  }

  // Übergeben → wieder öffnen; späte Antwort aus „Verloren“ und „Übergeben“ landet in „Antwort“.
  await act(server, replied, { action: 'handed_over' });
  assert.equal((await act(server, replied, { action: 'reopened' })).lead.stage, 'replied');
  await act(server, contacted, { action: 'lost' });
  assert.equal((await act(server, contacted, { action: 'message_received', text: 'Doch noch Interesse' })).lead.stage, 'replied');
  await act(server, replied, { action: 'handed_over' });
  assert.equal((await act(server, replied, { action: 'message_received', text: 'Noch eine Frage' })).lead.stage, 'replied');

  // Mit Termin im Verlauf: zurück nach „Termin“ – aus „Übergeben“ wie aus „Verloren“.
  await act(server, replied, { action: 'meeting_booked' });
  await act(server, replied, { action: 'handed_over' });
  const back = await act(server, replied, { action: 'reopened' });
  assert.equal(back.lead.stage, 'meeting');
  assert.equal(back.events.at(-1)?.title, 'Wieder geöffnet · Termin');
  await act(server, replied, { action: 'lost' });
  assert.equal((await act(server, replied, { action: 'reopened' })).lead.stage, 'meeting');
});

test('Liste: sort=recent zeigt zuletzt bearbeitete Leads zuerst – mit limit fehlen dann die ältesten', async () => {
  const server = app();
  const all = (await list(server, '?limit=2000')).leads;
  const recent = await list(server, '?sort=recent&limit=5');
  assert.equal(recent.total, all.length);
  assert.deepEqual(
    recent.leads.map((lead) => lead.lastActivityAt),
    all.map((lead) => lead.lastActivityAt).sort((a, b) => b - a).slice(0, 5),
  );
  assert.equal((await server.inject({ method: 'GET', url: '/api/leads?sort=quatsch' })).statusCode, 400);
});
