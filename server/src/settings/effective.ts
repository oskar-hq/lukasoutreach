import { SETTING_KEYS, SETTINGS, type SettingKey, type SettingValue } from '../../../shared/settings.js';
import { formatWorkDays, loadConfig, type Config } from '../config.js';
import { openDatabase, type Database } from '../db/database.js';
import { SecretBox } from './crypto.js';
import { SettingsStore } from './store.js';
import { definitionOf, toEnv, validateValue } from './validate.js';

/**
 * Wirksame Werte (Vertrag `shared/settings.ts`): in der Software gesetzt → `.env` → Standard. Eine gemeinsame
 * Funktion für den Server UND alle Server-Befehle: Software-Werte werden über die Umgebung gelegt und mit derselben
 * `loadConfig` gelesen wie die `.env`. Ein ungültiger oder nicht lesbarer Software-Wert lässt den Start nie scheitern –
 * er wird übersprungen (es gilt `.env`/Standard) und als `problem` gemeldet. Nur Fehler in der `.env` stoppen den Start.
 */

export type Env = NodeJS.ProcessEnv;

export interface Effective {
  /** Mit Software-Werten. */
  config: Config;
  /** Nur `.env` und Standard – was ohne Software-Wert gälte. */
  baseConfig: Config;
  /** Die Umgebung, aus der `config` gelesen wurde. */
  overlay: Env;
  baseEnv: Env;
  /** Angewandte Software-Werte (leer im Notfallmodus). */
  software: Map<SettingKey, SettingValue>;
  /** Alles, was in der Software gespeichert ist (auch im Notfallmodus, auch Ungültiges mit Wert null). */
  stored: Map<SettingKey, { secret: boolean; value: SettingValue | null }>;
  problems: Map<SettingKey, string>;
  safeMode: boolean;
}

/** Leere Umgebungsvariablen zählen wie „nicht gesetzt“ – `''` aus der Software dagegen überdeckt bewusst. */
const envText = (value: string | undefined) => (value && value.trim() ? value.trim() : null);

export function loadEffective(baseEnv: Env, store: SettingsStore, now = Date.now()): Effective {
  const baseConfig = loadConfig(baseEnv);
  const safeMode = baseConfig.settings.safeMode;
  // Abgelaufene Probe vor allem anderen zurücksetzen (auch beim Start und in den Server-Befehlen).
  if (!safeMode) {
    const trial = store.trial();
    if (trial && trial.revertsAt <= now) {
      store.revertTrial(now);
      store.addHistory({ at: now, username: trial.username, ip: null, key: trial.keys[0], action: 'reverted' });
    }
  } else if (store.trial()) {
    store.clearTrial();
    store.bump();
  }

  const problems = new Map<SettingKey, string>();
  const stored = new Map<SettingKey, { secret: boolean; value: SettingValue | null }>();
  const valid = new Map<SettingKey, SettingValue>();
  for (const row of store.all()) {
    stored.set(row.key, { secret: row.secret, value: row.value });
    const definition = definitionOf(row.key);
    if (!definition || definition.readOnlyReason) continue;
    if (row.value === null) {
      if (row.problem) problems.set(row.key, row.problem);
      continue;
    }
    const checked = validateValue(definition, row.value);
    if (!checked.ok) {
      problems.set(row.key, `Der gespeicherte Wert ist ungültig (${checked.message}) und wird ignoriert.`);
      continue;
    }
    valid.set(row.key, checked.value);
  }

  const software = new Map<SettingKey, SettingValue>();
  if (!safeMode) for (const key of SETTING_KEYS) if (valid.has(key)) software.set(key, valid.get(key)!);

  // Zusammen lesen; scheitert `loadConfig` (Querregel), Software-Werte von hinten nach vorn weglassen.
  const keys = [...software.keys()];
  for (;;) {
    const overlay: Env = { ...baseEnv };
    for (const key of keys) overlay[key] = toEnv(software.get(key)!);
    try {
      const config = loadConfig(overlay);
      for (const key of [...software.keys()]) if (!keys.includes(key)) software.delete(key);
      return { config, baseConfig, overlay, baseEnv, software, stored, problems, safeMode };
    } catch (error) {
      const dropped = keys.pop();
      if (!dropped) throw error;
      problems.set(dropped, 'Passt nicht zu den übrigen Einstellungen und wird ignoriert.');
    }
  }
}

/** Server und Befehle: Konfiguration inklusive Software-Werten aus dem Datenordner. */
export function loadConfigWithSettings(env: Env = process.env): Config {
  const base = loadConfig(env);
  let db: Database | null = null;
  try {
    db = openDatabase(base.dataDir);
    const store = new SettingsStore(db, new SecretBox(base.dataDir, base.settings.key));
    return loadEffective(env, store).config;
  } catch (error) {
    // Die Datenbank kommt nicht in Frage (z. B. Rechte): mit .env und Standard weiterarbeiten (Fehler der .env wirft
    // schon `loadConfig` oben).
    console.error(`Hinweis: Einstellungen aus der Software konnten nicht gelesen werden (${error instanceof Error ? error.message : String(error)}) – es gelten .env und Standard.`);
    return base;
  } finally {
    db?.close();
  }
}

// ── Wert je Schlüssel, wie das Backend ihn wirksam verwendet ─────────────────

/** Nicht-geheime Werte aus der Konfiguration (null = nicht gesetzt). */
export function valueOf(key: SettingKey, config: Config, env: Env): SettingValue | null {
  switch (key) {
    case 'MAX_RESULTS': return config.maxResults;
    case 'SEARCH_HITS_PER_RUN': return config.searchHits;
    case 'AUTO_QUALIFY_TERMS': return config.autoQualifyTerms.length ? config.autoQualifyTerms.join(', ') : 'off';
    case 'LEAD_DISTRIBUTION': return config.leadDistribution;
    case 'QUALIFY_MIN_CONFIDENCE': return config.minConfidence;
    case 'UNIPILE_DSN': return config.unipile.dsn;
    case 'UNIPILE_ACCOUNT_ID': return config.unipile.accountId;
    case 'UNIPILE_SEARCH_API': return config.unipile.searchApi;
    case 'UNIPILE_LOCATION_ID': return config.unipile.locationId;
    case 'UNIPILE_FETCH_COMPANY': return config.unipile.fetchCompany;
    case 'LINKEDIN_ACTIONS': return config.linkedin.actionsOn ? 'on' : 'off';
    case 'UNIPILE_ACCOUNT_NICK': return config.linkedin.accounts.nick;
    case 'UNIPILE_ACCOUNT_JOHANNES': return config.linkedin.accounts.johannes;
    case 'UNIPILE_WARMUP_ACCOUNTS': return config.linkedin.warmupAccounts.join(',') || null;
    case 'UNIPILE_ACCOUNTS_USED': return config.unipile.usedAccounts.join(',') || null;
    case 'LINKEDIN_WARMUP_PER_DAY': return config.linkedin.warmupPerDay;
    case 'LINKEDIN_INVITES_PER_DAY': return config.linkedin.invitesPerDay;
    case 'LINKEDIN_ACCOUNT_FALLBACK': return config.linkedin.accountFallback ? 'on' : 'off';
    case 'LINKEDIN_INVITES_PER_WEEK': return config.linkedin.invitesPerWeek;
    case 'LINKEDIN_MESSAGES_PER_DAY': return config.linkedin.messagesPerDay;
    case 'LINKEDIN_WORK_HOURS': return `${config.linkedin.workHours.fromHour}-${config.linkedin.workHours.toHour}`;
    case 'LINKEDIN_WORK_DAYS': return formatWorkDays(config.linkedin.workHours.days);
    case 'LINKEDIN_TIMEZONE': return config.linkedin.workHours.timeZone;
    case 'LINKEDIN_PAUSE_SECONDS': return `${config.linkedin.pauseMs[0] / 1000}-${config.linkedin.pauseMs[1] / 1000}`;
    case 'LINKEDIN_SYNC_MINUTES': return config.linkedin.syncMinutes;
    case 'ANTHROPIC_MODEL': return config.anthropic.model;
    case 'META_GRAPH_VERSION': return config.meta.graphVersion;
    case 'ENRICHMENT_PROVIDER': return config.enrichmentProvider;
    case 'TREG_MAX_COST_USD': return config.treg.maxCostUsd;
    case 'CLOSE_STATUS_ID': return config.close.statusId;
    case 'CRM_HANDOVER': return config.close.handover;
    case 'LOST_DELETE_DAYS': return config.retention.lostDeleteDays === null ? 'off' : config.retention.lostDeleteDays;
    case 'ENRICH_AUTO': return config.clay.autoEnrich;
    case 'ENRICH_MAX_PER_DAY': return config.clay.dailyLimit;
    case 'FOLLOWUP_AFTER_DAYS': return config.tasks.followUpAfterDays;
    case 'MAX_FOLLOW_UPS': return config.tasks.maxFollowUps;
    case 'NEW_LEADS_PER_DAY': return config.tasks.newLeadsPerDay;
    case 'INVITE_STALE_DAYS': return config.tasks.inviteStaleDays;
    case 'INVITE_NOTE': return config.tasks.inviteNote ? 'on' : 'off';
    case 'BACKUP_HOUR_UTC': return config.backup.hourUtc === null ? 'off' : config.backup.hourUtc;
    case 'BACKUP_KEEP': return config.backup.keep;
    case 'BACKUP_MAX_AGE_DAYS': return config.backup.maxAgeDays;
    case 'UPDATE_AUTO': return config.update.auto;
    case 'UPDATE_HOUR': return config.update.hour;
    case 'PUBLIC_URL': return config.auth.publicUrl;
    case 'AUTH_COOKIE_SECURE': return config.auth.cookieSecure;
    case 'TRUST_PROXY_HOPS': return config.auth.trustProxyHops;
    case 'DATA_DIR': return config.dataDir;
    case 'PORT': return config.port;
    case 'HOST': return config.host;
    case 'SETTINGS_SAFE_MODE': return config.settings.safeMode;
    default: return envText(env[key]);
  }
}

/** Geheimnisse (Klartext, nie ausliefern – nur für `set` und `hint`). */
export function secretOf(key: SettingKey, config: Config): string | null {
  switch (key) {
    case 'UNIPILE_API_KEY': return config.unipile.apiKey;
    case 'ANTHROPIC_API_KEY': return config.anthropic.apiKey;
    case 'META_ACCESS_TOKEN': return config.meta.accessToken;
    case 'TREG_TOKEN': return config.treg.token;
    case 'CLOSE_API_KEY': return config.close.apiKey;
    case 'SLACK_WEBHOOK_URL': return config.slack.webhookUrl;
    case 'CLAY_WEBHOOK_URL': return config.clay.webhookUrl;
    case 'CLAY_WEBHOOK_TOKEN': return config.clay.webhookToken;
    case 'CLAY_CALLBACK_SECRET': return config.clay.callbackSecret;
    default: return null;
  }
}

/** Aus welcher Quelle der Wert ohne Software-Wert käme. */
export function fallbackSource(key: SettingKey, baseEnv: Env): 'env' | 'default' {
  if (envText(baseEnv[key]) !== null) return 'env';
  // Ersatznamen aus der Zeit vor den Einstellungen
  if (key === 'ENRICH_AUTO' && envText(baseEnv.CLAY_AUTO_ENRICH) !== null) return 'env';
  if (key === 'ENRICH_MAX_PER_DAY' && envText(baseEnv.CLAY_MAX_PER_DAY) !== null) return 'env';
  return 'default';
}

export const KNOWN_KEYS = new Set<string>(SETTINGS.map((definition) => definition.key));
