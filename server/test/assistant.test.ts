import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import type { AssistantChatDetail, AssistantChatListResponse, AssistantModelsResponse, AssistantStreamEvent } from '../../shared/assistant.js';
import type { LeadListResponse } from '../../shared/leads.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { AssistantData } from '../src/assistant/data.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { LeadStore } from '../src/leads/leadStore.js';
import { tempDataDir } from './helpers.js';

/** KI-Assistent (`shared/assistant.ts`, Wunsch des Nutzers 22.10.): Chat mit Lesezugriff auf alle Outreach-Daten. */

const servers: Array<{ close: () => void }> = [];
after(() => servers.forEach((server) => server.close()));

function app(env: NodeJS.ProcessEnv = {}, anthropicBaseURL?: string) {
  const dataDir = tempDataDir();
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: dataDir, MOCK_SPEED: '0', AUTH_COOKIE_SECURE: 'false', ...env });
  const server = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: false, ...(anthropicBaseURL ? { messagesTest: { anthropicBaseURL } } : {}) });
  return { server, dataDir };
}
type App = ReturnType<typeof app>['server'];

const events = (body: string): AssistantStreamEvent[] =>
  body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantStreamEvent);

async function newChat(server: App, model?: string): Promise<AssistantChatDetail> {
  const response = await server.inject({ method: 'POST', url: '/api/assistant/chats', payload: model ? { model } : {} });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as AssistantChatDetail;
}

const ask = (server: App, id: string, text: string, model?: string) =>
  server.inject({ method: 'POST', url: `/api/assistant/chats/${id}/messages`, payload: { text, ...(model ? { model } : {}) } });

test('Simulation: Chat anlegen, Frage stellen – Stream mit Werkzeugen, Text und gespeicherter Antwort mit Lead-Link', async () => {
  const { server } = app();
  const models = (await server.inject({ method: 'GET', url: '/api/assistant/models' })).json() as AssistantModelsResponse;
  assert.equal(models.defaultModel, 'claude-opus-5-5');
  assert.ok(models.models.some((model) => model.id === 'claude-opus-5-5'));

  const chat = await newChat(server);
  assert.equal(chat.title, 'Neuer Chat');
  // Die Simulation sucht nach dem längsten Wort der Frage.
  const response = await ask(server, chat.id, 'Bedarf?');
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /text\/event-stream/);
  const stream = events(response.body);
  assert.equal(stream[0].type, 'start');
  assert.deepEqual(
    stream.filter((event) => event.type === 'tool').map((event) => (event as { tool: { tool: string } }).tool.tool),
    ['outreach_analysis', 'search_messages'],
  );
  const text = stream.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('');
  const done = stream.at(-1)!;
  assert.equal(done.type, 'done');
  assert.equal(done.type === 'done' && done.message.text, text, 'gestückelter Text = gespeicherte Antwort');
  assert.match(text, /\[Ralf Ostermann\]\(lead:[^)]+\)/, 'Treffer als Lead-Link');

  const detail = (await server.inject({ method: 'GET', url: `/api/assistant/chats/${chat.id}` })).json() as AssistantChatDetail;
  assert.equal(detail.title, 'Bedarf?');
  assert.deepEqual(detail.messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(detail.messages[1].tools?.length, 2);
  const list = (await server.inject({ method: 'GET', url: '/api/assistant/chats' })).json() as AssistantChatListResponse;
  assert.deepEqual(list.chats.map((entry) => entry.id), [chat.id]);

  assert.equal((await ask(server, chat.id, '')).statusCode, 400);
  assert.equal((await ask(server, 'gibt-es-nicht', 'Hallo')).statusCode, 404);
  assert.equal((await ask(server, chat.id, 'Hallo', 'gpt-5')).statusCode, 400, 'nur Claude-Modelle');
  assert.equal((await server.inject({ method: 'DELETE', url: `/api/assistant/chats/${chat.id}` })).statusCode, 200);
  assert.equal((await server.inject({ method: 'GET', url: `/api/assistant/chats/${chat.id}` })).statusCode, 404);
});

test('Daten: Sequenz-Auswertung je Position, Gesprächsstapel mit Blättern, Suche, Detail – nur im Sichtbereich', async () => {
  const { server, dataDir } = app();
  await server.ready();
  const db = openDatabase(dataDir);
  const data = new AssistantData(new LeadStore(db), db);

  const analysis = data.analysis(null);
  assert.match(analysis, /## Erste Antwort je Position in der Sequenz/);
  assert.match(analysis, /\| 1 \(Erstnachricht\) \| \d+ \| \d+ \|/);
  assert.match(analysis, /## Nach Kategorie/);

  const first = data.conversations(null, { outcome: 'replied', limit: 2 });
  assert.equal(first.count, 2);
  assert.ok(first.total >= 2);
  assert.match(first.text, /^Gespräche 1–2 von \d+ \(Filter: replied\)\. (Weitere mit offset=2\.|Das sind alle\.)/);
  assert.match(first.text, /→ #1/);
  assert.match(first.text, /← /);

  const found = data.searchMessages(null, 'kein Bedarf');
  assert.match(found, /\[Ralf Ostermann\]\(lead:/);
  const ralf = ((await server.inject({ method: 'GET', url: '/api/leads?q=Ostermann' })).json() as LeadListResponse).leads[0];
  assert.match(data.leadDetail(null, ralf.id) ?? '', /Verlauf:/);
  // Mitarbeiter eines anderen Gründers sieht den Lead nicht – weder im Detail noch in der Suche.
  const other = ralf.owner === 'nick' ? 'johannes' : 'nick';
  assert.equal(data.leadDetail([other], ralf.id), null);
  assert.doesNotMatch(data.searchMessages([other], 'kein Bedarf'), /Ostermann/);
  db.close();
});

/** Ein echter Lead mit Gespräch (im echten Betrieb gibt es keine Demo-Leads). */
async function withConversation(server: App) {
  const card = {
    runId: '11111111-1111-4111-8111-111111111111',
    mode: 'live',
    providerId: 'ACoASSIST1',
    publicIdentifier: 'ralf-ostermann',
    profileUrl: 'https://www.linkedin.com/in/ralf-ostermann',
    firstName: 'Ralf',
    lastName: 'Ostermann',
    headline: 'Geschäftsführer · Rotdorn Kapitalanlagen GmbH',
    position: 'Geschäftsführer',
    company: 'Rotdorn Kapitalanlagen GmbH',
    location: 'Köln',
    website: null,
    networkDistance: 2,
    category: 'kapitalanlage_vertrieb',
    confidence: 0.9,
    reason: 'Test',
    summary: 'Test',
    metaAds: null,
  };
  const created = (await server.inject({ method: 'POST', url: '/api/leads', payload: { cards: [card], owner: 'nick' } })).json() as { created: Array<{ id: string }> };
  const id = created.created[0].id;
  for (const payload of [
    { action: 'invite_sent' },
    { action: 'invite_accepted' },
    { action: 'message_sent', text: 'Hallo Ralf, kurze Frage zu euren Leads …', label: 'G1' },
    { action: 'message_received', text: 'Danke, aber kein Bedarf.' },
  ]) {
    assert.equal((await server.inject({ method: 'POST', url: `/api/leads/${id}/events`, payload })).statusCode, 200);
  }
}

/** Nachgebaute Anthropic-API mit Stream (SSE) – antwortet der Reihe nach mit den vorgegebenen Inhalten. */
async function fakeStreamingAnthropic(script: Array<{ content: Array<Record<string, unknown>>; stop_reason: string }>) {
  const requests: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    // Nur Anfragen des Assistenten (mit Werkzeugen) – die Einschätzung neuer Antworten läuft nebenher und bekommt einen Fehler.
    if (!Array.isArray(body.tools)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'nicht im Skript' } }));
      return;
    }
    requests.push({ headers: req.headers, body });
    const step = script[Math.min(requests.length - 1, script.length - 1)];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (data: Record<string, unknown>) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    send({ type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } });
    step.content.forEach((block, index) => {
      if (block.type === 'text') {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
      } else {
        send({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
        send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      }
      send({ type: 'content_block_stop', index });
    });
    send({ type: 'message_delta', delta: { stop_reason: step.stop_reason, stop_sequence: null }, usage: { output_tokens: 200 } });
    send({ type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

test('Live: Claude ruft ein Werkzeug auf, liest das Ergebnis, antwortet – Verlauf wird unverändert wieder mitgeschickt', async () => {
  const fake = await fakeStreamingAnthropic([
    { content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_messages', input: { query: 'kein Bedarf' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Das war **Ralf Ostermann** – er hatte keinen Bedarf.' }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: 'Gern.' }], stop_reason: 'end_turn' },
  ]);
  const { server } = app({ LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'x', ANTHROPIC_API_KEY: 'sk-ant-test' }, fake.baseUrl);
  await withConversation(server);
  const chat = await newChat(server);
  const stream = events((await ask(server, chat.id, 'Wer hatte keinen Bedarf?')).body);
  assert.deepEqual(stream.map((event) => event.type), ['start', 'tool', 'text', 'done']);
  const done = stream.at(-1)!;
  assert.equal(done.type === 'done' && done.message.text, 'Das war **Ralf Ostermann** – er hatte keinen Bedarf.');
  assert.ok(done.type === 'done' && (done.message.costEur ?? 0) > 0, 'Kosten erfasst');

  // Zweite Runde: das Werkzeug-Ergebnis mit dem Lead-Link ging an Claude.
  const second = fake.requests[1].body as { messages: Array<{ role: string; content: unknown }> };
  const toolResult = JSON.stringify(second.messages.at(-1));
  assert.match(toolResult, /tool_result/);
  assert.match(toolResult, /Ralf Ostermann\]\(lead:/);
  // Anfrage: Opus 5.5 mit Effort, Cache, Ausweichmodell bei Ablehnung; das Datum steht in der Frage, nicht im Systemtext.
  const body = fake.requests[0].body as Record<string, unknown> & { system: Array<{ text: string }>; messages: Array<{ content: string }> };
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.equal(body.fallbacks, 'default');
  assert.match(String(fake.requests[0].headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.match(body.messages[0].content, /^Wer hatte keinen Bedarf\?\n\n\(Heute ist /);
  assert.doesNotMatch(body.system[0].text, /Heute ist/);
  assert.equal((body.tools as unknown[]).length, 5);

  // Folgefrage: der ganze bisherige Verlauf (Frage, Werkzeugaufruf, Ergebnis, Antwort) unverändert vorneweg.
  events((await ask(server, chat.id, 'Danke!')).body);
  const third = fake.requests[2].body as { messages: unknown[] };
  assert.equal(third.messages.length, 5);
  assert.deepEqual(third.messages.slice(0, 3), second.messages);
});

test('Live ohne Anthropic-Schlüssel: verständliche Fehlermeldung im Stream, Antwort als fehlgeschlagen gespeichert', async () => {
  const { server } = app({ LEAD_SEARCH_MODE: 'live', UNIPILE_API_KEY: 'x' });
  const chat = await newChat(server);
  const stream = events((await ask(server, chat.id, 'Hallo?')).body);
  const last = stream.at(-1)!;
  assert.equal(last.type, 'error');
  assert.match(last.type === 'error' ? last.message : '', /Anthropic-API-Schlüssel/);
  const detail = (await server.inject({ method: 'GET', url: `/api/assistant/chats/${chat.id}` })).json() as AssistantChatDetail;
  assert.equal(detail.messages[1].failed, true);
});
