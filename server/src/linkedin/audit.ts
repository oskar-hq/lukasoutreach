import type { FastifyBaseLogger } from 'fastify';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import type { CockpitLead } from '../../../shared/leads.js';
import {
  LINKEDIN_AUDIT_DAYS_DEFAULT,
  LINKEDIN_AUDIT_DAYS_MAX,
  type LinkedInAuditFounder,
  type LinkedInAuditLead,
  type LinkedInAuditStatus,
  type LinkedInInviteStatsDay,
  type LinkedInInviteStatsFounder,
  type LinkedInInviteTotals,
  type LinkedInInviteStatsResponse,
} from '../../../shared/linkedin.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { LeadStore } from '../leads/leadStore.js';
import { randomBetween, sleep } from '../lib/sleep.js';
import { relationTime, TRACKED_MANUAL, type ConnectionStore, type NewContactImporter, type RelationItem } from './connections.js';
import { localDayStart, localTime, stableNumber } from './guard.js';
import { classify, type LinkedInService } from './service.js';

/**
 * Überprüfung „wurde etwas übersehen?“ und Statistik der Anfragen (Teammeeting 05.11., Vertrag `shared/linkedin.ts`
 * → Anfragen von Hand …, Punkte 3 und 4). Nur lesend bei LinkedIn – sendet nie.
 */

declare module 'fastify' {
  interface FastifyInstance {
    /** Für Tests: LinkedIn-Dienst (eingeplante Anfragen `processQueue()`), Überprüfung und Übernahme neuer Kontakte. */
    linkedinService: LinkedInService;
    linkedinAudit: LinkedInAudit;
    contactImporter: NewContactImporter;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Zwischen zwei Überprüfungen live mindestens so lange warten (jede liest Kontakte und Chats bei LinkedIn). */
export const AUDIT_COOLDOWN_MS = 60 * 60 * 1000;
/** Kontakte je Seite und höchstens so viele Seiten (2.000 Kontakte) je Account. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** Übernahme-Runden nach der Überprüfung (je bis zu 10 Kontakte). */
const IMPORT_ROUNDS = 5;

export interface AuditDeps {
  config: Config;
  db: Database;
  leads: LeadStore;
  linkedin: LinkedInService;
  connections: ConnectionStore;
  importer: NewContactImporter;
  log: FastifyBaseLogger;
  random?: () => number;
  /** Untergrenze der Pause zwischen zwei Chat-Prüfungen (ms), Standard 3000 – Tests setzen 0. */
  minPauseMs?: number;
}

const name = (lead: CockpitLead) => `${lead.person.firstName} ${lead.person.lastName}`.trim();
const MESSAGE_KINDS = new Set(['message_sent', 'message_received']);

export class LinkedInAudit {
  private state: LinkedInAuditStatus = { running: false, startedAt: null, finishedAt: null, days: LINKEDIN_AUDIT_DAYS_DEFAULT, done: 0, total: 0, founders: [] };

  constructor(private readonly deps: AuditDeps) {}

  get status(): LinkedInAuditStatus {
    return structuredClone(this.state);
  }

  /** Live höchstens einmal je Stunde (liest bei LinkedIn) – ms bis zur nächsten, 0 = jetzt möglich. */
  cooldownLeft(now = Date.now()): number {
    if (this.deps.config.mode !== 'live' || this.state.running || !this.state.finishedAt) return 0;
    return Math.max(0, this.state.finishedAt + AUDIT_COOLDOWN_MS - now);
  }

  /** Startet im Hintergrund; läuft schon eine → `started: false`. */
  start(days = LINKEDIN_AUDIT_DAYS_DEFAULT): { started: boolean; done: Promise<void> | null } {
    if (this.state.running) return { started: false, done: null };
    const span = Math.min(LINKEDIN_AUDIT_DAYS_MAX, Math.max(1, Math.floor(days)));
    this.state = { running: true, startedAt: Date.now(), finishedAt: null, days: span, done: 0, total: AUTH_FOUNDER_IDS.length, founders: [] };
    const done = this.runAll(span)
      .catch((error) => this.deps.log.error({ err: error }, 'LinkedIn-Überprüfung abgebrochen'))
      .finally(() => {
        this.state.running = false;
        this.state.finishedAt = Date.now();
      });
    return { started: true, done };
  }

  private async runAll(days: number): Promise<void> {
    for (const founder of AUTH_FOUNDER_IDS) {
      const result = await this.auditFounder(founder, days);
      this.state.founders.push(result);
      this.state.done++;
    }
    // Neue Kontakte ohne Lead gleich übernehmen (mit KI wie im Abgleich), dann ihren Stand eintragen.
    for (let round = 0; round < IMPORT_ROUNDS; round++) {
      if ((await this.deps.importer.run()) === 0) break;
    }
    for (const founder of this.state.founders) {
      founder.unknown = founder.unknown.map((contact) => this.deps.connections.contact(contact.id) ?? contact);
      founder.acceptedAfter = this.windowRate(founder.founder, Date.now() - days * DAY_MS).accepted;
    }
  }

  private async auditFounder(founder: AuthFounderId, days: number): Promise<LinkedInAuditFounder> {
    const since = Date.now() - days * DAY_MS;
    const before = this.windowRate(founder, since);
    const result: LinkedInAuditFounder = {
      founder,
      connections: 0,
      ok: 0,
      fixedAccepted: [],
      chatImported: [],
      notMessaged: [],
      unknown: [],
      invitesSent: before.sent,
      acceptedBefore: before.accepted,
      acceptedAfter: before.accepted,
      problem: null,
    };
    const reader = this.deps.linkedin.readerFor(founder);
    if (reader.problem) {
      result.problem = reader.problem;
      return result;
    }
    let relations: RelationItem[];
    try {
      relations = await this.relations(founder, reader, since);
    } catch (error) {
      const classified = classify(error);
      this.deps.log.warn({ founder, error: classified.log }, 'LinkedIn-Überprüfung: Kontakte nicht lesbar');
      result.problem = `${this.deps.linkedin.founderName(founder)}: ${classified.reason.replace(/ – nichts gesendet\.?$/, '.')}`;
      return result;
    }
    result.connections = relations.length;
    let checkedChats = 0;
    for (const relation of relations) {
      const connectedAt = relationTime(relation.created_at);
      const found = this.deps.leads.findExisting({ providerId: relation.member_id ?? '', publicIdentifier: relation.public_identifier ?? null });
      if (!found) {
        const contact = this.deps.connections.noteRelation(founder, relation, Date.now());
        if (contact) result.unknown.push(contact);
        continue;
      }
      let lead: CockpitLead = found;
      const entry = (): LinkedInAuditLead => ({ leadId: lead.id, name: name(lead), connectedAt });
      let fixed = false;
      if (lead.stage === 'new' || lead.stage === 'invited') {
        const at = connectedAt ? Math.min(Math.max(connectedAt, lead.lastContactAt ?? 0), Date.now()) : undefined;
        lead = this.deps.leads.applyAction(lead.id, { action: 'invite_accepted', at }, null, Date.now(), {}, null);
        result.fixedAccepted.push(entry());
        fixed = true;
      }
      if (lead.stage === 'connected' && !this.deps.leads.events(lead.id).some((event) => MESSAGE_KINDS.has(event.kind))) {
        // Vielleicht wurde auf LinkedIn geschrieben, aber nichts eingetragen → Chat prüfen und übernehmen.
        if (checkedChats > 0 && this.deps.config.mode === 'live') {
          const min = this.deps.minPauseMs ?? 3000;
          await sleep(randomBetween(min, min ? Math.max(min, 8000) : 0, this.deps.random));
        }
        checkedChats++;
        const chat = await this.deps.linkedin.importContactChat(lead.id);
        if (chat && chat.imported > 0) result.chatImported.push(entry());
        else result.notMessaged.push(entry());
        continue;
      }
      if (!fixed) result.ok++;
    }
    return result;
  }

  /** Kontakte seit `since`, neueste zuerst. Simulation: aus den Leads plus ein erfundener Kontakt ohne Lead. */
  private async relations(founder: AuthFounderId, reader: ReturnType<LinkedInService['readerFor']>, since: number): Promise<RelationItem[]> {
    if (this.deps.config.mode === 'mock') return this.mockRelations(founder, since);
    const list: RelationItem[] = [];
    let cursor: string | null | undefined = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response: { items: RelationItem[]; cursor?: string | null } = await reader.client!.listRelations(
        { accountId: reader.accountId!, limit: PAGE_SIZE, cursor },
        AbortSignal.timeout(30_000),
      );
      let older = false;
      for (const relation of response.items ?? []) {
        const at = relationTime(relation.created_at);
        if (at !== null && at < since) {
          older = true;
          continue;
        }
        list.push(relation);
      }
      cursor = response.cursor;
      if (!cursor || older) break;
    }
    return list;
  }

  private mockRelations(founder: AuthFounderId, since: number): RelationItem[] {
    const now = Date.now();
    const leads = this.deps.leads
      .list({ stages: ['invited', 'connected', 'contacted', 'replied', 'meeting'], limit: 100_000 })
      .leads.filter((lead) => (lead.linkedin?.sentBy ?? lead.owner) === founder && lead.lastActivityAt >= since)
      // Simulation: jede zweite offene Anfrage gilt als angenommen.
      .filter((lead) => lead.stage !== 'invited' || stableNumber(lead.id) % 2 === 0);
    const relations: RelationItem[] = leads.map((lead) => ({
      member_id: lead.person.providerId,
      public_identifier: lead.person.publicIdentifier ?? undefined,
      first_name: lead.person.firstName,
      last_name: lead.person.lastName,
      created_at: Math.max(since, lead.lastActivityAt),
    }));
    if (founder === AUTH_FOUNDER_IDS[0]) {
      relations.push({ member_id: 'mock-new-contact-mara', public_identifier: 'mara-beispiel', first_name: 'Mara', last_name: 'Beispiel', headline: 'Geschäftsführerin · Beispiel Finanz GmbH (Simulation)', created_at: now - DAY_MS });
    }
    return relations;
  }

  /**
   * Anfragen seit `since` über den Account des Gründers und davon angenommen: Verlauf der Leads („Anfrage gesendet“,
   * Anfrage danach angenommen) plus von Hand gesehene Anfragen, aus denen (noch) kein Lead wurde.
   */
  windowRate(founder: AuthFounderId, since: number): { sent: number; accepted: number } {
    const fromLeads = this.deps.db
      .prepare(
        `SELECT COUNT(DISTINCT e.lead_id) AS sent,
                COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM lead_events a WHERE a.lead_id = e.lead_id AND a.kind = 'invite_accepted') THEN e.lead_id END) AS accepted
           FROM lead_events e JOIN leads l ON l.id = e.lead_id
          WHERE e.kind = 'invite_sent' AND e.at >= ? AND COALESCE(json_extract(l.linkedin, '$.sentBy'), l.owner) = ?`,
      )
      .get(since, founder) as { sent: number; accepted: number };
    const manual = this.deps.db
      .prepare(
        `SELECT COUNT(*) AS sent, COUNT(accepted_at) AS accepted FROM linkedin_sent_invites s
          WHERE s.founder = ? AND ${TRACKED_MANUAL} AND s.sent_at >= ?
            AND (s.lead_id IS NULL OR NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = s.lead_id))`,
      )
      .get(founder, since) as { sent: number; accepted: number };
    return { sent: fromLeads.sent + manual.sent, accepted: fromLeads.accepted + manual.accepted };
  }

  // ── Statistik ──────────────────────────────────────────────────────────

  /** Anfragen und Annahmen je Tag und Gründer-Account der letzten `days` Tage (heute eingeschlossen). */
  stats(days = 14, now = Date.now()): LinkedInInviteStatsResponse {
    const span = Math.min(60, Math.max(1, Math.floor(days)));
    const timeZone = this.deps.config.linkedin.workHours.timeZone;
    const dayOf = (at: number) => localTime(at, timeZone).day;
    const todayStart = localDayStart(now, timeZone);
    const dates: string[] = [];
    for (let offset = span - 1; offset >= 0; offset--) dates.push(dayOf(localDayStart(todayStart - offset * DAY_MS + 12 * 60 * 60 * 1000, timeZone) + 12 * 60 * 60 * 1000));
    const since = localDayStart(todayStart - (span - 1) * DAY_MS + 12 * 60 * 60 * 1000, timeZone);
    const founders: LinkedInInviteStatsFounder[] = AUTH_FOUNDER_IDS.map((founder) => {
      const rows = new Map<string, LinkedInInviteStatsDay>(dates.map((date) => [date, { date, sentCockpit: 0, sentManual: 0, accepted: 0, acceptedOfDay: 0 }]));
      const events = this.deps.db
        .prepare(
          `SELECT e.kind, e.at, e.lead_id,
                  EXISTS (SELECT 1 FROM linkedin_sent_invites s WHERE s.lead_id = e.lead_id AND ${TRACKED_MANUAL}) AS manual,
                  EXISTS (SELECT 1 FROM lead_events a WHERE a.lead_id = e.lead_id AND a.kind = 'invite_accepted') AS accepted
             FROM lead_events e JOIN leads l ON l.id = e.lead_id
            WHERE e.kind IN ('invite_sent', 'invite_accepted') AND e.at >= ? AND COALESCE(json_extract(l.linkedin, '$.sentBy'), l.owner) = ?`,
        )
        .all(since, founder) as { kind: string; at: number; lead_id: string; manual: number; accepted: number }[];
      let sentCockpit = 0;
      let sentManual = 0;
      let acceptedCockpit = 0;
      let acceptedManual = 0;
      for (const event of events) {
        const row = rows.get(dayOf(event.at));
        if (!row) continue;
        if (event.kind === 'invite_accepted') {
          row.accepted++;
          continue;
        }
        if (event.accepted) row.acceptedOfDay = (row.acceptedOfDay ?? 0) + 1;
        if (event.manual) {
          row.sentManual++;
          sentManual++;
          if (event.accepted) acceptedManual++;
        } else {
          row.sentCockpit++;
          sentCockpit++;
          if (event.accepted) acceptedCockpit++;
        }
      }
      // Von Hand gesendet, aber (noch) kein Lead: nur aus der Liste der gesehenen Anfragen.
      for (const sent of this.deps.connections.manualRows(founder, since)) {
        if (sent.leadId && this.deps.leads.get(sent.leadId)) continue;
        const row = rows.get(dayOf(sent.sentAt));
        if (!row) continue;
        row.sentManual++;
        sentManual++;
        if (sent.acceptedAt !== null) {
          acceptedManual++;
          row.acceptedOfDay = (row.acceptedOfDay ?? 0) + 1;
          // Annahme am Tag zählen – ohne Lead gibt es kein Ereignis „angenommen“.
          const acceptedRow = rows.get(dayOf(sent.acceptedAt));
          if (acceptedRow) acceptedRow.accepted++;
        }
      }
      const sent = sentCockpit + sentManual;
      const acceptedOfSent = acceptedCockpit + acceptedManual;
      const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);
      return {
        founder,
        days: dates.map((date) => rows.get(date)!),
        sent,
        sentManual,
        acceptedOfSent,
        rate: rate(acceptedOfSent, sent),
        rateManual: rate(acceptedManual, sentManual),
        rateCockpit: rate(acceptedCockpit, sentCockpit),
        lifetime: this.lifetime(founder),
      };
    });
    return { days: span, founders };
  }

  /** Seit Beginn: alle Anfragen über den Account (Verlauf der Leads + von Hand ohne Lead) und davon angenommen. */
  private lifetime(founder: AuthFounderId): LinkedInInviteTotals {
    const leads = this.deps.db
      .prepare(
        `SELECT COUNT(*) AS sent,
                COALESCE(SUM(manual), 0) AS sentManual,
                COALESCE(SUM(accepted), 0) AS accepted,
                COALESCE(SUM(manual * accepted), 0) AS acceptedManual
           FROM (SELECT EXISTS (SELECT 1 FROM linkedin_sent_invites s WHERE s.lead_id = e.lead_id AND ${TRACKED_MANUAL}) AS manual,
                        EXISTS (SELECT 1 FROM lead_events a WHERE a.lead_id = e.lead_id AND a.kind = 'invite_accepted') AS accepted
                   FROM lead_events e JOIN leads l ON l.id = e.lead_id
                  WHERE e.kind = 'invite_sent' AND COALESCE(json_extract(l.linkedin, '$.sentBy'), l.owner) = ?)`,
      )
      .get(founder) as { sent: number; sentManual: number; accepted: number; acceptedManual: number };
    let sentManual = leads.sentManual;
    let acceptedManual = leads.acceptedManual;
    // `manualRows` zählt nur ab Beobachtungsbeginn (`TRACKED_MANUAL`) – ältere offene Anfragen sind nicht „von Hand“.
    for (const sent of this.deps.connections.manualRows(founder, 0)) {
      if (sent.leadId && this.deps.leads.get(sent.leadId)) continue;
      sentManual++;
      if (sent.acceptedAt !== null) acceptedManual++;
    }
    const sentCockpit = leads.sent - leads.sentManual;
    const acceptedCockpit = leads.accepted - leads.acceptedManual;
    const sent = sentCockpit + sentManual;
    const acceptedOfSent = acceptedCockpit + acceptedManual;
    const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);
    return {
      sent,
      sentManual,
      acceptedOfSent,
      rate: rate(acceptedOfSent, sent),
      rateManual: rate(acceptedManual, sentManual),
      rateCockpit: rate(acceptedCockpit, sentCockpit),
    };
  }
}
