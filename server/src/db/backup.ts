import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Database } from './database.js';

/**
 * Sicherung der Datenbank: `VACUUM INTO` schreibt eine vollständige, in sich stimmige Kopie – auch während der
 * Server läuft. Die Kopien liegen im Unterordner `backups/` des Datenordners (Docker-Volume); es bleiben die
 * neuesten `keep` Dateien, und jede Sicherung (jeder Art) wird nach `BACKUP_MAX_AGE_DAYS` Tagen gelöscht (Standard 7,
 * Entscheidung 07.10.). Gegen den Verlust des ganzen Servers helfen sie nicht → zusätzlich Hostinger-Backups.
 */

export const BACKUP_PREFIX = 'cockpit-';

function stamp(now: Date): string {
  // 2026-10-03T02-00-00Z – sortierbar und ohne Doppelpunkte (Dateinamen)
  return now.toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
}

export function backupDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

/** Von Hand (Oberfläche, `backupCli`) und automatisch vor dem Wiederherstellen – nicht vom Zeitplan. */
export const MANUAL_BACKUP_PREFIX = 'manuell-';
export const BEFORE_RESTORE_PREFIX = 'vor-wiederherstellen-';
/** Automatisch vor jedem Update (Knopf und nachts) – es bleiben die letzten `BEFORE_UPDATE_KEEP` (shared/system.ts). */
export const BEFORE_UPDATE_PREFIX = 'vor-update-';

const PREFIXES = [BACKUP_PREFIX, MANUAL_BACKUP_PREFIX, BEFORE_RESTORE_PREFIX, BEFORE_UPDATE_PREFIX];
const STAMP = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-\d+)?\.db$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Zeitpunkt einer Sicherung aus dem Namen (UTC), sonst Änderungszeit der Datei. */
export function backupTime(name: string, file: string): number {
  const match = name.match(STAMP);
  if (match) {
    const [y, mo, d, h, mi, s] = match.slice(1).map(Number);
    return Date.UTC(y, mo - 1, d, h, mi, s);
  }
  return Math.floor(statSync(file).mtimeMs);
}

/**
 * Sicherungen aller Arten löschen, die älter als `maxAgeDays` Tage sind – außer `keepFile` (die gerade angelegte).
 * So bleibt immer mindestens eine. Gibt die Zahl gelöschter Dateien zurück.
 */
export function pruneOldBackups(dataDir: string, maxAgeDays: number, now = new Date(), keepFile: string | null = null): number {
  const dir = backupDir(dataDir);
  if (!existsSync(dir)) return 0;
  const limit = now.getTime() - maxAgeDays * DAY_MS;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.db') || !PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const file = path.join(dir, name);
    if (keepFile && path.resolve(file) === path.resolve(keepFile)) continue;
    try {
      if (backupTime(name, file) < limit) {
        rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // Gerade anderswo gelöscht – nichts zu tun.
    }
  }
  return removed;
}

/**
 * Legt eine Sicherung mit `prefix` an, löscht ältere mit demselben Präfix über `keep` hinaus und – mit `maxAgeDays` –
 * alle Sicherungen, die älter sind. Gibt den Pfad zurück. Gibt es den Namen schon (zwei Sicherungen in derselben
 * Sekunde), wird „-2“, „-3“ … angehängt.
 */
export function writeBackup(db: Database, dataDir: string, prefix: string, keep: number, now = new Date(), maxAgeDays: number | null = null): string {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${prefix}${stamp(now)}.db`);
  for (let n = 2; existsSync(file); n++) file = path.join(dir, `${prefix}${stamp(now)}-${n}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(path.join(dir, old), { force: true });
  if (maxAgeDays !== null) pruneOldBackups(dataDir, maxAgeDays, now, file);
  return file;
}

/** Geplante Sicherung (`cockpit-…`): legt sie an, löscht ältere über `keep` hinaus und gibt den Pfad zurück. */
export function backupDatabase(db: Database, dataDir: string, keep: number, now = new Date()): string {
  return writeBackup(db, dataDir, BACKUP_PREFIX, keep, now);
}

/** Millisekunden bis zur nächsten vollen Stunde `hourUtc` (UTC). */
export function msUntilHour(hourUtc: number, now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Plant die tägliche Sicherung; gibt eine Funktion zum Beenden zurück. */
export function scheduleDailyBackup(
  run: () => void,
  hourUtc: number,
  onError: (error: unknown) => void,
): () => void {
  let timer: NodeJS.Timeout;
  const plan = () => {
    timer = setTimeout(() => {
      try {
        run();
      } catch (error) {
        onError(error);
      }
      plan();
    }, msUntilHour(hourUtc));
    // Der Zeitgeber allein hält den Prozess nicht am Leben (Tests, sauberes Beenden).
    timer.unref();
  };
  plan();
  return () => clearTimeout(timer);
}
