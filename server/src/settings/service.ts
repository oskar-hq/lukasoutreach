import type { FastifyBaseLogger } from 'fastify';
import {
  SETTINGS,
  SETTING_KEYS,
  type AnthropicModelsResponse,
  type SettingDefinition,
  type SettingKey,
  type SettingState,
  type SettingsErrorCode,
  type SettingsHistoryResponse,
  type SettingsResponse,
  type SettingsTestResponse,
  type SettingsTestService,
  type SettingsUpdateRequest,
  type SettingValue,
} from '../../../shared/settings.js';
import { unipileTestResult } from '../adapters/live/liveAdapter.js';
import { MetaAdLibraryClient, MetaApiError, MetaNetworkError } from '../adapters/live/metaAdLibrary.js';
import { UNIPILE_SESSION_DOWN_TEXT, UnipileClient, UnipileHttpError, UnipileNetworkError, isUnipileSessionDown } from '../adapters/live/unipileClient.js';
import type { AccountStore } from '../auth/accounts.js';
import { verifyPassword } from '../auth/password.js';
import { Counter, LoginLimiter } from '../auth/rateLimit.js';
import { hashSessionId, type SessionStore } from '../auth/sessions.js';
import { SHARED_ACCOUNT_MESSAGE, loadConfig, sharedLinkedInAccount, type Config } from '../config.js';
import type { Database } from '../db/database.js';
import { TREG_ENRICH_ID } from '../enrichment/service.js';
import { AnthropicModels } from '../ai/models.js';
import { SecretBox } from './crypto.js';
import { fallbackSource, loadEffective, secretOf, valueOf, type Effective, type Env } from './effective.js';
import { SettingsStore } from './store.js';
import { definitionOf, toEnv, validateValue } from './validate.js';

/**
 * Einstellungen in der Software (Vertrag `shared/settings.ts`): lesen, ändern (Prüfreihenfolge laut Dateikopf des
 * Vertrags), Probe-Änderung mit Beweis über eine neue Sitzung, Verlauf, Verbindungstest. Nach jeder Änderung werden
 * die wirksamen Werte neu gelesen und über `apply` ohne Neustart in Kraft gesetzt.
 */

export class SettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: SettingsErrorCode | 'unauthorized',
    message: string,
    readonly field?: SettingKey,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface Actor {
  username: string;
  ip: string | null;
  /** Sitzungs-ID aus dem Cookie (für die Probe-Änderung). */
  sessionId: string | null;
  /** `Origin`-Kopfzeile der Anfrage (für die Querregel zu AUTH_COOKIE_SECURE). */
  origin: string | null;
}

export interface SettingsDeps {
  /** Die laufende Konfiguration (wird von `apply` ersetzt) – hier nur zum Lesen. */
  config: Config;
  baseEnv: Env;
  db: Database;
  accounts: AccountStore;
  sessions: SessionStore;
  /** Wirksame Konfiguration in Kraft setzen (Adapter neu bauen, Sicherung neu planen …). */
  apply: (config: Config) => void | Promise<void>;
  /** Läuft gerade eine Lead-Suche? */
  runActive: () => boolean;
  log: FastifyBaseLogger;
  /** Nur Tests: fetch und Basisadressen der Dienste für den Verbindungstest. */
  fetch?: typeof fetch;
  anthropicBaseUrl?: string;
  metaBaseUrl?: string;
}

export interface UpdateResult {
  response: SettingsResponse;
  /** Neue Sitzung für die Probe-Änderung – die Route setzt das Cookie. */
  newSession?: { id: string; remember: boolean };
}

const TEST_PER_SERVICE_MS = 10_000;
const TEST_PER_HOUR = { max: 20, windowMs: 60 * 60 * 1000 };
const SERVICES: readonly SettingsTestService[] = ['unipile', 'anthropic', 'meta', 'treg', 'close', 'slack'];
/** Treg hat keinen kostenlosen Prüf-Abruf: eine Firma, die jeder Anbieter kennt (ca. 0,2 Cent). */
const TREG_TEST_DOMAIN = 'bosch.de';
const TEST_TIMEOUT_MS = 15_000;
export const SLACK_TEST_TEXT = 'Test aus dem Outreach Cockpit – Slack ist verbunden.';

/** Netzfehler beim Verbindungstest (ohne Adresse, ohne Antworttext). */
class TestNetworkError extends Error {
  constructor() {
    super('Nicht erreichbar.');
    this.name = 'TestNetworkError';
  }
}

const hint = (secret: string | null): { set: boolean; hint: string | null } => ({
  set: Boolean(secret),
  hint: secret && secret.length >= 12 ? secret.slice(-4) : null,
});

const ACCOUNT_SETTING_KEYS = ['UNIPILE_ACCOUNT_JOHANNES', 'UNIPILE_ACCOUNT_NICK'] as const;

export class SettingsService {
  readonly store: SettingsStore;
  /** Fehlversuche bei Passwort-Abfragen – auch für `/api/system/*` (gemeinsamer Zähler). */
  readonly limiter = new LoginLimiter();
  private readonly testHour = new Counter(TEST_PER_HOUR);
  private readonly testLast = new Map<string, number>();
  private trialTimer: NodeJS.Timeout | null = null;
  private readonly anthropicModels: AnthropicModels;

  constructor(private readonly deps: SettingsDeps) {
    this.anthropicModels = new AnthropicModels({ baseURL: deps.anthropicBaseUrl, fetch: deps.fetch });
    this.store = new SettingsStore(deps.db, new SecretBox(deps.config.dataDir, deps.config.settings.key));
    this.scheduleTrial();
  }

  close(): void {
    if (this.trialTimer) clearTimeout(this.trialTimer);
    this.trialTimer = null;
  }

  private effective(now = Date.now()): Effective {
    return loadEffective(this.deps.baseEnv, this.store, now);
  }

  // ── Lesen ──────────────────────────────────────────────────────────────

  private state(definition: SettingDefinition, eff: Effective): SettingState {
    const { key } = definition;
    const software = eff.software.has(key);
    const base: SettingState = {
      key,
      source: software ? 'software' : fallbackSource(key, eff.baseEnv),
      fallbackSource: fallbackSource(key, eff.baseEnv),
    };
    const problem = eff.problems.get(key);
    if (problem) base.problem = problem;
    if (eff.safeMode) {
      const stored = eff.stored.get(key);
      if (stored) {
        base.stored = definition.type === 'secret' ? { secret: hint(stored.value === null ? null : String(stored.value)) } : { value: stored.value };
      }
    }
    if (definition.type === 'secret') {
      return { ...base, secret: hint(secretOf(key, eff.config)), fallbackSecret: hint(secretOf(key, eff.baseConfig)) };
    }
    return { ...base, value: valueOf(key, eff.config, eff.baseEnv), fallback: valueOf(key, eff.baseConfig, eff.baseEnv) };
  }

  get(clientIp: string, now = Date.now()): SettingsResponse {
    const eff = this.effective(now);
    const trial = this.store.trial();
    return {
      settings: SETTINGS.map((definition) => this.state(definition, eff)),
      trial: trial ? { keys: trial.keys, revertsAt: trial.revertsAt, username: trial.username } : null,
      safeMode: eff.safeMode,
      version: this.store.version(),
      serverTime: now,
      clientIp,
    };
  }

  history(): SettingsHistoryResponse {
    return { entries: this.store.history(100) };
  }

  // ── Ändern ─────────────────────────────────────────────────────────────

  async update(request: SettingsUpdateRequest, actor: Actor, now = Date.now()): Promise<UpdateResult> {
    // 1 · Aufbau der Anfrage, unbekannte Schlüssel
    const changes = request?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
      throw new SettingsError(400, 'invalid_setting', 'Es gibt nichts zu ändern.');
    }
    const keys = Object.keys(changes) as SettingKey[];
    for (const key of keys) {
      if (!definitionOf(key)) throw new SettingsError(400, 'invalid_setting', `„${key}“ ist keine bekannte Einstellung.`, key);
    }
    // In Reihenfolge des Katalogs (für „erster betroffener Schlüssel“)
    const ordered = SETTING_KEYS.filter((key) => keys.includes(key));
    const definitions = new Map(ordered.map((key) => [key, definitionOf(key)!] as const));
    const eff = this.effective(now);

    // 2 · Nur über die .env änderbar; Notfallmodus: nur Löschen
    for (const key of ordered) {
      const definition = definitions.get(key)!;
      if (definition.readOnlyReason) throw new SettingsError(409, 'setting_read_only', `„${definition.label}“ lässt sich nur über die .env ändern: ${definition.readOnlyReason}`, key);
    }
    if (eff.safeMode) {
      const key = ordered.find((entry) => changes[entry] !== null);
      if (key) throw new SettingsError(409, 'setting_read_only', 'Im Notfallmodus lassen sich Werte nur löschen, nicht ändern.', key);
    }

    // 3 · Stand
    if (request.version !== undefined && request.version !== this.store.version()) {
      throw new SettingsError(409, 'settings_changed', 'Inzwischen hat jemand anderes gespeichert. Bitte lade die Einstellungen neu.');
    }

    // 4 · Probe-Schlüssel allein, keine zweite Probe
    const trialKeys = eff.safeMode ? [] : ordered.filter((key) => definitions.get(key)!.trial);
    if (trialKeys.length) {
      const other = ordered.find((key) => !trialKeys.includes(key));
      if (other) {
        throw new SettingsError(400, 'invalid_setting', 'Diese Einstellungen gelten zuerst auf Probe und müssen einzeln gespeichert werden.', other);
      }
      if (this.store.trial()) {
        throw new SettingsError(409, 'trial_pending', 'Eine Probe-Änderung läuft noch. Bestätige sie oder setze sie zurück.', trialKeys[0]);
      }
    }

    // 5 · Werte und Querregeln gegen den zusammengeführten Stand
    const next = new Map(eff.software);
    const validated = new Map<SettingKey, SettingValue | null>();
    for (const key of ordered) {
      const raw = changes[key];
      if (raw === null) {
        next.delete(key);
        validated.set(key, null);
        continue;
      }
      const checked = validateValue(definitions.get(key)!, raw);
      if (!checked.ok) throw new SettingsError(400, 'invalid_setting', checked.message, key);
      next.set(key, checked.value);
      validated.set(key, checked.value);
    }
    const candidate = this.candidateConfig(next, ordered);
    this.checkCrossRules(candidate, eff, validated, ordered, actor);

    // 6 · Sperre nach Fehlversuchen (ohne Passwortprüfung)
    const needsPassword = ordered.some((key) => definitions.get(key)!.reauth);
    if (needsPassword) {
      const retryAfter = this.limiter.retryAfter(actor.ip ?? '-', actor.username, now);
      if (retryAfter > 0) {
        throw new SettingsError(429, 'too_many_attempts', `Zu viele Fehlversuche. Bitte warte ${Math.max(1, Math.ceil(retryAfter / 60))} Minuten.`, undefined, retryAfter);
      }
      // 7 · Passwort
      await this.checkPassword(request.password, actor, now);
    }

    // 8 · Speichern, Verlauf, in Kraft setzen
    const effective = (key: SettingKey) => eff.software.get(key) ?? null;
    const actions: { key: SettingKey; value: SettingValue | null }[] = [];
    for (const key of ordered) {
      const value = validated.get(key)!;
      // Gleicher Wert wie bisher in der Software: nichts zu tun.
      if (value === effective(key) && (value !== null || !eff.stored.has(key))) continue;
      actions.push({ key, value });
    }
    if (actions.length === 0) return { response: this.get(actor.ip ?? '-', now) };

    const trialPrevious: Partial<Record<SettingKey, SettingValue>> = {};
    this.deps.db.exec('BEGIN IMMEDIATE');
    try {
      // Während der Passwortprüfung kann ein anderer gespeichert haben – Stand noch einmal prüfen.
      if (request.version !== undefined && request.version !== this.store.version()) {
        throw new SettingsError(409, 'settings_changed', 'Inzwischen hat jemand anderes gespeichert. Bitte lade die Einstellungen neu.');
      }
      for (const { key, value } of actions) {
        const definition = definitions.get(key)!;
        const secret = definition.type === 'secret';
        const before = eff.software.get(key) ?? null;
        if (trialKeys.includes(key) && before !== null) trialPrevious[key] = before;
        if (value === null) this.store.delete(key);
        else this.store.set(key, value, secret, actor.username, now);
        this.store.addHistory({
          at: now,
          username: actor.username,
          ip: actor.ip,
          key,
          action: value === null ? 'reset' : trialKeys.includes(key) ? 'trial' : 'set',
          ...(secret ? {} : { from: before, to: value }),
        });
      }
      this.store.bump();
      this.deps.db.exec('COMMIT');
    } catch (error) {
      this.deps.db.exec('ROLLBACK');
      throw error;
    }
    this.deps.log.info({ username: actor.username, keys: actions.map((action) => action.key) }, 'Einstellungen geändert');

    let newSession: UpdateResult['newSession'];
    if (trialKeys.length && actions.length) {
      const remember = actor.sessionId ? (this.deps.sessions.get(actor.sessionId)?.remember ?? false) : false;
      const id = this.deps.sessions.create(actor.username, remember, now);
      newSession = { id, remember };
      this.store.setTrial({
        keys: actions.map((action) => action.key),
        previous: trialPrevious,
        revertsAt: now + this.deps.config.settings.trialSeconds * 1000,
        username: actor.username,
        sessionHash: hashSessionId(id),
      });
      this.store.bump();
      this.scheduleTrial();
    }

    await this.reapply(now);
    return { response: this.get(actor.ip ?? '-', now), newSession };
  }

  /** Konfiguration, wie sie nach dem Speichern wäre – wirft SettingsError mit `field`, wenn `loadConfig` sie ablehnt. */
  private candidateConfig(software: Map<SettingKey, SettingValue>, changed: SettingKey[]): Config {
    const overlay: Env = { ...this.deps.baseEnv };
    for (const [key, value] of software) overlay[key] = toEnv(value);
    try {
      return loadConfig(overlay);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const field = SETTING_KEYS.find((key) => message.includes(key) && changed.includes(key)) ?? changed[0];
      throw new SettingsError(400, 'invalid_setting', message, field);
    }
  }

  private checkCrossRules(
    candidate: Config,
    eff: Effective,
    validated: Map<SettingKey, SettingValue | null>,
    ordered: SettingKey[],
    actor: Actor,
  ): void {
    // AUTH_COOKIE_SECURE muss zum Protokoll passen, über das gerade gespeichert wird – sonst sperrt man sich aus.
    if (ordered.includes('AUTH_COOKIE_SECURE') && actor.origin) {
      const secure = candidate.auth.cookieSecure;
      if (actor.origin.startsWith('http://') && secure) {
        throw new SettingsError(400, 'invalid_setting', 'Du bist gerade über http:// angemeldet – dann muss „Anmeldung nur über HTTPS“ aus bleiben, sonst kommst du nicht mehr hinein.', 'AUTH_COOKIE_SECURE');
      }
      if (actor.origin.startsWith('https://') && !secure) {
        throw new SettingsError(400, 'invalid_setting', 'Du bist über https:// angemeldet – dann muss „Anmeldung nur über HTTPS“ an bleiben.', 'AUTH_COOKIE_SECURE');
      }
    }
    // Jeder Gründer braucht seinen eigenen LinkedIn-Account – sonst gelten die Grenzen doppelt.
    const changedAccount = ACCOUNT_SETTING_KEYS.find((key) => ordered.includes(key));
    if (changedAccount && sharedLinkedInAccount(candidate)) {
      throw new SettingsError(400, 'invalid_setting', SHARED_ACCOUNT_MESSAGE, changedAccount);
    }
    // Aufwärmen nur für reine Scraping-Accounts – die Gründer-Accounts haben ihre eigenen Anfragen und Grenzen.
    if (['UNIPILE_WARMUP_ACCOUNTS', ...ACCOUNT_SETTING_KEYS].some((key) => ordered.includes(key as SettingKey))) {
      const founders = Object.values(candidate.linkedin.accounts).filter(Boolean);
      if (candidate.linkedin.warmupAccounts.some((id) => founders.includes(id))) {
        throw new SettingsError(400, 'invalid_setting', 'Ein Gründer-Account kann nicht aufgewärmt werden – nimm ihn dort heraus oder ordne ihn keinem Gründer zu.', 'UNIPILE_WARMUP_ACCOUNTS');
      }
    }
    // PUBLIC_URL mit http:// nur, wenn die Anmeldung ohne HTTPS läuft.
    const publicUrl = candidate.auth.publicUrl;
    if (ordered.includes('PUBLIC_URL') && publicUrl?.startsWith('http://') && candidate.auth.cookieSecure) {
      throw new SettingsError(400, 'invalid_setting', 'Eine Adresse mit http:// geht nur, wenn „Anmeldung nur über HTTPS“ aus ist.', 'PUBLIC_URL');
    }
    // Adresse mit gebundenem Geheimnis nur zusammen mit einem neuen Wert für dieses Geheimnis.
    for (const key of ordered) {
      const definition = definitionOf(key)!;
      if (!definition.boundSecret) continue;
      const before = definition.type === 'secret' ? secretOf(key, eff.config) : valueOf(key, eff.config, eff.baseEnv);
      const after = definition.type === 'secret' ? secretOf(key, candidate) : valueOf(key, candidate, eff.baseEnv);
      if (before !== after && !ordered.includes(definition.boundSecret)) {
        const bound = definitionOf(definition.boundSecret)!;
        throw new SettingsError(400, 'invalid_setting', `Wenn du „${definition.label}“ änderst, gib bitte auch „${bound.label}“ neu ein – das Geheimnis geht sonst an eine fremde Adresse.`, key);
      }
    }
    void validated;
  }

  private async checkPassword(password: string | undefined, actor: Actor, now: number): Promise<void> {
    if (!password) throw new SettingsError(403, 'reauth_failed', 'Bitte gib dein Passwort ein.');
    const account = this.deps.accounts.find(actor.username);
    // Vor dem `await` zählen – gleichzeitige Anfragen kämen sonst alle an der Sperre vorbei.
    const retryAfter = this.limiter.reserve(actor.ip ?? '-', actor.username, now);
    if (retryAfter > 0) {
      throw new SettingsError(429, 'too_many_attempts', `Zu viele Fehlversuche. Bitte warte ${Math.max(1, Math.ceil(retryAfter / 60))} Minuten.`, undefined, retryAfter);
    }
    const valid = account ? await verifyPassword(password, account.passwordHash) : false;
    if (!valid) {
      this.deps.log.info({ username: actor.username, ip: actor.ip }, 'Einstellungen: Passwort falsch');
      throw new SettingsError(403, 'reauth_failed', 'Das Passwort stimmt nicht.');
    }
    this.limiter.release(actor.ip ?? '-', actor.username, now);
  }

  private async reapply(now = Date.now()): Promise<void> {
    await this.deps.apply(this.effective(now).config);
  }

  // ── Probe-Änderung ─────────────────────────────────────────────────────

  private scheduleTrial(): void {
    if (this.trialTimer) clearTimeout(this.trialTimer);
    this.trialTimer = null;
    const trial = this.store.trial();
    if (!trial) return;
    const wait = Math.max(0, trial.revertsAt - Date.now()) + 50;
    this.trialTimer = setTimeout(() => {
      this.trialTimer = null;
      void this.autoRevert();
    }, wait);
    this.trialTimer.unref();
  }

  private async autoRevert(): Promise<void> {
    const trial = this.store.trial();
    if (!trial) return;
    if (trial.revertsAt > Date.now()) return this.scheduleTrial();
    try {
      await this.revertNow(trial.username, null, 'reverted');
      this.deps.log.warn({ keys: trial.keys }, 'Probe-Änderung nicht bestätigt – zurückgesetzt');
    } catch (error) {
      this.deps.log.error({ err: error }, 'Probe-Änderung konnte nicht zurückgesetzt werden');
    }
  }

  private async revertNow(username: string, ip: string | null, action: 'reverted', now = Date.now()): Promise<void> {
    const trial = this.store.revertTrial(now);
    if (!trial) return;
    for (const key of trial.keys) this.store.addHistory({ at: now, username, ip, key, action });
    this.deps.sessions.deleteByHash(trial.sessionHash);
    await this.reapply(now);
  }

  async confirmTrial(actor: Actor, now = Date.now()): Promise<SettingsResponse> {
    const trial = this.store.trial();
    if (!trial) throw new SettingsError(409, 'no_trial', 'Es gibt keine Probe-Änderung zu bestätigen.');
    if (!actor.sessionId || hashSessionId(actor.sessionId) !== trial.sessionHash) {
      throw new SettingsError(
        409,
        'trial_session_mismatch',
        'Bestätigen geht nur in der neuen Sitzung der Probe. Melde dich mit den neuen Einstellungen an und bestätige dort – sonst wird automatisch zurückgesetzt.',
      );
    }
    this.store.clearTrial();
    for (const key of trial.keys) this.store.addHistory({ at: now, username: actor.username, ip: actor.ip, key, action: 'confirmed' });
    this.store.bump();
    this.scheduleTrial();
    return this.get(actor.ip ?? '-', now);
  }

  async revertTrialBy(actor: Actor, now = Date.now()): Promise<SettingsResponse> {
    if (!this.store.trial()) throw new SettingsError(409, 'no_trial', 'Es gibt keine Probe-Änderung zurückzusetzen.');
    await this.revertNow(actor.username, actor.ip, 'reverted', now);
    this.scheduleTrial();
    return this.get(actor.ip ?? '-', now);
  }

  // ── Verbindungstest ────────────────────────────────────────────────────

  async test(service: string, actor: Actor, now = Date.now()): Promise<SettingsTestResponse> {
    if (!(SERVICES as readonly string[]).includes(service)) throw new SettingsError(400, 'invalid_setting', 'Unbekannter Dienst.');
    const last = this.testLast.get(service) ?? 0;
    if (now - last < TEST_PER_SERVICE_MS) {
      const retryAfter = Math.ceil((TEST_PER_SERVICE_MS - (now - last)) / 1000);
      throw new SettingsError(429, 'too_many_attempts', `Bitte warte ${retryAfter} Sekunden, bevor du diesen Dienst noch einmal testest.`, undefined, retryAfter);
    }
    const blocked = this.testHour.blockedFor(actor.username, now);
    if (blocked > 0) {
      throw new SettingsError(429, 'too_many_attempts', 'Zu viele Verbindungstests in dieser Stunde.', undefined, Math.ceil(blocked / 1000));
    }
    this.testLast.set(service, now);
    this.testHour.hit(actor.username, now);

    const { config } = this.deps;
    if (config.mode === 'mock') return { ok: true, message: 'Simulation – keine Verbindung nötig.' };
    try {
      switch (service as SettingsTestService) {
        case 'unipile':
          return await this.testUnipile(config);
        case 'anthropic':
          return await this.testAnthropic(config);
        case 'meta':
          return await this.testMeta(config);
        case 'treg':
          return await this.testTreg(config);
        case 'close':
          return await this.testClose(config);
        case 'slack':
          return await this.testSlack(config);
      }
    } catch (error) {
      this.deps.log.info({ service, error: error instanceof Error ? error.name : 'Fehler' }, 'Verbindungstest fehlgeschlagen');
      return { ok: false, message: failureMessage(error) };
    }
  }

  private async testUnipile(config: Config): Promise<SettingsTestResponse> {
    const { dsn, apiKey } = config.unipile;
    if (!dsn || !apiKey) return { ok: false, message: 'Unipile ist nicht eingerichtet (Adresse oder Token fehlt).' };
    const client = new UnipileClient({ dsn, apiKey, fetch: this.deps.fetch, timeoutMs: 15_000 });
    const { items } = await client.listAccounts(AbortSignal.timeout(20_000));
    return unipileTestResult(items ?? [], config.unipile.accountId, config.unipile.searchApi);
  }

  /** Claude-Modelle für die Auswahl unter Einstellungen → KI (`GET /api/settings/models`). */
  models(): Promise<AnthropicModelsResponse> {
    const { config } = this.deps;
    return this.anthropicModels.list(config.anthropic.apiKey || null, config.mode);
  }

  private async testAnthropic(config: Config): Promise<SettingsTestResponse> {
    const key = config.anthropic.apiKey;
    if (!key) return { ok: false, message: 'Anthropic ist nicht eingerichtet (API-Schlüssel fehlt).' };
    const base = (this.deps.anthropicBaseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    const response = await (this.deps.fetch ?? fetch)(`${base}/v1/models?limit=1`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, message: 'Zugang abgelehnt – bitte den API-Schlüssel prüfen.' };
    if (!response.ok) return { ok: false, message: `Unerwartete Antwort (HTTP ${response.status}).` };
    return { ok: true, message: 'Verbunden: Anthropic-Zugang gültig.' };
  }

  private async testMeta(config: Config): Promise<SettingsTestResponse> {
    const token = config.meta.accessToken;
    if (!token) return { ok: false, message: 'Meta ist nicht eingerichtet (Access Token fehlt).' };
    const client = new MetaAdLibraryClient({ accessToken: token, version: config.meta.graphVersion, baseUrl: this.deps.metaBaseUrl, fetch: this.deps.fetch, timeoutMs: 15_000 });
    // Eine kleine Abfrage der Werbebibliothek – prüft Token und Berechtigung.
    await client.searchAds({ searchTerms: 'Immobilien', activeStatus: 'ACTIVE', limit: 1 }, AbortSignal.timeout(20_000));
    return { ok: true, message: 'Verbunden: Meta-Werbebibliothek antwortet.' };
  }

  /** Abruf für den Verbindungstest: Netzfehler → TestNetworkError (Zeitüberschreitung bleibt TimeoutError). */
  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      const response = await (this.deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
      // Antworttext nie auswerten oder weitergeben – nur den Status.
      await response.body?.cancel().catch(() => undefined);
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw error;
      throw new TestNetworkError();
    }
  }

  /** Close: `GET /api/v1/me/` mit Basic-Anmeldung (Schlüssel als Benutzername, leeres Passwort) – nur lesend. */
  private async testClose(config: Config): Promise<SettingsTestResponse> {
    const key = config.close.apiKey;
    if (!key) return { ok: false, message: 'Close ist nicht eingerichtet (API-Schlüssel fehlt).' };
    const response = await this.call(`${config.close.baseUrl}/api/v1/me/`, {
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, accept: 'application/json' },
    });
    if (!response.ok) return rejectedOrUnexpected(response.status, 'Zugang abgelehnt – bitte den API-Schlüssel prüfen.');
    return { ok: true, message: 'Verbunden: Close-Zugang gültig.' };
  }

  /**
   * Treg: es gibt keinen kostenlosen Prüf-Abruf – darum genau ein Abruf derselben Schnittstelle wie bei der
   * Anreicherung (`treg.companies.enrich`) für eine bekannte Firma, mit der eingestellten Kostengrenze.
   */
  private async testTreg(config: Config): Promise<SettingsTestResponse> {
    const { token, baseUrl, maxCostUsd } = config.treg;
    if (!token) return { ok: false, message: 'Treg ist nicht eingerichtet (Token fehlt).' };
    const response = await this.call(`${baseUrl}/call/${TREG_ENRICH_ID}`, {
      method: 'POST',
      headers: { 'X-Treg-Token': token, 'X-Treg-Route-Max-Cost': String(maxCostUsd), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ domain: TREG_TEST_DOMAIN }),
    });
    if (response.status === 402) return { ok: false, message: 'Zugang gültig, aber das Treg-Guthaben ist aufgebraucht – bitte auf treg.to aufladen.' };
    if (!response.ok) return rejectedOrUnexpected(response.status, 'Zugang abgelehnt – bitte den Token prüfen.');
    return { ok: true, message: 'Verbunden: Treg-Zugang gültig (der Test hat eine Firma abgefragt, ca. 0,2 Cent).' };
  }

  /** Slack: schickt die Testnachricht in den Kanal – das ist gewollt, sie ist der Beweis. */
  private async testSlack(config: Config): Promise<SettingsTestResponse> {
    const webhook = config.slack.webhookUrl;
    if (!webhook) return { ok: false, message: 'Slack ist nicht eingerichtet (Webhook-Adresse fehlt).' };
    const response = await this.call(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: SLACK_TEST_TEXT }),
    });
    // Slack meldet einen gelöschten oder falschen Webhook mit 403/404/410.
    if (response.status === 404 || response.status === 410) return { ok: false, message: 'Zugang abgelehnt – bitte die Webhook-Adresse prüfen.' };
    if (!response.ok) return rejectedOrUnexpected(response.status, 'Zugang abgelehnt – bitte die Webhook-Adresse prüfen.');
    return { ok: true, message: 'Verbunden: Testnachricht in Slack gesendet.' };
  }
}

/** Feste Sätze – nie der Antworttext eines fremden Servers. */
function rejectedOrUnexpected(status: number, rejected: string): SettingsTestResponse {
  return { ok: false, message: status === 401 || status === 403 ? rejected : `Unerwartete Antwort (HTTP ${status}).` };
}


function failureMessage(error: unknown): string {
  if (error instanceof UnipileHttpError) {
    if (isUnipileSessionDown(error)) return `Unipile-Sitzung nicht aktiv: ${UNIPILE_SESSION_DOWN_TEXT}`;
    if (error.status === 401 || error.status === 403) return 'Zugang abgelehnt – bitte Adresse und Token prüfen.';
    return `Unerwartete Antwort (HTTP ${error.status}).`;
  }
  if (error instanceof MetaApiError) {
    if (error.code === 190 || error.status === 401 || error.status === 403) return 'Zugang abgelehnt – bitte den Token prüfen (er läuft nach 60 Tagen ab).';
    return `Unerwartete Antwort (HTTP ${error.status}).`;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || /Zeitüberschreitung/.test(error.message))) return 'Zeitüberschreitung – der Dienst antwortet nicht.';
  if (error instanceof UnipileNetworkError || error instanceof MetaNetworkError || error instanceof TestNetworkError) return 'Nicht erreichbar.';
  return 'Nicht erreichbar oder unerwartete Antwort.';
}
