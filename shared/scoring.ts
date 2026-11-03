/**
 * Vertrag für den Lead-Score (Scoring v1) – wird von Frontend (Vite) und Backend (Node) importiert.
 * Konzept und Begründungen: `server/docs/SCORING.md`.
 *
 * v1 ist regelbasiert und erklärbar: Jeder Wert kommt mit seinen Einzelteilen und einem Satz, warum.
 * Die Zahlen sind **Scores (0–1), keine Wahrscheinlichkeiten** – kalibriert wird erst mit echten Ergebnissen
 * (Erfolg = positive Antwort mit Terminwunsch). In der Oberfläche daher als Stufe bzw. „Score“ zeigen, nicht als „%“.
 *
 * Fehlende Angaben (z. B. Firmengröße) zählen nicht als schlecht: Der Teil fällt aus der Gewichtung heraus, und
 * `completeness` sinkt. So sieht man, wie belastbar ein Score ist.
 */

export const SCORE_VERSION = 'v1';

export type ScoreTier = 'high' | 'medium' | 'low';

export const SCORE_TIER_LABELS: Record<ScoreTier, string> = { high: 'Hoch', medium: 'Mittel', low: 'Niedrig' };

/** Grenzen der Stufen (Score ≥ Grenze). */
export const SCORE_TIER_THRESHOLDS = { high: 0.75, medium: 0.55 } as const;

export function scoreTier(value: number): ScoreTier {
  if (value >= SCORE_TIER_THRESHOLDS.high) return 'high';
  if (value >= SCORE_TIER_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/** Ein Teil des ICP-Scores, z. B. „Branche“ mit Gewicht 0,35 und Wert 1,0. */
export interface ScoreComponent {
  key: 'industry' | 'decision_maker' | 'company_size' | 'region' | 'presence';
  label: string;
  /** Gewicht laut Konzept (alle Gewichte zusammen 1). */
  weight: number;
  /** 0–1; null = unbekannt (zählt nicht mit). */
  value: number | null;
  /** Ein Satz: woher der Wert kommt. */
  detail: string;
}

/** Hard-Filter: alles muss erfüllt sein. null = konnte nicht geprüft werden (→ Review statt Aussortieren). */
export interface HardFilterCheck {
  key: 'industry' | 'region' | 'decision_maker' | 'active';
  label: string;
  passed: boolean | null;
  detail: string;
}

/**
 * Meta-Werbung: Status, wie sicher wir sind, und wie groß die Chance für uns ist.
 * active = schaltet gerade · historical = früher geschaltet, jetzt nicht · none_found = keine eigenen Anzeigen
 * gefunden (heißt nicht sicher „nie“) · unknown = nicht geprüft.
 */
export type AdStatus = 'active' | 'historical' | 'none_found' | 'unknown';

export const AD_STATUS_LABELS: Record<AdStatus, string> = {
  active: 'Schaltet gerade Meta-Ads',
  historical: 'Früher Meta-Ads, jetzt nicht',
  none_found: 'Keine Meta-Ads gefunden',
  unknown: 'Nicht geprüft',
};

export interface AdEvidence {
  status: AdStatus;
  /** 0–1: wie sicher der Status ist (eindeutig zugeordnete Seite, Website-Domain im Abgleich …). */
  confidence: number;
  /** 0–1: wie groß die Chance ist, dass die Firma Paid Social von uns braucht – je Lead-Typ. */
  opportunity: number;
  /** Ein Satz Begründung. */
  detail: string;
}

/**
 * Lead-Typ: greenfield = passt, keine erkennbare Meta-Werbung · reactivation = passt, früher Meta-Ads, jetzt nicht ·
 * active = schaltet gerade (seit 07.10. nicht mehr aussortiert, sondern markiert: Kampagnen von Hand prüfen) · unclear = Datenlage zu dünn → Deep Scan.
 */
export type LeadType = 'greenfield' | 'reactivation' | 'active' | 'unclear';

export const LEAD_TYPE_LABELS: Record<LeadType, string> = {
  greenfield: 'Greenfield',
  reactivation: 'Reactivation',
  active: 'Aktiv',
  unclear: 'Unklar',
};

export interface LeadScore {
  version: typeof SCORE_VERSION;
  /** Gesamt-Score 0–1 = 0,7 · ICP + 0,3 · Opportunity. */
  total: number;
  tier: ScoreTier;
  icp: { score: number; tier: ScoreTier; components: ScoreComponent[] };
  hardFilters: HardFilterCheck[];
  ads: AdEvidence;
  leadType: LeadType;
  /** 0–1: Anteil der Gewichte, für die Daten vorlagen. */
  completeness: number;
  /** Zeitpunkt der Berechnung (ms). */
  scoredAt: number;
}
