import type { Database } from '../db/database.js';
import { localTime } from './guard.js';

/**
 * Feste Obergrenzen je LinkedIn-Account und Tag nach der Empfehlung von Unipile („LinkedIn API Rate Limits and
 * Restrictions in 2026“). Entscheidung des Nutzers 17.10., nachdem ein Account gesperrt wurde: Diese Werte lassen sich
 * weder in den Einstellungen noch in der `.env` überschreiten – niedriger einstellen geht, höher nicht.
 *   - Profilabrufe (Profil und Firmenseite): 100 je Account und Tag.
 *   - Suchtreffer: 1.000 je Account und Tag (klassische Suche), 2.500 mit Sales Navigator.
 *   - Vernetzungsanfragen: höchstens 80 am Tag und 200 in 7 Tagen, Nachrichten höchstens 100 am Tag (je Account).
 */
export const UNIPILE_LIMITS = {
  profilesPerDay: 100,
  searchResultsPerDay: { classic: 1000, sales_navigator: 2500 },
  invitesPerDay: 80,
  invitesPerWeek: 200,
  messagesPerDay: 100,
} as const;

/**
 * Gründer-Accounts (Nick, Johannes) brauchen mehr Schutz als reine Scraping-Accounts (Wunsch des Nutzers 17.10.):
 * Über sie wird vernetzt und geschrieben. Beim Scrapen kommen sie erst dran, wenn die Scraping-Accounts voll sind,
 * und dann nur mit dem halben Tageslimit.
 */
export const FOUNDER_SCRAPE_LIMITS = {
  profilesPerDay: 50,
  searchResultsPerDay: { classic: 500, sales_navigator: 1250 },
} as const;

/** `profile` = Profil- oder Firmenabruf, `search` = angefragte Suchtreffer (volle Seite, auch wenn weniger kommen). */
export type UsageKind = 'profile' | 'search';

/**
 * Wofür ein Abruf war (09.11., nur für den Optimierungs-Bericht): Profil bzw. Firmenseite der Lead-Suche, dasselbe beim
 * Übernehmen neuer Kontakte, Profil beim Aufwärmen, Suchtreffer.
 */
export type UsageSource = 'lead_profile' | 'lead_company' | 'contact_profile' | 'contact_company' | 'warmup' | 'search';
export const USAGE_SOURCE_LABELS: Record<UsageSource, string> = {
  lead_profile: 'Lead-Suche: Profil',
  lead_company: 'Lead-Suche: Firmenseite',
  contact_profile: 'Neue Kontakte: Profil',
  contact_company: 'Neue Kontakte: Firmenseite',
  warmup: 'Aufwärmen: Profil',
  search: 'Suchtreffer',
};
/** So lange bleibt das Protokoll je Zweck (der Zähler fürs Limit nur 14 Tage). */
export const USAGE_LOG_KEEP_DAYS = 120;

/** Zähler je Unipile-Account und Kalendertag (deutsche Zeit) – für Suche und Profilabrufe aller Läufe zusammen. */
export interface AccountUsage {
  used(accountId: string, kind: UsageKind, now: number): number;
  /** `source`: wofür (nur Protokoll, ändert das Limit nicht). */
  add(accountId: string, kind: UsageKind, count: number, now: number, source?: UsageSource): void;
}

/** Ohne Datenbank (Tests, Befehle): Zähler im Speicher. */
export class MemoryAccountUsage implements AccountUsage {
  private readonly counts = new Map<string, number>();

  constructor(private readonly timeZone = 'Europe/Berlin') {}

  private key(accountId: string, kind: UsageKind, now: number) {
    return `${localTime(now, this.timeZone).day}|${accountId}|${kind}`;
  }

  used(accountId: string, kind: UsageKind, now: number): number {
    return this.counts.get(this.key(accountId, kind, now)) ?? 0;
  }

  add(accountId: string, kind: UsageKind, count: number, now: number, _source?: UsageSource): void {
    const key = this.key(accountId, kind, now);
    this.counts.set(key, (this.counts.get(key) ?? 0) + count);
  }
}

/** Im Betrieb: Tabelle `linkedin_account_usage` – übersteht Neustarts und neu gebaute Adapter (Einstellungen). */
export class DbAccountUsage implements AccountUsage {
  constructor(
    private readonly db: Database,
    private readonly timeZone: () => string,
  ) {}

  private day(now: number) {
    return localTime(now, this.timeZone()).day;
  }

  used(accountId: string, kind: UsageKind, now: number): number {
    const row = this.db
      .prepare('SELECT count FROM linkedin_account_usage WHERE day = ? AND account_id = ? AND kind = ?')
      .get(this.day(now), accountId, kind) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  add(accountId: string, kind: UsageKind, count: number, now: number, source?: UsageSource): void {
    this.db
      .prepare(
        'INSERT INTO linkedin_account_usage (day, account_id, kind, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, account_id, kind) DO UPDATE SET count = count + excluded.count',
      )
      .run(this.day(now), accountId, kind, count);
    // Alte Tage braucht niemand mehr.
    this.db.prepare('DELETE FROM linkedin_account_usage WHERE day < ?').run(this.day(now - 14 * 24 * 60 * 60 * 1000));
    try {
      this.db
        .prepare(
          'INSERT INTO linkedin_usage_log (day, account_id, source, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, account_id, source) DO UPDATE SET count = count + excluded.count',
        )
        .run(this.day(now), accountId, source ?? (kind === 'search' ? 'search' : 'lead_profile'), count);
      this.db.prepare('DELETE FROM linkedin_usage_log WHERE day < ?').run(this.day(now - USAGE_LOG_KEEP_DAYS * 24 * 60 * 60 * 1000));
    } catch {
      // Protokoll ist Beiwerk – das Limit zählt oben.
    }
  }
}
