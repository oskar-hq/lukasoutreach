import type { Database } from '../db/database.js';

/**
 * Modellvergleich (Wunsch des Nutzers 09.11.: „wo brauchen wir wirklich ein teures Modell?“): Ein Teil der
 * Vorprüfungen und Einstufungen geht zusätzlich an ein zweites Modell (`AI_SHADOW_PERCENT`). Sein Urteil zählt nie –
 * gespeichert wird nur der Vergleich, den der Optimierungs-Bericht auswertet (Übereinstimmung je Modellpaar).
 * Gespeichert wird je Profil nur die Headline, kein Name. Einträge älter als `SHADOW_KEEP_DAYS` fliegen raus.
 */
export const SHADOW_KEEP_DAYS = 120;

export interface ShadowEntry {
  purpose: 'prescreen' | 'qualify';
  providerId: string;
  runId: string | null;
  headline: string | null;
  mainModel: string;
  /** Vorprüfung: `likely`/`maybe`/`no`; Einstufung: `ja`/`nein` (qualifiziert nach Kategorie + Urteil der KI). */
  mainVerdict: string;
  mainCategory: string | null;
  mainConfidence: number | null;
  shadowModel: string;
  shadowVerdict: string;
  shadowCategory: string | null;
  shadowConfidence: number | null;
}

type Sink = (entry: ShadowEntry) => void;
let sink: Sink | null = null;

export function setShadowSink(next: Sink | null): void {
  sink = next;
}

/** Wirft nie – der Vergleich ist Beiwerk. */
export function recordShadow(entry: ShadowEntry): void {
  if (!sink) return;
  try {
    sink(entry);
  } catch {
    // ignorieren
  }
}

/** Würfelt, ob dieser Aufruf zusätzlich verglichen wird. */
export function shouldShadow(percent: number, random: () => number = Math.random): boolean {
  return percent > 0 && random() * 100 < percent;
}

export class ShadowStore {
  constructor(private readonly db: Database) {}

  record(entry: ShadowEntry, at: number): void {
    this.db
      .prepare(
        `INSERT INTO ai_shadow (at, purpose, provider_id, run_id, headline, main_model, main_verdict, main_category, main_confidence,
           shadow_model, shadow_verdict, shadow_category, shadow_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        entry.purpose,
        entry.providerId,
        entry.runId,
        entry.headline,
        entry.mainModel,
        entry.mainVerdict,
        entry.mainCategory,
        entry.mainConfidence,
        entry.shadowModel,
        entry.shadowVerdict,
        entry.shadowCategory,
        entry.shadowConfidence,
      );
    this.db.prepare('DELETE FROM ai_shadow WHERE at < ?').run(at - SHADOW_KEEP_DAYS * 24 * 60 * 60 * 1000);
  }
}
