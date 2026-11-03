import { SETTING_KEYS, SETTINGS, type SettingKey } from '../../shared/settings.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { SecretBox } from './settings/crypto.js';
import { loadEffective } from './settings/effective.js';
import { SettingsStore } from './settings/store.js';

/**
 * Einstellungen auf dem Server – der Notweg, falls eine Einstellung den Zugang stört (Ausgabe nie mit Werten):
 *   docker compose exec backend node dist/server/src/settingsCli.js list
 *   docker compose exec backend node dist/server/src/settingsCli.js reset AUTH_COOKIE_SECURE
 *   docker compose exec backend node dist/server/src/settingsCli.js reset --all
 * Danach `docker compose up -d backend`. Lokal: npm run settings --prefix server -- list
 */

const USAGE = `Einstellungen

  list              welche Einstellungen in der Software gesetzt sind (nur Namen, nie Werte)
  reset <SCHLÜSSEL> einen Wert aus der Software löschen – es gilt wieder die .env bzw. der Standard
  reset --all       alle Werte aus der Software löschen
`;

const fail = (message: string): never => {
  console.error(`Fehler: ${message}`);
  process.exit(1);
};

const [command, argument] = process.argv.slice(2);
if (!command || command === 'hilfe' || command === '--help') {
  console.log(USAGE);
  process.exit(0);
}

const config = loadConfig();
const db = openDatabase(config.dataDir);
const store = new SettingsStore(db, new SecretBox(config.dataDir, config.settings.key));

if (command === 'list') {
  const effective = loadEffective(process.env, store);
  const keys = [...effective.stored.keys()];
  if (!keys.length) console.log('In der Software ist nichts gesetzt – es gelten .env und Standard.');
  for (const key of SETTING_KEYS.filter((entry) => keys.includes(entry))) {
    const label = SETTINGS.find((entry) => entry.key === key)?.label ?? key;
    const problem = effective.problems.get(key);
    console.log(`${key}  (${label})${effective.safeMode ? '  [Notfallmodus: wird ignoriert]' : ''}${problem ? `  – ${problem}` : ''}`);
  }
  if (effective.safeMode) console.log('\nNotfallmodus ist an (SETTINGS_SAFE_MODE=true): Werte aus der Software werden ignoriert.');
} else if (command === 'reset') {
  if (argument === '--all') {
    const count = store.deleteAll();
    store.clearTrial();
    store.bump();
    console.log(`${count} Wert(e) gelöscht. Danach: docker compose up -d backend`);
  } else if (argument && (SETTING_KEYS as readonly string[]).includes(argument)) {
    console.log(store.delete(argument as SettingKey) ? `${argument} gelöscht. Danach: docker compose up -d backend` : `${argument} war in der Software nicht gesetzt.`);
    store.bump();
  } else {
    fail(`Schlüssel angeben (z. B. AUTH_COOKIE_SECURE) oder --all. Gültig: ${SETTING_KEYS.join(', ')}`);
  }
} else {
  console.log(USAGE);
  fail(`Unbekannter Befehl „${command}“.`);
}
db.close();
