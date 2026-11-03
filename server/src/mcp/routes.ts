import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authRole, workingFounders, type AuthFounderId, type AuthUser } from '../../../shared/auth.js';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { MCP_CONSENT_PARAM, type McpConnectionsResponse, type McpConsentInfo, type McpConsentResult } from '../../../shared/mcp.js';
import { AssistantData } from '../assistant/data.js';
import { publicAccount, type AccountStore } from '../auth/accounts.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { LeadStore } from '../leads/leadStore.js';
import { McpOAuthStore, type TokenPair } from './oauth.js';
import { createMcpServer } from './tools.js';

/**
 * MCP-Server für die Claude-App (Vertrag `shared/mcp.ts`): OAuth 2.1 (Metadaten, dynamische Registrierung, Freigabe im
 * Cockpit, Tokens mit PKCE) und der MCP-Endpunkt `/mcp` (Streamable HTTP, zustandslos – je Anfrage ein Server mit den
 * Werkzeugen des angemeldeten Kontos).
 */

const SCOPE = 'cockpit';
/**
 * Rücksprungadressen (Sicherheitsprüfung 29.10.): nur die Claude-App (https auf claude.ai/claude.com) und lokale
 * Desktop-Clients (http/https auf localhost). Vorher durfte jede https-Adresse rein – dann hätte jemand einen Client
 * „Claude“ mit eigener Rücksprungadresse anlegen und einem Gründer den Freigabe-Link schicken können; ein Klick auf
 * „Freigeben“ hätte ihm den Zugang zum Konto gegeben (Code + eigenes PKCE).
 */
const CLAUDE_REDIRECT_HOST = /^(?:[a-z0-9-]+\.)*(?:claude\.ai|claude\.com)$/;
const LOCAL_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export function allowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (LOCAL_REDIRECT_HOSTS.has(url.hostname)) return url.protocol === 'http:' || url.protocol === 'https:';
  return url.protocol === 'https:' && CLAUDE_REDIRECT_HOST.test(url.hostname);
}
const RedirectUri = z
  .string()
  .url()
  .max(500)
  .refine(allowedRedirectUri, 'Rücksprungadresse muss zur Claude-App gehören (https://claude.ai/…) oder lokal sein (localhost).');
const RegisterSchema = z.object({ client_name: z.string().trim().max(100).optional(), redirect_uris: z.array(RedirectUri).min(1).max(10) });
const AuthorizeSchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().min(1).max(500),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(500).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(500).optional(),
});
const TokenSchema = z.discriminatedUnion('grant_type', [
  z.object({ grant_type: z.literal('authorization_code'), code: z.string().min(1), redirect_uri: z.string().min(1), client_id: z.string().min(1), code_verifier: z.string().min(43).max(128) }),
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().min(1), client_id: z.string().min(1) }),
]);
const IdParams = z.object({ id: z.string().min(1).max(100) });
const ConsentSchema = z.object({ approve: z.boolean() });

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

/** OAuth-Fehler im Format von RFC 6749 (für Clients, nicht für die Oberfläche). */
function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.status(status).header('Cache-Control', 'no-store').send({ error, error_description: description });
}

export function registerMcpRoutes(app: FastifyInstance, { config, db, leads, accounts }: { config: Config; db: Database; leads: LeadStore; accounts: AccountStore }) {
  const oauth = new McpOAuthStore(db);
  const data = new AssistantData(leads, db);

  /** Öffentliche Adresse des Cockpits: `PUBLIC_URL`, sonst aus der Anfrage (lokal http, sonst https hinter Caddy). */
  const baseOf = (request: FastifyRequest) => {
    if (config.auth.publicUrl) return config.auth.publicUrl.replace(/\/+$/, '');
    const host = request.headers.host ?? 'localhost';
    const local = /^(localhost|127\.|\[::1\]|192\.168\.|10\.)/.test(host);
    return `${local ? 'http' : 'https'}://${host}`;
  };
  const metadataUrl = (base: string) => `${base}/.well-known/oauth-protected-resource/mcp`;

  // ── Metadaten ───────────────────────────────────────────────────────────

  const resourceMetadata = async (request: FastifyRequest) => {
    const base = baseOf(request);
    return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Outreach-Cockpit' };
  };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

  const serverMetadata = async (request: FastifyRequest) => {
    const base = baseOf(request);
    return {
      issuer: base,
      authorization_endpoint: `${base}/api/oauth/authorize`,
      token_endpoint: `${base}/api/oauth/token`,
      registration_endpoint: `${base}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
    };
  };
  app.get('/.well-known/oauth-authorization-server', serverMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', serverMetadata);

  // ── OAuth ───────────────────────────────────────────────────────────────

  app.post('/api/oauth/register', async (request, reply) => {
    const body = RegisterSchema.safeParse(request.body ?? {});
    if (!body.success) return oauthError(reply, 400, 'invalid_client_metadata', body.error.issues.map((issue) => issue.message).join(' '));
    const client = oauth.registerClient(body.data.client_name || 'Claude', body.data.redirect_uris);
    request.log.info({ client: client.name }, 'MCP: Client registriert');
    return reply.status(201).header('Cache-Control', 'no-store').send({
      client_id: client.clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // Anmeldeanfrage merken und zur Freigabe ins Cockpit (dort mit Anmeldung). Ungültiger Client/Rücksprung: nie umleiten.
  app.get('/api/oauth/authorize', async (request, reply) => {
    const query = AuthorizeSchema.safeParse(request.query);
    if (!query.success) return reply.status(400).type('text/plain; charset=utf-8').send(`Ungültige Anmeldeanfrage: ${query.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
    const client = oauth.client(query.data.client_id);
    if (!client || !client.redirectUris.includes(query.data.redirect_uri)) return reply.status(400).type('text/plain; charset=utf-8').send('Unbekannter Client oder Rücksprungadresse.');
    const pending = oauth.createAuthRequest({
      clientId: client.clientId,
      redirectUri: query.data.redirect_uri,
      state: query.data.state ?? null,
      codeChallenge: query.data.code_challenge,
      scope: query.data.scope ?? null,
    });
    return reply.redirect(`${baseOf(request)}/?${MCP_CONSENT_PARAM}=${encodeURIComponent(pending.id)}`, 302);
  });

  app.get('/api/oauth/consent/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const pending = params.success ? oauth.authRequest(params.data.id) : null;
    const client = pending ? oauth.client(pending.clientId) : null;
    if (!pending || !client) return sendError(reply, 404, 'not_found', 'Diese Anfrage ist abgelaufen – starte die Verbindung in der Claude-App neu.');
    const body: McpConsentInfo = { clientName: client.name, redirectHost: new URL(pending.redirectUri).host };
    return body;
  });

  app.post('/api/oauth/consent/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const body = ConsentSchema.safeParse(request.body ?? {});
    const pending = params.success ? oauth.authRequest(params.data.id) : null;
    if (!pending || !body.success) return sendError(reply, 404, 'not_found', 'Diese Anfrage ist abgelaufen – starte die Verbindung in der Claude-App neu.');
    const user = request.authUser;
    if (!user) return sendError(reply, 401, 'unauthorized', 'Bitte zuerst anmelden.');
    const target = new URL(pending.redirectUri);
    if (body.data.approve) {
      target.searchParams.set('code', oauth.issueCode(pending, user.username));
      request.log.info({ username: user.username }, 'MCP: Verbindung freigegeben');
    } else {
      oauth.dropAuthRequest(pending.id);
      target.searchParams.set('error', 'access_denied');
    }
    if (pending.state) target.searchParams.set('state', pending.state);
    const result: McpConsentResult = { redirect: target.toString() };
    return result;
  });

  // Token-Abruf als Formular (application/x-www-form-urlencoded) wie im Standard – zusätzlich zu JSON. Der Parser gilt nur
  // in diesem gekapselten Teil: Für alle anderen Routen bleiben Formulare abgelehnt (Schutz vor Formular-CSRF).
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    scope.post('/api/oauth/token', async (request, reply) => {
      const body = TokenSchema.safeParse(request.body ?? {});
      if (!body.success) return oauthError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
      let tokens: TokenPair | null;
      if (body.data.grant_type === 'authorization_code') {
        tokens = oauth.redeemCode(body.data.code, body.data.client_id, body.data.redirect_uri, body.data.code_verifier);
      } else {
        tokens = oauth.refresh(body.data.refresh_token, body.data.client_id);
      }
      if (!tokens) return oauthError(reply, 400, 'invalid_grant', 'Code oder Token ungültig oder abgelaufen.');
      return reply.header('Cache-Control', 'no-store').send({ ...tokens, scope: SCOPE });
    });
  });

  // ── Verbindungen ────────────────────────────────────────────────────────

  app.get('/api/mcp/connections', async (request, reply) => {
    const user = request.authUser;
    if (!user) return sendError(reply, 401, 'unauthorized', 'Bitte zuerst anmelden.');
    const body: McpConnectionsResponse = { url: `${baseOf(request)}/mcp`, connections: oauth.connections(user.username) };
    return body;
  });

  app.delete('/api/mcp/connections/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const user = request.authUser;
    if (!user) return sendError(reply, 401, 'unauthorized', 'Bitte zuerst anmelden.');
    if (!params.success || !oauth.revoke(user.username, params.data.id)) return sendError(reply, 404, 'not_found', 'Diese Verbindung gibt es nicht (mehr).');
    request.log.info({ username: user.username }, 'MCP: Verbindung getrennt');
    return { ok: true };
  });

  // ── MCP ─────────────────────────────────────────────────────────────────

  const unauthorized = (request: FastifyRequest, reply: FastifyReply, error?: string) =>
    reply
      .status(401)
      .header('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl(baseOf(request))}"${error ? `, error="${error}"` : ''}`)
      .send({ error: 'unauthorized', error_description: 'Anmeldung nötig – verbinde den Connector in der Claude-App.' });

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return unauthorized(request, reply);
    const username = oauth.userOf(token);
    const account = username ? accounts.find(username) : null;
    if (!account) return unauthorized(request, reply, 'invalid_token');
    const user: AuthUser = publicAccount(account);
    if (user.awaitingApproval) return reply.status(403).send({ error: 'forbidden', error_description: 'Dein Konto ist noch nicht freigegeben.' });
    const scope: AuthFounderId[] | null = authRole(user) === 'assistant' ? workingFounders(user) : null;

    const server = createMcpServer({ app, user, scope, data, baseUrl: baseOf(request) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };
  app.post('/mcp', handle);
  app.get('/mcp', handle);
  app.delete('/mcp', handle);
}
