/**
 * Vertrag für das Dashboard aus echten Zahlen (Roadmap Phase 6) – wird von Frontend (Vite) und Backend (Node)
 * importiert. Nur Typen, Konstanten und `import type` aus anderen Vertragsdateien.
 *
 * Das Backend zählt die Ereignisse im Verlauf der Leads (`shared/leads.ts`) – egal ob von Hand protokolliert oder
 * echt über LinkedIn gesendet. Zuordnung zum Gründer: der heutige Zuständige des Leads. Tage in der Zeitzone
 * `timeZone` (Standard Europe/Berlin, wie LINKEDIN_TIMEZONE). Simulation: dieselbe Rechnung über die 30 Demo-Leads
 * (die Zahlen sind deshalb klein – Verläufe der letzten Wochen, keine 16 Wochen Historie).
 *
 * Route (mit Sitzung):
 *   GET /api/dashboard?days=112   → 200 DashboardResponse
 *     days: Anzahl Tage bis einschließlich heute (7–366, Standard 112 = 8 sichtbare Wochen + 8 zum Vergleich).
 *
 * Zählregeln je Tag (`DashboardDay`):
 *   requests  – Vernetzungsanfragen gesendet (`invite_sent`)
 *   accepted  – Anfragen angenommen (`invite_accepted`)
 *   messaged  – Leads mit Erstnachricht an diesem Tag (erste `message_sent` je Lead; Follow-ups zählen nicht)
 *   replies   – Leads mit erster Antwort an diesem Tag. Als Antwort zählt (seit 20.10., Wunsch des Nutzers: „alles ab
 *               Antwort im Board“): eingegangene Nachricht, Termin, Übergabe, von Hand nach Antwort/Termin/Übergeben
 *               oder in eine eigene Board-Spalte verschoben. Leads, die dort liegen, ohne passendes Ereignis (frühere
 *               Verschiebungen), zählen rückwirkend am Tag ihrer letzten Aktivität. Je Lead höchstens einmal.
 *   meetings  – Termine vereinbart (`meeting_booked`)
 *   handovers – an das CRM übergeben (`handed_over`; im Frontend bisher „Exporte nach Close“)
 * Quoten rechnet das Frontend selbst (Annahme = accepted/requests, Antwort = replies/messaged), damit Woche,
 * Zeitraum und Gründer frei wählbar bleiben.
 */
import type { AuthFounderId } from './auth.js';
import type { LeadStage } from './leads.js';

export const DASHBOARD_DAYS_DEFAULT = 112;
export const DASHBOARD_DAYS_MAX = 366;

export interface DashboardDay {
  /** YYYY-MM-DD in `timeZone`. */
  date: string;
  requests: number;
  accepted: number;
  messaged: number;
  replies: number;
  meetings: number;
  handovers: number;
}

/** Antwortquote einer Vorlage der Erstnachricht (A/B/C). Basis: Leads mit Erstnachricht im Zeitraum. */
export interface TemplateStat {
  template: string;
  /** Leads, deren Erstnachricht mit dieser Vorlage im Zeitraum gesendet wurde. */
  messaged: number;
  /** Davon haben geantwortet (irgendwann danach, auch nach Follow-ups). */
  replied: number;
}

/**
 * Antwort je Stufe: Stufe 0 = nach der Erstnachricht, 1 = nach Follow-up 1 usw. `reached` = Leads, die diese Stufe
 * erreicht haben (Nachricht gesendet), `replied` = davon antworteten, bevor die nächste Stufe gesendet wurde.
 */
export interface FollowUpStat {
  stage: number;
  reached: number;
  replied: number;
}

export interface DashboardResponse {
  /** Erster und letzter Tag (YYYY-MM-DD), letzter = heute. */
  from: string;
  to: string;
  timeZone: string;
  generatedAt: number;
  /** Je Gründer alle Tage von `from` bis `to`, älteste zuerst, lückenlos (auch Tage mit 0). „Gesamt“ = Summe. */
  days: Record<AuthFounderId, DashboardDay[]>;
  templates: Record<AuthFounderId, TemplateStat[]>;
  followUps: Record<AuthFounderId, FollowUpStat[]>;
  /** Aktueller Stand der Pipeline: Leads je Stufe (unabhängig vom Zeitraum). */
  pipeline: Record<AuthFounderId, Record<LeadStage, number>>;
  /**
   * Summe der eingetragenen Deal Values (`CockpitLead.dealValue`, Euro) je Stufe – aktueller Stand. „Offen“ = alles außer
   * `lost`. Fehlt bei älteren Backends.
   */
  dealValue?: Record<AuthFounderId, Record<LeadStage, number>>;
  /**
   * Ausgaben für die Claude-API (Wunsch des Nutzers 11.10.: gegen den offenen Deal Value aufwiegen). Für beide Gründer
   * zusammen (ein API-Schlüssel). Fehlt bei älteren Backends.
   */
  aiCost?: AiCostSummary;
}

/** Wofür die KI aufgerufen wurde. */
export const AI_PURPOSES = ['prescreen', 'qualify', 'suggest', 'conversation', 'assistant'] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];
export const AI_PURPOSE_LABELS: Record<AiPurpose, string> = {
  prescreen: 'Vorprüfung der Suchtreffer',
  qualify: 'Einstufung der Profile',
  suggest: 'Textvorschläge',
  conversation: 'Antworten auswerten',
  assistant: 'KI-Assistent',
};

/**
 * KI-Kosten in Euro. Das Backend zählt bei jedem Aufruf die Token laut Antwort der Anthropic-API (`usage`) und rechnet
 * mit den Listenpreisen des Modells; Dollar → Euro mit `usdToEur`. Eine Schätzung – maßgeblich ist die Rechnung in der
 * Anthropic-Konsole.
 */
export interface AiCostSummary {
  /** Seit Beginn der Aufzeichnung (`since`). */
  totalEur: number;
  /** Im Zeitraum `from`–`to` der Antwort. */
  periodEur: number;
  /** Laufender Kalendermonat (Zeitzone des Dashboards). */
  monthEur: number;
  /** Seit Beginn der Aufzeichnung je Zweck. */
  byPurpose: Record<AiPurpose, number>;
  /** Anzahl KI-Aufrufe seit Beginn. */
  calls: number;
  /** Qualifizierte Leads aus der Lead-Suche seit Beginn der Aufzeichnung (im Cockpit angelegt) – für „Kosten je Lead“. */
  leads: number;
  /**
   * Davon abgeschlossen: heute in der Stufe „Übergeben“ (`handed_over`). Fehlt bei älteren Backends.
   */
  closedLeads?: number;
  /** Durchschnitt: alle KI-Kosten ÷ qualifizierte Leads (null ohne Lead). Live bei jedem Abruf berechnet. */
  perQualifiedEur?: number | null;
  /** Durchschnitt: alle KI-Kosten ÷ abgeschlossene Leads (null ohne Abschluss). */
  perClosedEur?: number | null;
  /** Erster aufgezeichneter Aufruf (ms) – null = noch keiner. */
  since: number | null;
  /** Verwendeter Kurs Dollar → Euro. */
  usdToEur: number;
}
