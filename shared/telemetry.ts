/**
 * Nutzungsdaten (Wunsch des Nutzers 09.11.: „alles auf Datengrundlage optimieren – wie ein IT-Unternehmen seine
 * Software verbessert“). Die Oberfläche meldet in Paketen, was benutzt wird; das Backend misst selbst jede API-Anfrage
 * und jeden Hintergrund-Job. Ausgewertet wird im Nutzungs-Bericht (`GET /api/telemetry/report`, MCP `usage_report`).
 *
 * Gemessen wird ohne Inhalte: keine Nachrichtentexte, keine Namen von Leads, keine Eingaben in Textfelder – nur
 * welche Ansicht, welcher Knopf (`data-testid`), welches Tastaturkürzel, wie lange, welcher Fehler.
 */

/**
 * - `view`: Ansicht verlassen – `target` = Ansicht, `ms` = Verweildauer.
 * - `click`: Klick auf ein Element mit `data-testid` – `target` = testId.
 * - `hotkey`: Tastaturkürzel – `target` = Taste.
 * - `card`: Karte im Tagesstapel erledigt/verlassen – `target` = Kartentyp, `ms` = Zeit auf der Karte,
 *   `props.outcome` = letzter Klick bzw. letzte Taste auf der Karte.
 * - `error`: Fehler in der Oberfläche – `target` = Meldung (gekürzt).
 * - `api`: Anfrage ans Backend gescheitert oder langsam (> `TELEMETRY_SLOW_MS`) – `target` = Pfad ohne IDs,
 *   `ms` = Dauer, `props.status`.
 */
export const TELEMETRY_EVENT_NAMES = ['view', 'click', 'hotkey', 'card', 'error', 'api'] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export interface TelemetryEvent {
  name: TelemetryEventName;
  /** Zeitpunkt im Browser (ms). */
  at: number;
  /** Ansicht, in der es passierte (`home`, `focus`, `leads` …). */
  view: string | null;
  target: string | null;
  ms?: number | null;
  /** Kleine Zusatzangaben, nur Zahlen/kurze Texte. */
  props?: Record<string, string | number | boolean | null>;
}

/** `POST /api/telemetry/events` (angemeldet) → 204. Zu viele oder kaputte Ereignisse werden still verworfen. */
export interface TelemetryBatch {
  /** Zufällige Kennung je Browser-Tab (Sitzungen zählen). */
  sessionId: string;
  events: TelemetryEvent[];
  client?: { width: number; height: number; standalone: boolean; touch: boolean };
}

export const TELEMETRY_MAX_EVENTS = 200;
/** Ab so vielen Millisekunden gilt eine Anfrage als langsam. */
export const TELEMETRY_SLOW_MS = 1500;
/** So lange bleiben Nutzungsdaten gespeichert. */
export const TELEMETRY_KEEP_DAYS = 90;
/** `GET /api/telemetry/report?days=` – Markdown wie der Optimierungs-Bericht. */
export const USAGE_REPORT_DAYS_DEFAULT = 14;
export const USAGE_REPORT_DAYS_MAX = 90;

/** Pfad ohne IDs („/api/leads/3f2a…/events“ → „/api/leads/:id/events“), damit sich Anfragen zählen lassen. */
export function telemetryPath(url: string): string {
  const path = url.split('?')[0];
  return path
    .split('/')
    .map((part) => (/^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9]+$|^[A-Za-z0-9_-]{20,}$/i.test(part) ? ':id' : part))
    .join('/');
}
