import type { SettingKey, SettingsHistoryAction, SettingsHistoryEntry, SettingValue } from '../../../shared/settings.js';
import { SETTING_KEYS } from '../../../shared/settings.js';
import type { Database } from '../db/database.js';
import type { SecretBox } from './crypto.js';

/**
 * Speicher der Einstellungen in der Datenbank. Nicht-geheime Werte als JSON, Geheimnisse verschlüsselt (`SecretBox`).
 * `version` zählt jede Änderung hoch (Schutz gegen gleichzeitiges Speichern). Der Verlauf enthält nie ein Geheimnis.
 */

export interface StoredRow {
  key: SettingKey;
  secret: boolean;
  /** Entschlüsselter bzw. gelesener Wert; null = nicht lesbar (siehe `problem`). */
  value: SettingValue | null;
  problem?: string;
}

export interface TrialRow {
  keys: SettingKey[];
  /** Vorheriger Software-Wert je Schlüssel (fehlt = war nicht in der Software gesetzt). */
  previous: Partial<Record<SettingKey, SettingValue>>;
  revertsAt: number;
  username: string;
  sessionHash: string;
}

const isKey = (key: string): key is SettingKey => (SETTING_KEYS as readonly string[]).includes(key);

export class SettingsStore {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  version(): number {
    return (this.db.prepare('SELECT version FROM settings_meta WHERE id = 1').get() as { version: number }).version;
  }

  bump(): number {
    this.db.prepare('UPDATE settings_meta SET version = version + 1 WHERE id = 1').run();
    return this.version();
  }

  /** Alle gespeicherten Werte; unbekannte Schlüssel (aus einer anderen Version) werden übersprungen. */
  all(): StoredRow[] {
    const rows = this.db.prepare('SELECT key, secret, value FROM settings_values').all() as unknown as { key: string; secret: number; value: string }[];
    const result: StoredRow[] = [];
    for (const row of rows) {
      if (!isKey(row.key)) continue;
      const secret = row.secret === 1;
      if (secret) {
        const plain = this.box.decrypt(row.value);
        result.push(plain === null ? { key: row.key, secret, value: null, problem: 'Der gespeicherte Wert ist nicht lesbar (Schlüssel für Geheimnisse fehlt oder passt nicht) und wird ignoriert.' } : { key: row.key, secret, value: plain });
        continue;
      }
      try {
        result.push({ key: row.key, secret, value: JSON.parse(row.value) as SettingValue });
      } catch {
        result.push({ key: row.key, secret, value: null, problem: 'Der gespeicherte Wert ist beschädigt und wird ignoriert.' });
      }
    }
    return result;
  }

  set(key: SettingKey, value: SettingValue, secret: boolean, by: string | null, now: number): void {
    const stored = secret ? this.box.encrypt(String(value)) : JSON.stringify(value);
    this.db
      .prepare(
        `INSERT INTO settings_values (key, secret, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET secret = excluded.secret, value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(key, secret ? 1 : 0, stored, now, by);
  }

  delete(key: SettingKey): boolean {
    return Number(this.db.prepare('DELETE FROM settings_values WHERE key = ?').run(key).changes) > 0;
  }

  deleteAll(): number {
    return Number(this.db.prepare('DELETE FROM settings_values').run().changes);
  }

  // ── Verlauf ──

  addHistory(entry: { at: number; username: string; ip: string | null; key: SettingKey; action: SettingsHistoryAction; from?: SettingValue | null; to?: SettingValue | null }): void {
    this.db
      .prepare('INSERT INTO settings_history (at, username, ip, key, action, from_value, to_value) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        entry.at,
        entry.username,
        entry.ip,
        entry.key,
        entry.action,
        entry.from === undefined ? null : JSON.stringify(entry.from),
        entry.to === undefined ? null : JSON.stringify(entry.to),
      );
    // Höchstens die letzten 5000 Einträge behalten.
    this.db.prepare('DELETE FROM settings_history WHERE id <= (SELECT MAX(id) FROM settings_history) - 5000').run();
  }

  history(limit = 100): SettingsHistoryEntry[] {
    const rows = this.db
      .prepare('SELECT at, username, ip, key, action, from_value, to_value FROM settings_history ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as { at: number; username: string; ip: string | null; key: string; action: string; from_value: string | null; to_value: string | null }[];
    return rows
      .filter((row) => isKey(row.key))
      .map((row) => ({
        at: row.at,
        username: row.username,
        ...(row.ip ? { ip: row.ip } : {}),
        key: row.key as SettingKey,
        action: row.action as SettingsHistoryAction,
        ...(row.from_value !== null ? { from: JSON.parse(row.from_value) as SettingValue | null } : {}),
        ...(row.to_value !== null ? { to: JSON.parse(row.to_value) as SettingValue | null } : {}),
      }));
  }

  // ── Probe-Änderung ──

  trial(): TrialRow | null {
    const row = this.db.prepare('SELECT keys, previous, reverts_at, username, session_hash FROM settings_trial WHERE id = 1').get() as
      | { keys: string; previous: string; reverts_at: number; username: string; session_hash: string }
      | undefined;
    if (!row) return null;
    return { keys: JSON.parse(row.keys), previous: JSON.parse(row.previous), revertsAt: row.reverts_at, username: row.username, sessionHash: row.session_hash };
  }

  setTrial(trial: TrialRow): void {
    this.db
      .prepare(
        `INSERT INTO settings_trial (id, keys, previous, reverts_at, username, session_hash) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET keys = excluded.keys, previous = excluded.previous, reverts_at = excluded.reverts_at, username = excluded.username, session_hash = excluded.session_hash`,
      )
      .run(JSON.stringify(trial.keys), JSON.stringify(trial.previous), trial.revertsAt, trial.username, trial.sessionHash);
  }

  clearTrial(): void {
    this.db.prepare('DELETE FROM settings_trial WHERE id = 1').run();
  }

  /** Vorherige Werte der Probe zurückschreiben (Probe-Schlüssel sind nie Geheimnisse). Gibt true zurück, wenn etwas zu tun war. */
  revertTrial(now: number): TrialRow | null {
    const trial = this.trial();
    if (!trial) return null;
    for (const key of trial.keys) {
      const previous = trial.previous[key];
      if (previous === undefined) this.delete(key);
      else this.set(key, previous, false, trial.username, now);
    }
    this.clearTrial();
    this.bump();
    return trial;
  }
}
