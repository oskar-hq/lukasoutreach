import { AI_PURPOSES, type AiCostSummary, type AiPurpose } from '../../../shared/dashboard.js';
import type { Database } from '../db/database.js';

/**
 * KI-Kosten (Wunsch des Nutzers 11.10.: Ausgaben für die Claude-API gegen den offenen Deal Value aufwiegen).
 * Jeder Aufruf meldet seine Token laut `usage` der Anthropic-Antwort; die Kosten rechnen wir mit den Listenpreisen
 * (Dollar je 1 Mio. Token, Stand Oktober 2026). Maßgeblich bleibt die Rechnung in der Anthropic-Konsole.
 */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

/** Listenpreise je Modellfamilie (Präfix des Modellnamens, längster Treffer gilt). */
const PRICES: Array<[prefix: string, price: Price]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-fable', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet', { input: 3, output: 15, cacheRead: 0.3 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ['claude-haiku', { input: 1, output: 5, cacheRead: 0.1 }],
];
/** Unbekanntes Modell: lieber zu hoch als zu niedrig schätzen. */
const FALLBACK_PRICE: Price = { input: 10, output: 50, cacheRead: 1 };

export function priceOf(model: string): Price {
  const name = model.trim().toLowerCase();
  let best: [string, Price] | null = null;
  for (const entry of PRICES) if (name.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  return best ? best[1] : FALLBACK_PRICE;
}

/** Token laut Anthropic-Antwort (`response.usage`); fehlende Felder zählen 0. */
export interface AiTokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Kosten in Dollar. Cache-Schreiben kostet das 1,25-Fache des Eingabepreises (5 Minuten). */
export function costUsd(model: string, usage: AiTokenUsage): number {
  const price = priceOf(model);
  const n = (value: number | null | undefined) => (Number.isFinite(value) ? Math.max(0, value as number) : 0);
  return (
    (n(usage.input_tokens) * price.input +
      n(usage.output_tokens) * price.output +
      n(usage.cache_read_input_tokens) * price.cacheRead +
      n(usage.cache_creation_input_tokens) * price.input * 1.25) /
    1_000_000
  );
}

type Sink = (purpose: AiPurpose, model: string, usage: AiTokenUsage, runId: string | null) => void;
let sink: Sink | null = null;

/** Der Server setzt beim Start, wohin Aufrufe gemeldet werden (Datenbank). Tests: eigener Sink oder null. */
export function setAiUsageSink(next: Sink | null): void {
  sink = next;
}

/** Nach jedem KI-Aufruf mit Antwort (auch abgelehnt/unbrauchbar – bezahlt ist er trotzdem). Wirft nie. */
export function recordAiUsage(purpose: AiPurpose, model: string, usage: AiTokenUsage | null | undefined, runId?: string | null): void {
  if (!usage || !sink) return;
  try {
    sink(purpose, model, usage, runId ?? null);
  } catch {
    // Zählen ist Beiwerk – ein Fehler hier darf keinen Lauf stören.
  }
}

export class AiUsageStore {
  constructor(private readonly db: Database) {}

  record(purpose: AiPurpose, model: string, usage: AiTokenUsage, at: number, runId: string | null = null): void {
    const n = (value: number | null | undefined) => (Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0);
    this.db
      .prepare(
        'INSERT INTO ai_usage (at, purpose, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        at,
        purpose,
        model,
        n(usage.input_tokens),
        n(usage.output_tokens),
        n(usage.cache_read_input_tokens),
        n(usage.cache_creation_input_tokens),
        costUsd(model, usage),
        runId,
      );
  }

  /** KI-Kosten eines Laufs der Lead-Suche in Dollar. */
  runCostUsd(runId: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM ai_usage WHERE run_id = ?').get(runId) as { usd: number }).usd;
  }

  reset(): void {
    this.db.exec('DELETE FROM ai_usage;');
  }

  isEmpty(): boolean {
    return !this.db.prepare('SELECT 1 FROM ai_usage LIMIT 1').get();
  }

  /**
   * Simulation: erfundene, gleichbleibende Aufrufe der letzten 21 Tage, damit das Dashboard beim Entwickeln etwas zeigt
   * (wie die Demo-Leads). Je Tag 3 Vorprüfungen, 15 Einstufungen, 2 Textvorschläge, 1 Auswertung mit Claude Opus 5.5.
   */
  seedDemo(now: number): void {
    const model = 'claude-opus-5-5';
    const day = 24 * 60 * 60 * 1000;
    const plan: Array<[AiPurpose, number, AiTokenUsage]> = [
      ['prescreen', 3, { input_tokens: 9_000, output_tokens: 1_800 }],
      ['qualify', 15, { input_tokens: 2_500, output_tokens: 400 }],
      ['suggest', 2, { input_tokens: 1_500, output_tokens: 300 }],
      ['conversation', 1, { input_tokens: 2_000, output_tokens: 250 }],
    ];
    for (let ago = 20; ago >= 0; ago--) {
      for (const [purpose, count, usage] of plan) {
        for (let k = 0; k < count; k++) this.record(purpose, model, usage, now - ago * day - (k + 1) * 60_000);
      }
    }
  }
}

/**
 * Zusammenfassung fürs Dashboard. `dayOf` = Tag („YYYY-MM-DD“) in der Zeitzone des Dashboards; Zeitraum `from`–`to`
 * und Monat von `to`.
 */
export function aiCostSummary(
  db: Database,
  options: { from: string; to: string; usdToEur: number; dayOf: (at: number) => string; liveOnly?: boolean },
): AiCostSummary {
  const rows = db.prepare('SELECT at, purpose, cost_usd FROM ai_usage ORDER BY at').all() as Array<{ at: number; purpose: string; cost_usd: number }>;
  const byPurpose = Object.fromEntries(AI_PURPOSES.map((purpose) => [purpose, 0])) as Record<AiPurpose, number>;
  let total = 0;
  let period = 0;
  let month = 0;
  const thisMonth = options.to.slice(0, 7);
  for (const row of rows) {
    const eur = row.cost_usd * options.usdToEur;
    total += eur;
    if ((AI_PURPOSES as readonly string[]).includes(row.purpose)) byPurpose[row.purpose as AiPurpose] += eur;
    const day = options.dayOf(row.at);
    if (day >= options.from && day <= options.to) period += eur;
    if (day.slice(0, 7) === thisMonth) month += eur;
  }
  const since = rows.length ? rows[0].at : null;
  // Qualifizierte Leads = aus der Lead-Suche angelegt seit Beginn der Aufzeichnung; abgeschlossen = davon „Übergeben“.
  // Simulation (`liveOnly: false`): auch die Demo-Leads, egal wann angelegt – damit die Durchschnitte etwas zeigen.
  const counts =
    since === null
      ? { leads: 0, closed: 0 }
      : options.liveOnly === false
        ? (db
            .prepare(
              `SELECT COUNT(*) AS leads, COALESCE(SUM(stage = 'handed_over'), 0) AS closed FROM leads
                WHERE json_extract(origin, '$.kind') IN ('search', 'demo')`,
            )
            .get() as { leads: number; closed: number })
        : (db
            .prepare(
              `SELECT COUNT(*) AS leads, COALESCE(SUM(stage = 'handed_over'), 0) AS closed FROM leads
                WHERE created_at >= ? AND json_extract(origin, '$.kind') = 'search' AND json_extract(origin, '$.mode') = 'live'`,
            )
            .get(since) as { leads: number; closed: number });
  const leads = counts.leads;
  const cents = (value: number) => Math.round(value * 100) / 100;
  return {
    totalEur: cents(total),
    periodEur: cents(period),
    monthEur: cents(month),
    byPurpose: Object.fromEntries(AI_PURPOSES.map((purpose) => [purpose, cents(byPurpose[purpose])])) as Record<AiPurpose, number>,
    calls: rows.length,
    leads,
    closedLeads: counts.closed,
    perQualifiedEur: leads > 0 ? cents(total / leads) : null,
    perClosedEur: counts.closed > 0 ? cents(total / counts.closed) : null,
    since,
    usdToEur: options.usdToEur,
  };
}
