import { randomUUID } from 'node:crypto';
import type { AuthFounderId } from '../../../shared/auth.js';
import { LEAD_STAGE_LABELS, type CockpitLead } from '../../../shared/leads.js';
import {
  LEAD_CATEGORY_FIELD,
  type LeadImportEntry,
  type LeadImportEntryStatus,
  type LeadImportItem,
  type LeadImportItemResult,
  type LeadImportStatusResponse,
} from '../../../shared/leadImport.js';
import type { Database } from '../db/database.js';
import type { AccountUsage } from '../linkedin/accountUsage.js';
import { UNIPILE_LIMITS } from '../linkedin/accountUsage.js';
import type { AccountPrefsStore } from '../linkedin/accountPrefs.js';
import type { ConnectionStore } from '../linkedin/connections.js';
import { LinkedInError, type LinkedInService } from '../linkedin/service.js';
import type { LeadStore } from './leadStore.js';

/**
 * Listen-Import (Lukas-Instanz 19.11., Vertrag `shared/leadImport.ts`): Links aus einer fertigen Liste werden
 * eingereiht und im Hintergrund abgerufen – je Link ein Profilabruf über den Account des Besitzers, 3–8 s Pause,
 * nie über das Tageslimit für Profilabrufe des Accounts (alle Zwecke zusammen, `AccountUsage`). Keine Suche, keine KI,
 * kein Meta-Check, nichts gesendet. Die Tabelle `lead_imports` legt `ensureInstanceSchema` an.
 */

const TICK_MS = 60_000;
/** Höchstens so viele Abrufe je Runde – danach gibt die Runde ab (eine Runde läuft so höchstens ~2 Minuten). */
const PER_TICK = 20;
/** Nach Zugangs- oder Serverfehlern ruht die Warteschlange so lange. */
const REST_MS = 60 * 60_000;

interface ImportRow {
  id: string;
  owner: string;
  profile: string;
  identifier: string;
  category: string | null;
  note: string | null;
  fields: string | null;
  status: LeadImportEntryStatus;
  lead_id: string | null;
  message: string | null;
  actor: string | null;
  queued_at: number;
  processed_at: number | null;
}

export interface LeadImportDeps {
  db: Database;
  leads: LeadStore;
  linkedin: LinkedInService;
  usage: AccountUsage;
  prefs?: AccountPrefsStore;
  connections?: ConnectionStore;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  founderName: (id: AuthFounderId) => string;
  /** Nicht gleichzeitig mit einer Lead-Suche über dieselben Accounts. */
  busy?: () => boolean;
  /** Nur Tests: kürzere Pausen. */
  minPauseMs?: number;
}

export type AddResult = { status: 'created' | 'duplicate'; lead: CockpitLead; message: string };

export class LeadImportQueue {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private restingUntil: number | null = null;
  private restingReason: string | null = null;
  /** Letzter Fehlschlag einer Runde (für `trackJob`). */
  lastFailure: string | null = null;

  constructor(private readonly deps: LeadImportDeps) {}

  // ── Einreihen ──────────────────────────────────────────────────────────

  /** Links einreihen; nichts wird sofort abgerufen. `identifier` = öffentliche Kennung (null = kein Profil-Link). */
  enqueue(items: Array<LeadImportItem & { identifier: string | null }>, owner: AuthFounderId, actor: string | null, now = Date.now()): LeadImportItemResult[] {
    const results: LeadImportItemResult[] = [];
    const seen = new Set<string>();
    const insert = this.deps.db.prepare(
      `INSERT INTO lead_imports (id, owner, profile, identifier, category, note, fields, status, actor, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    );
    for (const item of items) {
      const profile = item.profile.trim();
      if (!item.identifier) {
        results.push({ profile, status: 'invalid', message: 'Kein LinkedIn-Profil-Link (https://www.linkedin.com/in/…).' });
        continue;
      }
      const key = item.identifier.toLowerCase();
      const known = this.deps.leads.findByPublicIdentifier(key);
      if (known) {
        results.push({ profile, status: 'duplicate', leadId: known.id, message: `Gibt es schon: ${name(known)} unter „${LEAD_STAGE_LABELS[known.stage]}“.` });
        continue;
      }
      const waiting = this.deps.db.prepare("SELECT 1 FROM lead_imports WHERE identifier = ? AND status = 'queued' LIMIT 1").get(key);
      if (waiting || seen.has(key)) {
        results.push({ profile, status: 'duplicate', message: 'Steht schon in der Warteschlange.' });
        continue;
      }
      seen.add(key);
      const itemOwner = item.owner ?? owner;
      insert.run(randomUUID(), itemOwner, profile, key, item.category?.trim() || null, item.note?.trim() || null, item.fields ? JSON.stringify(item.fields) : null, actor, now);
      results.push({ profile, status: 'queued', message: 'In der Warteschlange.' });
    }
    if (results.some((result) => result.status === 'queued')) {
      // Wer gerade wegen Zugangsfehlern ruht, bleibt ruhig; sonst gleich anfangen.
      queueMicrotask(() => void this.tick());
    }
    return results;
  }

  waiting(owner?: AuthFounderId): number {
    const row = owner
      ? this.deps.db.prepare("SELECT COUNT(*) AS n FROM lead_imports WHERE status = 'queued' AND owner = ?").get(owner)
      : this.deps.db.prepare("SELECT COUNT(*) AS n FROM lead_imports WHERE status = 'queued'").get();
    return (row as { n: number }).n;
  }

  // ── Sofort (add_lead) ──────────────────────────────────────────────────

  /** Genau einen Link sofort abrufen und anlegen – mit demselben Tageslimit wie die Warteschlange. */
  async addNow(item: LeadImportItem, identifier: string, owner: AuthFounderId, actor: string | null, now = Date.now()): Promise<AddResult> {
    const known = this.deps.leads.findByPublicIdentifier(identifier);
    if (known) return { status: 'duplicate', lead: known, message: `${name(known)} gibt es schon – unter „${LEAD_STAGE_LABELS[known.stage]}“.` };
    const room = this.room(owner, now);
    if (room.free <= 0) {
      throw new LinkedInError('linkedin_limit', 429, `Tageslimit für Profilabrufe erreicht (${room.used}/${room.limit}). Mit import_leads einreihen – die Warteschlange macht morgen weiter.`);
    }
    return this.fetchAndCreate(item, identifier, owner, actor, now);
  }

  // ── Abarbeiten ─────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Eine Runde: so viele Einträge wie Limit und Runde erlauben. Gibt die Zahl der verarbeiteten Einträge zurück. */
  async tick(now = Date.now()): Promise<number> {
    // Läuft schon eine Runde (z. B. gleich nach dem Einreihen angestoßen): abwarten, dann selbst noch eine.
    if (this.current) await this.current.catch(() => 0);
    this.current = this.round(now);
    try {
      return await this.current;
    } finally {
      this.current = null;
    }
  }

  private current: Promise<number> | null = null;

  private async round(now: number): Promise<number> {
    if (this.running) return 0;
    if (this.restingUntil && now < this.restingUntil) return 0;
    if (this.deps.busy?.()) return 0;
    this.running = true;
    this.restingUntil = null;
    this.restingReason = null;
    let done = 0;
    try {
      const full = new Set<string>();
      for (let i = 0; i < PER_TICK; i++) {
        const row = this.next(full);
        if (!row) break;
        const owner = row.owner as AuthFounderId;
        const at = Date.now();
        if (this.room(owner, at).free <= 0) {
          full.add(owner);
          i--;
          continue;
        }
        if (done > 0) await sleep(this.pauseMs());
        const outcome = await this.process(row, Date.now());
        if (outcome === 'stop') break;
        done++;
      }
      this.lastFailure = null;
    } catch (error) {
      this.lastFailure = String(error);
      this.deps.log.warn({ error: String(error) }, 'Listen-Import: Runde abgebrochen');
    } finally {
      this.running = false;
    }
    return done;
  }

  private next(skipOwners: Set<string>): ImportRow | null {
    const rows = this.deps.db.prepare("SELECT * FROM lead_imports WHERE status = 'queued' ORDER BY queued_at ASC, rowid ASC LIMIT 50").all() as unknown as ImportRow[];
    return rows.find((row) => !skipOwners.has(row.owner)) ?? null;
  }

  private async process(row: ImportRow, now: number): Promise<'ok' | 'stop'> {
    const owner = row.owner as AuthFounderId;
    const item: LeadImportItem = {
      profile: row.profile,
      ...(row.category ? { category: row.category } : {}),
      ...(row.note ? { note: row.note } : {}),
      ...(row.fields ? { fields: JSON.parse(row.fields) as Record<string, string> } : {}),
    };
    try {
      const known = this.deps.leads.findByPublicIdentifier(row.identifier);
      const result = known
        ? { status: 'duplicate' as const, lead: known, message: `Gibt es schon: ${name(known)} unter „${LEAD_STAGE_LABELS[known.stage]}“.` }
        : await this.fetchAndCreate(item, row.identifier, owner, row.actor, now);
      this.finish(row.id, result.status, result.lead.id, result.message, now);
      return 'ok';
    } catch (error) {
      if (error instanceof LinkedInError) {
        // Profil gibt es nicht bzw. Link falsch: nur dieser Eintrag. Alles andere (Limit, Zugang, Account fehlt,
        // Unipile weg) liegt am Account – Eintrag bleibt in der Warteschlange, Pause.
        if (error.code === 'linkedin_rejected') {
          this.finish(row.id, 'failed', null, error.message, now);
          return 'ok';
        }
        this.rest(now, error.message);
        return 'stop';
      }
      this.rest(now, 'Unerwarteter Fehler beim Profilabruf.');
      this.deps.log.warn({ importId: row.id, error: String(error) }, 'Listen-Import: Profilabruf fehlgeschlagen');
      return 'stop';
    }
  }

  private rest(now: number, reason: string): void {
    this.restingUntil = now + REST_MS;
    this.restingReason = reason;
    this.deps.log.warn({ until: new Date(this.restingUntil).toISOString() }, 'Listen-Import ruht');
  }

  private finish(id: string, status: LeadImportEntryStatus, leadId: string | null, message: string, now: number): void {
    this.deps.db.prepare('UPDATE lead_imports SET status = ?, lead_id = ?, message = ?, processed_at = ? WHERE id = ?').run(status, leadId, message, now, id);
  }

  /** Profil abrufen (zählt zum Tageslimit), Lead anlegen, Kategorie, Felder und Notiz setzen. */
  private async fetchAndCreate(item: LeadImportItem, identifier: string, owner: AuthFounderId, actor: string | null, now: number): Promise<AddResult> {
    const accountId = this.deps.linkedin.accountOf(owner);
    const contact = await this.deps.linkedin.lookupContact(owner, identifier);
    if (accountId) this.deps.usage.add(accountId, 'profile', 1, now, 'import_profile');
    const { lead, created } = this.deps.leads.createContact(contact, owner, now, actor);
    if (!created) return { status: 'duplicate', lead, message: `${name(lead)} gibt es schon – unter „${LEAD_STAGE_LABELS[lead.stage]}“.` };
    this.deps.connections?.recordContactInvite(owner, lead, lead.createdAt);
    const fields: Record<string, string> = { ...(item.fields ?? {}) };
    if (item.category) fields[LEAD_CATEGORY_FIELD] = item.category.trim().toLowerCase();
    let current = lead;
    if (Object.keys(fields).length) current = this.deps.leads.setFields(lead.id, fields, owner, now, actor);
    if (item.note) current = this.deps.leads.applyAction(lead.id, { action: 'note', text: item.note }, owner, now, undefined, actor);
    this.deps.log.info({ leadId: lead.id, owner }, 'Listen-Import: Lead angelegt');
    return { status: 'created', lead: current, message: `${name(current)} ist jetzt unter „${LEAD_STAGE_LABELS[current.stage]}“.` };
  }

  // ── Stand ──────────────────────────────────────────────────────────────

  /** Freie Profilabrufe heute für den Account des Besitzers (alle Zwecke zusammen). */
  room(owner: AuthFounderId, now = Date.now()): { used: number; limit: number; free: number } {
    const accountId = this.deps.linkedin.accountOf(owner);
    if (!accountId) return { used: 0, limit: 0, free: 0 };
    const limit = Math.min(UNIPILE_LIMITS.profilesPerDay, this.deps.prefs?.get(accountId).profilesPerDay ?? UNIPILE_LIMITS.profilesPerDay);
    const used = this.deps.usage.used(accountId, 'profile', now);
    return { used, limit, free: Math.max(0, limit - used) };
  }

  status(owners: readonly AuthFounderId[], recentLimit = 20, now = Date.now()): LeadImportStatusResponse {
    const placeholders = owners.map(() => '?').join(', ');
    const where = owners.length ? `WHERE owner IN (${placeholders})` : '';
    const countRows = this.deps.db.prepare(`SELECT status, COUNT(*) AS n FROM lead_imports ${where} GROUP BY status`).all(...owners) as Array<{ status: LeadImportEntryStatus; n: number }>;
    const counts: Record<LeadImportEntryStatus, number> = { queued: 0, created: 0, duplicate: 0, failed: 0 };
    for (const row of countRows) counts[row.status] = row.n;
    const recentRows = this.deps.db
      .prepare(`SELECT * FROM lead_imports ${where} ORDER BY COALESCE(processed_at, queued_at) DESC, rowid DESC LIMIT ?`)
      .all(...owners, recentLimit) as unknown as ImportRow[];
    const recent: LeadImportEntry[] = recentRows.map((row) => ({
      profile: row.profile,
      owner: row.owner as AuthFounderId,
      status: row.status,
      leadId: row.lead_id,
      message: row.message,
      queuedAt: row.queued_at,
      processedAt: row.processed_at,
    }));
    const profilesToday: LeadImportStatusResponse['profilesToday'] = {};
    for (const owner of owners) {
      const room = this.room(owner, now);
      profilesToday[owner] = { used: room.used, limit: room.limit };
    }
    const resting = this.restingUntil && now < this.restingUntil ? this.restingUntil : null;
    return {
      counts,
      profilesToday,
      restingUntil: resting,
      restingReason: resting ? this.restingReason : null,
      recent,
      message: this.summary(counts, owners, resting, now),
    };
  }

  private summary(counts: Record<LeadImportEntryStatus, number>, owners: readonly AuthFounderId[], resting: number | null, now: number): string {
    const parts = [`${counts.created} angelegt, ${counts.duplicate} Dubletten, ${counts.failed} Fehler, ${counts.queued} warten.`];
    if (resting) parts.push(`Pausiert bis ${new Date(resting).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}: ${this.restingReason}`);
    else if (counts.queued) {
      // Nur Besitzer, für die etwas wartet – sonst zählt der freie Account des anderen Gründers mit.
      const waitingFor = owners.filter((owner) => this.waiting(owner) > 0);
      const free = waitingFor.reduce((sum, owner) => sum + this.room(owner, now).free, 0);
      parts.push(free > 0 ? `Heute noch ${free} Profilabrufe frei – die Warteschlange arbeitet (3–8 s Pause je Profil).` : 'Tageslimit für Profilabrufe erreicht – es geht morgen weiter.');
    }
    return parts.join(' ');
  }

  private pauseMs(): number {
    const min = this.deps.minPauseMs ?? 3000;
    const max = this.deps.minPauseMs !== undefined ? this.deps.minPauseMs : 8000;
    return min + Math.random() * (max - min);
  }
}

const name = (lead: CockpitLead) => [lead.person.firstName, lead.person.lastName].filter(Boolean).join(' ');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

declare module 'fastify' {
  interface FastifyInstance {
    /** Für Tests: Listen-Import (`tick()`). */
    leadImports: LeadImportQueue;
  }
}
