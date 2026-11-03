import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { MANUAL_BACKUP_PREFIX, backupDatabase, backupDir, msUntilHour, writeBackup } from '../src/db/backup.js';
import { openDatabase } from '../src/db/database.js';
import { LeadStore } from '../src/leads/leadStore.js';
import { tempDataDir } from './helpers.js';

test('Sicherung: vollständige Kopie, nur die neuesten werden behalten', () => {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  new LeadStore(db).resetDemo();

  const files: string[] = [];
  for (let day = 1; day <= 4; day++) files.push(backupDatabase(db, dataDir, 3, new Date(Date.UTC(2026, 9, day, 2))));
  assert.deepEqual(readdirSync(backupDir(dataDir)), [
    'cockpit-2026-10-02T02-00-00Z.db',
    'cockpit-2026-10-03T02-00-00Z.db',
    'cockpit-2026-10-04T02-00-00Z.db',
  ]);

  const copy = new DatabaseSync(files.at(-1)!, { readOnly: true });
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM leads').get() as { n: number }).n, 30);
  assert.ok((copy.prepare('SELECT COUNT(*) AS n FROM lead_events').get() as { n: number }).n > 30);
  copy.close();
  db.close();
});

test('Zeitplan: nächste Sicherung zur eingestellten Stunde (UTC)', () => {
  const now = new Date(Date.UTC(2026, 9, 3, 12, 30));
  assert.equal(msUntilHour(2, now), 13.5 * 60 * 60 * 1000, 'morgen 02:00');
  assert.equal(msUntilHour(13, now), 30 * 60 * 1000, 'heute 13:00');
  assert.equal(msUntilHour(12, new Date(Date.UTC(2026, 9, 3, 12, 0))), 24 * 60 * 60 * 1000, 'genau jetzt → morgen');
});

test('Konfiguration der Sicherung', () => {
  assert.deepEqual(loadConfig({}).backup, { hourUtc: 2, keep: 14, maxAgeDays: 7 });
  assert.deepEqual(loadConfig({ BACKUP_HOUR_UTC: 'off', BACKUP_KEEP: '30', BACKUP_MAX_AGE_DAYS: '3' }).backup, { hourUtc: null, keep: 30, maxAgeDays: 3 });
  assert.throws(() => loadConfig({ BACKUP_HOUR_UTC: '25' }), /BACKUP_HOUR_UTC/);
});

test('Sicherungen werden nach 7 Tagen gelöscht – geplante und von Hand, die neueste bleibt immer', () => {
  const dataDir = tempDataDir();
  const db = openDatabase(dataDir);
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 2));
  writeBackup(db, dataDir, MANUAL_BACKUP_PREFIX, 14, at(1), 7);
  for (let day = 1; day <= 9; day++) backupDatabase(db, dataDir, 14, at(day));
  // Am 10.: alles vor dem 3. (älter als 7 Tage) fliegt raus, auch die Sicherung von Hand.
  writeBackup(db, dataDir, MANUAL_BACKUP_PREFIX, 14, at(10), 7);
  assert.deepEqual(readdirSync(backupDir(dataDir)).sort(), [
    'cockpit-2026-10-03T02-00-00Z.db',
    'cockpit-2026-10-04T02-00-00Z.db',
    'cockpit-2026-10-05T02-00-00Z.db',
    'cockpit-2026-10-06T02-00-00Z.db',
    'cockpit-2026-10-07T02-00-00Z.db',
    'cockpit-2026-10-08T02-00-00Z.db',
    'cockpit-2026-10-09T02-00-00Z.db',
    'manuell-2026-10-10T02-00-00Z.db',
  ]);
  // Lange keine Sicherung: die gerade angelegte bleibt, auch wenn die Uhr weit springt.
  writeBackup(db, dataDir, MANUAL_BACKUP_PREFIX, 14, at(40), 7);
  assert.deepEqual(readdirSync(backupDir(dataDir)), ['manuell-2026-11-09T02-00-00Z.db']);
  db.close();
});
