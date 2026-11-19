import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthFounderId } from '../../../shared/auth.js';
import { CATEGORY_LABELS, DEFAULT_SEARCH_PROFILE, type EnrichedProfile, type SearchHit } from '../../../shared/leadSearch.js';
import type { CockpitLead, ContactVia, LeadAssessment } from '../../../shared/leads.js';
import type { LinkedInManualInvite, LinkedInNewContact, LinkedInNewContactStatus } from '../../../shared/linkedin.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { ContactProfile, LeadStore } from '../leads/leadStore.js';
import { randomBetween, sleep } from '../lib/sleep.js';
import { AdapterError, type LeadSearchAdapter, type RunContext } from '../pipeline/adapter.js';
import { detectHiring } from '../qualify/hiring.js';
import { QualificationValidationError, parseQualification } from '../qualify/schema.js';
import { applyTargetRules } from '../qualify/targetGroup.js';
import { nextLocalMidnight } from './guard.js';

/**
 * Anfragen von Hand und neue Kontakte (Teammeeting 05.11., Vertrag `shared/linkedin.ts` → „Anfragen von Hand …“).
 *
 * Der Abgleich liest je Gründer-Account die offenen, gesendeten Anfragen (`GET /users/invite/sent`) und merkt sich jede
 * (Tabelle `linkedin_sent_invites`): Kam sie nicht aus dem Cockpit, ist sie „von Hand“ (z. B. Sales Navigator). Neue
 * Kontakte (`GET /users/relations`, neuer als der Zeitpunkt, ab dem der Account beobachtet wird) ohne Lead landen in
 * `linkedin_new_contacts` und werden von `NewContactImporter` übernommen – mit Profil, Firmenseite und KI wie in der
 * Lead-Suche. Von Hand angefragte immer, alle anderen nur, wenn die KI sie als passend einstuft (Wunsch des Nutzers
 * 05.11., „Punkt A“: sonst landen Recruiter oder Bekannte, die euch anfragen, im Tagesstapel).
 */

const MINUTE_MS = 60_000;
/** Je Runde höchstens so viele neue Kontakte übernehmen – der Rest kommt beim nächsten Abgleich dran. */
const IMPORT_PER_ROUND = 10;
/** Nach so vielen Fehlversuchen bleibt ein Kontakt `failed` (von Hand übernehmen geht weiter). */
const MAX_ATTEMPTS = 4;
/**
 * Nach einem Stopp (Tageslimit der Accounts, Zugang, KI ausgefallen) ruht die automatische Übernahme so lange –
 * höchstens aber bis kurz nach Mitternacht, wenn die Tageslimits wieder frei sind (10.11.: bei vollem Limit lief sie
 * alle 3 Minuten doppelt ins Leere, rund 960 gleiche Warnungen am Tag).
 */
export const IMPORT_REST_MS = 30 * MINUTE_MS;

/** Eintrag aus `GET /users/invite/sent` (Felder laut offiziellem SDK `unipile-node-sdk`, `InvitationSent`). */
export interface SentInvitationItem {
  id?: string;
  parsed_datetime?: string | null;
  invited_user?: string | null;
  invited_user_id?: string | null;
  invited_user_public_id?: string | null;
  invited_user_description?: string | null;
}

/** Eintrag aus `GET /users/relations` (`UserRelation`). */
export interface RelationItem {
  member_id?: string;
  public_identifier?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  public_profile_url?: string;
  created_at?: number;
}

/** Zeitpunkt einer Verbindung in ms – Unipile liefert Sekunden oder Millisekunden. */
export function relationTime(created: number | undefined | null): number | null {
  if (!created || created <= 0) return null;
  return created < 1e12 ? created * 1000 : created;
}

/** Schlüssel einer Person: LinkedIn-ID (ACoAA…) oder – ohne – die öffentliche Kennung, klein geschrieben. */
export function personKey(providerId: string | null | undefined, publicIdentifier: string | null | undefined): string | null {
  const key = (providerId || publicIdentifier || '').trim().toLowerCase();
  return key || null;
}

interface ContactRow {
  id: string;
  founder: string;
  person_key: string;
  provider_id: string | null;
  public_identifier: string | null;
  name: string;
  headline: string | null;
  profile_url: string | null;
  connected_at: number | null;
  manual_invite: number;
  sent_at: number | null;
  status: string;
  lead_id: string | null;
  note: string | null;
  attempts: number;
  updated_at: number;
  /** Schon abgerufenes Profil (JSON von `enrich`), Migration 50 – fehlt bei älteren Zeilen. */
  enriched?: string | null;
}

function toContact(row: ContactRow): LinkedInNewContact {
  return {
    id: row.id,
    founder: row.founder as AuthFounderId,
    name: row.name,
    headline: row.headline,
    profileUrl: row.profile_url,
    connectedAt: row.connected_at,
    manualInvite: row.manual_invite === 1,
    status: row.status as LinkedInNewContactStatus,
    leadId: row.lead_id,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

/**
 * „Von Hand“ zählt erst ab Beobachtungsbeginn (erster Abgleich der gesendeten Anfragen, Marke `sent:<Gründer>`, 07.11.):
 * Was beim ersten Lesen schon offen war, ist älter – ob von Hand oder übers Cockpit, ist unbekannt. Zählte es mit, stünden
 * hunderte alte, noch offene Anfragen als „von Hand“ in der Statistik und drückten die Quote. `s` = linkedin_sent_invites.
 */
export const TRACKED_MANUAL = `(s.source = 'logged' OR (s.source = 'manual' AND s.sent_at > 0
  AND s.sent_at >= COALESCE((SELECT m.since FROM linkedin_relation_marks m WHERE m.account_id = 'sent:' || s.founder), 0)))`;

/**
 * Anfrage, die jemand von Hand auf LinkedIn geschickt und im Cockpit über „Manuell vernetzt“ eingetragen hat (09.11.):
 * als `logged` merken (= von Hand, eingetragen) – sonst hielte der nächste Abgleich sie für eine Cockpit-Anfrage (der Lead
 * steht ja schon auf „Anfrage gesendet“). Eigener Wert, weil die Regel „von Hand erst ab Beobachtungsbeginn“
 * (`TRACKED_MANUAL`) für eingetragene nicht gilt – ihr Ursprung ist bekannt.
 */
export function recordManualInvite(db: Database, founder: AuthFounderId, lead: CockpitLead, at: number): void {
  const key = personKey(lead.person.providerId, lead.person.publicIdentifier);
  if (!key) return;
  db.prepare(
    `INSERT INTO linkedin_sent_invites (founder, person_key, provider_id, public_identifier, name, headline, source, sent_at, seen_at, lead_id)
     VALUES (?, ?, ?, ?, ?, ?, 'logged', ?, ?, ?)
     ON CONFLICT (founder, person_key) DO UPDATE SET source = 'logged', sent_at = excluded.sent_at, lead_id = excluded.lead_id`,
  ).run(
    founder,
    key,
    lead.person.providerId,
    lead.person.publicIdentifier?.toLowerCase() ?? null,
    `${lead.person.firstName} ${lead.person.lastName}`.trim(),
    lead.person.headline || null,
    at,
    at,
    lead.id,
  );
}

/** Speicher für gesehene Anfragen und neue Kontakte. */
export class ConnectionStore {
  constructor(
    private readonly db: Database,
    private readonly leads: LeadStore,
  ) {}

  /** Anfrage, die das Cockpit gerade gesendet hat (oder ein eingetragener Versand) – zählt nie als „von Hand“. */
  recordCockpitInvite(founder: AuthFounderId, lead: CockpitLead, at: number): void {
    const key = personKey(lead.person.providerId, lead.person.publicIdentifier);
    if (!key) return;
    this.db
      .prepare(
        `INSERT INTO linkedin_sent_invites (founder, person_key, provider_id, public_identifier, name, headline, source, sent_at, seen_at, lead_id)
         VALUES (?, ?, ?, ?, ?, ?, 'cockpit', ?, ?, ?) ON CONFLICT (founder, person_key) DO NOTHING`,
      )
      .run(
        founder,
        key,
        lead.person.providerId,
        lead.person.publicIdentifier?.toLowerCase() ?? null,
        `${lead.person.firstName} ${lead.person.lastName}`.trim(),
        lead.person.headline || null,
        at,
        at,
        lead.id,
      );
  }

  private sentRow(founder: AuthFounderId, providerId: string | null | undefined, publicIdentifier: string | null | undefined) {
    const keys = [personKey(providerId, null), personKey(null, publicIdentifier)].filter((key): key is string => !!key);
    for (const key of keys) {
      const row = this.db.prepare('SELECT * FROM linkedin_sent_invites WHERE founder = ? AND person_key = ?').get(founder, key) as
        | { person_key: string; source: string; sent_at: number; lead_id: string | null }
        | undefined;
      if (row) return row;
    }
    if (publicIdentifier) {
      const row = this.db
        .prepare('SELECT * FROM linkedin_sent_invites WHERE founder = ? AND public_identifier = ? LIMIT 1')
        .get(founder, publicIdentifier.toLowerCase()) as { person_key: string; source: string; sent_at: number; lead_id: string | null } | undefined;
      if (row) return row;
    }
    return null;
  }

  /**
   * Offene, gesendete Anfragen eines Accounts merken. Neue, die nicht aus dem Cockpit kamen, sind „von Hand“; steht
   * die Person als „Neu“ im Cockpit, wird die Anfrage dort eingetragen (dann übernimmt der normale Abgleich die
   * Annahme). Gibt die Zahl der neu gesehenen Anfragen von Hand zurück.
   */
  recordSentList(founder: AuthFounderId, items: readonly SentInvitationItem[], now: number): number {
    // Erstes Lesen für diesen Gründer: Anfragen ohne Datum laut LinkedIn sind schon älter (sonst zählten alle offenen
    // Anfragen als „heute gesendet“). Danach heißt neu ohne Datum: seit dem letzten Abgleich gesendet.
    const mark = `sent:${founder}`;
    const first = !this.db.prepare('SELECT 1 FROM linkedin_relation_marks WHERE account_id = ?').get(mark);
    if (first) this.db.prepare('INSERT INTO linkedin_relation_marks (account_id, since) VALUES (?, ?) ON CONFLICT (account_id) DO NOTHING').run(mark, now);
    let manual = 0;
    for (const item of items) {
      const key = personKey(item.invited_user_id, item.invited_user_public_id);
      if (!key) continue;
      if (this.sentRow(founder, item.invited_user_id, item.invited_user_public_id)) continue;
      const parsed = item.parsed_datetime ? Date.parse(item.parsed_datetime) : NaN;
      const sentAt = Number.isFinite(parsed) ? Math.min(parsed, now) : first ? 0 : now;
      const lead = this.leads.findExisting({ providerId: item.invited_user_id ?? '', publicIdentifier: item.invited_user_public_id ?? null });
      // Über das Cockpit gesendet oder dort eingetragen: Lead steht schon auf „Anfrage gesendet“ oder weiter.
      const fromCockpit = !!lead && lead.stage !== 'new';
      let leadId: string | null = fromCockpit ? lead!.id : null;
      // Ohne bekanntes Datum (erstes Lesen) nicht eintragen – das Ereignis zählte sonst für heute.
      if (lead && lead.stage === 'new' && sentAt > 0) {
        try {
          // Über wessen Account die Anfrage ging – der Abgleich dieses Accounts erkennt dann die Annahme.
          this.leads.applyAction(
            lead.id,
            { action: 'invite_sent', at: sentAt },
            founder,
            now,
            { state: { sentBy: founder, invitationId: item.id ?? null, invitedAt: sentAt, chatId: null, chatStartedAt: null } },
            null,
            'Vernetzungsanfrage gesendet · von Hand auf LinkedIn',
          );
          leadId = lead.id;
        } catch {
          // Passt nicht (mehr) – dann nur zählen.
        }
      }
      if (!fromCockpit && sentAt > 0) manual++;
      this.db
        .prepare(
          `INSERT INTO linkedin_sent_invites (founder, person_key, provider_id, public_identifier, name, headline, source, sent_at, seen_at, lead_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (founder, person_key) DO NOTHING`,
        )
        .run(
          founder,
          key,
          item.invited_user_id ?? null,
          item.invited_user_public_id?.toLowerCase() ?? null,
          item.invited_user?.trim() || null,
          item.invited_user_description?.trim() || null,
          fromCockpit ? 'cockpit' : 'manual',
          sentAt,
          now,
          leadId,
        );
    }
    return manual;
  }

  /** Ab wann neue Kontakte dieses Accounts zählen (beim ersten Abgleich: jetzt – ältere nur über die Überprüfung). */
  relationsSince(accountId: string, now: number): number {
    this.db.prepare('INSERT INTO linkedin_relation_marks (account_id, since) VALUES (?, ?) ON CONFLICT (account_id) DO NOTHING').run(accountId, now);
    const row = this.db.prepare('SELECT since FROM linkedin_relation_marks WHERE account_id = ?').get(accountId) as { since: number };
    return row.since;
  }

  /**
   * Neuer Kontakt ohne Lead → zur Übernahme vormerken (einmal je Gründer und Person). Mit Lead nur die Annahme an der
   * gesehenen Anfrage merken. Gibt den vorgemerkten Kontakt zurück oder null.
   */
  noteRelation(founder: AuthFounderId, relation: RelationItem, now: number, status: LinkedInNewContactStatus = 'pending'): LinkedInNewContact | null {
    const key = personKey(relation.member_id, relation.public_identifier);
    if (!key) return null;
    const connectedAt = relationTime(relation.created_at);
    const sent = this.sentRow(founder, relation.member_id, relation.public_identifier);
    if (sent) {
      this.db.prepare('UPDATE linkedin_sent_invites SET accepted_at = COALESCE(accepted_at, ?) WHERE founder = ? AND person_key = ?').run(connectedAt ?? now, founder, sent.person_key);
    }
    const lead = this.leads.findExisting({ providerId: relation.member_id ?? '', publicIdentifier: relation.public_identifier ?? null });
    if (lead) return null;
    const existing = this.contactByKey(founder, key);
    if (existing) return existing;
    const manual = !!sent && (sent.source === 'manual' || sent.source === 'logged');
    const name = [relation.first_name, relation.last_name].map((part) => part?.trim()).filter(Boolean).join(' ') || relation.public_identifier || 'Unbekannt';
    const profileUrl = relation.public_profile_url?.startsWith('https://')
      ? relation.public_profile_url
      : relation.public_identifier
        ? `https://www.linkedin.com/in/${encodeURIComponent(relation.public_identifier)}`
        : null;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO linkedin_new_contacts (id, founder, person_key, provider_id, public_identifier, name, headline, profile_url, connected_at,
           manual_invite, sent_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (founder, person_key) DO NOTHING`,
      )
      .run(
        id,
        founder,
        key,
        relation.member_id ?? null,
        relation.public_identifier?.toLowerCase() ?? null,
        name,
        relation.headline?.trim() || null,
        profileUrl,
        connectedAt,
        manual ? 1 : 0,
        manual ? sent!.sent_at : null,
        status,
        now,
        now,
      );
    return this.contactByKey(founder, key);
  }

  private contactByKey(founder: AuthFounderId, key: string): LinkedInNewContact | null {
    const row = this.db.prepare('SELECT * FROM linkedin_new_contacts WHERE founder = ? AND person_key = ?').get(founder, key) as ContactRow | undefined;
    return row ? toContact(row) : null;
  }

  contactRow(id: string): ContactRow | null {
    return (this.db.prepare('SELECT * FROM linkedin_new_contacts WHERE id = ?').get(id) as ContactRow | undefined) ?? null;
  }

  contact(id: string): LinkedInNewContact | null {
    const row = this.contactRow(id);
    return row ? toContact(row) : null;
  }

  /**
   * Kontakt per LinkedIn-Link (Feedback #1, 11.11.): als Anfrage „von Hand“ merken, bei schon Vernetzten mit Annahme –
   * so zählt er in der Statistik „von Hand“ und der Abgleich hält die offene Anfrage nicht für eine des Cockpits.
   */
  recordContactInvite(founder: AuthFounderId, lead: CockpitLead, at: number): void {
    if (lead.stage !== 'invited' && lead.stage !== 'connected') return;
    recordManualInvite(this.db, founder, lead, at);
    if (lead.stage === 'connected') {
      const key = personKey(lead.person.providerId, lead.person.publicIdentifier);
      if (key) this.db.prepare('UPDATE linkedin_sent_invites SET accepted_at = COALESCE(accepted_at, ?) WHERE founder = ? AND person_key = ?').run(at, founder, key);
    }
  }

  /** Gibt es Kontakte, die noch auf die Übernahme warten? */
  hasPending(): boolean {
    return !!this.db.prepare("SELECT 1 FROM linkedin_new_contacts WHERE status = 'pending' LIMIT 1").get();
  }

  pending(limit: number): ContactRow[] {
    return this.db
      .prepare("SELECT * FROM linkedin_new_contacts WHERE status = 'pending' ORDER BY manual_invite DESC, created_at ASC LIMIT ?")
      .all(limit) as unknown as ContactRow[];
  }

  list(limit = 200): LinkedInNewContact[] {
    return (this.db.prepare('SELECT * FROM linkedin_new_contacts ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as ContactRow[]).map(toContact);
  }

  update(id: string, change: { status: LinkedInNewContactStatus; leadId?: string | null; note?: string | null; attempt?: boolean }, now: number): void {
    this.db
      .prepare(
        'UPDATE linkedin_new_contacts SET status = ?, lead_id = COALESCE(?, lead_id), note = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?',
      )
      .run(change.status, change.leadId ?? null, change.note ?? null, change.attempt ? 1 : 0, now, id);
  }

  /** Abgerufenes Profil am Kontakt merken (09.11.): ein neuer Versuch liest LinkedIn nicht noch einmal. */
  saveEnriched(id: string, enriched: unknown): void {
    this.db.prepare('UPDATE linkedin_new_contacts SET enriched = ? WHERE id = ?').run(JSON.stringify(enriched), id);
  }

  /** Übernommener Kontakt mit gesehener Anfrage: die Anfrage gehört jetzt zum Lead (zählt dann über den Verlauf). */
  linkSent(founder: AuthFounderId, providerId: string | null, publicIdentifier: string | null, leadId: string): void {
    const sent = this.sentRow(founder, providerId, publicIdentifier);
    if (sent) this.db.prepare('UPDATE linkedin_sent_invites SET lead_id = ? WHERE founder = ? AND person_key = ?').run(leadId, founder, sent.person_key);
  }

  /** Von Hand gesendete Anfragen seit `since` (auch die, aus denen schon ein Lead wurde). */
  manualSince(founder: AuthFounderId, since: number): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM linkedin_sent_invites WHERE founder = ? AND source IN ('manual', 'logged') AND sent_at >= ?").get(founder, since) as {
        n: number;
      }
    ).n;
  }

  /** Anfragen von Hand seit `since` mit Stand, neueste zuerst (Knopf „wer hat angenommen?“, 06.11.). */
  manualList(since: number): LinkedInManualInvite[] {
    const rows = this.db
      .prepare(
        `SELECT s.founder, s.name, s.headline, s.public_identifier, s.sent_at, s.accepted_at,
                CASE WHEN EXISTS (SELECT 1 FROM leads l WHERE l.id = s.lead_id) THEN s.lead_id END AS lead_id
           FROM linkedin_sent_invites s
          WHERE ${TRACKED_MANUAL} AND s.sent_at >= ?
          ORDER BY s.sent_at DESC LIMIT 1000`,
      )
      .all(since) as {
      founder: string;
      name: string | null;
      headline: string | null;
      public_identifier: string | null;
      sent_at: number;
      accepted_at: number | null;
      lead_id: string | null;
    }[];
    return rows.map((row) => {
      // Lead da (z. B. übernommen) → Stand und Name aus dem Lead.
      const lead = row.lead_id ? this.leads.get(row.lead_id) : null;
      const accepted = row.accepted_at ?? (lead ? (this.leads.events(lead.id).find((event) => event.kind === 'invite_accepted')?.at ?? null) : null);
      return {
        founder: row.founder as AuthFounderId,
        name: (lead ? `${lead.person.firstName} ${lead.person.lastName}`.trim() : row.name) || 'Unbekannt',
        headline: lead?.person.headline || row.headline,
        profileUrl: lead?.person.profileUrl ?? (row.public_identifier ? `https://www.linkedin.com/in/${encodeURIComponent(row.public_identifier)}` : null),
        sentAt: row.sent_at,
        acceptedAt: accepted,
        leadId: lead?.id ?? null,
      };
    });
  }

  /** Von Hand gesendete Anfragen im Zeitraum je Tag-Beginn (für die Statistik). */
  manualRows(founder: AuthFounderId, since: number): { sentAt: number; acceptedAt: number | null; leadId: string | null }[] {
    return (
      this.db
        .prepare(`SELECT sent_at, accepted_at, lead_id FROM linkedin_sent_invites s WHERE s.founder = ? AND ${TRACKED_MANUAL} AND s.sent_at >= ?`)
        .all(founder, since) as { sent_at: number; accepted_at: number | null; lead_id: string | null }[]
    ).map((row) => ({ sentAt: row.sent_at, acceptedAt: row.accepted_at, leadId: row.lead_id }));
  }
}

export interface ImporterDeps {
  config: Config;
  store: ConnectionStore;
  leads: LeadStore;
  log: FastifyBaseLogger;
  /** Aktueller Such-Adapter (Profil + Firmenseite über die Scraping-Accounts, KI). */
  adapter: () => LeadSearchAdapter;
  /** true, solange eine Lead-Suche läuft – dann wartet die Übernahme (nie zwei Läufe gleichzeitig über die Accounts). */
  busy?: () => boolean;
  /** Bestehenden LinkedIn-Chat des neuen Leads übernehmen. */
  importChat?: (leadId: string) => Promise<unknown>;
  random?: () => number;
  /** Untergrenze der Pause zwischen zwei Profilen (ms), Standard 3000 – Tests setzen 0. */
  minPauseMs?: number;
}

type Outcome = { status: LinkedInNewContactStatus; leadId: string | null; note: string | null };

/** Übernimmt vorgemerkte neue Kontakte als Leads (nacheinander, mit Schutzpausen). */
export class NewContactImporter {
  private running: Promise<number> | null = null;
  /** Bis dahin ruht die automatische Übernahme (nach einem Stopp wegen Limit, Zugang oder KI). */
  private restUntil = 0;
  /** Woran die letzte Runde gescheitert ist (für die Job-Messung) – null = lief sauber durch. */
  private failure: string | null = null;

  constructor(private readonly deps: ImporterDeps) {}

  /** Eine Runde: bis zu `IMPORT_PER_ROUND` vorgemerkte Kontakte. Läuft nie doppelt. */
  run(): Promise<number> {
    if (!this.running) {
      this.running = this.round().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /**
   * Ruht die automatische Übernahme gerade? Nur für den Anstoß aus dem Abgleich – `run()` von Hand (Überprüfung,
   * Tests) und „doch übernehmen“ versuchen es immer.
   */
  resting(now = Date.now()): boolean {
    return now < this.restUntil;
  }

  /** Fehler der letzten Runde (null = keiner): Hintergrund-Jobs zählen sie damit als gescheitert. */
  get lastFailure(): string | null {
    return this.failure;
  }

  private async round(): Promise<number> {
    // Vor der Prüfung auf „belegt“: Eine Runde, die gar nicht läuft, erbt nicht den Fehler der vorigen (Job-Messung).
    this.failure = null;
    if (this.deps.busy?.()) return 0;
    this.restUntil = 0;
    let done = 0;
    for (const row of this.deps.store.pending(IMPORT_PER_ROUND)) {
      if (this.deps.busy?.()) break;
      if (done > 0 && this.deps.config.mode === 'live') {
        // Schutzpause 3–8 s wie in der Lead-Suche (Tests setzen 0).
        const min = this.deps.minPauseMs ?? 3000;
        await sleep(randomBetween(min, min ? Math.max(min, 8000) : 0, this.deps.random));
      }
      const stop = await this.importOne(row.id, false);
      done++;
      if (stop) {
        // Tageslimit oder Ausfall: nicht alle paar Minuten neu anrennen – später, spätestens kurz nach Mitternacht.
        const now = Date.now();
        this.restUntil = Math.min(now + IMPORT_REST_MS, nextLocalMidnight(now, this.deps.config.linkedin.workHours.timeZone) + MINUTE_MS);
        break;
      }
    }
    return done;
  }

  /**
   * Einen Kontakt übernehmen. `force`: aussortierten Kontakt trotzdem als Lead anlegen (Knopf „doch übernehmen“).
   * Gibt true zurück, wenn die Runde aufhören soll (Tageslimit/Zugang).
   */
  async importOne(id: string, force: boolean): Promise<boolean> {
    const row = this.deps.store.contactRow(id);
    if (!row) return false;
    const now = Date.now();
    let outcome: Outcome;
    let stop = false;
    try {
      outcome = await this.process(row, force);
    } catch (error) {
      const limit = error instanceof AdapterError && (error.fatal || error.code === 'rate_limit');
      stop = limit;
      const note = error instanceof AdapterError ? `${error.title}: ${error.message}` : 'Übernahme fehlgeschlagen.';
      this.failure = error instanceof AdapterError ? error.title : 'Übernahme fehlgeschlagen';
      this.deps.log.warn({ contact: id, err: String(error) }, 'Neuer LinkedIn-Kontakt nicht übernommen');
      const failed = row.attempts + 1 >= MAX_ATTEMPTS && !limit;
      this.deps.store.update(id, { status: failed ? 'failed' : 'pending', note: failed ? note : `${note} Nächster Versuch beim nächsten Abgleich.`, attempt: !limit }, now);
      return stop;
    }
    this.deps.store.update(id, { status: outcome.status, leadId: outcome.leadId, note: outcome.note, attempt: true }, Date.now());
    if (outcome.status === 'imported' && outcome.leadId) {
      this.deps.store.linkSent(row.founder as AuthFounderId, row.provider_id, row.public_identifier, outcome.leadId);
      try {
        await this.deps.importChat?.(outcome.leadId);
      } catch (error) {
        this.deps.log.warn({ leadId: outcome.leadId, err: String(error) }, 'Chat des neuen Kontakts nicht übernommen');
      }
      this.deps.log.info({ contact: id, leadId: outcome.leadId, manual: row.manual_invite === 1 }, 'Neuer LinkedIn-Kontakt übernommen');
    }
    return stop;
  }

  private async process(row: ContactRow, force: boolean): Promise<Outcome> {
    const owner = row.founder as AuthFounderId;
    const known = this.deps.leads.findExisting({ providerId: row.provider_id ?? '', publicIdentifier: row.public_identifier });
    if (known) return { status: 'imported', leadId: known.id, note: 'Gab es schon im Cockpit.' };
    const manual = row.manual_invite === 1;
    const [firstName, ...rest] = row.name.split(' ');
    const hit: SearchHit = {
      providerId: row.provider_id ?? row.public_identifier ?? row.person_key,
      publicIdentifier: row.public_identifier,
      firstName: firstName ?? row.name,
      lastName: rest.join(' '),
      headline: row.headline ?? '',
      location: null,
      networkDistance: 1,
      profileUrl: row.profile_url,
    };
    const { profile, providerId, publicIdentifier } = await this.enrichOnce(row, hit);
    const assessed = await this.assess(hit, profile);
    const via: ContactVia = manual ? 'manual_invite' : 'new_connection';
    if (!manual && !force) {
      if (!assessed) return { status: 'rejected', leadId: null, note: 'Ohne KI nicht geprüft – bei Bedarf von Hand übernehmen.' };
      if (!assessed.qualified) return { status: 'rejected', leadId: null, note: `Passt laut KI nicht: ${assessed.assessment.reason}` };
    }
    const contact: ContactProfile = {
      firstName: hit.firstName,
      lastName: hit.lastName,
      headline: profile.headline || hit.headline,
      position: profile.position ?? '',
      company: profile.companyName ?? '',
      location: profile.location,
      website: profile.companyWebsite,
      providerId: providerId ?? hit.providerId,
      publicIdentifier: publicIdentifier ?? hit.publicIdentifier,
      profileUrl: hit.profileUrl,
      networkDistance: 1,
      pendingInvitation: false,
    };
    const { lead } = this.deps.leads.createFromConnection({
      contact,
      owner,
      via,
      assessment: assessed?.assessment ?? null,
      company: {
        name: profile.companyName ?? '',
        website: profile.companyWebsite,
        industry: profile.companyIndustry ?? (assessed ? CATEGORY_LABELS[assessed.assessment.category] : null),
      },
      hiring: assessed?.hiring ?? detectHiring(hit, profile),
      sentAt: row.sent_at,
      connectedAt: row.connected_at,
    });
    return { status: 'imported', leadId: lead.id, note: force && !manual ? 'Von Hand übernommen.' : null };
  }

  /**
   * Profil und Firmenseite höchstens einmal je Kontakt abrufen (Bericht 09.11.): Scheitert danach etwas (KI nicht
   * erreichbar, Guthaben leer …), bleibt der Kontakt „wartend“ und kommt beim nächsten Abgleich – alle paar Minuten –
   * wieder dran. Vorher kostete jeder Versuch zwei Abrufe vom Tageslimit der Accounts.
   */
  private async enrichOnce(row: ContactRow, hit: SearchHit): Promise<Awaited<ReturnType<NewContactImporter['enrich']>>> {
    if (row.enriched) {
      try {
        return JSON.parse(row.enriched) as Awaited<ReturnType<NewContactImporter['enrich']>>;
      } catch {
        // kaputt → neu abrufen
      }
    }
    const result = await this.enrich(hit);
    this.deps.store.saveEnriched(row.id, result);
    return result;
  }

  private async enrich(hit: SearchHit): Promise<{ profile: EnrichedProfile; providerId: string | null; publicIdentifier: string | null }> {
    if (this.deps.config.mode === 'mock') {
      return {
        profile: {
          headline: hit.headline || 'Geschäftsführer (Simulation)',
          position: 'Geschäftsführer',
          companyName: `${hit.lastName || hit.firstName} Finanz GmbH (Simulation)`,
          companyDescription: 'Kapitalanlage-Vertrieb mit 15 Beratern (Simulation).',
          companyWebsite: null,
          companyIndustry: 'Finanzdienstleistungen',
          location: 'Hamburg',
        },
        providerId: null,
        publicIdentifier: null,
      };
    }
    const result = await this.deps.adapter().enrich(hit, this.context());
    return { profile: result.profile, providerId: result.providerId ?? null, publicIdentifier: result.publicIdentifier ?? null };
  }

  private async assess(hit: SearchHit, profile: EnrichedProfile): Promise<{ qualified: boolean; assessment: LeadAssessment; hiring: ReturnType<typeof detectHiring> } | null> {
    if (this.deps.config.mode === 'mock') {
      return {
        qualified: true,
        assessment: { category: 'kapitalanlage_vertrieb', confidence: 0.82, reason: 'Geschäftsführer eines Kapitalanlage-Vertriebs (Simulation).', summary: 'Neuer Kontakt aus LinkedIn. Passt zur Zielgruppe (Simulation).' },
        hiring: null,
      };
    }
    const adapter = this.deps.adapter();
    if (!adapter.canQualify) return null;
    try {
      const graded = parseQualification(await adapter.qualify(hit, profile, this.context()), this.deps.config.minConfidence);
      const rated = applyTargetRules(hit, profile, graded);
      const hiring = detectHiring(hit, profile) ?? rated.hiring ?? null;
      return { qualified: rated.qualified, assessment: { category: rated.category, confidence: rated.confidence, reason: rated.reason, summary: rated.summary }, hiring };
    } catch (error) {
      if (error instanceof QualificationValidationError) return null;
      throw error;
    }
  }

  private context(): RunContext {
    // Kennung je Tag: Der Live-Adapter zählt Profilabrufe je Kennung (höchstens `MAX_RESULTS_LIMIT`).
    return { signal: AbortSignal.timeout(5 * MINUTE_MS), runId: `neue-kontakte-${new Date().toISOString().slice(0, 10)}`, profile: DEFAULT_SEARCH_PROFILE };
  }
}
