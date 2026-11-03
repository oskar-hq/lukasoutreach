import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddContactResponse, LeadDetailResponse } from '../../shared/leads.js';
import type { TasksResponse } from '../../shared/tasks.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

/** Persönlicher Kontakt per LinkedIn-Link (`POST /api/leads/contact`, Wunsch des Nutzers 19.10.). */

const LIVE: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key', LINKEDIN_ACTIONS: 'off', UNIPILE_ACCOUNT_NICK: 'acc_nick' };

function app(env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  return buildApp({ config: loadConfig({ ...base, ...env }), adapter: new MockAdapter(0), logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
}

const add = (server: ReturnType<typeof app>, payload: object) => server.inject({ method: 'POST', url: '/api/leads/contact', payload });

test('Kontakt per Link: ein Profilabruf über den Account des Besitzers, 1. Grad → Vernetzt, Erstnachricht im Stapel', async (t) => {
  // Nicks Account muss bei Unipile verbunden sein – sonst pausiert sein Stapel (17.10.).
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const profiles = () => unipile.requests.filter((request) => request.method === 'GET' && request.path.startsWith('/api/v1/users/ACoTEST'));

  const response = await add(server, { profile: 'https://www.linkedin.com/in/ACoTEST101/?originalSubdomain=de', owner: 'nick' });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as AddContactResponse;
  assert.equal(body.created, true);
  assert.equal(body.message, 'Vorname101 Nachname101 ist jetzt unter „Vernetzt“.');
  assert.equal(body.importedMessages, 0, 'kein Chat vorhanden');
  const { lead } = body;
  assert.deepEqual(
    [lead.stage, lead.owner, lead.origin.kind, lead.assessment, lead.person.providerId, lead.person.publicIdentifier, lead.person.networkDistance],
    ['connected', 'nick', 'contact', null, 'ACoTEST101', 'person-101', 1],
  );
  assert.deepEqual([lead.person.position, lead.person.location, lead.person.profileUrl], ['Geschäftsführer', 'Hamburg', 'https://www.linkedin.com/in/person-101']);
  assert.ok(lead.company.name.length > 0 && lead.company.name !== 'Alte Firma', 'aktuelle Firma');
  assert.equal(profiles().length, 1, 'genau ein Profilabruf');
  assert.deepEqual([profiles()[0].path, profiles()[0].query.get('account_id'), profiles()[0].query.get('notify')], ['/api/v1/users/ACoTEST101', 'acc_nick', 'false']);
  assert.equal(unipile.requests.filter((request) => request.method === 'POST').length, 0, 'nichts gesendet');

  const detail = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.deepEqual(
    detail.events.map((event) => [event.kind, event.title]),
    [['created', 'Persönlicher Kontakt – per LinkedIn-Link aufgenommen · Vernetzt']],
  );

  const tasks = (await server.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse;
  assert.ok(tasks.tasks.some((task) => task.type === 'first' && task.lead.id === lead.id), 'Erstnachricht fällig');

  // Derselbe Link noch einmal (andere Schreibweise): vorhandener Lead, kein neuer Profilabruf.
  const again = await add(server, { profile: 'linkedin.com/in/Person-101', owner: 'nick' });
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual([again.json().created, again.json().lead.id], [false, lead.id]);
  assert.match(again.json().message, /gibt es schon – unter „Vernetzt“ bei Nick/);
  assert.equal(profiles().length, 1);

  // Offene Anfrage → „Anfrage gesendet“; kein Kontakt → „Neu“ mit Hinweis.
  const pending = (await add(server, { profile: 'ACoTEST7', owner: 'nick' })).json() as AddContactResponse;
  assert.equal(pending.lead.stage, 'invited');
  const stranger = (await add(server, { profile: 'ACoTEST5', owner: 'nick' })).json() as AddContactResponse;
  assert.equal(stranger.lead.stage, 'new');
  assert.match(stranger.message, /noch nicht vernetzt/);
});

test('Kontakt per Link: bestehender LinkedIn-Chat wird übernommen, neue Antworten erkennt der Abgleich', async (t) => {
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const day = 24 * 60 * 60 * 1000;
  const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
  unipile.linkedin.attendeeChats.ACoTEST102 = [
    { id: 'chat-alt', account_id: 'acc_nick', timestamp: iso(30 * day) },
    { id: 'chat-102', account_id: 'acc_nick', timestamp: iso(day) },
    { id: 'chat-fremd', account_id: 'acc_other', timestamp: iso(0) },
  ];
  unipile.linkedin.messages['chat-102'] = [
    { id: 'm3', text: 'Gern, Donnerstag passt?', is_sender: 0, timestamp: iso(day), sender_id: 'ACoTEST102' },
    { id: 'm1', text: 'Hi, schön dich zu sehen!', is_sender: 1, timestamp: iso(3 * day), sender_id: 'me' },
    { id: 'm2', text: 'Danke, dir auch.', is_sender: 0, timestamp: iso(2 * day), sender_id: 'ACoTEST102' },
  ];
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });

  const response = await add(server, { profile: 'ACoTEST102', owner: 'nick' });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as AddContactResponse;
  assert.equal(body.importedMessages, 3);
  assert.match(body.message, /3 Nachrichten aus dem LinkedIn-Chat übernommen/);
  assert.deepEqual([body.lead.stage, body.lead.linkedin?.chatId], ['replied', 'chat-102'], 'letzte Nachricht vom Kontakt → du bist dran');
  const chatsQuery = unipile.requests.find((request) => request.path === '/api/v1/chat_attendees/ACoTEST102/chats');
  assert.equal(chatsQuery?.query.get('account_id'), 'acc_nick');

  const detail = (await server.inject({ method: 'GET', url: `/api/leads/${body.lead.id}` })).json() as LeadDetailResponse;
  assert.deepEqual(
    detail.events.filter((event) => event.kind.startsWith('message')).map((event) => [event.kind, event.text]),
    [
      ['message_sent', 'Hi, schön dich zu sehen!'],
      ['message_received', 'Danke, dir auch.'],
      ['message_received', 'Gern, Donnerstag passt?'],
    ],
  );

  // Abgleich: übernommene Nachrichten nicht doppelt, eine neue Antwort schon.
  unipile.linkedin.messages['chat-102'].push({ id: 'm4', text: 'Und 10 Uhr?', is_sender: 0, timestamp: iso(0), sender_id: 'ACoTEST102' });
  const sync = await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  assert.equal(sync.statusCode, 200, sync.body);
  const after = (await server.inject({ method: 'GET', url: `/api/leads/${body.lead.id}` })).json() as LeadDetailResponse;
  assert.deepEqual(after.events.filter((event) => event.kind === 'message_received').map((event) => event.text), ['Danke, dir auch.', 'Gern, Donnerstag passt?', 'Und 10 Uhr?']);
});

test('Kontakt per Link: Fehler verständlich, nichts angelegt', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });

  const bad = await add(server, { profile: 'https://example.com/anna', owner: 'nick' });
  assert.deepEqual([bad.statusCode, bad.json().error.code], [400, 'invalid_request']);

  // Für Johannes ist kein Account gewählt.
  const noAccount = await add(server, { profile: 'ACoTEST101', owner: 'johannes' });
  assert.deepEqual([noAccount.statusCode, noAccount.json().error.code], [409, 'linkedin_no_account']);

  // Unbekanntes Profil (Unipile 404).
  const missing = await add(server, { profile: 'gibt-es-nicht', owner: 'nick' });
  assert.deepEqual([missing.statusCode, missing.json().error.code], [409, 'linkedin_rejected']);
  assert.match(missing.json().error.message, /findet LinkedIn nicht/);

  // Ohne Unipile-Zugang.
  const off = await add(app({ LEAD_SEARCH_MODE: 'live', UNIPILE_ACCOUNT_NICK: 'acc_nick' }), { profile: 'ACoTEST101', owner: 'nick' });
  assert.deepEqual([off.statusCode, off.json().error.code], [409, 'linkedin_off']);

  const list = (await server.inject({ method: 'GET', url: '/api/leads' })).json();
  assert.equal(list.total, 0);
});

test('Kontakt per Link in der Simulation: Name aus dem Link, 1. Grad', async () => {
  const server = app();
  const response = await add(server, { profile: 'https://de.linkedin.com/in/anna-berg-4a1b2c', owner: 'johannes' });
  assert.equal(response.statusCode, 201, response.body);
  const { lead } = response.json() as AddContactResponse;
  assert.deepEqual([lead.person.firstName, lead.person.lastName, lead.stage, lead.owner], ['Anna', 'Berg', 'replied', 'johannes']);
  assert.equal(response.json().importedMessages, 2);
});
