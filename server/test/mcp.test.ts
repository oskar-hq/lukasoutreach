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
import { MCP_CHANGEABLE_SETTING_KEYS } from '../src/mcp/settingsTools.js';
import type { SettingsResponse } from '../../shared/settings.js';
import { pkceMatches } from '../src/mcp/oauth.js';
import { tempDataDir } from './helpers.js';

/** MCP-Server für die Claude-App (`shared/mcp.ts`, Wunsch des Nutzers 22.10.): OAuth mit PKCE, Werkzeuge, Trennen. */

const apps: Array<{ close: () => Promise<unknown> }> = [];
after(async () => {
  for (const app of apps) await app.close();
});

function mcpApp() {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), AUTH_DEMO_ACCOUNTS: 'true', AUTH_COOKIE_SECURE: 'false', MOCK_SPEED: '0' });
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
