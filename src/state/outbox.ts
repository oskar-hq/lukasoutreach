import { ApiError } from '../lib/leadSearchApi';

/**
 * Ausgangskorb für Entscheidungen im Cockpit. Eine Entscheidung gilt in der Oberfläche sofort, gespeichert (ab
 * Phase 3: wirklich gesendet) wird sie erst, wenn das Rückgängig-Fenster vorbei ist – der Server kennt kein
 * „Rückgängig“. Läuft außerhalb von React (ein Korb je Tab), damit Seitenwechsel, Neuaufbau und StrictMode nichts
 * verlieren oder doppelt senden.
 *
 * - Aufträge desselben Leads (`queue`) laufen nacheinander, verschiedene Leads parallel.
 * - Unklarer Ausgang (offline, 5xx, Zeitüberschreitung, 401): Der Auftrag wartet und wird wiederholt – vorher prüft
 *   `verify`, ob er nicht doch schon angekommen ist (sonst gäbe es z. B. ein Follow-up doppelt). Bei `idempotent`
 *   (Meldung mit `clientId`, die der Server nur einmal bucht) entfällt diese Prüfung.
 * - Endgültig abgelehnt (400/404/409): `onFinalError`; bei 409 vorher `verify` (anderer Tab war schneller).
 * - Beim Verlassen der Seite geht alles sofort raus (`keepalive`), beim Abmelden wartet `drain()` darauf.
 */

export type OutboxPhase = 'scheduled' | 'sending' | 'waiting';

export interface OutboxJob<R> {
  /** Eindeutig, z. B. die Aufgaben-ID. Ein neuer Auftrag mit derselben ID ersetzt einen noch nicht gestarteten. */
  id: string;
  /** Reihenfolge innerhalb einer Warteschlange (meist die Lead-ID). */
  queue: string;
  delayMs: number;
  /**
   * `urgent`: Seite wird gerade geschlossen – nur noch eine einzige Anfrage, keine Vorabprüfung.
   * `retry`: nicht der erste Versuch (der vorige Ausgang war unklar).
   */
  send: (options: { keepalive: boolean; signal: AbortSignal; urgent: boolean; retry: boolean }) => Promise<R>;
  /** Wiederholen ist gefahrlos (der Server erkennt die Wiederholung) – `verify` dann nur noch nach 409. */
  idempotent?: boolean;
  /** Nach unklarem Ausgang: Ergebnis, falls die Aktion schon gespeichert ist, sonst null. */
  verify?: () => Promise<R | null>;
  onStart?: () => void;
  onSuccess: (result: R) => void;
  /** Auftrag wartet (offline usw.) und wird wiederholt. */
  onWaiting?: (error: ApiError) => void;
  onFinalError: (error: ApiError) => void;
}

interface Entry {
  job: OutboxJob<unknown>;
  phase: OutboxPhase;
  commitAt: number;
  attempts: number;
  generation: number;
  promise: Promise<void> | null;
  retryTimer?: number;
}

export interface OutboxSnapshot {
  entries: { id: string; queue: string; phase: OutboxPhase; commitAt: number }[];
  /** Angehalten (Panel offen, Maus über der Meldung) – das Fenster läuft nicht ab. */
  held: boolean;
  /** Pausiert nach 401 – erst nach erneuter Anmeldung geht es weiter. */
  paused: boolean;
}

const TIMEOUT_MS = 15_000;
/** Größere Anfragen dürfen nicht mit `keepalive` (Browser-Grenze 64 KB für alle Anfragen zusammen). */
const KEEPALIVE_LIMIT = 56_000;
const RETRY_DELAYS = [2_000, 5_000, 10_000, 30_000, 60_000];
/** Nach dem Loslassen (Panel zu) bleibt noch kurz Zeit für Rückgängig. */
const RELEASE_GRACE_MS = 1_500;

/** Ob ein Fehler „vielleicht angekommen“ bedeutet – dann warten und wiederholen statt aufgeben. */
export function isRetriable(error: ApiError): boolean {
  // LinkedIn- und Close-Fehler sind endgültig (Limit, Pause, Dienst nicht erreichbar, Schlüssel falsch – jeweils
  // „nichts gebucht“). Die Meldung zeigt die Karte; ein neuer Versuch ist ein neuer Klick.
  if (error.code.startsWith('linkedin_') || error.code.startsWith('crm_')) return false;
  return error.code === 'offline' || error.status === 0 || error.status >= 500 || error.status === 401;
}

function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('offline', 'Backend nicht erreichbar.', 0);
}

class Outbox {
  private entries: Entry[] = [];
  private holds = new Set<string>();
  private paused = false;
  private generation = 0;
  private timer: number | undefined;
  private listeners = new Set<() => void>();
  private snapshot: OutboxSnapshot = { entries: [], held: false, paused: false };

  constructor() {
    if (typeof window === 'undefined') return;
    // Seite wird geschlossen oder neu geladen: alles sofort losschicken (nur synchron gestartete Anfragen überleben).
    // Seite wird wirklich verlassen: nur noch eine Anfrage je Auftrag, ohne Vorabprüfung (nichts Asynchrones überlebt).
    window.addEventListener('pagehide', () => this.flushAll(true));
    // Nur in den Hintergrund: normal starten, mit Prüfung – das Skript läuft weiter.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushAll();
      else this.retryWaiting();
    });
    window.addEventListener('online', () => this.retryWaiting());
    // Noch nicht gespeicherte Entscheidungen, die schon gescheitert sind (offline, Server weg): Beim Schließen oder
    // Neuladen fragt der Browser nach – sonst wären sie still verloren (25.10.: nichts darf unbemerkt verschwinden).
    window.addEventListener('beforeunload', (event) => {
      if (!this.entries.some((entry) => entry.phase === 'waiting')) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = {
      entries: this.entries.map((entry) => ({ id: entry.job.id, queue: entry.job.queue, phase: entry.phase, commitAt: entry.commitAt })),
      held: this.holds.size > 0,
      paused: this.paused,
    };
    for (const listener of this.listeners) listener();
  }

  /** false: Ein Auftrag mit dieser ID läuft noch (z. B. aus einer früheren Sitzung) – dann nichts Neues. */
  schedule<R>(job: OutboxJob<R>): boolean {
    const existing = this.entries.find((entry) => entry.job.id === job.id);
    if (existing && existing.phase !== 'scheduled') return false;
    if (existing) this.entries = this.entries.filter((entry) => entry !== existing);
    this.entries.push({
      job: job as OutboxJob<unknown>,
      phase: 'scheduled',
      commitAt: Date.now() + job.delayMs,
      attempts: 0,
      generation: this.generation,
      promise: null,
    });
    this.emit();
    this.plan();
    return true;
  }

  /** Rückgängig: nur möglich, solange der Auftrag noch nicht gestartet ist. */
  cancel(id: string): boolean {
    const entry = this.entries.find((candidate) => candidate.job.id === id);
    if (!entry || entry.phase !== 'scheduled') return false;
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    this.emit();
    this.plan();
    return true;
  }

  has(id: string) {
    return this.entries.some((entry) => entry.job.id === id);
  }

  /** Sofort starten (z. B. „Jetzt abarbeiten“ nach der Übergabe). Wartet auf das Ergebnis. */
  async commitNow(id: string): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.job.id === id);
    if (!entry) return;
    if (entry.phase === 'scheduled' || entry.phase === 'waiting') this.start(entry);
    await entry.promise;
  }

  hold(reason: string) {
    if (this.holds.has(reason)) return;
    this.holds.add(reason);
    window.clearTimeout(this.timer);
    this.emit();
  }

  release(reason: string) {
    if (!this.holds.delete(reason)) return;
    if (this.holds.size === 0) {
      const earliest = Date.now() + RELEASE_GRACE_MS;
      for (const entry of this.entries) if (entry.phase === 'scheduled') entry.commitAt = Math.max(entry.commitAt, earliest);
    }
    this.emit();
    this.plan();
  }

  /** 401: nichts mehr senden, nichts verwerfen – nach erneuter Anmeldung geht es mit `resume` weiter. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    window.clearTimeout(this.timer);
    this.emit();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.emit();
    this.retryWaiting();
    this.plan();
  }

  /** Alles verwerfen (anderer Nutzer, Abmelden ohne Speichern). Laufende Anfragen melden sich nicht mehr zurück. */
  discardAll() {
    this.generation++;
    for (const entry of this.entries) window.clearTimeout(entry.retryTimer);
    this.entries = [];
    window.clearTimeout(this.timer);
    this.emit();
  }

  /**
   * Alle Aufträge einer Warteschlange verwerfen (der Lead wurde gelöscht). Laufende Anfragen melden sich nicht mehr
   * zurück; die übrigen Leads sind nicht betroffen.
   */
  discardQueue(queue: string) {
    const dropped = this.entries.filter((entry) => entry.job.queue === queue);
    if (!dropped.length) return;
    for (const entry of dropped) window.clearTimeout(entry.retryTimer);
    this.entries = this.entries.filter((entry) => entry.job.queue !== queue);
    this.emit();
    this.plan();
  }

  /**
   * Alle geplanten und wartenden Aufträge sofort starten – synchron, damit sie das Schließen der Seite überleben.
   * `urgent` nur beim Verlassen der Seite: dann ohne Vorabprüfung, weil danach nichts Asynchrones mehr läuft.
   */
  flushAll(urgent = false) {
    if (this.paused) return;
    for (const entry of [...this.entries]) {
      if (entry.phase === 'scheduled' || entry.phase === 'waiting') this.start(entry, urgent);
    }
  }

  /** Vor dem Abmelden: alles senden und warten. Gibt zurück, wie viele Aufträge noch warten (offline). */
  async drain(): Promise<number> {
    this.flushAll();
    await Promise.all(this.entries.map((entry) => entry.promise).filter(Boolean));
    return this.entries.filter((entry) => entry.phase === 'waiting').length;
  }

  /** Wartende Aufträge jetzt erneut versuchen (Knopf „Erneut versuchen“, wieder online). */
  retryWaiting() {
    if (this.paused) return;
    for (const entry of this.entries) {
      if (entry.phase !== 'waiting' || entry.promise) continue;
      window.clearTimeout(entry.retryTimer);
      this.start(entry);
    }
  }

  private plan() {
    window.clearTimeout(this.timer);
    if (this.paused || this.holds.size > 0) return;
    const now = Date.now();
    for (const entry of [...this.entries]) {
      if (entry.phase === 'scheduled' && entry.commitAt <= now && this.isFirstInQueue(entry)) this.start(entry);
    }
    const next = this.entries
      .filter((entry) => entry.phase === 'scheduled')
      .reduce((min, entry) => Math.min(min, entry.commitAt), Infinity);
    if (next !== Infinity) this.timer = window.setTimeout(() => this.plan(), Math.max(0, next - Date.now()));
  }

  private isFirstInQueue(entry: Entry) {
    return this.entries.find((candidate) => candidate.job.queue === entry.job.queue) === entry;
  }

  private start(entry: Entry, urgent = false) {
    if (entry.promise) return;
    window.clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    const { job } = entry;
    const generation = entry.generation;
    const alive = () => generation === this.generation && this.entries.includes(entry);
    const retry = entry.attempts > 0;
    entry.phase = 'sending';
    entry.attempts++;
    job.onStart?.();
    this.emit();

    const run = async () => {
      let result: unknown;
      try {
        // Nach einem unklaren Ausgang erst nachsehen, ob es schon angekommen ist.
        const verified = retry && !urgent && !job.idempotent && job.verify ? await job.verify() : null;
        // Immer mit keepalive: Schließt jemand die Seite, während die Anfrage läuft, kommt sie trotzdem an.
        result = verified ?? (await job.send({ keepalive: true, signal: AbortSignal.timeout(TIMEOUT_MS), urgent, retry }));
      } catch (raw) {
        const error = toApiError(raw);
        if (!alive()) return;
        if (error.status === 409 && job.verify) {
          const verified = await job.verify().catch(() => null);
          if (verified && alive()) return this.finish(entry, () => job.onSuccess(verified));
        }
        if (isRetriable(error)) {
          if (error.status === 401) this.pause();
          entry.phase = 'waiting';
          entry.promise = null;
          job.onWaiting?.(error);
          this.emit();
          if (!this.paused) {
            const delay = RETRY_DELAYS[Math.min(entry.attempts - 1, RETRY_DELAYS.length - 1)];
            entry.retryTimer = window.setTimeout(() => {
              if (alive() && entry.phase === 'waiting' && !this.paused) this.start(entry);
            }, delay);
          }
          return;
        }
        return this.finish(entry, () => job.onFinalError(error));
      }
      if (alive()) this.finish(entry, () => job.onSuccess(result));
    };
    entry.promise = run();
  }

  private finish(entry: Entry, callback: () => void) {
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    entry.promise = null;
    callback();
    this.emit();
    this.plan();
  }
}

export const outbox = new Outbox();

/** Ob ein JSON-Body klein genug für `keepalive` ist. */
export function fitsKeepalive(body: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(body)).length < KEEPALIVE_LIMIT;
}
