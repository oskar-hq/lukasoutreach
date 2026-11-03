import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import { HIRING_ROLE_MAX_LENGTH, LEAD_CATEGORIES } from '../../../shared/leadSearch.js';
import {
  BOARD_COLUMN_NAME_MAX,
  DEAL_VALUE_MAX,
  LEAD_ACTIONS,
  LEAD_STAGES,
  REPLY_INTERESTS,
  type BoardColumnsResponse,
  type ConversationListResponse,
  type CreateLeadsResponse,
  type DeleteLeadResponse,
  type LeadDetailResponse,
  type RequeueInvitesResponse,
  type UnsentInvitesResponse,
  type LeadErrorCode,
  type LeadListResponse,
} from '../../../shared/leads.js';
import type { EnrichmentErrorCode } from '../../../shared/enrichment.js';
import type { SettingsErrorCode } from '../../../shared/settings.js';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { LEAD_FEEDBACK_NOTE_MAX, LEAD_FEEDBACK_REASONS, type LearningSummary } from '../../../shared/learning.js';
import { InviteLimiter } from '../auth/rateLimit.js';
import { actorFor, assistantDenial, type FounderNameOf } from '../auth/roles.js';
import { leadDistributionPool, type Config } from '../config.js';
import type { Database } from '../db/database.js';
import { EnrichmentLimitError, EnrichmentOffError, EnrichmentService } from '../enrichment/service.js';
import { DASHBOARD_DAYS_DEFAULT, DASHBOARD_DAYS_MAX } from '../../../shared/dashboard.js';
import { loadDashboard } from '../dashboard/dashboard.js';
import { localDayStart, nextLocalMidnight } from '../linkedin/guard.js';
import { FounderAccounts } from '../linkedin/founderAccounts.js';
import type { AccountPrefsStore } from '../linkedin/accountPrefs.js';
import { founderInviteLimits } from '../linkedin/accountPrefs.js';
import { accountHasRoom, inviteAccountFor, otherFounder, type InviteCounts, type InviteLimits } from '../linkedin/inviteAccount.js';
import { ACCOUNT_PAUSED_MESSAGE, TASK_TYPES, type TasksResponse } from '../../../shared/tasks.js';
import { computeTasks } from '../tasks/dailyTasks.js';
import { hasDangerousScheme, safeWebUrl } from './webUrl.js';
import {
  DuplicateBoardColumnError,
  InvalidBoardOrderError,
  DuplicateEventError,
  InvalidFollowUpError,
  InvalidTransitionError,
  LeadNotFoundError,
  LeadStore,
  UnknownBoardColumnError,
} from './leadStore.js';

/** Routen `/api/leads/*` laut Vertrag `shared/leads.ts`. */

const founder = z.enum(AUTH_FOUNDER_IDS);

const ListQuery = z.object({
  owner: founder.optional(),
  stage: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((part) => part.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(LEAD_STAGES))),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['activity', 'score', 'recent']).default('activity'),
  // Überblick nach Kapitalanlage-Vertrieb / Finanzdienstleister / Bauträger (19.10., 27.10.): KI-Kategorien, durch Komma getrennt.
  category: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((part) => part.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(LEAD_CATEGORIES))),
  // Board: zur Stufen-Auswahl zusätzlich alle Leads in eigenen Spalten (auch verlorene/übergebene).
  columns: z
    .enum(['1', 'true', '0', 'false'])
    .optional()
    .transform((value) => value === '1' || value === 'true'),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

const text = (max: number) => z.string().trim().max(max);

export { webUrlProblem } from './webUrl.js';

/** Website und Werbebibliothek: Seltsames wird null, statt die ganze Übergabe abzulehnen. */
const webUrl = (max: number) => z.string().transform((value) => (value.trim().length > max ? null : safeWebUrl(value)));

/** Profil-Adresse: `javascript:`, `data:` … lehnen ab (sieht nach Angriff aus), sonst Seltsames → null. */
const profileUrl = (max: number) =>
  z
    .string()
    .refine((value) => !hasDangerousScheme(value), { message: 'Nur Adressen mit http:// oder https:// sind erlaubt.' })
    .transform((value) => (value.trim().length > max ? null : safeWebUrl(value)));

const MetaAdsSchema = z.object({
  state: z.enum(['none', 'stopped', 'active', 'unchecked']),
  advertiser: z.string().nullable(),
  ads: z.number(),
  activeAds: z.number(),
  lastStop: z.string().nullable(),
  foreignAds: z.number(),
  libraryUrl: webUrl(2000).nullable(),
  note: z.string().nullable(),
});

const CardSchema = z.object({
  runId: text(64),
  mode: z.enum(['mock', 'live']),
  providerId: text(200).min(1),
  publicIdentifier: text(200).nullable(),
  profileUrl: profileUrl(500).nullable(),
  firstName: text(100),
  lastName: text(100),
  headline: text(500),
  position: text(300),
  company: text(300),
  location: text(200).nullable(),
  website: webUrl(500).nullable(),
  networkDistance: z.union([z.literal(1), z.literal(2), z.literal(3), z.null()]),
  category: z.enum(LEAD_CATEGORIES),
  confidence: z.number().min(0).max(1),
  reason: text(1000),
  summary: text(2000),
  metaAds: MetaAdsSchema.nullable(),
  // Hiring-Signal aus der Lead-Suche (13.10.); der Speicher übernimmt nur bekannte Felder.
  hiring: z
    .object({
      role: text(HIRING_ROLE_MAX_LENGTH).nullable(),
      source: z.enum(['profile', 'ai', 'manual']),
      evidence: text(500).nullable().optional(),
    })
    .nullable()
    .optional(),
});

const CreateSchema = z.object({ cards: z.array(CardSchema).min(1).max(100), owner: founder.optional() });

const ActionSchema = z.object({
  action: z.enum(LEAD_ACTIONS),
  text: text(10_000).optional(),
  label: text(40).optional(),
  at: z.number().int().positive().optional(),
  clientId: z.string().trim().min(1).max(64).optional(),
});

const SnoozeSchema = z.object({ until: z.number().int().positive().optional() });

/** Höchstens so weit in die Zukunft überspringen. */
const SNOOZE_MAX_MS = 30 * 24 * 60 * 60 * 1000;


const UpdateSchema = z
  .object({
    owner: founder.optional(),
    // Board: Stufe von Hand, auch zurück (19.10.).
    stage: z.enum(LEAD_STAGES).optional(),
    followUpPlan: z
      .object({ at: z.number().int().positive(), column: z.string().min(1).max(64).nullable().optional() })
      .nullable()
      .optional(),
    replyInterest: z.enum(REPLY_INTERESTS).nullable().optional(),
    nextStep: text(300).nullable().optional(),
    boardColumn: z.string().min(1).max(64).nullable().optional(),
    // Deal Value in ganzen Euro (11.10.).
    dealValue: z.number('Deal Value bitte als Zahl in Euro.').int('Deal Value bitte in ganzen Euro.').min(0, 'Deal Value darf nicht negativ sein.').max(DEAL_VALUE_MAX, 'Deal Value ist zu hoch.').nullable().optional(),
    // Meta-Ads-Stand von Hand (11.10.).
    metaAds: z
      .object({
        state: z.enum(['none', 'stopped', 'active']),
        lastStop: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum bitte als JJJJ-MM-TT.').nullable().optional(),
      })
      .optional(),
    // 👍/👎 zur Lead-Qualität (13.10., `shared/learning.ts`); null nimmt die eigene Rückmeldung zurück.
    feedback: z
      .object({
        verdict: z.enum(['good', 'bad']),
        reason: z.enum(LEAD_FEEDBACK_REASONS).nullable().optional(),
        note: z.string().trim().max(LEAD_FEEDBACK_NOTE_MAX, `Notiz höchstens ${LEAD_FEEDBACK_NOTE_MAX} Zeichen.`).nullable().optional(),
      })
      .nullable()
      .optional(),
    // Hiring-Signal von Hand (13.10.): { role } = sucht Mitarbeiter, null = sucht keine.
    hiring: z
      .object({
        role: z.string().trim().max(HIRING_ROLE_MAX_LENGTH, `Stelle höchstens ${HIRING_ROLE_MAX_LENGTH} Zeichen.`).nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .refine(
    (value) =>
      value.owner !== undefined ||
      value.nextStep !== undefined ||
      value.boardColumn !== undefined ||
      value.dealValue !== undefined ||
      value.metaAds !== undefined ||
      value.feedback !== undefined ||
      value.hiring !== undefined ||
      value.stage !== undefined ||
      value.followUpPlan !== undefined ||
      value.replyInterest !== undefined,
    'Nichts zu ändern.',
  );
const ColumnSchema = z.object({
  name: z.string('Bitte einen Namen eingeben.').trim().min(1, 'Bitte einen Namen eingeben.').max(BOARD_COLUMN_NAME_MAX, `Höchstens ${BOARD_COLUMN_NAME_MAX} Zeichen.`),
});
const ColumnParams = z.object({ id: z.string().min(1).max(64) });
const OrderSchema = z.object({ order: z.array(z.string().min(1).max(80)).max(200) });
const StageParams = z.object({ stage: z.enum(LEAD_STAGES) });
const StageNameSchema = z.object({ name: z.string().max(BOARD_COLUMN_NAME_MAX, `Höchstens ${BOARD_COLUMN_NAME_MAX} Zeichen.`).nullable() });

/** Lesende Lead-Routen mit `:id`, die auch Mitarbeiter auf fremden Leads nutzen dürfen (schreiben nichts). */
const READ_ONLY_LEAD_ROUTES = new Set(['/api/leads/:id/suggest']);

function sendError(reply: FastifyReply, status: number, code: LeadErrorCode | EnrichmentErrorCode | SettingsErrorCode | 'unauthorized' | 'not_allowed', message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'Anfrage'}: ${issue.message}`).join(' ');
}

const ClayCallbackSchema = z.looseObject({ leadId: z.string().trim().min(1).max(64) });

/** Vergleich in konstanter Zeit (über die Hashes, damit auch die Länge nichts verrät). */
function sameSecret(given: string, expected: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

export function registerLeadRoutes(
  app: FastifyInstance,
  {
    config,
    db,
    onDemoReset,
    founderName,
    founderAccounts = new FounderAccounts({ config }),
    accountPrefs,
  }: {
    config: Config;
    db: Database;
    /** Eigene Tagesgrenzen je LinkedIn-Account (21.10.). */
    accountPrefs?: AccountPrefsStore;
    /** Welche Gründer-Accounts gerade verbunden sind (17.10.) – sonst pausieren ihre Aufgaben. */
    founderAccounts?: FounderAccounts;
    /** Nach `POST /api/leads/demo/reset` (z. B. automatische Suche leeren). */
    onDemoReset?: () => void;
    /** Namen der Gründer in 403-Sätzen (aus den Gründer-Konten). */
    founderName?: FounderNameOf;
  },
) {
  // LEAD_DISTRIBUTION=balanced: neue Leads (auch der automatischen Suche, die diesen Store nutzt) auf beide Gründer
  // verteilen – Regel in LeadStore.createFromCards.
  const store = new LeadStore(db, { ownerPool: () => leadDistributionPool(config) });

  // Mitarbeiter buchen nur auf Leads ihres Gründers (Vertrag „Rollen und Rechte“): jede schreibende Route unter
  // `/api/leads/:id…` – auch die LinkedIn-Routen, die später registriert werden. Lesen bleibt erlaubt.
  // Unbekannter Lead: weiter zur Route (404 dort).
  // Geplante Follow-ups (20.10.): fällige einlösen, bevor Leads, Aufgaben, Chats oder Dashboard gelesen werden.
  app.addHook('onRequest', async (request) => {
    if (request.method !== 'GET') return;
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/leads') || path === '/api/tasks' || path === '/api/conversations' || path === '/api/dashboard') store.releaseDueFollowUps();
  });

  app.addHook('preHandler', async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith('/api/leads/:id') || request.method === 'GET' || request.method === 'HEAD' || READ_ONLY_LEAD_ROUTES.has(route)) return;
    const id = (request.params as { id?: unknown }).id;
    const lead = typeof id === 'string' ? store.get(id) : null;
    const denial = lead ? assistantDenial(request.authUser, lead.owner, founderName) : null;
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
  });
  const enrichment = new EnrichmentService({ config, db, leads: store, log: app.log });
  app.addHook('onClose', async () => enrichment.close());
  // Falsche Schlüssel am Rückkanal: 10 je IP in 15 Minuten, dann 429.
  const callbackLimiter = new InviteLimiter();

  // Simulation: leere Datenbank → Demo-Leads anlegen, damit das Cockpit sofort etwas zeigt.
  app.addHook('onReady', async () => {
    if (config.mode === 'mock' && store.count() === 0) {
      const count = store.resetDemo();
      app.log.info({ count }, 'Demo-Leads angelegt (Simulation)');
    }
    const scored = store.backfillScores();
    if (scored) app.log.info({ count: scored }, 'Score für ältere Leads nachgerechnet');
  });

  /** Anfragen je LinkedIn-Account heute und in 7 Tagen, dazu die Grenzen (Account-Wechsel, Wunsch des Nutzers 12.10.). */
  const inviteCounts = (now: number): InviteCounts => ({
    today: store.invitesByAccount(localDayStart(now, config.linkedin.workHours.timeZone)),
    week: store.invitesByAccount(now - 7 * 24 * 60 * 60 * 1000),
  });
  const inviteLimits = (): InviteLimits => ({
    perDay: config.linkedin.invitesPerDay,
    perDayFor: founderInviteLimits(config, accountPrefs),
    perWeek: config.linkedin.invitesPerWeek,
    fallback: config.linkedin.accountFallback,
  });

  /**
   * Über welchen Account die Anfrage eines Gründers gehen darf – eigener, sonst (Fallback) der des anderen. Sind beide
   * voll: `blocked` mit Satz.
   */
  const inviteAccount = (
    owner: AuthFounderId,
    now: number,
    usable: (account: AuthFounderId) => boolean = () => true,
  ): { account: AuthFounderId } | { blocked: string } => {
    const counts = inviteCounts(now);
    const limits = inviteLimits();
    const account = inviteAccountFor(owner, counts, limits, usable);
    if (account) return { account };
    const both = limits.fallback && otherFounder(owner) ? ' – auf beiden LinkedIn-Accounts' : '';
    if ((counts.today[owner] ?? 0) >= limits.perDay) {
      return {
        blocked: `Tageslimit für Vernetzungsanfragen erreicht (${limits.perDay}${both}) – weitere sind bis morgen gesperrt, damit der LinkedIn-Account nicht eingeschränkt wird. Ändern unter Einstellungen → Senden über LinkedIn.`,
      };
    }
    return {
      blocked: `Limit für Vernetzungsanfragen in 7 Tagen erreicht (${limits.perWeek}${both}) – weitere sind gesperrt, bis ältere Anfragen aus dem Zeitraum fallen. Ändern unter Einstellungen → Senden über LinkedIn.`,
    };
  };

  /**
   * Stand der Vernetzungsanfragen für die Oberfläche (25.10., Kundengespräch „27 von 20“): je Account gezählt wie die
   * Sperre, dazu je Gründer, über welchen Account seine nächste Anfrage geht – auch unter „Alle“, wo Leads beider
   * Gründer im Stapel liegen. Vorher zeigte die Karte Anfragen je Lead-Besitzer gegen das Limit je Account.
   */
  const inviteInfo = (
    now: number,
    available: Record<AuthFounderId, boolean>,
  ): Pick<TasksResponse, 'invitesByAccount' | 'inviteViaByOwner' | 'invitesPerDayByAccount'> => {
    const counts = inviteCounts(now);
    const limits = inviteLimits();
    return {
      invitesByAccount: counts.today,
      inviteViaByOwner: Object.fromEntries(
        AUTH_FOUNDER_IDS.map((id) => [id, available[id] ? inviteAccountFor(id, counts, limits, (account) => available[account]) : null]),
      ),
      invitesPerDayByAccount: Object.fromEntries(AUTH_FOUNDER_IDS.map((id) => [id, limits.perDayFor?.[id] ?? limits.perDay])),
    };
  };

  const detail = (id: string): LeadDetailResponse | null => {
    const lead = store.get(id);
    return lead ? { lead, events: store.events(id) } : null;
  };

  app.get('/api/leads', async (request, reply): Promise<LeadListResponse | FastifyReply> => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const { owner, stage, q, limit, offset, sort, columns, category } = parsed.data;
    return store.list({ owner, stages: stage, query: q, limit, offset, sort, withBoardColumns: columns, categories: category });
  });

  const OPEN_STAGES = ['new', 'invited', 'connected', 'contacted', 'replied', 'meeting'] as const;

  /**
   * Stapel eines Gründers mit verbundenem Account. „Meine“ (Wunsch des Nutzers 24.10.): nur seine Leads und nur so
   * viele neue, wie sein Account schafft („Neue Leads pro Tag“, abzüglich heute angeschriebener eigener Leads – egal,
   * ob in „Meine“ oder „Alle“). Sind sie erledigt, ist „Meine“ leer; weiter geht es unter „Alle“. Nur dort (`adoptPaused`)
   * füllen neue Leads eines Gründers ohne verbundenen Account (17.10.) die freien Plätze (`adoptedFrom`).
   */
  const founderStack = (owner: AuthFounderId, available: Record<AuthFounderId, boolean>, now: number, adoptPaused = false): TasksResponse => {
    const open = store.list({ owner, stages: [...OPEN_STAGES], limit: 100_000 }).leads;
    const today = localDayStart(now, config.linkedin.workHours.timeZone);
    const counts = inviteCounts(now);
    // Nie mehr neue Leads, als der eigene Account heute vernetzen darf (25.10.): Bei „Neue Leads pro Tag“ über dem
    // Anfragen-Limit standen sonst Karten im Stapel, die nur noch „Tageslimit erreicht“ sagen konnten.
    const perAccount = Math.min(config.tasks.newLeadsPerDay, inviteLimits().perDayFor?.[owner] ?? config.linkedin.invitesPerDay);
    const rules = { ...config.tasks, newLeadsPerDay: perAccount, handover: config.close.handover };
    const sent = { [owner]: store.invitesSince(today)[owner] ?? 0 };
    const paused = AUTH_FOUNDER_IDS.filter((id) => id !== owner && !available[id]);
    const adopt = adoptPaused && paused.length ? store.list({ stages: ['new'], limit: 100_000 }).leads.filter((lead) => paused.includes(lead.owner)) : [];
    const tasks = computeTasks(open, owner, rules, now, sent, today, store.meetingsBookedAt(owner), adopt);
    const via = inviteAccountFor(owner, counts, inviteLimits(), (account) => available[account]);
    return {
      ...tasks,
      rules: { ...tasks.rules, invitesPerDay: config.linkedin.invitesPerDay, inviteAccounts: 1 },
      ...inviteInfo(now, available),
      inviteVia: via,
      ...(paused.length ? { accountPaused: paused } : {}),
    };
  };

  /** Leerer Stapel eines Gründers, dessen LinkedIn-Account nicht verbunden ist – alles wartet. */
  const pausedStack = (owner: AuthFounderId | null, paused: AuthFounderId[], now: number): TasksResponse => ({
    tasks: [],
    counts: { reply: 0, followup: 0, first: 0, lead: 0 },
    attention: [],
    owner,
    generatedAt: now,
    rules: { ...config.tasks, invitesPerDay: config.linkedin.invitesPerDay },
    invitesToday: owner ? { [owner]: 0 } : {},
    accountPaused: paused,
  });

  // Tagesstapel (Vertrag shared/tasks.ts): aus allen offenen Leads berechnet.
  app.get('/api/tasks', async (request, reply) => {
    // `owner=all` (16.10., Umschalter „Alle“ im Tagesstapel): Aufgaben beider Gründer. Ohne owner wie bisher der eigene.
    const parsed = z.object({ owner: z.union([founder, z.literal('all')]).optional() }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const now = Date.now();
    // „Heute“ nach Ortszeit (LINKEDIN_TIMEZONE, Standard Europe/Berlin), nicht UTC.
    const today = localDayStart(now, config.linkedin.workHours.timeZone);
    const available = await founderAccounts.available();
    const paused = AUTH_FOUNDER_IDS.filter((id) => !available[id]);
    if (parsed.data.owner === 'all') {
      for (const id of AUTH_FOUNDER_IDS) {
        const denial = assistantDenial(request.authUser, id, founderName);
        if (denial) return sendError(reply, 403, 'not_allowed', denial);
      }
      if (!paused.length) {
        const open = store.list({ stages: [...OPEN_STAGES], limit: 100_000 }).leads;
        const tasks = computeTasks(
          open,
          null,
          { ...config.tasks, newLeadsPerDay: Math.min(config.tasks.newLeadsPerDay, config.linkedin.invitesPerDay), handover: config.close.handover },
          now,
          store.invitesSince(today),
          today,
          store.meetingsBookedAt(null),
          [],
          config.linkedin.accountFallback,
        );
        return { ...tasks, rules: { ...tasks.rules, invitesPerDay: config.linkedin.invitesPerDay }, ...inviteInfo(now, available) };
      }
      // Ein Account nicht verbunden (17.10.): nur die Stapel der Gründer mit Account, samt übernommenen Leads.
      const stacks = AUTH_FOUNDER_IDS.filter((id) => available[id]).map((id) => founderStack(id, available, now, true));
      if (!stacks.length) return pausedStack(null, paused, now);
      const body: TasksResponse = {
        tasks: TASK_TYPES.flatMap((type) => stacks.flatMap((stack) => stack.tasks.filter((task) => task.type === type))),
        counts: Object.fromEntries(TASK_TYPES.map((type) => [type, stacks.reduce((sum, stack) => sum + stack.counts[type], 0)])) as TasksResponse['counts'],
        attention: stacks.flatMap((stack) => stack.attention),
        owner: null,
        generatedAt: now,
        rules: { ...config.tasks, invitesPerDay: config.linkedin.invitesPerDay },
        invitesToday: Object.assign({}, ...stacks.map((stack) => stack.invitesToday ?? {})),
        ...inviteInfo(now, available),
        accountPaused: paused,
      };
      return body;
    }
    // Admin-Konten haben keinen eigenen Tagesstapel → `owner` ist Pflicht (Vertrag „Rollen und Rechte“).
    if (!parsed.data.owner && request.authUser && !request.authUser.founder) {
      return sendError(reply, 400, 'invalid_request', 'Bitte wähle einen Gründer (owner) – Admin-Konten haben keinen eigenen Tagesstapel.');
    }
    const owner = parsed.data.owner ?? request.authUser?.founder ?? null;
    const denial = owner ? assistantDenial(request.authUser, owner, founderName) : null;
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
    if (!owner) {
      // Nur die offenen Leads dieses Gründers laden (ohne owner: alle).
      const open = store.list({ stages: [...OPEN_STAGES], limit: 100_000 }).leads;
      const tasks = computeTasks(open, owner, { ...config.tasks, handover: config.close.handover }, now, store.invitesSince(today), today, store.meetingsBookedAt(owner));
      return { ...tasks, rules: { ...tasks.rules, invitesPerDay: config.linkedin.invitesPerDay } };
    }
    if (!available[owner]) return pausedStack(owner, paused, now);
    return founderStack(owner, available, now);
  });

  // Dashboard (Vertrag shared/dashboard.ts): Zahlen aus dem Verlauf aller Leads.
  app.get('/api/dashboard', async (request, reply) => {
    const parsed = z
      .object({ days: z.coerce.number().int().min(7).max(DASHBOARD_DAYS_MAX).default(DASHBOARD_DAYS_DEFAULT) })
      .safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    return loadDashboard(db, {
      now: Date.now(),
      days: parsed.data.days,
      timeZone: config.linkedin.workHours.timeZone,
      maxFollowUps: config.tasks.maxFollowUps,
      usdToEur: config.anthropic.usdToEur,
      liveOnly: config.mode === 'live',
    });
  });

  // Chats (Vertrag shared/leads.ts → ConversationSummary).
  app.get('/api/conversations', async (request, reply): Promise<ConversationListResponse | FastifyReply> => {
    const parsed = z.object({ owner: founder.optional() }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    return { conversations: store.conversations(parsed.data.owner) };
  });

  // Was der Scraper aus Rückmeldungen gelernt hat (Vertrag shared/learning.ts). Trägt vorher neue Ergebnisse nach.
  app.get('/api/learning', async (): Promise<LearningSummary> => {
    const now = Date.now();
    store.syncLearning(now);
    return store.learning.summary(now);
  });

  // Eigene Spalten im Board (Vertrag shared/leads.ts → BoardColumn).
  const boardResponse = (): BoardColumnsResponse => ({ columns: store.boardColumns(), layout: store.boardLayout() });
  app.get('/api/board/columns', async (): Promise<BoardColumnsResponse> => boardResponse());
  // Reihenfolge und Stufen-Namen (22.10.) – vor /:id registriert; gleiche Rechte wie eigene Spalten (roles.ts).
  app.put('/api/board/columns/order', async (request, reply) => {
    const parsed = OrderSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', 'Ungültige Reihenfolge.');
    try {
      store.setBoardOrder(parsed.data.order);
      return boardResponse();
    } catch (error) {
      if (error instanceof InvalidBoardOrderError) return sendError(reply, 400, 'invalid_request', error.message);
      throw error;
    }
  });
  app.patch('/api/board/columns/stage/:stage', async (request, reply) => {
    const params = StageParams.safeParse(request.params);
    const parsed = StageNameSchema.safeParse(request.body ?? {});
    if (!params.success) return sendError(reply, 404, 'not_found', 'Stufe nicht gefunden.');
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join(' '));
    store.renameBoardStage(params.data.stage, parsed.data.name);
    return boardResponse();
  });
  app.post('/api/board/columns', async (request, reply) => {
    const parsed = ColumnSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join(' '));
    try {
      return reply.status(201).send(store.addBoardColumn(parsed.data.name));
    } catch (error) {
      if (error instanceof DuplicateBoardColumnError) return sendError(reply, 400, 'invalid_request', error.message);
      throw error;
    }
  });
  app.patch('/api/board/columns/:id', async (request, reply) => {
    const params = ColumnParams.safeParse(request.params);
    const parsed = ColumnSchema.safeParse(request.body ?? {});
    if (!params.success) return sendError(reply, 404, 'not_found', 'Spalte nicht gefunden.');
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join(' '));
    try {
      return store.renameBoardColumn(params.data.id, parsed.data.name) ?? sendError(reply, 404, 'not_found', 'Spalte nicht gefunden.');
    } catch (error) {
      if (error instanceof DuplicateBoardColumnError) return sendError(reply, 400, 'invalid_request', error.message);
      throw error;
    }
  });
  app.delete('/api/board/columns/:id', async (request, reply): Promise<BoardColumnsResponse | FastifyReply> => {
    const params = ColumnParams.safeParse(request.params);
    if (!params.success || !store.deleteBoardColumn(params.data.id)) return sendError(reply, 404, 'not_found', 'Spalte nicht gefunden.');
    return boardResponse();
  });

  // Vor /:id registriert, damit „demo“ nicht als ID gilt.
  app.post('/api/leads/demo/reset', async (_request, reply) => {
    if (config.mode !== 'mock') return sendError(reply, 404, 'not_found', 'Nur in der Simulation verfügbar.');
    // Echte Leads (aus Live-Läufen oder der Tracking-Liste) werden nie gelöscht.
    if (store.hasRealLeads()) {
      return sendError(reply, 409, 'live_leads_exist', 'Es gibt echte Leads aus Live-Läufen – die Demo-Daten werden nicht zurückgesetzt, damit nichts davon verloren geht.');
    }
    const count = store.resetDemo();
    onDemoReset?.();
    return { count };
  });

  app.get('/api/leads/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const body = params.success ? detail(params.data.id) : null;
    return body ?? sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
  });

  // Betroffenenrechte (Vertrag shared/leads.ts): nur Gründer und Admins – Mitarbeiter sperrt schon `roleDenial`.
  app.get('/api/leads/:id/export', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const data = params.success ? store.exportData(params.data.id) : null;
    if (!data) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    request.log.info({ leadId: data.lead.id, username: request.authUser?.username }, 'Daten eines Leads exportiert (Auskunft)');
    const day = data.exportedAt.slice(0, 10);
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="lead-${data.lead.id}-${day}.json"`)
      .header('Cache-Control', 'no-store')
      .send(JSON.stringify(data, null, 2));
  });

  app.delete('/api/leads/:id', async (request, reply): Promise<DeleteLeadResponse | FastifyReply> => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    try {
      store.deleteLead(params.data.id);
    } catch (error) {
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      throw error;
    }
    // Nur die ID ins Protokoll – keine Namen (das Protokoll kennt kein Löschkonzept).
    request.log.warn({ leadId: params.data.id, username: request.authUser?.username }, 'Lead auf Wunsch endgültig gelöscht');
    return { deleted: true, message: 'Der Lead ist endgültig gelöscht. Die Lead-Suche schlägt diese Person nicht wieder vor.' };
  });

  app.post('/api/leads', async (request, reply): Promise<CreateLeadsResponse | FastifyReply> => {
    const parsed = CreateSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const owner = parsed.data.owner ?? request.authUser?.founder;
    if (!owner) return sendError(reply, 400, 'invalid_request', 'Bitte angeben, wem die Leads gehören (owner).');
    const denial = assistantDenial(request.authUser, owner, founderName);
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
    // `owner` = wer gesucht hat; mit LEAD_DISTRIBUTION=balanced können die neuen Leads auch dem anderen Gründer
    // gehören (`origin.searchedBy`). actor nur, wenn es nicht der Gründer selbst war.
    const result = store.createFromCards(parsed.data.cards, owner, Date.now(), actorFor(request.authUser, owner));
    // Clay (Vertrag shared/enrichment.ts): neue Leads mit Score Hoch/Mittel, wenn eingeschaltet.
    await enrichment.autoEnrich(result.created);
    return { ...result, created: result.created.map((lead) => store.get(lead.id) ?? lead) };
  });

  app.get('/api/enrichment/status', async () => enrichment.status());

  app.post('/api/leads/:id/enrich', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    try {
      await enrichment.request(params.data.id);
    } catch (error) {
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      if (error instanceof EnrichmentOffError) return sendError(reply, 409, 'enrichment_off', error.message);
      if (error instanceof EnrichmentLimitError) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
        return sendError(reply, 429, 'enrichment_limit', error.message);
      }
      throw error;
    }
    return reply.status(202).send(detail(params.data.id));
  });

  // Rückkanal für Clay – ohne Sitzung (AUTH_OPEN_ROUTES), geschützt durch CLAY_CALLBACK_SECRET.
  app.post('/api/enrichment/clay', async (request, reply) => {
    const secret = config.clay.callbackSecret;
    if (enrichment.mode !== 'live' || enrichment.provider !== 'clay' || !secret) return sendError(reply, 404, 'not_found', 'Nicht gefunden.');
    const retryAfter = callbackLimiter.retryAfter(request.ip);
    if (retryAfter > 0) {
      reply.header('Retry-After', String(retryAfter));
      return reply.status(429).send({ error: { code: 'too_many_attempts', message: 'Zu viele Fehlversuche.' } } satisfies ApiErrorBody);
    }
    const header = request.headers['x-cockpit-secret'];
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const given = (typeof header === 'string' ? header : bearer)?.trim();
    if (!given || !sameSecret(given, secret)) {
      callbackLimiter.failure(request.ip);
      request.log.warn({ ip: request.ip }, 'Clay-Rückkanal: falscher oder fehlender Schlüssel');
      return sendError(reply, 401, 'unauthorized', 'Schlüssel fehlt oder ist falsch.');
    }
    const parsed = ClayCallbackSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    try {
      const lead = enrichment.receive(parsed.data.leadId, parsed.data);
      request.log.info({ leadId: lead.id, status: lead.enrichment?.status }, 'Ergebnis von Clay gespeichert');
      return { ok: true, status: lead.enrichment?.status };
    } catch (error) {
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      throw error;
    }
  });

  app.post('/api/leads/:id/events', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const parsed = ActionSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    try {
      const lead = store.get(params.data.id);
      // Sperre (11.10.): Tages- und 7-Tage-Limit für Vernetzungsanfragen gilt auch beim Eintragen von Hand. Nur, wenn die
      // Anfrage wirklich neu ist (Stufe „Neu“) – eine Wiederholung derselben Buchung beantwortet `applyAction` als Duplikat.
      let account: AuthFounderId | null = null;
      let adoptBy: AuthFounderId | null = null;
      if (lead && parsed.data.action === 'invite_sent' && lead.stage === 'new') {
        const available = await founderAccounts.available();
        if (!available[lead.owner]) {
          // Account des Besitzers nicht verbunden (17.10.): Anfrage über einen verbundenen Gründer, der wird Besitzer –
          // Erstnachricht und Follow-ups laufen dann ebenfalls über ihn. Zuerst wer es gerade erledigt.
          const counts = inviteCounts(Date.now());
          const limits = inviteLimits();
          const me = request.authUser?.founder ?? null;
          const order = [...(me ? [me] : []), ...AUTH_FOUNDER_IDS.filter((id) => id !== me)];
          adoptBy = order.find((id) => id !== lead.owner && available[id] && accountHasRoom(id, counts, limits)) ?? null;
          if (!adoptBy) {
            const anyone = AUTH_FOUNDER_IDS.some((id) => id !== lead.owner && available[id]);
            return sendError(reply, 429, 'invite_limit', anyone ? 'Tageslimit für Vernetzungsanfragen erreicht – der Lead wartet, bis wieder ein verbundener LinkedIn-Account frei ist.' : ACCOUNT_PAUSED_MESSAGE);
          }
          store.update(lead.id, { owner: adoptBy }, adoptBy, Date.now(), actorFor(request.authUser, adoptBy));
        } else {
          const choice = inviteAccount(lead.owner, Date.now(), (id) => available[id]);
          if ('blocked' in choice) return sendError(reply, 429, 'invite_limit', choice.blocked);
          account = choice.account;
        }
      }
      // Gebucht für den zuständigen Gründer – auch wenn der andere Gründer es für ihn erledigt (Umschalter „Alle“ im
      // Tagesstapel, Wunsch des Nutzers 16.10.). `actor` = wer es wirklich war, wenn nicht der Gründer selbst
      // (z. B. „Anna“ für Nick, „Nick“ für Johannes).
      const by = adoptBy ?? lead?.owner ?? request.authUser?.founder ?? null;
      // Über den Account des anderen Gründers: vor der Buchung merken – Erstnachricht und Follow-ups laufen dann ebenso,
      // und der Verlauf nennt den Account (ohne „über LinkedIn“ – eingetragen ist nicht gesendet).
      if (lead && account && account !== (lead.linkedin?.sentBy ?? lead.owner)) store.setLinkedInAccount(lead.id, account);
      store.applyAction(params.data.id, parsed.data, by, Date.now(), undefined, actorFor(request.authUser, by));
    } catch (error) {
      if (error instanceof DuplicateEventError) return { ...detail(params.data.id)!, duplicate: true };
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      if (error instanceof InvalidTransitionError) return sendError(reply, 409, 'invalid_transition', error.message);
      throw error;
    }
    return detail(params.data.id);
  });

  // Nur eingetragene Anfragen nachsenden (Vertrag shared/leads.ts, 11.10.).
  app.get('/api/leads/unsent-invites', async (request, reply) => {
    const parsed = z.object({ owner: founder.optional() }).safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const leads = store
      .unsentInvites(parsed.data.owner)
      .filter((lead) => !assistantDenial(request.authUser, lead.owner, founderName));
    const body: UnsentInvitesResponse = { leads };
    return body;
  });

  app.post('/api/leads/unsent-invites/requeue', async (request, reply) => {
    const parsed = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) }).safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const result: RequeueInvitesResponse = { requeued: [], skipped: [] };
    const now = Date.now();
    for (const id of [...new Set(parsed.data.ids)]) {
      const lead = store.get(id);
      if (!lead) {
        result.skipped.push({ id, reason: 'Lead nicht gefunden' });
        continue;
      }
      if (assistantDenial(request.authUser, lead.owner, founderName)) {
        result.skipped.push({ id, reason: 'Lead eines anderen Gründers' });
        continue;
      }
      const by = lead.owner;
      const done = store.requeueUnsentInvite(id, by, now, actorFor(request.authUser, by));
      if (done) result.requeued.push(id);
      else result.skipped.push({ id, reason: 'Nicht mehr in „Anfrage gesendet“ oder schon über das Cockpit gesendet' });
    }
    request.log.info({ requeued: result.requeued.length, skipped: result.skipped.length }, 'Nur eingetragene Anfragen zurück auf Neu');
    return result;
  });

  // „Für heute überspringen“: fehlt bis `until` (Standard: nächster Tag, UTC) im Tagesstapel.
  app.post('/api/leads/:id/snooze', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const parsed = SnoozeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const now = Date.now();
    const until = parsed.data.until ?? nextLocalMidnight(now, config.linkedin.workHours.timeZone);
    if (until <= now || until > now + SNOOZE_MAX_MS) {
      return sendError(reply, 400, 'invalid_request', 'Überspringen geht nur bis höchstens 30 Tage in die Zukunft.');
    }
    try {
      store.snooze(params.data.id, until, now);
    } catch (error) {
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      throw error;
    }
    return detail(params.data.id);
  });

  app.delete('/api/leads/:id/snooze', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    try {
      store.snooze(params.data.id, null);
    } catch (error) {
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      throw error;
    }
    return detail(params.data.id);
  });

  app.patch('/api/leads/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const parsed = UpdateSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    try {
      // Admin (ohne Gründer): gebucht für den bisher zuständigen Gründer, wie bei den Ereignissen.
      const lead = store.get(params.data.id);
      // Mitarbeiter übergeben nur an Gründer, für die sie arbeiten (den bisherigen prüft schon der preHandler).
      const newOwner = parsed.data.owner;
      const denial = newOwner ? assistantDenial(request.authUser, newOwner, founderName) : null;
      if (denial) return sendError(reply, 403, 'not_allowed', denial);
      // Wie bei den Ereignissen: für den bisher zuständigen Gründer, `actor` = wer es war.
      const by = lead?.owner ?? request.authUser?.founder ?? null;
      store.update(params.data.id, parsed.data, by, Date.now(), actorFor(request.authUser, by));
    } catch (error) {
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      if (error instanceof UnknownBoardColumnError || error instanceof InvalidFollowUpError) return sendError(reply, 400, 'invalid_request', error.message);
      throw error;
    }
    return detail(params.data.id);
  });

  return { leads: store, enrichment };
}
