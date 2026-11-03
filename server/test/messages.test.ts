import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewLeadCard } from '../../shared/leadSearch.js';
import type { DashboardResponse } from '../../shared/dashboard.js';
import type { CreateLeadsResponse, LeadDetailResponse, RequeueInvitesResponse, UnsentInvitesResponse } from '../../shared/leads.js';
import type { TasksResponse } from '../../shared/tasks.js';
import { hiringRoleText, metaPauseText, renderTemplate, unknownPlaceholders, type MessageSuggestion, type MessageTemplate, type TemplatesResponse } from '../../shared/messages.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { guessReplyIntent } from '../src/messages/suggest.js';
import { startFakeAnthropic } from './fakeServers.js';
import { tempDataDir } from './helpers.js';

const LIVE: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'unipile-test-key' };

function app(env: NodeJS.ProcessEnv = {}, options: { requireSession?: boolean; anthropicBaseURL?: string } = {}) {
  const base: NodeJS.ProcessEnv = { LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false' };
  return buildApp({
    config: loadConfig({ ...base, ...env }),
    adapter: new MockAdapter(0),
    logger: false,
    requireSession: options.requireSession ?? false,
    ...(options.anthropicBaseURL ? { messagesTest: { anthropicBaseURL: options.anthropicBaseURL } } : {}),
  });
}

type App = ReturnType<typeof app>;

const NONE = { state: 'none', advertiser: null, ads: 0, activeAds: 0, lastStop: null, foreignAds: 0, libraryUrl: null, note: null } as const;
const STOPPED = { ...NONE, state: 'stopped', advertiser: 'Muster Wohnbau', ads: 4, lastStop: '2026-03-01' } as const;

const card = (overrides: Partial<NewLeadCard> = {}): NewLeadCard => ({
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'live',
  providerId: 'ACoMSG001',
  publicIdentifier: 'erika-muster',
  profileUrl: 'https://www.linkedin.com/in/erika-muster',
  firstName: 'Erika',
  lastName: 'Muster',
  headline: 'Geschäftsführerin · Muster Wohnbau GmbH',
  position: 'Geschäftsführerin',
  company: 'Muster Wohnbau GmbH',
  location: 'Köln',
  website: 'https://www.muster-wohnbau.de',
  networkDistance: 2,
  category: 'bautraeger_projektentwickler',
  confidence: 0.88,
  reason: 'Entwickelt und verkauft selbst.',
  summary: 'Bauträger aus Köln.',
  metaAds: NONE,
  ...overrides,
});

async function createLead(server: App, overrides: Partial<NewLeadCard> = {}) {
  const response = await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card(overrides)], owner: 'nick' } });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as CreateLeadsResponse).created[0];
}

const action = (server: App, id: string, payload: object) => server.inject({ method: 'POST', url: `/api/leads/${id}/events`, payload });
const suggest = (server: App, id: string, payload: object) => server.inject({ method: 'POST', url: `/api/leads/${id}/suggest`, payload });

// ── Reine Funktionen ───────────────────────────────────────────────────────

test('Platzhalter: ersetzen, unbekannte stehen lassen und melden', () => {
  assert.equal(renderTemplate('Hallo {{vorname}} von {{ firma }}, {{xyz}}', { vorname: 'Erika', firma: 'Muster' }), 'Hallo Erika von Muster, {{xyz}}');
  assert.deepEqual(unknownPlaceholders('{{vorname}} {{vornam}} {{stellen}} {{vornam}}'), ['vornam', 'stellen']);
  // {{stelle}} (13.10.): Hiring-Signal – „Verstärkung als …“, ohne Stelle nur „Verstärkung“.
  assert.deepEqual(unknownPlaceholders('{{stelle}}'), []);
  assert.equal(hiringRoleText(' Vertriebsmitarbeiter  (m/w/d) '), 'Verstärkung als Vertriebsmitarbeiter (m/w/d)');
  assert.equal(hiringRoleText(null), 'Verstärkung');
});

test('Einschätzung der Antwort ohne KI', () => {
  assert.equal(guessReplyIntent('Klingt spannend, wann hättest du Zeit?'), 'interested');
  assert.equal(guessReplyIntent('Was kostet das denn?'), 'question');
  assert.equal(guessReplyIntent('Aktuell nicht, vielleicht nächstes Jahr.'), 'not_now');
  assert.equal(guessReplyIntent('Danke, aber kein Interesse.'), 'not_interested');
  assert.equal(guessReplyIntent('Danke.'), 'unclear');
});

// ── Vorlagen ───────────────────────────────────────────────────────────────

test('Vorlagen: Standard, ändern, prüfen, zurücksetzen', async () => {
  const server = app();
  const list = (await server.inject({ method: 'GET', url: '/api/templates' })).json() as TemplatesResponse;
  const ids = list.templates.map((t) => t.id);
  assert.deepEqual(ids, ['G1', 'G2', 'R1', 'R2', 'S1', 'S2', 'GF1', 'RF1', 'SF1', 'H1', 'F1A', 'F2A', 'F3A', 'F1F', 'F2F', 'F3F', 'N1']);
  // Segmente (27.10.): Kundentexte für Kapitalanlage, eigene Entwürfe für Finanzdienstleister, Recruiting und Notiz für alle.
  assert.deepEqual(list.templates.filter((t) => t.segment === 'finanzdienstleister').map((t) => t.id), ['GF1', 'RF1', 'SF1', 'F1F', 'F2F', 'F3F']);
  assert.deepEqual(list.templates.filter((t) => !t.segment).map((t) => t.id), ['H1', 'N1']);
  // Hiring-Signal (13.10.): H1 spricht Firmen an, die Mitarbeiter suchen ({{stelle}}).
  assert.deepEqual(list.templates.filter((t) => t.audience === 'hiring').map((t) => t.id), ['H1']);
  assert.match(list.templates.find((t) => t.id === 'H1')!.text, /gerade \{\{stelle\}\} sucht/);
  // Seit 12.10. die Outreach-Nachrichten des Kunden: Reactivation mit {{metastopp}}, Follow-ups enden mit „Beste Grüße“.
  assert.match(list.templates.find((t) => t.id === 'R1')!.text, /ihr \{\{metastopp\}\} aufgehört habt, Meta Ads zu schalten/);
  assert.match(list.templates.find((t) => t.id === 'G1')!.text, /Meta Ad Library/);
  assert.ok(list.templates.filter((t) => t.kind === 'followup').every((t) => t.text.endsWith('Beste Grüße')));
  assert.ok(list.templates.every((t) => t.isDefault && unknownPlaceholders(t.text).length === 0));
  // Laufende Meta-Ads (12.10., Wunsch des Nutzers: kein Ausschluss, sondern Aufhänger): nur S1/S2 (und SF1 für Finanzdienstleister).
  assert.deepEqual(list.templates.filter((t) => /gerade (Meta Ads|Werbeanzeigen) schaltet/.test(t.text)).map((t) => t.id), ['S1', 'S2', 'SF1']);
  assert.ok(list.templates.filter((t) => t.audience === 'active').every((t) => t.id.startsWith('S')));

  const put = (id: string, payload: object) => server.inject({ method: 'PUT', url: `/api/templates/${id}`, payload });
  const bad = await put('G1', { text: 'Hallo {{vornam}}' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'invalid_template');
  assert.match(bad.json().error.message, /\{\{vornam\}\}/);
  assert.equal((await put('G1', { text: '   ' })).statusCode, 400);
  assert.equal((await put('N1', { text: 'x'.repeat(301) })).statusCode, 400);
  assert.equal((await put('XX', { text: 'Hallo' })).statusCode, 404);

  const ok = await put('G1', { text: 'Hallo {{vorname}}, neu.\n\n{{grussformel}}', name: 'Mein Text' });
  assert.equal(ok.statusCode, 200, ok.body);
  const changed = ok.json() as MessageTemplate;
  assert.equal(changed.isDefault, false);
  assert.equal(changed.name, 'Mein Text');
  assert.equal(changed.kind, 'first');

  const reset = (await server.inject({ method: 'POST', url: '/api/templates/G1/reset' })).json() as MessageTemplate;
  assert.equal(reset.isDefault, true);
  assert.notEqual(reset.text, changed.text);
  assert.equal((await server.inject({ method: 'POST', url: '/api/templates/XX/reset' })).statusCode, 404);
  await server.close();
});

test('Eigene Vorlagen: anlegen bis Z, löschen, die letzte bleibt, Vorschlag nutzt sie', async () => {
  const server = app();
  const list = async () => ((await server.inject({ method: 'GET', url: '/api/templates' })).json() as TemplatesResponse).templates;
  const create = (payload: object) => server.inject({ method: 'POST', url: '/api/templates', payload });
  const remove = (id: string) => server.inject({ method: 'DELETE', url: `/api/templates/${id}` });

  assert.equal((await create({ category: 'gibtsnicht', text: 'Hallo' })).statusCode, 400);
  assert.equal((await create({ category: 'followup_1', text: '  ' })).statusCode, 400);
  assert.match((await create({ category: 'followup_1', text: 'Hallo {{vornam}}' })).json().error.message, /vornam/);
  assert.equal((await create({ category: 'invite', text: 'x'.repeat(301) })).statusCode, 400);

  const made = await create({ category: 'followup_1', text: 'Hallo {{vorname}}, Variante C.' });
  assert.equal(made.statusCode, 201, made.body);
  const c = made.json() as MessageTemplate;
  assert.deepEqual([c.id, c.kind, c.stage, c.audience, c.name, c.custom, c.isDefault], ['F1.1', 'followup', 1, 'any', 'Neue Vorlage', true, false]);
  assert.equal(c.segment, null, 'ohne Angabe für alle');
  // Steht direkt hinter F1A und F1F – Reihenfolge = Buchstaben A, B, C.
  assert.deepEqual((await list()).filter((t) => t.kind === 'followup' && t.stage === 1).map((t) => t.id), ['F1A', 'F1F', 'F1.1']);

  // Ändern und „Zurücksetzen“ (ohne Standardtext bleibt sie, wie sie ist).
  const put = await server.inject({ method: 'PUT', url: '/api/templates/F1.1', payload: { text: 'Neu {{firma}}', name: 'Kurz' } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((put.json() as MessageTemplate).name, 'Kurz');
  assert.equal(((await server.inject({ method: 'POST', url: '/api/templates/F1.1/reset' })).json() as MessageTemplate).text, 'Neu {{firma}}');

  // Höchstens 26 je Kategorie (2 Standardtexte + 24 eigene).
  for (let index = 2; index < 25; index++) assert.equal((await create({ category: 'followup_1', text: `Text ${index}` })).statusCode, 201);
  const full = await create({ category: 'followup_1', text: 'Zu viel' });
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().error.code, 'template_limit');
  // Andere Kategorie ist davon unberührt.
  assert.equal((await create({ category: 'first_reactivation', name: 'Eigene', text: 'Hallo {{vorname}}' })).statusCode, 201);

  // Löschen: eigene und Standardtexte – die letzte einer Kategorie bleibt.
  assert.equal((await remove('F1.1')).statusCode, 200);
  assert.equal((await remove('F1.1')).statusCode, 404);
  assert.equal((await remove('N1')).statusCode, 409);
  assert.equal((await remove('N1')).json().error.code, 'last_template');
  assert.equal((await remove('G2')).statusCode, 200);
  assert.equal((await remove('GF1')).statusCode, 200);
  const last = await remove('G1');
  assert.equal(last.statusCode, 409);
  assert.ok((await list()).some((t) => t.id === 'G1'));
  assert.ok(!(await list()).some((t) => t.id === 'G2'));
  assert.equal((await server.inject({ method: 'PUT', url: '/api/templates/G2', payload: { text: 'x' } })).statusCode, 404);

  // Eine neue Vorlage bekommt nie die ID einer gelöschten.
  assert.equal((await remove('F1.2')).statusCode, 200);
  const again = (await create({ category: 'followup_1', text: 'Wieder da' })).json() as MessageTemplate;
  assert.equal(again.id, 'F1.25');

  // Greenfield hat nur noch G1 – der Vorschlag nimmt sie; eine gelöschte Vorlage gibt es für den Vorschlag nicht.
  const lead = await createLead(server, { metaAds: NONE });
  const suggestion = (await suggest(server, lead.id, { kind: 'first' })).json() as MessageSuggestion;
  assert.equal(suggestion.templateId, 'G1');
  assert.equal((await suggest(server, lead.id, { kind: 'first', templateId: 'G2' })).statusCode, 400);
  // „Zurücksetzen“ holt einen gelöschten Standardtext zurück.
  assert.equal((await server.inject({ method: 'POST', url: '/api/templates/G2/reset' })).statusCode, 200);
  assert.ok((await list()).some((t) => t.id === 'G2'));
  await server.close();
});

test('Vorlagen und Vorschläge nur mit Sitzung', async () => {
  const server = app({}, { requireSession: true });
  assert.equal((await server.inject({ method: 'GET', url: '/api/templates' })).statusCode, 401);
  assert.equal((await server.inject({ method: 'PUT', url: '/api/templates/G1', payload: { text: 'x' } })).statusCode, 401);
  assert.equal((await server.inject({ method: 'POST', url: '/api/templates', payload: { category: 'invite', text: 'x' } })).statusCode, 401);
  assert.equal((await server.inject({ method: 'DELETE', url: '/api/templates/G1' })).statusCode, 401);
  assert.equal((await server.inject({ method: 'POST', url: '/api/leads/x/suggest', payload: { kind: 'first' } })).statusCode, 401);
  await server.close();
});

test('Segmente (27.10.): Finanzdienstleister bekommen ihre Erstnachricht und Follow-ups, eigene Vorlagen mit Segment', async () => {
  const server = app();
  const fdl = await createLead(server, { providerId: 'ACoFDL01', publicIdentifier: 'fiona-fdl', category: 'finanzdienstleister', company: 'Fiona Finanz GmbH' });
  const ka = await createLead(server, { providerId: 'ACoKA001', publicIdentifier: 'karl-ka', category: 'kapitalanlage_vertrieb' });
  const first = (await suggest(server, fdl.id, { kind: 'first' })).json() as MessageSuggestion;
  assert.equal(first.templateId, 'GF1');
  assert.match(first.basis, /Finanzdienstleister/);
  assert.equal(((await suggest(server, fdl.id, { kind: 'followup' })).json() as MessageSuggestion).templateId, 'F1F');
  assert.ok(['G1', 'G2'].includes(((await suggest(server, ka.id, { kind: 'first' })).json() as MessageSuggestion).templateId!));
  assert.equal(((await suggest(server, ka.id, { kind: 'followup' })).json() as MessageSuggestion).templateId, 'F1A');

  // Eigene Vorlage nur für Finanzdienstleister; Segment ändern und wieder für alle.
  const made = await server.inject({ method: 'POST', url: '/api/templates', payload: { category: 'followup_2', text: 'Hallo {{vorname}}', segment: 'finanzdienstleister' } });
  assert.equal(made.statusCode, 201, made.body);
  const own = made.json() as MessageTemplate;
  assert.equal(own.segment, 'finanzdienstleister');
  assert.equal((await server.inject({ method: 'POST', url: '/api/templates', payload: { category: 'followup_2', text: 'x', segment: 'bautraeger' } })).statusCode, 400);
  const changed = await server.inject({ method: 'PUT', url: `/api/templates/${own.id}`, payload: { text: 'Hallo {{vorname}}', segment: null } });
  assert.equal((changed.json() as MessageTemplate).segment, null);
  const kept = await server.inject({ method: 'PUT', url: `/api/templates/${own.id}`, payload: { text: 'Neu' } });
  assert.equal((kept.json() as MessageTemplate).segment, null, 'ohne Angabe bleibt das Segment');
  // Standardtexte behalten ihr Segment.
  const fixed = await server.inject({ method: 'PUT', url: '/api/templates/F2F', payload: { text: 'Hallo', segment: null } });
  assert.equal((fixed.json() as MessageTemplate).segment, 'finanzdienstleister');
  await server.close();
});

// ── Vorschläge ─────────────────────────────────────────────────────────────

test('Simulation: Vorlage passend zum Lead-Typ, Follow-up-Stufe, Antwort mit Einschätzung', async () => {
  const server = app();
  const green = await createLead(server, { mode: 'mock' });
  const first = (await suggest(server, green.id, { kind: 'first' })).json() as MessageSuggestion;
  assert.equal(first.source, 'mock');
  assert.match(first.templateId ?? '', /^G[12]$/);
  assert.match(first.basis, /^Greenfield/);
  assert.match(first.text, /Erika/);
  // Option 1 nennt die Firma, Option 2 (Text des Kunden) nicht.
  if (first.templateId === 'G1') assert.match(first.text, /Muster Wohnbau GmbH/);
  // Erstnachrichten des Kunden enden mit der Frage nach dem Call (ohne Grußformel).
  assert.match(first.text, /15-Minuten-Call Sinn/);
  assert.ok(!first.text.includes('{{'));
  // Gleicher Lead → gleiche Variante (stabil).
  assert.equal(((await suggest(server, green.id, { kind: 'first' })).json() as MessageSuggestion).templateId, first.templateId);

  const reactivation = await createLead(server, { mode: 'mock', providerId: 'ACoMSG002', publicIdentifier: 'max-r', metaAds: STOPPED });
  const r = (await suggest(server, reactivation.id, { kind: 'first' })).json() as MessageSuggestion;
  assert.match(r.templateId ?? '', /^R[12]$/);

  const fixed = (await suggest(server, green.id, { kind: 'first', templateId: 'R2' })).json() as MessageSuggestion;
  assert.equal(fixed.templateId, 'R2');
  const wrong = await suggest(server, green.id, { kind: 'first', templateId: 'F1A' });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error.code, 'invalid_template');
  assert.equal((await suggest(server, green.id, { kind: 'first', templateId: 'NOPE' })).statusCode, 400);
  assert.equal((await suggest(server, green.id, { kind: 'quatsch' })).statusCode, 400);
  assert.equal((await suggest(server, 'gibt-es-nicht', { kind: 'first' })).statusCode, 404);

  // Verlauf: vernetzt → Erstnachricht → Follow-up 1 gesendet → nächster Vorschlag ist Stufe 2.
  for (const payload of [{ action: 'invite_accepted' }, { action: 'message_sent', text: 'Hallo', label: first.templateId }, { action: 'message_sent', text: 'Nachgehakt', label: 'F1A' }]) {
    assert.equal((await action(server, green.id, payload)).statusCode, 200);
  }
  const follow = (await suggest(server, green.id, { kind: 'followup' })).json() as MessageSuggestion;
  assert.match(follow.templateId ?? '', /^F2[AB]$/);
  assert.match(follow.basis, /Follow-up 2/);

  const noReply = (await suggest(server, green.id, { kind: 'reply' })).json() as MessageSuggestion;
  assert.equal(noReply.reply?.intent, 'unclear');
  assert.ok(noReply.notice);

  await action(server, green.id, { action: 'message_received', text: 'Klingt spannend, lass uns telefonieren.' });
  const reply = (await suggest(server, green.id, { kind: 'reply' })).json() as MessageSuggestion;
  assert.equal(reply.templateId, null);
  assert.equal(reply.reply?.intent, 'interested');
  assert.match(reply.text, /15 Minuten/);
  await server.close();
});

test('Live ohne Anthropic-Schlüssel: ausgefüllte Vorlage mit Hinweis', async () => {
  const server = app(LIVE);
  const lead = await createLead(server);
  const result = (await suggest(server, lead.id, { kind: 'first' })).json() as MessageSuggestion;
  assert.equal(result.source, 'template');
  assert.match(result.notice ?? '', /Kein Anthropic-Schlüssel/);
  assert.match(result.text, /Erika/);
  await server.close();
});

test('Live mit KI: Text von der KI, Verlauf und Vorlage im Prompt, Einschätzung der Antwort', async () => {
  const anthropic = await startFakeAnthropic({
    suggestion: { text: 'Hallo Erika, gern! Passt dir Donnerstag?\n\nViele Grüße\nNick', intent: 'interested', summary: 'Will telefonieren.' },
  });
  const server = app({ ...LIVE, ANTHROPIC_API_KEY: 'sk-test' }, { anthropicBaseURL: anthropic.baseUrl });
  const lead = await createLead(server);
  await action(server, lead.id, { action: 'invite_accepted' });
  await action(server, lead.id, { action: 'message_sent', text: 'Hallo Erika, erste Nachricht.' });
  await action(server, lead.id, { action: 'message_received', text: 'Klingt gut – ruf mich an.' });

  const result = (await suggest(server, lead.id, { kind: 'reply' })).json() as MessageSuggestion;
  assert.equal(result.source, 'ai');
  assert.equal(result.text, 'Hallo Erika, gern! Passt dir Donnerstag?\n\nViele Grüße\nNick');
  assert.deepEqual(result.reply, { intent: 'interested', summary: 'Will telefonieren.' });

  const sent = anthropic.requests.at(-1)!.body as { system: string; messages: Array<{ content: string }> };
  assert.match(sent.system, /\[cockpit:vorschlag\]/);
  const prompt = sent.messages[0].content;
  assert.match(prompt, /Firma: Muster Wohnbau GmbH/);
  assert.match(prompt, /Klingt gut – ruf mich an\./);
  assert.match(prompt, /<vorlage>/);
  assert.match(prompt, /Viele Grüße\\nNick/);
  assert.equal(anthropic.requests.at(-1)!.headers['x-api-key'], 'sk-test');
  await server.close();
  await anthropic.close();
});

test('Live: KI fällt aus → Vorlage mit Hinweis, ohne Schlüssel in der Meldung', async () => {
  const anthropic = await startFakeAnthropic({ status: 401 });
  const server = app({ ...LIVE, ANTHROPIC_API_KEY: 'sk-geheim-123' }, { anthropicBaseURL: anthropic.baseUrl });
  const lead = await createLead(server);
  const response = await suggest(server, lead.id, { kind: 'first' });
  assert.equal(response.statusCode, 200);
  const result = response.json() as MessageSuggestion;
  assert.equal(result.source, 'template');
  assert.match(result.notice ?? '', /Schlüssel ist ungültig/);
  assert.ok(!response.body.includes('sk-geheim-123'));
  await server.close();
  await anthropic.close();
});

test('Live: höchstens 60 KI-Vorschläge je Stunde', async () => {
  const anthropic = await startFakeAnthropic();
  const server = app({ ...LIVE, ANTHROPIC_API_KEY: 'sk-test' }, { anthropicBaseURL: anthropic.baseUrl });
  const lead = await createLead(server);
  for (let i = 0; i < 60; i++) assert.equal((await suggest(server, lead.id, { kind: 'first' })).statusCode, 200);
  const blocked = await suggest(server, lead.id, { kind: 'first' });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'too_many_requests');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  await server.close();
  await anthropic.close();
});

// ── Gespräch am Lead (Einschätzung + Zusammenfassung) ─────────────────────────

const getLead = async (server: App, id: string) => (await server.inject({ method: 'GET', url: `/api/leads/${id}` })).json().lead as import('../../shared/leads.js').CockpitLead;

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('Gespräch: Simulation schätzt jede neue Antwort sofort ein, Demo-Leads haben sie schon', async () => {
  const server = app();
  await server.ready();
  const demo = (await server.inject({ method: 'GET', url: '/api/leads?stage=replied' })).json().leads as import('../../shared/leads.js').CockpitLead[];
  assert.ok(demo.length > 0 && demo.every((lead) => lead.conversation?.source === 'mock'));

  const lead = await createLead(server, { mode: 'mock' });
  assert.equal(lead.conversation ?? null, null);
  await action(server, lead.id, { action: 'invite_accepted' });
  await action(server, lead.id, { action: 'message_sent', text: 'Hallo Erika' });
  const answered = await action(server, lead.id, { action: 'message_received', text: 'Danke, aber kein Interesse.' });
  const conversation = answered.json().lead.conversation;
  assert.equal(conversation.replyIntent, 'not_interested');
  assert.equal(conversation.source, 'mock');
  assert.match(conversation.summary, /1 Nachricht gesendet/);
  assert.match(conversation.summary, /kein Interesse/);
  await server.close();
});

test('Gespräch live: erst Regeln, dann KI im Hintergrund; ohne Schlüssel bleiben die Regeln', async () => {
  const anthropic = await startFakeAnthropic({ conversation: { replyIntent: 'question', replySummary: 'Fragt nach den Kosten.', summary: 'Erstnachricht gesendet. Erika fragt nach dem Preis.' } });
  const server = app({ ...LIVE, ANTHROPIC_API_KEY: 'sk-test' }, { anthropicBaseURL: anthropic.baseUrl });
  const lead = await createLead(server);
  await action(server, lead.id, { action: 'invite_accepted' });
  await action(server, lead.id, { action: 'message_sent', text: 'Hallo Erika' });
  const answered = await action(server, lead.id, { action: 'message_received', text: 'Was kostet das?' });
  assert.equal(answered.json().lead.conversation.source, 'rules');
  assert.equal(answered.json().lead.conversation.replyIntent, 'question');

  const done = await waitFor(() => getLead(server, lead.id), (value) => value.conversation?.source === 'ai');
  assert.equal(done.conversation?.source, 'ai');
  assert.equal(done.conversation?.replySummary, 'Fragt nach den Kosten.');
  const sent = anthropic.requests.find((request) => String((request.body as { system?: string }).system).includes('[cockpit:gespraech]'));
  assert.match((sent!.body as { messages: Array<{ content: string }> }).messages[0].content, /Erika \(\d\d\.\d\d\.\): Was kostet das\?/);
  await server.close();
  await anthropic.close();

  const plain = app(LIVE);
  const other = await createLead(plain);
  await action(plain, other.id, { action: 'invite_accepted' });
  const reply = await action(plain, other.id, { action: 'message_received', text: 'Klingt spannend!' });
  assert.equal(reply.json().lead.conversation.source, 'rules');
  assert.equal(reply.json().lead.conversation.replyIntent, 'interested');
  await plain.close();
});

test('Gespräch live: KI fällt aus → Regeln bleiben', async () => {
  const anthropic = await startFakeAnthropic({ status: 500, errorType: 'api_error' });
  const server = app({ ...LIVE, ANTHROPIC_API_KEY: 'sk-test' }, { anthropicBaseURL: anthropic.baseUrl });
  const lead = await createLead(server);
  await action(server, lead.id, { action: 'invite_accepted' });
  await action(server, lead.id, { action: 'message_received', text: 'Gerade nicht, vielleicht nächstes Jahr.' });
  await waitFor(async () => anthropic.requests.length, (n) => n >= 2, 3000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await getLead(server, lead.id);
  assert.equal(after.conversation?.source, 'rules');
  assert.equal(after.conversation?.replyIntent, 'not_now');
  await server.close();
  await anthropic.close();
});

test('Demo-Daten: Labels sind Vorlagen-IDs, Nick hat einen Reactivation-Lead mit Erstnachricht-Aufgabe', async () => {
  const server = app();
  await server.ready();
  const tasks = (await server.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as import('../../shared/tasks.js').TasksResponse;
  const reactivation = tasks.tasks.find((task) => task.type === 'first' && task.lead.score?.leadType === 'reactivation');
  assert.ok(reactivation, 'Reactivation-Lead mit Erstnachricht bei Nick');
  const suggestion = (await suggest(server, reactivation.lead.id, { kind: 'first' })).json() as MessageSuggestion;
  assert.match(suggestion.templateId ?? '', /^R[12]$/);

  const leads = (await server.inject({ method: 'GET', url: '/api/leads?limit=100' })).json().leads as Array<{ id: string }>;
  const labels = new Set<string>();
  for (const lead of leads) {
    const detail = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as { events: Array<{ kind: string; label: string | null }> };
    for (const event of detail.events) if (event.kind === 'message_sent' && event.label) labels.add(event.label);
  }
  assert.ok(labels.size > 0);
  assert.ok([...labels].every((label) => /^(G[12]|R[12]|F[123][AB])$/.test(label)), [...labels].join(', '));
  await server.close();
});

test('Gespräch: Zusammenfassung ohne doppelten Punkt nach dem Datum', async () => {
  const { rulesSummary } = await import('../src/messages/conversation.js');
  const at = Date.UTC(2026, 9, 4, 10);
  const lead = { person: { firstName: 'Ralf' } } as import('../../shared/leads.js').CockpitLead;
  const event = (kind: 'message_sent' | 'message_received', text: string | null) => ({ id: kind, leadId: 'l', kind, at, by: null, title: '', text, label: null });
  const summary = rulesSummary(lead, [event('message_sent', 'Hallo'), event('message_received', null)]);
  assert.equal(summary, '1 Nachricht gesendet, zuletzt am 04.10. Ralf hat einmal geantwortet, zuletzt am 04.10.');
  assert.ok(!summary.includes('..'));
  assert.match(rulesSummary(lead, [event('message_received', 'Gern!')]), /zuletzt am 04\.10\.: „Gern!“$/);
});

test('{{metapause}}: Dauer seit der letzten Meta-Anzeige – Text und im Vorschlag', async () => {
  const now = Date.UTC(2026, 9, 11, 12);
  assert.equal(metaPauseText(null, now), 'seit einiger Zeit');
  assert.equal(metaPauseText('2026-10-05', now), 'seit ein paar Tagen');
  assert.equal(metaPauseText('2026-09-01', now), 'seit rund 6 Wochen');
  assert.equal(metaPauseText('2026-06-11', now), 'seit rund 4 Monaten');
  assert.equal(metaPauseText('2023-10-11', now), 'seit rund 3 Jahren');
  assert.equal(metaPauseText('2027-01-01', now), 'seit einiger Zeit', 'Datum in der Zukunft');

  const server = app();
  const edited = await server.inject({ method: 'PUT', url: '/api/templates/R1', payload: { text: 'Hallo {{vorname}}, {{firma}} wirbt {{metapause}} nicht mehr auf Meta.' } });
  assert.equal(edited.statusCode, 200, edited.body);
  const lead = await createLead(server, { metaAds: STOPPED });
  const suggestion = (await suggest(server, lead.id, { kind: 'first', templateId: 'R1' })).json() as MessageSuggestion;
  assert.match(suggestion.text, /^Hallo Erika, Muster Wohnbau GmbH wirbt seit rund \d+ Monaten nicht mehr auf Meta\.$/);
  await server.close();
});

test('Meta-Ads von Hand: Lead-Typ und Erstnachricht wechseln, Deal Value mit Verlauf, Dashboard summiert', async () => {
  const server = app();
  const lead = await createLead(server, { metaAds: NONE });
  assert.equal(((await suggest(server, lead.id, { kind: 'first' })).json() as MessageSuggestion).templateId?.startsWith('G'), true);

  const patch = (payload: object) => server.inject({ method: 'PATCH', url: `/api/leads/${lead.id}`, payload });
  const stopped = await patch({ metaAds: { state: 'stopped', lastStop: '2026-06-01' } });
  assert.equal(stopped.statusCode, 200, stopped.body);
  const detail = stopped.json() as LeadDetailResponse;
  assert.equal(detail.lead.metaAds?.state, 'stopped');
  assert.equal(detail.lead.metaAds?.lastStop, '2026-06-01');
  assert.equal(detail.lead.metaAds?.manual, true);
  assert.equal(detail.lead.score?.leadType, 'reactivation');
  assert.match(detail.events.at(-1)?.title ?? '', /^Meta-Ads von Hand: Meta-Ads beendet am 01\.06\.2026$/);
  assert.equal(((await suggest(server, lead.id, { kind: 'first' })).json() as MessageSuggestion).templateId?.startsWith('R'), true);
  assert.equal((await patch({ metaAds: { state: 'stopped', lastStop: '1.6.2026' } })).statusCode, 400);

  const valued = (await patch({ dealValue: 25000 })).json() as LeadDetailResponse;
  assert.equal(valued.lead.dealValue, 25000);
  assert.equal(valued.events.at(-1)?.title, 'Deal Value: 25.000 €');
  assert.equal((await patch({ dealValue: -1 })).statusCode, 400);
  assert.equal((await patch({ dealValue: 12.5 })).statusCode, 400);
  const dashboard = (await server.inject({ method: 'GET', url: '/api/dashboard' })).json() as DashboardResponse;
  assert.equal(dashboard.dealValue?.nick.new, 25000);
  assert.equal(dashboard.dealValue?.johannes.new, 0);
  const cleared = (await patch({ dealValue: null })).json() as LeadDetailResponse;
  assert.equal(cleared.lead.dealValue, null);
  assert.equal(cleared.events.at(-1)?.title, 'Deal Value entfernt');
  await server.close();
});

test('Hiring-Signal: Recruiting-Vorlage mit {{stelle}} vor dem Lead-Typ, von Hand setzen und entfernen', async () => {
  const server = app();
  const hiring = await createLead(server, { mode: 'mock', hiring: { role: 'Vertriebsmitarbeiter (m/w/d)', source: 'profile', evidence: 'Headline: „Wir suchen …“' } });
  assert.deepEqual(hiring.hiring, { role: 'Vertriebsmitarbeiter (m/w/d)', source: 'profile', evidence: 'Headline: „Wir suchen …“' });
  const first = (await suggest(server, hiring.id, { kind: 'first' })).json() as MessageSuggestion;
  assert.equal(first.templateId, 'H1');
  assert.match(first.basis, /^Sucht Mitarbeiter \(Vertriebsmitarbeiter \(m\/w\/d\)\)/);
  assert.match(first.text, /gerade Verstärkung als Vertriebsmitarbeiter \(m\/w\/d\) sucht/);
  // Die Meta-Ads-Vorlagen bleiben wählbar.
  assert.equal(((await suggest(server, hiring.id, { kind: 'first', templateId: 'G1' })).json() as MessageSuggestion).templateId, 'G1');

  // Von Hand: ohne Signal → Greenfield; Signal ohne Stelle → „Verstärkung“; null entfernt es wieder.
  const plain = await createLead(server, { mode: 'mock', providerId: 'ACoMSG003', publicIdentifier: 'max-h' });
  assert.equal(plain.hiring, null);
  assert.match(((await suggest(server, plain.id, { kind: 'first' })).json() as MessageSuggestion).templateId ?? '', /^G[12]$/);
  const patch = (payload: object) => server.inject({ method: 'PATCH', url: `/api/leads/${plain.id}`, payload });
  const set = await patch({ hiring: { role: '  ' } });
  assert.equal(set.statusCode, 200, set.body);
  const detail = set.json() as LeadDetailResponse;
  assert.deepEqual(detail.lead.hiring, { role: null, source: 'manual', evidence: null });
  assert.equal(detail.events.at(-1)?.title, 'Sucht Mitarbeiter (von Hand)');
  const manual = (await suggest(server, plain.id, { kind: 'first' })).json() as MessageSuggestion;
  assert.equal(manual.templateId, 'H1');
  assert.match(manual.text, /gerade Verstärkung sucht/);
  assert.equal((await patch({ hiring: { role: 'x'.repeat(81) } })).statusCode, 400);
  const cleared = (await patch({ hiring: null })).json() as LeadDetailResponse;
  assert.equal(cleared.lead.hiring, null);
  assert.equal(cleared.events.at(-1)?.title, 'Sucht keine Mitarbeiter (von Hand)');
  await server.close();
});

test('INVITE_NOTE=off: Tagesstapel meldet die Notiz als ausgeschaltet', async () => {
  const on = app();
  assert.equal(((await on.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse).rules.inviteNote, true);
  const off = app({ INVITE_NOTE: 'off' });
  assert.equal(((await off.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse).rules.inviteNote, false);
  await on.close();
  await off.close();
});

test('Sperre: nach LINKEDIN_INVITES_PER_DAY Anfragen lehnt der Server weitere ab – auch von Hand eingetragen', async () => {
  // Ohne Account-Wechsel (12.10.: Standard an, siehe nächster Test).
  const server = app({ LINKEDIN_INVITES_PER_DAY: '2', LINKEDIN_ACCOUNT_FALLBACK: 'off' });
  const leads = [];
  for (let i = 0; i < 3; i++) leads.push(await createLead(server, { providerId: `ACoLIMIT${i}`, publicIdentifier: `limit-${i}` }));
  assert.equal((await action(server, leads[0].id, { action: 'invite_sent', clientId: 'a' })).statusCode, 200);
  assert.equal((await action(server, leads[1].id, { action: 'invite_sent', clientId: 'b' })).statusCode, 200);
  // Wiederholung derselben Buchung ist kein neuer Versuch.
  assert.equal((await action(server, leads[1].id, { action: 'invite_sent', clientId: 'b' })).statusCode, 200);
  const blocked = await action(server, leads[2].id, { action: 'invite_sent', clientId: 'c' });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'invite_limit');
  assert.match(blocked.json().error.message, /Tageslimit für Vernetzungsanfragen erreicht \(2\)/);
  // Lead bleibt in „Neu“, andere Aktionen gehen weiter.
  assert.equal((await action(server, leads[2].id, { action: 'note', text: 'Morgen vernetzen' })).statusCode, 200);
  const tasks = (await server.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse;
  assert.equal(tasks.rules.invitesPerDay, 2);
  assert.equal(tasks.invitesToday?.nick, 2);
  await server.close();
});

test('Account-Wechsel: ist der eigene Account voll, geht die Anfrage über den des anderen Gründers; „Meine“ zeigt nur die eigenen Plätze', async () => {
  const server = app({ LINKEDIN_INVITES_PER_DAY: '2', NEW_LEADS_PER_DAY: '2' });
  const leads = [];
  for (let i = 0; i < 5; i++) leads.push(await createLead(server, { providerId: `ACoSWITCH${i}`, publicIdentifier: `switch-${i}` }));
  const tasks = async () => (await server.inject({ method: 'GET', url: '/api/tasks?owner=nick' })).json() as TasksResponse;
  const before = await tasks();
  // „Meine“ (24.10.): nur die Plätze des eigenen Accounts – die von Johannes verteilt „Alle“ (Test in tasks.test.ts).
  assert.equal(before.rules.newLeadsPerDay, 2);
  assert.equal(before.inviteVia, 'nick');

  for (const lead of leads.slice(0, 2)) assert.equal((await action(server, lead.id, { action: 'invite_sent' })).statusCode, 200);
  assert.equal((await tasks()).inviteVia, 'johannes', 'eigener Account voll → nächste über Johannes');
  for (const lead of leads.slice(2, 4)) {
    const response = await action(server, lead.id, { action: 'invite_sent' });
    assert.equal(response.statusCode, 200, response.body);
    const detail = (await server.inject({ method: 'GET', url: `/api/leads/${lead.id}` })).json() as LeadDetailResponse;
    assert.equal(detail.lead.linkedin?.sentBy, 'johannes');
    assert.equal(detail.lead.owner, 'nick', 'der Lead bleibt bei Nick');
  }
  const blocked = await action(server, leads[4].id, { action: 'invite_sent' });
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.json().error.message, /Tageslimit für Vernetzungsanfragen erreicht \(2 – auf beiden LinkedIn-Accounts\)/);
  const after = await tasks();
  assert.deepEqual(after.invitesByAccount, { nick: 2, johannes: 2 });
  assert.equal(after.inviteVia, null);
  assert.equal(after.invitesToday?.nick, 4, 'alle heute angeschriebenen eigenen Leads zählen gegen „Meine“ – egal über welchen Account');
  // Johannes' Account ist heute auch für Johannes' eigene Leads voll.
  const johannes = (await server.inject({ method: 'GET', url: '/api/tasks?owner=johannes' })).json() as TasksResponse;
  assert.equal(johannes.inviteVia, null);
  await server.close();
});

test('Nur eingetragene Anfragen nachsenden: zurück auf „Neu“, alte Buchung zählt nicht mehr fürs Tageslimit', async () => {
  const server = app({ LINKEDIN_INVITES_PER_DAY: '2', LINKEDIN_ACCOUNT_FALLBACK: 'off' });
  const a = await createLead(server, { providerId: 'ACoUNSENT1', publicIdentifier: 'unsent-1' });
  const b = await createLead(server, { providerId: 'ACoUNSENT2', publicIdentifier: 'unsent-2' });
  const c = await createLead(server, { providerId: 'ACoUNSENT3', publicIdentifier: 'unsent-3' });
  assert.equal((await action(server, a.id, { action: 'invite_sent' })).statusCode, 200);
  assert.equal((await action(server, b.id, { action: 'invite_sent' })).statusCode, 200);
  assert.equal((await action(server, c.id, { action: 'invite_sent' })).statusCode, 429, 'Limit 2 erreicht');

  const list = (await server.inject({ method: 'GET', url: '/api/leads/unsent-invites?owner=nick' })).json() as UnsentInvitesResponse;
  assert.deepEqual(list.leads.map((lead) => lead.id).sort(), [a.id, b.id].sort());

  const requeue = await server.inject({ method: 'POST', url: '/api/leads/unsent-invites/requeue', payload: { ids: [a.id, b.id, c.id, 'gibts-nicht'] } });
  assert.equal(requeue.statusCode, 200, requeue.body);
  const result = requeue.json() as RequeueInvitesResponse;
  assert.deepEqual(result.requeued.sort(), [a.id, b.id].sort());
  assert.deepEqual(result.skipped.map((entry) => entry.id), [c.id, 'gibts-nicht']);

  const detail = (await server.inject({ method: 'GET', url: `/api/leads/${a.id}` })).json() as LeadDetailResponse;
  assert.equal(detail.lead.stage, 'new');
  assert.equal(detail.lead.lastContactAt, null);
  assert.ok(!detail.events.some((event) => event.kind === 'invite_sent'));
  assert.ok(detail.events.some((event) => event.kind === 'note' && event.title === 'Anfrage nur eingetragen – nicht auf LinkedIn gesendet'));
  assert.match(detail.events.at(-1)?.title ?? '', /^Zurück auf „Neu“/);
  // Tageslimit wieder frei: die alten Buchungen zählen nicht mehr.
  assert.equal((await action(server, c.id, { action: 'invite_sent' })).statusCode, 200);
  assert.deepEqual(((await server.inject({ method: 'GET', url: '/api/leads/unsent-invites' })).json() as UnsentInvitesResponse).leads.map((lead) => lead.id), [c.id]);
  await server.close();
});
