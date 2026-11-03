import { SearchMemory } from './pipeline/searchMemory.js';
import { AiUsageStore, setAiUsageSink } from './ai/usage.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { registerMcpRoutes } from './mcp/routes.js';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_SEARCH_PROFILE,
  MAX_RESULTS_LIMIT,
  type ApiErrorBody,
  type LeadSearchConfig,
  type StartRunRequest,
  type ManualQualifyResponse,
} from '../../shared/leadSearch.js';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../shared/auth.js';
import { actorFor, assistantDenial } from './auth/roles.js';
import { registerAuth } from './auth/auth.js';
import { AutoSearchPlanner } from './autoSearch/planner.js';
import { registerAutoSearchRoutes } from './autoSearch/routes.js';
import { liveProblems, liveWarnings, replaceConfig, startProblem, type Config } from './config.js';
import { scheduleDailyBackup } from './db/backup.js';
import { openDatabase } from './db/database.js';
import { DbAccountUsage } from './linkedin/accountUsage.js';
import { FounderAccounts } from './linkedin/founderAccounts.js';
import { registerLeadRoutes } from './leads/routes.js';
import { registerLinkedInRoutes } from './linkedin/routes.js';
import { registerCrmRoutes } from './crm/routes.js';
import { CrmService } from './crm/service.js';
import { ConversationService } from './messages/conversation.js';
import { scheduleRetention } from './leads/retention.js';
import { NOTICES, NotificationCenter, registerNotificationRoutes } from './notify/notifications.js';
import { SlackNotifier } from './notify/slack.js';
import { registerMessageRoutes } from './messages/routes.js';
import { LinkedInService } from './linkedin/service.js';
import { WarmupService } from './linkedin/warmup.js';
import { AccountPrefsStore } from './linkedin/accountPrefs.js';
import type { LeadSearchAdapter } from './pipeline/adapter.js';
import { AdapterRef } from './pipeline/adapterRef.js';
import { SearchProfileSchema } from './pipeline/profileSchema.js';
import { PipelineRunner, RunBusyError } from './pipeline/runner.js';
import { RunStore } from './pipeline/runStore.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { MetaRecheckService } from './ads/metaRecheck.js';
import { registerMetaRecheckRoutes } from './ads/metaRecheckRoutes.js';
import { SettingsService, type SettingsDeps } from './settings/service.js';
import { BackupService } from './system/backups.js';
import { DiskMonitor, formatBytes } from './system/disk.js';
import { UnipileWatch } from './system/unipileWatch.js';
import { registerSystemRoutes } from './system/routes.js';
import { UpdateService } from './system/updates.js';
import { TrackingFileError, TrackingStore, parseTrackingWorkbook } from './tracking/tracking.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Größte Tracking-Liste (Excel) – nginx erlaubt unter /api ebenfalls 20 MB. */
const TRACKING_UPLOAD_LIMIT = 20 * 1024 * 1024;

/** Vertraute Proxys vor dem Backend: 0 oder 1 (nur nginx) – siehe Kommentar an `Fastify(…)`. */
export function trustedProxyHops(config: Pick<Config, 'auth'>): number {
  return Math.min(config.auth.trustProxyHops, 1);
}

const StartRunSchema = z.object({
  // Grenzen gemeinsam mit der automatischen Suche (`pipeline/profileSchema.ts`).
  profile: SearchProfileSchema,
  known: z.array(z.object({ providerId: z.string().min(1), owner: z.string().max(60) })).max(5000).default([]),
  pendingInvitations: z.array(z.string().min(1)).max(5000).default([]),
  checked: z.array(z.string().min(1)).max(5000).default([]),
  owner: z.enum(AUTH_FOUNDER_IDS).optional(),
});

const IdParams = z.object({ id: z.string().uuid() });

export interface AppOptions {
  /**
   * Die `.env` (Umgebung), aus der `config` gelesen wurde – Grundlage für „Quelle .env/Standard“ und das Zurücksetzen
   * in den Einstellungen (`shared/settings.ts`). Ohne Angabe: leer.
   */
  env?: NodeJS.ProcessEnv;
  /** Baut den Adapter neu, wenn Einstellungen ihn betreffen (Modus, Zugänge). Ohne Angabe bleibt `adapter`. */
  createAdapter?: (config: Config) => LeadSearchAdapter | Promise<LeadSearchAdapter>;
  /** Nur Tests: fetch und Adressen für den Verbindungstest der Einstellungen. */
  settingsTest?: Pick<SettingsDeps, 'fetch' | 'anthropicBaseUrl' | 'metaBaseUrl'>;
  /** Nur Tests: Adresse des nachgebauten Anthropic-Servers für KI-Vorschläge. */
  messagesTest?: { anthropicBaseURL: string };
  /** Nur Tests: Untergrenze der LinkedIn-Pause (ms) – live sonst immer mindestens 3 s. */
  linkedinTest?: { minPauseMs: number };
  /** Nur Tests: fetch für die Slack-Nachricht (die Adresse muss auf hooks.slack.com zeigen). */
  slackTest?: { fetch: typeof fetch };
  /** Nur Tests: Uhr des Planers der automatischen Lead-Suche (der Planer hängt als `app.autoSearch` an der App). */
  autoSearchNow?: () => number;
  /** Hintergrund-Aufgaben planen: tägliche Sicherung, LinkedIn-Abgleich, automatische Lead-Suche (nur im echten Start, nicht in Tests). */
  scheduleBackups?: boolean;
  /** Backend nach dem Wiederherstellen einer Sicherung neu starten (nur im echten Start; Docker startet es wieder). */
  restartProcess?: () => void;
  config: Config;
  adapter: LeadSearchAdapter;
  logger?: boolean | object;
  /** Ohne gültige Sitzung → 401 für alle `/api/*` außer `AUTH_OPEN_ROUTES` (Vertrag `shared/auth.ts`). */
  requireSession?: boolean;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, runId?: string) {
  const body: ApiErrorBody = { error: { code, message, ...(runId ? { runId } : {}) } };
  return reply.status(status).send(body);
}

/** Unerwartete Fehler (5xx): Details nur ins Protokoll, nie in die Antwort (Dateipfade, SQL, Meldungen der Dienste). */
const INTERNAL_MESSAGE = 'Im Server ist etwas schiefgegangen. Bitte versuch es noch einmal – bleibt der Fehler, sag Bescheid.';

/**
 * Anfragen im Protokoll ohne Query: `?q=` enthält z. B. gesuchte Namen von Leads (personenbezogen, das Protokoll
 * kennt kein Löschkonzept). Sonst dieselben Felder wie Fastifys Standard.
 */
function logRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url.split('?')[0],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

function loggerOptions(logger: boolean | object): boolean | object {
  if (logger === false) return false;
  const base = logger === true ? {} : (logger as { serializers?: object });
  return { ...base, serializers: { req: logRequest, ...base.serializers } };
}

export function buildApp({
  config,
  adapter: initialAdapter,
  logger = true,
  requireSession = true,
  scheduleBackups = false,
  env = {},
  createAdapter,
  settingsTest,
  messagesTest,
  slackTest,
  linkedinTest,
  autoSearchNow,
  restartProcess,
}: AppOptions): FastifyInstance {
  // Client-IP aus X-Forwarded-For: vertraut wird höchstens EIN Proxy – nginx. nginx prüft selbst, ob die Anfrage von
  // Caddy kam (realip, nginx.conf), und gibt genau eine Adresse weiter. TRUST_PROXY_HOPS=2 aus älteren .env-Dateien
  // wirkt deshalb wie 1 (sonst ließe sich die Adresse vorne in der Kette vortäuschen); 0 = keinem Proxy vertrauen.
  // Als Funktion, weil die Typen die Zahl nicht kennen; Wert bei jeder Anfrage gelesen (Einstellung ohne Neustart).
  const app = Fastify({ logger: loggerOptions(logger), trustProxy: (_address: string, hop: number) => hop < trustedProxyHops(config) });
  // 4xx von Fastify (kaputtes JSON, zu große Datei …) bleiben wie bisher; alles andere → allgemeine Meldung.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (typeof error.statusCode === 'number' && error.statusCode < 500) return reply.send(error);
    request.log.error({ err: error }, 'Unerwarteter Fehler');
    return sendError(reply, 500, 'internal', INTERNAL_MESSAGE);
  });
  // Antworten der API enthalten personenbezogene Daten: nie im Browser-Cache ablegen (eigene Angaben der Route gelten).
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  const db = openDatabase(config.dataDir);
  // Neuigkeiten vom Programm (Vertrag shared/notifications.ts) – Slack hängt sich weiter unten an.
  let slack: SlackNotifier | null = null;
  const notifications = new NotificationCenter({ db, log: app.log, slack: (notification) => slack?.system(notification) });
  // Speicherplatz im Datenordner: stündlich und vor jeder Sicherung (Meldung, solange es knapp ist).
  const disk = new DiskMonitor({
    dir: () => config.dataDir,
    log: app.log,
    onLow: (info) => notifications.raise(NOTICES.diskLow(formatBytes(info.freeBytes), Math.floor((info.freeBytes / info.totalBytes) * 100))),
    onOk: () => notifications.resolve('disk:low'),
  });
  if (scheduleBackups) app.addHook('onReady', async () => disk.startTimer());
  app.addHook('onClose', async () => disk.close());
  // Sicherungen (Vertrag shared/system.ts): geplant, von Hand, vor dem Wiederherstellen, vor einem Update.
  const backups = new BackupService({ db, config, beforeBackup: () => disk.check(), disk: () => disk.read() });
  let stopBackups: (() => void) | null = null;
  const planBackups = () => {
    stopBackups?.();
    stopBackups = null;
    if (!scheduleBackups || config.backup.hourUtc === null) return;
    stopBackups = scheduleDailyBackup(
      () => {
        app.log.info({ file: backups.create('scheduled').name }, 'Datenbank gesichert');
        notifications.resolve('backup:scheduled');
      },
      config.backup.hourUtc,
      (error) => {
        app.log.error({ err: error }, 'Sicherung der Datenbank fehlgeschlagen');
        notifications.raise(NOTICES.backupFailed(error instanceof Error && error.message ? error.message : 'unbekannter Fehler'));
      },
    );
  };
  planBackups();
  app.addHook('onClose', async () => stopBackups?.());
  app.addHook('onClose', () => db.close());
  // Feste Unipile-Limits je LinkedIn-Account (17.10.): ein Zähler für alle Läufe, auch nach neu gebautem Adapter.
  const accountUsage = new DbAccountUsage(db, () => config.linkedin.workHours.timeZone);
  initialAdapter.useAccountUsage?.(accountUsage);
  // Einstellungen je LinkedIn-Account (21.10.): Such-Reihenfolge und eigene Tagesgrenzen.
  const accountPrefs = new AccountPrefsStore(db);
  initialAdapter.useAccountPrefs?.(accountPrefs);
  const adapterRef = new AdapterRef(initialAdapter);
  const adapter = adapterRef;
  const auth = registerAuth(app, {
    config,
    db,
    requireSession,
    onRegistered: ({ username, name }) => notifications.raise(NOTICES.registration(username, name)),
    // Sicherheitsprüfung 08.10.: Jede Änderung an Konten erfahren alle Gründer (Glocke + Slack).
    onAccountChange: (change) => notifications.raise(NOTICES.accountChange(change, founderName)),
  });
  // Namen der Gründer aus ihren Konten (Wunsch des Nutzers 08.10.) – für alle Meldungen und Texte des Servers.
  const founderName = (id: AuthFounderId) => auth.accounts.founderName(id);
  // Entschiedene Registrierungen verschwinden aus den Neuigkeiten, wartende (auch von vor dem Update) erscheinen.
  const syncRegistrations = () => {
    const open = auth.accounts.listRegistrations();
    for (const registration of open) notifications.raise(NOTICES.registration(registration.username, registration.name));
    notifications.resolveExcept('registration:', open.map((registration) => `registration:${registration.username}`));
  };
  app.addHook('onReady', async () => {
    // Simulation: Beispiel-Meldungen, damit die Glocke beim Entwickeln etwas zeigt (wie die Demo-Leads).
    if (config.mode === 'mock' && notifications.isEmpty()) notifications.resetDemo();
    syncRegistrations();
  });
  registerNotificationRoutes(app, { center: notifications, sync: syncRegistrations });
  // Suchgedächtnis der Lead-Suche (Migration 28): Cursor und Ertrag je Suchanfrage, geprüfte Profile aller Läufe.
  const searchMemory = new SearchMemory(db);
  // KI-Kosten (Migration 29): jeder Aufruf der Claude-API landet hier; die Simulation zeigt erfundene Werte.
  const aiUsage = new AiUsageStore(db);
  setAiUsageSink((purpose, model, usage, runId) => aiUsage.record(purpose, model, usage, Date.now(), runId));
  if (config.mode === 'mock' && aiUsage.isEmpty()) aiUsage.seedDemo(Date.now());
  // Demo-Reset leert auch die automatische Suche (Pläne, Zustand, geprüfte Profile) – der Planer entsteht weiter unten.
  // Welche Gründer-Accounts verbunden sind (18.10.) – eine Liste für Tagesstapel und Senden.
  const founderAccounts = new FounderAccounts({ config });
  const { leads, enrichment } = registerLeadRoutes(app, {
    config,
    db,
    founderAccounts,
    accountPrefs,
    founderName,
    onDemoReset: () => {
      autoSearch.reset();
      searchMemory.reset();
      aiUsage.reset();
      if (config.mode === 'mock') aiUsage.seedDemo(Date.now());
      notifications.resetDemo();
    },
  });
  // Echte LinkedIn-Aktionen (Phase 3, Vertrag shared/linkedin.ts).
  const linkedin = new LinkedInService({
    config,
    db,
    leads,
    log: app.log,
    minPauseMs: linkedinTest?.minPauseMs,
    founderName,
    accountPrefs,
    onPause: (founder, until, reason) => notifications.raise(NOTICES.linkedinPaused(founder, founderName(founder), until, reason)),
    onResume: (founder) => notifications.resolve(`linkedin:pause:${founder}`),
  });
  // Accounts aufwärmen (21.10.): Scraping-Accounts vernetzen sich nebenbei mit der Branche.
  const warmup = new WarmupService({ config, db, log: app.log, usage: accountUsage, prefs: accountPrefs, minPauseMs: linkedinTest?.minPauseMs });
  registerLinkedInRoutes(app, { leads, linkedin, founderAccounts, warmup, accountPrefs });
  if (scheduleBackups) warmup.start();
  app.addHook('onClose', async () => warmup.close());
  if (scheduleBackups) linkedin.startBackgroundSync();
  app.addHook('onClose', async () => linkedin.close());
  // Vorlagen und Vorschläge (Phase 4, Vertrag shared/messages.ts) – gesendet wird von Hand.
  registerMessageRoutes(app, { config, db, leads, anthropicBaseURL: messagesTest?.anthropicBaseURL });
  // Gespräch am Lead: Einschätzung der Antwort + Zusammenfassung bei jeder neuen Antwort (Phase 4).
  const conversation = new ConversationService({ config, leads, log: app.log, anthropicBaseURL: messagesTest?.anthropicBaseURL });
  app.addHook('onReady', async () => {
    const count = conversation.backfill();
    if (count) app.log.info({ count }, 'Gesprächs-Einschätzung für ältere Leads nachgetragen');
  });
  app.addHook('onClose', async () => conversation.close());
  // KI-Assistent (Vertrag shared/assistant.ts): Chat mit Lesezugriff auf alle Outreach-Daten.
  registerAssistantRoutes(app, { config, db, leads, anthropicBaseURL: messagesTest?.anthropicBaseURL });
  // MCP-Server für die Claude-App (Vertrag shared/mcp.ts): lesen und bedienen, mit OAuth.
  registerMcpRoutes(app, { config, db, leads, accounts: auth.accounts });
  // Übergabe heißer Leads an Close (Vertrag shared/crm.ts).
  registerCrmRoutes(app, { leads, crm: new CrmService({ config, leads, log: app.log, founderName }) });
  // Slack bei neuer Antwort und bei Neuigkeiten (nur live, mit SLACK_WEBHOOK_URL).
  const slackNotifier = new SlackNotifier({ config, leads, log: app.log, fetch: slackTest?.fetch, founderName });
  slack = slackNotifier;
  app.addHook('onClose', async () => slackNotifier.close());
  // Datenschutz: „Verloren“ nach LOST_DELETE_DAYS löschen – nur im echten Betrieb.
  if (scheduleBackups) {
    let stopRetention: (() => void) | null = null;
    app.addHook('onReady', async () => {
      stopRetention = scheduleRetention(config, leads, app.log);
    });
    app.addHook('onClose', async () => stopRetention?.());
  }
  const store = new RunStore();
  const tracking = new TrackingStore(db, config.dataDir);
  app.addHook('onReady', () => tracking.load());
  const runner = new PipelineRunner(adapter, store, {
    minConfidence: () => config.minConfidence,
    searchHits: () => config.searchHits,
    log: app.log,
    tracking,
    leads,
    founderName,
    // Tageslimit der automatischen Suche: jeder Profilabruf zählt (auch von Hand). Der Planer entsteht weiter unten.
    onProfileFetch: () => autoSearch.countProfileFetch(),
    memory: searchMemory,
    autoQualifyTerms: () => config.autoQualifyTerms,
    runCostEur: (runId) => aiUsage.runCostUsd(runId) * config.anthropic.usdToEur,
    // Lernen aus Lead-Qualität (13.10., shared/learning.ts): vor jedem Lauf neue Ergebnisse übernehmen, dann Beispiele.
    learning: {
      examples: () => {
        leads.syncLearning();
        return leads.learning.examplesText();
      },
      markQualified: (providerId, snapshot) => void leads.learning.markQualified(providerId, snapshot, Date.now()),
    },
  });

  /** Qualifizierte Leads eines beendeten Laufs anlegen (Dubletten überspringt `createFromCards`) und am Lauf vermerken. */
  const saveRunLeads = (runId: string, owner: AuthFounderId, actor: string | null): void => {
    const run = store.get(runId)?.snapshot;
    if (!run) return;
    try {
      const cards = runner.handoff(runId) ?? [];
      const result = leads.createFromCards(cards, owner, Date.now(), actor);
      run.saved = {
        created: result.created.map((lead) => ({ leadId: lead.id, owner: lead.owner })),
        skipped: result.skipped.map((entry) => ({ leadId: entry.leadId, owner: entry.owner })),
        at: Date.now(),
      };
      app.log.info({ runId, created: result.created.length, skipped: result.skipped.length }, 'Lead-Suche: Leads gespeichert');
      void enrichment.autoEnrich(result.created).catch((error: unknown) => app.log.warn({ runId, err: String(error) }, 'Firmendaten nicht geholt'));
    } catch (error) {
      app.log.error({ runId, err: error instanceof Error ? error.stack : String(error) }, 'Lead-Suche: Leads nicht gespeichert');
    }
  };

  // Meta-Ads für alle Leads nachprüfen (Vertrag shared/metaRecheck.ts) – über den aktuellen Adapter.
  const metaRecheck = new MetaRecheckService({ leads, adapter, log: app.log, pauseMs: config.mode === 'live' ? 1_500 : 0 });
  registerMetaRecheckRoutes(app, { service: metaRecheck });
  app.decorate('metaRecheck', metaRecheck);
  app.addHook('onClose', async () => metaRecheck.close());

  // Einstellungen in der Software (Vertrag shared/settings.ts): wirken ohne Neustart.
  const settings = new SettingsService({
    config,
    baseEnv: env,
    db,
    accounts: auth.accounts,
    sessions: auth.sessions,
    runActive: () => store.active() !== undefined,
    log: app.log,
    ...settingsTest,
    apply: async (next) => {
      const metaToken = config.meta.accessToken;
      replaceConfig(config, next);
      if (createAdapter) {
        const next = await createAdapter(config);
        next.useAccountUsage?.(accountUsage);
        next.useAccountPrefs?.(accountPrefs);
        adapterRef.set(next);
      }
      // Neuer Meta-Token (Wunsch des Nutzers 15.10.): alle Leads, die bisher ohne Meta-Check gesucht wurden, nachprüfen.
      // Nur im echten Betrieb – in der Simulation startet sie von Hand (Tests setzen Tokens nur zum Ausprobieren).
      if (config.mode === 'live' && config.meta.accessToken && config.meta.accessToken !== metaToken && adapterRef.canCheckAds) {
        try {
          metaRecheck.start();
        } catch (error) {
          app.log.info({ err: error instanceof Error ? error.message : String(error) }, 'Meta-Nachprüfung nicht gestartet');
        }
      }
      planBackups();
      // LinkedIn liest Grenzen, Arbeitszeit und Accounts bei jeder Aktion neu; nur der Abgleich-Zeitgeber plant neu.
      linkedin.replanSync();
    },
  });
  registerSettingsRoutes(app, { service: settings, config });

  // Sicherungen und Updates in der Oberfläche (Vertrag shared/system.ts).
  const updates = new UpdateService({
    mode: () => config.mode,
    env,
    // UPDATE_AUTO/UPDATE_HOUR aus der laufenden Konfiguration (Einstellungen wirken ohne Neustart).
    settings: () => ({ enabled: config.update.auto, hour: config.update.hour }),
    runActive: () => store.active() !== undefined,
    log: app.log,
    onAutoResult: (result, reason) => {
      if (result === 'failed') notifications.raise(NOTICES.updateFailed(reason ?? 'Der Update-Dienst hat nicht geantwortet.'));
      else notifications.resolve('update:auto');
    },
    // Scheitert das nächtliche Update erst nach dem Start (Bauen/Neustarten), steht es nur im Protokoll des Dienstes.
    onRunFinished: (run, auto) => {
      if (run.ok) notifications.resolve('update:auto');
      else if (auto) notifications.raise({ ...NOTICES.updateFailed(`Das nächtliche Update ist beim Einspielen gescheitert: ${run.message}`), repeat: false });
    },
    // Vor jedem echten Update die Datenbank sichern (`vor-update-…`, es bleiben die letzten 3).
    backupBeforeUpdate: () => backups.create('before_update').name,
  });
  registerSystemRoutes(app, {
    config,
    backups,
    updates,
    accounts: auth.accounts,
    limiter: settings.limiter,
    runActive: () => store.active() !== undefined,
    restart: restartProcess,
    notify: (notice) => notifications.raise(notice),
    log: app.log,
  });
  // Nach dem Wiederherstellen steht „Sicherung wiederhergestellt“ schon in der Datenbank – jetzt Slack nachholen.
  app.addHook('onReady', async () => {
    notifications.sendPendingSlack('restore:');
  });
  if (scheduleBackups) app.addHook('onReady', async () => updates.startTimer());
  app.addHook('onClose', async () => updates.close());

  const unipileWatchEnabled = () => config.mode === 'live' && liveProblems(config).length === 0;
  // Automatische Lead-Suche (Vertrag shared/autoSearch.ts): Zeitplan je Gründer, Planer prüft alle 20 s.
  const autoSearch = new AutoSearchPlanner({
    config,
    db,
    runner,
    runs: store,
    leads,
    enrichment,
    startProblem: () => startProblem(config),
    // Unipile laut regelmäßiger Prüfung down → geplante Läufe still überspringen (die Unipile-Meldung steht schon da).
    unipileDown: () => unipileWatchEnabled() && notifications.isActive('unipile:down'),
    log: app.log,
    now: autoSearchNow,
    runCostEur: (runId) => aiUsage.runCostUsd(runId) * config.anthropic.usdToEur,
    onFinished: (founder, result, alert) => {
      if (result.status === 'failed' || alert) {
        notifications.raise(
          NOTICES.autoSearchFailed(founder, founderName(founder), result.message ?? 'Der Lauf ist ohne Ergebnis abgebrochen.', result.status === 'skipped'),
        );
      } else if (result.status === 'done') {
        notifications.resolve(`search:auto:${founder}`);
      }
    },
  });
  app.decorate('autoSearch', autoSearch);

  // Regelmäßige Unipile-Prüfung (nur live, Adresse + Token gesetzt): meldet einmal, wenn Unipile keinen startklaren
  // LinkedIn-Account liefert (z. B. Testzeitraum/Abo abgelaufen) – auch wenn Suche und LinkedIn-Aktionen aus sind.
  const unipileWatch = new UnipileWatch({
    enabled: unipileWatchEnabled,
    status: (signal) => adapterRef.current().accountStatus?.(signal, { refresh: true }) ?? null,
    onDown: (status) => notifications.raise(NOTICES.unipileDown(status.message || 'Unipile liefert keinen startklaren LinkedIn-Account.')),
    onOk: () => notifications.resolve('unipile:down'),
    log: app.log,
  });
  app.decorate('unipileWatch', unipileWatch);
  if (scheduleBackups) app.addHook('onReady', async () => unipileWatch.startTimer());
  app.addHook('onClose', async () => unipileWatch.close());
  registerAutoSearchRoutes(app, { planner: autoSearch });
  if (scheduleBackups) app.addHook('onReady', async () => autoSearch.startTimer());
  // Beim Beenden: Zeitgeber stoppen, Warteschlange leeren, nichts mehr in die Datenbank schreiben.
  app.addHook('onClose', async () => autoSearch.close());
  app.addHook('onClose', async () => settings.close());

  // Excel-Upload der Tracking-Liste kommt als rohe Bytes. Grenze wie überall 1 MB – nur die Upload-Route erlaubt
  // 20 MB (`bodyLimit` an der Route), damit nicht jede Route große Bodys in den Speicher liest.
  app.addContentTypeParser(['application/octet-stream', XLSX_MIME], { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  // Ohne Sitzung (AUTH_OPEN_ROUTES): eine winzige Abfrage zeigt, ob die Datenbank antwortet – sonst 503 ohne Details.
  app.get('/api/health', async (_request, reply) => {
    try {
      db.prepare('SELECT 1').get();
    } catch {
      return reply.status(503).send({ ok: false });
    }
    return { ok: true, mode: config.mode };
  });

  app.get('/api/lead-search/config', async (request): Promise<LeadSearchConfig> => {
    // Live: zusätzlich prüfen, ob bei Unipile ein LinkedIn-Account bereitsteht (nur Account-Liste, keine LinkedIn-Aktion).
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh === '1';
    const problems = config.mode === 'live' ? liveProblems(config) : [];
    const warnings = liveWarnings(config);
    const current = adapterRef.current();
    const account =
      config.mode === 'live' && problems.length === 0 && current.accountStatus
        ? await current.accountStatus(AbortSignal.timeout(15_000), { refresh })
        : null;
    // Hinweise aus der Account-Liste (mehrere LinkedIn-Accounts, Sales Navigator) und der letzten Kontaktprüfung.
    if (config.mode === 'live') warnings.push(...(current.setupWarnings?.() ?? []));
    return {
      mode: config.mode,
      ready: problems.length === 0 && (!account || account.state === 'ok'),
      problems,
      defaults: { ...DEFAULT_SEARCH_PROFILE, maxResults: config.maxResults },
      maxResultsLimit: MAX_RESULTS_LIMIT,
      searchHits: config.searchHits,
      // Nur live: die Simulation nutzt kein Suchgedächtnis (Vertrag: stabiler Trichter).
      backlog: config.mode === 'live' ? searchMemory.backlogSize(Date.now()) : 0,
      live: config.mode === 'live' ? { searchApi: config.unipile.searchApi, model: config.anthropic.model } : null,
      metaAds: current.canCheckAds,
      account,
      warnings,
      tracking: tracking.summary(),
    };
  });

  // Outreach-Tracking-Liste (Excel) für den Dubletten-Filter – es wird nur der Profil-Index gespeichert.
  app.get('/api/lead-search/tracking', async () => ({ tracking: tracking.summary() }));

  app.put('/api/lead-search/tracking', { bodyLimit: TRACKING_UPLOAD_LIMIT }, async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return sendError(reply, 400, 'invalid_file', 'Keine Datei empfangen.');
    const header = request.headers['x-file-name'];
    let fileName = 'Tracking.xlsx';
    try {
      if (typeof header === 'string' && header) fileName = decodeURIComponent(header).slice(0, 200);
    } catch {
      // Unlesbarer Dateiname – Standardnamen behalten.
    }
    try {
      const index = await parseTrackingWorkbook(body, fileName);
      await tracking.replace(index);
      request.log.info({ count: index.summary.count, sheets: index.summary.sheets }, 'Tracking-Liste geladen');
      return { tracking: index.summary };
    } catch (error) {
      if (error instanceof TrackingFileError) return sendError(reply, 400, 'invalid_file', error.message);
      throw error;
    }
  });

  app.delete('/api/lead-search/tracking', async () => {
    await tracking.clear();
    return { tracking: null };
  });

  app.post('/api/lead-search/runs', async (request, reply) => {
    const problem = startProblem(config);
    if (problem) return sendError(reply, 400, 'config', problem);
    const parsed = StartRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join(' '));
    }
    // Für wen gesucht wird: Angabe der Oberfläche (Admin, Mitarbeiter mehrerer Gründer), sonst der eigene Gründer.
    const owner = parsed.data.owner ?? request.authUser?.founder ?? null;
    const denial = owner ? assistantDenial(request.authUser, owner, founderName) : null;
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
    try {
      // Leads gehen nicht mehr verloren (Kundengespräch 25.10.): Am Ende des Laufs legt der Server die qualifizierten
      // Leads selbst an – bisher erst nach „In den Tagesstapel“ plus 60 s Rückgängig-Fenster im Browser; wer vorher
      // neu lud oder die Seite schloss, verlor sie.
      const actor = owner ? actorFor(request.authUser, owner) : null;
      const run = runner.start(parsed.data satisfies StartRunRequest, {}, owner ? (finished) => saveRunLeads(finished.id, owner, actor) : undefined);
      return reply.status(202).send({ run });
    } catch (error) {
      if (error instanceof RunBusyError) return sendError(reply, 409, 'busy', error.message, error.runId);
      throw error;
    }
  });

  app.get('/api/lead-search/runs/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const record = params.success ? store.get(params.data.id) : undefined;
    if (!record) return sendError(reply, 404, 'not_found', 'Lauf nicht gefunden.');
    return { run: record.snapshot };
  });

  app.post('/api/lead-search/runs/:id/cancel', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const record = params.success ? store.get(params.data.id) : undefined;
    if (!record) return sendError(reply, 404, 'not_found', 'Lauf nicht gefunden.');
    runner.cancel(record.snapshot.id);
    return { run: record.snapshot };
  });

  app.post('/api/lead-search/runs/:id/handoff', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const record = params.success ? store.get(params.data.id) : undefined;
    if (!record) return sendError(reply, 404, 'not_found', 'Lauf nicht gefunden.');
    if (record.snapshot.status === 'running') {
      return sendError(reply, 409, 'running', 'Der Lauf ist noch nicht fertig.');
    }
    return { leads: runner.handoff(record.snapshot.id) ?? [], run: record.snapshot };
  });

  // Nach dem Lauf von Hand qualifizieren (Wunsch des Nutzers 12.10.).
  app.post('/api/lead-search/runs/:id/leads/:leadId/qualify', async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(100), leadId: z.string().min(1).max(200) }).safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const result = runner.qualifyManually(params.data.id, params.data.leadId);
    if (result === 'not_found') return sendError(reply, 404, 'not_found', 'Lead nicht gefunden – vielleicht wurde das Backend neu gestartet.');
    if (result === 'running') return sendError(reply, 409, 'running', 'Der Lauf ist noch nicht fertig.');
    if (result === 'not_allowed') {
      return sendError(reply, 400, 'invalid_request', 'Diesen Lead kannst du nicht von Hand qualifizieren – er ist schon im Cockpit, vernetzt oder qualifiziert.');
    }
    return result satisfies ManualQualifyResponse;
  });

  // Live-Fortschritt als Server-Sent Events: zuerst der komplette Stand, danach nur Änderungen.
  app.get('/api/lead-search/runs/:id/events', (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const record = params.success ? store.get(params.data.id) : undefined;
    if (!record) return sendError(reply, 404, 'not_found', 'Lauf nicht gefunden.');

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (data: string) => res.write(`data: ${data}\n\n`);
    write(JSON.stringify({ type: 'run', run: record.snapshot }));
    if (record.snapshot.status !== 'running') {
      write(JSON.stringify({ type: 'end', run: record.snapshot }));
      res.end();
      return;
    }

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    const unsubscribe = store.subscribe(record.snapshot.id, (data, event) => {
      write(data);
      if (event.type === 'end') {
        close();
        res.end();
      }
    });
    // Verbindung vom Browser geschlossen (Seitenwechsel, Reload) → Abo beenden.
    res.on('close', close);
  });

  return app;
}
