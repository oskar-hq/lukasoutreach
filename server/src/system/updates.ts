import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Weekday } from '../../../shared/autoSearch.js';
import type { LeadSearchMode } from '../../../shared/leadSearch.js';
import { UPDATE_CHANGES_MAX, type UpdateRun, type UpdateState, type UpdateStatusResponse, type VersionInfo } from '../../../shared/system.js';
import { nextRunAt } from '../autoSearch/time.js';
import type { Env } from '../settings/effective.js';

/**
 * Software-Updates (Vertrag `shared/system.ts` → „Updates“). Das Backend selbst ruft nie git oder Docker auf: Es
 * spricht mit dem Update-Dienst (`deploy/updater`, nur im internen Docker-Netz, gemeinsamer Schlüssel aus
 * `UPDATER_TOKEN_FILE`). Fehlt der Dienst, meldet der Status `available: false` mit fertigem Satz.
 *
 * Simulation (`LEAD_SEARCH_MODE=mock` und kein Schlüssel vorhanden – so laufen die E2E-Tests): erfundene Versionen,
 * ein „Update“ dauert `MOCK_UPDATE_SECONDS` (Standard 3 s) und meldet danach „aktuell“. Es wird nichts eingespielt.
 *
 * Nachts automatisch: `UPDATE_AUTO` + `UPDATE_HOUR` (deutsche Zeit) – nur wenn es etwas Neues gibt und keine
 * Lead-Suche läuft (sonst eine Stunde später erneut).
 *
 * Vor jedem echten Update (Knopf und nachts) sichert `backupBeforeUpdate` die Datenbank (`vor-update-…`); scheitert
 * das, startet das Update nicht (503 `backup_failed`). Ob ein gestartetes Update später beim Bauen scheitert, steht nur
 * im Protokoll des Dienstes – `watchLastRun` liest es jede Minute und meldet den Ausgang einmal je Lauf.
 */

export const UPDATER_UNAVAILABLE_REASON =
  'Der Update-Dienst ist noch nicht eingerichtet – einmal das nächste Update von Hand einspielen (README → Updates), danach geht es per Knopf.';
export const UPDATE_TIME_ZONE = 'Europe/Berlin';
const CHECK_INTERVAL_MS = 10_000;
const RETRY_BUSY_MS = 60 * 60 * 1000;
const AUTO_TICK_MS = 60 * 1000;
const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7] as Weekday[];
const AUTO_BY = 'Automatisch (nachts)';
/** Ältere Läufe meldet `watchLastRun` nicht mehr (z. B. nach einem Neustart des Backends Tage später). */
const RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class SystemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'SystemError';
  }
}

/** Der Dienst war schon einmal da (Schlüssel vorhanden), antwortet aber gerade nicht – z. B. Neustart nach einem Update. */
export const UPDATER_RESTARTING_REASON = 'Der Update-Dienst startet gerade neu – gleich noch einmal nachsehen.';
export const UPDATER_NOT_RESPONDING_REASON = 'Der Update-Dienst antwortet gerade nicht – bitte in ein paar Minuten noch einmal nachsehen.';
/** So lange nach dem letzten Lauf gilt „antwortet nicht“ als Neustart. */
const RECENT_RUN_MS = 15 * 60 * 1000;
const BUSY_MESSAGE = 'Gerade läuft eine Lead-Suche – bitte warte, bis sie fertig ist, und spiel das Update dann ein.';

// ── Einstellungen UPDATE_AUTO / UPDATE_HOUR (aus `config.update`, wirkt ohne Neustart) ──

export interface UpdateSettings {
  enabled: boolean;
  hour: number;
}

// ── Client für den Update-Dienst ──────────────────────────────────────────────

/** Antwort des Update-Dienstes (`deploy/updater/server.mjs`). */
export interface UpdaterStatus {
  current: VersionInfo;
  latest: VersionInfo;
  behind: number;
  changes: VersionInfo[];
  checkedAt: number | null;
  running: boolean;
  lastRun: UpdateRun | null;
  /** Code schon geholt, Bauen/Starten aber gescheitert oder unterbrochen – erneut einspielen geht. */
  pendingBuild?: boolean;
}

/** Protokoll des Dienstes im gemeinsamen Volume (`updater-state.json`) – lesbar auch, wenn er gerade nicht antwortet. */
interface UpdaterStateFile {
  lastRun: UpdateRun | null;
  checkedAt: number | null;
  pendingBuild?: boolean;
}

/** Dienst nicht erreichbar oder Schlüssel fehlt. */
export class UpdaterUnavailable extends Error {}

/** Dienst antwortet mit Fehler (`code` aus dem Dienst, `message` schon ohne Geheimnisse). */
export class UpdaterRejected extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class UpdaterClient {
  constructor(
    private readonly url: string,
    private readonly tokenFile: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Schlüssel vorhanden = Dienst ist eingerichtet (er legt ihn beim ersten Start an). */
  configured(): boolean {
    return existsSync(this.tokenFile);
  }

  /** Letztes Protokoll des Dienstes aus dem gemeinsamen Volume (nur lesen), null wenn nicht lesbar. */
  readState(): UpdaterStateFile | null {
    try {
      const data = JSON.parse(readFileSync(path.join(path.dirname(this.tokenFile), 'updater-state.json'), 'utf8')) as UpdaterStateFile;
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  private token(): string {
    try {
      const token = readFileSync(this.tokenFile, 'utf8').trim();
      if (token) return token;
    } catch {
      // unten
    }
    throw new UpdaterUnavailable('Schlüssel fehlt');
  }

  private async call(method: 'GET' | 'POST', route: string, timeoutMs: number, body?: object): Promise<UpdaterStatus> {
    const token = this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new UpdaterUnavailable('nicht erreichbar');
    }
    const data = (await response.json().catch(() => null)) as (UpdaterStatus & { error?: { code?: string; message?: string } }) | null;
    if (response.ok && data && !data.error) return data;
    if (response.status === 401) throw new UpdaterUnavailable('Schlüssel abgelehnt');
    throw new UpdaterRejected(response.status, data?.error?.code ?? 'failed', data?.error?.message ?? `Der Update-Dienst antwortet mit Fehler ${response.status}.`);
  }

  status(fetchRemote: boolean): Promise<UpdaterStatus> {
    return this.call('GET', `/status?fetch=${fetchRemote ? '1' : '0'}`, fetchRemote ? 200_000 : 20_000);
  }

  update(by: string): Promise<UpdaterStatus> {
    return this.call('POST', '/update', 200_000, { by });
  }
}

// ── Simulation ────────────────────────────────────────────────────────────────

const SIM_DAY = Date.UTC(2026, 9, 6, 9, 0);
const SIM_CURRENT: VersionInfo = { commit: 'a1b2c3d', title: 'Sicherungen und Updates in der Oberfläche', date: SIM_DAY - 2 * 24 * 3600_000 };
const SIM_CHANGES: VersionInfo[] = [
  { commit: 'c0ffee1', title: 'Übergabe an Close', date: SIM_DAY },
  { commit: 'b4d5e6f', title: 'Lead-Suche: Firmendaten schneller anreichern', date: SIM_DAY - 24 * 3600_000 },
];

interface SimState {
  current: VersionInfo;
  changes: VersionInfo[];
  checkedAt: number | null;
  running: boolean;
  lastRun: UpdateRun | null;
}

// ── Dienst ───────────────────────────────────────────────────────────────────

export interface UpdateServiceDeps {
  mode: () => LeadSearchMode;
  /** Umgebung des Backends: UPDATER_URL, UPDATER_TOKEN_FILE, APP_COMMIT*, MOCK_UPDATE_SECONDS. */
  env: Env;
  settings: () => UpdateSettings;
  /** Läuft gerade eine Lead-Suche? Dann kein automatisches Update. */
  runActive: () => boolean;
  log: FastifyBaseLogger;
  fetch?: typeof fetch;
  now?: () => number;
  /** Ausgang des automatischen Updates – für Neuigkeiten (`shared/notifications.ts`). `reason` nur bei 'failed'. */
  onAutoResult?: (result: 'up_to_date' | 'started' | 'failed', reason?: string) => void;
  /**
   * Ein Lauf des Update-Dienstes ist fertig (aus seinem Protokoll, einmal je Lauf) – `auto`: nachts gestartet. So
   * fallen auch Fehler auf, die erst nach dem Start beim Bauen/Neustarten passieren.
   */
  onRunFinished?: (run: UpdateRun, auto: boolean) => void;
  /** Sicherung der Datenbank vor einem echten Update; wirft, wenn sie nicht geht (dann kein Update). Gibt den Namen zurück. */
  backupBeforeUpdate?: () => string;
}

export class UpdateService {
  readonly client: UpdaterClient;
  private readonly sim: SimState = { current: SIM_CURRENT, changes: [...SIM_CHANGES], checkedAt: null, running: false, lastRun: null };
  private simTimer: NodeJS.Timeout | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private lastCheckAt = 0;
  /** Nächster automatischer Versuch und die Stunde, für die er berechnet wurde. */
  private autoAt: number | null = null;
  private autoHour: number | null = null;
  /** Zuletzt erfolgreich vom Dienst gelesener Stand. */
  private lastKnown: UpdaterStatus | null = null;
  /** Dieses Backend hat ein Update gestartet und sein Ende noch nicht gesehen (Zeitpunkt des Starts). */
  private startedRunAt: number | null = null;
  /** Start des zuletzt von `watchLastRun` gemeldeten Laufs (nur im Speicher; nach einem Neustart zählt RESULT_MAX_AGE_MS). */
  private reportedRunAt: number | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    const url = (deps.env.UPDATER_URL?.trim() || 'http://updater:8790').replace(/\/+$/, '');
    this.client = new UpdaterClient(url, deps.env.UPDATER_TOKEN_FILE?.trim() || '/shared/updater.token', deps.fetch);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Simulation nur ohne eingerichteten Update-Dienst (ein Testserver mit Mock-Daten darf echt aktualisieren). */
  simulated(): boolean {
    return this.deps.mode() === 'mock' && !this.client.configured();
  }

  /** Commit, mit dem dieses Backend gebaut wurde (Build-Argument `APP_COMMIT`), sonst null. */
  private ownVersion(): VersionInfo | null {
    const commit = this.deps.env.APP_COMMIT?.trim();
    if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) return null;
    const date = Number(this.deps.env.APP_COMMIT_DATE);
    return { commit: commit.slice(0, 7), title: this.deps.env.APP_COMMIT_TITLE?.trim() ?? '', date: Number.isFinite(date) ? date : 0 };
  }

  // ── Automatisch ──

  /** Nächster automatischer Versuch (ms) oder null, wenn aus. */
  nextAutoAt(now = this.now()): number | null {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      this.autoAt = null;
      this.autoHour = null;
      return null;
    }
    if (this.autoAt === null || this.autoHour !== settings.hour) {
      this.autoAt = nextRunAt(now, ALL_DAYS, `${String(settings.hour).padStart(2, '0')}:00`, UPDATE_TIME_ZONE);
      this.autoHour = settings.hour;
    }
    return this.autoAt;
  }

  /** Einmal prüfen, ob ein automatisches Update fällig ist (Zeitgeber jede Minute; Tests rufen es direkt). */
  async autoTick(now = this.now()): Promise<'off' | 'waiting' | 'busy' | 'up_to_date' | 'started' | 'failed'> {
    const due = this.nextAutoAt(now);
    if (due === null) return 'off';
    if (now < due) return 'waiting';
    if (this.deps.runActive()) {
      this.autoAt = now + RETRY_BUSY_MS;
      this.deps.log.info('Automatisches Update verschoben: Lead-Suche läuft (in einer Stunde erneut)');
      return 'busy';
    }
    // Nächster regulärer Termin (morgen), egal wie dieser Versuch ausgeht.
    this.autoAt = null;
    this.nextAutoAt(now + 60_000);
    const report = (result: 'up_to_date' | 'started' | 'failed', reason?: string) => {
      try {
        this.deps.onAutoResult?.(result, reason);
      } catch {
        // Meldungen dürfen das Update nie stören.
      }
      return result;
    };
    try {
      const status = await this.check(true);
      if (status.behind === 0 && !status.pendingBuild) return report('up_to_date');
      await this.start(AUTO_BY, status);
      this.deps.log.info('Automatisches Update gestartet');
      return report('started');
    } catch (error) {
      if (error instanceof SystemError && error.code === 'up_to_date') return report('up_to_date');
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log.warn({ reason }, 'Automatisches Update fehlgeschlagen');
      return report('failed', reason);
    }
  }

  /**
   * Ausgang des letzten Laufs aus dem Protokoll des Dienstes (`updater-state.json`, ohne Netz) bzw. der Simulation –
   * einmal je Lauf an `onRunFinished`. Läufe, die länger als 24 h fertig sind, zählen nicht (Neustart Tage später).
   */
  watchLastRun(now = this.now()): 'none' | 'done' | 'failed' {
    const run = this.simulated() ? this.sim.lastRun : this.client.configured() ? (this.client.readState()?.lastRun ?? this.lastKnown?.lastRun ?? null) : null;
    if (!run || run.finishedAt === null || run.ok === null || this.reportedRunAt === run.startedAt) return 'none';
    this.reportedRunAt = run.startedAt;
    if (now - run.finishedAt > RESULT_MAX_AGE_MS) return 'none';
    try {
      this.deps.onRunFinished?.(run, run.by === AUTO_BY);
    } catch {
      // Meldungen dürfen nie stören.
    }
    return run.ok ? 'done' : 'failed';
  }

  startTimer(intervalMs = AUTO_TICK_MS): void {
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => {
      this.watchLastRun();
      void this.autoTick();
    }, intervalMs);
    this.autoTimer.unref();
  }

  close(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (this.simTimer) clearTimeout(this.simTimer);
    this.autoTimer = null;
    this.simTimer = null;
  }

  // ── Status ──

  private response(parts: Partial<UpdateStatusResponse> & Pick<UpdateStatusResponse, 'available' | 'simulated'>): UpdateStatusResponse {
    const settings = this.deps.settings();
    return {
      reason: null,
      current: null,
      latest: null,
      behind: 0,
      changes: [],
      checkedAt: null,
      state: 'idle',
      lastRun: null,
      pendingBuild: false,
      auto: { enabled: settings.enabled, hour: settings.hour },
      nextAutoAt: this.nextAutoAt(),
      ...parts,
    };
  }

  private stateOf(running: boolean, lastRun: UpdateRun | null): UpdateState {
    if (running || (lastRun && lastRun.finishedAt === null)) return 'running';
    if (!lastRun) return 'idle';
    return lastRun.ok ? 'done' : 'failed';
  }

  private fromSim(): UpdateStatusResponse {
    const { current, changes, checkedAt, running, lastRun } = this.sim;
    return this.response({
      available: true,
      simulated: true,
      current,
      latest: changes[0] ?? current,
      behind: changes.length,
      changes: changes.slice(0, UPDATE_CHANGES_MAX),
      checkedAt,
      state: this.stateOf(running, lastRun),
      lastRun,
    });
  }

  private fromUpdater(status: UpdaterStatus): UpdateStatusResponse {
    const own = this.ownVersion();
    // Läuft ein anderer Stand als im Projektordner (z. B. Bauen fehlgeschlagen), zählt der laufende.
    const current = own && own.commit !== status.current.commit ? own : status.current;
    this.lastKnown = status;
    if (!status.running && status.lastRun && status.lastRun.finishedAt !== null && status.lastRun.startedAt >= (this.startedRunAt ?? 0) - 60_000) {
      this.startedRunAt = null;
    }
    return this.response({
      available: true,
      simulated: false,
      current,
      latest: status.latest,
      behind: status.behind,
      changes: status.changes.slice(0, UPDATE_CHANGES_MAX),
      checkedAt: status.checkedAt,
      state: this.stateOf(status.running, status.lastRun),
      lastRun: status.lastRun,
      pendingBuild: status.pendingBuild === true,
    });
  }

  private unavailable(reason: string): UpdateStatusResponse {
    return this.response({ available: false, simulated: false, reason, current: this.ownVersion() });
  }

  /**
   * Dienst gerade nicht erreichbar. Nie eingerichtet (kein Schlüssel) → Hinweis auf die einmalige Einrichtung. War er
   * schon da und lief eben ein Update (oder ist der letzte Lauf jünger als 15 min) → „startet gerade neu“, der Zustand
   * bleibt „läuft“, solange das Ende nicht bekannt ist. Sonst → „antwortet gerade nicht“. Nie die Shell empfehlen.
   */
  private unreachable(): { reason: string; status: UpdateStatusResponse } {
    if (!this.client.configured()) return { reason: UPDATER_UNAVAILABLE_REASON, status: this.unavailable(UPDATER_UNAVAILABLE_REASON) };
    const saved = this.client.readState();
    const known = this.lastKnown;
    const lastRun = saved?.lastRun ?? known?.lastRun ?? null;
    const unfinished = this.startedRunAt !== null || (lastRun !== null && lastRun.finishedAt === null) || known?.running === true;
    const recent = lastRun !== null && this.now() - (lastRun.finishedAt ?? lastRun.startedAt) < RECENT_RUN_MS;
    const reason = unfinished || recent ? UPDATER_RESTARTING_REASON : UPDATER_NOT_RESPONDING_REASON;
    const own = this.ownVersion();
    return {
      reason,
      status: this.response({
        available: false,
        simulated: false,
        reason,
        current: own ?? known?.current ?? null,
        latest: known?.latest ?? null,
        behind: known?.behind ?? 0,
        changes: known?.changes.slice(0, UPDATE_CHANGES_MAX) ?? [],
        checkedAt: saved?.checkedAt ?? known?.checkedAt ?? null,
        state: unfinished ? 'running' : this.stateOf(false, lastRun),
        lastRun,
        pendingBuild: saved?.pendingBuild === true || known?.pendingBuild === true,
      }),
    };
  }

  /** GET: zuletzt geprüfter Stand, ohne bei GitHub nachzusehen. Nie ein Fehler – höchstens `available: false`. */
  async status(): Promise<UpdateStatusResponse> {
    if (this.simulated()) return this.fromSim();
    try {
      return this.fromUpdater(await this.client.status(false));
    } catch (error) {
      if (error instanceof UpdaterRejected) return this.unavailable(error.message);
      return this.unreachable().status;
    }
  }

  /** Jetzt bei GitHub nachsehen – höchstens alle 10 s (die Automatik zählt nicht mit). */
  async check(internal = false): Promise<UpdateStatusResponse> {
    const now = this.now();
    if (!internal) {
      const wait = this.lastCheckAt + CHECK_INTERVAL_MS - now;
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        throw new SystemError(429, 'too_many_attempts', `Bitte warte ${seconds} Sekunden, bevor du noch einmal nachsiehst.`, seconds);
      }
      this.lastCheckAt = now;
    }
    if (this.simulated()) {
      this.sim.checkedAt = now;
      return this.fromSim();
    }
    try {
      return this.fromUpdater(await this.client.status(true));
    } catch (error) {
      throw this.asSystemError(error);
    }
  }

  /**
   * Update starten (Passwort prüft die Route). 202-Status mit `state: 'running'`. Vorher die Datenbank sichern – aber
   * nur, wenn wirklich ein Update kommt (wie in `autoTick`): Läuft schon eins oder ist nichts neu, antwortet es 409
   * ohne Sicherung. `checked` = eben geprüfter Stand (Automatik), sonst fragt es den Dienst frisch (mit GitHub).
   */
  async start(by: string, checked?: UpdateStatusResponse): Promise<UpdateStatusResponse> {
    if (this.deps.runActive()) throw new SystemError(409, 'busy', BUSY_MESSAGE);
    if (this.simulated()) return this.startSim(by);
    let status = checked;
    if (!status) {
      try {
        status = this.fromUpdater(await this.client.status(true));
      } catch (error) {
        throw this.asSystemError(error);
      }
    }
    if (status.state === 'running') throw new SystemError(409, 'update_running', 'Es läuft schon ein Update.');
    if (status.behind === 0 && !status.pendingBuild) throw new SystemError(409, 'up_to_date', 'Die Software ist schon aktuell.');
    this.backupFirst();
    try {
      const started = this.now();
      const status = await this.client.update(by);
      this.startedRunAt = started;
      return this.fromUpdater(status);
    } catch (error) {
      throw this.asSystemError(error);
    }
  }

  /** Sicherung vor dem Update – scheitert sie, bricht das Update mit klarem Satz ab (es wurde nichts geändert). */
  private backupFirst(): void {
    if (!this.deps.backupBeforeUpdate) return;
    try {
      const name = this.deps.backupBeforeUpdate();
      this.deps.log.info({ file: name }, 'Datenbank vor dem Update gesichert');
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : 'unbekannter Fehler';
      this.deps.log.warn({ reason }, 'Sicherung vor dem Update fehlgeschlagen – Update nicht gestartet');
      throw new SystemError(
        503,
        'backup_failed',
        `Die Sicherung der Datenbank vor dem Update hat nicht geklappt (${reason}) – das Update wurde nicht gestartet. Prüf den Speicherplatz oder leg unter Sicherungen von Hand eine an und versuch es dann noch einmal.`,
      );
    }
  }

  private asSystemError(error: unknown): SystemError {
    if (error instanceof UpdaterRejected) {
      if (error.code === 'update_running' || error.code === 'up_to_date') return new SystemError(409, error.code, error.message);
      return new SystemError(503, 'updater_unavailable', error.message);
    }
    if (error instanceof UpdaterUnavailable) return new SystemError(503, 'updater_unavailable', this.unreachable().reason);
    return new SystemError(503, 'updater_unavailable', 'Der Update-Dienst hat nicht geantwortet. Bitte später noch einmal versuchen.');
  }

  private startSim(by: string): UpdateStatusResponse {
    if (this.sim.running) throw new SystemError(409, 'update_running', 'Es läuft schon ein Update.');
    if (this.sim.changes.length === 0) throw new SystemError(409, 'up_to_date', 'Die Software ist schon aktuell.');
    const startedAt = this.now();
    this.sim.running = true;
    this.sim.checkedAt = startedAt;
    this.sim.lastRun = { startedAt, finishedAt: null, ok: null, message: 'Das Update läuft … (Simulation)', by };
    const seconds = Number(this.deps.env.MOCK_UPDATE_SECONDS);
    const delayMs = (Number.isFinite(seconds) && seconds >= 0 ? seconds : 3) * 1000;
    this.simTimer = setTimeout(() => {
      const latest = this.sim.changes[0];
      this.sim.current = latest;
      this.sim.changes = [];
      this.sim.running = false;
      this.sim.lastRun = { startedAt, finishedAt: this.now(), ok: true, message: `Auf ${latest.commit} aktualisiert. (Simulation – nichts wurde eingespielt.)`, by };
      this.simTimer = null;
    }, delayMs);
    this.simTimer.unref();
    return this.fromSim();
  }
}
