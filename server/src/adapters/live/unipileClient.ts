import { CancelledError } from '../../pipeline/adapter.js';

/**
 * Schlanker Client für die Unipile-API (v1). Nur dokumentierte Endpunkte:
 * - GET  /api/v1/accounts                         – verbundene Accounts
 * - GET  /api/v1/linkedin/search/parameters       – IDs für Region u. a. (type=LOCATION | REGION …)
 * - POST /api/v1/linkedin/search                  – Personensuche (classic / sales_navigator)
 * - GET  /api/v1/users/invite/sent                – gesendete, offene Vernetzungsanfragen
 * - GET  /api/v1/users/{identifier}               – Profil (notify=false: keine Benachrichtigung über den Besuch)
 * - GET  /api/v1/linkedin/company/{identifier}    – Firmenprofil
 * Echte LinkedIn-Aktionen (Phase 3, Pfade und Felder laut offiziellem SDK `unipile-node-sdk`):
 * - POST /api/v1/users/invite                     – Vernetzungsanfrage (JSON: provider_id, account_id, message?)
 * - GET  /api/v1/users/relations                  – Kontakte (angenommene Anfragen erkennen)
 * - POST /api/v1/chats                            – neue Unterhaltung mit erster Nachricht (multipart: account_id,
 *                                                   attendees_ids, text)
 * - POST /api/v1/chats/{chat_id}/messages         – Nachricht in bestehender Unterhaltung (multipart: text)
 * - GET  /api/v1/chats/{chat_id}/messages         – Nachrichten einer Unterhaltung (Antworten erkennen)
 * - GET  /api/v1/chats                            – Unterhaltungen eines Accounts, neueste Aktivität zuerst (Query
 *                                                   account_id, after = ISO-Zeitpunkt, limit, cursor) – Abgleich
 * - GET  /api/v1/chat_attendees/{attendee_id}/chats – 1:1-Unterhaltungen mit einer Person (attendee_id = provider_id),
 *                                                   Query account_id, limit (Chat eines Kontakts übernehmen)
 * account_id, limit und cursor gehören in die Query, nicht in den Body.
 */

export class UnipileHttpError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
    readonly detail: string | null,
    readonly path: string,
  ) {
    super(`Unipile ${status}${type ? ` (${type})` : ''} bei ${path}${detail ? `: ${detail}` : ''}`);
    this.name = 'UnipileHttpError';
  }
}

/** Überschrift und Satz, wenn bei Unipile keine Sitzung läuft (Testzeitraum/Abo abgelaufen, Account getrennt). */
export const UNIPILE_SESSION_DOWN_TITLE = 'Unipile-Sitzung nicht aktiv';
export const UNIPILE_SESSION_DOWN_TEXT =
  'Für deinen LinkedIn-Account läuft bei Unipile gerade keine Sitzung (no_client_session). Meist ist der Unipile-Testzeitraum bzw. das Abo abgelaufen oder der Account bei Unipile getrennt. Prüf Abo und Account-Status im Unipile-Dashboard und verbinde den Account bei Bedarf neu.';

/**
 * Unipile antwortet mit HTTP 503 und `type: errors/no_client_session` („No client session is currently running“),
 * wenn für den Account keine Sitzung läuft – das ist kein LinkedIn-Limit, sondern ein Abo-/Verbindungsproblem.
 */
export function isUnipileSessionDown(error: unknown): boolean {
  if (!(error instanceof UnipileHttpError)) return false;
  if ((error.type ?? '').toLowerCase().includes('no_client_session')) return true;
  return error.status === 503 && /no client session/i.test(error.detail ?? '');
}

export class UnipileNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnipileNetworkError';
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export interface UnipileAccount {
  id: string;
  type?: string;
  name?: string;
  connection_params?: { im?: { premiumFeatures?: string[] } };
  sources?: Array<{ id?: string; status?: string }>;
}

export interface UnipileSearchParameter {
  id: string;
  title: string;
}

/** Personentreffer der Suche (Felder laut Unipile-Schema LinkedinPeopleSearchResult). */
export interface UnipilePeopleResult {
  type: 'PEOPLE' | string;
  id: string;
  public_identifier?: string | null;
  public_profile_url?: string | null;
  profile_url?: string | null;
  name?: string | null;
  first_name?: string;
  last_name?: string;
  headline?: string;
  location?: string | null;
  industry?: string | null;
  network_distance?: 'DISTANCE_1' | 'DISTANCE_2' | 'DISTANCE_3' | 'OUT_OF_NETWORK' | string;
  pending_invitation?: boolean;
  current_positions?: Array<{ company?: string; company_id?: string | null; role?: string }>;
}

export interface UnipileSearchResponse {
  items: UnipilePeopleResult[];
  cursor?: string | null;
}

export interface UnipileInvitation {
  invited_user_id?: string | null;
  invited_user_public_id?: string | null;
}

/** Profil (Felder laut Unipile-Schema LinkedinUserProfile). */
export interface UnipileProfile {
  provider_id?: string;
  public_identifier?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  headline?: string;
  location?: string;
  websites?: string[];
  network_distance?: 'FIRST_DEGREE' | 'SECOND_DEGREE' | 'THIRD_DEGREE' | 'OUT_OF_NETWORK' | string;
  invitation?: { type?: 'SENT' | 'RECEIVED' | string; status?: 'PENDING' | 'IGNORED' | 'WITHDRAWN' | string };
  work_experience?: Array<{
    position?: string;
    company?: string;
    company_id?: string;
    current?: boolean;
    start?: string | null;
    end?: string | null;
  }>;
}

export interface UnipileCompany {
  id?: string;
  name?: string;
  description?: string;
  website?: string;
  industry?: string[];
}

export interface UnipileRelation {
  member_id?: string;
  public_identifier?: string;
  first_name?: string;
  last_name?: string;
  created_at?: number;
}

/** Nachricht (Felder laut Unipile-Schema Message). is_sender: 1 = vom eigenen Account. */
export interface UnipileMessage {
  id: string;
  text: string | null;
  sender_id?: string;
  is_sender: 0 | 1;
  timestamp: string;
  chat_id?: string;
}

/** Unterhaltung (Felder laut Unipile-Schema Chat, nur was das Cockpit braucht). */
export interface UnipileChat {
  id: string;
  account_id?: string;
  timestamp?: string | null;
  /** Bei 1:1-Unterhaltungen die LinkedIn-ID der anderen Person. */
  attendee_provider_id?: string | null;
}

export interface UnipileClientOptions {
  /** z. B. https://api68.unipile.com:19881 */
  dsn: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Zeitlimit je Anfrage. */
  timeoutMs?: number;
  /**
   * Nur diese Accounts zurückgeben (`UNIPILE_ACCOUNTS_USED`, Instanz Lukas 03.11.: derselbe Unipile wie im anderen
   * Cockpit – dessen Accounts darf dieses Cockpit nie zum Suchen, Lesen oder Senden nehmen). Wird bei jedem Aufruf
   * gelesen, damit geänderte Einstellungen sofort gelten. Leere Liste = alle.
   */
  onlyAccounts?: () => readonly string[];
}

export class UnipileClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: UnipileClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    { query, body, signal }: { query?: Query; body?: unknown; signal: AbortSignal },
  ): Promise<T> {
    const form = body instanceof FormData;
    const url = new URL(`${this.options.dsn}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'X-API-KEY': this.options.apiKey,
          accept: 'application/json',
          // FormData setzt den Content-Type (mit boundary) selbst.
          ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}),
        },
        body: form ? body : body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) throw new CancelledError();
      if (timeout.aborted) throw new UnipileNetworkError(`Zeitüberschreitung bei ${path}`);
      throw new UnipileNetworkError(error instanceof Error ? error.message : String(error));
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const problem = (json ?? {}) as { type?: string; detail?: string; title?: string; message?: string };
      throw new UnipileHttpError(
        response.status,
        problem.type ?? null,
        problem.detail ?? problem.title ?? problem.message ?? (text.slice(0, 200) || null),
        path,
      );
    }
    return json as T;
  }

  async listAccounts(signal: AbortSignal, { all = false }: { all?: boolean } = {}) {
    const result = await this.request<{ items: UnipileAccount[] }>('GET', '/accounts', { signal });
    const only = all ? [] : (this.options.onlyAccounts?.() ?? []);
    if (only.length === 0 || !Array.isArray(result?.items)) return result;
    return { ...result, items: result.items.filter((account) => typeof account.id === 'string' && only.includes(account.id)) };
  }

  searchParameters(params: { accountId: string; type: string; keywords: string; limit?: number }, signal: AbortSignal) {
    return this.request<{ items: UnipileSearchParameter[] }>('GET', '/linkedin/search/parameters', {
      query: { account_id: params.accountId, type: params.type, keywords: params.keywords, limit: params.limit ?? 5 },
      signal,
    });
  }

  search(params: { accountId: string; body: object; limit: number; cursor?: string | null }, signal: AbortSignal) {
    return this.request<UnipileSearchResponse>('POST', '/linkedin/search', {
      query: { account_id: params.accountId, limit: params.limit, cursor: params.cursor ?? undefined },
      body: params.body,
      signal,
    });
  }

  invitationsSent(params: { accountId: string; limit: number; cursor?: string | null }, signal: AbortSignal) {
    return this.request<{ items: UnipileInvitation[]; cursor?: string | null }>('GET', '/users/invite/sent', {
      query: { account_id: params.accountId, limit: params.limit, cursor: params.cursor ?? undefined },
      signal,
    });
  }

  getProfile(params: { accountId: string; identifier: string }, signal: AbortSignal) {
    return this.request<UnipileProfile>('GET', `/users/${encodeURIComponent(params.identifier)}`, {
      // notify=false: Die Person wird nicht über den Profilbesuch benachrichtigt (Standard laut Doku, hier explizit).
      query: { account_id: params.accountId, linkedin_sections: 'experience', notify: false },
      signal,
    });
  }

  getCompany(params: { accountId: string; identifier: string }, signal: AbortSignal) {
    return this.request<UnipileCompany>('GET', `/linkedin/company/${encodeURIComponent(params.identifier)}`, {
      query: { account_id: params.accountId },
      signal,
    });
  }

  // ── Echte Aktionen (Phase 3) ──

  sendInvitation(params: { accountId: string; providerId: string; message?: string }, signal: AbortSignal) {
    return this.request<{ object?: string; invitation_id?: string }>('POST', '/users/invite', {
      body: { provider_id: params.providerId, account_id: params.accountId, ...(params.message ? { message: params.message } : {}) },
      signal,
    });
  }

  listRelations(params: { accountId: string; limit: number; cursor?: string | null }, signal: AbortSignal) {
    return this.request<{ items: UnipileRelation[]; cursor?: string | null }>('GET', '/users/relations', {
      query: { account_id: params.accountId, limit: params.limit, cursor: params.cursor ?? undefined },
      signal,
    });
  }

  startChat(params: { accountId: string; attendeeId: string; text: string }, signal: AbortSignal) {
    const body = new FormData();
    body.append('account_id', params.accountId);
    body.append('text', params.text);
    body.append('attendees_ids', params.attendeeId);
    return this.request<{ object?: string; chat_id: string | null; message_id: string | null }>('POST', '/chats', { body, signal });
  }

  sendChatMessage(params: { chatId: string; text: string }, signal: AbortSignal) {
    const body = new FormData();
    body.append('text', params.text);
    return this.request<{ object?: string; message_id: string | null }>('POST', `/chats/${encodeURIComponent(params.chatId)}/messages`, {
      body,
      signal,
    });
  }

  listChats(params: { accountId: string; after?: string; limit: number; cursor?: string | null }, signal: AbortSignal) {
    return this.request<{ items: UnipileChat[]; cursor?: string | null }>('GET', '/chats', {
      query: { account_id: params.accountId, after: params.after, limit: params.limit, cursor: params.cursor ?? undefined },
      signal,
    });
  }

  attendeeChats(params: { accountId: string; attendeeId: string; limit: number }, signal: AbortSignal) {
    return this.request<{ items: UnipileChat[]; cursor?: string | null }>('GET', `/chat_attendees/${encodeURIComponent(params.attendeeId)}/chats`, {
      query: { account_id: params.accountId, limit: params.limit },
      signal,
    });
  }

  chatMessages(params: { chatId: string; limit: number }, signal: AbortSignal) {
    return this.request<{ items: UnipileMessage[]; cursor?: string | null }>('GET', `/chats/${encodeURIComponent(params.chatId)}/messages`, {
      query: { limit: params.limit },
      signal,
    });
  }
}
