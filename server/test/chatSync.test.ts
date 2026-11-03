import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse, LeadDetailResponse } from '../../shared/leads.js';
import type { ChatSyncStatus } from '../../shared/linkedin.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

/** Chats nachträglich mit LinkedIn abgleichen (`/api/linkedin/chat-sync`, Wunsch des Nutzers 19.10.). */

const LIVE: NodeJS.ProcessEnv = {
  LEAD_SEARCH_MODE: 'live',
  UNIPILE_API_KEY: 'unipile-test-key',
  LINKEDIN_ACTIONS: 'off',
  UNIPILE_ACCOUNT_NICK: 'acc_nick',
  LINKEDIN_PAUSE_SECONDS: '0-0',
};

function app(env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  return buildApp({ config: loadConfig({ ...base, ...env }), adapter: new MockAdapter(0), logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
}
type App = ReturnType<typeof app>;

const card = (i: number): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: `ACoTEST${i}`,
  publicIdentifier: `person-${i}`,
  profileUrl: `https://www.linkedin.com/in/person-${i}`,
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

const act = async (server: App, id: string, payload: object) => {
  const response = await server.inject({ method: 'POST', url: `/api/leads/${id}/events`, payload });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as LeadDetailResponse).lead;
};

async function runSync(server: App): Promise<ChatSyncStatus> {
  const started = await server.inject({ method: 'POST', url: '/api/linkedin/chat-sync', payload: {} });
  assert.equal(started.statusCode, 202, started.body);
  for (let i = 0; i < 200; i++) {
    const status = (await server.inject({ method: 'GET', url: '/api/linkedin/chat-sync' })).json() as ChatSyncStatus;
    if (!status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Abgleich wurde nicht fertig');
}

test('Chat-Abgleich: nur vernetzte Leads, fehlende Nachrichten beider Seiten übernommen, nichts doppelt', async (t) => {
  // Nicks Account muss bei Unipile verbunden sein – sonst gehen Anfragen nicht über ihn (17.10.).
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const created = (await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card(1), card(2), card(3)], owner: 'nick' } })).json() as CreateLeadsResponse;
  const [a, b, c] = created.created as CockpitLead[];
  const hour = 60 * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();

  // A: von Hand angeschrieben (ohne Chat-ID im Cockpit), während der Sperre kamen Antwort und eigene Nachricht.
  await act(server, a.id, { action: 'invite_sent', at: now - 10 * hour });
  await act(server, a.id, { action: 'invite_accepted', at: now - 9 * hour });
  await act(server, a.id, { action: 'message_sent', text: 'Hallo  A, schön dich zu sehen!', at: now - 8 * hour });
  unipile.linkedin.attendeeChats.ACoTEST1 = [{ id: 'chat-a', account_id: 'acc_nick', timestamp: iso(now - hour) }];
  unipile.linkedin.messages['chat-a'] = [
    { id: 'a1', text: 'Hallo A, schön dich zu sehen!', is_sender: 1, timestamp: iso(now - 8 * hour), sender_id: 'me' },
    { id: 'a2', text: 'Klingt gut, erzähl mehr.', is_sender: 0, timestamp: iso(now - 5 * hour), sender_id: 'ACoTEST1' },
    { id: 'a3', text: 'Passt Donnerstag?', is_sender: 1, timestamp: iso(now - 4 * hour), sender_id: 'me' },
  ];
  // B: nur Anfrage gesendet, kein Chat.
  await act(server, b.id, { action: 'invite_sent', at: now - 10 * hour });
  // C: verloren – gehört nicht mehr zum Abgleich (nur vernetzte Leads, Wunsch des Nutzers 20.10.).
  await act(server, c.id, { action: 'invite_sent', at: now - 20 * hour });
  await act(server, c.id, { action: 'message_received', text: 'Kein Interesse.', at: now - 19 * hour });
  const lost = await act(server, c.id, { action: 'lost', at: now - 3 * hour });
  unipile.linkedin.attendeeChats.ACoTEST3 = [{ id: 'chat-c', account_id: 'acc_nick', timestamp: iso(now) }];
  unipile.linkedin.messages['chat-c'] = [
    { id: 'c1', text: 'Alte Nachricht vor dem Verloren', is_sender: 0, timestamp: iso(lost.lastActivityAt - hour), sender_id: 'ACoTEST3' },
    // Nach der letzten Aktivität (im Test ist das das Anlegen eben gerade).
    { id: 'c2', text: 'Ich habe es mir anders überlegt!', is_sender: 0, timestamp: iso(lost.lastActivityAt + 1000), sender_id: 'ACoTEST3' },
  ];

  const status = await runSync(server);
  assert.deepEqual([status.leadsTotal, status.leadsDone, status.imported, status.leadsUpdated, status.problems], [1, 1, 2, 1, ['Johannes: kein LinkedIn-Account eingetragen.']]);

  const detailA = (await server.inject({ method: 'GET', url: `/api/leads/${a.id}` })).json() as LeadDetailResponse;
  assert.deepEqual(
    detailA.events.filter((event) => event.kind.startsWith('message')).map((event) => [event.kind, event.text]),
    [
      ['message_sent', 'Hallo  A, schön dich zu sehen!'],
      ['message_received', 'Klingt gut, erzähl mehr.'],
      ['message_sent', 'Passt Donnerstag?'],
    ],
  );
  assert.equal(detailA.lead.stage, 'replied');
  assert.equal(detailA.lead.linkedin?.chatId, 'chat-a', 'Chat gemerkt – der normale Abgleich holt künftige Antworten');
  assert.match(detailA.events.find((event) => event.text === 'Klingt gut, erzähl mehr.')!.title, /aus LinkedIn übernommen/);

  const detailC = (await server.inject({ method: 'GET', url: `/api/leads/${c.id}` })).json() as LeadDetailResponse;
  assert.equal(detailC.lead.stage, 'lost');
  assert.ok(!detailC.events.some((event) => event.text === 'Ich habe es mir anders überlegt!'));
  assert.ok(!unipile.requests.some((request) => request.path.includes('ACoTEST2') || request.path.includes('chat-c')), 'B und C nicht abgefragt');

  // Zweiter Lauf: nichts Neues. Nur lesend – nie gesendet.
  const again = await runSync(server);
  assert.equal(again.imported, 0);
  assert.equal(unipile.requests.filter((request) => request.method === 'POST').length, 0);
});

test('Chat-Abgleich: ohne Unipile verständlich abgelehnt, Simulation übernimmt erfundene Antworten', async () => {
  const off = await app({ LEAD_SEARCH_MODE: 'live', UNIPILE_ACCOUNT_NICK: 'acc_nick' }).inject({ method: 'POST', url: '/api/linkedin/chat-sync', payload: {} });
  assert.deepEqual([off.statusCode, off.json().error.code], [409, 'linkedin_off']);

  const server = app();
  await server.ready();
  const status = await runSync(server);
  assert.ok(status.leadsTotal > 0);
  assert.equal(status.problems.length, 0);
  assert.equal((await runSync(server)).imported, 0, 'zweiter Lauf übernimmt nichts doppelt');
});

test('Automatischer Abgleich: Chats mit neuer Aktivität per Liste, Antwort auf von Hand gesendete Nachricht kommt an, kaputter Chat stört nicht', async (t) => {
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const created = (await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card(1), card(2), card(3)], owner: 'nick' } })).json() as CreateLeadsResponse;
  const [a, b, c] = created.created as CockpitLead[];
  for (const lead of [a, b, c]) {
    await act(server, lead.id, { action: 'invite_sent' });
    await act(server, lead.id, { action: 'invite_accepted' });
    await act(server, lead.id, { action: 'message_sent', text: `Hallo ${lead.person.firstName}` });
  }
  const now = new Date().toISOString();
  // Viele Chats im Cockpit, aber nur zwei mit neuer Aktivität; einer davon ist kaputt.
  unipile.linkedin.chatList = [
    { id: 'chat-b', account_id: 'acc_nick', timestamp: now, attendee_provider_id: 'ACoTEST2' },
    { id: 'chat-a', account_id: 'acc_nick', timestamp: now, attendee_provider_id: 'ACoTEST1' },
    { id: 'chat-x', account_id: 'acc_nick', timestamp: now, attendee_provider_id: 'ACoFREMD' },
  ];
  unipile.linkedin.brokenChats = ['chat-b'];
  unipile.linkedin.messages['chat-a'] = [
    { id: 'a1', text: 'Hallo Vorname1', is_sender: 1, timestamp: now, sender_id: 'me' },
    { id: 'a2', text: 'Gern, ruf mich an.', is_sender: 0, timestamp: now, sender_id: 'ACoTEST1' },
  ];

  const synced = (await server.inject({ method: 'POST', url: '/api/linkedin/sync' })).json() as { replied: string[]; problems: string[] };
  assert.deepEqual(synced.replied, [a.id]);
  assert.deepEqual(synced.problems, ['Johannes: kein LinkedIn-Account eingetragen.'], 'kaputter Chat ist kein Problem für den ganzen Account');
  const detailA = (await server.inject({ method: 'GET', url: `/api/leads/${a.id}` })).json() as LeadDetailResponse;
  assert.equal(detailA.lead.stage, 'replied');
  assert.deepEqual(detailA.events.filter((event) => event.kind.startsWith('message')).map((event) => event.text), ['Hallo Vorname1', 'Gern, ruf mich an.']);
  assert.equal(detailA.lead.linkedin?.chatId, 'chat-a');
  // Nur Nachrichten der aktiven Chats abgerufen – nicht je Lead.
  const messageCalls = unipile.requests.filter((request) => request.method === 'GET' && /^\/api\/v1\/chats\/[^/]+\/messages$/.test(request.path)).map((request) => request.path);
  assert.deepEqual(messageCalls.sort(), ['/api/v1/chats/chat-a/messages', '/api/v1/chats/chat-b/messages']);
  assert.ok(!unipile.requests.some((request) => request.path.includes('ACoTEST3')));
  assert.equal(unipile.requests.filter((request) => request.method === 'POST').length, 0, 'nur lesend');
});

test('Automatischer Abgleich (22.10.): späte Antwort eines verlorenen Leads kommt an – Lead wieder offen, Aufgabe „Antwort“', async (t) => {
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const created = (await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card(7)], owner: 'nick' } })).json() as CreateLeadsResponse;
  const lead = created.created[0] as CockpitLead;
  await act(server, lead.id, { action: 'invite_sent' });
  await act(server, lead.id, { action: 'invite_accepted' });
  await act(server, lead.id, { action: 'message_sent', text: 'Hallo Vorname7' });
  await act(server, lead.id, { action: 'lost', text: 'Keine Antwort' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const now = new Date().toISOString();
  unipile.linkedin.chatList = [{ id: 'chat-7', account_id: 'acc_nick', timestamp: now, attendee_provider_id: 'ACoTEST7' }];
  unipile.linkedin.messages['chat-7'] = [
    { id: 'm1', text: 'Hallo Vorname7', is_sender: 1, timestamp: new Date(Date.now() - 60_000).toISOString(), sender_id: 'me' },
    { id: 'm2', text: 'Sorry für die späte Antwort – lass uns sprechen.', is_sender: 0, timestamp: now, sender_id: 'ACoTEST7' },
  ];
  const synced = (await server.inject({ method: 'POST', url: '/api/linkedin/sync' })).json() as { replied: string[] };
  assert.deepEqual(synced.replied, [lead.id]);
  const detail = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(detail.lead.stage, 'replied');
  const tasks = (await server.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as { tasks: { type: string; lead: { id: string } }[] };
  assert.ok(tasks.tasks.some((task) => task.type === 'reply' && task.lead.id === lead.id), 'Antwort steht in den Aufgaben');
});

test('Automatischer Abgleich: eigene Nachricht bei offener Anfrage setzt nicht „Vernetzt“, erst die Kontaktliste', async (t) => {
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const created = (await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card(1)], owner: 'nick' } })).json() as CreateLeadsResponse;
  const [lead] = created.created as CockpitLead[];
  await act(server, lead.id, { action: 'invite_sent' });
  const now = new Date().toISOString();
  // Notiz zur Anfrage taucht als eigene Nachricht im Chat auf – die Anfrage ist auf LinkedIn aber noch offen.
  unipile.linkedin.chatList = [{ id: 'chat-a', account_id: 'acc_nick', timestamp: now, attendee_provider_id: 'ACoTEST1' }];
  unipile.linkedin.messages['chat-a'] = [{ id: 'a1', text: 'Hallo Vorname1, gern vernetzen', is_sender: 1, timestamp: now, sender_id: 'me' }];

  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  let detail = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(detail.lead.stage, 'invited');
  assert.equal(detail.events.some((event) => event.kind === 'invite_accepted' || event.kind === 'message_sent'), false);

  // Angenommen laut Kontaktliste → Vernetzt; die Nachricht kommt danach noch an.
  unipile.linkedin.relations = [{ member_id: 'ACoTEST1', public_identifier: 'person-1', created_at: Date.now() }];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  detail = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(detail.events.filter((event) => event.kind === 'invite_accepted').length, 1);
  assert.deepEqual(detail.events.filter((event) => event.kind === 'message_sent').map((event) => event.text), ['Hallo Vorname1, gern vernetzen']);
});
