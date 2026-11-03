import type { AuthFounderId } from '../../shared/auth.js';
import { UNIPILE_LIMITS } from './linkedin/accountUsage.js';
import { WARMUP_MAX_PER_DAY } from '../../shared/linkedin.js';
import { MAX_RESULTS_DEFAULT, SEARCH_HITS_DEFAULT, SEARCH_HITS_MAX, SEARCH_HITS_MIN, clampMaxResults, type LeadSearchMode } from '../../shared/leadSearch.js';
import { LEAD_DISTRIBUTIONS, type LeadDistribution } from '../../shared/leads.js';
import { AUTO_QUALIFY_DEFAULT_TERMS } from '../../shared/settings.js';

/** Standardmodell für die Qualifizierung – über ANTHROPIC_MODEL änderbar. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
/** Aktuelle Graph-API-Version für die Meta-Werbebibliothek (laut offiziellem Meta-Business-SDK) – über META_GRAPH_VERSION änderbar. */
export const DEFAULT_META_GRAPH_VERSION = 'v26.0';

export interface Config {
  mode: LeadSearchMode;
  port: number;
  host: string;
  /** Ablage für die Tracking-Liste (im Container ein Docker-Volume). */
  dataDir: string;
  /** Voreinstellung für „Max. Anzahl“ – nie über 25. */
  maxResults: number;
  /** Suchtreffer pro Lauf (`SEARCH_HITS_PER_RUN`, 20–1000) – kosten Suchseiten, keine Profilbesuche. */
  searchHits: number;
  /** Stichwörter für die Qualifizierung ohne KI (`AUTO_QUALIFY_TERMS`) – leer = aus. */
  autoQualifyTerms: string[];
  /** Faktor für die simulierten Verzögerungen im Mock-Modus (1 = ca. 15–20 s pro Lauf). */
  mockSpeed: number;
  /** Wem neue Leads gehören (`LEAD_DISTRIBUTION`, Vertrag shared/leads.ts → `LeadDistribution`). */
  leadDistribution: LeadDistribution;
  unipile: {
    dsn: string | null;
    apiKey: string | null;
    accountId: string | null;
    searchApi: 'classic' | 'sales_navigator';
    locationId: string | null;
    fetchCompany: boolean;
  };
  anthropic: {
    apiKey: string | null;
    model: string;
    /** Kurs Dollar → Euro für die KI-Kosten im Dashboard (`AI_USD_EUR_RATE`, Standard 0,86). */
    usdToEur: number;
  };
  /** Meta Ad Library API – prüft, ob eine Firma gerade Meta-Ads schaltet. */
  meta: {
    accessToken: string | null;
    graphVersion: string;
  };
  /** Unter dieser Sicherheit gilt ein Lead nie als qualifiziert („streng ausgelegt“). */
  minConfidence: number;
  /** Tagesstapel (Vertrag `shared/tasks.ts`). */
  tasks: {
    followUpAfterDays: number;
    maxFollowUps: number;
    newLeadsPerDay: number;
    inviteStaleDays: number;
    /** Notiz zur Vernetzungsanfrage anbieten (`INVITE_NOTE` on/off, Standard on). */
    inviteNote: boolean;
  };
  /** Tägliche Sicherung der Datenbank: Stunde in UTC (null = aus), Anzahl aufbewahrter Kopien, Löschen nach Tagen. */
  backup: {
    hourUtc: number | null;
    keep: number;
    maxAgeDays: number;
  };
  /** Quelle der Firmendaten (Vertrag `shared/enrichment.ts`): treg (Standard, Entscheidung 05.10.) oder clay. */
  enrichmentProvider: 'treg' | 'clay';
  /** Treg (treg.to): Token und Adresse (Adresse nur für Tests änderbar). */
  treg: { token: string | null; baseUrl: string; maxCostUsd: number };
  /** Übergabe an Close (Vertrag `shared/crm.ts`). Live nur mit API-Schlüssel. */
  close: { apiKey: string | null; statusId: string | null; baseUrl: string; handover: boolean };
  /** Slack-Nachricht bei neuer Antwort (Incoming Webhook, nur https://hooks.slack.com/…). */
  slack: { webhookUrl: string | null };
  /** Datenschutz: Leads in „Verloren“ nach so vielen Tagen löschen; null = nie. */
  retention: { lostDeleteDays: number | null };
  /** Clay-Anreicherung (Vertrag `shared/enrichment.ts`). Live nur mit Webhook-Adresse und Rückkanal-Schlüssel. */
  clay: {
    /** Webhook der Clay-Tabelle, an die Leads geschickt werden. */
    webhookUrl: string | null;
    /** Optionaler Schlüssel des Clay-Webhooks (Header `x-clay-webhook-auth`). */
    webhookToken: string | null;
    /** Geheimer Schlüssel, den Clay beim Rückkanal mitschickt (Header `x-cockpit-secret`). */
    callbackSecret: string | null;
    /** Neue Leads mit Score Hoch/Mittel automatisch anreichern (Standard: Simulation an, live aus – kostet Credits). */
    autoEnrich: boolean;
    /** Höchstens so viele Anfragen am Tag (UTC). */
    dailyLimit: number;
  };
  /** Echte LinkedIn-Aktionen (Vertrag `shared/linkedin.ts`). */
  linkedin: {
    /** Simulation: simuliert · live: nur mit LINKEDIN_ACTIONS=on, sonst aus. */
    enabled: boolean;
    /** Der Schalter LINKEDIN_ACTIONS selbst (Einstellungen zeigen ihn auch in der Simulation unverändert an). */
    actionsOn: boolean;
    /** Unipile-Account je Gründer (UNIPILE_ACCOUNT_NICK / _JOHANNES). */
    accounts: Record<AuthFounderId, string | null>;
    /** Aufzuwärmende Scraping-Accounts (`UNIPILE_WARMUP_ACCOUNTS`, Wunsch des Nutzers 21.10.). */
    warmupAccounts: string[];
    /** Aufwärm-Anfragen je Account und Tag (`LINKEDIN_WARMUP_PER_DAY`, höchstens `WARMUP_MAX_PER_DAY`). */
    warmupPerDay: number;
    invitesPerDay: number;
    /** `LINKEDIN_ACCOUNT_FALLBACK`: Anfragen über den Account des anderen Gründers, wenn der eigene voll ist. */
    accountFallback: boolean;
    invitesPerWeek: number;
    messagesPerDay: number;
    workHours: { fromHour: number; toHour: number; days: number[]; timeZone: string };
    /** Zufällige Pause zwischen zwei Aktionen eines Accounts (ms). */
    pauseMs: [number, number];
    /** Automatischer Abgleich (angenommene Anfragen, Antworten) alle n Minuten; 0 = aus. */
    syncMinutes: number;
  };
  /**
   * Software-Updates (Vertrag `shared/system.ts`): nachts automatisch einspielen und zu welcher Stunde (deutsche Zeit).
   * Liest der Update-Planer bei jeder Prüfung aus der laufenden Konfiguration – Änderungen wirken ohne Neustart.
   */
  update: { auto: boolean; hour: number };
  /** Einstellungen in der Software (Vertrag `shared/settings.ts`) – immer nur aus der `.env`. */
  settings: {
    /** Notfallmodus: Werte aus der Software werden ignoriert. */
    safeMode: boolean;
    /** Schlüssel für gespeicherte Geheimnisse (32 Byte, base64 oder 64 Hex-Zeichen); leer = Datei im Datenordner. */
    key: string | null;
    /** Dauer einer Probe-Änderung (Standard 300 s; für Tests verkürzbar). */
    trialSeconds: number;
  };
  /** Anmeldung (Vertrag `shared/auth.ts`). */
  auth: {
    /** Öffentliche Adresse für Einladungslinks (PUBLIC_URL, ohne abschließenden „/“) – null, wenn nicht gesetzt. */
    publicUrl: string | null;
    /** Testkonten nick/johannes mit Passwort „demo“ – nur Entwicklung, E2E-Tests, Testserver. */
    demoAccounts: boolean;
    /** Sitzungs-Cookie nur über HTTPS. Aus nur lokal oder im Heimnetz über http. */
    cookieSecure: boolean;
    /** Anzahl vertrauter Proxys vor dem Backend (für die Client-IP aus X-Forwarded-For). Wirksam höchstens 1 (nginx). */
    trustProxyHops: number;
    /** Fester Einrichtungs-Schlüssel für das erste Konto (SETUP_TOKEN) – null = Zufallsschlüssel im Datenordner. */
    setupToken: string | null;
    /**
     * SETUP_TOKEN war gesetzt, aber kürzer als {@link SETUP_TOKEN_MIN_LENGTH} Zeichen: wird ignoriert (Warnung beim
     * Start; ohne Konto gilt der Zufallsschlüssel im Datenordner). Kein Startabbruch – sonst bliebe ein bestehender
     * Server mit kurzem Wert nach dem Auto-Update in der Neustart-Schleife hängen.
     */
    setupTokenIgnored: boolean;
  };
}

/** Mindestlänge für SETUP_TOKEN – ein kurzer, erratbarer Wert wäre eine offene Tür. */
export const SETUP_TOKEN_MIN_LENGTH = 24;

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** „26“, „26.0“ und „v26.0“ sind gleich gemeint. */
function normalizeGraphVersion(value: string): string {
  const trimmed = value.trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`META_GRAPH_VERSION muss z. B. "v26.0" sein (ist: "${value}").`);
  return `v${trimmed.includes('.') ? trimmed : `${trimmed}.0`}`;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  const normalized = text(value)?.toLowerCase();
  if (normalized === undefined || normalized === null) return fallback;
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/** Nicht gesetzt → Standardliste, „off“/„aus“ → keine, sonst Liste mit Komma getrennt. */
function autoQualifyTerms(value: string | undefined): string[] {
  if (value === undefined || !value.trim()) return [...AUTO_QUALIFY_DEFAULT_TERMS];
  if (/^(off|aus)$/i.test(value.trim())) return [];
  return [...new Set(value.split(',').map((term) => term.trim()).filter(Boolean))].slice(0, 30);
}

function number(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
}

/** „8-19“ → [8, 19]; „1-5“ → [1, 2, 3, 4, 5] (1 = Montag … 7 = Sonntag). */
function range(value: string, name: string, min: number, max: number): [number, number] {
  const match = value.trim().match(/^(\d{1,3})\s*-\s*(\d{1,3})$/);
  const from = match ? Number(match[1]) : NaN;
  const to = match ? Number(match[2]) : NaN;
  const example = { LINKEDIN_WORK_HOURS: '8-19', LINKEDIN_WORK_DAYS: '1-5', LINKEDIN_PAUSE_SECONDS: '3-8' }[name] ?? '1-5';
  // Stunden: Ende muss nach dem Anfang liegen; Tage und Pausen dürfen gleich sein („1-1“, „0-0“).
  if (!match || from < min || to > max || (name === 'LINKEDIN_WORK_HOURS' ? from >= to : from > to)) {
    throw new Error(`${name} muss eine Spanne wie "${example}" sein (ist: "${value}").`);
  }
  return [from, to];
}

/** „1-5“ → [1, 2, 3, 4, 5]; „1-5,7“ → [1, 2, 3, 4, 5, 7] (1 = Montag … 7 = Sonntag), sortiert, ohne Doppelte. */
export function parseWorkDays(value: string): number[] | null {
  const days = new Set<number>();
  for (const part of value.replace(/\s+/g, '').split(',')) {
    const match = part.match(/^([1-7])(?:-([1-7]))?$/);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (from > to) return null;
    for (let day = from; day <= to; day++) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/** [1, 2, 3, 4, 5, 7] → „1-5,7“ (für die Anzeige in den Einstellungen). */
export function formatWorkDays(days: number[]): string {
  const parts: string[] = [];
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return parts.join(',');
}

/** Gültige IANA-Zeitzone (laut `Intl`)? */
export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function timeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: value });
    return value;
  } catch {
    throw new Error(`LINKEDIN_TIMEZONE ist keine gültige Zeitzone (ist: "${value}").`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Standard ist der echte Betrieb. `mock` (Simulation ohne Netz) nur für automatische Tests und lokale Entwicklung.
  const rawMode = (text(env.LEAD_SEARCH_MODE) ?? 'live').toLowerCase();
  if (rawMode !== 'mock' && rawMode !== 'live') {
    throw new Error(`LEAD_SEARCH_MODE muss "mock" oder "live" sein (ist: "${rawMode}").`);
  }
  const searchApi = (text(env.UNIPILE_SEARCH_API) ?? 'classic').toLowerCase();
  if (searchApi !== 'classic' && searchApi !== 'sales_navigator') {
    throw new Error(`UNIPILE_SEARCH_API muss "classic" oder "sales_navigator" sein (ist: "${searchApi}").`);
  }
  const dsn = text(env.UNIPILE_DSN);
  const auth = {
    publicUrl: text(env.PUBLIC_URL)?.replace(/\/+$/, '') ?? null,
    demoAccounts: flag(env.AUTH_DEMO_ACCOUNTS, false),
    cookieSecure: flag(env.AUTH_COOKIE_SECURE, true),
    trustProxyHops: Math.max(0, Math.floor(number(env.TRUST_PROXY_HOPS, 1))),
    setupToken: null as string | null,
    setupTokenIgnored: false,
  };
  // Wer den Schlüssel kennt, legt das erste (Gründer-)Konto an – ein kurzer, erratbarer Wert gilt nicht.
  const rawSetupToken = text(env.SETUP_TOKEN);
  if (rawSetupToken && rawSetupToken.length < SETUP_TOKEN_MIN_LENGTH) auth.setupTokenIgnored = true;
  else auth.setupToken = rawSetupToken;
  const lostDelete = (text(env.LOST_DELETE_DAYS) ?? '30').toLowerCase();
  if (lostDelete !== 'off' && !(/^\d+$/.test(lostDelete) && Number(lostDelete) >= 1 && Number(lostDelete) <= 3650)) {
    throw new Error(`LOST_DELETE_DAYS muss eine Zahl 1–3650 oder "off" sein (ist: "${lostDelete}").`);
  }
  const slackWebhook = text(env.SLACK_WEBHOOK_URL);
  if (slackWebhook && !/^https:\/\/hooks\.slack\.com\//.test(slackWebhook)) {
    throw new Error('SLACK_WEBHOOK_URL muss mit https://hooks.slack.com/ beginnen.');
  }
  const backupHour = (text(env.BACKUP_HOUR_UTC) ?? '2').toLowerCase();
  if (backupHour !== 'off' && !/^([01]?\d|2[0-3])$/.test(backupHour)) {
    throw new Error(`BACKUP_HOUR_UTC muss eine Stunde 0–23 oder "off" sein (ist: "${backupHour}").`);
  }
  // Leitplanke: Testkonten mit bekanntem Passwort nie auf einem öffentlichen Server (dort läuft immer HTTPS).
  if (auth.demoAccounts && auth.cookieSecure) {
    throw new Error(
      'AUTH_DEMO_ACCOUNTS=true ist nur zusammen mit AUTH_COOKIE_SECURE=false erlaubt (lokale Entwicklung, Tests, Testserver im Heimnetz). Auf einem öffentlichen Server Testkonten nie einschalten.',
    );
  }
  const callbackSecret = text(env.CLAY_CALLBACK_SECRET);
  if (callbackSecret && callbackSecret.length < 24) {
    throw new Error('CLAY_CALLBACK_SECRET muss mindestens 24 Zeichen lang sein (z. B. openssl rand -hex 32).');
  }
  const webhookUrl = text(env.CLAY_WEBHOOK_URL);
  // http nur für lokale Testserver.
  if (webhookUrl && !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(webhookUrl)) {
    throw new Error('CLAY_WEBHOOK_URL muss mit https:// beginnen.');
  }
  return {
    mode: rawMode,
    port: number(env.PORT, 8787),
    host: text(env.HOST) ?? '0.0.0.0',
    dataDir: text(env.DATA_DIR) ?? 'data',
    maxResults: clampMaxResults(number(env.MAX_RESULTS, MAX_RESULTS_DEFAULT)),
    autoQualifyTerms: autoQualifyTerms(env.AUTO_QUALIFY_TERMS),
    searchHits: Math.min(SEARCH_HITS_MAX, Math.max(SEARCH_HITS_MIN, Math.floor(number(env.SEARCH_HITS_PER_RUN, SEARCH_HITS_DEFAULT)))),
    mockSpeed: Math.max(0, number(env.MOCK_SPEED, 1)),
    leadDistribution: (() => {
      const value = (text(env.LEAD_DISTRIBUTION) ?? 'owner').toLowerCase();
      if (!(LEAD_DISTRIBUTIONS as readonly string[]).includes(value)) {
        throw new Error(`LEAD_DISTRIBUTION muss "owner" oder "balanced" sein (ist: "${value}").`);
      }
      return value as LeadDistribution;
    })(),
    unipile: {
      // „api68.unipile.com:19881“ ist genauso erlaubt wie die volle URL.
      dsn: dsn ? (dsn.startsWith('http') ? dsn : `https://${dsn}`).replace(/\/+$/, '') : null,
      apiKey: text(env.UNIPILE_API_KEY),
      accountId: text(env.UNIPILE_ACCOUNT_ID),
      searchApi,
      locationId: text(env.UNIPILE_LOCATION_ID),
      fetchCompany: (text(env.UNIPILE_FETCH_COMPANY) ?? 'true').toLowerCase() !== 'false',
    },
    anthropic: {
      apiKey: text(env.ANTHROPIC_API_KEY),
      model: text(env.ANTHROPIC_MODEL) ?? DEFAULT_ANTHROPIC_MODEL,
      usdToEur: (() => {
        const value = number(env.AI_USD_EUR_RATE, 0.86);
        if (value <= 0 || value > 10) throw new Error(`AI_USD_EUR_RATE muss größer 0 und höchstens 10 sein (ist: "${env.AI_USD_EUR_RATE}").`);
        return value;
      })(),
    },
    meta: {
      accessToken: text(env.META_ACCESS_TOKEN),
      graphVersion: normalizeGraphVersion(text(env.META_GRAPH_VERSION) ?? DEFAULT_META_GRAPH_VERSION),
    },
    minConfidence: Math.min(1, Math.max(0, number(env.QUALIFY_MIN_CONFIDENCE, 0.6))),
    tasks: {
      followUpAfterDays: Math.max(1, Math.floor(number(env.FOLLOWUP_AFTER_DAYS, 2))),
      maxFollowUps: Math.max(0, Math.floor(number(env.MAX_FOLLOW_UPS, 3))),
      newLeadsPerDay: Math.max(0, Math.floor(number(env.NEW_LEADS_PER_DAY, 20))),
      inviteStaleDays: Math.max(1, Math.floor(number(env.INVITE_STALE_DAYS, 14))),
      inviteNote: (text(env.INVITE_NOTE) ?? 'on').toLowerCase() !== 'off',
    },
    backup: {
      hourUtc: backupHour === 'off' ? null : Number(backupHour),
      keep: Math.max(1, Math.floor(number(env.BACKUP_KEEP, 14))),
      maxAgeDays: Math.min(365, Math.max(1, Math.floor(number(env.BACKUP_MAX_AGE_DAYS, 7)))),
    },
    enrichmentProvider: (() => {
      const provider = (text(env.ENRICHMENT_PROVIDER) ?? 'treg').toLowerCase();
      if (provider !== 'treg' && provider !== 'clay') throw new Error(`ENRICHMENT_PROVIDER muss "treg" oder "clay" sein (ist: "${provider}").`);
      return provider;
    })(),
    slack: { webhookUrl: slackWebhook },
    retention: { lostDeleteDays: lostDelete === 'off' ? null : Number(lostDelete) },
    close: {
      apiKey: text(env.CLOSE_API_KEY),
      statusId: text(env.CLOSE_STATUS_ID),
      baseUrl: (text(env.CLOSE_BASE_URL) ?? 'https://api.close.com').replace(/\/+$/, ''),
      // Übergabe an Close anbieten (22.10.): im echten Betrieb erst einmal aus – wir arbeiten mit dem CRM im Cockpit.
      handover: flag(env.CRM_HANDOVER, rawMode === 'mock'),
    },
    treg: {
      token: text(env.TREG_TOKEN),
      baseUrl: (text(env.TREG_BASE_URL) ?? 'https://treg.to').replace(/\/+$/, ''),
      // Obergrenze je Abruf in US-Dollar (X-Treg-Route-Max-Cost). Üblich sind ca. 0,002 $; Treg-Standard wäre 1 $.
      maxCostUsd: (() => {
        const value = number(env.TREG_MAX_COST_USD, 0.05);
        if (value <= 0 || value > 1) throw new Error(`TREG_MAX_COST_USD muss größer 0 und höchstens 1 sein (ist: "${env.TREG_MAX_COST_USD}").`);
        return value;
      })(),
    },
    linkedin: (() => {
      const [fromHour, toHour] = range(text(env.LINKEDIN_WORK_HOURS) ?? '8-19', 'LINKEDIN_WORK_HOURS', 0, 24);
      const workDays = text(env.LINKEDIN_WORK_DAYS) ?? '1-5';
      const days = parseWorkDays(workDays);
      if (!days) throw new Error(`LINKEDIN_WORK_DAYS muss Tage wie "1-5" oder "1-5,7" sein (ist: "${workDays}").`);
      const [pauseFrom, pauseTo] = range(text(env.LINKEDIN_PAUSE_SECONDS) ?? '3-8', 'LINKEDIN_PAUSE_SECONDS', 0, 600);
      const actionsOn = flag(env.LINKEDIN_ACTIONS, false);
      return {
        enabled: rawMode === 'mock' ? true : actionsOn,
        actionsOn,
        accounts: { nick: text(env.UNIPILE_ACCOUNT_NICK), johannes: text(env.UNIPILE_ACCOUNT_JOHANNES) },
        warmupAccounts: [...new Set((text(env.UNIPILE_WARMUP_ACCOUNTS) ?? '').split(',').map((id) => id.trim()).filter(Boolean))],
        warmupPerDay: Math.min(WARMUP_MAX_PER_DAY, Math.max(0, Math.floor(number(env.LINKEDIN_WARMUP_PER_DAY, WARMUP_MAX_PER_DAY)))),
        // Feste Obergrenzen laut Unipile (17.10., `UNIPILE_LIMITS`): niedriger einstellen geht, höher nicht.
        invitesPerDay: Math.min(UNIPILE_LIMITS.invitesPerDay, Math.max(0, Math.floor(number(env.LINKEDIN_INVITES_PER_DAY, 20)))),
        // Wunsch des Nutzers 12.10.: eigener Account voll → über den des anderen Gründers weiter (Standard an).
        accountFallback: (text(env.LINKEDIN_ACCOUNT_FALLBACK) ?? 'on').toLowerCase() !== 'off',
        invitesPerWeek: Math.min(UNIPILE_LIMITS.invitesPerWeek, Math.max(0, Math.floor(number(env.LINKEDIN_INVITES_PER_WEEK, 80)))),
        messagesPerDay: Math.min(UNIPILE_LIMITS.messagesPerDay, Math.max(0, Math.floor(number(env.LINKEDIN_MESSAGES_PER_DAY, 40)))),
        workHours: {
          fromHour,
          toHour,
          days,
          timeZone: timeZone(text(env.LINKEDIN_TIMEZONE) ?? 'Europe/Berlin'),
        },
        pauseMs: [pauseFrom * 1000, pauseTo * 1000] as [number, number],
        syncMinutes: Math.max(0, Math.floor(number(env.LINKEDIN_SYNC_MINUTES, 15))),
      };
    })(),
    clay: {
      webhookUrl,
      webhookToken: text(env.CLAY_WEBHOOK_TOKEN),
      callbackSecret,
      // Gelten für jede Quelle (Namen aus der Clay-Zeit beibehalten; ENRICH_* gehen vor).
      autoEnrich: flag(env.ENRICH_AUTO ?? env.CLAY_AUTO_ENRICH, rawMode === 'mock'),
      dailyLimit: Math.max(0, Math.floor(number(env.ENRICH_MAX_PER_DAY ?? env.CLAY_MAX_PER_DAY, 50))),
    },
    update: {
      auto: flag(env.UPDATE_AUTO, false),
      hour: (() => {
        const hour = text(env.UPDATE_HOUR) ?? '3';
        if (!/^([01]?\d|2[0-3])$/.test(hour)) throw new Error(`UPDATE_HOUR muss eine Stunde 0–23 sein (ist: "${hour}").`);
        return Number(hour);
      })(),
    },
    settings: {
      safeMode: flag(env.SETTINGS_SAFE_MODE, false),
      key: text(env.SETTINGS_KEY),
      trialSeconds: Math.max(1, number(env.SETTINGS_TRIAL_SECONDS, 300)),
    },
    auth,
  };
}

/** Was für den Live-Modus noch fehlt (leer = startklar). */
export function liveProblems(config: Config): string[] {
  const problems: string[] = [];
  if (!config.unipile.dsn) problems.push('Die Unipile-Adresse fehlt (Einstellungen → LinkedIn (Unipile), z. B. https://api68.unipile.com:19881).');
  if (!config.unipile.apiKey) problems.push('Das Unipile-Token fehlt.');
  return problems;
}

/** Satz, warum keine Suche starten kann (Live-Modus nicht startklar) – null = startklar. Gilt von Hand und automatisch. */
export function startProblem(config: Config): string | null {
  const problems = config.mode === 'live' ? liveProblems(config) : [];
  return problems.length ? `Die Lead-Suche ist noch nicht vollständig eingerichtet: ${problems.join(' ')}` : null;
}

export const SHARED_ACCOUNT_MESSAGE = 'Nick und Johannes brauchen je einen eigenen LinkedIn-Account – sonst gelten die Grenzen doppelt.';

/** Beide Gründer auf demselben Unipile-Account (beide gesetzt)? */
export function sharedLinkedInAccount(config: Config): boolean {
  const { nick, johannes } = config.linkedin.accounts;
  return Boolean(nick && johannes && nick === johannes);
}

/**
 * Gründer, auf die neue Leads verteilt werden (`LEAD_DISTRIBUTION=balanced`): alle mit eingetragenem LinkedIn-Account,
 * in fester Reihenfolge. Leer, wenn nicht verteilt wird – bei `owner`, bei weniger als zwei Accounts oder wenn beide
 * Gründer denselben Account haben (dann gehen die Leads wie bisher an den, der gesucht hat).
 */
export function leadDistributionPool(config: Config): AuthFounderId[] {
  if (config.leadDistribution !== 'balanced' || sharedLinkedInAccount(config)) return [];
  // Simulation ohne Zuordnung: es gilt `mock-<gründer>` wie beim Senden (`LinkedInService.accountOf`) – sonst meldete die
  // Oberfläche beide Accounts als verbunden, verteilt wurde aber nicht (25.10.).
  const pool = (['nick', 'johannes'] as const).filter((founder) => config.linkedin.accounts[founder] || config.mode === 'mock');
  return pool.length >= 2 ? pool : [];
}

/** Was im Live-Modus eingeschränkt ist, den Start aber nicht verhindert. */
export function liveWarnings(config: Config): string[] {
  if (config.mode !== 'live') return [];
  const warnings: string[] = [];
  if (sharedLinkedInAccount(config)) warnings.push(`${SHARED_ACCOUNT_MESSAGE} Gesendet wird darum nicht (Einstellungen → Senden über LinkedIn).`);
  // Zwei LinkedIn-Accounts (einer mit Sales Navigator): Ohne UNIPILE_ACCOUNT_ID ist offen, über welchen gesucht wird.
  if (config.unipile.searchApi === 'sales_navigator' && !config.unipile.accountId) {
    warnings.push('Die Suche läuft über Sales Navigator, aber UNIPILE_ACCOUNT_ID ist leer. Trag dort den LinkedIn-Account mit Sales Navigator ein (Such-Account).');
  }
  if (!config.anthropic.apiKey) {
    warnings.push('Ohne Anthropic-API-Schlüssel (Einstellungen → KI-Bewertung) werden Leads gefunden und angereichert, aber nicht von der KI bewertet.');
  } else if (!config.meta.accessToken) {
    warnings.push('Ohne Meta-Token (Einstellungen → Meta-Werbebibliothek) wird nicht geprüft, ob eine Firma gerade Meta-Ads schaltet – qualifizierte Leads bleiben „Meta-Ads nicht geprüft“.');
  }
  return warnings;
}

/**
 * Neue Werte in dieselbe Konfiguration schreiben (verschachtelte Objekte bleiben dieselben Objekte): Alles, was die
 * Konfiguration oder einen Teil davon gemerkt hat, sieht danach die neuen Werte – so wirken Einstellungen ohne Neustart.
 */
export function replaceConfig<T extends object>(target: T, source: T): void {
  const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const t = target as Record<string, unknown>;
  const s = source as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (isPlain(t[key]) && isPlain(s[key])) replaceConfig(t[key] as object, s[key] as object);
    else t[key] = s[key];
  }
}
