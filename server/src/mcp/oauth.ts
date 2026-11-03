import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { McpConnection } from '../../../shared/mcp.js';
import type { Database } from '../db/database.js';

/**
 * OAuth 2.1 für den MCP-Server (Vertrag `shared/mcp.ts`, Migration 41): dynamisch registrierte Clients, offene
 * Anmeldeanfragen (warten auf die Freigabe im Cockpit), einmalige Codes mit PKCE (S256) und Token-Paare. Codes und
 * Tokens liegen nur als SHA-256-Hash in der Datenbank – ein Datenbank-Abzug verrät keinen gültigen Zugang.
 */

export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_MS = 8 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

export interface McpClient {
  clientId: string;
  name: string;
  redirectUris: string[];
}

export interface AuthRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string | null;
}

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

/** PKCE S256: base64url(sha256(verifier)) muss der Challenge entsprechen. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

export class McpOAuthStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  registerClient(name: string, redirectUris: string[]): McpClient {
    const clientId = randomUUID();
    this.db.prepare('INSERT INTO mcp_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(clientId, name, JSON.stringify(redirectUris), this.now());
    return { clientId, name, redirectUris };
  }

  client(clientId: string): McpClient | null {
    const row = this.db.prepare('SELECT client_id, name, redirect_uris FROM mcp_clients WHERE client_id = ?').get(clientId) as
      | { client_id: string; name: string; redirect_uris: string }
      | undefined;
    return row ? { clientId: row.client_id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[] } : null;
  }

  createAuthRequest(request: Omit<AuthRequest, 'id'>): AuthRequest {
    this.prune();
    const id = secret();
    this.db
      .prepare('INSERT INTO mcp_auth_requests (id, client_id, redirect_uri, state, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, request.clientId, request.redirectUri, request.state, request.codeChallenge, request.scope, this.now() + AUTH_REQUEST_TTL_MS);
    return { id, ...request };
  }

  authRequest(id: string): AuthRequest | null {
    const row = this.db.prepare('SELECT * FROM mcp_auth_requests WHERE id = ? AND expires_at > ?').get(id, this.now()) as
      | { id: string; client_id: string; redirect_uri: string; state: string | null; code_challenge: string; scope: string | null }
      | undefined;
    return row ? { id: row.id, clientId: row.client_id, redirectUri: row.redirect_uri, state: row.state, codeChallenge: row.code_challenge, scope: row.scope } : null;
  }

  /** Freigabe erteilt: Anfrage verbrauchen, einmaligen Code ausgeben. */
  issueCode(request: AuthRequest, username: string): string {
    const code = secret();
    this.db.prepare('DELETE FROM mcp_auth_requests WHERE id = ?').run(request.id);
    this.db
      .prepare('INSERT INTO mcp_codes (code_hash, client_id, username, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(code), request.clientId, username, request.redirectUri, request.codeChallenge, this.now() + CODE_TTL_MS);
    return code;
  }

  dropAuthRequest(id: string): void {
    this.db.prepare('DELETE FROM mcp_auth_requests WHERE id = ?').run(id);
  }

  /** Code einlösen (einmalig): Client, Rücksprungadresse und PKCE müssen passen. null = ungültig. */
  redeemCode(code: string, clientId: string, redirectUri: string, verifier: string): TokenPair | null {
    const row = this.db.prepare('SELECT * FROM mcp_codes WHERE code_hash = ?').get(hash(code)) as
      | { client_id: string; username: string; redirect_uri: string; code_challenge: string; expires_at: number }
      | undefined;
    if (!row) return null;
    // Immer verbrauchen – auch ein falscher Versuch macht den Code wertlos.
    this.db.prepare('DELETE FROM mcp_codes WHERE code_hash = ?').run(hash(code));
    if (row.expires_at <= this.now() || row.client_id !== clientId || row.redirect_uri !== redirectUri || !pkceMatches(verifier, row.code_challenge)) return null;
    return this.issueTokens(row.client_id, row.username);
  }

  /** Neues Token-Paar gegen das Refresh-Token (das alte Paar ist danach ungültig). */
  refresh(refreshToken: string, clientId: string): TokenPair | null {
    const row = this.db.prepare('SELECT id, client_id, username, refresh_expires_at FROM mcp_tokens WHERE refresh_hash = ?').get(hash(refreshToken)) as
      | { id: string; client_id: string; username: string; refresh_expires_at: number }
      | undefined;
    if (!row || row.client_id !== clientId || row.refresh_expires_at <= this.now()) return null;
    this.db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(row.id);
    return this.issueTokens(row.client_id, row.username, row.id);
  }

  private issueTokens(clientId: string, username: string, keepId?: string): TokenPair {
    const access = secret();
    const refresh = secret();
    const now = this.now();
    this.db
      .prepare(
        'INSERT INTO mcp_tokens (id, client_id, username, access_hash, refresh_hash, access_expires_at, refresh_expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(keepId ?? randomUUID(), clientId, username, hash(access), hash(refresh), now + ACCESS_TTL_MS, now + REFRESH_TTL_MS, now, null);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh };
  }

  /** Konto zum Zugriffstoken – null, wenn unbekannt, abgelaufen oder getrennt. Merkt die letzte Nutzung. */
  userOf(accessToken: string): string | null {
    const row = this.db.prepare('SELECT id, username, access_expires_at FROM mcp_tokens WHERE access_hash = ?').get(hash(accessToken)) as
      | { id: string; username: string; access_expires_at: number }
      | undefined;
    if (!row || row.access_expires_at <= this.now()) return null;
    this.db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(this.now(), row.id);
    return row.username;
  }

  connections(username: string): McpConnection[] {
    const rows = this.db
      .prepare(
        'SELECT t.id, t.created_at, t.last_used_at, c.name FROM mcp_tokens t LEFT JOIN mcp_clients c ON c.client_id = t.client_id WHERE t.username = ? AND t.refresh_expires_at > ? ORDER BY t.created_at DESC',
      )
      .all(username, this.now()) as Array<{ id: string; created_at: number; last_used_at: number | null; name: string | null }>;
    return rows.map((row) => ({ id: row.id, clientName: row.name ?? 'Unbekannter Client', createdAt: row.created_at, lastUsedAt: row.last_used_at }));
  }

  revoke(username: string, id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_tokens WHERE id = ? AND username = ?').run(id, username).changes > 0;
  }

  private prune(): void {
    const now = this.now();
    this.db.prepare('DELETE FROM mcp_auth_requests WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM mcp_codes WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM mcp_tokens WHERE refresh_expires_at <= ?').run(now);
  }
}
