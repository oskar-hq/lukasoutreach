import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKUP_NAME_PATTERN, BEFORE_UPDATE_KEEP, type BackupInfo, type BackupListResponse, type DiskSpaceInfo } from '../../../shared/system.js';
import type { Config } from '../config.js';
import { BACKUP_PREFIX, BEFORE_RESTORE_PREFIX, BEFORE_UPDATE_PREFIX, MANUAL_BACKUP_PREFIX, backupDir, backupTime, msUntilHour, writeBackup } from '../db/backup.js';
import { DATABASE_FILE, migrate, type Database } from '../db/database.js';
import { LeadStore } from '../leads/leadStore.js';
import { NotificationCenter, type RaiseInput } from '../notify/notifications.js';

/**
 * Sicherungen in der Oberfläche (Vertrag `shared/system.ts`): auflisten, jetzt sichern, Datei finden, Wiederherstellen
 * vorbereiten. Die Art steckt im Dateinamen: `cockpit-…` (geplant, wie bisher), `manuell-…` (von Hand),
 * `vor-wiederherstellen-…` (automatisch vor dem Einspielen), `vor-update-…` (automatisch vor jedem Update). Jede Art
 * behält höchstens `BACKUP_KEEP` Dateien (vor einem Update: `BEFORE_UPDATE_KEEP` = 3 – sie sind nur für den Weg zurück
 * nach einem missglückten Update da); jede Sicherung wird nach `BACKUP_MAX_AGE_DAYS` Tagen gelöscht (die neueste
 * bleibt immer).
 *
 * Wiederherstellen tauscht die Datei nie im laufenden Betrieb: Die geprüfte Kopie wird als `cockpit.db.restore`
 * neben die Datenbank gelegt, das Backend beendet sich, und beim nächsten Start setzt `applyPendingRestore` sie ein –
 * bevor irgendetwas die Datenbank öffnet.
 */

export const RESTORE_FILE = `${DATABASE_FILE}.restore`;

export class BackupError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'not_found' | 'invalid_backup' | 'busy',
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

function kindOf(name: string): BackupInfo['kind'] {
  if (name.startsWith(BACKUP_PREFIX)) return 'scheduled';
  if (name.startsWith(BEFORE_RESTORE_PREFIX)) return 'before_restore';
  if (name.startsWith(BEFORE_UPDATE_PREFIX)) return 'before_update';
  return 'manual';
}

const PREFIX_OF: Record<BackupInfo['kind'], string> = {
  scheduled: BACKUP_PREFIX,
  manual: MANUAL_BACKUP_PREFIX,
  before_restore: BEFORE_RESTORE_PREFIX,
  before_update: BEFORE_UPDATE_PREFIX,
};

const createdAtOf = backupTime;

/** „06.10.2026, 02:00“ in deutscher Zeit – für fertige Sätze. */
export function germanDateTime(ms: number): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

/** Prüft eine Datenbank-Datei (nur lesend): SQLite `integrity_check` = ok und Tabellen des Cockpits vorhanden. */
export function checkBackupFile(file: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') return false;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'leads')").all();
    return tables.length === 2;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Beim Start, bevor die Datenbank geöffnet wird: liegt eine geprüfte Wiederherstellung bereit, ersetzt sie die
 * Datenbank (WAL-Reste des alten Stands werden entfernt). Gibt true zurück, wenn etwas eingesetzt wurde.
 */
export function applyPendingRestore(dataDir: string): boolean {
  const pending = path.join(dataDir, RESTORE_FILE);
  if (!existsSync(pending)) return false;
  const target = path.join(dataDir, DATABASE_FILE);
  for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
  renameSync(pending, target);
  return true;
}

const ACTION_COLUMNS = 'id, founder, account_id, lead_id, kind, status, detail, day, at';

/**
 * LinkedIn-Schutz übersteht das Wiederherstellen: alle Einträge aus `linkedin_actions`, die in der Sicherung fehlen
 * (Tages-/Wochengrenzen zählen weiter), und die jetzigen Pausen (`linkedin_pauses`) in die bereitgelegte Kopie
 * übernehmen. Fehlen die Tabellen in der Sicherung (älter als die LinkedIn-Aktionen), bleibt sie, wie sie ist.
 * Gibt die Zahl übernommener Aktionen zurück.
 */
export function carryOverLinkedInSafety(current: Database, file: string): number {
  const target = new DatabaseSync(file);
  try {
    const tables = target.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('linkedin_actions', 'linkedin_pauses')").all();
    if (tables.length !== 2) return 0;
    const actions = current.prepare(`SELECT ${ACTION_COLUMNS} FROM linkedin_actions`).all() as Record<string, string | number | null>[];
    const pauses = current.prepare('SELECT founder, paused_until, reason FROM linkedin_pauses').all() as Record<string, string | number>[];
    const insertAction = target.prepare(`INSERT OR IGNORE INTO linkedin_actions (${ACTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertPause = target.prepare('INSERT INTO linkedin_pauses (founder, paused_until, reason) VALUES (?, ?, ?)');
    let added = 0;
    target.exec('BEGIN IMMEDIATE');
    try {
      for (const row of actions) {
        const result = insertAction.run(row.id, row.founder, row.account_id, row.lead_id, row.kind, row.status, row.detail, row.day, row.at);
        added += Number(result.changes);
      }
      target.exec('DELETE FROM linkedin_pauses');
      for (const row of pauses) insertPause.run(row.founder, row.paused_until, row.reason);
      target.exec('COMMIT');
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
    return added;
  } finally {
    target.close();
  }
}

/** Spalten einer Tabelle (leer, wenn es sie nicht gibt). */
function columnsOf(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
}

/**
 * Zeilen aus dem jetzigen Stand in die Kopie übernehmen (gemeinsame Spalten). `where` wählt Zeilen aus;
 * `replaceAll` leert die Tabelle der Kopie vorher. Fehlt die Tabelle auf einer Seite, passiert nichts.
 */
function copyRows(
  current: Database,
  target: Database,
  table: string,
  { where, replaceAll, keepExisting = false }: { where?: string; replaceAll: boolean; keepExisting?: boolean },
): void {
  const targetColumns = new Set(columnsOf(target, table));
  const columns = columnsOf(current, table).filter((column) => targetColumns.has(column));
  if (!columns.length) return;
  if (replaceAll) target.exec(`DELETE FROM ${table}`);
  const list = columns.join(', ');
  const rows = current.prepare(`SELECT ${list} FROM ${table}${where ? ` WHERE ${where}` : ''}`).all() as Record<string, string | number | null>[];
  const insert = target.prepare(`INSERT OR ${keepExisting ? 'IGNORE' : 'REPLACE'} INTO ${table} (${list}) VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of rows) insert.run(...columns.map((column) => row[column]));
}

/**
 * Zugang übersteht das Wiederherstellen nie rückwärts (Sicherheitsprüfung 09.10.): Die Kopie wird auf das jetzige
 * Schema gebracht, dann gelten die **jetzigen** Konten mit Passwörtern und Rollen (`users`), offenen Registrierungen
 * und Gesehen-Stände; alle Sitzungen und Einladungslinks werden gelöscht (alle melden sich neu an) und die jetzigen
 * Meldungen über Konten (`account_change`) übernommen. Sonst kämen entfernte Konten, alte Passwörter und alte
 * Sitzungen mit der Sicherung zurück und die Spur, wer was an Konten geändert hat, wäre weg.
 * Datenschutz: Die jetzigen Fingerabdrücke gelöschter Leads (`deleted_leads`) kommen in die Kopie, und jeder Lead der
 * Kopie mit so einem Fingerabdruck wird dort gelöscht – über denselben Löschweg wie „Löschen auf Wunsch“ (Verlauf weg,
 * zählbare Ereignisse anonym ins Archiv, Bezüge gelöst). Sonst käme ein nach der Sicherung gelöschter Lead zurück.
 * `notice` (z. B. „Sicherung wiederhergestellt von …“) landet ohne Slack in der Kopie.
 */
export function carryOverAccess(current: Database, file: string, notice?: RaiseInput, now = Date.now()): void {
  const target = new DatabaseSync(file);
  try {
    migrate(target);
    // Für das Löschen samt Verlauf (lead_events hängt per ON DELETE CASCADE an leads).
    target.exec('PRAGMA foreign_keys = ON');
    target.exec('BEGIN IMMEDIATE');
    try {
      copyRows(current, target, 'users', { replaceAll: true });
      copyRows(current, target, 'registrations', { replaceAll: true });
      copyRows(current, target, 'notification_seen', { replaceAll: true });
      target.exec('DELETE FROM sessions; DELETE FROM invitations;');
      copyRows(current, target, 'notifications', { where: "kind = 'account_change'", replaceAll: false });
      copyRows(current, target, 'deleted_leads', { replaceAll: false, keepExisting: true });
      new LeadStore(target).purgeForgotten(now);
      if (notice) new NotificationCenter({ db: target, log: QUIET_LOG, now: () => now }).raiseOrThrow(notice);
      target.exec('COMMIT');
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
  } finally {
    target.close();
  }
}

/** `raiseOrThrow` loggt nur „Meldung“ – in der Kopie ohne Protokoll. */
const QUIET_LOG = { info: () => undefined, error: () => undefined } as unknown as ConstructorParameters<typeof NotificationCenter>[0]['log'];

export interface BackupServiceDeps {
  db: Database;
  /** Die laufende Konfiguration (wird bei Änderungen der Einstellungen ersetzt) – nur lesen. */
  config: Config;
  now?: () => number;
  /** Vor jeder Sicherung (z. B. Speicherplatz prüfen) – Fehler darin stören die Sicherung nicht. */
  beforeBackup?: () => void;
  /** Freier Platz im Datenordner für die Liste (null = nicht lesbar). */
  disk?: () => DiskSpaceInfo | null;
}

export class BackupService {
  private running = false;
  private restoring = false;
  private lastError: string | null = null;

  constructor(private readonly deps: BackupServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private dir(): string {
    return backupDir(this.deps.config.dataDir);
  }

  list(): BackupListResponse {
    const dir = this.dir();
    const names = existsSync(dir) ? readdirSync(dir).filter((name) => BACKUP_NAME_PATTERN.test(name)) : [];
    const backups: BackupInfo[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = statSync(file);
        if (!stat.isFile()) continue;
        backups.push({ name, size: stat.size, createdAt: createdAtOf(name, file), kind: kindOf(name) });
      } catch {
        // Gerade gelöscht (Aufräumen) – auslassen.
      }
    }
    backups.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
    const hour = this.deps.config.backup.hourUtc;
    const now = this.now();
    return {
      backups,
      nextAt: hour === null ? null : now + msUntilHour(hour, new Date(now)),
      keep: this.deps.config.backup.keep,
      maxAgeDays: this.deps.config.backup.maxAgeDays,
      lastError: this.lastError,
      ...this.diskInfo(),
    };
  }

  private diskInfo(): { disk?: DiskSpaceInfo } {
    try {
      const disk = this.deps.disk?.();
      return disk ? { disk } : {};
    } catch {
      return {};
    }
  }

  /** Sicherung anlegen. 409 busy, solange eine andere läuft oder eine Wiederherstellung ansteht. */
  create(kind: BackupInfo['kind']): BackupInfo {
    if (this.running || this.restoring) throw new BackupError(409, 'busy', 'Gerade läuft schon eine Sicherung – bitte einen Moment warten.');
    this.running = true;
    const prefix = PREFIX_OF[kind];
    try {
      this.deps.beforeBackup?.();
    } catch {
      // Nur eine Prüfung (Speicherplatz) – die Sicherung versucht es trotzdem.
    }
    try {
      const { maxAgeDays } = this.deps.config.backup;
      const keep = kind === 'before_update' ? BEFORE_UPDATE_KEEP : this.deps.config.backup.keep;
      const file = writeBackup(this.deps.db, this.deps.config.dataDir, prefix, keep, new Date(this.now()), maxAgeDays);
      if (kind === 'scheduled') this.lastError = null;
      const name = path.basename(file);
      return { name, size: statSync(file).size, createdAt: createdAtOf(name, file), kind };
    } catch (error) {
      if (kind === 'scheduled') {
        this.lastError = `Die geplante Sicherung am ${germanDateTime(this.now())} ist fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  /** Pfad einer vorhandenen Sicherung – unbekannter oder unzulässiger Name → 404. */
  file(name: string): string {
    if (!BACKUP_NAME_PATTERN.test(name)) throw new BackupError(404, 'not_found', 'Diese Sicherung gibt es nicht.');
    const file = path.join(this.dir(), name);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // weiter unten 404
    }
    throw new BackupError(404, 'not_found', 'Diese Sicherung gibt es nicht.');
  }

  info(name: string): BackupInfo {
    const file = this.file(name);
    return { name, size: statSync(file).size, createdAt: createdAtOf(name, file), kind: kindOf(name) };
  }

  /** Steht eine Wiederherstellung an (dann keine weiteren Sicherungen/Wiederherstellungen bis zum Neustart)? */
  get restorePending(): boolean {
    return this.restoring;
  }

  /**
   * Wiederherstellen vorbereiten (nur live): Sicherung prüfen (sonst 400 invalid_backup, nichts geändert), den jetzigen
   * Stand sichern, jetzigen Zugang und LinkedIn-Grenzen übernehmen, `notice` hineinschreiben und die Kopie als
   * `cockpit.db.restore` bereitlegen. Den Neustart löst der Aufrufer aus.
   */
  prepareRestore(name: string, notice?: RaiseInput): { backup: BackupInfo; safetyBackup: string } {
    const source = this.file(name);
    const backup = this.info(name);
    if (this.running || this.restoring) throw new BackupError(409, 'busy', 'Gerade läuft schon eine Sicherung oder Wiederherstellung – bitte einen Moment warten.');
    const dataDir = this.deps.config.dataDir;
    const staging = path.join(dataDir, `${RESTORE_FILE}.tmp`);
    rmSync(staging, { force: true });
    // Auf einer Kopie prüfen: genau diese Bytes werden später eingesetzt.
    copyFileSync(source, staging);
    if (!checkBackupFile(staging)) {
      rmSync(staging, { force: true });
      throw new BackupError(400, 'invalid_backup', 'Diese Sicherung ist beschädigt oder keine Datenbank des Cockpits – es wurde nichts geändert.');
    }
    let safety: BackupInfo;
    try {
      safety = this.create('before_restore');
      // Konten, Passwörter und Meldungen über Konten bleiben, Sitzungen und Einladungen sind weg.
      carryOverAccess(this.deps.db, staging, notice, this.now());
      // Grenzen und Pausen für LinkedIn dürfen durch eine ältere Sicherung nicht zurückgesetzt werden.
      carryOverLinkedInSafety(this.deps.db, staging);
      // Nur die Datei selbst einsetzen (kein WAL neben der Kopie zurücklassen).
      for (const suffix of ['-wal', '-shm']) rmSync(`${staging}${suffix}`, { force: true });
    } catch (error) {
      rmSync(staging, { force: true });
      throw error;
    }
    this.restoring = true;
    renameSync(staging, path.join(dataDir, RESTORE_FILE));
    return { backup, safetyBackup: safety.name };
  }
}
