import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse, LeadDetailResponse } from '../../shared/leads.js';
import type {
  LinkedInAuditStatus,
  LinkedInInviteStatsResponse,
  LinkedInNewContactsResponse,
  LinkedInStatusResponse,
} from '../../shared/linkedin.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { AdapterError } from '../src/pipeline/adapter.js';
import { MOCK_LEADS } from '../src/adapters/mock/mockData.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { dueSlotRandom, effectiveClock, nextRunAtRandom, randomOffsetMinutes, shiftClock } from '../src/autoSearch/time.js';
import { startFakeUnipile } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

/**
 * Teammeeting 05.11. (Vertrag shared/linkedin.ts → Anfragen von Hand …): Anfragen über den Tag verteilt, „nur von
 * Hand“, Anfragen von Hand erkennen und neue Kontakte übernehmen, Überprüfung, Statistik, zufälliger Start der Suche.
 */

const LIVE: NodeJS.ProcessEnv = {
  LEAD_SEARCH_MODE: 'live',
  UNIPILE_API_KEY: 'unipile-test-key',
  LINKEDIN_ACTIONS: 'on',
  UNIPILE_ACCOUNT_NICK: 'acc_nick',
  UNIPILE_ACCOUNT_JOHANNES: 'acc_johannes',
  LINKEDIN_PAUSE_SECONDS: '0-0',
  LINKEDIN_WORK_HOURS: '0-24',
  LINKEDIN_WORK_DAYS: '1-7',
  ANTHROPIC_API_KEY: 'test-key',
};

function app(env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  return buildApp({ config: loadConfig({ ...base, ...env }), adapter: new MockAdapter(0), logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
}
type App = ReturnType<typeof app>;

const card = (i: number): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: `ACoFLOW${i}`,
  publicIdentifier: `flow-${i}`,
  profileUrl: `https://www.linkedin.com/in/flow-${i}`,
  firstName: `Vorname${i}`,
  lastName: `Nachname${i}`,
  headline: 'Geschäftsführer',
  position: 'Geschäftsführer',
  company: `Firma ${i} GmbH`,
  location: 'Hamburg',
  website: null,
  networkDistance: 2,
  category: 'kapitalanlage_vertrieb',
  confidence: 0.9,
  reason: 'Test',
  summary: 'Test',
  metaAds: null,
});

async function createLeads(server: App, cards: NewLeadCard[], owner: 'nick' | 'johannes' = 'nick'): Promise<CockpitLead[]> {
  const response = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards, owner } });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as CreateLeadsResponse).created;
}

const status = async (server: App) => (await server.inject({ method: 'GET', url: '/api/linkedin/status' })).json() as LinkedInStatusResponse;
const leadOf = async (server: App, id: string) => ((await server.inject({ method: 'GET', url: `/api/leads/${id}` })).json() as LeadDetailResponse).lead;
const inviteCalls = (unipile: Awaited<ReturnType<typeof startFakeUnipile>>) =>
  unipile.requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/users/invite').length;

test('Über den Tag verteilt (Standard): Klick plant ein, der Server sendet zur geplanten Zeit', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [first, second] = await createLeads(server, [card(1), card(2)]);

  const response = await server.inject({ method: 'POST', url: `/api/leads/${first.id}/linkedin/invite`, payload: { message: 'Hallo' } });
  assert.equal(response.statusCode, 200, response.body);
  const queued = (response.json() as LeadDetailResponse).lead;
  assert.equal(queued.stage, 'new', 'erst beim Senden „Anfrage gesendet“');
  assert.ok(queued.queuedInvite && queued.queuedInvite.at > Date.now(), 'Zeitpunkt in der Zukunft');
  assert.equal(queued.queuedInvite?.message, 'Hallo');
  assert.equal(inviteCalls(unipile), 0, 'nichts sofort gesendet');

  // Tagesstapel zeigt eingeplante Leads nicht mehr an.
  const tasks = (await server.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as { tasks: { lead: CockpitLead }[] };
  assert.ok(!tasks.tasks.some((task) => task.lead.id === first.id), 'eingeplant → nicht im Tagesstapel');

  // Zweiter Klick: mindestens 6 Minuten später eingeplant.
  const two = (await server.inject({ method: 'POST', url: `/api/leads/${second.id}/linkedin/invite`, payload: {} })).json() as LeadDetailResponse;
  assert.ok(two.lead.queuedInvite!.at - queued.queuedInvite!.at >= 6 * 60_000 - 1, 'Abstand zwischen zwei Anfragen');
  const st = await status(server);
  assert.equal(st.accounts[0].inviteMode, 'spread');
  assert.equal(st.accounts[0].queuedInvites, 2);
  assert.equal(st.accounts[0].nextQueuedAt, queued.queuedInvite!.at);

  // Zur geplanten Zeit sendet der Server – genau eine je Runde und Account.
  assert.equal(await server.linkedinService.processQueue(queued.queuedInvite!.at + 1000), 1);
  assert.equal(inviteCalls(unipile), 1);
  const sent = await leadOf(server, first.id);
  assert.equal(sent.stage, 'invited');
  assert.equal(sent.queuedInvite, null);
  const body = unipile.requests.find((request) => request.path === '/api/v1/users/invite')!.body as { message?: string };
  assert.equal(body.message, 'Hallo', 'Notiz bleibt erhalten');

  // Zurücknehmen: Plan weg, nichts gesendet.
  const cancelled = await server.inject({ method: 'DELETE', url: `/api/leads/${second.id}/linkedin/invite` });
  assert.equal(cancelled.statusCode, 200);
  assert.equal((cancelled.json() as LeadDetailResponse).lead.queuedInvite, null);
  assert.equal(await server.linkedinService.processQueue(Date.now() + 2 * 24 * 3600_000), 0);
  assert.equal(inviteCalls(unipile), 1);
});

test('Eingeplant, aber die Stufe passt nicht mehr → nicht gesendet, Notiz im Verlauf', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(3)]);
  const queued = ((await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/linkedin/invite`, payload: {} })).json() as LeadDetailResponse).lead;
  // In der Zwischenzeit von Hand als verloren markiert.
  await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'lost' } });
  await server.linkedinService.processQueue(queued.queuedInvite!.at + 1000);
  assert.equal(inviteCalls(unipile), 0);
  const after = await leadOf(server, lead.id);
  assert.equal(after.queuedInvite, null);
});

test('Nur von Hand (Testwoche): Cockpit schickt keine Anfrage, auch nicht als Ausweich-Account; Ende → wieder verteilt', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl, LINKEDIN_INVITE_MODE: 'instant' });
  const until = Date.now() + 7 * 24 * 3600_000;
  const set = await server.inject({ method: 'PUT', url: '/api/linkedin/accounts/acc_johannes/invite-mode', payload: { mode: 'manual', until } });
  assert.equal(set.statusCode, 200, set.body);
  assert.deepEqual(set.json(), { mode: 'manual', until });
  // Account ohne Gründer → 409; Ende in der Vergangenheit → 400.
  assert.equal((await server.inject({ method: 'PUT', url: '/api/linkedin/accounts/acc_other/invite-mode', payload: { mode: 'manual' } })).statusCode, 409);
  assert.equal((await server.inject({ method: 'PUT', url: '/api/linkedin/accounts/acc_nick/invite-mode', payload: { mode: 'manual', until: 1000 } })).statusCode, 400);

  const [lead] = await createLeads(server, [card(4)], 'johannes');
  const refused = await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/linkedin/invite`, payload: {} });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, 'linkedin_manual');
  assert.match(refused.json().error.message, /nur von Hand/);
  assert.equal(inviteCalls(unipile), 0);

  // Nicks Account voll → nie über Johannes ausweichen.
  await server.inject({ method: 'PUT', url: '/api/linkedin/accounts/acc_nick/limits', payload: { invitesPerDay: 0 } });
  const [nickLead] = await createLeads(server, [card(5)], 'nick');
  const full = await server.inject({ method: 'POST', url: `/api/leads/${nickLead.id}/linkedin/invite`, payload: {} });
  assert.equal(full.statusCode, 429, 'Limit statt Ausweichen auf den Account „nur von Hand“');
  assert.equal(inviteCalls(unipile), 0);

  const st = await status(server);
  const johannes = st.accounts.find((account) => account.founder === 'johannes')!;
  assert.equal(johannes.inviteMode, 'manual');
  assert.equal(johannes.manualUntil, until);
  const accounts = (await server.inject({ method: 'GET', url: '/api/linkedin/accounts' })).json() as { accounts: { id: string; inviteMode?: string }[] };
  assert.ok(Array.isArray(accounts.accounts));

  // Abgelaufen → wieder der Standard (hier „sofort“).
  assert.equal(server.linkedinService.inviteModeOf('johannes', until + 1).mode, 'instant');
});

test('Anfragen von Hand erkennen: zählen heute, angenommen → Lead mit Firmenseite und KI, Unbekannte nur wenn passend', async (t) => {
  const qualified = MOCK_LEADS.find((lead) => lead.ai.qualified && lead.ai.confidence >= 0.8 && lead.ai.category === 'kapitalanlage_vertrieb')!;
  const unqualified = MOCK_LEADS.find((lead) => !lead.ai.qualified)!;
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });

  // Erster Abgleich: die schon offenen Anfragen ohne Datum zählen nicht als „heute“.
  // Dazu eine ältere mit Datum (vor dem ersten Abgleich gesendet – von wem, ist unbekannt).
  const oldDated = { invited_user_id: 'ACoOLD2', invited_user_public_id: 'old-2', parsed_datetime: new Date(Date.now() - 20 * 24 * 3600_000).toISOString() };
  unipile.linkedin.invitationsByAccount.acc_nick = [{ invited_user_id: 'ACoOLD1', invited_user_public_id: 'old-1' }, oldDated];
  unipile.linkedin.relationsByAccount.acc_nick = [];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  let nick = (await status(server)).accounts.find((account) => account.founder === 'nick')!;
  assert.equal(nick.manualInvitesToday, 0);
  assert.ok(nick.invitesCheckedAt);

  // Nick schickt im Sales Navigator zwei Anfragen von Hand.
  unipile.linkedin.invitationsByAccount.acc_nick = [
    { invited_user_id: 'ACoOLD1', invited_user_public_id: 'old-1' },
    oldDated,
    { invited_user_id: qualified.hit.providerId, invited_user_public_id: 'qualified-person' },
    { invited_user_id: 'ACoMANUAL2', invited_user_public_id: 'manual-2' },
  ];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  nick = (await status(server)).accounts.find((account) => account.founder === 'nick')!;
  assert.equal(nick.manualInvitesToday, 2);
  assert.equal(nick.invitesSentToday?.used, 2, 'zählt für das Tageslimit');
  assert.equal(nick.invitesSentToday?.limit, 20);

  // Angenommen: die von Hand angefragte Person + ein Unbekannter, der nicht passt + einer, der passt.
  const now = Date.now();
  unipile.linkedin.relationsByAccount.acc_nick = [
    { member_id: qualified.hit.providerId, public_identifier: 'qualified-person', created_at: now },
    { member_id: unqualified.hit.providerId, public_identifier: 'stranger', created_at: now },
  ];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  await server.contactImporter.run();

  const contacts = ((await server.inject({ method: 'GET', url: '/api/linkedin/new-contacts' })).json() as LinkedInNewContactsResponse).contacts;
  const manual = contacts.find((contact) => contact.manualInvite)!;
  assert.equal(manual.status, 'imported', JSON.stringify(contacts));
  const stranger = contacts.find((contact) => !contact.manualInvite)!;
  assert.equal(stranger.status, 'rejected');
  assert.match(stranger.note ?? '', /Passt laut KI nicht/);

  const lead = await leadOf(server, manual.leadId!);
  assert.equal(lead.stage, 'connected');
  assert.deepEqual(lead.origin, { kind: 'contact', via: 'manual_invite' });
  assert.equal(lead.owner, 'nick');
  assert.ok(lead.assessment, 'KI-Einschätzung');
  assert.equal(lead.company.name, qualified.profile.companyName, 'Firma aus Profil/Firmenseite');
  const events = ((await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse).events.map((event) => event.kind);
  assert.ok(events.includes('invite_sent') && events.includes('invite_accepted'), 'Anfrage und Annahme im Verlauf');

  // Doppelt zählen gibt es nicht: der Lead zählt jetzt über den Verlauf, die Zeile ohne Lead nicht mehr.
  nick = (await status(server)).accounts.find((account) => account.founder === 'nick')!;
  assert.equal(nick.invitesSentToday?.used, 2);

  // Aussortierten doch übernehmen.
  const forced = await server.inject({ method: 'POST', url: `/api/linkedin/new-contacts/${stranger.id}/import` });
  assert.equal(forced.statusCode, 200);
  assert.equal(forced.json().status, 'imported');
  const forcedLead = await leadOf(server, forced.json().leadId);
  assert.deepEqual(forcedLead.origin, { kind: 'contact', via: 'new_connection' });

  // Statistik: 2 von Hand gesendet, 1 davon angenommen.
  const stats = (await server.inject({ method: 'GET', url: '/api/linkedin/invite-stats?days=7' })).json() as LinkedInInviteStatsResponse;
  const nickStats = stats.founders.find((founder) => founder.founder === 'nick')!;
  assert.equal(stats.days, 7);
  assert.equal(nickStats.days.length, 7);
  assert.equal(nickStats.sentManual, 2);
  assert.equal(nickStats.rateManual, 0.5);
  assert.equal(nickStats.days.at(-1)!.sentManual, 2);
  // Seit Beginn (07.11.): beim ersten Abgleich schon offene Anfragen (old-1 ohne Datum, old-2 mit Datum) zählen nicht
  // als „von Hand“ – sonst drückten alte, noch offene Anfragen die Quote.
  assert.equal(nickStats.lifetime?.sentManual, 2);
  assert.equal(nickStats.lifetime?.rateManual, 0.5);
});

test('Überprüfung: angenommene Anfrage korrigiert, Chat übernommen, ohne Nachricht gemeldet, Unbekannte übernommen', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl, LINKEDIN_INVITE_MODE: 'instant' });
  const [invited, connected, chatted] = await createLeads(server, [card(6), card(7), card(8)]);
  for (const lead of [invited, connected, chatted]) {
    assert.equal((await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/linkedin/invite`, payload: {} })).statusCode, 200);
  }
  // Zwei davon sind schon als vernetzt eingetragen (ohne Nachricht).
  for (const lead of [connected, chatted]) await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'invite_accepted' } });
  // Bei einem steht eine Nachricht nur auf LinkedIn.
  unipile.linkedin.attendeeChats[chatted.person.providerId] = [{ id: 'chat-audit', account_id: 'acc_nick', timestamp: new Date().toISOString() }];
  unipile.linkedin.messages['chat-audit'] = [{ id: 'm1', text: 'Hi, danke fürs Vernetzen!', is_sender: 1, timestamp: new Date().toISOString(), sender_id: 'acc' }];
  const qualified = MOCK_LEADS.find((lead) => lead.ai.qualified && lead.ai.confidence >= 0.8)!;
  const now = Date.now();
  unipile.linkedin.relationsByAccount.acc_nick = [
    { member_id: invited.person.providerId, public_identifier: 'flow-6', created_at: now },
    { member_id: connected.person.providerId, public_identifier: 'flow-7', created_at: now },
    { member_id: chatted.person.providerId, public_identifier: 'flow-8', created_at: now },
    { member_id: qualified.hit.providerId, public_identifier: 'unknown-1', created_at: now - 3 * 24 * 3600_000 },
    { member_id: 'ACoTOOOLD', public_identifier: 'too-old', created_at: now - 40 * 24 * 3600_000 },
  ];
  unipile.linkedin.relationsByAccount.acc_johannes = [];

  const start = await server.inject({ method: 'POST', url: '/api/linkedin/audit', payload: { days: 14 } });
  assert.equal(start.statusCode, 202, start.body);
  // Läuft schon → 200.
  assert.equal((await server.inject({ method: 'POST', url: '/api/linkedin/audit', payload: {} })).statusCode, 200);
  let state: LinkedInAuditStatus;
  for (let i = 0; i < 100; i++) {
    state = (await server.inject({ method: 'GET', url: '/api/linkedin/audit' })).json() as LinkedInAuditStatus;
    if (!state.running) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  state = (await server.inject({ method: 'GET', url: '/api/linkedin/audit' })).json() as LinkedInAuditStatus;
  assert.equal(state.running, false);
  const nick = state.founders.find((founder) => founder.founder === 'nick')!;
  assert.equal(nick.connections, 4, 'nur die letzten 14 Tage');
  assert.deepEqual(nick.fixedAccepted.map((entry) => entry.leadId), [invited.id]);
  assert.deepEqual(nick.chatImported.map((entry) => entry.leadId), [chatted.id]);
  assert.deepEqual(nick.notMessaged.map((entry) => entry.leadId).sort(), [invited.id, connected.id].sort());
  assert.equal(nick.unknown.length, 1);
  assert.equal(nick.unknown[0].status, 'imported');
  assert.equal(nick.invitesSent, 3);
  assert.equal(nick.acceptedBefore, 2);
  assert.equal(nick.acceptedAfter, 3);
  assert.equal((await leadOf(server, invited.id)).stage, 'connected');
  assert.equal((await leadOf(server, chatted.id)).stage, 'contacted');
  assert.equal(inviteCalls(unipile), 3, 'die Überprüfung sendet nie');
  // Live höchstens einmal pro Stunde.
  const again = await server.inject({ method: 'POST', url: '/api/linkedin/audit', payload: {} });
  assert.equal(again.statusCode, 429);
  assert.match(again.json().error.message, /höchstens einmal pro Stunde/);
});

test('Simulation: Status, Überprüfung und Statistik funktionieren ohne Unipile', async () => {
  const server = app();
  const st = await status(server);
  assert.equal(st.accounts[0].inviteMode, 'spread');
  assert.equal(st.accounts[0].queuedInvites, 0);
  assert.equal(st.accounts[0].manualInvitesToday, 0);
  const start = await server.inject({ method: 'POST', url: '/api/linkedin/audit', payload: {} });
  assert.equal(start.statusCode, 202);
  let state: LinkedInAuditStatus = start.json();
  for (let i = 0; i < 100 && state.running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = (await server.inject({ method: 'GET', url: '/api/linkedin/audit' })).json() as LinkedInAuditStatus;
  }
  assert.equal(state.founders.length, 2);
  assert.ok(state.founders[0].unknown.some((contact) => contact.name === 'Mara Beispiel' && contact.status === 'imported'));
  const stats = (await server.inject({ method: 'GET', url: '/api/linkedin/invite-stats' })).json() as LinkedInInviteStatsResponse;
  assert.equal(stats.days, 14);
  assert.equal(stats.founders.length, 2);
});

test('Zufälliger Start der automatischen Suche: fest je Tag, im Fenster, nextRunAt zeigt den echten Start', () => {
  assert.equal(shiftClock('06:30', 0), '06:30');
  assert.equal(shiftClock('06:30', 90), '08:00');
  assert.equal(shiftClock('23:30', 90), '23:59', 'nie über Mitternacht');
  const offsets = new Set<number>();
  for (let day = 1; day <= 28; day++) {
    const offset = randomOffsetMinutes(`2026-11-${String(day).padStart(2, '0')}`, '06:30', 'nick', 90);
    assert.ok(offset >= 0 && offset <= 90);
    offsets.add(offset);
  }
  assert.ok(offsets.size > 10, 'jeden Tag eine andere Zeit');
  assert.equal(randomOffsetMinutes('2026-11-05', '06:30', 'nick', 90), randomOffsetMinutes('2026-11-05', '06:30', 'nick', 90), 'stabil');

  const timeZone = 'Europe/Berlin';
  const now = Date.UTC(2026, 10, 5, 4, 0); // Do 05.11., 5:00 Uhr in Berlin
  const next = nextRunAtRandom(now, [1, 2, 3, 4, 5], ['06:30'], timeZone, 'nick', 90)!;
  const clock = effectiveClock('2026-11-05', '06:30', 'nick', 90);
  const [hour, minute] = clock.split(':').map(Number);
  assert.equal(next, Date.UTC(2026, 10, 5, hour - 1, minute), `heute um ${clock}`);
  assert.equal(dueSlotRandom(next, [1, 2, 3, 4, 5], ['06:30'], timeZone, 'nick', 90), '2026-11-05 06:30', 'Kennung bleibt die eingestellte Uhrzeit');
  assert.equal(dueSlotRandom(next + 60_000, [1, 2, 3, 4, 5], ['06:30'], timeZone, 'nick', 90), null);
  // Ohne Zufall wie bisher.
  assert.equal(nextRunAtRandom(now, [4], ['06:30'], timeZone, 'nick', 0), Date.UTC(2026, 10, 5, 5, 30));
});

test('Zufälliger Start über die API speichern und prüfen', async () => {
  const server = app();
  const list = (await server.inject({ method: 'GET', url: '/api/auto-search' })).json() as { schedules: { founder: string; profile: unknown; randomMinutes?: number }[] };
  const nick = list.schedules.find((schedule) => schedule.founder === 'nick')!;
  assert.equal(nick.randomMinutes, 0);
  const body = { enabled: true, days: [1, 2, 3, 4, 5], time: '06:30', profile: nick.profile, randomMinutes: 90 };
  const saved = await server.inject({ method: 'PUT', url: '/api/auto-search/nick', payload: body });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().randomMinutes, 90);
  const bad = await server.inject({ method: 'PUT', url: '/api/auto-search/nick', payload: { ...body, randomMinutes: 500 } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.field, 'randomMinutes');
  // Fehlt das Feld, bleibt der gespeicherte Wert.
  const kept = await server.inject({ method: 'PUT', url: '/api/auto-search/nick', payload: { ...body, randomMinutes: undefined } });
  assert.equal(kept.json().randomMinutes, 90);
});

test('Von Hand an einen Lead im Cockpit angefragt (anderer Gründer): Stufe „Anfrage gesendet“ über dessen Account, Annahme erkannt', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(9)], 'nick');
  unipile.linkedin.invitationsByAccount.acc_nick = [];
  unipile.linkedin.invitationsByAccount.acc_johannes = [];
  unipile.linkedin.relationsByAccount.acc_nick = [];
  unipile.linkedin.relationsByAccount.acc_johannes = [];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  // Johannes schickt die Anfrage im Sales Navigator.
  unipile.linkedin.invitationsByAccount.acc_johannes = [{ invited_user_id: lead.person.providerId, invited_user_public_id: 'flow-9' }];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  let current = await leadOf(server, lead.id);
  assert.equal(current.stage, 'invited');
  assert.equal(current.linkedin?.sentBy, 'johannes');
  assert.equal(current.owner, 'nick', 'Besitzer bleibt');
  unipile.linkedin.relationsByAccount.acc_johannes = [{ member_id: lead.person.providerId, public_identifier: 'flow-9', created_at: Date.now() }];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  current = await leadOf(server, lead.id);
  assert.equal(current.stage, 'connected');
  const stats = (await server.inject({ method: 'GET', url: '/api/linkedin/invite-stats?days=1' })).json() as LinkedInInviteStatsResponse;
  const johannes = stats.founders.find((founder) => founder.founder === 'johannes')!;
  assert.equal(johannes.sentManual, 1);
  assert.equal(johannes.rateManual, 1);
  // Tageszeile passt zur Quote (07.11.): „davon angenommen“ summiert sich zu acceptedOfSent.
  assert.equal(johannes.days.reduce((sum, day) => sum + (day.acceptedOfDay ?? 0), 0), johannes.acceptedOfSent);
  // Seit Beginn: mindestens so viel wie im Zeitraum.
  assert.ok(johannes.lifetime);
  assert.ok(johannes.lifetime.sent >= johannes.sent);
  assert.equal(johannes.lifetime.sentManual, 1);
  assert.equal(johannes.lifetime.rateManual, 1);
});

test('Nur von Hand (05.11.): keine Vernetzen-Karten für diesen Gründer, neue Leads der Verteilung gehen an den anderen', async () => {
  const server = app({ LEAD_DISTRIBUTION: 'balanced' });
  await createLeads(server, [card(20), card(21)], 'johannes');
  const tasks = async (owner: string) => (await server.inject({ method: 'GET', url: `/api/tasks?owner=${owner}` })).json() as { counts: { lead: number }; tasks: { type: string; lead: CockpitLead }[] };
  assert.ok((await tasks('johannes')).counts.lead >= 2, 'vorher: Karten „Neuer Lead“');

  const set = await server.inject({ method: 'PUT', url: '/api/linkedin/accounts/mock-johannes/invite-mode', payload: { mode: 'manual', until: Date.now() + 7 * 24 * 3600_000 } });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal((await tasks('johannes')).counts.lead, 0, 'Johannes bekommt keine Vernetzen-Karten');
  // Unter „Alle“ höchstens auf freien Plätzen von Nick – nie als Karte für Johannes.
  const all = await tasks('all');
  assert.ok(!all.tasks.some((task) => task.type === 'lead' && task.lead.owner === 'johannes' && !/Platz von/.test((task as { reason?: string }).reason ?? '')));

  // Verteilung: alle neuen Leads an Nick.
  const created = await createLeads(server, [card(22), card(23), card(24), card(25)], 'johannes');
  assert.ok(created.every((lead) => lead.owner === 'nick'), created.map((lead) => lead.owner).join(','));
});

test('06.11.: Liste „wer hat angenommen“, Dashboard zählt Anfragen von Hand mit, Pause wegen Zugang endet von selbst', async (t) => {
  const qualified = MOCK_LEADS.find((lead) => lead.ai.qualified && lead.ai.confidence >= 0.8 && lead.ai.category === 'kapitalanlage_vertrieb')!;
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  unipile.linkedin.invitationsByAccount.acc_nick = [];
  unipile.linkedin.invitationsByAccount.acc_johannes = [];
  unipile.linkedin.relationsByAccount.acc_nick = [];
  unipile.linkedin.relationsByAccount.acc_johannes = [];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  const before = (await server.inject({ method: 'GET', url: '/api/dashboard' })).json() as { days: Record<string, { requests: number; accepted: number }[]> };
  const requestsBefore = before.days.nick.reduce((sum, day) => sum + day.requests, 0);

  unipile.linkedin.invitationsByAccount.acc_nick = [
    { invited_user_id: qualified.hit.providerId, invited_user_public_id: 'hand-1' },
    { invited_user_id: 'ACoHAND2', invited_user_public_id: 'hand-2' },
  ];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  unipile.linkedin.relationsByAccount.acc_nick = [{ member_id: qualified.hit.providerId, public_identifier: 'hand-1', created_at: Date.now() }];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  await server.contactImporter.run();

  // Liste: einer angenommen (im Cockpit), einer offen.
  const list = (await server.inject({ method: 'GET', url: '/api/linkedin/manual-invites?days=7' })).json() as { invites: { acceptedAt: number | null; leadId: string | null }[] };
  assert.equal(list.invites.length, 2);
  assert.equal(list.invites.filter((invite) => invite.acceptedAt !== null).length, 1);
  assert.ok(list.invites.some((invite) => invite.acceptedAt !== null && invite.leadId));

  // Dashboard: beide Anfragen gezählt (die angenommene über den Lead, die offene über die Liste), eine Annahme.
  const after = (await server.inject({ method: 'GET', url: '/api/dashboard' })).json() as { days: Record<string, { requests: number; accepted: number }[]> };
  assert.equal(after.days.nick.reduce((sum, day) => sum + day.requests, 0) - requestsBefore, 2);

  // Pause wegen abgelehntem Zugang: endet, sobald der Abgleich über den Account wieder geht.
  // Pause wie nach einem 401 beim Senden, dann Abgleich.
  server.linkedinService.guard.setPause('nick', Date.now() + 6 * 3600_000, 'Unipile lehnt den Zugang ab (API-Key, Berechtigung oder LinkedIn-Account getrennt).');
  assert.ok((await status(server)).accounts[0].pausedUntil);
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  assert.equal((await status(server)).accounts[0].pausedUntil, null, 'Pause aufgehoben');
  // Limit-Pause bleibt.
  server.linkedinService.guard.setPause('nick', Date.now() + 6 * 3600_000, 'LinkedIn meldet ein Limit.');
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  assert.ok((await status(server)).accounts[0].pausedUntil, 'Limit-Pause bleibt');
});

test('06.11.: liegen gebliebene neue Kontakte werden beim nächsten Abgleich erneut übernommen', async (t) => {
  const qualified = MOCK_LEADS.find((lead) => lead.ai.qualified && lead.ai.confidence >= 0.8 && lead.ai.category === 'kapitalanlage_vertrieb')!;
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  unipile.linkedin.invitationsByAccount.acc_nick = [];
  unipile.linkedin.relationsByAccount.acc_nick = [];
  unipile.linkedin.relationsByAccount.acc_johannes = [];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  unipile.linkedin.invitationsByAccount.acc_nick = [{ invited_user_id: qualified.hit.providerId, invited_user_public_id: 'hand-3' }];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  // Annahme kommt an, aber gerade läuft „eine Suche“ → Übernahme wartet.
  let busy = true;
  const original = server.contactImporter.run.bind(server.contactImporter);
  server.contactImporter.run = () => (busy ? Promise.resolve(0) : original());
  unipile.linkedin.relationsByAccount.acc_nick = [{ member_id: qualified.hit.providerId, public_identifier: 'hand-3', created_at: Date.now() }];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  let contacts = ((await server.inject({ method: 'GET', url: '/api/linkedin/new-contacts' })).json() as LinkedInNewContactsResponse).contacts;
  assert.equal(contacts[0].status, 'pending');
  // Nächster Abgleich ohne neuen Kontakt: jetzt übernommen.
  busy = false;
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  contacts = ((await server.inject({ method: 'GET', url: '/api/linkedin/new-contacts' })).json() as LinkedInNewContactsResponse).contacts;
  assert.equal(contacts[0].status, 'imported');
});

test('„Manuell vernetzt“ (09.11.): eingetragene Anfrage zählt als von Hand – auch nach dem Abgleich', async (t) => {
  const unipile = await startFakeUnipile({ accounts: [{ object: 'Account', type: 'LINKEDIN', id: 'acc_nick', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] }] });
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(30)]);
  const logged = await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'invite_sent', manual: true } });
  assert.equal(logged.statusCode, 200, logged.body);
  const events = (logged.json() as LeadDetailResponse).events;
  assert.equal(events.at(-1)!.title, 'Vernetzungsanfrage gesendet · von Hand auf LinkedIn');
  assert.equal(unipile.requests.filter((request) => request.path === '/api/v1/users/invite').length, 0, 'nichts über LinkedIn gesendet');
  // Der Abgleich sieht die Anfrage auf LinkedIn – sie bleibt „von Hand“.
  unipile.linkedin.invitationsByAccount.acc_nick = [{ invited_user_id: lead.person.providerId, invited_user_public_id: lead.person.publicIdentifier! }];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  const stats = (await server.inject({ method: 'GET', url: '/api/linkedin/invite-stats?days=1' })).json() as LinkedInInviteStatsResponse;
  const nick = stats.founders.find((founder) => founder.founder === 'nick')!;
  assert.equal(nick.sent, 1);
  assert.equal(nick.sentManual, 1);
  assert.equal(nick.lifetime?.sentManual, 1);
});

test('Neue Kontakte (Bericht 09.11.): scheitert die KI, liest der nächste Versuch LinkedIn nicht noch einmal', async (t) => {
  const qualified = MOCK_LEADS.find((lead) => lead.ai.qualified && lead.ai.confidence >= 0.8 && lead.ai.category === 'kapitalanlage_vertrieb')!;
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const adapter = new MockAdapter(0);
  let enriched = 0;
  let aiDown = true;
  const enrich = adapter.enrich.bind(adapter);
  adapter.enrich = (...args) => {
    enriched++;
    return enrich(...args);
  };
  const qualify = adapter.qualify.bind(adapter);
  adapter.qualify = (...args) => {
    if (aiDown) return Promise.reject(new AdapterError('auth', 'Anthropic-Guthaben aufgebraucht', 'Lade Guthaben auf.', true));
    return qualify(...args);
  };
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  const server = buildApp({ config: loadConfig({ ...base, ...LIVE, UNIPILE_DSN: unipile.baseUrl }), adapter, logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
  unipile.linkedin.invitationsByAccount.acc_nick = [];
  unipile.linkedin.relationsByAccount.acc_nick = [];
  unipile.linkedin.relationsByAccount.acc_johannes = [];
  await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  // Neuer Kontakt ohne gesehene Anfrage → Profil lesen, dann KI (fällt aus).
  unipile.linkedin.relationsByAccount.acc_nick = [{ member_id: qualified.hit.providerId, public_identifier: 'neu-1', created_at: Date.now() }];
  const contacts = async () => ((await server.inject({ method: 'GET', url: '/api/linkedin/new-contacts' })).json() as LinkedInNewContactsResponse).contacts;
  for (let round = 0; round < 3; round++) {
    await server.contactImporter.run();
    if (round === 0) await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
  }
  assert.equal((await contacts())[0]?.status, 'pending', 'wartet weiter');
  assert.equal(enriched, 1, 'Profil nur einmal abgerufen, trotz mehrerer Versuche');
  // KI wieder da → übernommen, ohne neuen Abruf.
  aiDown = false;
  await server.contactImporter.run();
  assert.equal((await contacts())[0].status, 'imported');
  assert.equal(enriched, 1);
});

test('Neue Kontakte (10.11.): Tageslimit erreicht → ein Versuch je Abgleich, danach Ruhe; Job zählt als gescheitert', async (t) => {
  const qualified = MOCK_LEADS.find((lead) => lead.ai.qualified && lead.ai.confidence >= 0.8 && lead.ai.category === 'kapitalanlage_vertrieb')!;
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const adapter = new MockAdapter(0);
  let attempts = 0;
  let limit = true;
  const enrich = adapter.enrich.bind(adapter);
  adapter.enrich = (...args) => {
    attempts++;
    if (limit) return Promise.reject(new AdapterError('rate_limit', 'Tageslimit für Firmenseiten erreicht', 'Morgen geht es weiter.', true));
    return enrich(...args);
  };
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  const server = buildApp({ config: loadConfig({ ...base, ...LIVE, UNIPILE_DSN: unipile.baseUrl }), adapter, logger: false, requireSession: false, linkedinTest: { minPauseMs: 0 } });
  unipile.linkedin.invitationsByAccount.acc_nick = [];
  unipile.linkedin.relationsByAccount.acc_nick = [];
  unipile.linkedin.relationsByAccount.acc_johannes = [];
  const sync = async () => {
    await server.inject({ method: 'POST', url: '/api/linkedin/sync' });
    // Die Übernahme läuft nach dem Abgleich im Hintergrund.
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  await sync();
  unipile.linkedin.relationsByAccount.acc_nick = [{ member_id: qualified.hit.providerId, public_identifier: 'neu-limit', created_at: Date.now() }];
  // Erster Abgleich: genau ein Versuch – vorher stieß derselbe Abgleich die Übernahme zweimal an.
  await sync();
  assert.equal(attempts, 1, 'ein Versuch je Abgleich');
  assert.equal(server.contactImporter.resting(), true);
  // Weitere Abgleiche (im Betrieb alle 3 Minuten): die Übernahme ruht, statt jedes Mal ins Leere zu laufen.
  await sync();
  await sync();
  assert.equal(attempts, 1, 'kein neuer Versuch während der Ruhe');
  const contacts = async () => ((await server.inject({ method: 'GET', url: '/api/linkedin/new-contacts' })).json() as LinkedInNewContactsResponse).contacts;
  assert.equal((await contacts())[0].status, 'pending', 'wartet weiter, zählt nicht als Fehlversuch');
  const report = (await server.inject({ method: 'GET', url: '/api/telemetry/report?days=1' })).body;
  assert.match(report, /\| neue_kontakte \| 1 \| 1 \|[^\n]*Tageslimit für Firmenseiten erreicht \|/, 'ein Lauf, als gescheitert gezählt');
  // Von Hand (Überprüfung, „doch übernehmen“) geht es jederzeit – und nach einem sauberen Lauf ist die Ruhe vorbei.
  limit = false;
  await server.contactImporter.run();
  assert.equal(attempts, 2);
  assert.equal((await contacts())[0].status, 'imported');
  assert.equal(server.contactImporter.resting(), false);
  assert.equal(server.contactImporter.lastFailure, null);
});

test('Neuer Kontakt ohne Unterhaltung (10.11.): 404 von Unipile ist kein Fehler – nichts übernommen, keine Warnung', async (t) => {
  const unipile = await startFakeUnipile();
  t.after(() => unipile.close());
  const server = app({ ...LIVE, UNIPILE_DSN: unipile.baseUrl });
  const [lead] = await createLeads(server, [card(40)]);
  await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'invite_sent', manual: true } });
  await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'invite_accepted' } });
  unipile.linkedin.unknownAttendees.push(lead.person.providerId);
  const result = await server.linkedinService.importContactChat(lead.id);
  assert.equal(result?.imported, 0, 'kein Chat → 0 übernommen, aber kein Abbruch (null)');
  const logs = ((await server.inject({ method: 'GET', url: '/api/telemetry/logs?hours=1' })).json() as { logs: { msg: string }[] }).logs;
  assert.equal(logs.filter((row) => row.msg.includes('Chat des Kontakts')).length, 0);
});
