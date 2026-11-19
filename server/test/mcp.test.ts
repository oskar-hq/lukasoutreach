import type { TasksResponse } from '../../shared/tasks.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LeadListResponse } from '../../shared/leads.js';
import type { McpConnectionsResponse, McpConsentInfo, McpConsentResult } from '../../shared/mcp.js';
import { openDatabase } from '../src/db/database.js';
import { SessionStore } from '../src/auth/sessions.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { berlinMorning } from '../src/mcp/tools.js';
import { captureLog } from '../src/telemetry/logs.js';
import { MCP_CHANGEABLE_SETTING_KEYS } from '../src/mcp/settingsTools.js';
import type { SettingsResponse } from '../../shared/settings.js';
import { pkceMatches } from '../src/mcp/oauth.js';
import { tempDataDir } from './helpers.js';

/** MCP-Server für die Claude-App (`shared/mcp.ts`, Wunsch des Nutzers 22.10.): OAuth mit PKCE, Werkzeuge, Trennen. */

const apps: Array<{ close: () => Promise<unknown> }> = [];
after(async () => {
  for (const app of apps) await app.close();
});

function mcpApp(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false', MOCK_SPEED: '0', ...env });
  const app = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: true });
  apps.push(app);
  return app;
}
type App = ReturnType<typeof mcpApp>;

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function login(app: App, username: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'demo' } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
}

/** Kompletter Anmeldeablauf wie die Claude-App: registrieren, authorize, Freigabe im Cockpit, Code gegen Tokens. */
async function connect(app: App, username = 'nick') {
  const registered = await app.inject({ method: 'POST', url: '/api/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
  assert.equal(registered.statusCode, 201, registered.body);
  const clientId = (registered.json() as { client_id: string }).client_id;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  const authorize = await app.inject({ method: 'GET', url: `/api/oauth/authorize?${query}` });
  assert.equal(authorize.statusCode, 302, authorize.body);
  const consentId = new URL(String(authorize.headers.location)).searchParams.get('mcp_consent')!;
  assert.ok(consentId);

  // Ohne Anmeldung keine Freigabe.
  assert.equal((await app.inject({ method: 'GET', url: `/api/oauth/consent/${consentId}` })).statusCode, 401);
  const cookie = await login(app, username);
  const info = (await app.inject({ method: 'GET', url: `/api/oauth/consent/${consentId}`, headers: { cookie } })).json() as McpConsentInfo;
  assert.deepEqual(info, { clientName: 'Claude', redirectHost: 'claude.ai' });
  const decided = await app.inject({ method: 'POST', url: `/api/oauth/consent/${consentId}`, headers: { cookie }, payload: { approve: true } });
  assert.equal(decided.statusCode, 200, decided.body);
  const back = new URL((decided.json() as McpConsentResult).redirect);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const code = back.searchParams.get('code')!;

  // Token-Abruf als Formular (wie im Standard).
  const form = (fields: Record<string, string>) => ({
    method: 'POST' as const,
    url: '/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
  const wrong = await app.inject(form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: 'x'.repeat(43) }));
  assert.equal(wrong.statusCode, 400, 'falscher PKCE-Verifier');
  assert.equal((wrong.json() as { error: string }).error, 'invalid_grant');
  // Der falsche Versuch hat den Code verbraucht → neu freigeben.
  const again = await app.inject({ method: 'GET', url: `/api/oauth/authorize?${query}` });
  const againId = new URL(String(again.headers.location)).searchParams.get('mcp_consent')!;
  const code2 = new URL(
    ((await app.inject({ method: 'POST', url: `/api/oauth/consent/${againId}`, headers: { cookie }, payload: { approve: true } })).json() as McpConsentResult).redirect,
  ).searchParams.get('code')!;
  const token = await app.inject(form({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }));
  assert.equal(token.statusCode, 200, token.body);
  assert.equal(token.headers['cache-control'], 'no-store');
  const tokens = token.json() as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(tokens.token_type, 'Bearer');
  return { clientId, cookie, tokens };
}

async function mcpClient(app: App, accessToken: string) {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  await client.connect(transport);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join('\n');

test('Metadaten: Ressource und Anmeldeserver nach RFC 9728/8414', async () => {
  const app = mcpApp();
  const resource = (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp', headers: { host: 'localhost:8787' } })).json() as {
    resource: string;
    authorization_servers: string[];
  };
  assert.equal(resource.resource, 'http://localhost:8787/mcp');
  assert.deepEqual(resource.authorization_servers, ['http://localhost:8787']);
  const server = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'crm.example.de' } })).json() as Record<string, unknown>;
  assert.equal(server.issuer, 'https://crm.example.de');
  assert.equal(server.token_endpoint, 'https://crm.example.de/api/oauth/token');
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
});

test('Ohne Token: 401 mit Verweis auf die Metadaten; ungültige Anfragen werden nicht umgeleitet', async () => {
  const app = mcpApp();
  const response = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'localhost' }, payload: {} });
  assert.equal(response.statusCode, 401);
  assert.match(String(response.headers['www-authenticate']), /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/);
  const bad = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer falsch' }, payload: {} });
  assert.equal(bad.statusCode, 401);

  assert.equal((await app.inject({ method: 'POST', url: '/api/oauth/register', payload: { redirect_uris: ['http://evil.example/cb'] } })).statusCode, 400, 'nur https');
  // Sicherheitsprüfung 29.10.: nur Claude-App und lokale Clients – keine fremde https-Adresse, kein Täuschen per Subdomain.
  for (const uri of ['https://evil.example/cb', 'https://claude.ai.evil.example/cb', 'https://evilclaude.ai/cb', 'https://user@claude.ai/cb', 'http://claude.ai/cb']) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/oauth/register', payload: { redirect_uris: [uri] } })).statusCode, 400, uri);
  }
  for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'http://localhost:33418/callback', 'http://127.0.0.1:5555/cb']) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/oauth/register', payload: { redirect_uris: [uri] } })).statusCode, 201, uri);
  }
  // Formulare nur am Token-Endpunkt – sonst bleibt Formular-CSRF auf /api/* ausgeschlossen.
  const cookie = await login(app, 'nick');
  const form = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=b' });
  assert.equal(form.statusCode, 415);
  const query = new URLSearchParams({ response_type: 'code', client_id: 'unbekannt', redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
  assert.equal((await app.inject({ method: 'GET', url: `/api/oauth/authorize?${query}` })).statusCode, 400);
});

test('Ablehnen: zurück zu Claude mit access_denied', async () => {
  const app = mcpApp();
  const registered = (await app.inject({ method: 'POST', url: '/api/oauth/register', payload: { redirect_uris: [REDIRECT] } })).json() as { client_id: string };
  const query = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 's' });
  const id = new URL(String((await app.inject({ method: 'GET', url: `/api/oauth/authorize?${query}` })).headers.location)).searchParams.get('mcp_consent');
  const cookie = await login(app, 'nick');
  const result = (await app.inject({ method: 'POST', url: `/api/oauth/consent/${id}`, headers: { cookie }, payload: { approve: false } })).json() as McpConsentResult;
  const back = new URL(result.redirect);
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('code'), null);
  assert.equal((await app.inject({ method: 'GET', url: `/api/oauth/consent/${id}`, headers: { cookie } })).statusCode, 404, 'Anfrage verbraucht');
});

test('todays_tasks: „Braucht Aufmerksamkeit“ gekürzt – Anzahl je Grund, älteste zuerst, weiterblättern', async () => {
  // 10.11.: 433 Einträge = 74.712 Zeichen – zu groß für die Claude-App. Hier zählt jede offene Anfrage schon nach
  // einem Tag, damit die Demo-Daten sicher mehrere Einträge liefern.
  const app = mcpApp({ INVITE_STALE_DAYS: '1', FOLLOWUP_AFTER_DAYS: '1', MAX_FOLLOW_UPS: '0' });
  const { cookie, tokens } = await connect(app);
  const client = await mcpClient(app, tokens.access_token);
  try {
    const all = (await app.inject({ method: 'GET', url: '/api/tasks?owner=all', headers: { cookie } })).json() as TasksResponse;
    assert.ok(all.attention.length >= 2, 'Demo-Daten mit „Braucht Aufmerksamkeit“');
    const short = textOf(await client.callTool({ name: 'todays_tasks', arguments: { scope: 'all', attention_limit: 1 } }));
    const attentionLines = (text: string) => text.slice(text.indexOf('## Braucht Aufmerksamkeit')).split('\n').filter((line) => line.startsWith('- '));
    assert.match(short, new RegExp(`## Braucht Aufmerksamkeit \\(${all.attention.length}\\)`));
    assert.match(short, /\d+ × /, 'Anzahl je Grund');
    assert.equal(attentionLines(short).length, 1);
    assert.match(short, new RegExp(`… und ${all.attention.length - 1} weitere – mit attention_offset: 1 weiterblättern`));
    const paged = textOf(await client.callTool({ name: 'todays_tasks', arguments: { scope: 'all', attention_limit: 100, attention_offset: 1 } }));
    assert.equal(attentionLines(paged).length, all.attention.length - 1);
    assert.doesNotMatch(paged, /weiterblättern/);
  } finally {
    await client.close();
  }
});

test('Claude-App: Aufgaben lesen, Notiz schreiben, Nachricht eintragen, Wiedervorlage – dann Token erneuern und trennen', async () => {
  const app = mcpApp();
  const { clientId, cookie, tokens } = await connect(app);
  const client = await mcpClient(app, tokens.access_token);

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['todays_tasks', 'read_conversations', 'send_message', 'add_note', 'schedule_follow_up', 'mark_lost']) assert.ok(tools.includes(name), name);

  const tasks = await client.callTool({ name: 'todays_tasks', arguments: {} });
  assert.match(textOf(tasks), /# Aufgaben/);

  const leads = (await app.inject({ method: 'GET', url: '/api/leads', headers: { cookie } })).json() as LeadListResponse;
  const lead = leads.leads.find((entry) => entry.owner === 'nick' && entry.stage !== 'lost') ?? leads.leads[0];
  assert.ok(lead, 'Demo-Leads vorhanden');

  const note = await client.callTool({ name: 'add_note', arguments: { lead_id: lead.id, text: 'Aus der Claude-App' } });
  assert.ok(!note.isError, textOf(note));
  assert.match(textOf(note), /Notiz gespeichert/);
  assert.match(textOf(note), new RegExp(`/\\?lead=${lead.id}`), 'Lead-Link ins Cockpit');

  const sent = await client.callTool({ name: 'send_message', arguments: { lead_id: lead.id, text: 'Hallo, kurze Frage …', only_record: true } });
  assert.ok(!sent.isError, textOf(sent));
  assert.match(textOf(sent), /Nachricht eingetragen/);

  const followUp = await client.callTool({ name: 'schedule_follow_up', arguments: { lead_id: lead.id, in_days: 14 } });
  assert.ok(!followUp.isError, textOf(followUp));
  assert.match(textOf(followUp), /Wiedervorlage/);

  const unknown = await client.callTool({ name: 'add_note', arguments: { lead_id: 'gibt-es-nicht', text: 'x' } });
  assert.ok(unknown.isError, 'unbekannter Lead → Fehler');
  await client.close();

  // Verbindungen: eine, mit Adresse zum Eintragen.
  const list = (await app.inject({ method: 'GET', url: '/api/mcp/connections', headers: { cookie } })).json() as McpConnectionsResponse;
  assert.equal(list.connections.length, 1);
  assert.match(list.url, /\/mcp$/);
  assert.ok(list.connections[0].lastUsedAt);

  // Erneuern: neues Paar, altes Zugriffstoken ungültig, gleiche Verbindung.
  const refreshed = await app.inject({ method: 'POST', url: '/api/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId } });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const next = refreshed.json() as { access_token: string };
  assert.equal((await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${tokens.access_token}` }, payload: {} })).statusCode, 401);
  const after = (await app.inject({ method: 'GET', url: '/api/mcp/connections', headers: { cookie } })).json() as McpConnectionsResponse;
  assert.deepEqual(after.connections.map((entry) => entry.id), list.connections.map((entry) => entry.id));
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId } })).statusCode,
    400,
    'altes Refresh-Token verbraucht',
  );

  // Trennen: Token sofort ungültig; fremde Konten können nicht trennen.
  const other = await login(app, 'johannes');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/mcp/connections/${list.connections[0].id}`, headers: { cookie: other } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/mcp/connections/${list.connections[0].id}`, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${next.access_token}` }, payload: {} })).statusCode, 401);
});

test('Einstellungen per Claude-App (31.10.): nachsehen, ändern, Grenzen prüfen, Geheimnisse nur in der Oberfläche', async () => {
  const app = mcpApp();
  const { tokens, cookie } = await connect(app);
  const client = await mcpClient(app, tokens.access_token);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['find_settings', 'change_setting', 'change_auto_search', 'change_account_limits']) assert.ok(tools.includes(name), name);
  assert.ok(MCP_CHANGEABLE_SETTING_KEYS.includes('NEW_LEADS_PER_DAY'));
  assert.ok(!MCP_CHANGEABLE_SETTING_KEYS.includes('ANTHROPIC_API_KEY'));

  const found = textOf(await client.callTool({ name: 'find_settings', arguments: {} }));
  assert.match(found, /\*\*Neue Leads pro Tag\*\* · key NEW_LEADS_PER_DAY/);
  assert.match(found, /## Automatische Suche/);
  assert.match(found, /account_id /);
  assert.match(found, /Zugangsschlüssel – nur in der Oberfläche/);

  const changed = await client.callTool({ name: 'change_setting', arguments: { key: 'NEW_LEADS_PER_DAY', value: '12' } });
  assert.ok(!changed.isError, textOf(changed));
  assert.match(textOf(changed), /auf 12/);
  const settings = (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json() as SettingsResponse;
  assert.equal(settings.settings.find((state) => state.key === 'NEW_LEADS_PER_DAY')?.value, 12);

  const tooMany = await client.callTool({ name: 'change_setting', arguments: { key: 'NEW_LEADS_PER_DAY', value: 5000 } });
  assert.ok(tooMany.isError);
  assert.match(textOf(tooMany), /Höchstens 100/);

  const secret = await client.callTool({ name: 'change_setting', arguments: { key: 'ANTHROPIC_API_KEY', value: 'sk-test' } });
  assert.ok(secret.isError);
  assert.match(textOf(secret), /nur in der Oberfläche/);

  // Sicherung ausschalten braucht das Passwort → nur in der Oberfläche, nichts geändert.
  const backup = await client.callTool({ name: 'change_setting', arguments: { key: 'BACKUP_HOUR_UTC', value: 'off' } });
  assert.ok(backup.isError);
  assert.match(textOf(backup), /Passwort – nur in der Oberfläche/);
  const unchanged = (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json() as SettingsResponse;
  assert.notEqual(unchanged.settings.find((state) => state.key === 'BACKUP_HOUR_UTC')?.value, 'off');

  // Optimierungs-Bericht per Claude-App (09.11.): ganz und nur einzelne Abschnitte.
  assert.ok(tools.includes('optimization_report'));
  const report = textOf(await client.callTool({ name: 'optimization_report', arguments: { days: 7 } }));
  assert.match(report, /^# Optimierungs-Bericht/);
  assert.match(report, /## Läufe der Lead-Suche/);
  const part = textOf(await client.callTool({ name: 'optimization_report', arguments: { sections: ['linkedin'] } }));
  assert.match(part, /## Wohin die LinkedIn-Abrufe gingen/);
  assert.ok(!part.includes('## Läufe der Lead-Suche'), 'nur gewünschte Abschnitte');
  assert.match(textOf(await client.callTool({ name: 'optimization_report', arguments: { sections: ['gibtsnicht'] } })), /Kein Abschnitt passt.*Vorhanden: /);

  // Nutzungs-Bericht per Claude-App (09.11.).
  assert.ok(tools.includes('usage_report'));
  const usage = textOf(await client.callTool({ name: 'usage_report', arguments: { sections: ['API'] } }));
  assert.match(usage, /^# Nutzungs-Bericht/);
  assert.match(usage, /## API \(Server\)/);
  assert.ok(!usage.includes('## Ansichten'));

  // Systemzustand, Neuigkeiten, Server-Logs per Claude-App (09.11.).
  for (const name of ['system_status', 'notifications', 'server_logs']) assert.ok(tools.includes(name), name);
  const status = textOf(await client.callTool({ name: 'system_status', arguments: {} }));
  assert.match(status, /^# Systemzustand/);
  assert.match(status, /## Lead-Suche/);
  assert.match(status, /## Update und Speicher/);
  assert.ok(!(await client.callTool({ name: 'notifications', arguments: {} })).isError);
  captureLog([{ err: new Error('Anthropic-Guthaben aufgebraucht') }, 'Neuer LinkedIn-Kontakt nicht übernommen'], 40);
  captureLog(['Schlüssel sk-ant-abcdefghijklmnop123 gesehen'], 50);
  const logs = textOf(await client.callTool({ name: 'server_logs', arguments: { contains: 'Kontakt' } }));
  assert.match(logs, /\[warn\] Neuer LinkedIn-Kontakt nicht übernommen/);
  assert.match(logs, /Anthropic-Guthaben aufgebraucht/);
  const errors = textOf(await client.callTool({ name: 'server_logs', arguments: { level: 'error' } }));
  assert.match(errors, /\[geschwärzt\]/);
  assert.ok(!errors.includes('sk-ant-abcdefghijklmnop123'), 'Schlüssel geschwärzt');

  // Feedback (09.11.): aus der Oberfläche mit Bild und Zusammenhang, aus der Claude-App, lesen, Stand setzen → Glocke.
  for (const name of ['submit_feedback', 'list_feedback', 'feedback_detail', 'update_feedback']) assert.ok(tools.includes(name), name);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const posted = await app.inject({
    method: 'POST',
    url: '/api/feedback',
    headers: { cookie },
    payload: { text: 'Beim Klick auf Senden passiert nichts', context: { view: 'focus', leadId: 'lead-1', trail: ['12:00:01 click followup-send (focus)'], errors: ['POST /api/leads/:id/events → 500'] }, images: [png, 'kaputt'] },
  });
  assert.equal(posted.statusCode, 201, posted.body);
  const created = posted.json() as { number: number; kind: string; imageCount: number };
  assert.equal(created.kind, 'bug', 'mit Fehlern im Zusammenhang → Fehler');
  assert.equal(created.imageCount, 1, 'kaputtes Bild verworfen');
  const viaChat = textOf(await client.callTool({ name: 'submit_feedback', arguments: { text: 'Bitte Follow-ups auch am Wochenende', kind: 'wish' } }));
  assert.match(viaChat, /Gemeldet als #2/);
  const open = textOf(await client.callTool({ name: 'list_feedback', arguments: {} }));
  assert.match(open, /#1.*Etwas geht nicht · Eingegangen/);
  assert.match(open, /#2.*Idee \/ Wunsch/);
  const detail = await client.callTool({ name: 'feedback_detail', arguments: { id: '1' } });
  const parts = detail.content as Array<{ type: string; text?: string; mimeType?: string }>;
  assert.match(parts[0].text!, /click followup-send \(focus\)/);
  assert.match(parts[0].text!, /POST \/api\/leads\/:id\/events → 500/);
  assert.match(parts[0].text!, /offener Lead: lead-1/);
  assert.equal(parts.filter((part) => part.type === 'image' && part.mimeType === 'image/png').length, 1, 'Bild kommt mit');
  const done = textOf(await client.callTool({ name: 'update_feedback', arguments: { id: '#1', status: 'done', answer: 'Ist behoben, ab dem nächsten Update da.' } }));
  assert.match(done, /#1: Erledigt/);
  const bell = (await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie } })).json() as { notifications: Array<{ title: string; text: string }> };
  assert.ok(bell.notifications.some((item) => item.title === 'Deine Meldung #1: Erledigt' && item.text === 'Ist behoben, ab dem nächsten Update da.'), 'Melder sieht es in der Glocke');
  assert.ok(!bell.notifications.some((item) => item.title.startsWith('Feedback #1 von')), 'neues Feedback #1 ist erledigt');
  assert.equal((await app.inject({ method: 'GET', url: '/api/feedback/1/images/1', headers: { cookie } })).headers['content-type'], 'image/png');

  // Update per Claude-App (09.11.): dieselbe Route wie der Knopf – ohne Update-Dienst ein klarer Satz.
  assert.ok(tools.includes('start_update'));
  const update = await client.callTool({ name: 'start_update', arguments: {} });
  assert.match(textOf(update), /Update gestartet|Schon aktuell|läuft schon|Update-Dienst/);

  const auto = await client.callTool({ name: 'change_auto_search', arguments: { founder: 'nick', time: '09:30', kapitalanlage_percent: 70 } });
  assert.ok(!auto.isError, textOf(auto));
  assert.match(textOf(auto), /09:30/);
  assert.match(textOf(auto), /70 % Kapitalanlage/);
  await client.close();
});

test('Hilfen: PKCE und 8:00 Uhr Berliner Zeit (Sommer- und Winterzeit)', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.ok(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
  assert.ok(!pkceMatches('anders', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
  assert.equal(new Date(berlinMorning('2026-07-01')).toISOString(), '2026-07-01T06:00:00.000Z');
  assert.equal(new Date(berlinMorning('2026-12-01')).toISOString(), '2026-12-01T07:00:00.000Z');
});

test('Sicherheitsprüfung 29.10.: Sitzungen beenden (Passwort neu, Konto entfernt) trennt auch die Claude-App', async () => {
  const dataDir = tempDataDir();
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: dataDir, AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false', MOCK_SPEED: '0' });
  const app = buildApp({ config, adapter: new MockAdapter(0), logger: false, requireSession: true });
  apps.push(app);
  const { tokens, clientId } = await connect(app);
  const call = () => app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${tokens.access_token}` }, payload: {} });
  assert.notEqual((await call()).statusCode, 401, 'vorher verbunden');
  const db = openDatabase(dataDir);
  new SessionStore(db).deleteForUser('nick');
  db.close();
  assert.equal((await call()).statusCode, 401, 'Zugriffstoken ungültig');
  const refreshed = await app.inject({ method: 'POST', url: '/api/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId } });
  assert.equal(refreshed.statusCode, 400, 'Refresh-Token ungültig');
});

test('Claude-App: Leads aus einer Liste – add_lead, import_leads, import_status, set_lead_fields (Lukas-Instanz 19.11.)', async () => {
  const app = mcpApp();
  const { tokens } = await connect(app);
  const client = await mcpClient(app, tokens.access_token);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ['add_lead', 'import_leads', 'import_status', 'set_lead_fields']) assert.ok(tools.includes(name), name);

    const added = textOf(await client.callTool({ name: 'add_lead', arguments: { profile: 'https://www.linkedin.com/in/mcp-gruenderin', category: 'startup_gruender', fields: { welle: '1' } } }));
    assert.match(added, /^Angelegt: /);
    const leadId = added.match(/lead_id: ([^)\s]+)/)![1];
    const detail = textOf(await client.callTool({ name: 'lead_detail', arguments: { lead_id: leadId } }));
    assert.match(detail, /Felder: welle=1 · kategorie=startup_gruender/);

    const imported = textOf(await client.callTool({ name: 'import_leads', arguments: { items: [{ profile: 'mcp-gruenderin' }, { profile: 'mcp-marketing' }, { profile: 'https://example.com/x' }] } }));
    assert.match(imported, /# Import: 1 eingereiht, 1 Dubletten, 1 Fehler/);
    await app.leadImports.tick();
    const status = textOf(await client.callTool({ name: 'import_status', arguments: {} }));
    assert.match(status, /1 angelegt, 0 Dubletten, 0 Fehler, 0 warten/);

    const fields = textOf(await client.callTool({ name: 'set_lead_fields', arguments: { lead_id: leadId, fields: { testgruppe: 'B' } } }));
    assert.match(fields, /testgruppe: B/);
  } finally {
    await client.close();
  }
});

test('Claude-App: Vorlagen anlegen, ändern, löschen (Lukas-Instanz 19.11.)', async () => {
  const app = mcpApp({ LEAD_FIELDS: 'aufhaenger' });
  const { tokens } = await connect(app);
  const client = await mcpClient(app, tokens.access_token);
  try {
    const listed = textOf(await client.callTool({ name: 'list_templates', arguments: {} }));
    assert.match(listed, /^Platzhalter: .*\{\{aufhaenger\}\}, \{\{kategorie\}\}/);
    const created = textOf(await client.callTool({ name: 'create_template', arguments: { category: 'first_greenfield', name: 'VC · Funding', text: 'Hi {{vorname}}, {{aufhaenger}}' } }));
    assert.match(created, /^Angelegt:\n### (\S+) · VC · Funding/);
    const id = created.match(/### (\S+) ·/)![1];
    const updated = textOf(await client.callTool({ name: 'update_template', arguments: { template_id: id, text: 'Hallo {{vorname}}, {{aufhaenger}}!' } }));
    assert.match(updated, /Hallo \{\{vorname\}\}, \{\{aufhaenger\}\}!/);
    const bad = await client.callTool({ name: 'update_template', arguments: { template_id: id, text: 'Hi {{unbekannt}}' } });
    assert.equal(bad.isError, true);
    assert.match(textOf(await client.callTool({ name: 'delete_template', arguments: { template_id: id } })), /gelöscht/);
  } finally {
    await client.close();
  }
});

test('Claude-App: eigene Kategorien und freie Felder – filtern und auswerten (Lukas-Instanz 19.11.)', async () => {
  const app = mcpApp({ LEAD_CATEGORY_LIST: 'startup_gruender, vc_platform' });
  const { cookie, tokens } = await connect(app);
  const client = await mcpClient(app, tokens.access_token);
  try {
    const bad = await client.callTool({ name: 'add_lead', arguments: { profile: 'kat-falsch', category: 'kapitalanlage' } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /Unbekannte Kategorie „kapitalanlage“ – erlaubt: startup_gruender, vc_platform/);
    for (const [profile, category, gruppe] of [['kat-a', 'startup_gruender', 'A'], ['kat-b', 'startup_gruender', 'B'], ['kat-c', 'vc_platform', 'A']]) {
      assert.match(textOf(await client.callTool({ name: 'add_lead', arguments: { profile, category, fields: { testgruppe: gruppe } } })), /^Angelegt/);
    }
    const imported = textOf(await client.callTool({ name: 'import_leads', arguments: { items: [{ profile: 'kat-d', category: 'falsch' }, { profile: 'kat-e', category: 'vc_platform' }] } }));
    assert.match(imported, /1 eingereiht, 0 Dubletten, 1 Fehler/);

    const founders = textOf(await client.callTool({ name: 'find_leads', arguments: { category: 'startup_gruender' } }));
    assert.match(founders, /^2 Leads/);
    assert.match(founders, /kategorie=startup_gruender/);
    const groupA = textOf(await client.callTool({ name: 'find_leads', arguments: { fields: { testgruppe: 'A' } } }));
    assert.match(groupA, /^2 Leads/);

    // Erstnachricht eintragen, eine Antwort – dann je Testgruppe auswerten.
    const leads = (await app.inject({ method: 'GET', url: '/api/leads?limit=500', headers: { cookie } })).json() as LeadListResponse;
    const byProfile = (id: string) => leads.leads.find((lead) => lead.person.publicIdentifier === id)!;
    for (const id of ['kat-a', 'kat-b']) {
      const lead = byProfile(id);
      assert.ok(lead, id);
      await client.callTool({ name: 'send_message', arguments: { lead_id: lead.id, text: 'Hallo!', only_record: true } });
    }
    await client.callTool({ name: 'record_reply', arguments: { lead_id: byProfile('kat-a').id, text: 'Gern!' } });
    const analysis = textOf(await client.callTool({ name: 'outreach_analysis', arguments: { group_by: ['testgruppe'], category: 'startup_gruender' } }));
    assert.match(analysis, /## Nach Feld „testgruppe“/);
    assert.match(analysis, /\| A \| 1 \| 1 \(100 %\)/);
    assert.match(analysis, /\| B \| 1 \| 0 \(0 %\)/);
    const conversations = textOf(await client.callTool({ name: 'read_conversations', arguments: { fields: { testgruppe: 'B' } } }));
    assert.match(conversations, /von 1 \(Filter: all, testgruppe=B\)/);
  } finally {
    await client.close();
  }
});

test('Claude-App: Sender per Name statt ID (Lukas-Instanz 19.11.)', async () => {
  const app = mcpApp();
  const { tokens } = await connect(app);
  const client = await mcpClient(app, tokens.access_token);
  try {
    const added = textOf(await client.callTool({ name: 'add_lead', arguments: { profile: 'sender-name', owner: 'Johannes' } }));
    assert.match(added, /^Angelegt/);
    const leadId = added.match(/lead_id: ([^)\s]+)/)![1];
    const detail = textOf(await client.callTool({ name: 'lead_detail', arguments: { lead_id: leadId } }));
    assert.match(detail.split('\n')[0], /· Johannes$/);
    const unknown = await client.callTool({ name: 'add_lead', arguments: { profile: 'sender-x', owner: 'Lukas' } });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /Unbekannter Sender „Lukas“ – bekannt: Nick \(nick\), Johannes \(johannes\)/);
  } finally {
    await client.close();
  }
});
