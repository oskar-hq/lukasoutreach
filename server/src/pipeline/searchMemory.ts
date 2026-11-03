import type { PrescreenVerdict, SearchHit } from '../../../shared/leadSearch.js';
import type { Database } from '../db/database.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** So lange gilt ein geprüftes Profil als bekannt (wie `AUTO_SEARCH_CHECKED_DAYS`). */
export const SEARCH_CHECKED_DAYS = 90;
/** Nach so vielen Tagen fängt eine ausgeschöpfte Suchanfrage wieder vorne an – inzwischen gibt es neue Profile. */
export const SEARCH_QUERY_REFRESH_DAYS = 30;

/** Zurückgestellte Treffer: höchstens so viele, so lange. */
export const SEARCH_BACKLOG_MAX = 1000;
export const SEARCH_BACKLOG_DAYS = 14;
/** So lange bleibt gemerkt, welche Suchanfrage ein Profil fand (Ergebnisse kommen oft erst nach Wochen). */
export const SEARCH_SOURCE_DAYS = 90;

/** Ein Treffer auf der Warteliste – mit der Vorprüfung, falls schon gemacht (dann prüft der nächste Lauf nicht neu). */
export interface BacklogEntry {
  hit: SearchHit;
  source: string | null;
  prescreen?: PrescreenVerdict | null;
}

/** Stand einer Suchanfrage über alle Läufe hinweg. */
export interface SearchQueryState {
  key: string;
  label: string;
  /** Cursor der nächsten Seite (Unipile) – null = vorne anfangen. */
  cursor: string | null;
  /** Abgerufene Seiten seit dem letzten Neubeginn. */
  pages: number;
  /** Treffer insgesamt, davon noch nie geprüft (`fresh`). */
  hits: number;
  fresh: number;
  /** Laut KI-Vorprüfung „passt vermutlich“ bzw. am Ende qualifiziert. */
  likely: number;
  qualified: number;
  /**
   * Echte Ergebnisse der Leads dieser Anfrage (`shared/learning.ts`): „passt“ (Antwort, Termin, Übergabe oder 👍) bzw. 👎.
   * Fehlt in Tests mit eigenem Speicher.
   */
  good?: number;
  bad?: number;
  /** Ausgeschöpft (keine weitere Seite) – bis `SEARCH_QUERY_REFRESH_DAYS` übersprungen. */
  exhaustedAt: number | null;
}

/** Was der Adapter für eine Suchanfrage braucht (Tests: im Speicher). */
export interface SearchQueryMemory {
  query(key: string, now: number): SearchQueryState | null;
  /** Nach jeder Seite: Cursor, Tiefe, Treffer; `exhausted` = keine weitere Seite. */
  savePage(key: string, label: string, page: { cursor: string | null; hits: number; fresh: number; exhausted: boolean }, now: number): void;
  /** Cursor ungültig (z. B. abgelaufen) → vorne anfangen, Ertrag bleibt. */
  restart(key: string, now: number): void;
}

interface QueryRow {
  key: string;
  label: string;
  cursor: string | null;
  pages: number;
  hits: number;
  fresh: number;
  likely: number;
  qualified: number;
  good: number;
  bad: number;
  exhausted_at: number | null;
}

/**
 * Suchgedächtnis (Wunsch des Nutzers 11.10.: „findet jedes Mal dieselben Kunden“, Migration 28):
 *  - je Suchanfrage Cursor und Tiefe – der nächste Lauf blättert dort weiter, wo der letzte aufgehört hat;
 *  - je Suchanfrage der Ertrag (neue Treffer, „passt vermutlich“, qualifiziert) – ergiebige Anfragen kommen zuerst;
 *  - alle geprüften Profile aller Läufe (auch von Hand) – sie zählen nicht mehr zur Trefferzahl.
 */
export class SearchMemory implements SearchQueryMemory {
  constructor(private readonly db: Database) {}

  query(key: string, now: number): SearchQueryState | null {
    const row = this.db.prepare('SELECT * FROM search_queries WHERE key = ?').get(key) as QueryRow | undefined;
    if (!row) return null;
    // Ausgeschöpft und lange her → wieder vorne anfangen (neue Mitglieder, geänderte Profile).
    if (row.exhausted_at !== null && now - row.exhausted_at > SEARCH_QUERY_REFRESH_DAYS * DAY_MS) {
      this.db.prepare('UPDATE search_queries SET cursor = NULL, pages = 0, exhausted_at = NULL, updated_at = ? WHERE key = ?').run(now, key);
      return { ...toState(row), cursor: null, pages: 0, exhaustedAt: null };
    }
    return toState(row);
  }

  savePage(key: string, label: string, page: { cursor: string | null; hits: number; fresh: number; exhausted: boolean }, now: number): void {
    this.db
      .prepare(
        `INSERT INTO search_queries (key, label, cursor, pages, hits, fresh, exhausted_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET label = excluded.label, cursor = excluded.cursor, pages = pages + 1,
           hits = hits + excluded.hits, fresh = fresh + excluded.fresh, exhausted_at = excluded.exhausted_at,
           updated_at = excluded.updated_at`,
      )
      .run(key, label, page.exhausted ? null : page.cursor, page.hits, page.fresh, page.exhausted ? now : null, now);
  }

  restart(key: string, now: number): void {
    this.db.prepare('UPDATE search_queries SET cursor = NULL, pages = 0, exhausted_at = NULL, updated_at = ? WHERE key = ?').run(now, key);
  }

  /** Nach dem Lauf: Ertrag je Suchanfrage nachtragen (Vorprüfung „likely“, qualifiziert). */
  addYield(stats: ReadonlyMap<string, { likely: number; qualified: number }>, now: number): void {
    const update = this.db.prepare('UPDATE search_queries SET likely = likely + ?, qualified = qualified + ?, updated_at = ? WHERE key = ?');
    for (const [key, { likely, qualified }] of stats) if (likely || qualified) update.run(likely, qualified, now, key);
  }

  /** Provider-IDs, die ein Lauf in den letzten `SEARCH_CHECKED_DAYS` Tagen geprüft hat. */
  checked(now: number): string[] {
    this.db.prepare('DELETE FROM search_checked WHERE checked_at < ?').run(now - SEARCH_CHECKED_DAYS * DAY_MS);
    return (this.db.prepare('SELECT provider_id FROM search_checked ORDER BY checked_at').all() as Array<{ provider_id: string }>).map(
      (row) => row.provider_id,
    );
  }

  addChecked(providerIds: readonly string[], now: number): void {
    if (!providerIds.length) return;
    const insert = this.db.prepare(
      'INSERT INTO search_checked (provider_id, checked_at) VALUES (?, ?) ON CONFLICT (provider_id) DO UPDATE SET checked_at = excluded.checked_at',
    );
    for (const id of providerIds) insert.run(id, now);
  }

  /**
   * Zurückgestellte Treffer (älteste zuerst): Der nächste Lauf bekommt sie vor der Suche – sonst blätterte die Suche
   * an ihnen vorbei, und „beim nächsten Lauf dran“ stimmte nicht mehr.
   */
  backlog(now: number): BacklogEntry[] {
    this.db.prepare('DELETE FROM search_backlog WHERE added_at < ?').run(now - SEARCH_BACKLOG_DAYS * DAY_MS);
    const rows = this.db.prepare('SELECT hit, source, prescreen FROM search_backlog ORDER BY added_at, rowid LIMIT ?').all(SEARCH_BACKLOG_MAX) as Array<{
      hit: string;
      source: string | null;
      prescreen: string | null;
    }>;
    const entries: BacklogEntry[] = [];
    for (const row of rows) {
      try {
        entries.push({ hit: JSON.parse(row.hit) as SearchHit, source: row.source, prescreen: row.prescreen ? (JSON.parse(row.prescreen) as PrescreenVerdict) : null });
      } catch {
        // Kaputter Eintrag – überspringen.
      }
    }
    return entries;
  }

  /** Für den Startdialog: so viele Treffer warten auf den nächsten Lauf (ohne abgelaufene). */
  backlogSize(now: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM search_backlog WHERE added_at >= ?').get(now - SEARCH_BACKLOG_DAYS * DAY_MS) as { n: number };
    return Math.min(SEARCH_BACKLOG_MAX, Number(row.n));
  }

  /** Nach dem Lauf: Erledigtes aus der Warteliste nehmen, neu Zurückgestelltes hinten anhängen. */
  updateBacklog(done: readonly string[], deferred: readonly BacklogEntry[], now: number): void {
    const remove = this.db.prepare('DELETE FROM search_backlog WHERE provider_id = ?');
    for (const id of done) remove.run(id);
    const insert = this.db.prepare(
      // Schon auf der Warteliste: Platz behalten, nur die Vorprüfung nachtragen.
      'INSERT INTO search_backlog (provider_id, hit, source, added_at, prescreen) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT (provider_id) DO UPDATE SET prescreen = COALESCE(excluded.prescreen, search_backlog.prescreen)',
    );
    for (const { hit, source, prescreen } of deferred) insert.run(hit.providerId, JSON.stringify(hit), source, now, prescreen ? JSON.stringify(prescreen) : null);
    // Obergrenze: die ältesten fallen raus.
    this.db
      .prepare('DELETE FROM search_backlog WHERE provider_id NOT IN (SELECT provider_id FROM search_backlog ORDER BY added_at DESC, rowid DESC LIMIT ?)')
      .run(SEARCH_BACKLOG_MAX);
  }

  /**
   * Welche Suchanfrage welches Profil gefunden hat (für Ergebnisse, die erst Tage später kommen – `learning/`). Je Profil
   * die erste Anfrage; Einträge älter als `SEARCH_SOURCE_DAYS` fallen weg.
   */
  addSources(sources: ReadonlyMap<string, string>, now: number): void {
    this.db.prepare('DELETE FROM search_lead_source WHERE at < ?').run(now - SEARCH_SOURCE_DAYS * DAY_MS);
    const insert = this.db.prepare('INSERT OR IGNORE INTO search_lead_source (provider_id, query_key, at) VALUES (?, ?, ?)');
    for (const [providerId, key] of sources) insert.run(providerId, key, now);
  }

  /** Für die Übersicht/das Log: Anfragen nach Ertrag. */
  queries(): SearchQueryState[] {
    return (this.db.prepare('SELECT * FROM search_queries ORDER BY qualified DESC, likely DESC, updated_at DESC').all() as unknown as QueryRow[]).map(toState);
  }

  reset(): void {
    this.db.exec('DELETE FROM search_queries; DELETE FROM search_checked; DELETE FROM search_backlog; DELETE FROM search_lead_source;');
  }
}

function toState(row: QueryRow): SearchQueryState {
  return {
    key: row.key,
    label: row.label,
    cursor: row.cursor,
    pages: row.pages,
    hits: row.hits,
    fresh: row.fresh,
    likely: row.likely,
    qualified: row.qualified,
    good: row.good ?? 0,
    bad: row.bad ?? 0,
    exhaustedAt: row.exhausted_at,
  };
}

/**
 * Wie vielversprechend ist die nächste Seite dieser Anfrage? Unbekannte Anfragen 1; danach zählt der Ertrag je Seite:
 * echte Ergebnisse (Antwort, Termin, 👍) am meisten, qualifizierte Leads viel, „passt vermutlich“ mittel, neue Treffer
 * wenig. 👎 drückt die Anfrage nach hinten (13.10.: lernen aus Lead-Qualität). Anfragen, die nur noch Bekannte
 * liefern, rutschen nach hinten.
 */
export function queryPriority(state: Pick<SearchQueryState, 'hits' | 'fresh' | 'likely' | 'qualified' | 'good' | 'bad'> | null): number {
  if (!state || state.hits === 0) return 1;
  const good = state.good ?? 0;
  const bad = state.bad ?? 0;
  // Je 10 Treffer (eine Seite der klassischen Suche) – zählt auch über einen Neubeginn hinweg.
  return (1 + state.fresh * 0.05 + state.likely * 0.3 + state.qualified * 3 + good * 6) / (1 + state.hits / 10) / (1 + bad * 0.5);
}
