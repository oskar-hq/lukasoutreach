import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_SEARCH_ACTOR } from '../../shared/autoSearch.js';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { CockpitLead, ConversationListResponse, CreateLeadsResponse, LeadStage } from '../../shared/leads.js';
import type { LeadScore } from '../../shared/scoring.js';
import type { TasksResponse } from '../../shared/tasks.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { LeadStore } from '../src/leads/leadStore.js';
import { computeTasks, type TaskRules } from '../src/tasks/dailyTasks.js';
import { mockApp, tempDataDir } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 3, 12);
const RULES: TaskRules = { followUpAfterDays: 2, maxFollowUps: 3, newLeadsPerDay: 20, inviteStaleDays: 14, inviteNote: true };

let counter = 0;
function lead(stage: LeadStage, overrides: Partial<CockpitLead> = {}): CockpitLead {
  counter++;
  return {
    id: `lead-${String(counter).padStart(3, '0')}`,
    owner: 'nick',
    stage,
    person: { firstName: 'Max', lastName: `Muster${counter}`, headline: '', position: 'GF', location: null, providerId: `P${counter}`, publicIdentifier: null, profileUrl: null, networkDistance: 2 },
    company: { name: 'Muster GmbH', website: null, industry: null, region: null },
    assessment: null,
    metaAds: null,
    origin: { kind: 'demo' },
    template: null,
    followUpsSent: 0,
    nextStep: null,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW,
    lastContactAt: null,
    lastReplyAt: null,
    lastActivityAt: NOW - DAY,
    ...overrides,
  };
}

function score(total: number, tier: LeadScore['tier']): LeadScore {
  return {
    version: 'v1',
    total,
    tier,
    icp: { score: total, tier, components: [] },
    hardFilters: [],
    ads: { status: 'none_found', confidence: 0.7, opportunity: 0.8, detail: '' },
    leadType: 'greenfield',
    completeness: 1,
    scoredAt: NOW,
  };
}

test('Regeln: Antwort, fälliges Follow-up, Erstnachricht, neuer Lead – Reihenfolge reply → followup → first → lead', () => {
  const leads = [
    lead('new', { score: score(0.8, 'high') }),
    lead('connected', { lastActivityAt: NOW - 3 * DAY }),
    lead('contacted', { lastContactAt: NOW - 3 * DAY, followUpsSent: 1 }),
    lead('contacted', { lastContactAt: NOW - DAY }), // noch nicht fällig
    lead('replied', { lastReplyAt: NOW - 2 * 60 * 60 * 1000 }),
    lead('handed_over'),
    lead('lost'),
  ];
  const result = computeTasks(leads, 'nick', RULES, NOW);
  assert.deepEqual(result.tasks.map((task) => task.type), ['reply', 'followup', 'first', 'lead']);
  assert.deepEqual(result.counts, { reply: 1, followup: 1, first: 1, lead: 1 });
  const followup = result.tasks[1];
  assert.equal(followup.followUpNumber, 2);
  assert.equal(followup.reason, 'Keine Antwort seit 3 Tagen – Follow-up 2 von 3');
  assert.equal(followup.id, `${followup.lead.id}:followup:2`);
  assert.equal(result.tasks[0].reason, 'Hat heute geantwortet');
  assert.equal(result.tasks[2].reason, 'Vernetzt seit 3 Tagen – Erstnachricht fehlt');
  assert.equal(result.tasks[3].reason, 'Score Hoch · Greenfield');
  assert.deepEqual(result.rules, RULES);
});

test('Gründer-Filter und älteste zuerst', () => {
  const leads = [
    lead('replied', { owner: 'johannes', lastReplyAt: NOW - DAY }),
    lead('replied', { lastReplyAt: NOW - DAY }),
    lead('replied', { lastReplyAt: NOW - 3 * DAY }),
  ];
  const nick = computeTasks(leads, 'nick', RULES, NOW);
  assert.equal(nick.counts.reply, 2);
  assert.equal(nick.tasks[0].lead.id, leads[2].id, 'älteste Antwort zuerst');
  assert.equal(computeTasks(leads, null, RULES, NOW).counts.reply, 3);
});

test('„Braucht Aufmerksamkeit“: Anfrage zu lange offen, alle Follow-ups ohne Antwort, Termin nicht übergeben', () => {
  const leads = [
    lead('invited', { lastContactAt: NOW - 16 * DAY }),
    lead('invited', { lastContactAt: NOW - 5 * DAY }),
    lead('contacted', { lastContactAt: NOW - 4 * DAY, followUpsSent: 3 }),
    lead('meeting', { lastActivityAt: NOW - 2 * DAY }),
  ];
  const result = computeTasks(leads, 'nick', RULES, NOW);
  assert.equal(result.tasks.length, 0, 'keine davon ist eine Aufgabe im Stapel');
  assert.deepEqual(
    result.attention.map((item) => [item.reason, item.days]),
    [['invite_stale', 16], ['followups_done', 4], ['meeting_open', 2]],
  );
  assert.equal(result.attention[0].detail, 'Anfrage seit 16 Tagen offen');
});

test('neue Leads: Tageslimit je Gründer, beste nach Score, ~15 % Exploration aus der mittleren Stufe, stabil je Tag', () => {
  const leads = [
    ...Array.from({ length: 30 }, (_, i) => lead('new', { score: score(0.9 - i * 0.001, 'high') })),
    ...Array.from({ length: 10 }, (_, i) => lead('new', { score: score(0.6 - i * 0.001, 'medium') })),
    ...Array.from({ length: 5 }, () => lead('new', { owner: 'johannes', score: score(0.8, 'high') })),
  ];
  const result = computeTasks(leads, null, RULES, NOW);
  const nick = result.tasks.filter((task) => task.lead.owner === 'nick');
  assert.equal(nick.length, 20, 'Limit je Gründer');
  assert.equal(result.tasks.filter((task) => task.lead.owner === 'johannes').length, 5);
  const explored = nick.filter((task) => task.exploration);
  assert.equal(explored.length, 3, '15 % von 20');
  assert.ok(explored.every((task) => task.lead.score?.tier === 'medium'));
  assert.match(explored[0].reason, /zum Vergleich ausgewählt/);
  assert.ok(nick.filter((task) => !task.exploration).every((task) => task.lead.score?.tier === 'high'));

  const again = computeTasks(leads, null, RULES, NOW + 60_000);
  assert.deepEqual(again.tasks.map((task) => task.id), result.tasks.map((task) => task.id), 'gleicher Tag → gleiche Auswahl');

  const few = computeTasks(leads.slice(0, 5), 'nick', RULES, NOW);
  assert.equal(few.tasks.length, 5);
  assert.ok(few.tasks.every((task) => !task.exploration), 'unter dem Limit: alle, keine Exploration');
});

test('Route: Simulation liefert den Stapel aus den Demo-Leads; Aktion lässt die Aufgabe verschwinden', async () => {
  const app = mockApp();
  const result = (await app.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse;
  assert.equal(result.owner, 'nick');
  assert.ok(result.counts.reply > 0 && result.counts.first > 0 && result.counts.lead > 0);
  assert.ok(result.tasks.every((task) => task.lead.owner === 'nick'));

  const first = result.tasks.find((task) => task.type === 'first')!;
  const done = await app.inject({ method: 'POST', url: `/api/leads/${first.lead.id}/events`, payload: { action: 'message_sent', text: 'Hallo', label: 'A' } });
  assert.equal(done.statusCode, 200);
  const after = (await app.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse;
  assert.equal(after.counts.first, result.counts.first - 1);
  assert.ok(!after.tasks.some((task) => task.lead.id === first.lead.id), 'gerade angeschrieben → kein Follow-up fällig');
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks?owner=fremd' })).statusCode, 400);
});

test('Route: ohne owner gilt der angemeldete Gründer; Regeln aus der Konfiguration', async () => {
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'mock',
    DATA_DIR: tempDataDir(),
    AUTH_DEMO_ACCOUNTS: 'true',
    AUTH_COOKIE_SECURE: 'false',
    FOLLOWUP_AFTER_DAYS: '5',
    NEW_LEADS_PER_DAY: '2',
  });
  const app = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: true });
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks' })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'johannes', password: 'demo' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const result = (await app.inject({ method: 'GET', url: '/api/tasks', headers: { cookie } })).json() as TasksResponse;
  assert.equal(result.owner, 'johannes');
  assert.equal(result.rules.followUpAfterDays, 5);
  // „Meine“ (24.10.): nur die Plätze des eigenen Accounts – die des zweiten verteilt „Alle“.
  assert.equal(result.rules.newLeadsPerDay, 2);
  assert.equal(result.counts.lead, 2);
  assert.equal(result.inviteVia, 'johannes');
});

test('„Alle“ mit zweitem Account: freie Plätze des einen Gründers bekommen die übrigen neuen Leads des anderen', () => {
  const rules = { ...RULES, newLeadsPerDay: 3 };
  const nick = Array.from({ length: 8 }, (_, i) => lead('new', { owner: 'nick', score: score(0.9 - i * 0.01, 'high') }));
  const johannes = [lead('new', { owner: 'johannes', score: score(0.8, 'high') })];
  const all = [...nick, ...johannes];
  // Ohne Teilen: je Gründer höchstens 3.
  assert.equal(computeTasks(all, null, rules, NOW).counts.lead, 4);
  // Mit Teilen: Johannes hat 2 Plätze frei → 2 weitere von Nick, zusammen 3 + 3.
  const shared = computeTasks(all, null, rules, NOW, {}, undefined, {}, [], true);
  assert.equal(shared.counts.lead, 6);
  assert.equal(shared.tasks.filter((task) => task.reason.includes('Platz von Johannes')).length, 2);
  // Heute gesendete Anfragen von Johannes verbrauchen seine Plätze.
  assert.equal(computeTasks(all, null, rules, NOW, { johannes: 2 }, undefined, {}, [], true).counts.lead, 4);
  // „Meine“ teilt nie.
  assert.equal(computeTasks(all, 'nick', rules, NOW, {}, undefined, {}, [], true).counts.lead, 3);
  // Nick hat heute schon 5 eigene Leads angeschrieben (2 über seine Plätze hinaus) → Johannes' freie Plätze sind verbraucht.
  assert.equal(computeTasks(all, null, rules, NOW, { nick: 5 }, undefined, {}, [], true).counts.lead, 1);
});

test('Tageslimit: heutige Anfragen zählen mit, heute aus der Suche übergebene Leads sind immer dabei', () => {
  const rules = { ...RULES, newLeadsPerDay: 5 };
  const old = Array.from({ length: 10 }, (_, i) => lead('new', { score: score(0.9 - i * 0.01, 'high') }));
  const fresh = [0, 1].map(() => lead('new', { origin: { kind: 'search', runId: 'r', mode: 'live' }, createdAt: NOW - 60_000, score: score(0.5, 'medium') }));
  const all = [...old, ...fresh];

  assert.equal(computeTasks(all, 'nick', rules, NOW).counts.lead, 5);
  // 2 Anfragen heute → nur noch 3 Plätze, davon 2 für die frisch übergebenen.
  const result = computeTasks(all, 'nick', rules, NOW, { nick: 2 });
  assert.equal(result.counts.lead, 3);
  assert.ok(fresh.every((item) => result.tasks.some((task) => task.lead.id === item.id)));
  assert.deepEqual(result.invitesToday, { nick: 2 });
  // Limit ausgeschöpft: übergebene bleiben trotzdem drin.
  const full = computeTasks(all, 'nick', rules, NOW, { nick: 5 });
  assert.deepEqual(full.tasks.map((task) => task.lead.id).sort(), fresh.map((item) => item.id).sort());
  // Demo-Leads von heute zählen nicht als „übergeben“.
  const demoToday = lead('new', { createdAt: NOW - 60_000 });
  assert.equal(computeTasks([demoToday], 'nick', rules, NOW, { nick: 5 }).counts.lead, 0);
});

test('Übersprungene Leads fehlen im Stapel, bis die Zeit um ist', () => {
  const replied = lead('replied', { lastReplyAt: NOW - DAY, snoozedUntil: NOW + DAY });
  const fresh = lead('new', { snoozedUntil: NOW + 60_000 });
  const expired = lead('connected', { snoozedUntil: NOW - 1 });
  const result = computeTasks([replied, fresh, expired], 'nick', RULES, NOW);
  assert.deepEqual(result.tasks.map((task) => task.lead.id), [expired.id]);
  assert.equal(computeTasks([replied], 'nick', RULES, NOW + 2 * DAY).counts.reply, 1);
});

test('Route: Überspringen, clientId gegen doppelte Meldungen, heutige Anfragen im Stapel', async () => {
  const app = mockApp();
  const tasks = async () => (await app.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse;
  const before = await tasks();
  const reply = before.tasks.find((task) => task.type === 'reply')!;

  // Überspringen bis morgen → fehlt; Aufheben → wieder da.
  const snoozed = await app.inject({ method: 'POST', url: `/api/leads/${reply.lead.id}/snooze`, payload: {} });
  assert.equal(snoozed.statusCode, 200, snoozed.body);
  assert.ok(snoozed.json().lead.snoozedUntil > Date.now());
  assert.ok(!(await tasks()).tasks.some((task) => task.lead.id === reply.lead.id));
  assert.equal((await app.inject({ method: 'POST', url: `/api/leads/${reply.lead.id}/snooze`, payload: { until: Date.now() - 1 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/leads/${reply.lead.id}/snooze`, payload: { until: Date.now() + 40 * DAY } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/leads/gibt-es-nicht/snooze', payload: {} })).statusCode, 404);
  const unsnoozed = await app.inject({ method: 'DELETE', url: `/api/leads/${reply.lead.id}/snooze` });
  assert.equal(unsnoozed.json().lead.snoozedUntil, null);
  assert.ok((await tasks()).tasks.some((task) => task.lead.id === reply.lead.id));

  // Follow-up zweimal mit derselben clientId gemeldet → nur einmal gezählt.
  const followup = before.tasks.find((task) => task.type === 'followup')!;
  const payload = { action: 'message_sent', text: 'Nachgehakt', label: 'A', clientId: 'c-123' };
  const once = await app.inject({ method: 'POST', url: `/api/leads/${followup.lead.id}/events`, payload });
  const twice = await app.inject({ method: 'POST', url: `/api/leads/${followup.lead.id}/events`, payload });
  assert.equal(once.statusCode, 200);
  assert.equal(twice.statusCode, 200);
  assert.equal(once.json().duplicate, undefined);
  assert.equal(twice.json().duplicate, true);
  assert.equal(twice.json().lead.followUpsSent, followup.lead.followUpsSent + 1);
  assert.equal(twice.json().events.filter((event: { text: string | null }) => event.text === 'Nachgehakt').length, 1);
  // Ohne clientId wird jede Meldung gebucht (wie bisher).
  const other = await app.inject({ method: 'POST', url: `/api/leads/${followup.lead.id}/events`, payload: { action: 'note', text: 'x' } });
  assert.equal(other.statusCode, 200);

  // Anfrage heute → zählt gegen das Tageslimit.
  const newLead = before.tasks.find((task) => task.type === 'lead')!;
  await app.inject({ method: 'POST', url: `/api/leads/${newLead.lead.id}/events`, payload: { action: 'invite_sent' } });
  const after = await tasks();
  assert.equal(after.invitesToday?.nick, 1);
  assert.equal(after.counts.lead, before.counts.lead - 1);
});

test('„Heute“ nach Ortszeit: Tagesanfang und Mitternacht in Europe/Berlin', async () => {
  const { localDayStart, nextLocalMidnight } = await import('../src/linkedin/guard.js');
  // 06.10.2026, 00:30 Uhr in Berlin (Sommerzeit, UTC+2) = 05.10. 22:30 UTC → schon der 06.10.
  const now = Date.UTC(2026, 9, 5, 22, 30);
  assert.equal(localDayStart(now, 'Europe/Berlin'), Date.UTC(2026, 9, 5, 22, 0));
  assert.equal(nextLocalMidnight(now, 'Europe/Berlin'), Date.UTC(2026, 9, 6, 22, 0));
  // Anfrage um 00:30 Ortszeit zählt für den neuen Tag, nicht (wie mit UTC) für den alten.
  const rules = { ...RULES, newLeadsPerDay: 2 };
  const leads = [0, 1, 2].map(() => lead('new'));
  assert.equal(computeTasks(leads, 'nick', rules, now, { nick: 1 }, localDayStart(now, 'Europe/Berlin')).counts.lead, 1);
});

test('Route: neue Antwort hebt das Überspringen auf', async () => {
  const app = mockApp();
  const tasks = async () => (await app.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse;
  const followup = (await tasks()).tasks.find((task) => task.type === 'followup')!;
  await app.inject({ method: 'POST', url: `/api/leads/${followup.lead.id}/snooze`, payload: {} });
  assert.ok(!(await tasks()).tasks.some((task) => task.lead.id === followup.lead.id));
  const answered = await app.inject({ method: 'POST', url: `/api/leads/${followup.lead.id}/events`, payload: { action: 'message_received', text: 'Gern, wann?' } });
  assert.equal(answered.json().lead.snoozedUntil, null);
  assert.ok((await tasks()).tasks.some((task) => task.lead.id === followup.lead.id && task.type === 'reply'));
  // Andere Aktionen lassen das Überspringen stehen.
  const other = (await tasks()).tasks.find((task) => task.type === 'first')!;
  await app.inject({ method: 'POST', url: `/api/leads/${other.lead.id}/snooze`, payload: {} });
  const noted = await app.inject({ method: 'POST', url: `/api/leads/${other.lead.id}/events`, payload: { action: 'note', text: 'x' } });
  assert.ok(noted.json().lead.snoozedUntil > Date.now());
});

test('Antwort beantwortet: keine Antwort-Aufgabe mehr, bis die Person wieder schreibt', () => {
  const answered = lead('replied', { lastReplyAt: NOW - 2 * DAY, lastContactAt: NOW - DAY });
  const open = lead('replied', { lastReplyAt: NOW - DAY, lastContactAt: NOW - 2 * DAY });
  const result = computeTasks([answered, open], 'nick', RULES, NOW);
  assert.deepEqual(result.tasks.map((task) => task.lead.id), [open.id]);
});

test('Antwort-Aufgabe: ID je Antwort – eine zweite Antwort am selben Tag ist eine neue Aufgabe', () => {
  const first = lead('replied', { lastReplyAt: NOW - 3 * 60 * 60 * 1000 });
  const task = computeTasks([first], 'nick', RULES, NOW).tasks[0];
  assert.equal(task.id, `${first.id}:reply:${first.lastReplyAt}`);
  // Du antwortest, die Person schreibt noch am selben Tag wieder.
  const again = { ...first, lastContactAt: NOW - 2 * 60 * 60 * 1000, lastReplyAt: NOW - 60 * 60 * 1000 };
  const next = computeTasks([again], 'nick', RULES, NOW).tasks[0];
  assert.equal(next.type, 'reply');
  assert.notEqual(next.id, task.id);
});

test('Aktives Gespräch (25.10.): nach FOLLOWUP_AFTER_DAYS Ruhe wieder ein Follow-up – alle 2 Tage, ohne Höchstzahl', () => {
  const quiet = lead('replied', { lastReplyAt: NOW - 5 * DAY, lastContactAt: NOW - 3 * DAY, followUpsSent: 5 });
  const recent = lead('replied', { lastReplyAt: NOW - 2 * DAY, lastContactAt: NOW - DAY });
  // Wieder geöffnet nach einer Antwort: auch aus „Angeschrieben“, über MAX_FOLLOW_UPS hinaus.
  const reopened = lead('contacted', { lastReplyAt: NOW - 9 * DAY, lastContactAt: NOW - 2 * DAY, followUpsSent: 3 });
  const result = computeTasks([quiet, recent, reopened], 'nick', RULES, NOW);
  assert.deepEqual(
    result.tasks.map((task) => [task.lead.id, task.type, task.active]),
    [
      [quiet.id, 'followup', true],
      [reopened.id, 'followup', true],
    ],
  );
  assert.equal(result.tasks[0].id, `${quiet.id}:followup:active:${quiet.lastContactAt}`);
  assert.equal(result.tasks[0].reason, 'Aktives Gespräch – keine Antwort auf deine Nachricht seit 3 Tagen, nachfassen');
  assert.equal(result.attention.length, 0);
  // Nachgefasst: 2 Tage Ruhe, dann neue Aufgabe mit neuer ID.
  const after = { ...quiet, lastContactAt: NOW };
  assert.equal(computeTasks([after], 'nick', RULES, NOW).tasks.length, 0);
  const later = computeTasks([after], 'nick', RULES, NOW + 2 * DAY).tasks[0];
  assert.equal(later.id, `${quiet.id}:followup:active:${NOW}`);
  // Verloren: nie wieder (offene Stufen nur).
  assert.equal(computeTasks([{ ...quiet, stage: 'lost' as const }], 'nick', RULES, NOW).tasks.length, 0);
});

test('Exploration: Tageswechsel nach Ortszeit (todayStart), nicht nach UTC', () => {
  const leads = [
    ...Array.from({ length: 30 }, (_, i) => lead('new', { score: score(0.9 - i * 0.001, 'high') })),
    ...Array.from({ length: 40 }, (_, i) => lead('new', { score: score(0.6 - i * 0.001, 'medium') })),
  ];
  const explored = (now: number, todayStart: number) =>
    computeTasks(leads, 'nick', RULES, now, {}, todayStart)
      .tasks.filter((task) => task.exploration)
      .map((task) => task.id);
  // Berlin (MESZ): der Tag beginnt um 22:00 UTC des Vortags. 21:30 UTC und 23:30 UTC liegen im selben UTC-Tag, aber
  // in verschiedenen Berliner Tagen – und 23:30 UTC und 00:30 UTC (nächster UTC-Tag) im selben Berliner Tag.
  const berlinStart = Date.UTC(2026, 9, 3, 22);
  const beforeMidnight = explored(Date.UTC(2026, 9, 3, 21, 30), Date.UTC(2026, 9, 2, 22));
  const lateEvening = explored(Date.UTC(2026, 9, 3, 23, 30), berlinStart);
  const afterUtcMidnight = explored(Date.UTC(2026, 9, 4, 0, 30), berlinStart);
  assert.deepEqual(lateEvening, afterUtcMidnight, 'gleicher Berliner Tag → gleiche Auswahl');
  assert.notDeepEqual(beforeMidnight, lateEvening, 'neuer Berliner Tag → andere Auswahl');
});

test('Termin: neue Antwort nach dem Termin ist wieder eine Antwort-Aufgabe, bis du antwortest', () => {
  const booked = NOW - 2 * DAY;
  const fresh = lead('meeting', { lastContactAt: NOW - 4 * DAY, lastReplyAt: NOW - DAY, lastActivityAt: NOW - DAY });
  const old = lead('meeting', { lastContactAt: NOW - 4 * DAY, lastReplyAt: NOW - 3 * DAY, lastActivityAt: booked });
  const answered = lead('meeting', { lastContactAt: NOW - 60_000, lastReplyAt: NOW - DAY, lastActivityAt: NOW - 60_000 });
  const result = computeTasks([fresh, old, answered], 'nick', RULES, NOW, {}, undefined, { [fresh.id]: booked, [old.id]: booked, [answered.id]: booked });
  assert.deepEqual(result.tasks.map((task) => [task.lead.id, task.type]), [[fresh.id, 'reply']]);
  assert.equal(result.tasks[0].id, `${fresh.id}:reply:${fresh.lastReplyAt}`);
  // „Termin nicht übergeben“ bleibt für alle drei.
  assert.equal(result.attention.filter((item) => item.reason === 'meeting_open').length, 3);
});

test('Übergabe an Close aus (22.10.): keine Erinnerung „Termin noch nicht übergeben“, Antwort-Aufgaben bleiben', () => {
  const fresh = lead('meeting', { lastContactAt: NOW - 4 * DAY, lastReplyAt: NOW - DAY, lastActivityAt: NOW - DAY });
  const result = computeTasks([fresh], 'nick', { ...RULES, handover: false }, NOW, {}, undefined, { [fresh.id]: NOW - 2 * DAY });
  assert.deepEqual(result.tasks.map((task) => task.type), ['reply']);
  assert.equal(result.attention.length, 0);
});

const searchCard = (providerId: string): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'mock',
  providerId,
  publicIdentifier: null,
  profileUrl: null,
  firstName: 'Erika',
  lastName: providerId,
  headline: 'Geschäftsführerin',
  position: 'Geschäftsführerin',
  company: `Firma ${providerId}`,
  location: 'Köln',
  website: null,
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.88,
  reason: 'Entwickelt selbst.',
  summary: 'Bauträger.',
  metaAds: null,
});

test('Route: Antwort im Termin → Antwort-Aufgabe; Termin direkt nach der Antwort → keine', async () => {
  const app = mockApp();
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const created = (await post('/api/leads', { cards: [searchCard('ACoMEET1')], owner: 'nick' })).json() as CreateLeadsResponse;
  const id = created.created[0].id;
  for (const action of ['invite_accepted', 'message_sent', 'message_received', 'meeting_booked']) {
    assert.equal((await post(`/api/leads/${id}/events`, { action, text: action.startsWith('message') ? 'Hallo' : undefined })).statusCode, 200);
  }
  const replyFor = async () => ((await app.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse).tasks.filter((task) => task.lead.id === id);
  assert.deepEqual(await replyFor(), [], 'Termin gerade vereinbart – die Antwort davor ist erledigt');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await post(`/api/leads/${id}/events`, { action: 'message_received', text: 'Können wir verschieben?' });
  const tasks = await replyFor();
  assert.deepEqual(tasks.map((task) => [task.type, task.lead.stage]), [['reply', 'meeting']]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await post(`/api/leads/${id}/events`, { action: 'message_sent', text: 'Klar, Freitag?' });
  assert.deepEqual(await replyFor(), []);
});

test('Tageslimit: Leads der automatischen Suche zählen mit, von Hand übergebene nicht', () => {
  const rules = { ...RULES, newLeadsPerDay: 3 };
  const old = Array.from({ length: 5 }, (_, i) => lead('new', { score: score(0.9 - i * 0.01, 'high') }));
  const auto = [0, 1, 2, 3].map(() => lead('new', { origin: { kind: 'search', runId: 'a', mode: 'live', auto: true }, createdAt: NOW - 60_000, score: score(0.95, 'high') }));
  const manual = lead('new', { origin: { kind: 'search', runId: 'm', mode: 'live' }, createdAt: NOW - 60_000, score: score(0.5, 'medium') });
  const result = computeTasks([...old, ...auto, manual], 'nick', rules, NOW);
  // Von Hand übergeben: immer dabei; dazu 2 Plätze für die besten übrigen (hier die automatischen mit höherem Score).
  assert.equal(result.counts.lead, 3);
  assert.ok(result.tasks.some((task) => task.lead.id === manual.id));
  assert.equal(result.tasks.filter((task) => task.lead.origin.kind === 'search' && task.lead.origin.auto).length, 2);
  // Limit ausgeschöpft: keine automatischen mehr, die von Hand übergebenen bleiben.
  assert.deepEqual(computeTasks([...auto, manual], 'nick', rules, NOW, { nick: 3 }).tasks.map((task) => task.lead.id), [manual.id]);
});

test('Automatische Suche markiert ihre Leads (origin.auto), die Übergabe von Hand nicht', () => {
  const store = new LeadStore(openDatabase(tempDataDir()));
  const auto = store.createFromCards([searchCard('ACoAUTO1')], 'nick', NOW, AUTO_SEARCH_ACTOR).created[0];
  const manual = store.createFromCards([searchCard('ACoHAND1')], 'nick', NOW, 'Nick').created[0];
  assert.deepEqual(store.get(auto.id)?.origin, { kind: 'search', runId: '11111111-1111-4111-8111-111111111111', mode: 'mock', auto: true });
  assert.deepEqual(store.get(manual.id)?.origin, { kind: 'search', runId: '11111111-1111-4111-8111-111111111111', mode: 'mock' });
});

test('Chats je Gründer in SQL; Index für Ereignisse nach Art und Zeit (Migration 24)', async () => {
  const app = mockApp();
  const list = async (query = '') => ((await app.inject({ method: 'GET', url: `/api/conversations${query}` })).json() as ConversationListResponse).conversations;
  const all = await list();
  const nick = await list('?owner=nick');
  assert.ok(nick.length > 0 && nick.length < all.length);
  assert.ok(nick.every((item) => item.lead.owner === 'nick'));
  assert.deepEqual(
    nick.map((item) => item.lead.id),
    all.filter((item) => item.lead.owner === 'nick').map((item) => item.lead.id),
  );
  assert.ok(nick.every((item) => item.messageCount > 0 && typeof item.lastMessage.at === 'number'));

  const db = openDatabase(tempDataDir());
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lead_events'").all() as { name: string }[]).map((row) => row.name);
  assert.ok(indexes.includes('lead_events_kind_at'));
  assert.ok(indexes.includes('lead_events_lead'));
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 24, true);
});

test('Leads aus einer Suche von Hand von gestern haben Vorrang vor automatisch gefundenen (25.10.)', () => {
  const yesterday = NOW - DAY;
  const auto = Array.from({ length: 30 }, () => lead('new', { createdAt: yesterday, score: score(0.95, 'high'), origin: { kind: 'search', runId: 'r1', mode: 'live', auto: true } }));
  const manual = Array.from({ length: 3 }, () => lead('new', { createdAt: yesterday - DAY, score: score(0.5, 'medium'), origin: { kind: 'search', runId: 'r2', mode: 'live' } }));
  const picked = computeTasks([...auto, ...manual], 'nick', RULES, NOW).tasks.map((task) => task.lead.id);
  for (const entry of manual) assert.ok(picked.includes(entry.id), `${entry.id} fehlt trotz Suche von Hand`);
  assert.equal(picked.length, RULES.newLeadsPerDay);
});
