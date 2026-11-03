import { loadConfigWithSettings } from './settings/effective.js';
import { MANUAL_BACKUP_PREFIX, writeBackup } from './db/backup.js';
import { openDatabase } from './db/database.js';

/**
 * Sofort-Sicherung der Datenbank (zusätzlich zur täglichen; heißt „manuell-…“, wie „Jetzt sichern“ in der Oberfläche):
 *   docker compose exec backend node dist/server/src/backupCli.js
 * Lokal: npm run backup --prefix server
 */
const config = loadConfigWithSettings();
const db = openDatabase(config.dataDir);
try {
  console.log(`Gesichert: ${writeBackup(db, config.dataDir, MANUAL_BACKUP_PREFIX, config.backup.keep, new Date(), config.backup.maxAgeDays)}`);
} finally {
  db.close();
}
