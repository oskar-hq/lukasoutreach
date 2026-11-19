/**
 * Leads aus einer fertigen Liste anlegen (Lukas-Instanz, Wunsch des Kunden 19.11.): Das Cockpit ist hier Sendemaschine,
 * nicht Lead-Suche. Je LinkedIn-Link ein Profilabruf über den Account des Besitzers (`notify=false`), danach steht der
 * Lead ohne KI-Vorprüfung und ohne Meta-Check im Cockpit – Stufe aus dem Kontaktgrad: nicht vernetzt → `new`,
 * offene Anfrage → `invited`, schon vernetzt → `connected` (wie „Kontakt per Link“, `AddContactRequest`).
 * Mehrere Personen derselben Firma sind erlaubt – nur dieselbe Person nicht doppelt.
 *
 *   POST /api/leads/add            LeadAddRequest → 201 LeadAddResponse (angelegt) · 200 (Dublette) ·
 *                                  400 invalid_request · 403 not_allowed · 429 linkedin_limit (Tageslimit der
 *                                  Profilabrufe voll – dann import nutzen, die Warteschlange wartet) · 409/503
 *                                  `LinkedInErrorCode`. Sofort, genau ein Profilabruf.
 *   POST /api/leads/import         LeadImportRequest → 202 LeadImportResponse. Bis 100 Links, nichts wird sofort
 *                                  abgerufen: Die Warteschlange arbeitet im Hintergrund mit 3–8 s Pause und hält das
 *                                  Tageslimit für Profilabrufe des Accounts ein (Einstellungen → LinkedIn → Grenzen,
 *                                  höchstens 100). Ist es voll, geht es am nächsten Tag weiter.
 *   GET  /api/leads/import/status  → LeadImportStatusResponse (`?owner=` optional, `?limit=` letzte Einträge).
 */
import type { AuthFounderId } from './auth.js';

/** Höchstens so viele Links je `POST /api/leads/import`. */
export const LEAD_IMPORT_MAX_ITEMS = 100;
/** Freie Felder je Lead: Name höchstens 40 Zeichen (a–z, 0–9, _), Wert höchstens 500 Zeichen, höchstens 20 Felder. */
export const LEAD_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const LEAD_FIELD_VALUE_MAX_LENGTH = 500;
export const LEAD_FIELDS_MAX = 20;
/** Unter diesem Feld steht die Kategorie aus `LeadImportItem.category` (bis Kategorien je Instanz einstellbar sind). */
export const LEAD_CATEGORY_FIELD = 'kategorie';

export interface LeadImportItem {
  /** LinkedIn-Profil-Link (`https://www.linkedin.com/in/…`) oder die Kennung aus dem Link. */
  profile: string;
  /** Wem der Lead gehört; ohne Angabe der Gründer des Kontos. Abgerufen wird über dessen LinkedIn-Account. */
  owner?: AuthFounderId;
  /** Freie Kategorie, z. B. „startup_gruender“ – landet im freien Feld `kategorie`. */
  category?: string;
  /** Notiz in den Verlauf des Leads. */
  note?: string;
  /** Freie Felder, z. B. { welle: "1", testgruppe: "B", aufhaenger: "…" } – stehen in `lead_detail` (MCP). */
  fields?: Record<string, string>;
}

export type LeadAddRequest = LeadImportItem;

export interface LeadAddResponse {
  /** created = neu angelegt · duplicate = gab es schon (unverändert). */
  status: 'created' | 'duplicate';
  leadId: string;
  /** Fertiger Satz, z. B. „Anna Berg ist jetzt unter Neu.“ */
  message: string;
}

export interface LeadImportRequest {
  items: LeadImportItem[];
}

/** Ergebnis je Link beim Einreihen. */
export interface LeadImportItemResult {
  profile: string;
  /** queued = in der Warteschlange · duplicate = Lead gibt es schon bzw. steht schon in der Warteschlange · invalid = kein Profil-Link. */
  status: 'queued' | 'duplicate' | 'invalid';
  /** Bei `duplicate` mit vorhandenem Lead. */
  leadId?: string;
  message: string;
}

export interface LeadImportResponse {
  results: LeadImportItemResult[];
  queued: number;
  duplicates: number;
  invalid: number;
  /** Wie viele insgesamt noch warten (alle Importe dieses Besitzers). */
  waiting: number;
  /** Fertiger Satz zur Lage, z. B. „Heute noch 37 Profilabrufe frei – Rest ab morgen.“ */
  message: string;
}

export type LeadImportEntryStatus = 'queued' | 'created' | 'duplicate' | 'failed';

export interface LeadImportEntry {
  profile: string;
  owner: AuthFounderId;
  status: LeadImportEntryStatus;
  leadId: string | null;
  /** Fehlergrund bzw. Ergebnis in einem Satz. */
  message: string | null;
  queuedAt: number;
  processedAt: number | null;
}

export interface LeadImportStatusResponse {
  counts: Record<LeadImportEntryStatus, number>;
  /** Profilabrufe heute je Besitzer (Zähler des LinkedIn-Accounts, alle Zwecke zusammen). */
  profilesToday: Partial<Record<AuthFounderId, { used: number; limit: number }>>;
  /** Warteschlange ruht (Tageslimit, Zugangsfehler) bis zu diesem Zeitpunkt; null = arbeitet bzw. nichts zu tun. */
  restingUntil: number | null;
  restingReason: string | null;
  /** Letzte Einträge, neueste zuerst. */
  recent: LeadImportEntry[];
  message: string;
}
