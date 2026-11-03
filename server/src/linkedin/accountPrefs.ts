import type { LinkedInAccountLimits } from '../../../shared/linkedin.js';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import { UNIPILE_LIMITS } from './accountUsage.js';

/**
 * Einstellungen je LinkedIn-Account (Wunsch des Nutzers 21.10.): eigene Tagesgrenzen für Suchtreffer, Profilabrufe und
 * Vernetzungsanfragen sowie die Reihenfolge der Scraping-Accounts beim Suchen. null = Standard. Höher als die festen
 * Unipile-Grenzen (`UNIPILE_LIMITS`) geht nie; Gründer-Accounts ohne Platz scrapen zuletzt (mit Platz seit 22.10. wie alle anderen).
 */

export interface AccountPref extends LinkedInAccountLimits {
  /** Platz in der Reihenfolge (0 = zuerst) – null: hinter allen mit Platz, in der Reihenfolge von Unipile. */
  position: number | null;
}

const EMPTY: AccountPref = { position: null, profilesPerDay: null, searchResultsPerDay: null, invitesPerDay: null };

/** Obergrenzen für eigene Werte. Suchtreffer: die höhere der beiden Such-Arten (je nach Suche gilt die passende). */
export const ACCOUNT_LIMIT_MAX: Record<keyof LinkedInAccountLimits, number> = {
  profilesPerDay: UNIPILE_LIMITS.profilesPerDay,
  searchResultsPerDay: UNIPILE_LIMITS.searchResultsPerDay.sales_navigator,
  invitesPerDay: UNIPILE_LIMITS.invitesPerDay,
};

export class AccountPrefsStore {
  constructor(private readonly db: Database) {}

  get(accountId: string): AccountPref {
    const row = this.db
      .prepare('SELECT position, profiles_per_day, search_results_per_day, invites_per_day FROM linkedin_account_prefs WHERE account_id = ?')
      .get(accountId) as { position: number | null; profiles_per_day: number | null; search_results_per_day: number | null; invites_per_day: number | null } | undefined;
    if (!row) return { ...EMPTY };
    return { position: row.position, profilesPerDay: row.profiles_per_day, searchResultsPerDay: row.search_results_per_day, invitesPerDay: row.invites_per_day };
  }

  /** Eigene Grenzen setzen (fehlendes Feld bleibt, null = Standard). */
  setLimits(accountId: string, limits: Partial<LinkedInAccountLimits>): AccountPref {
    const next = { ...this.get(accountId), ...limits };
    this.db
      .prepare(
        `INSERT INTO linkedin_account_prefs (account_id, position, profiles_per_day, search_results_per_day, invites_per_day) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET profiles_per_day = excluded.profiles_per_day, search_results_per_day = excluded.search_results_per_day, invites_per_day = excluded.invites_per_day`,
      )
      .run(accountId, next.position, next.profilesPerDay, next.searchResultsPerDay, next.invitesPerDay);
    return next;
  }

  /** Reihenfolge der Scraping-Accounts: Position = Index in `ids`; andere verlieren ihren Platz. */
  setOrder(ids: string[]): void {
    this.db.exec('UPDATE linkedin_account_prefs SET position = NULL');
    const upsert = this.db.prepare(
      'INSERT INTO linkedin_account_prefs (account_id, position) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET position = excluded.position',
    );
    ids.forEach((id, index) => upsert.run(id, index));
  }

  /** `ids` nach Platz sortiert; ohne Platz dahinter in der bisherigen Reihenfolge. */
  sort(ids: string[]): string[] {
    const position = new Map(ids.map((id) => [id, this.get(id).position]));
    return ids
      .map((id, index) => ({ id, index, position: position.get(id) ?? null }))
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.index - b.index)
      .map((entry) => entry.id);
  }

  /** Gibt es überhaupt eine eingestellte Reihenfolge? Ohne sie verteilt die Suche weiter gleichmäßig. */
  hasOrder(ids: string[]): boolean {
    return ids.some((id) => this.get(id).position !== null);
  }

  /** Eigener Wert, sonst der Standard – nie höher als die Unipile-Grenze. */
  limit(accountId: string, kind: keyof LinkedInAccountLimits, fallback: number): number {
    const own = this.get(accountId)[kind];
    return Math.min(ACCOUNT_LIMIT_MAX[kind], own ?? fallback);
  }
}

/** Eigene Anfragen-Grenze je Gründer (über seinen Account) – nur wo eine eingestellt ist. */
export function founderInviteLimits(config: Config, prefs: AccountPrefsStore | undefined): Partial<Record<AuthFounderId, number>> {
  const limits: Partial<Record<AuthFounderId, number>> = {};
  if (!prefs) return limits;
  for (const founder of AUTH_FOUNDER_IDS) {
    // Simulation ohne Zuordnung: es gilt `mock-<gründer>` (wie `LinkedInService.accountOf`).
    const accountId = config.linkedin.accounts[founder] ?? (config.mode === 'mock' ? `mock-${founder}` : null);
    const own = accountId ? prefs.get(accountId).invitesPerDay : null;
    if (own !== null) limits[founder] = Math.min(ACCOUNT_LIMIT_MAX.invitesPerDay, own);
  }
  return limits;
}
