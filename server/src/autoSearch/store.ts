import type { AuthFounderId } from '../../../shared/auth.js';
import {
  AUTO_SEARCH_CHECKED_DAYS,
  AUTO_SEARCH_DEFAULT_MAX_ROUNDS,
  AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT,
  type AutoSearchFocus,
  type AutoSearchLastRun,
  type AutoSearchToday,
  type AutoSearchUpdate,
  type Weekday,
} from '../../../shared/autoSearch.js';
import type { SearchProfile } from '../../../shared/leadSearch.js';
import type { Database } from '../db/database.js';

/**
 * Speicher der automatischen Lead-Suche (Migration 12, 23): Zeitplan je Gründer, letzter Lauf, Kennung des zuletzt
 * ausgelösten Termins (gegen doppeltes Auslösen) und die Profile, die automatische Suchen schon geprüft haben.
 */

export interface StoredSchedule extends AutoSearchUpdate {
  dailyTarget: number | null;
  maxRounds: number;
  secondTime: string | null;
  dailyBudgetEur: number | null;
  kapitalanlagePercent: number;
  updatedAt: number;
  updatedBy: string | null;
}

interface ScheduleRow {
  enabled: number;
  days: string;
  time: string;
  second_time: string | null;
  profile: string;
  updated_at: number;
  updated_by: string | null;
  daily_target: number | null;
  max_rounds: number | null;
  daily_budget_eur: number | null;
  kapitalanlage_percent: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fälliger Termin, der noch wartet (Migration 23): geplanter Zeitpunkt und Tag des Termins. */
export interface PendingSlot {
  startedAt: number;
  day: string;
}

export class AutoSearchStore {
  constructor(private readonly db: Database) {}

  schedule(founder: AuthFounderId): StoredSchedule | null {
    const row = this.db.prepare('SELECT * FROM auto_search_schedules WHERE founder = ?').get(founder) as ScheduleRow | undefined;
    if (!row) return null;
    return {
      enabled: row.enabled === 1,
      days: JSON.parse(row.days) as Weekday[],
      time: row.time,
      secondTime: row.second_time ?? null,
      profile: JSON.parse(row.profile) as SearchProfile,
      dailyTarget: row.daily_target ?? null,
      maxRounds: row.max_rounds ?? AUTO_SEARCH_DEFAULT_MAX_ROUNDS,
      dailyBudgetEur: row.daily_budget_eur ?? null,
      kapitalanlagePercent: row.kapitalanlage_percent ?? AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  /** Fehlen `dailyTarget`/`maxRounds` im Update, bleiben die gespeicherten Werte (Vertrag). */
  saveSchedule(founder: AuthFounderId, update: AutoSearchUpdate, now: number, by: string | null): void {
    const current = this.schedule(founder);
    const dailyTarget = update.dailyTarget !== undefined ? update.dailyTarget : (current?.dailyTarget ?? null);
    const maxRounds = update.maxRounds ?? current?.maxRounds ?? AUTO_SEARCH_DEFAULT_MAX_ROUNDS;
    const secondTime = update.secondTime !== undefined ? update.secondTime : (current?.secondTime ?? null);
    const budget = update.dailyBudgetEur !== undefined ? update.dailyBudgetEur : (current?.dailyBudgetEur ?? null);
    const percent = update.kapitalanlagePercent ?? current?.kapitalanlagePercent ?? AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT;
    this.db
      .prepare(
        `INSERT INTO auto_search_schedules (founder, enabled, days, time, profile, updated_at, updated_by, daily_target, max_rounds, second_time, daily_budget_eur, kapitalanlage_percent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (founder) DO UPDATE SET enabled = excluded.enabled, days = excluded.days, time = excluded.time,
           profile = excluded.profile, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
           daily_target = excluded.daily_target, max_rounds = excluded.max_rounds, second_time = excluded.second_time,
           daily_budget_eur = excluded.daily_budget_eur, kapitalanlage_percent = excluded.kapitalanlage_percent`,
      )
      .run(founder, update.enabled ? 1 : 0, JSON.stringify(update.days), update.time, JSON.stringify(update.profile), now, by, dailyTarget, maxRounds, secondTime, budget, percent);
  }

  /** Stand des Tagesziels – nur für `day`, sonst null (neuer Tag beginnt bei 0). */
  today(founder: AuthFounderId, day: string): AutoSearchToday | null {
    const today = this.storedToday(founder);
    return today?.day === day ? today : null;
  }

  private storedToday(founder: AuthFounderId): AutoSearchToday | null {
    const row = this.db.prepare('SELECT today FROM auto_search_state WHERE founder = ?').get(founder) as { today: string | null } | undefined;
    if (!row?.today) return null;
    try {
      return JSON.parse(row.today) as AutoSearchToday;
    } catch {
      return null;
    }
  }

  /** Fälliger Termin, der noch auf seinen Start wartet (null = keiner). Übersteht einen Neustart. */
  pending(founder: AuthFounderId): PendingSlot | null {
    const row = this.db.prepare('SELECT pending FROM auto_search_state WHERE founder = ?').get(founder) as { pending: string | null } | undefined;
    if (!row?.pending) return null;
    try {
      return JSON.parse(row.pending) as PendingSlot;
    } catch {
      return null;
    }
  }

  setPending(founder: AuthFounderId, pending: PendingSlot | null): void {
    this.db
      .prepare(
        `INSERT INTO auto_search_state (founder, pending) VALUES (?, ?)
         ON CONFLICT (founder) DO UPDATE SET pending = excluded.pending`,
      )
      .run(founder, pending ? JSON.stringify(pending) : null);
  }

  /** Profilabrufe an diesem Tag (alle Läufe, beide Gründer). */
  profileFetches(day: string): number {
    const row = this.db.prepare('SELECT count FROM auto_search_profile_fetches WHERE day = ?').get(day) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Einen Profilabruf zählen; ältere Tage werden dabei gelöscht (nur der laufende Tag zählt). */
  addProfileFetch(day: string): void {
    this.db.prepare('DELETE FROM auto_search_profile_fetches WHERE day < ?').run(day);
    this.db
      .prepare(
        `INSERT INTO auto_search_profile_fetches (day, count) VALUES (?, 1)
         ON CONFLICT (day) DO UPDATE SET count = count + 1`,
      )
      .run(day);
  }

  /**
   * Einen Lauf des Tages zählen (gestartet) bzw. übergebene Leads dazurechnen – immer für den Tag des Termins. Ist
   * gespeichert schon ein späterer Tag (Lauf ging über Mitternacht, danach lief schon etwas am neuen Tag), bleibt
   * dieser stehen: Der alte Tag ist vorbei und wird nicht mehr angezeigt.
   */
  addToday(founder: AuthFounderId, day: string, add: { rounds?: number; created?: number; costEur?: number }): AutoSearchToday {
    const stored = this.storedToday(founder);
    const current = stored?.day === day ? stored : { day, created: 0, rounds: 0, costEur: 0 };
    const next: AutoSearchToday = {
      day,
      created: current.created + (add.created ?? 0),
      rounds: current.rounds + (add.rounds ?? 0),
      costEur: Math.round(((current.costEur ?? 0) + (add.costEur ?? 0)) * 10_000) / 10_000,
      // Ein neu gestarteter Lauf hebt den Stopp-Grund auf („Jetzt ausführen“ nach dem Stopp).
      stopReason: add.rounds ? null : (current.stopReason ?? null),
    };
    return this.writeToday(founder, stored, next);
  }

  /** Warum heute kein weiterer Lauf fürs Tagesziel kommt (`AutoSearchToday.stopReason`). */
  setStopReason(founder: AuthFounderId, day: string, reason: string): AutoSearchToday {
    const stored = this.storedToday(founder);
    const current = stored?.day === day ? stored : { day, created: 0, rounds: 0, costEur: 0 };
    return this.writeToday(founder, stored, { ...current, stopReason: reason });
  }

  private writeToday(founder: AuthFounderId, stored: AutoSearchToday | null, next: AutoSearchToday): AutoSearchToday {
    if (stored && stored.day > next.day) return next;
    this.db
      .prepare(
        `INSERT INTO auto_search_state (founder, today) VALUES (?, ?)
         ON CONFLICT (founder) DO UPDATE SET today = excluded.today`,
      )
      .run(founder, JSON.stringify(next));
    return next;
  }

  lastRun(founder: AuthFounderId): AutoSearchLastRun | null {
    const row = this.db.prepare('SELECT last_run FROM auto_search_state WHERE founder = ?').get(founder) as { last_run: string | null } | undefined;
    return row?.last_run ? (JSON.parse(row.last_run) as AutoSearchLastRun) : null;
  }

  setLastRun(founder: AuthFounderId, run: AutoSearchLastRun): void {
    this.db
      .prepare(
        `INSERT INTO auto_search_state (founder, last_run) VALUES (?, ?)
         ON CONFLICT (founder) DO UPDATE SET last_run = excluded.last_run`,
      )
      .run(founder, JSON.stringify(run));
  }

  /** Bisherige Läufe je Zielgruppe (50/50-Regel, seit 27.10. neu gezählt – Migration 43). */
  focusCounts(founder: AuthFounderId): Record<AutoSearchFocus, number> {
    const row = this.db.prepare('SELECT focus_counts FROM auto_search_state WHERE founder = ?').get(founder) as { focus_counts: string | null } | undefined;
    const empty = { kapitalanlage_vertrieb: 0, finanzdienstleister: 0, bautraeger_projektentwickler: 0 };
    if (!row?.focus_counts) return empty;
    try {
      return { ...empty, ...(JSON.parse(row.focus_counts) as Partial<Record<AutoSearchFocus, number>>) };
    } catch {
      return empty;
    }
  }

  /** Einen gestarteten Lauf für diese Zielgruppe zählen. */
  countFocus(founder: AuthFounderId, focus: AutoSearchFocus): void {
    const counts = this.focusCounts(founder);
    counts[focus] += 1;
    this.db
      .prepare(
        `INSERT INTO auto_search_state (founder, focus_counts) VALUES (?, ?)
         ON CONFLICT (founder) DO UPDATE SET focus_counts = excluded.focus_counts`,
      )
      .run(founder, JSON.stringify(counts));
  }

  /**
   * Termin `key` für diesen Gründer als ausgelöst merken. false = war schon ausgelöst (gleiche Minute, auch vor einem
   * Neustart) – dann nicht noch einmal starten.
   */
  claimSlot(founder: AuthFounderId, key: string): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO auto_search_state (founder, last_key) VALUES (?, ?)
         ON CONFLICT (founder) DO UPDATE SET last_key = excluded.last_key
         WHERE auto_search_state.last_key IS NULL OR auto_search_state.last_key <> excluded.last_key`,
      )
      .run(founder, key);
    return Number(result.changes) > 0;
  }

  /** Alles löschen (Zurücksetzen der Simulation). */
  reset(): void {
    this.db.exec(
      'DELETE FROM auto_search_schedules; DELETE FROM auto_search_state; DELETE FROM auto_search_checked; DELETE FROM auto_search_profile_fetches;',
    );
  }

  /** Provider-IDs, die automatische Suchen dieses Gründers in den letzten `AUTO_SEARCH_CHECKED_DAYS` Tagen geprüft haben. */
  checked(founder: AuthFounderId, now: number): string[] {
    this.db.prepare('DELETE FROM auto_search_checked WHERE checked_at < ?').run(now - AUTO_SEARCH_CHECKED_DAYS * DAY_MS);
    const rows = this.db.prepare('SELECT provider_id FROM auto_search_checked WHERE founder = ? ORDER BY checked_at').all(founder) as Array<{
      provider_id: string;
    }>;
    return rows.map((row) => row.provider_id);
  }

  /**
   * Geprüfte Provider-IDs beider Gründer zusammen: Beide suchen über denselben Unipile-Such-Account mit einem
   * gemeinsamen Tageslimit – was Nick schon abgelehnt hat, soll Johannes nicht noch einmal abrufen (und umgekehrt).
   */
  checkedShared(now: number): string[] {
    this.db.prepare('DELETE FROM auto_search_checked WHERE checked_at < ?').run(now - AUTO_SEARCH_CHECKED_DAYS * DAY_MS);
    const rows = this.db
      .prepare('SELECT provider_id FROM auto_search_checked GROUP BY provider_id ORDER BY MIN(checked_at)')
      .all() as Array<{ provider_id: string }>;
    return rows.map((row) => row.provider_id);
  }

  addChecked(founder: AuthFounderId, providerIds: string[], now: number): void {
    if (providerIds.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO auto_search_checked (founder, provider_id, checked_at) VALUES (?, ?, ?)
       ON CONFLICT (founder, provider_id) DO UPDATE SET checked_at = excluded.checked_at`,
    );
    this.db.exec('BEGIN');
    try {
      for (const id of providerIds) insert.run(founder, id, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
