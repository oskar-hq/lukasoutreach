import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import {
  AUTO_SEARCH_ACTOR,
  AUTO_SEARCH_DEFAULT_MAX_ROUNDS,
  AUTO_SEARCH_DEFAULTS,
  AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES,
  AUTO_SEARCH_MAX_ROUNDS_LIMIT,
  AUTO_SEARCH_TIME_ZONE,
  AUTO_SEARCH_WAIT_MINUTES,
  focusKeywords,
  nextAutoSearchFocus,
  AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT,
  type AutoSearchLastRun,
  type AutoSearchSchedule,
  type AutoSearchToday,
  type AutoSearchUpdate,
} from '../../../shared/autoSearch.js';
import { DEFAULT_SEARCH_PROFILE, type LeadStatus, type NewLeadCard, type RunSnapshot } from '../../../shared/leadSearch.js';
import type { CockpitLead, CreateLeadsResponse } from '../../../shared/leads.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import { RunBusyError, checkedIds, type Logger, type PipelineRunner } from '../pipeline/runner.js';
import type { RunStore } from '../pipeline/runStore.js';
import { AutoSearchStore } from './store.js';
import { dueSlotAny, localClock, nextRunAtAny } from './time.js';

/** Uhrzeiten eines Plans: `time` und – falls gesetzt – `secondTime`. */
function timesOf(plan: { time: string; secondTime?: string | null }): string[] {
  return plan.secondTime && plan.secondTime !== plan.time ? [plan.time, plan.secondTime] : [plan.time];
}

/**
 * Planer der automatischen Lead-Suche (Vertrag `shared/autoSearch.ts`):
 *   - `tick()` prüft (im Betrieb alle 20 s) je Gründer, ob jetzt die geplante Minute ist. Nur genau dann – was
 *     verpasst wurde (Server aus), wird nicht nachgeholt. Jeder Termin wird in der Datenbank als ausgelöst gemerkt,
 *     bevor er startet, damit er auch nach einem Neustart in derselben Minute nicht doppelt läuft.
 *   - Fällige Läufe stehen in einer Warteschlange und laufen nacheinander (beide Gründer zur selben Zeit).
 *   - Ist die Suche durch einen anderen Lauf belegt, wartet der Termin und versucht es bei jedem `tick()` erneut,
 *     höchstens `AUTO_SEARCH_WAIT_MINUTES` – danach `skipped`.
 *   - Ein Lauf = `runner.start` (dieselben Schutzgrenzen wie von Hand), danach Übergabe und Anlegen der Leads für den
 *     Gründer (`actor` = `AUTO_SEARCH_ACTOR`) und Clay/Treg wie bei `POST /api/leads`.
 *   - Tagesziel (`dailyTarget`, `maxRounds`): Nach einem erfolgreichen geplanten Lauf, der noch ungeprüfte Profile fand,
 *     reiht der Planer den nächsten Lauf mit `AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES` Pause ein, solange am Tag des
 *     Termins weniger Leads übergeben und weniger Läufe gelaufen sind als vorgegeben.
 *   - Profilabrufe bremsen nur die Grenzen je LinkedIn-Account (Einstellungen → LinkedIn-Accounts, Live-Adapter).
 *     Die alte gemeinsame Tagesgrenze (`AUTO_SEARCH_PROFILES_PER_DAY`, aus der Zeit mit einem Such-Account) ist seit
 *     31.10. raus (Wunsch des Nutzers). Der Runner meldet weiter jeden Profilabruf (`countProfileFetch`) – nur zum Anzeigen.
 *   - Wartende Termine stehen auch in der Datenbank (`pending`): Nach einem Neustart werden sie als übersprungen
 *     gemeldet statt still zu verschwinden.
 *   - Kein Fehler darf den Planer beenden: alles wird gefangen und ohne Geheimnisse geloggt.
 */

declare module 'fastify' {
  interface FastifyInstance {
    /** Planer der automatischen Lead-Suche (Tests: `tick()`, `idle()`). */
    autoSearch: AutoSearchPlanner;
  }
}

/** Tagesziel: nach so vielen Läufen am Stück ohne neuen Lead ist für heute Schluss. */
export const AUTO_SEARCH_MAX_EMPTY_ROUNDS = 3;

const euro = (value: number) => `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** So oft prüft der Planer im Betrieb (mindestens jede Minute laut Vertrag). */
export const AUTO_SEARCH_TICK_MS = 20_000;

const MINUTE_MS = 60_000;

export const AUTO_SEARCH_MESSAGES = {
  skipped: `Übersprungen: Es lief gerade eine andere Suche, und sie war auch nach ${AUTO_SEARCH_WAIT_MINUTES} Minuten Warten nicht fertig.`,
  cancelled: 'Die Suche wurde abgebrochen.',
  unexpected: 'Die automatische Suche ist wegen eines unerwarteten Fehlers ausgefallen. Details stehen im Backend-Log.',
  restarted: 'Der Server wurde während der Suche neu gestartet – der Lauf ist abgebrochen.',
  restartedPending:
    'Übersprungen: Der Server wurde neu gestartet, bevor die geplante Suche starten konnte. Sie wird nicht nachgeholt – der nächste Termin läuft wie geplant.',
  noAnthropic:
    'Übersprungen: Ohne Anthropic-API-Schlüssel kann die KI die gefundenen Leads nicht bewerten – die Suche würde nur LinkedIn-Abrufe verbrauchen. Trag den Schlüssel unter Einstellungen → KI-Bewertung (Anthropic) ein.',
  aiFailed:
    'KI-Bewertung fehlgeschlagen: Die gefundenen Profile konnten nicht von der KI bewertet werden, es kam kein neuer Lead dazu. Prüf Schlüssel und Guthaben unter Einstellungen → KI-Bewertung (Anthropic) – die Profile kommen beim nächsten Lauf wieder dran.',
  unipileDown:
    'Übersprungen: Unipile ist gerade nicht erreichbar – siehe Meldung „Unipile antwortet nicht wie erwartet“ in der Glocke. Der nächste Termin läuft wie geplant, sobald Unipile wieder antwortet.',
  budget: (budget: number) =>
    `Übersprungen: Das KI-Tagesbudget von ${euro(budget)} ist heute aufgebraucht. Morgen geht es weiter – das Budget stellst du unter Einstellungen → Automatische Suche ein.`,
} as const;

/** Gründe für `AutoSearchToday.stopReason`: warum heute kein weiterer Lauf fürs Tagesziel kommt. */
export const AUTO_SEARCH_STOP = {
  rounds: (max: number) => `Gestoppt nach ${max} Läufen – mehr Läufe am Tag sind eingestellt nicht erlaubt.`,
  budget: (budget: number) => `Gestoppt: Das KI-Tagesbudget von ${euro(budget)} ist aufgebraucht.`,
  exhausted:
    'Gestoppt: Die Suche fand keine ungeprüften Profile mehr – alle Treffer zu diesem Suchprofil sind schon geprüft. Mehr Leads bringt ein breiteres Suchprofil (Positionen, Region, Stichwörter).',
  empty: (rounds: number) =>
    `Gestoppt: ${rounds} Läufe am Stück ohne neuen qualifizierten Lead. Mehr Leads bringt ein breiteres Suchprofil oder eine niedrigere KI-Schwelle.`,
  failed: (message: string | null) => `Gestoppt: Der letzte Lauf lief nicht sauber durch${message ? ` (${message})` : ''}.`,
  dayOver: 'Gestoppt: Der Tag des Termins ist vorbei.',
} as const;

interface Job {
  founder: AuthFounderId;
  /** Geplanter Zeitpunkt (Minutenbeginn). */
  startedAt: number;
  /** Seit wann der Termin auf eine fremde Suche wartet (null = noch nicht gewartet). */
  waitingSince: number | null;
  /** Folgelauf für das Tagesziel (kein eigener Termin). */
  followUp?: boolean;
  /** Tag des Termins („YYYY-MM-DD“, Zeitzone) – alles Zählen (Läufe, Leads, Tagesziel) gilt für diesen Tag. */
  day: string;
  /** Frühester Start (ms) – Pause vor einem Folgelauf. */
  notBefore?: number;
  /** Folgelauf nach „Jetzt einmal ausführen“ (läuft auch bei ausgeschaltetem Zeitplan). */
  manual?: boolean;
}

export interface AutoSearchDeps {
  config: Config;
  db: Database;
  runner: PipelineRunner;
  runs: RunStore;
  /** `searcher` = Gründer dieses Zeitplans; mit `LEAD_DISTRIBUTION=balanced` verteilt der Store die Leads selbst. */
  leads: { createFromCards(cards: NewLeadCard[], searcher: AuthFounderId, now: number, actor: string | null): CreateLeadsResponse };
  enrichment: { autoEnrich(leads: CockpitLead[]): Promise<void> };
  /** Satz, warum keine Suche starten kann (Live nicht startklar) – null = startklar. */
  startProblem: () => string | null;
  /**
   * Meldet die regelmäßige Unipile-Prüfung gerade „nicht erreichbar“ (Meldung `unipile:down` offen)? Dann werden
   * geplante Läufe still übersprungen (`skipped`, ohne zusätzliche Fehlermeldung/Slack – die Unipile-Meldung reicht).
   * „Jetzt ausführen“ versucht es trotzdem.
   */
  unipileDown?: () => boolean;
  log: Logger;
  /** Uhr – in Tests eine Fake-Uhr. */
  now?: () => number;
  /**
   * Nach jedem Lauf mit Ergebnis (auch ohne gestarteten Lauf) – für Neuigkeiten (`shared/notifications.ts`).
   * `alert` = true: Meldung wie bei `failed`, obwohl der Lauf nur übersprungen wurde (z. B. Anthropic-Schlüssel fehlt).
   */
  onFinished?: (founder: AuthFounderId, result: AutoSearchLastRun, alert: boolean) => void;
  /** KI-Kosten eines Laufs in Euro (Tagesbudget, `AutoSearchLastRun.costEur`). Ohne: Kosten 0, kein Budget wirksam. */
  runCostEur?: (runId: string) => number;
}

export class AutoSearchPlanner {
  readonly store: AutoSearchStore;
  private readonly now: () => number;
  private readonly queue: Job[] = [];
  private pumping: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  /** Läufe, deren Abschluss (Übergabe, Anlegen) noch aussteht – für Tests (`idle()`) und sauberes Beenden. */
  private readonly pending = new Set<Promise<void>>();
  /** Laufende Läufe dieses Planers → Gründer (für „Termin durch eigenen Lauf erledigt“). */
  private readonly owners = new Map<string, AuthFounderId>();
  /** Läufe am Stück ohne neuen Lead – fürs Tagesziel (`AUTO_SEARCH_MAX_EMPTY_ROUNDS`). */
  private readonly streaks = new Map<AuthFounderId, { day: string; streak: number }>();
  /**
   * „Jetzt einmal ausführen“ (Wunsch des Nutzers 22.10.): sucht wie ein Termin weiter bis zum Tagesziel – gezählt ab dem
   * Klick (Leads und Läufe des Tages zu diesem Zeitpunkt), damit ein schon erreichtes Tagesziel nicht sofort stoppt.
   */
  private readonly manualChains = new Map<AuthFounderId, { day: string; created: number; rounds: number }>();

  constructor(private readonly deps: AutoSearchDeps) {
    this.store = new AutoSearchStore(deps.db);
    this.now = deps.now ?? Date.now;
    this.recover();
  }

  /**
   * Nach einem Neustart: Läufe und Warteschlange sind nur im Speicher. Steht ein Lauf noch auf `running`, den der
   * Server nicht mehr kennt (Absturz, Deploy während der Suche), wird er als `failed` abgeschlossen. Wartete ein
   * fälliger Termin noch auf seinen Start, wird er als `skipped` gemeldet (nicht nachgeholt).
   */
  private recover(): void {
    for (const founder of AUTH_FOUNDER_IDS) {
      try {
        const last = this.store.lastRun(founder);
        if (last?.status === 'running' && !(last.runId && this.deps.runs.get(last.runId))) {
          this.store.setLastRun(founder, { ...last, status: 'failed', finishedAt: this.now(), message: AUTO_SEARCH_MESSAGES.restarted });
          this.deps.log.warn({ founder, runId: last.runId }, 'Automatische Lead-Suche: Lauf durch Neustart abgebrochen');
        }
        const pending = this.store.pending(founder);
        if (pending) {
          this.store.setPending(founder, null);
          this.store.setLastRun(founder, {
            runId: null,
            startedAt: pending.startedAt,
            finishedAt: this.now(),
            status: 'skipped',
            manual: false,
            created: 0,
            message: AUTO_SEARCH_MESSAGES.restartedPending,
          });
          this.deps.log.warn({ founder, slot: pending.startedAt }, 'Automatische Lead-Suche: wartender Termin durch Neustart verfallen');
        }
      } catch (error) {
        this.deps.log.error({ founder, err: errorText(error) }, 'Automatische Lead-Suche: letzter Lauf nicht lesbar');
      }
    }
  }

  /** Zurücksetzen der Simulation: Pläne, Zustand und geprüfte Profile löschen, Warteschlange leeren. */
  reset(): void {
    this.queue.length = 0;
    this.store.reset();
  }

  /**
   * Plan speichern (PUT). Ist die geplante Uhrzeit genau die laufende Minute, gilt dieser Termin als erledigt – sonst
   * startete sofort ein Lauf, obwohl `nextRunAt` schon den nächsten Termin zeigt.
   */
  save(founder: AuthFounderId, update: AutoSearchUpdate, by: string | null): AutoSearchSchedule {
    const now = this.now();
    this.store.saveSchedule(founder, update, now, by);
    const saved = this.store.schedule(founder);
    const key = saved?.enabled ? dueSlotAny(now, saved.days, timesOf(saved), AUTO_SEARCH_TIME_ZONE) : null;
    if (key) this.store.claimSlot(founder, key);
    return this.schedule(founder);
  }

  /** Zeitplan wie in der API – ohne gespeicherten Plan die Standardwerte (aus). */
  schedule(founder: AuthFounderId): AutoSearchSchedule {
    const stored = this.store.schedule(founder);
    const plan = stored ?? {
      ...AUTO_SEARCH_DEFAULTS,
      profile: this.defaultProfile(),
      dailyTarget: null,
      maxRounds: AUTO_SEARCH_DEFAULT_MAX_ROUNDS,
      secondTime: null,
      dailyBudgetEur: null,
      kapitalanlagePercent: AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT,
      updatedAt: null,
      updatedBy: null,
    };
    return {
      founder,
      enabled: plan.enabled,
      days: [...plan.days],
      time: plan.time,
      secondTime: plan.secondTime,
      profile: plan.profile,
      nextRunAt: plan.enabled ? nextRunAtAny(this.now(), plan.days, timesOf(plan), AUTO_SEARCH_TIME_ZONE) : null,
      ...this.followUpOf(founder),
      lastRun: this.store.lastRun(founder),
      nextFocus: nextAutoSearchFocus(this.store.focusCounts(founder), plan.kapitalanlagePercent),
      focusCounts: this.store.focusCounts(founder),
      kapitalanlagePercent: plan.kapitalanlagePercent,
      updatedAt: plan.updatedAt,
      updatedBy: plan.updatedBy,
      dailyTarget: plan.dailyTarget,
      maxRounds: plan.maxRounds,
      dailyBudgetEur: plan.dailyBudgetEur,
      today: this.todayOf(founder),
    };
  }

  /** Eingereihter Folgelauf fürs Tagesziel (Pause) – damit die Oberfläche zeigt, dass die Suche weitermacht. */
  private followUpOf(founder: AuthFounderId): Pick<AutoSearchSchedule, 'followUpAt' | 'followUpManual'> {
    const job = this.queue.find((entry) => entry.founder === founder && entry.followUp);
    return job ? { followUpAt: job.notBefore ?? job.startedAt, followUpManual: job.manual === true } : { followUpAt: null, followUpManual: false };
  }

  /** Stand des Tages mit dem Zähler der Profilabrufe (beide Gründer, nur zur Info – gebremst wird je Account). */
  private todayOf(founder: AuthFounderId): AutoSearchToday | null {
    const day = this.day();
    const today = this.store.today(founder, day);
    if (!today) return null;
    return { ...today, profileFetches: this.store.profileFetches(day) };
  }

  /** Heutiger Tag in der Zeitzone der automatischen Suche („YYYY-MM-DD“). */
  private day(): string {
    return localClock(this.now(), AUTO_SEARCH_TIME_ZONE).day;
  }

  /** Standardprofil wie `GET /api/lead-search/config` (`defaults`): `MAX_RESULTS` der Installation. */
  private defaultProfile() {
    return { ...DEFAULT_SEARCH_PROFILE, maxResults: this.deps.config.maxResults };
  }

  /** Im Betrieb regelmäßig prüfen. Der Zeitgeber hält den Prozess nicht am Leben (Tests, sauberes Beenden). */
  startTimer(intervalMs = AUTO_SEARCH_TICK_MS): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }

  /** Fällige Termine einreihen und die Warteschlange abarbeiten. Wirft nie. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const now = this.now();
    // Je Gründer einzeln absichern: ein kaputter Plan hält den anderen nicht auf.
    for (const founder of AUTH_FOUNDER_IDS) {
      try {
        const plan = this.store.schedule(founder);
        if (!plan?.enabled) continue;
        const key = dueSlotAny(now, plan.days, timesOf(plan), AUTO_SEARCH_TIME_ZONE);
        if (!key || !this.store.claimSlot(founder, key)) continue;
        this.deps.log.info({ founder, slot: key }, 'Automatische Lead-Suche fällig');
        const job: Job = { founder, startedAt: Math.floor(now / MINUTE_MS) * MINUTE_MS, waitingSince: null, day: localClock(now, AUTO_SEARCH_TIME_ZONE).day };
        // Erst merken, dann einreihen: Geht der Server vor dem Start aus, meldet `recover()` den Termin als übersprungen.
        this.safe(() => this.store.setPending(founder, { startedAt: job.startedAt, day: job.day }), founder);
        this.queue.push(job);
      } catch (error) {
        this.deps.log.error({ founder, err: errorText(error) }, 'Automatische Lead-Suche: Prüfung fehlgeschlagen');
      }
    }
    return this.pump();
  }

  /** Wartet, bis Warteschlange und alle Abschlüsse fertig sind (Tests). */
  async idle(): Promise<void> {
    while (this.pumping || this.pending.size) {
      await this.pumping;
      await Promise.all([...this.pending]);
    }
  }

  /**
   * „Jetzt einmal ausführen“: sofort starten. Wirft `RunBusyError` (409) oder gibt `{ problem }` zurück, wenn der
   * Live-Modus nicht startklar ist (400 config). Der Abschluss läuft im Hintergrund weiter.
   */
  runNow(founder: AuthFounderId): { runId: string } | { problem: string } {
    const problem = this.deps.startProblem();
    if (problem) return { problem };
    const budget = this.store.schedule(founder)?.dailyBudgetEur ?? null;
    if (budget !== null && this.costBudget(founder, this.day()) <= 0) return { problem: AUTO_SEARCH_MESSAGES.budget(budget) };
    const day = this.day();
    const today = this.store.today(founder, day);
    const started = this.start(founder, this.now(), true, day);
    this.manualChains.set(founder, { day, created: today?.created ?? 0, rounds: today?.rounds ?? 0 });
    this.streaks.delete(founder);
    return { runId: started.id };
  }

  /** Vom Runner vor jedem Profilabruf (alle Läufe, auch von Hand) – Zähler zum Anzeigen, keine Grenze. Wirft nie. */
  countProfileFetch(): void {
    if (this.closed) return;
    this.safe(() => this.store.addProfileFetch(this.day()));
  }

  /** Heute noch verfügbares KI-Budget dieses Gründers in Euro – Infinity ohne Budget. */
  private costBudget(founder: AuthFounderId, day: string): number {
    const budget = this.store.schedule(founder)?.dailyBudgetEur ?? null;
    if (budget === null) return Infinity;
    return budget - (this.store.today(founder, day)?.costEur ?? 0);
  }

  /** KI-Kosten eines Laufs in Euro (0, wenn nicht messbar). */
  private runCost(runId: string): number {
    try {
      return this.deps.runCostEur?.(runId) ?? 0;
    } catch {
      return 0;
    }
  }

  /** Live ohne Anthropic-Schlüssel (laufende Konfiguration, also auch aus den Einstellungen): nichts würde bewertet. */
  private missingQualifier(): boolean {
    return this.deps.config.mode === 'live' && !this.deps.config.anthropic.apiKey;
  }

  /** Arbeitet die Warteschlange ab – höchstens einmal gleichzeitig. */
  private pump(): Promise<void> {
    if (!this.pumping) {
      this.pumping = this.drain()
        .catch((error) => this.deps.log.error({ err: errorText(error) }, 'Automatische Lead-Suche: Warteschlange fehlgeschlagen'))
        .finally(() => {
          this.pumping = null;
        });
    }
    return this.pumping;
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length) {
      // Der erste Termin, der schon starten darf – ein Folgelauf in seiner Pause hält andere nicht auf.
      const now = this.now();
      const job = this.queue.find((entry) => (entry.notBefore ?? 0) <= now);
      if (!job) return;
      let step: 'wait' | 'next' | Promise<void>;
      try {
        step = this.step(job);
      } catch (error) {
        // Ein kaputter Termin (z. B. unlesbarer Plan, Datenbank belegt) darf den anderen Gründer nicht blockieren.
        this.remove(job);
        this.deps.log.error({ founder: job.founder, err: errorText(error) }, 'Automatische Lead-Suche nicht gestartet');
        this.finishWithoutRun(job, 'failed', AUTO_SEARCH_MESSAGES.unexpected);
        continue;
      }
      // Beim nächsten tick() erneut versuchen.
      if (step === 'wait') return;
      // Nacheinander: erst den nächsten Termin, wenn dieser fertig übergeben ist.
      if (step !== 'next') await step;
    }
  }

  /** Termin aus der Warteschlange nehmen; ein geplanter Termin wartet dann auch in der Datenbank nicht mehr. */
  private remove(job: Job): void {
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    if (!job.followUp) this.safe(() => this.store.setPending(job.founder, null), job.founder);
  }

  /** Ein Schritt für einen Termin: verwerfen/abschließen ('next'), warten ('wait') oder Lauf starten. */
  private step(job: Job): 'wait' | 'next' | Promise<void> {
    const now = this.now();
    const plan = this.store.schedule(job.founder);
    // In der Zwischenzeit ausgeschaltet → Termin verfällt (Folgeläufe nach „Jetzt ausführen“ brauchen nur den Plan).
    if (!plan || (!plan.enabled && !job.manual)) {
      this.remove(job);
      return 'next';
    }
    // Folgelauf, dessen Tag inzwischen vorbei ist → verfällt (das Tagesziel gilt für den Tag des Termins).
    if (job.followUp && job.day !== this.day()) {
      this.remove(job);
      this.deps.log.info({ founder: job.founder, day: job.day }, 'Automatische Lead-Suche: Tag vorbei, kein weiterer Lauf');
      return 'next';
    }
    const problem = this.deps.startProblem();
    if (problem) {
      this.remove(job);
      this.finishWithoutRun(job, 'failed', problem);
      return 'next';
    }
    if (this.deps.unipileDown?.()) {
      this.remove(job);
      this.finishWithoutRun(job, 'skipped', AUTO_SEARCH_MESSAGES.unipileDown);
      return 'next';
    }
    if (this.missingQualifier()) {
      this.remove(job);
      this.finishWithoutRun(job, 'skipped', AUTO_SEARCH_MESSAGES.noAnthropic, true);
      return 'next';
    }
    if (this.costBudget(job.founder, job.day) <= 0) {
      this.remove(job);
      // Ein geplanter Termin meldet sich, ein Folgelauf fürs Tagesziel nicht (der Termin selbst lief ja schon).
      this.finishWithoutRun(job, 'skipped', AUTO_SEARCH_MESSAGES.budget(plan.dailyBudgetEur ?? 0), !job.followUp);
      return 'next';
    }
    const active = this.deps.runs.active();
    if (active) return this.busy(job, active.snapshot.id, now);
    try {
      const { done } = this.start(job.founder, job.startedAt, job.manual === true, job.day);
      this.remove(job);
      return done;
    } catch (error) {
      // Gerade eben hat jemand von Hand gestartet → wie belegt behandeln.
      if (error instanceof RunBusyError) return this.busy(job, error.runId, now);
      throw error;
    }
  }

  /** Suche belegt: Läuft schon ein Lauf desselben Gründers (z. B. „Jetzt ausführen“), ist der Termin erledigt. */
  private busy(job: Job, runId: string, now: number): 'wait' | 'next' {
    if (this.owners.get(runId) === job.founder) {
      this.remove(job);
      this.deps.log.info({ founder: job.founder, runId }, 'Automatische Lead-Suche: Termin durch laufenden eigenen Lauf erledigt');
      return 'next';
    }
    job.waitingSince ??= now;
    if (now - job.waitingSince < AUTO_SEARCH_WAIT_MINUTES * MINUTE_MS) return 'wait';
    this.remove(job);
    this.finishWithoutRun(job, 'skipped', AUTO_SEARCH_MESSAGES.skipped);
    return 'next';
  }

  /**
   * Startet einen Lauf mit dem Profil des Gründers; wirft `RunBusyError`. `day` = Tag des Termins (Zählen).
   */
  private start(founder: AuthFounderId, startedAt: number, manual: boolean, day: string): RunSnapshot & { done: Promise<void> } {
    const { profile } = this.schedule(founder);
    // Geprüfte Profile beider Gründer überspringen: ein Such-Account, ein Tageslimit (`checkedShared`).
    const checked = this.store.checkedShared(this.now());
    // Anteil Kapitalanlage/Finanzdienstleister (Regler, Standard 50 %): Dieser Lauf sucht gezielt eine Zielgruppe – mit
    // den passenden Stichwörtern des Profils.
    const focus = nextAutoSearchFocus(this.store.focusCounts(founder), this.store.schedule(founder)?.kapitalanlagePercent);
    const remaining = this.costBudget(founder, day);
    const run = this.deps.runner.start(
      {
        profile: { ...profile, keywords: focusKeywords(profile.keywords, focus) },
        known: [],
        pendingInvitations: [],
        checked,
      },
      Number.isFinite(remaining) ? { maxCostEur: Math.max(0, remaining) } : {},
    );
    this.safe(() => this.store.countFocus(founder, focus), founder);
    this.safe(() => void this.store.addToday(founder, day, { rounds: 1 }), founder);
    const lastRun: AutoSearchLastRun = { runId: run.id, startedAt, finishedAt: null, status: 'running', manual, created: 0, message: null, focus };
    this.safe(() => this.store.setLastRun(founder, lastRun), founder);
    this.deps.log.info({ founder, runId: run.id, manual }, 'Automatische Lead-Suche gestartet');
    this.owners.set(run.id, founder);
    const done = this.waitForEnd(run.id)
      .then(() => this.finish(founder, run.id, lastRun, day))
      .catch((error) => this.deps.log.error({ founder, runId: run.id, err: errorText(error) }, 'Automatische Lead-Suche: Abschluss fehlgeschlagen'))
      .finally(() => this.owners.delete(run.id));
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done));
    return { ...run, done };
  }

  private waitForEnd(runId: string): Promise<void> {
    return new Promise((resolve) => {
      const record = this.deps.runs.get(runId);
      if (!record || record.snapshot.status !== 'running') return resolve();
      const unsubscribe = this.deps.runs.subscribe(runId, (_data, event) => {
        if (event.type !== 'end') return;
        unsubscribe();
        resolve();
      });
    });
  }

  /** Nach dem Lauf: geprüfte Profile merken, übergeben, Leads anlegen, letzten Lauf speichern. */
  private async finish(founder: AuthFounderId, runId: string, lastRun: AutoSearchLastRun, day: string): Promise<void> {
    if (this.closed) return;
    const record = this.deps.runs.get(runId);
    let result: AutoSearchLastRun;
    // Profile, die dieser Lauf neu geprüft hat (nicht schon bekannt) – 0 = Suche ausgeschöpft.
    let fresh = 0;
    try {
      if (!record) throw new Error('Lauf nicht mehr im Speicher');
      const run = record.snapshot;
      // Nur Profile mit Endergebnis merken – was wegen Abbruch, Fehler, Limit oder fehlender KI offen blieb, kommt
      // beim nächsten Lauf wieder dran.
      this.store.addChecked(founder, checkedIds(run), this.now());
      fresh = freshCount(run);
      // Qualifizierte Leads gehen immer in den Tagesstapel – auch nach Abbruch oder Fehler, sie sind schon bezahlt.
      const cards = this.deps.runner.handoff(runId) ?? [];
      // `created` zählt alle neuen Leads dieses Laufs für das Tagesziel des Zeitplans – auch die, die
      // `LEAD_DISTRIBUTION=balanced` dem anderen Gründer zugeteilt hat (gesucht hat dieser Zeitplan).
      const created = cards.length ? this.deps.leads.createFromCards(cards, founder, this.now(), AUTO_SEARCH_ACTOR).created : [];
      try {
        await this.deps.enrichment.autoEnrich(created);
      } catch (error) {
        this.deps.log.warn({ founder, runId, err: errorText(error) }, 'Automatische Lead-Suche: Firmendaten nicht geholt');
      }
      let status: AutoSearchLastRun['status'] = run.status === 'done' ? 'done' : run.status === 'cancelled' ? 'cancelled' : 'failed';
      let message =
        status === 'done'
          ? null
          : status === 'cancelled'
            ? AUTO_SEARCH_MESSAGES.cancelled
            : run.error
              ? `${run.error.title}: ${run.error.message}`
              : AUTO_SEARCH_MESSAGES.unexpected;
      // KI ausgefallen (Anthropic nicht erreichbar, Guthaben leer …): Lauf „fertig“, aber nichts bewertet → als Fehler
      // melden (Neuigkeit) und keine Folgeläufe, die dieselben Profile nur erneut abrufen würden.
      if (status === 'done' && created.length === 0 && mostlyUnrated(run)) {
        status = 'failed';
        message = AUTO_SEARCH_MESSAGES.aiFailed;
      }
      result = { ...lastRun, finishedAt: this.now(), status, created: created.length, message, costEur: roundCost(this.runCost(runId)) };
    } catch (error) {
      this.deps.log.error({ founder, runId, err: errorText(error) }, 'Automatische Lead-Suche: Übergabe fehlgeschlagen');
      result = { ...lastRun, finishedAt: this.now(), status: 'failed', message: AUTO_SEARCH_MESSAGES.unexpected, costEur: roundCost(this.runCost(runId)) };
    }
    if (this.closed) return;
    this.safe(() => this.store.setLastRun(founder, result), founder);
    this.deps.log.info({ founder, runId, status: result.status, created: result.created }, 'Automatische Lead-Suche beendet');
    this.safe(() => this.deps.onFinished?.(founder, result, false), founder);
    this.safe(() => this.continueForTarget(founder, result, day, fresh), founder);
  }

  /**
   * Tagesziel: Nach einem erfolgreich beendeten Lauf den nächsten einreihen
   * (nach `AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES` Pause), solange am Tag des Termins weniger als `dailyTarget` Leads
   * übergeben und weniger als `maxRounds` Läufe gestartet sind. Nicht weiter nach Fehler oder Abbruch (z. B.
   * LinkedIn-Limit), wenn der Lauf kein ungeprüftes Profil mehr fand (Suche ausgeschöpft), nach
   * `AUTO_SEARCH_MAX_EMPTY_ROUNDS` Läufen am Stück ohne neuen Lead oder wenn der Tag vorbei ist – Schutzgrenzen
   * gehen vor. Sind alle LinkedIn-Accounts an ihrer Grenze, endet der Lauf mit Fehler → Stopp mit dem Satz des Adapters. Nach „Jetzt einmal ausführen“ genauso, auch bei
   * ausgeschaltetem Zeitplan; Leads und Läufe zählen dann ab dem Klick (`manualChains`).
   */
  private continueForTarget(founder: AuthFounderId, result: AutoSearchLastRun, day: string, fresh: number): void {
    const today = this.store.addToday(founder, day, { created: result.created, costEur: result.costEur ?? 0 });
    const chain = result.manual ? this.manualChains.get(founder) : undefined;
    if (result.manual && chain?.day !== day) return;
    const plan = this.store.schedule(founder);
    if (!plan || (!plan.enabled && !chain) || plan.dailyTarget === null) return this.endChain(founder, chain);
    const created = today.created - (chain?.created ?? 0);
    const rounds = today.rounds - (chain?.rounds ?? 0);
    const info = { founder, day, created, rounds, manual: Boolean(chain) };
    // Jeder Stopp vor dem Tagesziel steht mit Grund im Zeitplan (`today.stopReason`), nicht nur im Log.
    const stop = (reason: string) => {
      this.endChain(founder, chain);
      this.safe(() => void this.store.setStopReason(founder, day, reason), founder);
    };
    if (created >= plan.dailyTarget) {
      this.endChain(founder, chain);
      this.deps.log.info(info, 'Automatische Lead-Suche: Tagesziel erreicht');
      return;
    }
    if (result.status !== 'done') return stop(AUTO_SEARCH_STOP.failed(result.message));
    // Mit KI-Tagesbudget zählt das Geld, nicht die Zahl der Läufe (Wunsch des Nutzers 11.10.) – nur die Obergrenze bleibt.
    const maxRounds = plan.dailyBudgetEur !== null ? AUTO_SEARCH_MAX_ROUNDS_LIMIT : plan.maxRounds;
    if (rounds >= maxRounds) {
      this.deps.log.info(info, 'Automatische Lead-Suche: höchste Zahl an Läufen erreicht');
      return stop(AUTO_SEARCH_STOP.rounds(maxRounds));
    }
    if (plan.dailyBudgetEur !== null && (today.costEur ?? 0) >= plan.dailyBudgetEur) {
      this.deps.log.info({ ...info, costEur: today.costEur, budget: plan.dailyBudgetEur }, 'Automatische Lead-Suche: KI-Tagesbudget aufgebraucht');
      return stop(AUTO_SEARCH_STOP.budget(plan.dailyBudgetEur));
    }
    // Bis 11.10. war nach einem Lauf ohne neuen Lead Schluss – oft schon nach dem ersten (Nutzer: „hat einen Kunden
    // gefunden“). Jetzt: weiter, solange die Suche noch ungeprüfte Profile findet; erst nach mehreren Läufen am Stück
    // ohne neuen Lead oder wenn nichts Neues mehr kam (Suche ausgeschöpft) ist für heute Schluss.
    const streak = this.zeroStreak(founder, day, result.created);
    if (fresh === 0) {
      this.deps.log.info(info, 'Automatische Lead-Suche: keine ungeprüften Profile mehr gefunden – heute kein weiterer');
      return stop(AUTO_SEARCH_STOP.exhausted);
    }
    if (streak >= AUTO_SEARCH_MAX_EMPTY_ROUNDS) {
      this.deps.log.info({ ...info, streak }, 'Automatische Lead-Suche: mehrere Läufe ohne neuen Lead – heute kein weiterer');
      return stop(AUTO_SEARCH_STOP.empty(streak));
    }
    if (day !== this.day()) {
      this.deps.log.info(info, 'Automatische Lead-Suche: Tag des Termins vorbei – kein weiterer Lauf');
      return stop(AUTO_SEARCH_STOP.dayOver);
    }
    const notBefore = this.now() + AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES * MINUTE_MS;
    this.queue.push({ founder, startedAt: notBefore, waitingSince: null, followUp: true, day, notBefore, manual: Boolean(chain) });
    this.deps.log.info({ ...info, target: plan.dailyTarget, round: rounds + 1 }, 'Automatische Lead-Suche: weiterer Lauf für das Tagesziel');
    void this.pump();
  }

  /** Kette nach „Jetzt einmal ausführen“ beenden – nur die eigene (ein neuer Klick hat schon eine neue angelegt). */
  private endChain(founder: AuthFounderId, chain: { day: string } | undefined): void {
    if (chain && this.manualChains.get(founder) === chain) this.manualChains.delete(founder);
  }

  /** Läufe am Stück ohne neuen Lead (je Gründer und Tag); ein Lauf mit Lead setzt zurück. */
  private zeroStreak(founder: AuthFounderId, day: string, created: number): number {
    const last = this.streaks.get(founder);
    const streak = created > 0 ? 0 : (last?.day === day ? last.streak : 0) + 1;
    this.streaks.set(founder, { day, streak });
    return streak;
  }

  private finishWithoutRun(job: Job, status: 'failed' | 'skipped', message: string, alert = false, stopReason = true): void {
    // Folgelauf fürs Tagesziel fiel aus → heute geht es nicht weiter; der Grund gehört zum Tagesstand.
    if (job.followUp && stopReason) this.safe(() => void this.store.setStopReason(job.founder, job.day, message.replace(/^Übersprungen:/, 'Gestoppt:')), job.founder);
    if (job.manual) this.endChain(job.founder, this.manualChains.get(job.founder));
    const lastRun: AutoSearchLastRun = { runId: null, startedAt: job.startedAt, finishedAt: this.now(), status, manual: job.manual === true, created: 0, message };
    this.safe(() => this.store.setLastRun(job.founder, lastRun), job.founder);
    this.deps.log.warn({ founder: job.founder, status, message }, 'Automatische Lead-Suche nicht gelaufen');
    this.safe(() => this.deps.onFinished?.(job.founder, lastRun, alert), job.founder);
  }

  private safe(work: () => void, founder?: AuthFounderId): void {
    try {
      work();
    } catch (error) {
      this.deps.log.error({ founder, err: errorText(error) }, 'Automatische Lead-Suche: Speichern fehlgeschlagen');
    }
  }
}

export { checkedIds } from '../pipeline/runner.js';

/** Profile, die der Lauf neu geprüft hat: Vorprüfung oder Profilabruf mit Ergebnis – ohne bekannte Dubletten. */
export function freshCount(run: Pick<RunSnapshot, 'leads'>): number {
  return run.leads.filter((lead) => lead.status === 'screened_out' || (lead.profile && lead.status !== 'duplicate')).length;
}

const roundCost = (value: number) => Math.round(value * 10_000) / 10_000;

/** Leads, die bis zur KI kamen (Profil abgerufen, kein Duplikat): bewertet oder an der KI gescheitert. */
const AI_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>(['qualified', 'ads_active', 'rejected', 'failed', 'unrated']);
const AI_FAILED: ReadonlySet<LeadStatus> = new Set<LeadStatus>(['failed', 'unrated']);

/**
 * Mehr als die Hälfte der Leads, die zur KI kamen, blieb ohne Bewertung (`failed` mit Profil = KI-Fehler,
 * `unrated` = kein Schlüssel). Profilabruf-Fehler (`failed` ohne Profil) zählen nicht.
 */
export function mostlyUnrated(run: Pick<RunSnapshot, 'leads'>): boolean {
  const rated = run.leads.filter((lead) => lead.profile && AI_STATUSES.has(lead.status));
  const failed = rated.filter((lead) => AI_FAILED.has(lead.status)).length;
  return failed > 0 && failed * 2 > rated.length;
}

/** Nur die Meldung loggen – kein Body, keine Header (keine Geheimnisse). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
