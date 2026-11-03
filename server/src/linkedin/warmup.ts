import type { FastifyBaseLogger } from 'fastify';
import { WARMUP_RAMP, type LinkedInWarmupAccount, type LinkedInWarmupResponse } from '../../../shared/linkedin.js';
import { UnipileClient, UnipileHttpError } from '../adapters/live/unipileClient.js';
import { usedAccountIds, type Config } from '../config.js';
import type { Database } from '../db/database.js';
import { randomBetween, sleep } from '../lib/sleep.js';
import type { AccountPrefsStore } from './accountPrefs.js';
import { UNIPILE_LIMITS, type AccountUsage } from './accountUsage.js';
import { localTime, withinWorkHours } from './guard.js';
import { MIN_PAUSE_MS, classify } from './service.js';

/**
 * Accounts aufwärmen (Wunsch des Nutzers 21.10.): Die reinen Scraping-Accounts haben kaum Kontakte – LinkedIn zeigt
 * ihnen in der Suche fast nur anonyme „LinkedIn Mitglied“-Treffer und sortiert schlecht. Darum schicken die in
 * `UNIPILE_WARMUP_ACCOUNTS` gewählten Accounts nebenbei Vernetzungsanfragen (ohne Notiz) an Leute der Branche:
 * qualifizierte Leads aus dem Cockpit und Profile aus der Tracking-Liste (Excel).
 *
 * - Zu zufälligen Zeiten in der Arbeitszeit, über den Tag verteilt; höchstens `LINKEDIN_WARMUP_PER_DAY` (≤ 17) je
 *   Account, in den ersten Wochen weniger (`WARMUP_RAMP`). Gezählt wird nur, was die Automatik sendet – Anfragen, die
 *   jemand selbst über seinen privaten Account schickt, blockieren nichts.
 * - Jede Person höchstens einmal, von einem Account (`warmup_invites.target_key`).
 * - Nur live mit LINKEDIN_ACTIONS an. Limit/Zugang → Account pausiert (Tabelle `warmup_pauses`), Ablehnung einer
 *   einzelnen Person (schon vernetzt/angefragt) → nächste Person.
 * - Scraping läuft über diese Accounts unverändert weiter; Profilabrufe hier zählen zu deren Tageslimit.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;
/** Nie zwei Aufwärm-Anfragen eines Accounts kürzer hintereinander. */
const MIN_GAP_MS = 4 * MINUTE_MS;
/** Abgelehnte Personen (schon vernetzt …) je Runde höchstens so oft überspringen, dann bis zur nächsten Runde warten. */
const ATTEMPTS_PER_TICK = 3;
/** Wie oft die Automatik nachsieht, ob ein Account dran ist. */
const TICK_MS = MINUTE_MS;

interface Target {
  key: string;
  source: 'lead' | 'tracking';
  /** Lead: bekannte LinkedIn-ID; Tracking: erst über das Profil auflösen. */
  providerId: string | null;
  /** Für den Profilabruf (öffentliche Kennung oder ID aus dem Link). */
  identifier: string;
}

export interface WarmupDeps {
  config: Config;
  db: Database;
  log: FastifyBaseLogger;
  usage: AccountUsage;
  /** Eigene Anfragen-Grenze am Account (21.10.) – deckelt zusätzlich zum Anlauf. */
  prefs?: AccountPrefsStore;
  fetch?: typeof fetch;
  random?: () => number;
  /** Untergrenze der Pause zwischen Profilabruf und Anfrage (ms), Standard 3000 – Tests setzen 0. */
  minPauseMs?: number;
}

export class WarmupService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** Nächste geplante Anfrage je Account (nur im Speicher – nach einem Neustart neu ausgelost). */
  private readonly nextAt = new Map<string, number>();
  private client: { key: string; client: UnipileClient } | null = null;

  constructor(private readonly deps: WarmupDeps) {}

  private get config() {
    return this.deps.config;
  }

  private random(): number {
    return (this.deps.random ?? Math.random)();
  }

  /** live nur mit LINKEDIN_ACTIONS an und Unipile-Zugang – sonst sendet die Automatik nichts. */
  get mode(): LinkedInWarmupResponse['mode'] {
    if (this.config.mode === 'mock') return 'mock';
    return this.config.linkedin.actionsOn && this.config.unipile.dsn && this.config.unipile.apiKey ? 'live' : 'off';
  }

  private get unipile(): UnipileClient | null {
    const { dsn, apiKey } = this.config.unipile;
    if (this.mode !== 'live' || !dsn || !apiKey) return null;
    const key = `${dsn}|${apiKey}`;
    if (this.client?.key !== key) this.client = { key, client: new UnipileClient({ dsn, apiKey, fetch: this.deps.fetch, timeoutMs: 30_000, onlyAccounts: () => usedAccountIds(this.config) }) };
    return this.client.client;
  }

  /** Gewählte Accounts ohne die der Gründer (die senden schon selbst). */
  accounts(): string[] {
    const founders = Object.values(this.config.linkedin.accounts).filter(Boolean);
    return this.config.linkedin.warmupAccounts.filter((id) => !founders.includes(id));
  }

  private day(now: number): string {
    return localTime(now, this.config.linkedin.workHours.timeZone).day;
  }

  private startedAt(accountId: string): number | null {
    const row = this.deps.db.prepare("SELECT MIN(at) AS at FROM warmup_invites WHERE account_id = ? AND status = 'sent'").get(accountId) as { at: number | null };
    return row.at ?? null;
  }

  private sentOn(accountId: string, day: string): number {
    return (this.deps.db.prepare("SELECT COUNT(*) AS n FROM warmup_invites WHERE account_id = ? AND day = ? AND status = 'sent'").get(accountId, day) as { n: number }).n;
  }

  /** Heute erlaubt: Anlauf (6 → 10 → 14) seit der ersten Anfrage, danach der eingestellte Wert. */
  limitToday(accountId: string, now: number): number {
    const started = this.startedAt(accountId);
    const week = started === null ? 0 : Math.floor((now - started) / WEEK_MS);
    const own = this.deps.prefs?.get(accountId).invitesPerDay ?? Infinity;
    return Math.min(this.config.linkedin.warmupPerDay, WARMUP_RAMP[week] ?? Infinity, own);
  }

  private pause(accountId: string, now: number): { until: number; reason: string } | null {
    const row = this.deps.db.prepare('SELECT until, reason FROM warmup_pauses WHERE account_id = ?').get(accountId) as { until: number; reason: string } | undefined;
    return row && row.until > now ? row : null;
  }

  status(now = Date.now()): LinkedInWarmupResponse {
    const accounts: LinkedInWarmupAccount[] = this.accounts().map((id) => {
      const paused = this.pause(id, now);
      const sentToday = this.sentOn(id, this.day(now));
      const limitToday = this.limitToday(id, now);
      const next = this.nextAt.get(id);
      return {
        id,
        sentToday,
        limitToday,
        sentTotal: (this.deps.db.prepare("SELECT COUNT(*) AS n FROM warmup_invites WHERE account_id = ? AND status = 'sent'").get(id) as { n: number }).n,
        startedAt: this.startedAt(id),
        pausedUntil: paused?.until ?? null,
        pauseReason: paused?.reason ?? null,
        nextAt: next !== undefined && sentToday < limitToday && !paused && this.day(next) === this.day(now) ? next : null,
      };
    });
    return { mode: this.mode, accounts, poolLeft: this.poolLeft() };
  }

  /** Personen, die noch keine Aufwärm-Anfrage bekommen haben. */
  private poolLeft(): number {
    const leads = this.deps.db
      .prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${LEAD_FREE}`)
      .get() as { n: number };
    const tracking = this.deps.db
      .prepare(`SELECT COUNT(*) AS n FROM tracking_profiles WHERE ${TRACKING_FREE}`)
      .get() as { n: number };
    return leads.n + tracking.n;
  }

  /**
   * Nächste Person: abwechselnd zufällig aus den Leads oder der Tracking-Liste (was es noch gibt). Bei den Leads seit
   * 27.10. (Kundengespräch: „beim Aufwärmen beide Zielgruppen mischen“) je zur Hälfte Finanzdienstleister und die
   * übrigen (Kapitalanlage-Vertriebe …) – fehlt eine Seite, die andere.
   */
  private nextTarget(): Target | null {
    const pickLead = (finance: boolean) =>
      this.deps.db
        .prepare(
          `SELECT provider_id, public_identifier FROM leads WHERE ${LEAD_FREE}
           AND (json_extract(assessment, '$.category') IS 'finanzdienstleister') = ? ORDER BY random() LIMIT 1`,
        )
        .get(finance ? 1 : 0) as { provider_id: string; public_identifier: string | null } | undefined;
    const lead = (): Target | null => {
      const finance = this.random() < 0.5;
      const row = pickLead(finance) ?? pickLead(!finance);
      if (!row) return null;
      return { key: leadKey(row.provider_id, row.public_identifier), source: 'lead', providerId: row.provider_id, identifier: row.provider_id };
    };
    const tracked = (): Target | null => {
      const row = this.deps.db.prepare(`SELECT key FROM tracking_profiles WHERE ${TRACKING_FREE} ORDER BY random() LIMIT 1`).get() as { key: string } | undefined;
      if (!row) return null;
      return { key: row.key, source: 'tracking', providerId: null, identifier: row.key.slice(3) };
    };
    return this.random() < 0.5 ? (lead() ?? tracked()) : (tracked() ?? lead());
  }

  private record(target: Target, accountId: string, status: 'sent' | 'skipped', providerId: string | null, detail: string | null, now: number) {
    this.deps.db
      .prepare('INSERT OR IGNORE INTO warmup_invites (target_key, account_id, source, provider_id, status, detail, at, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(target.key, accountId, target.source, providerId, status, detail, now, this.day(now));
  }

  /** Abstand bis zur nächsten Anfrage: Rest der Arbeitszeit gleichmäßig auf die übrigen verteilt, zufällig gestreut. */
  private gap(now: number, remaining: number): number {
    const { toHour, timeZone } = this.config.linkedin.workHours;
    const local = localTime(now, timeZone);
    const left = Math.max(MINUTE_MS, ((toHour - local.hour) * 3600 - local.minute * 60 - local.second) * 1000);
    const average = left / (Math.max(1, remaining) + 1);
    return Math.max(MIN_GAP_MS, Math.round(average * (0.4 + this.random() * 1.2)));
  }

  /** Eine Runde: jeder fällige Account schickt höchstens eine Anfrage. Läuft nie doppelt. */
  tick(now = Date.now()): Promise<void> {
    this.running ??= this.runTick(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runTick(now: number): Promise<void> {
    const unipile = this.unipile;
    if (!unipile || !withinWorkHours(this.config.linkedin, now)) return;
    for (const accountId of this.accounts()) {
      if (this.pause(accountId, now)) continue;
      const remaining = this.limitToday(accountId, now) - this.sentOn(accountId, this.day(now));
      if (remaining <= 0) continue;
      const planned = this.nextAt.get(accountId);
      // Erste Runde des Tages (oder nach Neustart): Start zufällig auslosen statt sofort zu senden.
      if (planned === undefined || this.day(planned) !== this.day(now)) {
        this.nextAt.set(accountId, now + Math.round(this.random() * this.gap(now, remaining)));
        continue;
      }
      if (now < planned) continue;
      const sent = await this.sendOne(unipile, accountId, now);
      this.nextAt.set(accountId, now + this.gap(now, remaining - (sent ? 1 : 0)));
    }
  }

  /** Eine Anfrage über diesen Account – true, wenn gesendet. */
  private async sendOne(unipile: UnipileClient, accountId: string, now: number): Promise<boolean> {
    for (let attempt = 0; attempt < ATTEMPTS_PER_TICK; attempt++) {
      const target = this.nextTarget();
      if (!target) return false;
      try {
        let providerId = target.providerId;
        if (!providerId) {
          // Tracking-Liste: nur Link/Kennung bekannt → Profil einmal lesen (notify=false), zählt zum Profil-Limit.
          const profileLimit = Math.min(UNIPILE_LIMITS.profilesPerDay, this.deps.prefs?.get(accountId).profilesPerDay ?? UNIPILE_LIMITS.profilesPerDay);
          if (this.deps.usage.used(accountId, 'profile', now) >= profileLimit) return false;
          const profile = await unipile.getProfile({ accountId, identifier: target.identifier }, AbortSignal.timeout(30_000));
          this.deps.usage.add(accountId, 'profile', 1, now);
          const connected = profile.network_distance === 'FIRST_DEGREE' || profile.network_distance === 'DISTANCE_1';
          const pending = profile.invitation?.type === 'SENT' && profile.invitation.status === 'PENDING';
          if (!profile.provider_id || connected || pending) {
            this.record(target, accountId, 'skipped', profile.provider_id ?? null, connected ? 'schon vernetzt' : pending ? 'schon angefragt' : 'keine Kennung', now);
            continue;
          }
          providerId = profile.provider_id;
          await sleep(this.pauseMs());
        }
        await unipile.sendInvitation({ accountId, providerId }, AbortSignal.timeout(30_000));
        this.record(target, accountId, 'sent', providerId, null, now);
        this.deps.log.info({ accountId, source: target.source }, 'Aufwärmen: Vernetzungsanfrage gesendet');
        return true;
      } catch (error) {
        const classified = classify(error);
        if (classified.pauseMs) {
          // Limit, Zugang oder Serverfehler: nicht die Person, sondern der Account – pausieren, Person bleibt frei.
          const until = now + classified.pauseMs;
          this.deps.db
            .prepare('INSERT INTO warmup_pauses (account_id, until, reason) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET until = excluded.until, reason = excluded.reason')
            .run(accountId, until, classified.reason);
          this.deps.log.warn({ accountId, error: classified.log }, 'Aufwärmen: Account pausiert');
          return false;
        }
        if (error instanceof UnipileHttpError) {
          // Diese Person geht nicht (schon vernetzt/angefragt, nicht gefunden …) – merken und die nächste nehmen.
          this.record(target, accountId, 'skipped', target.providerId, classified.log, now);
          continue;
        }
        // Netzwerk/Zeitüberschreitung: nächste Runde noch einmal, Person bleibt frei.
        this.deps.log.warn({ accountId, error: classified.log }, 'Aufwärmen: Unipile nicht erreichbar');
        return false;
      }
    }
    return false;
  }

  private pauseMs(): number {
    const min = this.deps.minPauseMs ?? MIN_PAUSE_MS;
    const [from, to] = this.config.linkedin.pauseMs;
    return Math.max(min, randomBetween(from, to, this.random.bind(this)));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((error) => this.deps.log.warn({ error: String(error) }, 'Aufwärmen fehlgeschlagen')), TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Schlüssel wie in der Tracking-Liste: öffentliche Kennung bevorzugt, sonst die LinkedIn-ID. */
function leadKey(providerId: string, publicIdentifier: string | null): string {
  return publicIdentifier ? `in:${publicIdentifier.toLowerCase()}` : `id:${providerId}`;
}

/** Leads ohne Aufwärm-Anfrage (weder über die Kennung noch über die ID). */
const LEAD_FREE = `NOT EXISTS (SELECT 1 FROM warmup_invites w WHERE w.target_key = 'id:' || leads.provider_id
  OR (leads.public_identifier IS NOT NULL AND w.target_key = 'in:' || lower(leads.public_identifier)))`;
/** Einträge der Tracking-Liste ohne Aufwärm-Anfrage. */
const TRACKING_FREE = 'key NOT IN (SELECT target_key FROM warmup_invites)';
