/**
 * Lernen aus Lead-Qualität (Wunsch des Nutzers 13.10.: „Feedback zur Leadqualität, das automatisch berücksichtigt wird,
 * mit möglichst wenig menschlicher Arbeit“).
 *
 * Zwei Quellen, gemeinsam für beide Gründer:
 *   - **Ergebnisse (automatisch, `outcome`):** Lead hat interessiert geantwortet bzw. eine Frage gestellt, Termin
 *     vereinbart oder ist ans CRM übergeben → „passt“. Ohne Klick.
 *   - **Von Hand (`manual`):** 👍/👎 am Lead (`UpdateLeadRequest.feedback`), „Qualifizieren“ in der Ergebnisliste der Suche
 *     zählt als 👍. Von Hand geht vor Ergebnis.
 *
 * Wirkung:
 *   1. KI-Bewertung und Vorprüfung bekommen die jüngsten Rückmeldungen als Beispiele mit (ausgewogen passt/passt nicht,
 *      ohne Namen) – ab dem nächsten Lauf, ohne Training.
 *   2. Die Suche gewichtet ihre Anfragen (Stichwort × Position × Region) nach echten Ergebnissen: Anfragen, deren Leads
 *      antworten oder 👍 bekommen, kommen öfter dran, 👎 drückt sie nach hinten.
 *
 * Gespeichert wird je LinkedIn-Profil (Provider-ID) nur, was die KI zum Vergleich braucht: Headline, Position, Firma,
 * Branche, Kategorie, Urteil und Grund – kein Name. Löscht die Aufbewahrung einen verlorenen Lead, bleibt das Beispiel.
 */

export type LeadFeedbackVerdict = 'good' | 'bad';
export type LeadFeedbackSource = 'manual' | 'outcome';

/** Gründe für 👎 – kurze Auswahl, damit ein Klick reicht. */
export const LEAD_FEEDBACK_REASONS = ['makler', 'finanzberater', 'kein_entscheider', 'zu_klein', 'falsche_branche', 'sonstiges'] as const;
export type LeadFeedbackReason = (typeof LEAD_FEEDBACK_REASONS)[number];

export const LEAD_FEEDBACK_REASON_LABELS: Record<LeadFeedbackReason, string> = {
  makler: 'Makler',
  finanzberater: 'Finanz-/Versicherungsberater',
  kein_entscheider: 'Kein Entscheider',
  zu_klein: 'Zu klein',
  falsche_branche: 'Falsche Branche',
  sonstiges: 'Sonstiges',
};

/** Rückmeldung zu einem Lead (`CockpitLead.feedback`). */
export interface LeadFeedback {
  verdict: LeadFeedbackVerdict;
  source: LeadFeedbackSource;
  /** Nur bei `bad` (optional). */
  reason: LeadFeedbackReason | null;
  /** Kurzer Freitext (optional, höchstens `LEAD_FEEDBACK_NOTE_MAX` Zeichen). */
  note: string | null;
  at: number;
  /** Bei `outcome`: was das Ergebnis war, z. B. „Termin vereinbart“. */
  outcome?: string | null;
}

export const LEAD_FEEDBACK_NOTE_MAX = 200;

/** `UpdateLeadRequest.feedback`: 👍/👎 setzen; null nimmt die eigene Rückmeldung zurück. */
export interface LeadFeedbackInput {
  verdict: LeadFeedbackVerdict;
  reason?: LeadFeedbackReason | null;
  note?: string | null;
}

/** So viele Beispiele bekommt die KI höchstens mit (je Hälfte passt / passt nicht, wenn vorhanden). */
export const LEARNING_EXAMPLES_MAX = 24;

/** Woche „JJJJ-MM-TT“ (Montag) mit bewerteten Leads und davon „passt“. */
export interface LearningWeek {
  week: string;
  rated: number;
  good: number;
}

/** Suchanfrage mit ihrem Ertrag (`GET /api/learning`). */
export interface LearningQuery {
  label: string;
  qualified: number;
  /** Leads dieser Anfrage mit „passt“ (Ergebnis oder 👍). */
  good: number;
  /** Leads dieser Anfrage mit 👎. */
  bad: number;
  /** Zuletzt gesucht (ms). Fehlt bei älteren Backends. */
  lastSearchedAt?: number | null;
  /**
   * Seit `LEARNING_QUERY_STALE_DAYS` Tagen nicht mehr gesucht – z. B. weil die Zielgruppe gewechselt hat (27.10.:
   * Bauträger raus). Der Ertrag ist alt; die Oberfläche zeigt das an. Fehlt bei älteren Backends.
   */
  stale?: boolean;
}

/** Ab so vielen Tagen ohne Suche gilt eine Anfrage als „nicht mehr gesucht“ (`LearningQuery.stale`). */
export const LEARNING_QUERY_STALE_DAYS = 14;

/** Unter so vielen bewerteten Leads in einer Woche zeigt die Oberfläche keine Trefferquote („zu wenig Daten“). */
export const LEARNING_WEEK_MIN_RATED = 5;

/**
 * Wie sparsam die Suche mit LinkedIn umgeht (Wunsch des Nutzers 09.11.): Profilabrufe aller Accounts in den letzten
 * `days` Tagen gegen die in dieser Zeit qualifizierten Leads aus der Lead-Suche. Weniger ist besser – jeder Abruf
 * zählt gegen das Tageslimit der Accounts.
 */
export interface LearningEfficiency {
  days: number;
  profileFetches: number;
  qualified: number;
  /** profileFetches ÷ qualified, null ohne qualifizierten Lead. */
  perQualified: number | null;
}

/**
 * Optimierungs-Bericht (Wunsch des Nutzers 09.11.): `GET /api/learning/report?days=30` liefert eine Markdown-Datei
 * (`text/markdown`, Download) mit allen Rohzahlen zu KI-Kosten, Modellen, Modellvergleich, Suchanfragen,
 * LinkedIn-Abrufen, Entscheidungen je Treffer und Rückmeldungen – zum Einfügen in einen Chat mit Claude. Ohne Namen
 * und Profil-Links.
 */
export const LEARNING_REPORT_DAYS_DEFAULT = 30;
export const LEARNING_REPORT_DAYS_MAX = 180;

/** `GET /api/learning` – was der Scraper bisher gelernt hat. */
export interface LearningSummary {
  /** Gespeicherte Rückmeldungen insgesamt. */
  feedback: { good: number; bad: number; manual: number; outcome: number };
  /** So viele Beispiele gehen gerade an die KI. */
  examplesInUse: number;
  /** Trefferquote der letzten Wochen (älteste zuerst, höchstens 8): Anteil „passt“ an allen bewerteten Leads. */
  weeks: LearningWeek[];
  /** Beste Suchanfragen nach Ertrag (höchstens 5). */
  topQueries: LearningQuery[];
  /** Schwächste Suchanfragen – viel 👎 (höchstens 3). */
  weakQueries: LearningQuery[];
  /** Häufigste 👎-Gründe, meiste zuerst. */
  badReasons: Array<{ reason: LeadFeedbackReason; count: number }>;
  /**
   * Hinweise in einem Satz, z. B. „3 × 👎 ‚Finanzberater‘ bei Leads, die über ‚Ohne KI qualifizieren‘ kamen – Stichwort
   * ‚Vermögensaufbau‘ prüfen“. Die Software ändert dabei nichts selbst.
   */
  hints: string[];
  /** Profilabrufe je qualifiziertem Lead. Fehlt bei älteren Backends. */
  efficiency?: LearningEfficiency;
}
