import type { AssistantAskRequest, AssistantChatDetail, AssistantChatListResponse, AssistantModelsResponse, AssistantStreamEvent } from '../../shared/assistant';
import type { NotificationListResponse } from '../../shared/notifications';
import type { McpConnectionsResponse, McpConsentInfo, McpConsentResult } from '../../shared/mcp';
import type { MetaRecheckStatus } from '../../shared/metaRecheck';
import type {
  ApiErrorBody,
  LeadCategory,
  LeadSearchConfig,
  ManualQualifyResponse,
  TrackingSummary,
  NewLeadCard,
  RunEvent,
  RunSnapshot,
  StartRunRequest,
} from '../../shared/leadSearch';
import type {
  AcceptInviteRequest,
  AuthErrorCode,
  AuthFounderId,
  AuthResponse,
  AccountInfo,
  AccountListResponse,
  AuthUser,
  ApproveRequest,
  CreateInviteRequest,
  RegisterRequest,
  SetupInfo,
  CreateInviteResponse,
  InviteInfo,
  LoginRequest,
} from '../../shared/auth';
import type {
  BoardColumn,
  BoardColumnsResponse,
  ConversationListResponse,
  AddContactRequest,
  AddContactResponse,
  CreateLeadsRequest,
  CreateLeadsResponse,
  DeleteLeadResponse,
  LeadActionRequest,
  LeadDetailResponse,
  LeadListResponse,
  LeadStage,
  SnoozeRequest,
  UpdateLeadRequest,
  UnsentInvitesResponse,
  RequeueInvitesResponse,
} from '../../shared/leads';
import type { TasksResponse } from '../../shared/tasks';
import type { AutoSearchListResponse, AutoSearchSchedule, AutoSearchUpdate } from '../../shared/autoSearch';
import type { EnrichmentStatusResponse } from '../../shared/enrichment';
import type {
  SettingsHistoryResponse,
  AnthropicModelsResponse,
  SettingsResponse,
  SettingsTestResponse,
  SettingsTestService,
  SettingsUpdateRequest,
} from '../../shared/settings';
import type { CreateTemplateRequest, MessageSuggestion, MessageTemplate, SuggestRequest, TemplatesResponse, UpdateTemplateRequest } from '../../shared/messages';
import type { DashboardResponse } from '../../shared/dashboard';
import type { LearningSummary } from '../../shared/learning';
import type {
  LinkedInAccountsResponse,
  LinkedInWarmupResponse,
  LinkedInAccountLimits,
  LinkedInInviteRequest,
  ChatSyncRequest,
  ChatSyncStatus,
  LinkedInMessageRequest,
  LinkedInResumeRequest,
  LinkedInStatusResponse,
  LinkedInSyncResponse,
  LinkedInTestInviteRequest,
  LinkedInTestInviteResponse,
  LinkedInTestConnectRequest,
  LinkedInTestConnectResponse,
  LinkedInTestMessageRequest,
  LinkedInTestMessageResponse,
  LinkedInTestProfileRequest,
  LinkedInTestProfileResponse,
} from '../../shared/linkedin';
import type { BackupInfo, BackupListResponse, RestoreResponse, SettingsKeyResponse, UpdateStatusResponse } from '../../shared/system';
import type { CrmStatusResponse, HandoverRequest } from '../../shared/crm';

const BASE = '/api/lead-search';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** Bei „busy“: der Lauf, der gerade arbeitet. */
    readonly runId?: string,
    /** Betroffenes Feld, z. B. der Schlüssel bei `invalid_setting`. */
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Meldet „Sitzung abgelaufen“ (401 `unauthorized` auf einer geschützten Route) an die Anmeldung.
 * Die Auth-Routen selbst melden nichts – dort ist 401 eine normale Antwort.
 */
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function reportUnauthorized(url: string, status: number, code: string | undefined) {
  if (status !== 401 || url.startsWith('/api/auth/')) return;
  // Ältere Backends ohne Login liefern nie 401; ein 401 ohne Code zählt trotzdem als abgelaufene Sitzung.
  if (code && code !== ('unauthorized' satisfies AuthErrorCode)) return;
  for (const listener of unauthorizedListeners) listener();
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch {
    throw new ApiError('offline', 'Backend nicht erreichbar.', 0);
  }
  const body = (await response.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!response.ok || !body) {
    // Fastify antwortet auf unbekannte Routen mit `error: "Not Found"` (Text statt Objekt).
    const error = typeof body?.error === 'object' ? body.error : undefined;
    reportUnauthorized(url, response.status, error?.code);
    if (!error && response.status >= 500) throw new ApiError('offline', 'Backend nicht erreichbar.', response.status);
    throw new ApiError(error?.code ?? 'error', error?.message ?? `Fehler ${response.status}`, response.status, error?.runId, error?.field);
  }
  return body;
}

const request = <T,>(path: string, init?: RequestInit) => call<T>(`${BASE}${path}`, init);

/** Datei vom Backend holen (Sicherung, Auskunft) – Fehler wie bei `call`. */
async function fetchFile(url: string, init: RequestInit): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError('offline', 'Backend nicht erreichbar.', 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as Partial<ApiErrorBody> | null;
    const error = typeof body?.error === 'object' ? body.error : undefined;
    reportUnauthorized(url, response.status, error?.code);
    throw new ApiError(error?.code ?? 'error', error?.message ?? `Fehler ${response.status}`, response.status);
  }
  return response.blob();
}

/** Blob als Datei speichern (Download im Browser). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const leadSearchApi = {
  /** refresh = Account-Status bei Unipile frisch prüfen statt aus dem Zwischenspeicher. */
  config: (refresh = false) => request<LeadSearchConfig>(refresh ? '/config?refresh=1' : '/config'),
  start: (body: StartRunRequest) =>
    request<{ run: RunSnapshot }>('/runs', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.run),
  get: (id: string) => request<{ run: RunSnapshot }>(`/runs/${id}`).then((r) => r.run),
  cancel: (id: string) => request<{ run: RunSnapshot }>(`/runs/${id}/cancel`, { method: 'POST' }).then((r) => r.run),
  handoff: (id: string) => request<{ leads: NewLeadCard[]; run: RunSnapshot }>(`/runs/${id}/handoff`, { method: 'POST' }),
  /** Lead nach dem Lauf von Hand qualifizieren (Wunsch des Nutzers 12.10.). */
  qualify: (id: string, leadId: string) =>
    request<ManualQualifyResponse>(`/runs/${id}/leads/${encodeURIComponent(leadId)}/qualify`, { method: 'POST' }),
  /** Outreach-Tracking-Liste (Excel) hochladen – ersetzt die bisherige. */
  uploadTracking: async (file: File) => {
    let response: Response;
    try {
      response = await fetch(`${BASE}/tracking`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      });
    } catch {
      throw new ApiError('offline', 'Backend nicht erreichbar.', 0);
    }
    const body = (await response.json().catch(() => null)) as ({ tracking: TrackingSummary } & Partial<ApiErrorBody>) | null;
    if (!response.ok || !body?.tracking) {
      reportUnauthorized(`${BASE}/tracking`, response.status, body?.error?.code);
      throw new ApiError(body?.error?.code ?? 'error', body?.error?.message ?? `Fehler ${response.status}`, response.status);
    }
    return body.tracking;
  },
  removeTracking: () => request<{ tracking: null }>('/tracking', { method: 'DELETE' }),
};

/** Hängt der Server, gilt er nach dieser Zeit als nicht erreichbar (statt einer endlos leeren Seite). */
const AUTH_TIMEOUT_MS = 10_000;

/**
 * Anmeldung (`shared/auth.ts`). Ein Backend ohne Login antwortet auf diese Routen mit 404 –
 * dann bleibt die Demo-Auswahl der Gründer.
 */
/** Konten verwalten (`shared/auth.ts` → „Rollen und Rechte“). */
export const accountsApi = {
  list: (options: RequestOptions = {}) => call<AccountListResponse>('/api/accounts', options),
  /** Einladungslink erzeugen (neues Konto oder `reset`). Das Token kommt nur in dieser Antwort. */
  invite: (body: CreateInviteRequest) =>
    call<CreateInviteResponse>('/api/accounts/invite', { method: 'POST', body: JSON.stringify(body) }),
  remove: (username: string) => call<{ ok: true }>(`/api/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  /** Offene Registrierung freigeben (Rolle und Gründer festlegen). Ablehnen = `remove`. */
  approve: (username: string, body: ApproveRequest) =>
    call<AccountInfo>(`/api/accounts/${encodeURIComponent(username)}/approve`, { method: 'POST', body: JSON.stringify(body) }),
};

export const authApi = {
  me: () => call<AuthResponse>('/api/auth/me', { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) }).then((r): AuthUser => r.user),
  login: (body: LoginRequest) =>
    call<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    }).then((r): AuthUser => r.user),
  logout: () => call<{ ok: true }>('/api/auth/logout', { method: 'POST', signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) }),
  /** Einladungslink prüfen. Das Token geht nur im Body mit, nie in einer URL (Server-Logs). */
  checkInvite: (token: string) =>
    call<InviteInfo>('/api/auth/invite/check', {
      method: 'POST',
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    }),
  /** Ohne Sitzung: Gibt es schon ein Konto? Ältere Backends ohne Registrierung → Fehler (dann normale Anmeldung). */
  setup: () => call<SetupInfo>('/api/auth/setup', { signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) }),
  register: (body: RegisterRequest) =>
    call<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    }).then((r): AuthUser => r.user),
  onboardingDone: () => call<AuthResponse>('/api/auth/onboarding/done', { method: 'POST' }).then((r): AuthUser => r.user),
  acceptInvite: (body: AcceptInviteRequest) =>
    call<AuthResponse>('/api/auth/invite/accept', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    }).then((r): AuthUser => r.user),
};

/** Einstellungen in der Software (`shared/settings.ts`). */
export const settingsApi = {
  get: () => call<SettingsResponse>('/api/settings'),
  update: (body: SettingsUpdateRequest) => call<SettingsResponse>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  confirmTrial: () => call<SettingsResponse>('/api/settings/trial/confirm', { method: 'POST' }),
  revertTrial: () => call<SettingsResponse>('/api/settings/trial/revert', { method: 'POST' }),
  test: (service: SettingsTestService) =>
    call<SettingsTestResponse>('/api/settings/test', { method: 'POST', body: JSON.stringify({ service }) }),
  history: () => call<SettingsHistoryResponse>('/api/settings/history'),
  /** Claude-Modelle zur Auswahl (live von Anthropic, sonst eingebaut). */
  models: () => call<AnthropicModelsResponse>('/api/settings/models'),
  /** Meta-Ads aller Leads nachprüfen (`shared/metaRecheck.ts`). */
  metaRecheck: () => call<MetaRecheckStatus>('/api/settings/meta-recheck'),
  startMetaRecheck: () => call<MetaRecheckStatus>('/api/settings/meta-recheck', { method: 'POST' }),
};

/**
 * Automatische Lead-Suche nach Zeitplan (`shared/autoSearch.ts`). Gründer: nur der eigene Plan, Admin: beide,
 * Mitarbeiter: 403. `run` antwortet mit 202 – den Fortschritt zeigt danach `list` (`lastRun`).
 */
export const autoSearchApi = {
  list: (options: RequestOptions = {}) => call<AutoSearchListResponse>('/api/auto-search', options),
  update: (founder: AuthFounderId, body: AutoSearchUpdate) =>
    call<AutoSearchSchedule>(`/api/auto-search/${encodeURIComponent(founder)}`, { method: 'PUT', body: JSON.stringify(body) }),
  run: (founder: AuthFounderId) => call<{ runId: string }>(`/api/auto-search/${encodeURIComponent(founder)}/run`, { method: 'POST' }),
};

/** Abfrage für `GET /api/leads` – leere Werte werden weggelassen. */
export interface LeadListQuery {
  owner?: AuthFounderId;
  stage?: readonly LeadStage[];
  q?: string;
  limit?: number;
  offset?: number;
  /** recent = zuletzt bearbeitet zuerst (siehe `shared/leads.ts`). */
  sort?: 'activity' | 'score' | 'recent';
  /** Mit `stage`: zusätzlich alle Leads in eigenen Board-Spalten, egal in welcher Stufe (`columns=1`). */
  withBoardColumns?: boolean;
  /** Nur diese KI-Kategorien (`category=`). */
  category?: readonly LeadCategory[];
}

function leadListUrl(query: LeadListQuery): string {
  const params = new URLSearchParams();
  if (query.owner) params.set('owner', query.owner);
  if (query.stage?.length) params.set('stage', query.stage.join(','));
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  if (query.sort) params.set('sort', query.sort);
  if (query.withBoardColumns) params.set('columns', '1');
  if (query.category?.length) params.set('category', query.category.join(','));
  const search = params.toString();
  return search ? `/api/leads?${search}` : '/api/leads';
}

const leadUrl = (id: string, path = '') => `/api/leads/${encodeURIComponent(id)}${path}`;

/**
 * Leads im Cockpit (`shared/leads.ts`, Anreicherung `shared/enrichment.ts`).
 * `keepalive`: Anfrage überlebt das Schließen der Seite (Entscheidungen, die gerade noch rückgängig gemacht werden konnten).
 */
export interface RequestOptions {
  keepalive?: boolean;
  signal?: AbortSignal;
}

/** Eigene Spalten im Leads-Board (`shared/leads.ts` → BoardColumn). */
export const boardApi = {
  columns: () => call<BoardColumnsResponse>('/api/board/columns'),
  add: (name: string) => call<BoardColumn>('/api/board/columns', { method: 'POST', body: JSON.stringify({ name }) }),
  rename: (id: string, name: string) => call<BoardColumn>(`/api/board/columns/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  remove: (id: string) => call<BoardColumnsResponse>(`/api/board/columns/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Reihenfolge aller Spalten (Schlüssel `boardColumnKey`). */
  order: (order: string[]) => call<BoardColumnsResponse>('/api/board/columns/order', { method: 'PUT', body: JSON.stringify({ order }) }),
  /** Eigener Name einer Stufen-Spalte, null = Standardname. */
  renameStage: (stage: LeadStage, name: string | null) =>
    call<BoardColumnsResponse>(`/api/board/columns/stage/${encodeURIComponent(stage)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
};

/** Neuigkeiten vom Programm (`shared/notifications.ts`): Glocke oben rechts. */
export const notificationsApi = {
  list: (options: RequestOptions = {}) => call<NotificationListResponse>('/api/notifications', options),
  /** Alles bis jetzt gilt als gesehen – Antwort ist die neue Liste. */
  seen: () => call<NotificationListResponse>('/api/notifications/seen', { method: 'POST' }),
};

/** Chats (`shared/leads.ts` → ConversationSummary). */
export const conversationsApi = {
  list: (owner?: AuthFounderId) => call<ConversationListResponse>(`/api/conversations${owner ? `?owner=${owner}` : ''}`),
};

export const leadsApi = {
  list: (query: LeadListQuery = {}, options: RequestOptions = {}) => call<LeadListResponse>(leadListUrl(query), options),
  get: (id: string, options: RequestOptions = {}) => call<LeadDetailResponse>(leadUrl(id), options),
  create: (body: CreateLeadsRequest, options: RequestOptions = {}) =>
    call<CreateLeadsResponse>('/api/leads', { method: 'POST', body: JSON.stringify(body), ...options }),
  /** Persönlicher Kontakt per LinkedIn-Link – 201 neu, 200 gab es schon (`created: false`). */
  addContact: (body: AddContactRequest) => call<AddContactResponse>('/api/leads/contact', { method: 'POST', body: JSON.stringify(body) }),
  act: (id: string, body: LeadActionRequest, options: RequestOptions = {}) =>
    call<LeadDetailResponse>(leadUrl(id, '/events'), { method: 'POST', body: JSON.stringify(body), ...options }),
  /** „Für heute überspringen“: fehlt bis `until` im Tagesstapel. */
  snooze: (id: string, body: SnoozeRequest, options: RequestOptions = {}) =>
    call<LeadDetailResponse>(leadUrl(id, '/snooze'), { method: 'POST', body: JSON.stringify(body), ...options }),
  unsnooze: (id: string, options: RequestOptions = {}) => call<LeadDetailResponse>(leadUrl(id, '/snooze'), { method: 'DELETE', ...options }),
  update: (id: string, body: UpdateLeadRequest, options: RequestOptions = {}) =>
    call<LeadDetailResponse>(leadUrl(id), { method: 'PATCH', body: JSON.stringify(body), ...options }),
  /** Clay-Anreicherung anstoßen (202, `lead.enrichment.status` = pending) – danach den Lead neu laden. */
  enrich: (id: string) => call<LeadDetailResponse>(leadUrl(id, '/enrich'), { method: 'POST' }),
  /** Auskunft (DSGVO): alle gespeicherten Daten des Leads als JSON-Datei – nur Gründer und Admins. */
  exportData: (id: string): Promise<Blob> => fetchFile(leadUrl(id, '/export'), { method: 'GET' }),
  /** Endgültig löschen (DSGVO) – nur Gründer und Admins. */
  remove: (id: string) => call<DeleteLeadResponse>(leadUrl(id), { method: 'DELETE' }),
  /** Nur eingetragene, nie gesendete Anfragen (11.10.). */
  unsentInvites: () => call<UnsentInvitesResponse>('/api/leads/unsent-invites'),
  /** Diese Leads zurück auf „Neu“ – sie kommen wieder als „Neuer Lead“ in den Tagesstapel. */
  requeueInvites: (ids: string[]) =>
    call<RequeueInvitesResponse>('/api/leads/unsent-invites/requeue', { method: 'POST', body: JSON.stringify({ ids }) }),
};

/** Tagesstapel (`shared/tasks.ts`) – immer mit Gründer, damit nie versehentlich alle Aufgaben kommen. */
export const tasksApi = {
  /** owner null = Aufgaben aller Gründer (Umschalter „Alle“, nur Gründer-Konten). */
  get: (owner: AuthFounderId | null, options: RequestOptions = {}) => call<TasksResponse>(`/api/tasks?owner=${owner ?? 'all'}`, options),
};

/** Dashboard aus echten Zahlen (`shared/dashboard.ts`, Phase 6). */
export const dashboardApi = {
  get: (days?: number, options: RequestOptions = {}) => call<DashboardResponse>(`/api/dashboard${days ? `?days=${days}` : ''}`, options),
};

/** Was der Scraper aus Rückmeldungen zur Lead-Qualität gelernt hat (`shared/learning.ts`). */
export const learningApi = {
  get: (options: RequestOptions = {}) => call<LearningSummary>('/api/learning', options),
};

export const enrichmentApi = {
  status: () => call<EnrichmentStatusResponse>('/api/enrichment/status'),
};

/** Echte LinkedIn-Aktionen (`shared/linkedin.ts`, Phase 3) – Limits, Arbeitszeit und Pausen prüft das Backend. */
export const linkedinApi = {
  status: () => call<LinkedInStatusResponse>('/api/linkedin/status'),
  invite: (id: string, body: LinkedInInviteRequest, options: RequestOptions = {}) =>
    call<LeadDetailResponse>(leadUrl(id, '/linkedin/invite'), { method: 'POST', body: JSON.stringify(body), ...options }),
  message: (id: string, body: LinkedInMessageRequest, options: RequestOptions = {}) =>
    call<LeadDetailResponse>(leadUrl(id, '/linkedin/message'), { method: 'POST', body: JSON.stringify(body), ...options }),
  /** Angenommene Anfragen und neue Antworten holen. */
  sync: () => call<LinkedInSyncResponse>('/api/linkedin/sync', { method: 'POST' }),
  /** Chats nachträglich mit LinkedIn abgleichen – startet im Hintergrund, Fortschritt über `chatSyncStatus`. */
  chatSync: (body: ChatSyncRequest = {}) => call<ChatSyncStatus>('/api/linkedin/chat-sync', { method: 'POST', body: JSON.stringify(body) }),
  chatSyncStatus: () => call<ChatSyncStatus>('/api/linkedin/chat-sync'),
  /** Bei Unipile verbundene Accounts – zur Auswahl in den Einstellungen. */
  accounts: () => call<LinkedInAccountsResponse>('/api/linkedin/accounts'),
  /** Reihenfolge der Scraping-Accounts beim Suchen (21.10.). */
  accountOrder: (ids: string[]) => call<{ ok: true }>('/api/linkedin/accounts/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  /** Eigene Tagesgrenzen eines Accounts (null = Standard). */
  accountLimits: (id: string, limits: Partial<LinkedInAccountLimits>) =>
    call<LinkedInAccountLimits>(`/api/linkedin/accounts/${encodeURIComponent(id)}/limits`, { method: 'PUT', body: JSON.stringify(limits) }),
  /** Accounts aufwärmen (21.10.): Stand je Aufwärm-Account. */
  warmup: () => call<LinkedInWarmupResponse>('/api/linkedin/warmup'),
  /** Genau eine Test-Anfrage (z. B. an einen Kollegen). */
  testInvite: (body: LinkedInTestInviteRequest) =>
    call<LinkedInTestInviteResponse>('/api/linkedin/test-invite', { method: 'POST', body: JSON.stringify(body) }),
  /** Test-LinkedIn-Account: gespeichertes Profil, prüfen und speichern, entfernen. */
  testProfile: () => call<LinkedInTestProfileResponse>('/api/linkedin/test-profile'),
  saveTestProfile: (body: LinkedInTestProfileRequest) =>
    call<LinkedInTestProfileResponse>('/api/linkedin/test-profile', { method: 'PUT', body: JSON.stringify(body) }),
  removeTestProfile: () => call<LinkedInTestProfileResponse>('/api/linkedin/test-profile', { method: 'DELETE' }),
  /** Genau eine Test-Vernetzungsanfrage an den gespeicherten Test-Account. */
  testConnect: (body: LinkedInTestConnectRequest) =>
    call<LinkedInTestConnectResponse>('/api/linkedin/test-connect', { method: 'POST', body: JSON.stringify(body) }),
  /** Genau eine Test-Nachricht an den gespeicherten Test-Account. */
  testMessage: (body: LinkedInTestMessageRequest) =>
    call<LinkedInTestMessageResponse>('/api/linkedin/test-message', { method: 'POST', body: JSON.stringify(body) }),
  /** Pause eines Accounts aufheben. */
  resume: (body: LinkedInResumeRequest) => call<LinkedInStatusResponse>('/api/linkedin/resume', { method: 'POST', body: JSON.stringify(body) }),
};

/** Sicherungen und Updates (`shared/system.ts`) – nur Admin und Gründer. */
export const systemApi = {
  backups: () => call<BackupListResponse>('/api/system/backups'),
  backupNow: () => call<BackupInfo>('/api/system/backups', { method: 'POST' }),
  /** Lädt die Sicherung als Datei herunter (mit Passwort – sie enthält alle Leads). */
  downloadBackup: (name: string, password: string): Promise<Blob> =>
    fetchFile(`/api/system/backups/${encodeURIComponent(name)}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  /** Schlüssel für die Geheimnisse der Einstellungen (mit Passwort) – zum Ablegen im Passwort-Manager. */
  settingsKey: (password: string) => call<SettingsKeyResponse>('/api/system/settings-key', { method: 'POST', body: JSON.stringify({ password }) }),
  restoreBackup: (name: string, password: string) =>
    call<RestoreResponse>(`/api/system/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', body: JSON.stringify({ password }) }),
  update: () => call<UpdateStatusResponse>('/api/system/update'),
  checkUpdate: () => call<UpdateStatusResponse>('/api/system/update/check', { method: 'POST' }),
  /** Ohne Passwort (seit 23.10.) – ein Klick genügt. */
  startUpdate: () => call<UpdateStatusResponse>('/api/system/update', { method: 'POST', body: '{}' }),
};

/** Übergabe heißer Leads an Close (`shared/crm.ts`, Phase 6). */
export const crmApi = {
  status: () => call<CrmStatusResponse>('/api/crm/status'),
  handover: (id: string, body: HandoverRequest, options: RequestOptions = {}) =>
    call<LeadDetailResponse>(leadUrl(id, '/handover'), { method: 'POST', body: JSON.stringify(body), ...options }),
};

/**
 * Live-Fortschritt eines Laufs. EventSource verbindet sich bei kurzen Abbrüchen selbst neu und bekommt dann
 * wieder den kompletten Stand. `onLost` meldet, wenn der Lauf auf dem Server nicht mehr existiert
 * (z. B. nach einem Neustart des Backends) oder das Backend dauerhaft nicht erreichbar ist.
 */
export function subscribeToRun(
  id: string,
  handlers: { onEvent: (event: RunEvent) => void; onLost: () => void },
): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let retryTimer: number | undefined;
  let retries = 0;

  const close = () => {
    closed = true;
    window.clearTimeout(retryTimer);
    source?.close();
  };
  const retryOrGiveUp = () => {
    if (closed) return;
    if (retries++ < 5) retryTimer = window.setTimeout(connect, 2000);
    else handlers.onLost();
  };

  function connect() {
    const current = new EventSource(`${BASE}/runs/${id}/events`);
    source = current;
    current.onmessage = (message) => {
      retries = 0;
      const event = JSON.parse(message.data) as RunEvent;
      handlers.onEvent(event);
      if (event.type === 'end') close();
    };
    current.onerror = () => {
      if (closed || current.readyState !== EventSource.CLOSED) return;
      // Verbindung endgültig zu – nachsehen, ob es den Lauf noch gibt.
      leadSearchApi
        .get(id)
        .then((run) => {
          if (closed) return;
          handlers.onEvent({ type: 'run', run });
          if (run.status === 'running') retryOrGiveUp();
          else {
            handlers.onEvent({ type: 'end', run });
            close();
          }
        })
        .catch((error: unknown) => {
          if (closed) return;
          if (error instanceof ApiError && error.status === 404) handlers.onLost();
          else retryOrGiveUp();
        });
    };
  }

  connect();
  return close;
}

/** Textvorschläge (Phase 4, `shared/messages.ts`). Gesendet wird von Hand. */
export const messagesApi = {
  suggest: (leadId: string, body: SuggestRequest) =>
    call<MessageSuggestion>(`/api/leads/${encodeURIComponent(leadId)}/suggest`, { method: 'POST', body: JSON.stringify(body) }),
};

/** Nachrichten-Vorlagen (`shared/messages.ts`, Phase 4) – Standardtexte plus in der Software angepasste. */
export const templatesApi = {
  list: () => call<TemplatesResponse>('/api/templates'),
  update: (id: string, body: UpdateTemplateRequest) =>
    call<MessageTemplate>(`/api/templates/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  reset: (id: string) => call<MessageTemplate>(`/api/templates/${encodeURIComponent(id)}/reset`, { method: 'POST' }),
  create: (body: CreateTemplateRequest) => call<MessageTemplate>('/api/templates', { method: 'POST', body: JSON.stringify(body) }),
  remove: (id: string) => call<{ ok: true }>(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** KI-Assistent (`shared/assistant.ts`): Chats mit Lesezugriff auf alle Outreach-Daten, Antworten als Stream. */
const assistantChat = (id: string, suffix = '') => `/api/assistant/chats/${encodeURIComponent(id)}${suffix}`;

export const assistantApi = {
  models: () => call<AssistantModelsResponse>('/api/assistant/models'),
  list: () => call<AssistantChatListResponse>('/api/assistant/chats'),
  create: (model?: string) => call<AssistantChatDetail>('/api/assistant/chats', { method: 'POST', body: JSON.stringify(model ? { model } : {}) }),
  get: (id: string) => call<AssistantChatDetail>(assistantChat(id)),
  remove: (id: string) => call<{ ok: true }>(assistantChat(id), { method: 'DELETE' }),
  stop: (id: string) => call<{ stopped: boolean }>(assistantChat(id, '/stop'), { method: 'POST' }),
  /**
   * Frage stellen: Die Antwort kommt als Stream (`text/event-stream`), jedes Ereignis geht an `onEvent`. Löst auf, wenn
   * der Stream zu Ende ist. Fehler vor dem Stream (404, 409 busy, 400) wie bei `call`.
   */
  ask: async (id: string, body: AssistantAskRequest, onEvent: (event: AssistantStreamEvent) => void): Promise<void> => {
    let response: Response;
    try {
      response = await fetch(assistantChat(id, '/messages'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new ApiError('offline', 'Backend nicht erreichbar.', 0);
    }
    if (!response.ok || !response.body) {
      const error = ((await response.json().catch(() => null)) as Partial<ApiErrorBody> | null)?.error;
      const detail = typeof error === 'object' ? error : undefined;
      reportUnauthorized(assistantChat(id, '/messages'), response.status, detail?.code);
      throw new ApiError(detail?.code ?? 'error', detail?.message ?? `Fehler ${response.status}`, response.status);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        // Kommentare (`: ping`) sind nur der Herzschlag.
        if (chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)) as AssistantStreamEvent);
        end = buffer.indexOf('\n\n');
      }
    }
  },
};

/** MCP-Server für die Claude-App (`shared/mcp.ts`): Freigabe einer Anmeldung und eigene Verbindungen. */
export const mcpApi = {
  consent: (id: string) => call<McpConsentInfo>(`/api/oauth/consent/${encodeURIComponent(id)}`),
  decide: (id: string, approve: boolean) =>
    call<McpConsentResult>(`/api/oauth/consent/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ approve }) }),
  connections: () => call<McpConnectionsResponse>('/api/mcp/connections'),
  disconnect: (id: string) => call<{ ok: true }>(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
