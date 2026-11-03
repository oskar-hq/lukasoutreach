import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyInterestOf, type CockpitLead, type LeadDetailResponse, type LeadListResponse } from '../../shared/leads.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { computeDashboard } from '../src/dashboard/dashboard.js';
import { loadConfig } from '../src/config.js';
import { tempDataDir } from './helpers.js';

/** Board (Wunsch des Nutzers 19.10.): Stufe frei verschieben, Antwort interessiert/nicht interessiert, Filter nach Kategorie. */

async function app() {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' });
  const server = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false });
  await server.ready();
  return server;
}

const list = async (server: Awaited<ReturnType<typeof app>>, query: string) =>
  (await server.inject({ method: 'GET', url: `/api/leads?${query}` })).json() as LeadListResponse;
const patch = (server: Awaited<ReturnType<typeof app>>, id: string, payload: object) => server.inject({ method: 'PATCH', url: `/api/leads/${id}`, payload });

test('Stufe von Hand: Termin zurück nach Antwort, Verlauf zeigt die Verschiebung, Zähler bleiben', async () => {
  const server = await app();
  const [lead] = (await list(server, 'stage=replied&limit=1')).leads;
  const booked = await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'meeting_booked' } });
  assert.equal(booked.json().lead.stage, 'meeting');
  const meeting = booked.json().lead as CockpitLead;

  const moved = await patch(server, meeting.id, { stage: 'replied' });
  assert.equal(moved.statusCode, 200, moved.body);
  const detail = moved.json() as LeadDetailResponse;
  assert.equal(detail.lead.stage, 'replied');
  const last = detail.events.at(-1)!;
  assert.deepEqual([last.kind, last.title], ['stage_changed', 'Von Hand verschoben: Termin → Antwort']);

  // Ganz zurück nach „Neu“ und wieder vor – jeweils erlaubt.
  assert.equal((await patch(server, meeting.id, { stage: 'new' })).json().lead.stage, 'new');
  assert.equal((await patch(server, meeting.id, { stage: 'contacted' })).json().lead.stage, 'contacted');
  // Gleiche Stufe: kein neues Ereignis.
  const count = (await patch(server, meeting.id, { stage: 'contacted' })).json().events.length;
  assert.equal((await patch(server, meeting.id, { stage: 'contacted' })).json().events.length, count);

  const bad = await patch(server, meeting.id, { stage: 'egal' });
  assert.equal(bad.statusCode, 400);
});

test('Antwort einordnen: automatisch nach Einschätzung, von Hand änderbar, neue Antwort setzt zurück', async () => {
  const server = await app();
  const replied = (await list(server, 'stage=replied&limit=100')).leads;
  assert.ok(replied.length > 0);
  const lead = replied[0];
  assert.equal(lead.replyInterest ?? null, null);

  const setResponse = await patch(server, lead.id, { replyInterest: 'not_interested' });
  assert.equal(setResponse.statusCode, 200, setResponse.body);
  const set = setResponse.json() as LeadDetailResponse;
  assert.equal(set.lead.replyInterest, 'not_interested');
  assert.equal(replyInterestOf(set.lead), 'not_interested');
  assert.equal(set.events.at(-1)!.title, 'Antwort eingeordnet: Nicht interessiert');

  const answered = await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'message_received', text: 'Doch, gern einen Termin.' } });
  assert.equal(answered.statusCode, 200, answered.body);
  assert.equal((answered.json() as LeadDetailResponse).lead.replyInterest, null, 'neue Antwort → wieder automatisch');

  // Hilfsfunktion: Einschätzung „kein Interesse“/„gerade nicht“ → nicht interessiert, sonst interessiert.
  const base = { replyInterest: null } as Pick<CockpitLead, 'replyInterest' | 'conversation'>;
  const conv = (replyIntent: 'not_interested' | 'not_now' | 'question') => ({ replyIntent, replySummary: '', summary: '', source: 'mock' as const, updatedAt: 0, replyAt: 0 });
  assert.equal(replyInterestOf({ ...base, conversation: conv('not_now') }), 'not_interested');
  assert.equal(replyInterestOf({ ...base, conversation: conv('question') }), 'interested');
  assert.equal(replyInterestOf({ ...base, conversation: null }), 'interested');
});

test('Filter nach Kategorie: Kapitalanlage-Vertrieb und Bauträger getrennt', async () => {
  const server = await app();
  const all = await list(server, 'limit=1000');
  const ka = await list(server, 'category=kapitalanlage_vertrieb&limit=1000');
  const bt = await list(server, 'category=bautraeger_projektentwickler&limit=1000');
  assert.ok(ka.total > 0 && bt.total > 0);
  assert.ok(ka.leads.every((lead) => lead.assessment?.category === 'kapitalanlage_vertrieb'));
  assert.ok(bt.leads.every((lead) => lead.assessment?.category === 'bautraeger_projektentwickler'));
  assert.ok(ka.total + bt.total <= all.total);
  assert.equal((await server.inject({ method: 'GET', url: '/api/leads?category=quatsch' })).statusCode, 400);
});

test('Dashboard: von Hand nach „Antwort“ gezogener Lead zählt als Antwort (einmal)', async () => {
  const server = await app();
  const repliesToday = async () => {
    const dashboard = (await server.inject({ method: 'GET', url: '/api/dashboard?days=7' })).json() as { days: Record<string, { replies: number }[]> };
    return dashboard.days.nick.at(-1)!.replies + dashboard.days.johannes.at(-1)!.replies;
  };
  const [contacted] = (await list(server, 'stage=contacted&limit=1')).leads;
  const before = await repliesToday();
  assert.equal((await patch(server, contacted.id, { stage: 'replied' })).statusCode, 200);
  assert.equal(await repliesToday(), before + 1);
  // Weiter nach „Termin“ zählt nicht noch einmal.
  assert.equal((await patch(server, contacted.id, { stage: 'meeting' })).statusCode, 200);
  assert.equal(await repliesToday(), before + 1);
});

test('Follow-up planen: ab dem Zeitpunkt in der gewählten Spalte, Plan danach weg', async () => {
  const server = await app();
  const column = (await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: 'Follow-Up spezial' } })).json() as { id: string };
  const [lead] = (await list(server, 'stage=contacted&limit=1')).leads;

  const past = await patch(server, lead.id, { followUpPlan: { at: Date.now() - 1000, column: column.id } });
  assert.equal(past.statusCode, 400);
  const unknown = await patch(server, lead.id, { followUpPlan: { at: Date.now() + 60_000, column: 'gibt-es-nicht' } });
  assert.equal(unknown.statusCode, 400);

  const at = Date.now() + 400;
  const planned = (await patch(server, lead.id, { followUpPlan: { at, column: column.id } })).json() as LeadDetailResponse;
  assert.deepEqual(planned.lead.followUpPlan, { at, column: column.id, columnName: 'Follow-Up spezial' });
  assert.match(planned.events.at(-1)!.title, /^Follow-up geplant: jetzt in „Follow-Up spezial“, ab .* wieder in den Aufgaben$/);
  assert.equal(planned.lead.boardColumn, column.id, 'ab sofort in der Spalte (22.10.)');

  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(after.lead.boardColumn, column.id);
  assert.equal(after.lead.followUpPlan, null);
  assert.equal(after.events.at(-1)!.title, 'Follow-up fällig – jetzt in „Follow-Up spezial“ und in den Aufgaben');
  assert.equal(after.lead.stage, 'contacted', 'Stufe bleibt');

  // Plan löschen – holt ihn aus der Spalte des Plans zurück in die Stufe.
  await patch(server, lead.id, { followUpPlan: { at: Date.now() + 60_000, column: column.id } });
  const removed = (await patch(server, lead.id, { followUpPlan: null })).json() as LeadDetailResponse;
  assert.equal(removed.lead.followUpPlan, null);
  assert.equal(removed.lead.boardColumn, undefined);
});

test('Follow-up ohne Spalte: im Antwort-Bereich automatisch in die „Follow“-Spalte, sonst keine; null = bewusst keine', async () => {
  const server = await app();
  const column = (await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: 'Follow Up' } })).json() as { id: string };
  const [replied] = (await list(server, 'stage=replied&limit=1')).leads;
  const [contacted] = (await list(server, 'stage=contacted&limit=1')).leads;
  const at = Date.now() + 14 * 86_400_000;
  const auto = (await patch(server, replied.id, { followUpPlan: { at } })).json() as LeadDetailResponse;
  assert.equal(auto.lead.boardColumn, column.id);
  assert.equal(auto.lead.followUpPlan?.columnName, 'Follow Up');
  const notReplied = (await patch(server, contacted.id, { followUpPlan: { at } })).json() as LeadDetailResponse;
  assert.equal(notReplied.lead.boardColumn, undefined, 'Angeschrieben bleibt in der Stufe');
  assert.equal(notReplied.lead.followUpPlan?.column, null);
  await patch(server, replied.id, { followUpPlan: null });
  const none = (await patch(server, replied.id, { followUpPlan: { at, column: null } })).json() as LeadDetailResponse;
  assert.equal(none.lead.boardColumn, undefined);
});

test('Dashboard: eigene Spalten liegen hinter „Antwort“ – Verschieben dorthin zählt als geantwortet, auch rückwirkend', async () => {
  const server = await app();
  const repliesToday = async () => {
    const dashboard = (await server.inject({ method: 'GET', url: '/api/dashboard?days=7' })).json() as { days: Record<string, { replies: number }[]> };
    return dashboard.days.nick.at(-1)!.replies + dashboard.days.johannes.at(-1)!.replies;
  };
  const column = (await server.inject({ method: 'POST', url: '/api/board/columns', payload: { name: 'Conversation' } })).json() as { id: string };
  const [contacted] = (await list(server, 'stage=contacted&limit=1')).leads;
  const before = await repliesToday();
  const moved = (await patch(server, contacted.id, { boardColumn: column.id })).json() as LeadDetailResponse;
  assert.equal(moved.events.at(-1)!.title, 'In Spalte „Conversation“ verschoben');
  assert.equal(await repliesToday(), before + 1);
});

test('Dashboard rückwirkend: Lead im Antwort-Bereich ohne passendes Ereignis zählt zum Zeitpunkt seiner letzten Aktivität', () => {
  const now = Date.UTC(2026, 9, 20, 12);
  const options = { now, days: 7, timeZone: 'Europe/Berlin', maxFollowUps: 3 };
  const rows = [{ lead_id: 'l1', owner: 'nick', template: 'A', kind: 'message_sent', at: now - 2 * 86_400_000, label: 'A' }];
  const without = computeDashboard(rows, [], options);
  assert.equal(without.days.nick.reduce((sum, day) => sum + day.replies, 0), 0);
  const withLead = computeDashboard(rows, [], options, [{ id: 'l1', owner: 'nick', template: 'A', last_activity_at: now - 86_400_000 }]);
  assert.equal(withLead.days.nick.reduce((sum, day) => sum + day.replies, 0), 1);
  assert.equal(withLead.days.nick.at(-2)!.replies, 1, 'am Tag der letzten Aktivität');
  assert.equal(withLead.templates.nick[0].replied, 1, 'zählt auch für die Vorlage');
  // Schon mit Antwort-Ereignis: nicht doppelt.
  const replied = computeDashboard([...rows, { lead_id: 'l1', owner: 'nick', template: 'A', kind: 'message_received', at: now - 3_600_000, label: null }], [], options, [{ id: 'l1', owner: 'nick', template: 'A', last_activity_at: now }]);
  assert.equal(replied.days.nick.reduce((sum, day) => sum + day.replies, 0), 1);
});

test('„Vernetzt“ zurücksetzen: Anfrage gesendet, Annahme aus dem Verlauf (Dashboard zählt sie nicht mehr)', async () => {
  const server = await app();
  const [lead] = (await list(server, 'stage=new&limit=1')).leads;
  await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'invite_sent' } });
  const accepted = await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'invite_accepted' } });
  assert.equal(accepted.json().lead.stage, 'connected');

  const reset = await patch(server, lead.id, { stage: 'invited' });
  assert.equal(reset.statusCode, 200, reset.body);
  const detail = reset.json() as LeadDetailResponse;
  assert.equal(detail.lead.stage, 'invited');
  assert.equal(detail.events.some((event) => event.kind === 'invite_accepted'), false);
  assert.equal(detail.events.filter((event) => event.kind === 'invite_sent').length, 1, 'Anfrage bleibt im Verlauf');
  assert.equal(detail.events.at(-1)!.title, 'Von Hand verschoben: Vernetzt → Anfrage gesendet');

  // Wieder angenommen (z. B. durch den Abgleich) geht danach normal.
  const again = await server.inject({ method: 'POST', url: `/api/leads/${lead.id}/events`, payload: { action: 'invite_accepted' } });
  assert.equal(again.json().lead.stage, 'connected');
});

type Tasks = { tasks: { id: string; type: string; reason: string; resumed?: boolean; lead: { id: string } }[]; attention: { lead: { id: string }; reason: string }[] };
const tasksOf = async (server: Awaited<ReturnType<typeof app>>, owner: string) => (await server.inject({ method: 'GET', url: `/api/tasks?owner=${owner}` })).json() as Tasks;
const act = (server: Awaited<ReturnType<typeof app>>, id: string, payload: object) => server.inject({ method: 'POST', url: `/api/leads/${id}/events`, payload });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('Wiedervorlage (22.10.): nach allen Follow-ups pausiert, ab dem Tag wieder als Follow-up in den Aufgaben – ohne Spalte', async () => {
  const server = await app();
  const [lead] = (await list(server, 'stage=contacted&limit=1')).leads;
  for (let i = lead.followUpsSent; i < 3; i++) assert.equal((await act(server, lead.id, { action: 'message_sent', text: `Follow-up ${i + 1}` })).statusCode, 200);

  const at = Date.now() + 400;
  const planned = await patch(server, lead.id, { followUpPlan: { at } });
  assert.equal(planned.statusCode, 200, planned.body);
  const detail = planned.json() as LeadDetailResponse;
  assert.deepEqual(detail.lead.followUpPlan, { at, column: null, columnName: null });
  assert.match(detail.events.at(-1)!.title, /^Wiedervorlage geplant: ab .* wieder in den Aufgaben$/);
  assert.equal((await patch(server, lead.id, { followUpPlan: { at: Date.now() + 400 * 24 * 60 * 60 * 1000 } })).statusCode, 400, 'höchstens ein Jahr');
  await patch(server, lead.id, { followUpPlan: { at } });

  // Pausiert: weder Aufgabe noch „Braucht Aufmerksamkeit“.
  const before = await tasksOf(server, lead.owner);
  assert.ok(!before.tasks.some((task) => task.lead.id === lead.id));
  assert.ok(!before.attention.some((item) => item.lead.id === lead.id));

  await wait(500);
  const after = await tasksOf(server, lead.owner);
  const task = after.tasks.find((entry) => entry.lead.id === lead.id);
  assert.ok(task, 'wieder in den Aufgaben');
  assert.equal(task.type, 'followup');
  assert.match(task.reason, /^Wiedervorlage – geplant für /);
  assert.equal(task.resumed, true);
  assert.equal(task.id, `${lead.id}:followup:4:${at}`);
  const due = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
  assert.equal(due.lead.followUpDueAt, at);
  assert.equal(due.lead.followUpPlan, null);
  assert.equal(due.events.at(-1)!.title, 'Wiedervorlage fällig – wieder in den Aufgaben');

  // Nachricht gesendet → erledigt.
  const sent = (await act(server, lead.id, { action: 'message_sent', text: 'Noch einmal ich' })).json() as LeadDetailResponse;
  assert.equal(sent.lead.followUpDueAt, null);
  assert.ok(!(await tasksOf(server, lead.owner)).tasks.some((entry) => entry.lead.id === lead.id));
});

test('Wiedervorlage: verlorener Lead wird am Tag wieder geöffnet; eine Antwort hebt den Plan auf', async () => {
  const server = await app();
  const [lost, other] = (await list(server, 'stage=contacted&limit=2')).leads;
  await act(server, lost.id, { action: 'lost', text: 'Keine Antwort' });
  await patch(server, lost.id, { followUpPlan: { at: Date.now() + 300 } });
  await wait(400);
  const reopened = (await server.inject({ method: 'GET', url: `/api/leads/${lost.id}` })).json() as LeadDetailResponse;
  assert.equal(reopened.lead.stage, 'contacted');
  assert.ok(reopened.events.some((event) => event.kind === 'reopened' && /Wiedervorlage/.test(event.title)));
  assert.ok((await tasksOf(server, lost.owner)).tasks.some((task) => task.lead.id === lost.id && task.type === 'followup'));

  await patch(server, other.id, { followUpPlan: { at: Date.now() + 60_000 } });
  const replied = (await act(server, other.id, { action: 'message_received', text: 'Melde mich doch schon jetzt.' })).json() as LeadDetailResponse;
  assert.equal(replied.lead.followUpPlan, null);
  assert.ok((await tasksOf(server, other.owner)).tasks.some((task) => task.lead.id === other.id && task.type === 'reply'));
});
