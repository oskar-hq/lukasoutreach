import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const type = req.headers['content-type'] ?? '';
  if (type.startsWith('multipart/form-data')) {
    // Formular (z. B. POST /chats) wie ein Server auslesen; mehrfach vorkommende Felder als Liste.
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData();
    const fields: Record<string, string | string[]> = {};
    for (const [key, value] of form.entries()) {
      const text = String(value);
      const existing = fields[key];
      fields[key] = existing === undefined ? text : Array.isArray(existing) ? [...existing, text] : [existing, text];
    }
    return fields;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export interface FakeUnipileOptions {
  /** Status für den n-ten Profilabruf (1-basiert), z. B. { at: 3, status: 429 }. */
  failProfile?: { at: number; status: number; type?: string };
  searchStatus?: number;
  /** Ausgefallene Accounts (22.10.): Suche und Profilabruf über diese `account_id` antworten mit dem Status. */
  downAccounts?: Record<string, number>;
  people?: number;
  /** Ersetzt die Account-Liste von GET /accounts (Standard: ein startklarer LinkedIn-Account). */
  accounts?: object[];
  /**
   * Treffer wie aus Sales Navigator: andere ID (`ACwSN…`) und ohne öffentliche Kennung. Das Profil dazu liefert die
   * klassische Provider-ID `ACoTEST…` und `person-…`.
   */
  salesNavigatorIds?: boolean;
  /** Jede Anfrage scheitert wie nach Ablauf des Unipile-Testzeitraums: 503 `errors/no_client_session`. */
  sessionDown?: boolean;
  /** Orts-Suche kennt auch Teilregionen (Bundesländer): ID `loc-<Name>`. Standard: nur „Deutschland“. */
  regions?: boolean;
  /** Suche mit diesem Cursor scheitert mit 400 (abgelaufener Cursor). */
  badCursor?: string;
}

/** Zustand der nachgebauten LinkedIn-Aktionen – Tests ändern ihn direkt (neue Kontakte, Antworten, Fehler). */
export interface FakeLinkedInState {
  /** Kontakte für GET /users/relations (neueste zuerst). */
  relations: { member_id: string; public_identifier: string; created_at: number }[];
  /** Nachrichten je chat_id für GET /chats/:id/messages. */
  messages: Record<string, { id: string; text: string; is_sender: 0 | 1; timestamp: string; sender_id: string }[]>;
  /** Antwort auf GET /chats (Unterhaltungen mit Aktivität); null = Endpunkt antwortet 404 (Rückfall je Lead). */
  chatList: { id: string; account_id: string; timestamp: string; attendee_provider_id?: string }[] | null;
  /** GET /chats/:id/messages für diese Chats scheitert mit 500. */
  brokenChats: string[];
  /** 1:1-Unterhaltungen je Person (provider_id) für GET /chat_attendees/:id/chats. */
  attendeeChats: Record<string, { id: string; account_id: string; timestamp: string }[]>;
  /** Kontakte je account_id (weitere Gründer-Accounts); fehlt der Account hier, gilt `relations`. Seitenweise per cursor. */
  relationsByAccount: Record<string, { member_id: string; public_identifier: string; created_at?: number }[]>;
  /** Gesendete, offene Anfragen je account_id für GET /users/invite/sent; fehlt der Account, gilt die Standardliste. */
  invitationsByAccount: Record<string, { invited_user_id: string; invited_user_public_id: string }[]>;
  /** Kontakte/Anfragen dieses Accounts scheitern mit diesem Fehler (z. B. Account getrennt). */
  failAccount: Record<string, { status: number; type: string }>;
  /** Nächste Antwort auf POST /users/invite bzw. /chats… mit diesem Fehler. */
  failNext: { status: number; type: string } | null;
  chats: number;
}

/** Nachbau der benötigten Unipile-Endpunkte – Antwortformate wie in der Unipile-Dokumentation. */
export async function startFakeUnipile(options: FakeUnipileOptions = {}) {
  const requests: RecordedRequest[] = [];
  const total = options.people ?? 30;
  let profileCalls = 0;
  // Wie bei LinkedIn liefert jede andere Suchanfrage andere Personen: jede neue Anfrage bekommt den nächsten Block.
  const blocks = new Map<string, number>();

  const person = (i: number) => ({
    object: 'SearchResult',
    type: 'PEOPLE',
    id: options.salesNavigatorIds ? `ACwSN${i}` : `ACoTEST${i}`,
    public_identifier: options.salesNavigatorIds ? null : `person-${i}`,
    public_profile_url: `https://www.linkedin.com/in/person-${i}`,
    profile_url: `https://www.linkedin.com/in/ACoTEST${i}`,
    name: `Vorname${i} Nachname${i}`,
    headline: `Geschäftsführer · Firma ${i}`,
    location: 'Hamburg, Deutschland',
    industry: null,
    network_distance: i === 4 ? 'DISTANCE_1' : i % 2 ? 'DISTANCE_2' : 'DISTANCE_3',
    pending_invitation: i === 3,
  });
  const company = (i: number) => (i % 3 === 0 ? `Kapital Invest ${i} GmbH` : i % 3 === 1 ? `Bau Projekt ${i} GmbH` : `Makler ${i}`);

  const linkedin: FakeLinkedInState = {
    relations: [],
    relationsByAccount: {},
    invitationsByAccount: {},
    failAccount: {},
    messages: {},
    attendeeChats: {},
    chatList: null,
    brokenChats: [],
    failNext: null,
    chats: 0,
  };
  /** Liste seitenweise wie bei Unipile: cursor = Versatz, limit aus der Query. */
  const page = <T>(items: T[], query: URLSearchParams) => {
    const start = Number(query.get('cursor') ?? 0);
    const limit = Number(query.get('limit') ?? 100);
    return { items: items.slice(start, start + limit), cursor: start + limit < items.length ? String(start + limit) : null };
  };
  /** Tests schalten die Unipile-Sitzung hiermit zur Laufzeit aus und wieder ein. */
  const session = { down: options.sessionDown ?? false };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const failNext = () => {
      const fail = linkedin.failNext;
      if (!fail) return false;
      linkedin.failNext = null;
      send(fail.status, { status: fail.status, type: fail.type, detail: 'Fehler aus dem Test' });
      return true;
    };
    if (req.headers['x-api-key'] !== 'unipile-test-key') {
      return send(401, { status: 401, type: 'errors/invalid_credentials', title: 'Invalid credentials', detail: 'Wrong API key' });
    }
    if (session.down) {
      // Antwort wie bei Unipile nach Ablauf des Testzeitraums.
      return send(503, { status: 503, type: 'errors/no_client_session', title: 'No client session', detail: 'No client session is currently running.' });
    }
    const path = url.pathname.replace('/api/v1', '');
    if (req.method === 'GET' && path === '/accounts') {
      return send(200, {
        object: 'AccountList',
        items: options.accounts ?? [
          { object: 'Account', type: 'WHATSAPP', id: 'acc_whatsapp' },
          { object: 'Account', type: 'LINKEDIN', id: 'acc_linkedin', name: 'Nick', sources: [{ id: 's1', status: 'OK' }] },
        ],
        cursor: null,
      });
    }
    if (req.method === 'GET' && path === '/linkedin/search/parameters') {
      const wanted = url.searchParams.get('keywords') ?? '';
      if (options.regions && wanted !== 'Deutschland') {
        return send(200, { object: 'LinkedinSearchParametersList', items: [{ object: 'LinkedinSearchParameter', id: `loc-${wanted}`, title: `${wanted}, Deutschland` }], paging: { page_count: 1 } });
      }
      return send(200, {
        object: 'LinkedinSearchParametersList',
        items: [{ object: 'LinkedinSearchParameter', id: '101282230', title: 'Deutschland' }],
        paging: { page_count: 1 },
      });
    }
    const down = options.downAccounts?.[url.searchParams.get('account_id') ?? ''];
    if (down && ((req.method === 'POST' && path === '/linkedin/search') || (req.method === 'GET' && /^\/users\/(ACoTEST|ACwSN)\d+$/.test(path)) || (req.method === 'GET' && /^\/linkedin\/company\//.test(path)))) {
      return send(down, { status: down, type: down === 429 ? 'errors/too_many_requests' : 'errors/unexpected_error', detail: 'Account fällt aus' });
    }
    if (req.method === 'POST' && path === '/linkedin/search') {
      if (options.searchStatus) return send(options.searchStatus, { status: options.searchStatus, type: 'errors/disconnected_account', detail: 'Account getrennt' });
      if (options.badCursor && url.searchParams.get('cursor') === options.badCursor) {
        return send(400, { status: 400, type: 'errors/invalid_parameters', detail: 'Invalid cursor' });
      }
      const key = JSON.stringify(body);
      if (!blocks.has(key)) blocks.set(key, blocks.size);
      const start = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : blocks.get(key)! * 10;
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const items = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, k) => person(start + k + 1));
      const next = start + items.length;
      return send(200, { object: 'LinkedinSearch', items, config: {}, paging: { start, page_count: items.length, total_count: total }, cursor: next < total ? String(next) : null });
    }
    const accountFail = linkedin.failAccount[url.searchParams.get('account_id') ?? ''];
    if (accountFail && req.method === 'GET' && (path === '/users/invite/sent' || path === '/users/relations')) {
      return send(accountFail.status, { status: accountFail.status, type: accountFail.type, detail: 'Fehler aus dem Test' });
    }
    const invitationsOf = linkedin.invitationsByAccount[url.searchParams.get('account_id') ?? ''];
    if (req.method === 'GET' && path === '/users/invite/sent' && invitationsOf) {
      const { items, cursor } = page(invitationsOf, url.searchParams);
      return send(200, { object: 'InvitationList', items: items.map((item, k) => ({ object: 'InvitationSent', id: `inv-x${k}`, date: '2026-09-30', ...item })), cursor });
    }
    if (req.method === 'GET' && path === '/users/invite/sent') {
      return send(200, {
        object: 'InvitationList',
        items: [{ object: 'InvitationSent', id: 'inv1', invited_user_id: 'ACoTEST5', invited_user_public_id: 'person-5', date: '2026-09-30' }],
        cursor: null,
      });
    }
    // ── Echte Aktionen (Formate laut unipile-node-sdk) ──
    if (req.method === 'POST' && path === '/users/invite') {
      if (failNext()) return;
      return send(201, { object: 'UserInvitationSent', invitation_id: `inv-${requests.length}` });
    }
    if (req.method === 'GET' && path === '/users/relations') {
      const own = linkedin.relationsByAccount[url.searchParams.get('account_id') ?? ''];
      const { items, cursor } = own ? page(own, url.searchParams) : { items: linkedin.relations, cursor: null };
      return send(200, {
        object: 'UserRelationsList',
        items: items.map((relation) => ({ object: 'UserRelation', first_name: 'X', last_name: 'Y', headline: '', ...relation })),
        cursor,
      });
    }
    if (req.method === 'POST' && path === '/chats') {
      if (failNext()) return;
      linkedin.chats += 1;
      const chatId = `chat-${linkedin.chats}`;
      return send(201, { object: 'ChatStarted', chat_id: chatId, message_id: `msg-${requests.length}` });
    }
    if (req.method === 'GET' && path === '/chats' && linkedin.chatList) {
      const account = url.searchParams.get('account_id');
      const after = url.searchParams.get('after');
      const items = linkedin.chatList.filter((chat) => (!account || chat.account_id === account) && (!after || chat.timestamp >= after));
      return send(200, { object: 'ChatList', items: items.map((chat) => ({ object: 'Chat', type: 0, ...chat })), cursor: null });
    }
    const attendeeMatch = path.match(/^\/chat_attendees\/([^/]+)\/chats$/);
    if (attendeeMatch && req.method === 'GET') {
      const account = url.searchParams.get('account_id');
      const items = (linkedin.attendeeChats[decodeURIComponent(attendeeMatch[1])] ?? []).filter((chat) => !account || chat.account_id === account);
      return send(200, { object: 'ChatList', items: items.map((chat) => ({ object: 'Chat', type: 0, ...chat })), cursor: null });
    }
    const chatMatch = path.match(/^\/chats\/([^/]+)\/messages$/);
    if (chatMatch && req.method === 'POST') {
      if (failNext()) return;
      return send(201, { object: 'MessageSent', message_id: `msg-${requests.length}` });
    }
    if (chatMatch && req.method === 'GET' && linkedin.brokenChats.includes(decodeURIComponent(chatMatch[1]))) {
      return send(500, { status: 500, type: 'errors/unexpected_error', detail: 'kaputt' });
    }
    if (chatMatch && req.method === 'GET') {
      const items = linkedin.messages[decodeURIComponent(chatMatch[1])] ?? [];
      return send(200, { object: 'MessageList', items: items.map((message) => ({ object: 'Message', chat_id: chatMatch[1], ...message })), cursor: null });
    }
    const profileMatch = path.match(/^\/users\/((?:ACoTEST|ACwSN)(\d+))$/);
    if (req.method === 'GET' && profileMatch) {
      profileCalls++;
      if (options.failProfile && profileCalls === options.failProfile.at) {
        return send(options.failProfile.status, { status: options.failProfile.status, type: options.failProfile.type ?? 'errors/too_many_requests', detail: 'Slow down' });
      }
      const i = Number(profileMatch[2]);
      return send(200, {
        object: 'UserProfile',
        provider: 'LINKEDIN',
        provider_id: `ACoTEST${profileMatch[2]}`,
        public_identifier: `person-${i}`,
        first_name: `Vorname${i}`,
        last_name: `Nachname${i}`,
        headline: `Geschäftsführer · ${company(i)}`,
        location: 'Hamburg',
        websites: [],
        // Ab ACoTEST100: Kontakt 1. Grades (Test-LinkedIn-Account).
        network_distance: i >= 100 ? 'FIRST_DEGREE' : 'SECOND_DEGREE',
        invitation: i === 7 ? { type: 'SENT', status: 'PENDING' } : undefined,
        work_experience: [
          { position: 'Vertriebsleiter', company: 'Alte Firma', company_id: '999', current: false, start: '2015', end: '2019' },
          { position: 'Geschäftsführer', company: company(i), company_id: `c${i}`, current: true, start: '2019', end: null },
        ],
      });
    }
    const companyMatch = path.match(/^\/linkedin\/company\/c(\d+)$/);
    if (req.method === 'GET' && companyMatch) {
      const i = Number(companyMatch[1]);
      return send(200, {
        object: 'CompanyProfile',
        id: `c${i}`,
        name: company(i),
        description: `Beschreibung von ${company(i)}.`,
        website: `https://firma-${i}.example`,
        industry: ['Immobilien'],
      });
    }
    send(404, { status: 404, type: 'errors/resource_not_found', detail: `Unbekannt: ${req.method} ${path}` });
  });

  const baseUrl = await listen(server);
  return {
    baseUrl,
    requests,
    linkedin,
    session,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface FakeAnthropicOptions {
  status?: number;
  errorType?: string;
  /** Fehlermeldung bei `status` (Standard „invalid x-api-key“). */
  errorMessage?: string;
  /** Liefert für diese Firma eine kaputte Ausgabe. */
  brokenFor?: string;
  /** Antwort auf Vorschlags-Anfragen (System-Prompt mit „[cockpit:vorschlag]“), Standard: kurzer Beispieltext. */
  suggestion?: { text: string; intent: string | null; summary: string | null };
  /** Antwort auf Gesprächs-Einschätzungen (System-Prompt mit „[cockpit:gespraech]“). */
  conversation?: { replyIntent: string; replySummary: string; summary: string };
  /**
   * KI-Vorprüfung (System-Prompt mit „[cockpit:vorpruefung]“): Urteil je Headline. Standard: „no“, wenn die Headline
   * „Versicherung“ enthält, sonst „likely“. `prescreenStatus` lässt nur die Vorprüfung mit diesem Status scheitern.
   */
  prescreen?: (headline: string) => 'likely' | 'maybe' | 'no';
  prescreenStatus?: number;
}

/** Systemprompt einer aufgezeichneten Anfrage als Text – auch als Liste von Blöcken (Regeln + Beispiele). */
export function systemText(body: unknown): string {
  const system = (body as { system?: string | Array<{ text: string }> } | undefined)?.system;
  return typeof system === 'string' ? system : (system ?? []).map((block) => block.text).join('\n');
}

/** Minimaler Nachbau von POST /v1/messages mit strukturierter Ausgabe. */
export async function startFakeAnthropic(options: FakeAnthropicOptions = {}) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = (await readBody(req)) as { model: string; system?: string | Array<{ type: 'text'; text: string }>; messages: Array<{ content: string }> };
    // Systemprompt als Text – auch als Liste von Blöcken (Regeln + Beispiele aus `shared/learning.ts`).
    const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((block) => block.text).join('\n');
    requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body });
    if (options.status) {
      res.writeHead(options.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: options.errorType ?? 'authentication_error', message: options.errorMessage ?? 'invalid x-api-key' } }));
      return;
    }
    const content = body.messages[0].content;
    if (system.includes('[cockpit:vorpruefung]')) {
      if (options.prescreenStatus) {
        res.writeHead(options.prescreenStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
        return;
      }
      const judge = options.prescreen ?? ((headline: string) => (/Versicherung/.test(headline) ? 'no' : 'likely'));
      const results = [...content.matchAll(/^(\d+)\. Name: .*? \| Headline: (.*?) \| Ort: /gm)].map((match) => {
        const fit = judge(match[2]);
        return { nr: Number(match[1]), fit, reason: fit === 'no' ? 'Versicherungsvertrieb – keine Immobilienfirma' : 'Headline passt' };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify({ results }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 40 },
        }),
      );
      return;
    }
    if (system.includes('[cockpit:gespraech]')) {
      const output = options.conversation ?? { replyIntent: 'interested', replySummary: 'Will telefonieren.', summary: 'Erstnachricht gesendet, Lead hat Interesse.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify(output) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 40 },
        }),
      );
      return;
    }
    if (system.includes('[cockpit:vorschlag]')) {
      const suggestion = options.suggestion ?? { text: 'Hallo Erika, KI-Text.\n\nViele Grüße\nNick', intent: null, summary: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: JSON.stringify(suggestion) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 40 },
        }),
      );
      return;
    }
    const firma = /Firma: (.*)/.exec(content)?.[1] ?? '';
    const output = firma.startsWith('Kapital')
      ? { category: 'kapitalanlage_vertrieb', qualified: true, confidence: 0.9, reason: 'Vertreibt Kapitalanlagen.', summary: 'Kapitalanlage-Vertrieb. Geschäftsführer entscheidet.', hiringRole: null }
      : firma.startsWith('Bau')
        ? { category: 'bautraeger_projektentwickler', qualified: true, confidence: 0.84, reason: 'Entwickelt eigene Projekte.', summary: 'Bauträger. Geschäftsführer entscheidet.', hiringRole: null }
        : { category: 'makler', qualified: false, confidence: 0.8, reason: 'Vermittelt fremde Objekte.', summary: 'Maklerbüro. Nicht relevant.', hiringRole: null };
    const text = options.brokenFor && firma.includes(options.brokenFor) ? 'Das ist kein JSON' : JSON.stringify(output);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 40 },
      }),
    );
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export interface FakeMetaOptions {
  /** Graph-API-Fehler für jede Anfrage, z. B. { status: 400, code: 190 }. */
  error?: { status: number; code: number; message?: string };
}

/**
 * Nachbau von GET /{version}/ads_archive (Meta Ad Library API).
 * „Kapital Invest i“: gerade i → eigene aktive Anzeige, ungerade i → nur Fremdtreffer.
 * „Bau Projekt i“: eigene, beendete Anzeigen. Domain-Suche: nichts.
 */
export async function startFakeMeta(options: FakeMetaOptions = {}) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body: null });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (url.searchParams.get('access_token') !== 'meta-test-key') {
      return send(400, { error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190, fbtrace_id: 'x' } });
    }
    if (options.error) {
      return send(options.error.status, { error: { message: options.error.message ?? 'Fehler', type: 'OAuthException', code: options.error.code } });
    }
    if (req.method !== 'GET' || !/^\/v\d+\.\d+\/ads_archive$/.test(url.pathname)) {
      return send(400, { error: { message: 'Unsupported get request.', type: 'GraphMethodException', code: 100 } });
    }
    const term = url.searchParams.get('search_terms') ?? '';
    const foreign = { id: `f-${term}`, page_id: '555', page_name: 'Anderer Vertrieb GmbH', ad_delivery_start_time: '2026-08-01' };
    const kapital = /^Kapital Invest (\d+)$/.exec(term);
    const bau = /^Bau Projekt (\d+)$/.exec(term);
    let data: object[] = [];
    if (kapital && Number(kapital[1]) % 2 === 0) {
      data = [{ id: `a-${term}`, page_id: `10${kapital[1]}`, page_name: `Kapital Invest ${kapital[1]}`, ad_delivery_start_time: '2026-09-01' }, foreign];
    } else if (kapital) {
      data = [foreign];
    } else if (bau) {
      data = [
        { id: `b1-${term}`, page_id: `20${bau[1]}`, page_name: `Bau Projekt ${bau[1]} GmbH`, ad_delivery_start_time: '2026-03-01', ad_delivery_stop_time: '2026-05-01' },
        { id: `b2-${term}`, page_id: `20${bau[1]}`, page_name: `Bau Projekt ${bau[1]} GmbH`, ad_delivery_start_time: '2026-04-01', ad_delivery_stop_time: '2026-06-15' },
      ];
    }
    send(200, { data, paging: { cursors: { before: 'a', after: 'b' } } });
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Nachbau eines Clay-Tabellen-Webhooks (Clay-Doku „Import data from Webhook“): nimmt JSON per POST an, prüft den
 * optionalen Header `x-clay-webhook-auth` und antwortet 200. `status` erzwingt eine Fehlerantwort.
 */
export async function startFakeClay(options: { token?: string; status?: number } = {}) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (options.token && req.headers['x-clay-webhook-auth'] !== options.token) return send(401, { error: 'unauthorized' });
    if (options.status) return send(options.status, { error: 'failed' });
    send(200, { ok: true });
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Nachbau von treg.to für den geroutete Dienst `treg.companies.enrich` (Format aus der echten Antwort vom 05.10.2026):
 * `POST /call/treg.companies.enrich` mit JSON `{ domain }`, Header `X-Treg-Token` und `X-Treg-Route-Max-Cost`;
 * Antwort `{ output, raw, _treg }`, Fehlschlag = `output.name` null (HTTP 200). `companies` je Domain
 * (`{ output, raw? }`). `status` erzwingt eine Treg-eigene Fehlerantwort (z. B. 402).
 */
export async function startFakeTreg(options: { token?: string; companies?: Record<string, { output: object; raw?: unknown }>; status?: number } = {}) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = (await readBody(req)) as { domain?: string } | null;
    requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers['x-treg-token'] !== (options.token ?? 'treg-test-token')) return send(401, { detail: 'not authenticated' });
    if (options.status) return send(options.status, { detail: 'Fehler aus dem Test', balance_micro: 0 });
    if (req.method !== 'POST' || url.pathname !== '/call/treg.companies.enrich') {
      return send(404, { detail: `no registered tool for upstream '${url.pathname}'` });
    }
    const company = options.companies?.[body?.domain ?? ''];
    if (!company) {
      return send(200, { output: { name: null, domain: body?.domain ?? null }, raw: {}, _treg: { served_by: null, outcome: 'miss', charged_micro: 0 } });
    }
    send(200, { output: company.output, raw: company.raw ?? {}, _treg: { served_by: 'thecompaniesapi.companies.enrich', outcome: 'hit', charged_micro: 1900 } });
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export interface FakeCloseOptions {
  /** HTTP-Status für alle Anfragen an /api/v1/lead/ (z. B. 401, 429). */
  leadStatus?: number;
  /** HTTP-Status für Notizen (z. B. 500 → Notiz fehlt). */
  noteStatus?: number;
}

/** Nachbau der dokumentierten Close-Endpunkte POST /api/v1/lead/ und POST /api/v1/activity/note/ (Basic mit Schlüssel). */
export async function startFakeClose(options: FakeCloseOptions = {}) {
  const requests: RecordedRequest[] = [];
  let counter = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const send = (status: number, json: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Basic ${Buffer.from('close-test-key:').toString('base64')}`) return send(401, { error: 'Unauthorized' });
    if (req.method === 'POST' && url.pathname === '/api/v1/lead/') {
      if (options.leadStatus) return send(options.leadStatus, { error: 'Fehler' }, options.leadStatus === 429 ? { 'retry-after': '7' } : {});
      counter++;
      return send(200, { id: `lead_test${counter}`, html_url: `https://app.close.com/lead/lead_test${counter}/`, ...(body as object) });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/activity/note/') {
      if (options.noteStatus) return send(options.noteStatus, { error: 'Fehler' });
      return send(200, { id: `acti_${counter}`, ...(body as object) });
    }
    // Verbindungstest der Einstellungen (dokumentiert: GET /api/v1/me/ – der angemeldete Nutzer).
    if (req.method === 'GET' && url.pathname === '/api/v1/me/') return send(200, { id: 'user_test', first_name: 'Test', email: 'test@example.com' });
    send(404, { error: 'Not found' });
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
