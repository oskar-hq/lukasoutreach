import { trackJob } from '../telemetry/store.js';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { AUTH_FOUNDER_IDS, defaultFounderName, type AuthFounderId } from '../../../shared/auth.js';
import { MESSAGE_WITHOUT_TEXT, type CockpitLead, type LeadAction, type LeadStage } from '../../../shared/leads.js';
import {
  INVITE_SPREAD_MIN_GAP_MINUTES,
  type LeadLinkedInState,
  type LinkedInActionsMode,
  type LinkedInInviteMode,
  type ChatSyncStatus,
  type LinkedInErrorCode,
  type LinkedInStatusResponse,
  type LinkedInSyncResponse,
  type LinkedInTestProfile,
  type LinkedInUnipileAccount,
} from '../../../shared/linkedin.js';
import { UNIPILE_SESSION_DOWN_TEXT, UnipileClient, UnipileHttpError, UnipileNetworkError, isUnipileSessionDown, type UnipileAccount, type UnipileChat, type UnipileMessage } from '../adapters/live/unipileClient.js';
import { currentPosition, distanceOf, pickLinkedinAccount } from '../adapters/live/liveAdapter.js';
import { SHARED_ACCOUNT_MESSAGE, sharedLinkedInAccount, usedAccountIds, type Config } from '../config.js';
import type { Database } from '../db/database.js';
import { DuplicateEventError, InvalidTransitionError, LeadNotFoundError, assertTransition, type ContactProfile, type ImportedMessage, type LeadStore } from '../leads/leadStore.js';
import { randomBetween, sleep } from '../lib/sleep.js';
import { LinkedInGuard, localDayStart, localTime, stableNumber, withinWorkHours, type ActionKind } from './guard.js';
import { relationTime, type ConnectionStore, type RelationItem } from './connections.js';
import { otherFounder } from './inviteAccount.js';
import { founderInviteLimits, type AccountPrefsStore } from './accountPrefs.js';
import { FOUNDER_SCRAPE_LIMITS, UNIPILE_LIMITS } from './accountUsage.js';

/**
 * Echte LinkedIn-Aktionen über Unipile (Roadmap Phase 3, Vertrag `shared/linkedin.ts`).
 *
 * Reihenfolge der Prüfungen vor jedem Senden: eingeschaltet → Lead da → Lead gehört dem Gründer → Account eingetragen →
 * Stufe passt → nicht pausiert → Arbeitszeit → Limit. Dann je Gründer nacheinander (Warteschlange) mit 3–8 s Pause,
 * Stufe und Limit noch einmal prüfen, senden, protokollieren, Verlauf schreiben. Erst nach erfolgreichem Senden ändert
 * sich die Stufe; schlägt das Senden fehl, bleibt der Lead unverändert.
 *
 * Simulation: nichts verlässt den Server; Limits gelten trotzdem, Arbeitszeit und Pausen nicht.
 */

export class LinkedInError extends Error {
  constructor(
    readonly code: LinkedInErrorCode | 'invalid_transition',
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'LinkedInError';
  }
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Pausen nach Fehlern: Limit → einen Tag, Zugang → 6 h, Serverfehler (kann ein verstecktes Limit sein) → 1 h. */
const PAUSE_LIMIT_MS = 24 * HOUR_MS;
const PAUSE_AUTH_MS = 6 * HOUR_MS;
const PAUSE_SERVER_MS = HOUR_MS;
/** Simulation: nach so vielen Sekunden (· MOCK_SPEED) wird eine Anfrage angenommen bzw. kommt eine Antwort. */
const MOCK_ACCEPT_S = 30;
const MOCK_REPLY_S = 60;
const MOCK_REPLY = 'Danke für die Nachricht – klingt spannend. Wann passt dir ein kurzer Call?';
const CHAT_STAGES = ['connected', 'contacted', 'replied', 'meeting'] as const;
/** Abgleich: Unterhaltungen mit Aktivität seit dem letzten Lauf (mit Überlapp), beim ersten Lauf nach dem Start 3 Tage. */
const SYNC_OVERLAP_MS = 30 * 60 * 1000;
const FIRST_SYNC_LOOKBACK_MS = 3 * 24 * HOUR_MS;
const SYNC_CHAT_PAGES = 5;
/** Rückfall ohne Chat-Liste: nur Leads mit Aktivität in den letzten 30 Tagen. */
const FALLBACK_ACTIVE_MS = 30 * 24 * HOUR_MS;

export function linkedInMode(config: Config): LinkedInActionsMode {
  if (config.mode === 'mock') return 'mock';
  return config.linkedin.enabled && config.unipile.dsn && config.unipile.apiKey ? 'live' : 'off';
}

export interface LinkedInDeps {
  config: Config;
  db: Database;
  leads: LeadStore;
  log: FastifyBaseLogger;
  /** Name eines Gründers in Meldungen (aus seinem Konto), ohne Angabe „Nick“/„Johannes“. */
  founderName?: (id: AuthFounderId) => string;
  /** Eigene Grenzen je LinkedIn-Account (21.10.) – Anfragen am Tag der Gründer. */
  accountPrefs?: AccountPrefsStore;
  /** Account wurde pausiert bzw. Pause aufgehoben – für Neuigkeiten (`shared/notifications.ts`). */
  onPause?: (founder: AuthFounderId, until: number, reason: string) => void;
  onResume?: (founder: AuthFounderId) => void;
  /** Gesehene Anfragen und neue Kontakte (05.11.) – ohne: nichts davon (ältere Tests). */
  connections?: ConnectionStore;
  /** Nach dem Abgleich, wenn neue Kontakte zur Übernahme vorgemerkt sind. */
  onNewContacts?: () => void;
  fetch?: typeof fetch;
  random?: () => number;
  /**
   * Untergrenze der Pause zwischen zwei Aktionen live (ms). Standard 3000 – Schutzgrenze aus CLAUDE.md, gilt auch,
   * wenn in der `.env` weniger steht. Nur Tests setzen 0, damit sie nicht warten.
   */
  minPauseMs?: number;
}

/** Schutzgrenze: live nie weniger als 3 s zwischen zwei Aktionen eines Accounts. */
export const MIN_PAUSE_MS = 3000;

/**
 * Nachricht aus dem LinkedIn-Chat fürs Cockpit. Eigene Nachricht ohne Text (09.11.: Follow-up als Sticker, Bild oder
 * Anhang) → `MESSAGE_WITHOUT_TEXT`, damit sie im Verlauf steht und als Follow-up zählt. Nur über das dokumentierte Feld
 * `text` erkannt – was genau es war, sagt das Cockpit deshalb nicht. Ohne Text vom Lead: ausgelassen (wie bisher).
 */
function chatMessage(message: UnipileMessage, now: number): ImportedMessage {
  const own = message.is_sender === 1;
  const text = message.text?.trim() ? message.text : own ? MESSAGE_WITHOUT_TEXT : '';
  return { id: message.id, text: text ?? '', fromLead: message.is_sender === 0, at: Math.min(Date.parse(message.timestamp), now) };
}

export class LinkedInService {
  readonly guard: LinkedInGuard;

  /** Name eines Gründers in Meldungen. */
  founderName(id: AuthFounderId): string {
    return this.deps.founderName?.(id) ?? defaultFounderName(id);
  }

  private client: { key: string; client: UnipileClient } | null = null;
  private readonly queues = new Map<AuthFounderId, Promise<unknown>>();
  private readonly lastActionAt = new Map<AuthFounderId, number>();
  private readonly lastTestMessageAt = new Map<AuthFounderId, number>();
  private readonly lastTestInviteAt = new Map<AuthFounderId, number>();
  private lastSyncAt: number | null = null;
  private syncing: Promise<LinkedInSyncResponse> | null = null;
  /** Woran der letzte Abgleich gescheitert ist (Job-Messung) – null = alle Accounts lesbar. */
  private syncFailure: string | null = null;
  private chatSyncState: ChatSyncStatus = { running: false, startedAt: null, finishedAt: null, leadsTotal: 0, leadsDone: 0, imported: 0, leadsUpdated: 0, problems: [] };
  private timer: NodeJS.Timeout | null = null;
  /** Wofür der Zeitgeber gerade geplant ist („live|15“) – nur neu planen, wenn sich das ändert. */
  private timerPlan: string | null = null;
  /** Abgleich im Hintergrund erlaubt (nur im echten Start, nicht in Tests). */
  private background = false;
  /** Warnung „Pause unter 3 s angehoben“ nur einmal ins Log. */
  private pauseWarned = false;
  /** Zeitgeber der eingeplanten Anfragen (05.11.). */
  private queueTimer: NodeJS.Timeout | null = null;
  private queueBusy = false;
  /** Wann die gesendeten Anfragen je Gründer zuletzt bei LinkedIn gelesen wurden. */
  private readonly invitesCheckedAt = new Map<AuthFounderId, number>();

  constructor(private readonly deps: LinkedInDeps) {
    this.guard = new LinkedInGuard(deps.db, deps.config.linkedin, (founder) => founderInviteLimits(deps.config, deps.accountPrefs)[founder]);
  }

  /** Aus der laufenden Konfiguration – Einstellungen wirken ohne Neustart. */
  get mode(): LinkedInActionsMode {
    return linkedInMode(this.deps.config);
  }

  private get unipile(): UnipileClient | null {
    return this.mode === 'live' ? this.readClient : null;
  }

  /**
   * Nur lesender Abgleich (11.10.): Auch wenn von Hand gesendet wird (LINKEDIN_ACTIONS aus), prüft das Cockpit über
   * Unipile, ob eingetragene Anfragen angenommen wurden – sobald Unipile eingerichtet ist. Sendet nie etwas.
   */
  get watching(): boolean {
    if (this.mode === 'mock' || this.mode === 'live') return true;
    return this.readClient !== null;
  }

  /** Unipile-Client unabhängig von LINKEDIN_ACTIONS – nur für lesende Abfragen (Abgleich). */
  private get readClient(): UnipileClient | null {
    const { dsn, apiKey } = this.deps.config.unipile;
    if (this.deps.config.mode !== 'live' || !dsn || !apiKey) return null;
    const key = `${dsn}|${apiKey}`;
    if (this.client?.key !== key) this.client = { key, client: new UnipileClient({ dsn, apiKey, fetch: this.deps.fetch, timeoutMs: 30_000, onlyAccounts: () => usedAccountIds(this.deps.config) }) };
    return this.client.client;
  }

  private get settings() {
    return this.deps.config.linkedin;
  }

  accountOf(founder: AuthFounderId): string | null {
    return this.mode === 'mock' ? `mock-${founder}` : this.settings.accounts[founder];
  }

  /** Deaktivierter Account (Wunsch des Nutzers 03.11.): kein Traffic mehr darüber – auch kein Senden. */
  private isDisabled(accountId: string | null): boolean {
    return !!accountId && !!this.deps.accountPrefs?.isDisabled(accountId);
  }

  private assertEnabled(accountId: string, founder: AuthFounderId): void {
    if (this.isDisabled(accountId)) {
      throw new LinkedInError(
        'linkedin_no_account',
        409,
        `Der LinkedIn-Account von ${this.founderName(founder)} ist deaktiviert – darüber geht gerade nichts raus. Unter Einstellungen → LinkedIn → Accounts wieder einschalten.`,
      );
    }
  }

  /** Live: beide Gründer auf demselben Account → nichts senden (die Grenzen gälten doppelt). */
  private assertOwnAccounts(): void {
    if (this.mode === 'live' && sharedLinkedInAccount(this.deps.config)) {
      throw new LinkedInError('linkedin_no_account', 409, `${SHARED_ACCOUNT_MESSAGE} Bitte unter Einstellungen → Senden über LinkedIn ändern.`);
    }
  }

  /**
   * Wie Anfragen über den Account des Gründers rausgehen (05.11.): `manual` = gar nicht über das Cockpit, `spread` =
   * eingeplant über den Tag (nur live), `instant` = sofort. Ohne Account bzw. Einstellungen: Standard.
   */
  inviteModeOf(founder: AuthFounderId, now = Date.now()): { mode: LinkedInInviteMode; until: number | null } {
    const accountId = this.accountOf(founder);
    const fallback = this.settings.inviteMode;
    if (!accountId || !this.deps.accountPrefs) return { mode: fallback, until: null };
    return this.deps.accountPrefs.inviteMode(accountId, now, fallback);
  }

  private assertNotManual(founder: AuthFounderId, now: number): void {
    const { mode, until } = this.inviteModeOf(founder, now);
    if (mode !== 'manual') return;
    const end = until ? ` bis ${new Date(until).toLocaleDateString('de-DE', { timeZone: this.settings.workHours.timeZone, day: '2-digit', month: '2-digit' })}` : '';
    throw new LinkedInError(
      'linkedin_manual',
      409,
      `${this.founderName(founder)} vernetzt sich${end} nur von Hand auf LinkedIn – schick die Anfrage dort selbst. Sobald sie angenommen ist, übernimmt das Cockpit den Kontakt von allein.`,
    );
  }

  status(now = Date.now()): LinkedInStatusResponse {
    return {
      mode: this.mode,
      accounts: AUTH_FOUNDER_IDS.map((founder) => {
        const usage = this.guard.usage(founder, now);
        const pause = this.mode === 'live' ? this.guard.activePause(founder, now) : null;
        const inviteMode = this.inviteModeOf(founder, now);
        const queue = this.queuedFor(founder);
        return {
          founder,
          connected: this.mode !== 'off' && this.accountOf(founder) !== null,
          invitesToday: { used: usage.invitesToday, limit: this.guard.invitesPerDay(founder) },
          invitesWeek: { used: usage.invitesWeek, limit: this.settings.invitesPerWeek },
          messagesToday: { used: usage.messagesToday, limit: this.settings.messagesPerDay },
          pausedUntil: pause?.until ?? null,
          pauseReason: pause?.reason ?? null,
          inviteMode: inviteMode.mode,
          manualUntil: inviteMode.until,
          // Die Anfragen-Zählung enthält seit 05.11. auch die von Hand auf LinkedIn gesendeten (guard.invitesSince).
          invitesSentToday: { used: usage.invitesToday, limit: this.guard.invitesPerDay(founder) },
          manualInvitesToday: this.deps.connections?.manualSince(founder, localDayStart(now, this.settings.workHours.timeZone)) ?? 0,
          queuedInvites: queue.count,
          nextQueuedAt: queue.next,
          invitesCheckedAt: this.mode === 'mock' ? this.lastSyncAt : (this.invitesCheckedAt.get(founder) ?? null),
        };
      }),
      workHours: { ...this.settings.workHours, days: [...this.settings.workHours.days] },
      withinWorkHours: this.mode !== 'live' || withinWorkHours(this.settings, now),
      lastSyncAt: this.lastSyncAt,
      watching: this.watching,
    };
  }

  // ── Senden ─────────────────────────────────────────────────────────────

  /**
   * Vernetzungsanfrage. founder = Gründer des angemeldeten Kontos (Mitarbeiter: sein Gründer; ohne Anmeldung: Besitzer
   * des Leads). actor = Anzeigename des Kontos fürs Ereignis.
   */
  async invite(leadId: string, founder: AuthFounderId | null, message?: string, actor: string | null = null, clientId?: string): Promise<CockpitLead> {
    const note = message?.trim() || undefined;
    // Über den Tag verteilt (05.11.): nur echt gesendet wird eingeplant; Simulation und „von Hand“ wie bisher.
    if (this.mode === 'live') {
      const lead = this.deps.leads.get(leadId);
      if (lead && !(clientId && this.deps.leads.hasClientEvent(leadId, clientId))) {
        const owner = founder ?? lead.owner;
        const sender = this.inviteSender(owner, Date.now());
        if (lead.owner === owner && this.accountOf(sender) && this.inviteModeOf(sender).mode === 'spread') {
          return this.queueInvite(lead, owner, sender, note ?? null, actor, clientId ?? null);
        }
      }
    }
    return this.sendInvite(leadId, founder, note, actor, clientId);
  }

  private sendInvite(leadId: string, founder: AuthFounderId | null, note: string | undefined, actor: string | null, clientId: string | undefined): Promise<CockpitLead> {
    return this.run(leadId, founder, actor, clientId, 'invite', 'invite_sent', async (lead, accountId, sender) => {
      let invitationId: string | null;
      if (this.unipile) {
        const result = await this.unipile.sendInvitation({ accountId, providerId: lead.person.providerId, message: note }, AbortSignal.timeout(30_000));
        invitationId = result.invitation_id ?? null;
      } else {
        invitationId = `mock-inv-${randomUUID().slice(0, 8)}`;
      }
      const now = Date.now();
      // Über wessen Account die Anfrage ging – Erstnachricht und Follow-ups laufen später ebenso (nur dort ist man vernetzt).
      const state: LeadLinkedInState = { ...emptyState(lead, sender), sentBy: sender, invitationId, invitedAt: now };
      return { request: { action: 'invite_sent', text: note }, state, detail: invitationId };
    });
  }

  /** Erstnachricht (aus „Vernetzt“) oder Follow-up/Antwort (aus „Angeschrieben“, „Antwort“, „Termin“). */
  message(leadId: string, founder: AuthFounderId | null, text: string, label?: string, actor: string | null = null, clientId?: string): Promise<CockpitLead> {
    const body = text.trim();
    return this.run(leadId, founder, actor, clientId, 'message', 'message_sent', async (lead, accountId, sender) => {
      const base = lead.linkedin ?? emptyState(lead, sender);
      let chatId = base.chatId;
      let chatStartedAt = base.chatStartedAt;
      let messageId: string | null = null;
      if (this.unipile) {
        if (chatId) {
          try {
            messageId = (await this.unipile.sendChatMessage({ chatId, text: body }, AbortSignal.timeout(30_000))).message_id ?? null;
          } catch (error) {
            // Gemerkter Chat bei Unipile unbekannt (20.10.: jedes Follow-up scheiterte mit 404, obwohl die Accounts
            // liefen) → nichts gesendet, also die Chat-ID verwerfen und über das Profil anschreiben.
            if (!(error instanceof UnipileHttpError && error.status === 404)) throw error;
            this.deps.log.warn({ leadId: lead.id, chatId, error: classify(error).log }, 'Gemerkter Chat bei Unipile unbekannt – schreibe über das Profil');
            chatId = null;
          }
        }
        if (!chatId) {
          const started = await this.unipile.startChat({ accountId, attendeeId: lead.person.providerId, text: body }, AbortSignal.timeout(30_000));
          chatId = started.chat_id ?? null;
          chatStartedAt = Date.now();
          messageId = started.message_id ?? null;
        }
      } else {
        if (!chatId) {
          chatId = `mock-chat-${randomUUID().slice(0, 8)}`;
          chatStartedAt = Date.now();
        }
        messageId = `mock-msg-${randomUUID().slice(0, 8)}`;
      }
      const state: LeadLinkedInState = { ...base, chatId, chatStartedAt };
      return { request: { action: 'message_sent', text: body, label }, state, detail: messageId };
    });
  }

  private async run(
    leadId: string,
    founderOrNull: AuthFounderId | null,
    actor: string | null,
    clientId: string | undefined,
    kind: ActionKind,
    action: LeadAction,
    send: (
      lead: CockpitLead,
      accountId: string,
      sender: AuthFounderId,
    ) => Promise<{ request: { action: LeadAction; text?: string; label?: string }; state: LeadLinkedInState; detail: string | null }>,
  ): Promise<CockpitLead> {
    if (this.mode === 'off') {
      throw new LinkedInError('linkedin_off', 409, OFF_MESSAGE);
    }
    const lead = this.deps.leads.get(leadId);
    if (!lead) throw new LeadNotFoundError();
    // Schon gesendet (gleiche clientId, z. B. nach Netzfehler wiederholt): nicht noch einmal senden.
    if (clientId && this.deps.leads.hasClientEvent(leadId, clientId)) throw new DuplicateEventError();
    const founder = founderOrNull ?? lead.owner;
    if (lead.owner !== founder) {
      throw new LinkedInError('linkedin_not_owner', 409, `Der Lead gehört ${this.founderName(lead.owner)} – gesendet wird über dessen eigenen LinkedIn-Account.`);
    }
    // Über welchen Account (Wunsch des Nutzers 12.10.): Nachrichten über den, der die Anfrage gesendet hat; Anfragen
    // über den eigenen, solange er Platz hat – sonst über den des anderen Gründers (`LINKEDIN_ACCOUNT_FALLBACK`).
    const sender = kind === 'message' ? (lead.linkedin?.sentBy ?? founder) : this.inviteSender(founder, Date.now());
    const accountId = this.accountOf(sender);
    this.assertOwnAccounts();
    if (!accountId) {
      throw new LinkedInError(
        'linkedin_no_account',
        409,
        noAccountMessage(this.founderName(sender)),
      );
    }
    this.assertEnabled(accountId, sender);
    if (kind === 'invite') this.assertNotManual(sender, Date.now());
    this.checkBeforeSend(lead, sender, kind, action, Date.now());

    return this.enqueue(sender, async () => {
      // Seit dem Klick kann sich etwas geändert haben (zweiter Klick, Limit, Pause).
      const fresh = this.deps.leads.get(leadId);
      if (!fresh) throw new LeadNotFoundError();
      // Zweiter Klick mit derselben Kennung stand in der Warteschlange hinter dem ersten → jetzt schon gesendet.
      if (clientId && this.deps.leads.hasClientEvent(leadId, clientId)) throw new DuplicateEventError();
      this.checkBeforeSend(fresh, sender, kind, action, Date.now());
      let result;
      try {
        result = await send(fresh, accountId, sender);
      } catch (error) {
        throw this.failure(error, sender, accountId, leadId, kind);
      }
      const now = Date.now();
      this.guard.record({ founder: sender, accountId, leadId, kind, status: 'sent', detail: result.detail }, now);
      this.deps.log.info({ leadId, founder, sender, kind }, 'LinkedIn-Aktion gesendet');
      const updated = this.deps.leads.applyAction(leadId, { ...result.request, ...(clientId ? { clientId } : {}) }, founder, now, { state: result.state }, actor);
      if (kind === 'invite') {
        this.deps.connections?.recordCockpitInvite(sender, updated, now);
        if (updated.queuedInvite) return this.deps.leads.setQueuedInvite(leadId, null, now) ?? updated;
      }
      return updated;
    });
  }

  // ── Anfragen über den Tag verteilt (05.11.) ─────────────────────────────

  /** Eingeplante Anfragen über den Account des Gründers: Anzahl und nächste. */
  private queuedFor(founder: AuthFounderId): { count: number; next: number | null } {
    const row = this.deps.db.prepare('SELECT COUNT(*) AS n, MIN(due_at) AS next FROM linkedin_invite_queue WHERE founder = ?').get(founder) as {
      n: number;
      next: number | null;
    };
    return { count: row.n, next: row.next };
  }

  /**
   * Anfrage einplanen statt sofort senden. Prüft vorab wie beim Senden (Stufe, Account, Pause, „nur von Hand“), aber
   * nicht Arbeitszeit und Tageslimit – die regelt der Plan. Schon eingeplant → unverändert zurück.
   */
  private queueInvite(lead: CockpitLead, owner: AuthFounderId, sender: AuthFounderId, note: string | null, actor: string | null, clientId: string | null): CockpitLead {
    if (lead.queuedInvite) return lead;
    try {
      assertTransition(lead, 'invite_sent');
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new LinkedInError('invalid_transition', 409, error.message);
      throw error;
    }
    this.assertOwnAccounts();
    const accountId = this.accountOf(sender);
    if (!accountId) throw new LinkedInError('linkedin_no_account', 409, noAccountMessage(this.founderName(sender)));
    this.assertEnabled(accountId, sender);
    this.assertNotManual(sender, Date.now());
    const now = Date.now();
    const at = this.nextInviteSlot(sender, now);
    this.deps.db
      .prepare(
        `INSERT INTO linkedin_invite_queue (lead_id, founder, by_founder, actor, message, client_id, due_at, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (lead_id) DO NOTHING`,
      )
      .run(lead.id, sender, owner, actor, note, clientId, at, now);
    this.deps.log.info({ leadId: lead.id, founder: sender, at }, 'Vernetzungsanfrage eingeplant');
    return this.deps.leads.setQueuedInvite(lead.id, { at, message: note, queuedAt: now }, now) ?? lead;
  }

  /** Eingeplante Anfrage zurücknehmen (`DELETE /api/leads/:id/linkedin/invite`). */
  cancelQueuedInvite(leadId: string): CockpitLead {
    const lead = this.deps.leads.get(leadId);
    if (!lead) throw new LeadNotFoundError();
    this.deps.db.prepare('DELETE FROM linkedin_invite_queue WHERE lead_id = ?').run(leadId);
    return lead.queuedInvite ? (this.deps.leads.setQueuedInvite(leadId, null) ?? lead) : lead;
  }

  /**
   * Nächster Sendezeitpunkt über den Account: innerhalb der Arbeitszeit, mindestens `INVITE_SPREAD_MIN_GAP_MINUTES`
   * nach der letzten eingeplanten Anfrage, zufällig im Rest des Tages verteilt, sodass die freien Plätze bis
   * Feierabend reichen. Ist der Tag voll (gesendet + eingeplant ≥ Tagesgrenze) oder vorbei, der nächste Arbeitstag.
   */
  nextInviteSlot(founder: AuthFounderId, now: number, exclude: string | null = null): number {
    const { fromHour, toHour, days, timeZone } = this.settings.workHours;
    const gap = INVITE_SPREAD_MIN_GAP_MINUTES * MINUTE_MS;
    const limit = Math.max(1, this.guard.invitesPerDay(founder));
    const queued = (this.deps.db.prepare('SELECT lead_id, due_at FROM linkedin_invite_queue WHERE founder = ?').all(founder) as { lead_id: string; due_at: number }[])
      .filter((row) => row.lead_id !== exclude)
      .map((row) => row.due_at);
    const todayStart = localDayStart(now, timeZone);
    for (let offset = 0; offset < 21; offset++) {
      // Tagesanfang je Tag neu bestimmen (Sommer-/Winterzeit: nicht einfach 24 h addieren).
      const dayStart = localDayStart(todayStart + offset * DAY_MS + 12 * HOUR_MS, timeZone);
      const weekday = localTime(dayStart + 12 * HOUR_MS, timeZone).weekday;
      if (!days.includes(weekday)) continue;
      const windowStart = dayStart + fromHour * HOUR_MS;
      const windowEnd = dayStart + toHour * HOUR_MS;
      const inDay = queued.filter((at) => at >= dayStart && at < dayStart + DAY_MS);
      const sent = offset === 0 ? this.guard.usage(founder, now).invitesToday : 0;
      const free = limit - sent - inDay.length;
      if (free <= 0) continue;
      const last = inDay.length ? Math.max(...inDay) : null;
      const from = Math.max(windowStart, offset === 0 ? now + 2 * MINUTE_MS : windowStart, last !== null ? last + gap : windowStart);
      if (from >= windowEnd - MINUTE_MS) continue;
      // Rest des Tages gleichmäßig auf die freien Plätze verteilen, darin zufällig.
      const share = Math.max(0, (windowEnd - MINUTE_MS - from) / free);
      return Math.round(from + share * (this.deps.random ?? Math.random)());
    }
    // Kein Arbeitstag eingestellt o. Ä.: morgen früh zur Arbeitszeit.
    return localDayStart(todayStart + DAY_MS + 12 * HOUR_MS, timeZone) + fromHour * HOUR_MS;
  }

  /**
   * Fällige eingeplante Anfragen senden – je Account höchstens eine pro Runde (jede Minute), nur in der Arbeitszeit.
   * Länger als 30 Minuten überfällig (Server war aus) → neu einplanen statt alles auf einmal nachzuholen.
   * Grenze, Pause, Arbeitszeit, Netz → später noch einmal; alles andere (abgelehnt, Stufe passt nicht …) → raus aus dem
   * Plan, mit Notiz im Verlauf.
   */
  async processQueue(now = Date.now()): Promise<number> {
    if (this.queueBusy || this.mode !== 'live') return 0;
    this.queueBusy = true;
    let sent = 0;
    try {
      for (const founder of AUTH_FOUNDER_IDS) {
        const row = this.deps.db
          .prepare('SELECT * FROM linkedin_invite_queue WHERE founder = ? AND due_at <= ? ORDER BY due_at ASC LIMIT 1')
          .get(founder, now) as { lead_id: string; founder: string; by_founder: string | null; actor: string | null; message: string | null; client_id: string | null; due_at: number } | undefined;
        if (!row) continue;
        const lead = this.deps.leads.get(row.lead_id);
        if (!lead || lead.stage !== 'new') {
          this.dropQueued(row.lead_id, lead ? 'Die Stufe hat sich geändert.' : null);
          continue;
        }
        if (!withinWorkHours(this.settings, now) || now - row.due_at > 30 * MINUTE_MS) {
          this.replan(row.lead_id, founder, now);
          continue;
        }
        try {
          await this.sendInvite(row.lead_id, (row.by_founder as AuthFounderId | null) ?? lead.owner, row.message ?? undefined, row.actor, row.client_id ?? undefined);
          this.deps.db.prepare('DELETE FROM linkedin_invite_queue WHERE lead_id = ?').run(row.lead_id);
          sent++;
        } catch (error) {
          if (error instanceof DuplicateEventError) {
            this.dropQueued(row.lead_id, null);
          } else if (error instanceof LinkedInError && ['linkedin_outside_hours', 'linkedin_limit', 'linkedin_paused', 'linkedin_error'].includes(error.code)) {
            const pause = this.guard.activePause(founder, now);
            this.replan(row.lead_id, founder, Math.max(now, pause?.until ?? 0));
          } else {
            this.dropQueued(row.lead_id, error instanceof Error ? error.message : 'Unbekannter Fehler.');
          }
        }
      }
    } finally {
      this.queueBusy = false;
    }
    return sent;
  }

  private replan(leadId: string, founder: AuthFounderId, from: number): void {
    const at = this.nextInviteSlot(founder, from, leadId);
    this.deps.db.prepare('UPDATE linkedin_invite_queue SET due_at = ? WHERE lead_id = ?').run(at, leadId);
    const lead = this.deps.leads.get(leadId);
    if (lead?.queuedInvite) this.deps.leads.setQueuedInvite(leadId, { ...lead.queuedInvite, at });
  }

  /** Aus dem Plan nehmen; mit Grund eine Notiz im Verlauf („nicht gesendet: …“). */
  private dropQueued(leadId: string, reason: string | null): void {
    this.deps.db.prepare('DELETE FROM linkedin_invite_queue WHERE lead_id = ?').run(leadId);
    const lead = this.deps.leads.get(leadId);
    if (!lead) return;
    if (lead.queuedInvite) this.deps.leads.setQueuedInvite(leadId, null);
    if (reason) {
      try {
        this.deps.leads.applyAction(leadId, { action: 'note', text: `Eingeplante Vernetzungsanfrage nicht gesendet: ${reason}` }, null, Date.now(), {}, null);
      } catch {
        // Notiz ist nur ein Hinweis.
      }
      this.deps.log.warn({ leadId, reason }, 'Eingeplante Vernetzungsanfrage verworfen');
    }
  }

  /**
   * Je Gründer nacheinander: gleichzeitige Aktionen (Cockpit und Test-Anfrage) laufen nie parallel über denselben
   * Account. Live vor jeder Aktion die zufällige Pause seit der letzten; danach – auch nach einem Fehlschlag – zählt
   * die Aktion als letzte. `work` prüft Grenzen selbst noch einmal (seit dem Klick kann sich etwas geändert haben).
   */
  private enqueue<T>(founder: AuthFounderId, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(founder) ?? Promise.resolve();
    const job = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.mode === 'live') {
          const last = this.lastActionAt.get(founder);
          const [from, to] = this.pauseRange();
          if (last !== undefined) await sleep(last + randomBetween(from, to, this.deps.random) - Date.now());
        }
        try {
          return await work();
        } finally {
          if (this.mode === 'live') this.lastActionAt.set(founder, Date.now());
        }
      });
    this.queues.set(founder, job);
    return job;
  }

  /** Pause live: aus den Einstellungen, aber nie unter der Schutzgrenze (die `.env` darf weniger enthalten). */
  private pauseRange(): [number, number] {
    const min = this.deps.minPauseMs ?? MIN_PAUSE_MS;
    const [from, to] = this.settings.pauseMs;
    if (from >= min) return [from, to];
    if (!this.pauseWarned) {
      this.pauseWarned = true;
      this.deps.log.warn('LINKEDIN_PAUSE_SECONDS liegt unter der Schutzgrenze – es gelten mindestens 3 Sekunden.');
    }
    return [min, Math.max(min, to)];
  }

  /**
   * Account für die nächste Anfrage des Gründers: eigener, solange er weder pausiert noch voll ist; sonst – mit
   * `LINKEDIN_ACCOUNT_FALLBACK` – der des anderen Gründers, wenn der eingetragen, frei und nicht voll ist. Passt keiner,
   * bleibt es beim eigenen (dann meldet `checkBeforeSend` Limit bzw. Pause wie bisher).
   */
  private inviteSender(founder: AuthFounderId, now: number): AuthFounderId {
    const free = (account: AuthFounderId) =>
      !this.guard.limitReached(account, 'invite', now) && !(this.mode === 'live' && this.guard.activePause(account, now));
    // „Nur von Hand“ (05.11.): der eigene Account bleibt (dann meldet `assertNotManual` es), nie Ausweich-Account.
    if (this.inviteModeOf(founder, now).mode === 'manual') return founder;
    if (free(founder) && !this.isDisabled(this.accountOf(founder))) return founder;
    const other = this.settings.accountFallback ? otherFounder(founder) : null;
    if (other && this.accountOf(other) && !this.isDisabled(this.accountOf(other)) && this.inviteModeOf(other, now).mode !== 'manual' && free(other)) return other;
    return founder;
  }

  private checkBeforeSend(lead: CockpitLead, founder: AuthFounderId, kind: ActionKind, action: LeadAction, now: number): void {
    try {
      assertTransition(lead, action);
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw new LinkedInError('invalid_transition', 409, error.message);
      throw error;
    }
    if (this.mode === 'live') {
      const pause = this.guard.activePause(founder, now);
      if (pause) {
        throw new LinkedInError('linkedin_paused', 503, `LinkedIn-Aktionen für ${this.founderName(founder)} pausiert: ${pause.reason}`, Math.ceil((pause.until - now) / 1000));
      }
      // Arbeitszeit nur für Vernetzungsanfragen (07.11.): Nachrichten gehen raus, wann die Aufgabe abgearbeitet wird.
      if (kind === 'invite' && !withinWorkHours(this.settings, now)) {
        const { fromHour, toHour } = this.settings.workHours;
        throw new LinkedInError('linkedin_outside_hours', 409, `Vernetzungsanfragen gehen nur zu Arbeitszeiten raus (${fromHour}–${toHour} Uhr an den eingestellten Arbeitstagen).`);
      }
    }
    const limit = this.guard.limitReached(founder, kind, now);
    if (limit) throw new LinkedInError('linkedin_limit', 429, limit.message, limit.retryAfter);
  }

  /** Fehler beim Senden: protokollieren, bei Limit-/Zugangsfehlern den Account pausieren, verständliche Meldung. */
  private failure(error: unknown, founder: AuthFounderId, accountId: string, leadId: string | null, kind: ActionKind): LinkedInError {
    const now = Date.now();
    const classified = classify(error);
    this.guard.record({ founder, accountId, leadId, kind, status: 'failed', detail: classified.log }, now);
    this.deps.log.warn({ founder, leadId, kind, error: classified.log }, 'LinkedIn-Aktion fehlgeschlagen');
    if (classified.pauseMs) {
      const until = now + classified.pauseMs;
      this.pause(founder, until, classified.reason);
      return new LinkedInError('linkedin_paused', 503, `${classified.reason} Nichts gesendet; ${this.founderName(founder)} ist vorsichtshalber pausiert.`, Math.ceil(classified.pauseMs / 1000));
    }
    return new LinkedInError(classified.code, classified.status, classified.reason);
  }

  // ── Test-Befehl ────────────────────────────────────────────────────────

  /**
   * Genau eine Vernetzungsanfrage an ein vorgegebenes Profil (Roadmap: erst ein Test, dann das Cockpit). Gleiche
   * Schutzgrenzen wie im Cockpit, aber ohne Lead. Gibt die invitation_id zurück.
   */
  async testInvite(founder: AuthFounderId, identifier: string, message?: string): Promise<{ name: string; invitationId: string | null }> {
    if (this.mode !== 'live' || !this.unipile) throw new LinkedInError('linkedin_off', 409, OFF_MESSAGE);
    const accountId = this.accountOf(founder);
    if (!accountId) throw new LinkedInError('linkedin_no_account', 409, noAccountMessage(this.founderName(founder)));
    this.assertEnabled(accountId, founder);
    this.assertOwnAccounts();
    // Vorab prüfen (schnelle Antwort), in der Warteschlange noch einmal – wie beim Senden im Cockpit.
    this.checkTestInvite(founder, Date.now());
    return this.enqueue(founder, async () => {
      const unipile = this.unipile;
      if (!unipile) throw new LinkedInError('linkedin_off', 409, OFF_MESSAGE);
      this.checkTestInvite(founder, Date.now());
      try {
        const profile = await unipile.getProfile({ accountId, identifier }, AbortSignal.timeout(30_000));
        if (!profile.provider_id) throw new LinkedInError('linkedin_rejected', 409, 'Profil ohne provider_id – nichts gesendet.');
        const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || identifier;
        const result = await unipile.sendInvitation({ accountId, providerId: profile.provider_id, message: message?.trim() || undefined }, AbortSignal.timeout(30_000));
        this.guard.record({ founder, accountId, leadId: null, kind: 'invite', status: 'sent', detail: `Test: ${result.invitation_id ?? ''}` }, Date.now());
        return { name, invitationId: result.invitation_id ?? null };
      } catch (error) {
        if (error instanceof LinkedInError) throw error;
        throw this.failure(error, founder, accountId, null, 'invite');
      }
    });
  }

  /** Pause, Arbeitszeit, Limit für die Test-Anfrage (wie `checkBeforeSend`, ohne Lead). */
  private checkTestInvite(founder: AuthFounderId, now: number): void {
    const pause = this.guard.activePause(founder, now);
    if (pause) {
      throw new LinkedInError('linkedin_paused', 503, `LinkedIn-Aktionen für ${this.founderName(founder)} pausiert: ${pause.reason}`, Math.ceil((pause.until - now) / 1000));
    }
    if (!withinWorkHours(this.settings, now)) {
      const { fromHour, toHour } = this.settings.workHours;
      throw new LinkedInError('linkedin_outside_hours', 409, `Gesendet wird nur zu Arbeitszeiten (${fromHour}–${toHour} Uhr an den eingestellten Arbeitstagen).`);
    }
    const limit = this.guard.limitReached(founder, 'invite', now);
    if (limit) throw new LinkedInError('linkedin_limit', 429, limit.message, limit.retryAfter);
  }

  // ── Test-LinkedIn-Account ──────────────────────────────────────────────

  /** Gespeicherter Test-Account (Tabelle `settings`, Schlüssel `linkedin_test_profile`) oder null. */
  testProfile(): LinkedInTestProfile | null {
    const row = this.deps.db.prepare('SELECT value FROM settings WHERE key = ?').get(TEST_PROFILE_KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as LinkedInTestProfile;
    } catch {
      return null;
    }
  }

  clearTestProfile(): void {
    this.deps.db.prepare('DELETE FROM settings WHERE key = ?').run(TEST_PROFILE_KEY);
  }

  private saveTestProfile(profile: LinkedInTestProfile): void {
    this.deps.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(TEST_PROFILE_KEY, JSON.stringify(profile));
  }

  /** Unipile-Client für den Test-Account: braucht nur Adresse und Token, nicht LINKEDIN_ACTIONS. */
  private testClient(): UnipileClient {
    const { dsn, apiKey } = this.deps.config.unipile;
    if (!dsn || !apiKey) {
      throw new LinkedInError('linkedin_off', 409, 'Unipile ist nicht eingerichtet – trag Adresse und Token unter Einstellungen → LinkedIn (Unipile) ein.');
    }
    return new UnipileClient({ dsn, apiKey, fetch: this.deps.fetch, timeoutMs: 30_000, onlyAccounts: () => usedAccountIds(this.deps.config) });
  }

  private testAccount(founder: AuthFounderId): string {
    const accountId = this.deps.config.mode === 'mock' ? `mock-${founder}` : this.settings.accounts[founder];
    if (!accountId) throw new LinkedInError('linkedin_no_account', 409, noAccountMessage(this.founderName(founder)));
    this.assertEnabled(accountId, founder);
    return accountId;
  }

  /** Profil über Unipile auflösen (ohne Benachrichtigung) – Grundlage für Prüfen und Senden. */
  private async resolveTestProfile(founder: AuthFounderId, identifier: string): Promise<LinkedInTestProfile> {
    const accountId = this.testAccount(founder);
    if (this.deps.config.mode === 'mock') {
      return { name: 'Test-Kontakt', headline: 'Test-Account', publicIdentifier: identifier, profileUrl: `https://www.linkedin.com/in/${identifier}`, providerId: `mock-${identifier}`, connected: true, checkedAt: Date.now() };
    }
    const client = this.testClient();
    let profile;
    try {
      profile = await client.getProfile({ accountId, identifier }, AbortSignal.timeout(30_000));
    } catch (error) {
      if (error instanceof UnipileHttpError && (error.status === 404 || error.status === 422)) {
        throw new LinkedInError('linkedin_rejected', 409, 'Dieses Profil findet LinkedIn nicht – bitte den Link prüfen.');
      }
      const classified = classify(error);
      throw new LinkedInError(classified.code === 'linkedin_paused' ? 'linkedin_error' : classified.code, classified.status, classified.reason.replace(/ – nichts gesendet\.?$/, '.'));
    }
    if (!profile.provider_id) throw new LinkedInError('linkedin_rejected', 409, 'LinkedIn liefert für dieses Profil keine Kennung – bitte ein anderes Profil wählen.');
    const publicIdentifier = profile.public_identifier ?? null;
    return {
      name: [profile.first_name, profile.last_name].filter(Boolean).join(' ') || identifier,
      headline: profile.headline?.trim() || null,
      publicIdentifier,
      profileUrl: publicIdentifier ? `https://www.linkedin.com/in/${publicIdentifier}` : null,
      providerId: profile.provider_id,
      connected: profile.network_distance === 'FIRST_DEGREE',
      checkedAt: Date.now(),
    };
  }

  // ── Persönlicher Kontakt per Link ──────────────────────────────────────

  /**
   * Profil eines persönlichen Kontakts für `POST /api/leads/contact` – genau ein Profilabruf über den Account des
   * Besitzers (`notify=false`), damit der Kontaktgrad für ihn gilt. Braucht nur den Unipile-Zugang, nicht
   * LINKEDIN_ACTIONS. Sendet nichts. Simulation: aus der Kennung erfunden, 1. Grad.
   */
  async lookupContact(owner: AuthFounderId, identifier: string): Promise<ContactProfile> {
    if (this.deps.config.mode === 'mock') return mockContact(identifier);
    const accountId = this.settings.accounts[owner];
    if (!accountId) throw new LinkedInError('linkedin_no_account', 409, noAccountMessage(this.founderName(owner)));
    this.assertEnabled(accountId, owner);
    const client = this.testClient();
    let profile;
    try {
      profile = await client.getProfile({ accountId, identifier }, AbortSignal.timeout(30_000));
    } catch (error) {
      if (error instanceof UnipileHttpError && (error.status === 404 || error.status === 422)) {
        throw new LinkedInError('linkedin_rejected', 409, 'Dieses Profil findet LinkedIn nicht – bitte den Link prüfen.');
      }
      const classified = classify(error);
      throw new LinkedInError(classified.code === 'linkedin_paused' ? 'linkedin_error' : classified.code, classified.status, classified.reason.replace(/ – nichts gesendet\.?$/, '.'));
    }
    if (!profile.provider_id) throw new LinkedInError('linkedin_rejected', 409, 'LinkedIn liefert für dieses Profil keine Kennung – bitte den Link prüfen.');
    const current = currentPosition(profile);
    const publicIdentifier = profile.public_identifier ?? null;
    return {
      firstName: profile.first_name?.trim() || identifier,
      lastName: profile.last_name?.trim() ?? '',
      headline: profile.headline?.trim() ?? '',
      position: current?.position?.trim() ?? '',
      company: current?.company?.trim() ?? '',
      location: profile.location?.trim() || null,
      website: profile.websites?.[0] ?? null,
      providerId: profile.provider_id,
      publicIdentifier,
      profileUrl: `https://www.linkedin.com/in/${encodeURIComponent(publicIdentifier ?? identifier)}`,
      networkDistance: distanceOf(profile.network_distance),
      pendingInvitation: profile.invitation?.type === 'SENT' && profile.invitation.status === 'PENDING',
    };
  }

  /**
   * Bestehende Unterhaltung mit einem eben aufgenommenen Kontakt übernehmen (Wunsch des Nutzers 19.10.): die neueste
   * 1:1-Unterhaltung über den Account des Besitzers, bis zu 100 Nachrichten. Nur lesend. Schlägt das fehl, bleibt der
   * Lead, wie er ist (der Kontakt ist schon angelegt) – Rückgabe dann `null`. Simulation: zwei erfundene Nachrichten.
   */
  async importContactChat(leadId: string): Promise<{ lead: CockpitLead; imported: number } | null> {
    const lead = this.deps.leads.get(leadId);
    if (!lead || lead.stage !== 'connected') return null;
    const owner = lead.owner;
    const now = Date.now();
    let chatId: string;
    let messages: ImportedMessage[];
    if (this.deps.config.mode === 'mock') {
      chatId = `mock-chat-${lead.id}`;
      messages = [
        { id: `mock-import-${lead.id}-1`, fromLead: false, at: now - 3 * 24 * HOUR_MS, text: `Hi ${lead.person.firstName}, schön, dass wir hier vernetzt sind!` },
        { id: `mock-import-${lead.id}-2`, fromLead: true, at: now - 2 * 24 * HOUR_MS, text: 'Danke dir! Lass uns gern mal kurz telefonieren.' },
      ];
    } else {
      const accountId = this.settings.accounts[owner];
      const { dsn, apiKey } = this.deps.config.unipile;
      if (!accountId || !dsn || !apiKey || this.isDisabled(accountId)) return null;
      try {
        const client = this.testClient();
        const chats = await client.attendeeChats({ accountId, attendeeId: lead.person.providerId, limit: 10 }, AbortSignal.timeout(30_000));
        const chat = (chats.items ?? []).filter((item) => !item.account_id || item.account_id === accountId).sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? ''))[0];
        if (!chat) return { lead, imported: 0 };
        const response = await client.chatMessages({ chatId: chat.id, limit: 100 }, AbortSignal.timeout(30_000));
        chatId = chat.id;
        messages = (response.items ?? [])
          .map((message) => chatMessage(message, now))
          .filter((message) => Number.isFinite(message.at) && message.text.trim());
      } catch (error) {
        // 404 „Attendee not found“ (10.11., bei fast jedem neuen Kontakt): Mit der Person gibt es noch keine
        // Unterhaltung – nichts zu übernehmen, keine Warnung.
        if (error instanceof UnipileHttpError && error.status === 404) return { lead, imported: 0 };
        this.deps.log.warn({ leadId, error: classify(error).log }, 'Chat des Kontakts nicht übernommen');
        return null;
      }
    }
    if (!messages.length) return { lead, imported: 0 };
    const chatStartedAt = Math.min(...messages.map((message) => message.at));
    const updated = this.deps.leads.importChat(leadId, messages, { sentBy: owner, invitationId: null, invitedAt: null, chatId, chatStartedAt }, now);
    // Übernommene Antworten nicht noch einmal über den Abgleich buchen.
    for (const message of messages) this.guard.markSeen(message.id, leadId, now);
    return { lead: updated, imported: messages.filter((message) => message.text.trim()).length };
  }

  /** Test-Account prüfen und speichern. Sendet nichts. */
  async setTestProfile(founder: AuthFounderId, identifier: string): Promise<LinkedInTestProfile> {
    const profile = await this.resolveTestProfile(founder, identifier);
    this.saveTestProfile(profile);
    return profile;
  }

  /**
   * Genau eine Nachricht an den gespeicherten Test-Account (nie an einen Lead) – prüft nach Updates, ob Nachrichten
   * ankommen. Braucht nur den Unipile-Zugang. Pause und Tageslimit gelten, höchstens eine Test-Nachricht pro Minute.
   */
  async testMessage(founder: AuthFounderId, text: string): Promise<{ name: string }> {
    const stored = this.testProfile();
    if (!stored) throw new LinkedInError('linkedin_rejected', 409, 'Zuerst einen Test-Account eintragen und prüfen.');
    const accountId = this.testAccount(founder);
    const now = Date.now();
    const pause = this.guard.activePause(founder, now);
    if (pause) throw new LinkedInError('linkedin_paused', 503, `LinkedIn-Aktionen für ${this.founderName(founder)} pausiert: ${pause.reason}`, Math.ceil((pause.until - now) / 1000));
    const limit = this.guard.limitReached(founder, 'message', now);
    if (limit) throw new LinkedInError('linkedin_limit', 429, limit.message, limit.retryAfter);
    // Simulation (Tests): nichts senden, keine Wartezeit.
    if (this.deps.config.mode === 'mock') return { name: stored.name };
    const last = this.lastTestMessageAt.get(founder);
    if (last !== undefined && now - last < TEST_MESSAGE_COOLDOWN_MS) {
      const wait = Math.ceil((last + TEST_MESSAGE_COOLDOWN_MS - now) / 1000);
      throw new LinkedInError('linkedin_limit', 429, `Bitte warte ${wait} Sekunden bis zur nächsten Test-Nachricht.`, wait);
    }
    this.lastTestMessageAt.set(founder, now);
    return this.enqueue(founder, async () => {
      // Vor dem Senden noch einmal auflösen: Ist es noch dasselbe Profil, und ist es (noch) ein Kontakt?
      const current = await this.resolveTestProfile(founder, stored.providerId);
      if (current.providerId !== stored.providerId) {
        throw new LinkedInError('linkedin_rejected', 409, 'Das gespeicherte Profil passt nicht mehr – bitte den Test-Account neu prüfen. Nichts gesendet.');
      }
      this.saveTestProfile({ ...stored, connected: current.connected, checkedAt: current.checkedAt });
      if (!current.connected) {
        throw new LinkedInError('linkedin_rejected', 409, `${stored.name} ist kein Kontakt von ${this.founderName(founder)} – LinkedIn stellt Nachrichten nur an Kontakte 1. Grades zu. Nichts gesendet.`);
      }
      try {
        const result = await this.testClient().startChat({ accountId, attendeeId: stored.providerId, text }, AbortSignal.timeout(30_000));
        this.guard.record({ founder, accountId, leadId: null, kind: 'message', status: 'sent', detail: `Test: ${result.message_id ?? ''}` }, Date.now());
        return { name: stored.name };
      } catch (error) {
        throw this.failure(error, founder, accountId, null, 'message');
      }
    });
  }

  /**
   * Genau eine Vernetzungsanfrage an den gespeicherten Test-Account (nie an einen Lead). Braucht nur den Unipile-Zugang.
   * Pause und Tageslimit für Anfragen gelten, höchstens eine Test-Anfrage pro Minute. Ist der Test-Account schon ein
   * Kontakt 1. Grades, geht keine Anfrage raus (LinkedIn würde sie ablehnen).
   */
  async testConnect(founder: AuthFounderId, note?: string): Promise<{ name: string }> {
    const stored = this.testProfile();
    if (!stored) throw new LinkedInError('linkedin_rejected', 409, 'Zuerst einen Test-Account eintragen und prüfen.');
    const accountId = this.testAccount(founder);
    const now = Date.now();
    const pause = this.guard.activePause(founder, now);
    if (pause) throw new LinkedInError('linkedin_paused', 503, `LinkedIn-Aktionen für ${this.founderName(founder)} pausiert: ${pause.reason}`, Math.ceil((pause.until - now) / 1000));
    const limit = this.guard.limitReached(founder, 'invite', now);
    if (limit) throw new LinkedInError('linkedin_limit', 429, limit.message, limit.retryAfter);
    // Simulation (Tests): nichts senden, keine Wartezeit.
    if (this.deps.config.mode === 'mock') return { name: stored.name };
    const last = this.lastTestInviteAt.get(founder);
    if (last !== undefined && now - last < TEST_MESSAGE_COOLDOWN_MS) {
      const wait = Math.ceil((last + TEST_MESSAGE_COOLDOWN_MS - now) / 1000);
      throw new LinkedInError('linkedin_limit', 429, `Bitte warte ${wait} Sekunden bis zur nächsten Test-Anfrage.`, wait);
    }
    this.lastTestInviteAt.set(founder, now);
    return this.enqueue(founder, async () => {
      const current = await this.resolveTestProfile(founder, stored.providerId);
      if (current.providerId !== stored.providerId) {
        throw new LinkedInError('linkedin_rejected', 409, 'Das gespeicherte Profil passt nicht mehr – bitte den Test-Account neu prüfen. Nichts gesendet.');
      }
      this.saveTestProfile({ ...stored, connected: current.connected, checkedAt: current.checkedAt });
      if (current.connected) {
        throw new LinkedInError(
          'linkedin_rejected',
          409,
          `${stored.name} ist schon ein Kontakt von ${this.founderName(founder)} – eine Anfrage geht nicht. Zum Testen die Verbindung auf LinkedIn entfernen oder einen anderen Test-Account wählen. Nichts gesendet.`,
        );
      }
      try {
        const result = await this.testClient().sendInvitation({ accountId, providerId: stored.providerId, message: note?.trim() || undefined }, AbortSignal.timeout(30_000));
        this.guard.record({ founder, accountId, leadId: null, kind: 'invite', status: 'sent', detail: `Test: ${result.invitation_id ?? ''}` }, Date.now());
        return { name: stored.name };
      } catch (error) {
        throw this.failure(error, founder, accountId, null, 'invite');
      }
    });
  }

  // ── Abgleich ───────────────────────────────────────────────────────────

  /** Angenommene Anfragen und neue Antworten holen. Läuft nie doppelt gleichzeitig. */
  sync(): Promise<LinkedInSyncResponse> {
    if (!this.syncing) {
      this.syncing = this.syncOnce().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async syncOnce(): Promise<LinkedInSyncResponse> {
    const result: LinkedInSyncResponse = { accepted: [], replied: [], problems: [], syncedAt: Date.now() };
    this.syncFailure = null;
    if (this.mode === 'off' && !this.watching) {
      result.problems.push('Unipile ist nicht eingerichtet – angenommene Anfragen lassen sich nicht automatisch prüfen.');
      return result;
    }
    for (const founder of AUTH_FOUNDER_IDS) {
      const accountId = this.accountOf(founder);
      if (!accountId) {
        result.problems.push(`${this.founderName(founder)}: kein LinkedIn-Account eingetragen.`);
        continue;
      }
      if (this.isDisabled(accountId)) {
        result.problems.push(`${this.founderName(founder)}: LinkedIn-Account ist deaktiviert – kein Abgleich.`);
        continue;
      }
      try {
        if (this.mode === 'mock') this.syncMock(founder, result);
        else {
          await this.syncLive(founder, accountId, result);
          this.liftAccessPause(founder);
        }
      } catch (error) {
        const classified = classify(error);
        // Nur Limit/Zugang pausieren – ein Serverfehler beim Lesen sperrt nicht das Senden.
        if (classified.pauseMs && stopsReading(error)) this.pause(founder, Date.now() + classified.pauseMs, classified.reason);
        this.deps.log.warn({ founder, error: classified.log }, 'LinkedIn-Abgleich fehlgeschlagen');
        result.problems.push(`${this.founderName(founder)}: ${classified.reason}`);
        // Für die Job-Messung: ein fehlender oder deaktivierter Account ist kein Fehlschlag, ein gescheiterter Abruf schon.
        this.syncFailure = `${this.founderName(founder)}: ${classified.reason}`;
      }
    }
    this.lastSyncAt = result.syncedAt;
    // Liegen gebliebene neue Kontakte (Übernahme scheiterte z. B. am Tageslimit) bei jedem Abgleich erneut versuchen –
    // nicht erst, wenn wieder ein neuer Kontakt dazukommt (06.11.).
    if (this.deps.connections?.hasPending()) this.deps.onNewContacts?.();
    return result;
  }

  /**
   * Pause wegen abgelehntem Zugang (Account bei Unipile getrennt) von selbst aufheben, sobald der Abgleich über den
   * Account wieder durchgeht (06.11.: Account neu verbunden, Cockpit blieb trotzdem bis zum Ablauf pausiert).
   * Pausen wegen Limit bleiben.
   */
  private liftAccessPause(founder: AuthFounderId): void {
    const pause = this.guard.activePause(founder, Date.now());
    if (!pause || !pause.reason.startsWith(ACCESS_PAUSE_REASON)) return;
    if (this.guard.clearPause(founder)) {
      this.deps.log.info({ founder }, 'LinkedIn-Pause aufgehoben – Account geht wieder');
      this.deps.onResume?.(founder);
    }
  }

  /**
   * Leads, deren Anfrage bzw. Unterhaltung über den Account dieses Gründers läuft (auch fremde Leads, 12.10.). `closed`:
   * auch „Verloren“/„Übergeben“ – eine späte Antwort öffnet sie wieder und landet in den Aufgaben (Wunsch des Nutzers
   * 22.10.: jede Antwort gehört in die Aufgaben, bis dahin kam sie bei diesen Leads gar nicht an).
   */
  private openLeads(founder: AuthFounderId, closed = false): CockpitLead[] {
    const stages: LeadStage[] = ['invited', ...CHAT_STAGES, ...(closed ? (['lost', 'handed_over'] as const) : [])];
    return this.deps.leads.list({ stages, limit: 100_000 }).leads.filter((lead) => (lead.linkedin?.sentBy ?? lead.owner) === founder);
  }

  private async syncLive(founder: AuthFounderId, accountId: string, result: LinkedInSyncResponse): Promise<void> {
    // Lesend – auch ohne LINKEDIN_ACTIONS (angenommene Anfragen von Hand gesendeter Anfragen erkennen).
    const unipile = this.readClient!;
    const leads = this.openLeads(founder, true);

    // Gesendete Anfragen (05.11.): neue merken – was nicht aus dem Cockpit kam, ist „von Hand“ (Sales Navigator …).
    const connections = this.deps.connections;
    if (connections) {
      const items: import('./connections.js').SentInvitationItem[] = [];
      let cursor: string | null | undefined = null;
      for (let page = 0; page < 5; page++) {
        const response: { items: import('./connections.js').SentInvitationItem[]; cursor?: string | null } = await unipile.invitationsSent(
          { accountId, limit: 100, cursor },
          AbortSignal.timeout(30_000),
        );
        items.push(...(response.items ?? []));
        cursor = response.cursor;
        if (!cursor) break;
      }
      connections.recordSentList(founder, items, Date.now());
      this.invitesCheckedAt.set(founder, Date.now());
    }

    // Angenommene Anfragen: neueste Kontakte (bis 3 Seiten) mit offenen Anfragen abgleichen. Seit 05.11. außerdem neue
    // Kontakte ohne Lead vormerken (Übernahme), solange die Seiten Kontakte seit Beobachtungsbeginn enthalten.
    const invited = this.openLeads(founder, true).filter((lead) => lead.stage === 'invited');
    const watchFrom = connections ? connections.relationsSince(accountId, Date.now()) : null;
    if (invited.length || watchFrom !== null) {
      const byId = new Map(invited.map((lead) => [lead.person.providerId, lead]));
      const byPublic = new Map(invited.filter((lead) => lead.person.publicIdentifier).map((lead) => [lead.person.publicIdentifier!.toLowerCase(), lead]));
      let cursor: string | null | undefined = null;
      for (let page = 0; page < 3; page++) {
        const response: { items: RelationItem[]; cursor?: string | null } = await unipile.listRelations({ accountId, limit: 100, cursor }, AbortSignal.timeout(30_000));
        let fresh = false;
        for (const relation of response.items ?? []) {
          const created = relationTime(relation.created_at);
          const lead = (relation.member_id && byId.get(relation.member_id)) || (relation.public_identifier && byPublic.get(relation.public_identifier.toLowerCase()));
          if (lead && byId.has(lead.person.providerId)) {
            byId.delete(lead.person.providerId);
            // Nie vor der eigenen Anfrage (falsche Uhr/alte Verbindung), nie in der Zukunft.
            const at = created ? Math.min(Math.max(created, lead.lastContactAt ?? 0), Date.now()) : undefined;
            this.deps.leads.applyAction(lead.id, { action: 'invite_accepted', at }, null, Date.now(), {});
            result.accepted.push(lead.id);
          }
          if (connections && watchFrom !== null && created !== null && created >= watchFrom) {
            fresh = true;
            connections.noteRelation(founder, relation, Date.now());
          }
        }
        cursor = response.cursor;
        if (!cursor || (!byId.size && !fresh)) break;
      }
      // Angestoßen wird die Übernahme einmal am Ende des Abgleichs (`syncOnce`, sobald etwas wartet) – nicht hier je
      // Gründer: Ein wartender Kontakt zählte sonst bei jedem Abgleich als „neu“ und löste zwei Runden aus (10.11.).
    }

    // Nachrichten (seit 20.10.): erst die Unterhaltungen mit neuer Aktivität seit dem letzten Abgleich holen (ein Abruf
    // statt einer je Lead), dann nur deren Nachrichten. Zuordnung über die gemerkte Chat-ID oder die LinkedIn-ID der
    // anderen Person – so kommen auch Antworten auf von Hand gesendete Nachrichten an. Klappt die Liste nicht, wie früher
    // je Lead mit Chat-ID (nur kürzlich aktive). Ein einzelner kaputter Chat bricht den Abgleich nie ab.
    const byChat = new Map(leads.filter((lead) => lead.linkedin?.chatId).map((lead) => [lead.linkedin!.chatId!, lead]));
    const byProvider = new Map(leads.map((lead) => [lead.person.providerId, lead]));
    const now = Date.now();
    const since = this.lastSyncAt ? this.lastSyncAt - SYNC_OVERLAP_MS : now - FIRST_SYNC_LOOKBACK_MS;
    let targets: Array<{ lead: CockpitLead; chatId: string }> | null = [];
    try {
      let cursor: string | null | undefined = null;
      for (let page = 0; page < SYNC_CHAT_PAGES; page++) {
        const response: { items: UnipileChat[]; cursor?: string | null } = await unipile.listChats(
          { accountId, after: new Date(since).toISOString(), limit: 100, cursor },
          AbortSignal.timeout(30_000),
        );
        for (const chat of response.items ?? []) {
          if (chat.account_id && chat.account_id !== accountId) continue;
          const lead = byChat.get(chat.id) ?? (chat.attendee_provider_id ? byProvider.get(chat.attendee_provider_id) : undefined);
          if (lead && !targets.some((target) => target.lead.id === lead.id)) targets.push({ lead, chatId: chat.id });
        }
        cursor = response.cursor;
        if (!cursor) break;
      }
    } catch (error) {
      if (stopsReading(error)) throw error;
      this.deps.log.warn({ founder, error: classify(error).log }, 'LinkedIn-Abgleich: Chat-Liste nicht lesbar – je Lead');
      targets = null;
    }
    targets ??= leads
      .filter((lead) => lead.linkedin?.chatId && CHAT_STAGES.includes(lead.stage as (typeof CHAT_STAGES)[number]) && now - lead.lastActivityAt < FALLBACK_ACTIVE_MS)
      .map((lead) => ({ lead, chatId: lead.linkedin!.chatId! }));
    for (const { lead, chatId } of targets) {
      try {
        const response = await unipile.chatMessages({ chatId, limit: 20 }, AbortSignal.timeout(30_000));
        const messages = (response.items ?? [])
          .map((message) => chatMessage(message, Date.now()))
          .filter((message) => Number.isFinite(message.at) && message.text.trim());
        // Unterhaltung, die das Cockpit begonnen hat: nur Nachrichten ab ihrem Beginn (ältere sind Vorgeschichte).
        const startedAt = lead.linkedin?.chatId === chatId ? lead.linkedin.chatStartedAt : null;
        const recent = startedAt ? messages.filter((message) => message.at >= startedAt - 60_000) : messages;
        const { received } = this.importChatMessages(lead.id, founder, { chatId, messages: recent });
        if (received && !result.replied.includes(lead.id)) result.replied.push(lead.id);
      } catch (error) {
        // Limit oder Zugang: für diesen Gründer aufhören (pausiert in `syncOnce`); sonst nur diesen Chat auslassen.
        if (stopsReading(error)) throw error;
        this.deps.log.warn({ founder, leadId: lead.id, error: classify(error).log }, 'LinkedIn-Abgleich: Chat nicht lesbar');
      }
    }
  }

  // ── Chats nachträglich abgleichen ──────────────────────────────────────

  get chatSyncStatus(): ChatSyncStatus {
    return { ...this.chatSyncState, problems: [...this.chatSyncState.problems] };
  }

  /**
   * Chat-Abgleich starten (Vertrag `shared/linkedin.ts`, Wunsch des Nutzers 19.10.). Läuft im Hintergrund; `false` =
   * lief schon. `done` nur für Tests (wartet auf das Ende).
   */
  startChatSync(founder?: AuthFounderId): { started: boolean; done: Promise<void> } {
    if (this.chatSyncState.running) return { started: false, done: this.chatSyncRun ?? Promise.resolve() };
    if (this.deps.config.mode !== 'mock' && !this.readClient) {
      throw new LinkedInError('linkedin_off', 409, 'Unipile ist nicht eingerichtet – trag Adresse und Token unter Einstellungen → LinkedIn (Unipile) ein.');
    }
    const founders = (founder ? [founder] : [...AUTH_FOUNDER_IDS]).filter((id) => this.accountOf(id) && !this.isDisabled(this.accountOf(id)));
    const plan = founders.map((id) => ({ founder: id, leads: this.chatLeads(id) }));
    const problems = (founder ? [founder] : [...AUTH_FOUNDER_IDS])
      .filter((id) => !founders.includes(id))
      .map((id) => `${this.founderName(id)}: ${this.accountOf(id) ? 'LinkedIn-Account ist deaktiviert – kein Abgleich.' : 'kein LinkedIn-Account eingetragen.'}`);
    this.chatSyncState = {
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      leadsTotal: plan.reduce((sum, entry) => sum + entry.leads.length, 0),
      leadsDone: 0,
      imported: 0,
      leadsUpdated: 0,
      problems,
    };
    this.chatSyncRun = this.runChatSync(plan)
      .catch((error) => {
        this.deps.log.warn({ error: classify(error).log }, 'Chat-Abgleich abgebrochen');
        this.chatSyncState.problems.push('Der Abgleich ist abgebrochen – versuch es später noch einmal.');
      })
      .finally(() => {
        this.chatSyncState.running = false;
        this.chatSyncState.finishedAt = Date.now();
        this.chatSyncRun = null;
      });
    return { started: true, done: this.chatSyncRun };
  }

  private chatSyncRun: Promise<void> | null = null;

  /** Nur vernetzte Leads (Wunsch des Nutzers 20.10.): Vernetzt, Angeschrieben, Antwort, Termin. */
  private chatLeads(founder: AuthFounderId): CockpitLead[] {
    return this.deps.leads.list({ owner: founder, stages: [...CHAT_STAGES], limit: 100_000 }).leads;
  }

  private async runChatSync(plan: Array<{ founder: AuthFounderId; leads: CockpitLead[] }>): Promise<void> {
    const state = this.chatSyncState;
    for (const { founder, leads } of plan) {
      const accountId = this.accountOf(founder)!;
      for (const [index, lead] of leads.entries()) {
        try {
          if (this.deps.config.mode !== 'mock' && index > 0) await sleep(randomBetween(...this.pauseRange(), this.deps.random));
          const messages = this.deps.config.mode === 'mock' ? this.mockChat(lead) : await this.liveChat(lead, accountId);
          const imported = messages ? this.importChatMessages(lead.id, founder, messages).imported : 0;
          state.imported += imported;
          if (imported) state.leadsUpdated += 1;
        } catch (error) {
          const classified = classify(error);
          this.deps.log.warn({ founder, leadId: lead.id, error: classified.log }, 'Chat-Abgleich: Chat nicht gelesen');
          if (classified.pauseMs && stopsReading(error)) {
            // Limit oder Zugang: für diesen Gründer aufhören, der Account wird wie beim Senden pausiert.
            this.pause(founder, Date.now() + classified.pauseMs, classified.reason);
            state.problems.push(`${this.founderName(founder)}: ${classified.reason} Abgleich für ${this.founderName(founder)} abgebrochen.`);
            state.leadsDone += leads.length - index;
            break;
          }
        }
        state.leadsDone += 1;
      }
    }
  }

  /** Unterhaltung des Leads (bekannte `chatId`, sonst die neueste 1:1 über den Account) mit bis zu 100 Nachrichten. */
  private async liveChat(lead: CockpitLead, accountId: string): Promise<{ chatId: string; messages: ImportedMessage[] } | null> {
    const client = this.readClient;
    if (!client) return null;
    let chatId = lead.linkedin?.chatId ?? null;
    if (!chatId) {
      const chats = await client.attendeeChats({ accountId, attendeeId: lead.person.providerId, limit: 10 }, AbortSignal.timeout(30_000));
      chatId =
        (chats.items ?? [])
          .filter((item) => !item.account_id || item.account_id === accountId)
          .sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? ''))[0]?.id ?? null;
    }
    if (!chatId) return null;
    const response = await client.chatMessages({ chatId, limit: 100 }, AbortSignal.timeout(30_000));
    const now = Date.now();
    return {
      chatId,
      messages: (response.items ?? [])
        .map((message) => chatMessage(message, now))
        .filter((message) => Number.isFinite(message.at) && message.text.trim()),
    };
  }

  /** Simulation: jeder dritte Lead in „Angeschrieben“ hat eine Antwort, die das Cockpit noch nicht kennt. */
  private mockChat(lead: CockpitLead): { chatId: string; messages: ImportedMessage[] } | null {
    // Nach der LinkedIn-ID, nicht der Lead-ID: dieselben Demo-Leads bei jedem Zurücksetzen.
    if (lead.stage !== 'contacted' || stableNumber(lead.person.providerId) % 3 !== 0) return null;
    const at = Math.min(Date.now(), (lead.lastContactAt ?? lead.lastActivityAt) + HOUR_MS);
    return { chatId: lead.linkedin?.chatId ?? `mock-chat-${lead.id}`, messages: [{ id: `mock-chatsync-${lead.id}`, text: 'Sorry für die späte Antwort – passt nächste Woche ein Call?', fromLead: true, at }] };
  }

  /**
   * Fehlende Nachrichten übernehmen, älteste zuerst, über die normalen Aktionen (Stufe, Zähler, Einschätzung der
   * Antwort). Ausgelassen: schon gesehene, gleicher Text wie ein Eintrag im Verlauf, bei verlorenen/übergebenen Leads
   * alles vor der letzten Aktivität. Gibt die Zahl der übernommenen zurück.
   */
  private importChatMessages(leadId: string, founder: AuthFounderId, chat: { chatId: string; messages: ImportedMessage[] }): { imported: number; received: number } {
    const leads = this.deps.leads;
    const lead = leads.get(leadId);
    if (!lead) return { imported: 0, received: 0 };
    const normalize = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const known = new Set(
      leads
        .events(leadId)
        .filter((event) => event.kind === 'message_sent' || event.kind === 'message_received')
        .map((event) => `${event.kind}|${normalize(event.text)}`),
    );
    // Von Hand eingetragene Nachrichten ohne Text (Sticker, 09.11.) – Zeitpunkte zum Abgleich mit dem Chat.
    const manualWithoutText = leads
      .events(leadId)
      .filter((event) => event.kind === 'message_sent' && event.text === MESSAGE_WITHOUT_TEXT && !event.title.includes('aus LinkedIn übernommen'))
      .map((event) => event.at);
    const closedSince = lead.stage === 'lost' || lead.stage === 'handed_over' ? lead.lastActivityAt : null;
    const now = Date.now();
    let imported = 0;
    let received = 0;
    for (const message of [...chat.messages].sort((a, b) => a.at - b.at)) {
      const kind = message.fromLead ? 'message_received' : 'message_sent';
      // Eigene Nachricht, solange die Anfrage offen ist (Notiz zur Anfrage, InMail): kein Beweis für „vernetzt“
      // (20.10.: Lead stand auf Vernetzt, obwohl die Anfrage auf LinkedIn noch ausstand). Vernetzt setzt nur die
      // Kontaktliste; nicht als gesehen merken, damit die Nachricht nach der Annahme noch übernommen wird.
      if (kind === 'message_sent' && leads.get(leadId)!.stage === 'invited') continue;
      if (this.guard.seen(message.id)) continue;
      this.guard.markSeen(message.id, leadId, now);
      if (message.text === MESSAGE_WITHOUT_TEXT) {
        // Ohne Text: schon über „Follow-up schon gesendet“ eingetragen (bis 12 h daneben)? Dann nicht doppelt. Der
        // Textvergleich unten passt hier nicht – zwei Sticker hätten denselben „Text“.
        const logged = manualWithoutText.findIndex((at) => Math.abs(at - message.at) <= 12 * HOUR_MS);
        if (logged >= 0) {
          manualWithoutText.splice(logged, 1);
          continue;
        }
      } else if (known.has(`${kind}|${normalize(message.text)}`)) continue;
      if (closedSince !== null && message.at <= closedSince) continue;
      const current = leads.get(leadId)!;
      try {
        const title = message.fromLead ? `Antwort von ${current.person.firstName} · aus LinkedIn übernommen` : 'Nachricht gesendet · aus LinkedIn übernommen';
        leads.applyAction(leadId, { action: kind, text: message.text, at: message.at }, message.fromLead ? null : founder, now, undefined, null, title);
        known.add(`${kind}|${normalize(message.text)}`);
        imported += 1;
        if (message.fromLead) received += 1;
      } catch (error) {
        // Passt nicht zur Stufe (z. B. eigene Nachricht an einen verlorenen Lead) – auslassen.
        if (!(error instanceof InvalidTransitionError)) throw error;
      }
    }
    const after = leads.get(leadId);
    // Unterhaltung merken, damit der normale Abgleich künftige Antworten von selbst holt.
    if (after && chat.messages.length && !after.linkedin?.chatId) {
      leads.setLinkedInState(leadId, { sentBy: founder, invitationId: after.linkedin?.invitationId ?? null, invitedAt: after.linkedin?.invitedAt ?? null, chatId: chat.chatId, chatStartedAt: Math.min(...chat.messages.map((message) => message.at)) });
    }
    return { imported, received };
  }

  /** Simulation: rund 2 von 3 Anfragen werden angenommen, auf rund jede 3. Nachricht kommt eine Antwort. */
  private syncMock(founder: AuthFounderId, result: LinkedInSyncResponse): void {
    const speed = this.deps.config.mockSpeed;
    const now = Date.now();
    for (const lead of this.openLeads(founder)) {
      const state = lead.linkedin;
      if (!state) continue;
      const number = stableNumber(lead.id);
      if (lead.stage === 'invited' && state.invitedAt && now - state.invitedAt >= MOCK_ACCEPT_S * 1000 * speed && number % 3 !== 0) {
        this.deps.leads.applyAction(lead.id, { action: 'invite_accepted' }, null, now, {});
        result.accepted.push(lead.id);
      } else if (
        lead.stage === 'contacted' &&
        state.chatId &&
        lead.lastContactAt &&
        now - lead.lastContactAt >= MOCK_REPLY_S * 1000 * speed &&
        number % 3 === 0 &&
        this.guard.markSeen(`mock-reply-${lead.id}`, lead.id, now)
      ) {
        this.deps.leads.applyAction(lead.id, { action: 'message_received', text: MOCK_REPLY }, null, now, {});
        result.replied.push(lead.id);
      }
    }
  }

  // ── Einrichten in der Oberfläche ───────────────────────────────────────

  /**
   * Bei Unipile verbundene LinkedIn-Accounts zur Auswahl für UNIPILE_ACCOUNT_NICK/JOHANNES. Braucht nur den
   * Unipile-Zugang, nicht LINKEDIN_ACTIONS. Simulation: zwei erfundene Accounts, kein Netz.
   */
  async unipileAccounts(): Promise<LinkedInUnipileAccount[]> {
    const { config } = this.deps;
    // Simulation ohne Auswahl: es gilt `mock-<gründer>` (wie `accountOf`).
    const current = (founder: AuthFounderId) => config.linkedin.accounts[founder] ?? (config.mode === 'mock' ? `mock-${founder}` : null);
    const assigned = (id: string): AuthFounderId | null => AUTH_FOUNDER_IDS.find((founder) => current(founder) === id) ?? null;
    if (config.mode === 'mock') {
      // Simulation: ohne UNIPILE_ACCOUNT_ID sucht der erste Account.
      const search = config.unipile.accountId ?? MOCK_UNIPILE_ACCOUNTS[0].id;
      return this.withPrefs(MOCK_UNIPILE_ACCOUNTS.map((account) => ({ ...account, assignedTo: assigned(account.id), searching: account.id === search, warmup: config.linkedin.warmupAccounts.includes(account.id), used: usedAccountIds(config).length === 0 || usedAccountIds(config).includes(account.id) })));
    }
    const { dsn, apiKey } = config.unipile;
    if (!dsn || !apiKey) {
      throw new LinkedInError('linkedin_off', 409, 'Unipile ist nicht eingerichtet – trag Adresse und Token unter Einstellungen → LinkedIn (Unipile) ein.');
    }
    let items: UnipileAccount[];
    try {
      const client = new UnipileClient({ dsn, apiKey, fetch: this.deps.fetch, timeoutMs: 20_000 });
      // Alle Accounts (auch nicht genutzte), damit man sie unter Einstellungen freigeben kann.
      items = (await client.listAccounts(AbortSignal.timeout(25_000), { all: true })).items ?? [];
    } catch (error) {
      this.deps.log.warn({ error: error instanceof UnipileHttpError ? `HTTP ${error.status}` : error instanceof Error ? error.name : 'Fehler' }, 'Unipile-Accounts nicht abrufbar');
      const rejected = error instanceof UnipileHttpError && (error.status === 401 || error.status === 403);
      throw new LinkedInError(
        'linkedin_error',
        503,
        rejected ? 'Unipile lehnt den Zugang ab – bitte Adresse und Token unter Einstellungen → LinkedIn (Unipile) prüfen.' : 'Unipile ist gerade nicht erreichbar – bitte später noch einmal.',
      );
    }
    // Derselbe Such-Account wie in der Lead-Suche (UNIPILE_ACCOUNT_ID, sonst die automatische Wahl).
    const used = usedAccountIds(config);
    const search = pickLinkedinAccount(used.length > 0 ? items.filter((account) => used.includes(account.id ?? '')) : items, config.unipile.accountId, config.unipile.searchApi)?.id ?? null;
    return this.withPrefs(items
      .filter((account) => typeof account.id === 'string' && account.id && (account.type ?? '').toUpperCase() === 'LINKEDIN')
      .map((account) => ({
        id: account.id!,
        name: account.name?.trim() || 'LinkedIn-Account ohne Namen',
        assignedTo: assigned(account.id!),
        searching: account.id === search,
        warmup: config.linkedin.warmupAccounts.includes(account.id!),
        used: used.length === 0 || used.includes(account.id!),
      })));
  }

  /**
   * Reihenfolge und Grenzen je Account (21.10.) ergänzen; ohne Einstellungen-Speicher (Tests) unverändert. Liste in
   * Such-Reihenfolge: alle Accounts mit Platz (seit 22.10. auch Gründer), dann Scraping-Accounts ohne Platz, die Gründer
   * ohne Platz zuletzt.
   */
  private withPrefs(accounts: LinkedInUnipileAccount[]): LinkedInUnipileAccount[] {
    const prefs = this.deps.accountPrefs;
    if (!prefs) return accounts;
    const { config } = this.deps;
    const api = config.unipile.searchApi;
    const atEnd = (account: LinkedInUnipileAccount) => account.assignedTo !== null && prefs.get(account.id).position === null;
    const sorted = prefs.sort(accounts.map((account) => account.id)).map((id) => accounts.find((account) => account.id === id)!);
    const ordered = [...sorted.filter((account) => !atEnd(account)), ...sorted.filter(atEnd)];
    return ordered.map((account) => {
      const pref = prefs.get(account.id);
      const founder = account.assignedTo !== null;
      return {
        ...account,
        position: pref.position,
        disabled: pref.disabled,
        // Nur Gründer-Accounts senden – dort zeigt die Oberfläche, wie Anfragen rausgehen (05.11.).
        ...(founder
          ? { inviteMode: prefs.inviteMode(account.id, Date.now(), config.linkedin.inviteMode).mode, manualUntil: prefs.inviteMode(account.id, Date.now(), config.linkedin.inviteMode).until }
          : {}),
        limits: { profilesPerDay: pref.profilesPerDay, searchResultsPerDay: pref.searchResultsPerDay, invitesPerDay: pref.invitesPerDay },
        limitDefaults: {
          profilesPerDay: (founder ? FOUNDER_SCRAPE_LIMITS : UNIPILE_LIMITS).profilesPerDay,
          searchResultsPerDay: (founder ? FOUNDER_SCRAPE_LIMITS : UNIPILE_LIMITS).searchResultsPerDay[api],
          invitesPerDay: founder ? config.linkedin.invitesPerDay : config.linkedin.warmupPerDay,
        },
      };
    });
  }

  /**
   * Lesender Zugang für die Überprüfung (05.11.): Unipile-Client und Account des Gründers – oder ein Satz, warum nicht.
   * Braucht nur den Unipile-Zugang, nicht LINKEDIN_ACTIONS. Simulation: kein Client, kein Problem.
   */
  readerFor(founder: AuthFounderId): { client: UnipileClient | null; accountId: string | null; problem: string | null } {
    if (this.mode === 'mock') return { client: null, accountId: `mock-${founder}`, problem: null };
    const accountId = this.settings.accounts[founder];
    if (!accountId) return { client: null, accountId: null, problem: `${this.founderName(founder)}: kein LinkedIn-Account eingetragen.` };
    if (this.isDisabled(accountId)) return { client: null, accountId, problem: `${this.founderName(founder)}: LinkedIn-Account ist deaktiviert.` };
    const client = this.readClient;
    if (!client) return { client: null, accountId, problem: 'Unipile ist nicht eingerichtet.' };
    return { client, accountId, problem: null };
  }

  /** Pause eines Accounts aufheben (wie `linkedinCli fortsetzen`). Keine Pause → unverändert. */
  resume(founder: AuthFounderId): LinkedInStatusResponse {
    if (this.guard.clearPause(founder)) this.deps.log.info({ founder }, 'LinkedIn-Pause aufgehoben');
    this.deps.onResume?.(founder);
    return this.status();
  }

  private pause(founder: AuthFounderId, until: number, reason: string): void {
    this.guard.setPause(founder, until, reason);
    this.deps.onPause?.(founder, until, reason);
  }

  // ── Abgleich im Hintergrund ────────────────────────────────────────────

  /** Live: Abgleich alle LINKEDIN_SYNC_MINUTES Minuten (nur lesend). */
  startBackgroundSync(): void {
    this.background = true;
    this.replanSync();
    // Eingeplante Anfragen (05.11.): jede Minute nachsehen – sendet nur live und in der Arbeitszeit.
    if (!this.queueTimer) {
      this.queueTimer = setInterval(() => {
        trackJob('eingeplante_anfragen', () => this.processQueue()).catch((error) => this.deps.log.error({ err: error }, 'Eingeplante Anfragen fehlgeschlagen'));
      }, MINUTE_MS);
      this.queueTimer.unref();
    }
  }

  /**
   * Zeitgeber nach den aktuellen Einstellungen planen – nach jeder Änderung der Einstellungen aufrufen (Modus,
   * LINKEDIN_ACTIONS, Zugang, LINKEDIN_SYNC_MINUTES). Ändert sich nichts, läuft der Zeitgeber unverändert weiter.
   */
  replanSync(): void {
    const minutes = this.settings.syncMinutes;
    // Auch im Eintragen-Modus (LINKEDIN_ACTIONS aus), solange Unipile eingerichtet ist – der Abgleich liest nur.
    const plan = this.background && this.mode !== 'mock' && this.watching && minutes > 0 ? `live|${minutes}` : null;
    if (plan === this.timerPlan) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.timerPlan = plan;
    if (!plan) return;
    this.timer = setInterval(() => {
      trackJob('linkedin_abgleich', () => this.sync(), () => this.syncFailure).catch((error) => this.deps.log.error({ err: error }, 'LinkedIn-Abgleich fehlgeschlagen'));
    }, minutes * 60_000);
    this.timer.unref();
  }

  /** Nur Tests: Minuten, für die der Abgleich gerade geplant ist (null = aus). */
  get plannedSyncMinutes(): number | null {
    return this.timerPlan ? Number(this.timerPlan.split('|')[1]) : null;
  }

  close(): void {
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.timerPlan = null;
    this.background = false;
  }
}

const TEST_PROFILE_KEY = 'linkedin_test_profile';
const TEST_MESSAGE_COOLDOWN_MS = 60_000;

/** Anfang des Pausen-Grunds bei abgelehntem Zugang – daran erkennt `liftAccessPause` die Pause. */
const ACCESS_PAUSE_REASON = 'Unipile lehnt den Zugang ab';

const OFF_MESSAGE = 'Echte LinkedIn-Aktionen sind ausgeschaltet – einschalten unter Einstellungen → Senden über LinkedIn.';

function noAccountMessage(name: string): string {
  return `Für ${name} ist kein LinkedIn-Account gewählt – unter Einstellungen → Senden über LinkedIn auswählen.`;
}

/** Simulation: zwei erfundene Unipile-Accounts zur Auswahl. */
const MOCK_UNIPILE_ACCOUNTS: readonly Omit<LinkedInUnipileAccount, 'assignedTo' | 'searching'>[] = [
  { id: 'mock-nick', name: 'Nick (Simulation)' },
  { id: 'mock-johannes', name: 'Johannes (Simulation)' },
  // Reiner Scraping-Account (21.10.): zum Ausprobieren von „Aufwärmen“.
  { id: 'mock-scraper', name: 'Scraping-Account (Simulation)' },
];

function emptyState(lead: CockpitLead, founder: AuthFounderId): LeadLinkedInState {
  return lead.linkedin ?? { sentBy: founder, invitationId: null, invitedAt: null, chatId: null, chatStartedAt: null };
}

/** Simulation: Name aus der Kennung („anna-berg-1a2b“ → Anna Berg), immer 1. Grad. */
export function mockContact(identifier: string): ContactProfile {
  const slug = identifier.toLowerCase();
  const words = slug
    .split(/[-_]+/)
    .filter((word) => word && !/\d/.test(word))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return {
    firstName: words[0] ?? 'Kontakt',
    lastName: words.slice(1).join(' '),
    headline: 'Geschäftsführer · Persönlicher Kontakt (Simulation)',
    position: 'Geschäftsführer',
    company: 'Kontakt GmbH (Simulation)',
    location: 'Deutschland',
    website: null,
    providerId: `mock-contact-${slug}`,
    publicIdentifier: slug,
    profileUrl: `https://www.linkedin.com/in/${encodeURIComponent(slug)}`,
    networkDistance: 1,
    pendingInvitation: false,
  };
}

interface Classified {
  code: LinkedInErrorCode;
  status: number;
  /** Satz für die Oberfläche (ohne Schlüssel oder Antworttext). */
  reason: string;
  /** Für das Protokoll. */
  log: string;
  pauseMs?: number;
}

/**
 * Beim Lesen (Abgleich, Chat-Abgleich) brechen nur echtes Limit und fehlender Zugang ab – ein Serverfehler oder eine
 * Zeitüberschreitung bei einem einzelnen Chat nicht (20.10.: sonst pausierte ein kaputter Chat den ganzen Account bei
 * jedem Abgleich, und keine Antwort kam mehr an).
 */
export function stopsReading(error: unknown): boolean {
  const { pauseMs } = classify(error);
  return pauseMs === PAUSE_LIMIT_MS || pauseMs === PAUSE_AUTH_MS;
}

/** Unipile-Fehler einordnen. Limit- und Zugangsfehler pausieren den Account, Einzelablehnungen nicht. */
export function classify(error: unknown): Classified {
  if (error instanceof LinkedInError) return { code: error.code === 'invalid_transition' ? 'linkedin_rejected' : error.code, status: error.status, reason: error.message, log: error.message };
  if (error instanceof UnipileNetworkError || (error instanceof Error && error.name === 'TimeoutError')) {
    return { code: 'linkedin_error', status: 502, reason: 'Unipile ist gerade nicht erreichbar – nichts gesendet, bitte später noch einmal.', log: error.message };
  }
  if (!(error instanceof UnipileHttpError)) {
    return { code: 'linkedin_error', status: 502, reason: 'Unerwarteter Fehler – nichts gesendet.', log: error instanceof Error ? error.message : String(error) };
  }
  const type = (error.type ?? '').toLowerCase();
  // Mit Aufruf und Unipiles Begründung, damit man im Log sieht, was genau scheitert (Pfad ohne Query, kein Token).
  const log = `HTTP ${error.status} ${error.type ?? ''}`.trim() + ` bei ${error.path}${error.detail ? `: ${error.detail.slice(0, 160)}` : ''}`;
  // Keine Unipile-Sitzung (Abo/Testzeitraum abgelaufen, Account getrennt): kein verstecktes Limit, also keine Pause –
  // die Aktion scheitert mit klarer Meldung, bis der Account bei Unipile wieder läuft.
  if (isUnipileSessionDown(error)) {
    return { code: 'linkedin_error', status: 503, reason: `${UNIPILE_SESSION_DOWN_TEXT} – nichts gesendet.`, log };
  }
  if (error.status === 429 || /too_many|limit|throttl|quota/.test(type)) {
    return { code: 'linkedin_paused', status: 503, reason: 'LinkedIn meldet ein Limit.', log, pauseMs: PAUSE_LIMIT_MS };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      code: 'linkedin_paused',
      status: 503,
      reason: `${ACCESS_PAUSE_REASON} (API-Key, Berechtigung oder LinkedIn-Account getrennt).`,
      log,
      pauseMs: PAUSE_AUTH_MS,
    };
  }
  if (error.status === 404) return { code: 'linkedin_rejected', status: 409, reason: 'Profil oder Unterhaltung bei LinkedIn nicht gefunden – nichts gesendet.', log };
  if (error.status === 400 || error.status === 409 || error.status === 422) {
    // Typische Fälle: schon eingeladen, kürzlich zurückgezogen, Nachricht nur an Kontakte möglich.
    const hint = /already|recently|cannot_resend|exists/.test(type)
      ? ' (vermutlich schon eingeladen oder vernetzt)'
      : /not_connected|no_connection|first_degree|relation/.test(type)
        ? ' (Nachrichten gehen nur an Kontakte)'
        : '';
    return { code: 'linkedin_rejected', status: 409, reason: `LinkedIn lehnt diese Aktion ab${hint} – nichts gesendet.`, log };
  }
  return { code: 'linkedin_paused', status: 503, reason: `Unipile meldet einen Serverfehler (HTTP ${error.status}) – kann ein verstecktes Limit sein.`, log, pauseMs: PAUSE_SERVER_MS };
}
