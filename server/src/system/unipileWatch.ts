import type { FastifyBaseLogger } from 'fastify';
import type { LinkedinAccountStatus } from '../../../shared/leadSearch.js';

/**
 * Regelmäßige Unipile-Prüfung (nur live): Läuft der Unipile-Testzeitraum oder das Abo aus, merkt das sonst niemand,
 * solange LinkedIn-Aktionen und automatische Suche aus sind. Deshalb fragt der Server alle paar Stunden die
 * Account-Liste ab (GET /api/v1/accounts – dokumentiert, nur lesend, keine LinkedIn-Aktion) und meldet einmal
 * (Glocke + Slack), wenn kein startklarer LinkedIn-Account zurückkommt. Klappt es wieder, verschwindet die Meldung.
 */

/** Erste Prüfung kurz nach dem Start (nicht sofort – der Server soll erst hochfahren). */
export const UNIPILE_WATCH_FIRST_MS = 2 * 60 * 1000;
/** Danach alle 4 Stunden: 6 Anfragen am Tag. */
export const UNIPILE_WATCH_EVERY_MS = 4 * 60 * 60 * 1000;

/** „unreachable“ erst melden, wenn so viele Prüfungen in Folge scheitern (gegen Fehlalarm und Slack-Flattern). */
export const UNIPILE_UNREACHABLE_CHECKS = 2;

export interface UnipileWatchDeps {
  /** Nur prüfen, wenn live und Unipile-Adresse + Token gesetzt sind (wird bei jeder Prüfung neu gelesen). */
  enabled: () => boolean;
  /** Account-Status frisch von Unipile (null = Adapter kann das nicht, z. B. Simulation). */
  status: (signal: AbortSignal) => Promise<LinkedinAccountStatus> | null;
  onDown: (status: LinkedinAccountStatus) => void;
  onOk: () => void;
  log: FastifyBaseLogger;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Regelmäßige Unipile-Prüfung (Tests: `check()`). */
    unipileWatch: UnipileWatch;
  }
}

export class UnipileWatch {
  private firstTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Aufeinanderfolgende Prüfungen mit „unreachable“ – ein einzelner Netz-Aussetzer meldet noch nichts. */
  private unreachableInRow = 0;

  constructor(private readonly deps: UnipileWatchDeps) {}

  /**
   * Eine Prüfung. Zustand „connecting“ ändert nichts (vorübergehend). „unreachable“ meldet erst ab der
   * {@link UNIPILE_UNREACHABLE_CHECKS}. Prüfung in Folge (Netz-Aussetzer, Zeitüberschreitung). Fehler werden nur
   * geloggt. Ist die Prüfung aus (Simulation, Token entfernt), verschwindet eine offene Meldung.
   */
  async check(): Promise<LinkedinAccountStatus | null> {
    if (this.running) return null;
    if (!this.deps.enabled()) {
      this.unreachableInRow = 0;
      this.deps.onOk();
      return null;
    }
    this.running = true;
    try {
      const pending = this.deps.status(AbortSignal.timeout(30_000));
      if (!pending) return null;
      const status = await pending;
      if (status.state === 'ok') {
        this.unreachableInRow = 0;
        this.deps.onOk();
      } else if (status.state !== 'connecting') {
        this.deps.log.warn({ state: status.state }, 'Unipile-Prüfung: kein startklarer LinkedIn-Account');
        if (status.state === 'unreachable') this.unreachableInRow++;
        else this.unreachableInRow = 0;
        if (status.state !== 'unreachable' || this.unreachableInRow >= UNIPILE_UNREACHABLE_CHECKS) this.deps.onDown(status);
      }
      return status;
    } catch (error) {
      this.deps.log.error({ err: error instanceof Error ? error.message : String(error) }, 'Unipile-Prüfung fehlgeschlagen');
      return null;
    } finally {
      this.running = false;
    }
  }

  startTimer(firstMs = UNIPILE_WATCH_FIRST_MS, everyMs = UNIPILE_WATCH_EVERY_MS): void {
    if (this.timer || this.firstTimer) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.check();
      this.timer = setInterval(() => void this.check(), everyMs);
      this.timer.unref();
    }, firstMs);
    this.firstTimer.unref();
  }

  close(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }
}
