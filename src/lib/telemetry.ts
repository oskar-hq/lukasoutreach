import { TELEMETRY_MAX_EVENTS, TELEMETRY_SLOW_MS, telemetryPath, type TelemetryEvent, type TelemetryEventName } from '../../shared/telemetry';
import { onApiResult, telemetryApi } from './leadSearchApi';

/**
 * Nutzungsdaten der Oberfläche (Vertrag `shared/telemetry.ts`, Wunsch des Nutzers 09.11.: „alles auf Datengrundlage
 * optimieren“). Erfasst ohne Zutun jedes Features:
 *   - Klicks auf Elemente mit `data-testid` (das Attribut haben alle wichtigen Knöpfe – neue Features bekommen es auch),
 *   - Tastaturkürzel (`useHotkeys`), Ansichten mit Verweildauer, Karten im Tagesstapel mit Zeit und Ausgang,
 *   - Fehler (JS, abgelehnte Promises, ErrorBoundary) und gescheiterte oder langsame Anfragen.
 * Keine Inhalte: keine Texte aus Feldern, keine Namen. Gesendet in Paketen alle 15 s und beim Verlassen der Seite.
 * Läuft nur, solange jemand angemeldet ist (`start`/`stop` in der Hülle).
 */

const FLUSH_MS = 15_000;
const sessionId = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();

let running = false;
let queue: TelemetryEvent[] = [];
let view: string | null = null;
let viewSince = 0;
let card: { id: string; type: string; since: number; outcome: string | null; decided?: boolean } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const cleanups: Array<() => void> = [];

/** Die letzten Schritte und Fehler – für das Feedback-Fenster (`FeedbackHost`), damit Claude den Weg nachvollzieht. */
const TRAIL_MAX = 40;
const trail: TelemetryEvent[] = [];

function push(name: TelemetryEventName, target: string | null, extra: Pick<TelemetryEvent, 'ms' | 'props'> = {}): void {
  if (!running) return;
  const event: TelemetryEvent = { name, at: Date.now(), view, target: target ? target.slice(0, 160) : null, ...extra };
  trail.push(event);
  if (trail.length > TRAIL_MAX) trail.shift();
  queue.push(event);
  if (queue.length >= TELEMETRY_MAX_EVENTS) flush();
}

const clock = (at: number) => new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** „12:01:03 click start-lead (home)“ – älteste zuerst. */
export function recentTrail(): string[] {
  return trail.map((event) => `${clock(event.at)} ${event.name} ${event.target ?? ''}${event.ms ? ` ${Math.round(event.ms / 100) / 10}s` : ''}${event.props?.status !== undefined ? ` [${event.props.status}]` : ''} (${event.view ?? '–'})`.replace(/\s+/g, ' '));
}

/** Fehler und gescheiterte Anfragen der letzten 10 Minuten. */
export function recentErrors(): string[] {
  const since = Date.now() - 10 * 60 * 1000;
  return trail
    .filter((event) => event.at >= since && (event.name === 'error' || (event.name === 'api' && Number(event.props?.status ?? 0) !== 200)))
    .map((event) => `${clock(event.at)} ${event.name === 'api' ? `${event.target} → ${event.props?.status ?? '?'}` : event.target} (${event.view ?? '–'})`);
}

export function currentView(): string | null {
  return view;
}

export function flush(): void {
  if (!queue.length) return;
  const events = queue.slice(0, TELEMETRY_MAX_EVENTS);
  queue = queue.slice(TELEMETRY_MAX_EVENTS);
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
  telemetryApi.send({
    sessionId,
    events,
    client: { width: window.innerWidth, height: window.innerHeight, standalone: !!standalone, touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0 },
  });
}

/** Ansicht gewechselt: die vorige mit Verweildauer melden. */
export function setView(next: string): void {
  if (next === view) return;
  closeCard();
  if (view && viewSince) push('view', view, { ms: Date.now() - viewSince });
  view = next;
  viewSince = Date.now();
}

/** Karte im Tagesstapel gezeigt (`null` = keine mehr). Die vorige wird mit Zeit und letzter Aktion gemeldet. */
export function setCard(next: { id: string; type: string } | null): void {
  if (card && next && card.id === next.id) return;
  closeCard();
  if (next) card = { ...next, since: Date.now(), outcome: null };
}

function closeCard(): void {
  if (!card) return;
  push('card', card.type, { ms: Date.now() - card.since, props: card.outcome ? { outcome: card.outcome } : undefined });
  card = null;
}

/** Tastaturkürzel (aus `useHotkeys`). */
export function trackHotkey(key: string): void {
  push('hotkey', key);
  if (card && !card.decided) card.outcome = `Taste ${key}`;
}

/**
 * Entscheidung ohne Klick oder Taste, z. B. per Wischen (10.11.): Im Bericht standen solche Karten als „ohne Aktion“ –
 * auf dem Handy also fast alle.
 */
export function trackCardOutcome(outcome: string): void {
  // Steht fest: Der Klick, den der Browser nach dem Loslassen noch meldet, überschreibt die Geste nicht.
  if (card) Object.assign(card, { outcome, decided: true });
}

/** Fehler, den eine Komponente abgefangen hat (ErrorBoundary). */
export function trackError(message: string): void {
  push('error', message.slice(0, 160));
}

export function start(): void {
  if (running) return;
  running = true;
  viewSince = Date.now();
  const onClick = (event: MouseEvent) => {
    const element = event.target instanceof Element ? event.target.closest('[data-testid]') : null;
    const testId = element?.getAttribute('data-testid');
    if (!testId) return;
    push('click', testId);
    if (card && !card.decided) card.outcome = testId;
  };
  const onError = (event: ErrorEvent) => push('error', event.message || 'Fehler');
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    push('error', reason instanceof Error ? reason.message : String(reason ?? 'Promise abgelehnt'));
  };
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = () => {
    if (view && viewSince) {
      push('view', view, { ms: Date.now() - viewSince });
      viewSince = Date.now();
    }
    flush();
  };
  window.addEventListener('click', onClick, true);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  cleanups.push(
    () => window.removeEventListener('click', onClick, true),
    () => window.removeEventListener('error', onError),
    () => window.removeEventListener('unhandledrejection', onRejection),
    () => document.removeEventListener('visibilitychange', onHide),
    () => window.removeEventListener('pagehide', onPageHide),
    onApiResult(({ url, status, ms }) => {
      if (url.includes('/api/telemetry/')) return;
      // Abmelden/abgelaufen ist kein Fehler der Oberfläche.
      if (status === 401) return;
      if (status >= 400 || status === 0 || ms >= TELEMETRY_SLOW_MS) push('api', telemetryPath(url), { ms, props: { status } });
    }),
  );
  timer = setInterval(flush, FLUSH_MS);
}

/**
 * Abmelden: offene Ereignisse verwerfen statt senden – ohne Sitzung würde das Backend sie ablehnen (und der Browser
 * einen Fehler in die Konsole schreiben).
 */
export function stop(): void {
  if (!running) return;
  running = false;
  queue = [];
  card = null;
  view = null;
  if (timer) clearInterval(timer);
  timer = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
}
