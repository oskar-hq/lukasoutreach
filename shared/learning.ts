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
}

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
}
