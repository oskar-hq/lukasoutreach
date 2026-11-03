import { createHash, randomUUID } from 'node:crypto';
import type { AuthFounderId } from '../../../shared/auth.js';
import { AUTO_SEARCH_ACTOR } from '../../../shared/autoSearch.js';
import type { CompanyEnrichment } from '../../../shared/enrichment.js';
import type { LeadLinkedInState } from '../../../shared/linkedin.js';
import type { LeadConversation } from '../../../shared/messages.js';
import type { LeadCrmState } from '../../../shared/crm.js';
import { CATEGORY_LABELS, HIRING_ROLE_MAX_LENGTH, isQualifyingCategory, metaAdsLabel, type LeadCategory, type LeadHiring, type MetaAdsCheck, type NetworkDistance, type NewLeadCard } from '../../../shared/leadSearch.js';
import { manualMetaAds } from '../ads/metaAds.js';
import { SCORE_TIER_LABELS } from '../../../shared/scoring.js';
import { LEAD_FEEDBACK_REASON_LABELS } from '../../../shared/learning.js';
import {
  LEAD_ACTION_RULES,
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  orderedBoardKeys,
  type BoardColumn,
  type BoardLayout,
  type CockpitLead,
  type ConversationSummary,
  type CreateLeadsResponse,
  type FollowUpPlan,
  type LeadAction,
  type LeadActionRequest,
  type LeadDataExport,
  type LeadEvent,
  type LeadEventKind,
  type LeadStage,
  type ReplyInterest,
  type UpdateLeadRequest,
  REPLY_INTEREST_LABELS,
} from '../../../shared/leads.js';
import { BOARD_COLUMN_LABEL, DASHBOARD_EVENT_KINDS } from '../dashboard/dashboard.js';
import type { Database } from '../db/database.js';
import { enrichedTitle, mockValues, socialCount } from '../enrichment/values.js';
import { scoreLead } from '../scoring/score.js';
import { DEMO_SEED } from './demoSeed.js';
import { LearningStore } from '../learning/learningStore.js';
import { safeWebUrl } from './webUrl.js';
import { companyKeys } from './companyKey.js';

/**
 * Leads und ihr Verlauf in SQLite. Stufen ändern sich nur über Aktionen (`applyAction`) nach `LEAD_ACTION_RULES`
 * – so passen Stufe, Zähler und Verlauf immer zusammen.
 */

/** Profil eines persönlichen Kontakts, einmal über Unipile gelesen (bzw. in der Simulation erfunden). */
export interface ContactProfile {
  firstName: string;
  lastName: string;
  headline: string;
  position: string;
  company: string;
  location: string | null;
  website: string | null;
  providerId: string;
  publicIdentifier: string | null;
  profileUrl: string | null;
  networkDistance: NetworkDistance;
  /** Offene, vom Gründer gesendete Vernetzungsanfrage. */
  pendingInvitation: boolean;
}

/** Eine Nachricht aus einer übernommenen LinkedIn-Unterhaltung. */
export interface ImportedMessage {
  id: string;
  text: string;
  /** true = vom Kontakt, false = vom Gründer. */
  fromLead: boolean;
  at: number;
}

export class LeadNotFoundError extends Error {
  constructor() {
    super('Lead nicht gefunden.');
    this.name = 'LeadNotFoundError';
  }
}

/** Meldung mit dieser `clientId` ist für den Lead schon gebucht (Vertrag: Antwort 200 mit `duplicate: true`). */
export class DuplicateEventError extends Error {
  constructor() {
    super('Diese Meldung ist schon gebucht.');
  }
}

export class InvalidTransitionError extends Error {
  constructor(action: LeadAction, stage: LeadStage) {
    super(`„${ACTION_TITLES[action]}“ passt nicht zur Stufe „${LEAD_STAGE_LABELS[stage]}“.`);
    this.name = 'InvalidTransitionError';
  }
}

const ACTION_TITLES: Record<LeadAction, string> = {
  invite_sent: 'Vernetzungsanfrage gesendet',
  invite_accepted: 'Vernetzungsanfrage angenommen',
  message_sent: 'Nachricht gesendet',
  message_received: 'Antwort erhalten',
  meeting_booked: 'Termin vereinbart',
  handed_over: 'An das CRM übergeben',
  lost: 'Als verloren markiert',
  note: 'Notiz',
  reopened: 'Wieder geöffnet',
};

const FOUNDER_NAMES: Record<AuthFounderId, string> = { nick: 'Nick', johannes: 'Johannes' };

export interface LeadFilter {
  owner?: AuthFounderId;
  stages?: LeadStage[];
  query?: string;
  limit?: number;
  offset?: number;
  /** activity = am längsten ohne Aktivität zuerst (Standard) · score = höchster Score zuerst · recent = zuletzt bearbeitet zuerst. */
  sort?: 'activity' | 'score' | 'recent';
  /** Mit `stages`: zusätzlich alle Leads in einer eigenen Board-Spalte, egal in welcher Stufe. */
  withBoardColumns?: boolean;
  /** Nur Leads mit dieser KI-Kategorie (`assessment.category`). */
  categories?: LeadCategory[];
}

interface LeadRow {
  id: string;
  provider_id: string;
  owner: string;
  stage: string;
  person: string;
  company: string;
  assessment: string | null;
  meta_ads: string | null;
  score: string | null;
  enrichment: string | null;
  linkedin: string | null;
  conversation: string | null;
  crm: string | null;
  origin: string;
  template: string | null;
  follow_ups_sent: number;
  next_step: string | null;
  created_at: number;
  updated_at: number;
  last_contact_at: number | null;
  last_reply_at: number | null;
  last_activity_at: number;
  snoozed_until: number | null;
  board_column?: string | null;
  deal_value?: number | null;
  feedback?: string | null;
  hiring?: string | null;
  reply_interest?: string | null;
  follow_up_plan?: string | null;
  follow_up_due?: number | null;
}

interface EventRow {
  id: string;
  lead_id: string;
  kind: string;
  at: number;
  by: string | null;
  actor: string | null;
  title: string;
  text: string | null;
  label: string | null;
}

function toLead(row: LeadRow): CockpitLead {
  return {
    id: row.id,
    owner: row.owner as AuthFounderId,
    stage: row.stage as LeadStage,
    person: JSON.parse(row.person),
    company: JSON.parse(row.company),
    assessment: row.assessment ? JSON.parse(row.assessment) : null,
    metaAds: row.meta_ads ? JSON.parse(row.meta_ads) : null,
    score: row.score ? JSON.parse(row.score) : null,
    enrichment: row.enrichment ? JSON.parse(row.enrichment) : null,
    linkedin: row.linkedin ? JSON.parse(row.linkedin) : null,
    conversation: row.conversation ? JSON.parse(row.conversation) : null,
    crm: row.crm ? JSON.parse(row.crm) : null,
    origin: JSON.parse(row.origin),
    template: row.template,
    followUpsSent: row.follow_ups_sent,
    nextStep: row.next_step,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastContactAt: row.last_contact_at,
    lastReplyAt: row.last_reply_at,
    lastActivityAt: row.last_activity_at,
    snoozedUntil: row.snoozed_until ?? null,
    ...(row.board_column ? { boardColumn: row.board_column } : {}),
    dealValue: row.deal_value ?? null,
    feedback: row.feedback ? JSON.parse(row.feedback) : null,
    hiring: row.hiring ? JSON.parse(row.hiring) : null,
    replyInterest: (row.reply_interest as ReplyInterest | null | undefined) ?? null,
    followUpPlan: row.follow_up_plan ? JSON.parse(row.follow_up_plan) : null,
    followUpDueAt: row.follow_up_due ?? null,
  };
}

function toEvent(row: EventRow): LeadEvent {
  return {
    id: row.id,
    leadId: row.lead_id,
    kind: row.kind as LeadEventKind,
    at: row.at,
    by: row.by as AuthFounderId | null,
    actor: row.actor ?? null,
    title: row.title,
    text: row.text,
    label: row.label,
  };
}

/** Hiring-Signal einer Karte nur in bekannter Form übernehmen (Stelle und Beleg gekürzt). */
function cleanHiring(hiring: LeadHiring | null | undefined): LeadHiring | null {
  if (!hiring || typeof hiring !== 'object') return null;
  const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, max) : null);
  const source = hiring.source === 'ai' || hiring.source === 'manual' ? hiring.source : 'profile';
  return { role: text(hiring.role, HIRING_ROLE_MAX_LENGTH), source, evidence: text(hiring.evidence, 200) };
}

/** „25.000 €“ */
function formatEuro(value: number): string {
  return `${new Intl.NumberFormat('de-DE').format(value)} €`;
}

/** Fingerabdrücke eines Profils (SHA-256, ohne Namen/Firma) für gelöschte Leads. */
function fingerprints(person: { providerId: string; publicIdentifier?: string | null }): string[] {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const list = [`id:${hash(person.providerId)}`];
  if (person.publicIdentifier) list.push(`pub:${hash(person.publicIdentifier.toLowerCase())}`);
  return list;
}

/** Fingerabdrücke einer Firma (SHA-256 der Vergleichsschlüssel, kein Klartext) – gelöschte Leads sperren ihre Firma. */
function companyFingerprints(company: { name?: string | null; website?: string | null }): string[] {
  return companyKeys(company).map((key) => `co:${createHash('sha256').update(key).digest('hex')}`);
}

/** Text für die Freitextsuche: Name, Firma, Position, Ort – klein geschrieben. */
function searchText(lead: Pick<CockpitLead, 'person' | 'company'>): string {
  const { person, company } = lead;
  return [person.firstName, person.lastName, person.position, person.headline, person.location, company.name, company.industry, company.region]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Score aus allem, was zum Lead bekannt ist (KI-Einschätzung, Profil, Meta-Ads, Clay). null ohne KI-Einschätzung. */
/** Lead aus einem Live-Lauf oder der Tracking-Liste (nicht aus Demo oder Simulation). */
export function isRealLead(lead: Pick<CockpitLead, 'origin'>): boolean {
  return lead.origin.kind === 'tracking' || lead.origin.kind === 'contact' || (lead.origin.kind === 'search' && lead.origin.mode === 'live');
}

export function scoreOf(lead: Pick<CockpitLead, 'assessment' | 'person' | 'company' | 'metaAds' | 'enrichment'>, now = Date.now()) {
  if (!lead.assessment) return null;
  // Angezeigte Werte = gerechnete Werte: auch während einer neuen Anfrage (pending) oder nach einem Fehlschlag
  // zählen die zuletzt gelieferten Daten.
  const done = lead.enrichment ?? null;
  return scoreLead(
    {
      category: lead.assessment.category,
      confidence: lead.assessment.confidence,
      qualified: isQualifyingCategory(lead.assessment.category),
      position: lead.person.position,
      headline: lead.person.headline,
      location: lead.person.location ?? lead.company.region,
      website: lead.company.website,
      employees: done?.employees ?? null,
      hasSocials: done ? socialCount(done.socials) > 0 : null,
      metaPixel: done?.metaPixel ?? null,
      metaAds: lead.metaAds,
    },
    now,
  );
}

/** Wirft InvalidTransitionError, wenn die Aktion nicht zur Stufe passt (vor einer echten LinkedIn-Aktion prüfen). */
export function assertTransition(lead: CockpitLead, action: LeadAction): void {
  const rule = LEAD_ACTION_RULES[action];
  if (rule.from !== 'any' && !rule.from.includes(lead.stage)) throw new InvalidTransitionError(action, lead.stage);
  if (action === 'lost' && lead.stage === 'lost') throw new InvalidTransitionError(action, lead.stage);
}

const formatScore = (value: number) => value.toFixed(2).replace('.', ',');

/** Wiedervorlage höchstens so weit im Voraus (22.10.). */
const FOLLOW_UP_MAX_MS = 366 * 24 * 60 * 60 * 1000;

export class InvalidFollowUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFollowUpError';
  }
}

export class UnknownBoardColumnError extends Error {
  constructor() {
    super('Diese Spalte gibt es nicht (mehr) – bitte neu laden.');
    this.name = 'UnknownBoardColumnError';
  }
}

export class InvalidBoardOrderError extends Error {
  constructor() {
    super('Unbekannte oder doppelte Spalten in der Reihenfolge.');
    this.name = 'InvalidBoardOrderError';
  }
}

export class DuplicateBoardColumnError extends Error {
  constructor() {
    super('Eine Spalte mit diesem Namen gibt es schon.');
    this.name = 'DuplicateBoardColumnError';
  }
}

export class LeadStore {
  /** Wird nach jeder neuen Antwort eines Leads aufgerufen (auch aus dem LinkedIn-Abgleich und beim Demo-Reset). */
  private readonly replyListeners = new Set<(leadId: string, info: { fromReset: boolean }) => void>();

  /** Lernen aus Lead-Qualität (`shared/learning.ts`): 👍/👎, Ergebnisse, Beispiele für die KI. */
  readonly learning: LearningStore;

  /**
   * `ownerPool`: Gründer, auf die neue Leads aus der Lead-Suche verteilt werden (`LEAD_DISTRIBUTION=balanced`, siehe
   * `leadDistributionPool` in config.ts); leer oder ohne Angabe gehören sie dem, der gesucht hat. Wird bei jeder
   * Übergabe neu gelesen – Einstellungen wirken ohne Neustart.
   */
  constructor(
    private readonly db: Database,
    private readonly options: { ownerPool?: () => readonly AuthFounderId[] } = {},
  ) {
    this.learning = new LearningStore(db);
  }

  /**
   * Ergebnisse (interessierte Antwort/Frage, Termin, Übergabe) als „passt“ in die Lernbeispiele übernehmen und am Lead
   * vermerken. Billig (eine Abfrage), darf nie scheitern lassen – Aufrufer fangen nicht.
   */
  syncLearning(now = Date.now()): number {
    try {
      const changed = this.learning.syncOutcomes((row) => toLead(row as LeadRow), now);
      const save = this.db.prepare('UPDATE leads SET feedback = ? WHERE id = ?');
      for (const { id, feedback } of changed) save.run(JSON.stringify(feedback), id);
      return changed.length;
    } catch {
      return 0;
    }
  }

  onReply(listener: (leadId: string, info: { fromReset: boolean }) => void): () => void {
    this.replyListeners.add(listener);
    return () => this.replyListeners.delete(listener);
  }

  private emitReply(leadId: string, fromReset = false): void {
    for (const listener of this.replyListeners) listener(leadId, { fromReset });
  }

  /**
   * Datenschutz: echte Leads in „Verloren“ ohne Aktivität seit `before` endgültig löschen (mit Verlauf). Es bleibt nur
   * ein Fingerabdruck, damit die Lead-Suche sie nie wieder vorschlägt. Demo-Leads bleiben (keine echten Personen).
   * Maßstab ist `last_activity_at` – jede Aktion setzt es mindestens auf ihren Zeitpunkt, also zählt immer das letzte
   * „Verloren“ (nach „Wieder öffnen“ und erneutem „Verloren“ beginnt die Frist neu).
   */
  purgeLost(before: number, now = Date.now()): number {
    // Mit geplanter Wiedervorlage bleibt der Lead (22.10.) – er soll ja noch einmal drankommen.
    const rows = this.db
      .prepare("SELECT * FROM leads WHERE stage = 'lost' AND last_activity_at < ? AND follow_up_plan IS NULL")
      .all(before) as unknown as LeadRow[];
    const doomed = rows.map(toLead).filter(isRealLead);
    if (!doomed.length) return 0;
    this.transaction(() => this.purge(doomed, now));
    return doomed.length;
  }

  /**
   * Datenschutz (Art. 17): diesen Lead sofort endgültig löschen – derselbe Weg wie `purgeLost`, egal in welcher Stufe.
   * Wirft `LeadNotFoundError`.
   */
  deleteLead(id: string, now = Date.now()): CockpitLead {
    const lead = this.get(id);
    if (!lead) throw new LeadNotFoundError();
    this.transaction(() => this.purge([lead], now));
    return lead;
  }

  /**
   * Nach dem Einspielen einer Sicherung (Datenschutz): echte Leads löschen, deren Fingerabdruck in `deleted_leads` steht
   * – sie wurden nach der Sicherung auf Wunsch oder nach Frist gelöscht und dürfen mit ihr nicht zurückkommen. Derselbe
   * Löschweg wie `deleteLead` (Ereignisse anonym ins Archiv, damit das Dashboard weiter dieselben Zahlen zeigt).
   * Läuft in der Transaktion des Aufrufers. Gibt die Zahl der gelöschten Leads zurück.
   */
  purgeForgotten(now = Date.now()): number {
    const rows = this.db.prepare('SELECT * FROM leads').all() as unknown as LeadRow[];
    const doomed = rows.map(toLead).filter((lead) => isRealLead(lead) && this.wasDeleted(lead.person));
    if (doomed.length) this.purge(doomed, now);
    return doomed.length;
  }

  /**
   * Gemeinsamer Löschweg (innerhalb einer Transaktion): zählbare Ereignisse anonym fürs Dashboard aufheben
   * (`lead_events_archive`), Fingerabdruck merken (nur echte Leads – Demo- und Simulations-Leads sind keine Personen
   * und sollen die Simulation nicht verändern), Bezug in den LinkedIn-Aktionen und Firmendaten-Anfragen lösen (die
   * zählen weiter für die Grenzen bzw. Credits), verarbeitete LinkedIn-Nachrichten und „schon geprüft“ der
   * automatischen Suche löschen (der Fingerabdruck verhindert das erneute Vorschlagen, `wasDeleted` im Runner), dann
   * Lead samt Verlauf löschen.
   */
  private purge(leads: CockpitLead[], now: number): void {
    const remember = this.db.prepare('INSERT OR IGNORE INTO deleted_leads (fingerprint, deleted_at) VALUES (?, ?)');
    const remove = this.db.prepare('DELETE FROM leads WHERE id = ?');
    const kinds = DASHBOARD_EVENT_KINDS.map(() => '?').join(', ');
    const events = this.db.prepare(`SELECT kind, at, by, label FROM lead_events WHERE lead_id = ? AND kind IN (${kinds}) ORDER BY at, rowid`);
    const archive = this.db.prepare('INSERT INTO lead_events_archive (group_id, owner, template, kind, at, by, label) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const unlink = this.db.prepare('UPDATE linkedin_actions SET lead_id = NULL WHERE lead_id = ?');
    // lead_id ist dort NOT NULL – leerer Bezug statt NULL; das Tageslimit zählt nur `requested_at`.
    const unlinkEnrichment = this.db.prepare("UPDATE enrichment_requests SET lead_id = '' WHERE lead_id = ?");
    const forgetMessages = this.db.prepare('DELETE FROM linkedin_seen_messages WHERE lead_id = ?');
    const forgetChecked = this.db.prepare('DELETE FROM auto_search_checked WHERE provider_id = ?');
    for (const lead of leads) {
      const group = randomUUID();
      const rows = events.all(lead.id, ...DASHBOARD_EVENT_KINDS) as { kind: string; at: number; by: string | null; label: string | null }[];
      // Kennzeichen nur bei Nachrichten (Vorlage/Variante) – sonst kein Freitext.
      for (const row of rows) archive.run(group, lead.owner, lead.template, row.kind, row.at, row.by, row.kind === 'message_sent' ? row.label : null);
      if (isRealLead(lead)) {
        for (const fingerprint of [...fingerprints(lead.person), ...companyFingerprints(lead.company)]) remember.run(fingerprint, now);
        // Nur mit Fingerabdruck – sonst schlüge die automatische Suche den Treffer wieder vor.
        forgetChecked.run(lead.person.providerId);
      }
      unlink.run(lead.id);
      unlinkEnrichment.run(lead.id);
      forgetMessages.run(lead.id);
      // Rückmeldung zur Lead-Qualität gehört zum Lead (Beispiel für die KI, Bezug zur Suchanfrage) – mit ihm weg.
      this.learning.forget(lead.person.providerId);
      remove.run(lead.id);
    }
  }

  /**
   * Auskunft (Art. 15): alles, was zu diesem Lead gespeichert ist – Lead, Verlauf mit allen Nachrichten und die Zeilen
   * der Neben-Tabellen, die auf ihn verweisen. Null, wenn es ihn nicht gibt.
   */
  exportData(id: string, now = Date.now()): LeadDataExport | null {
    const lead = this.get(id);
    if (!lead) return null;
    const rows = (sql: string, ...params: (string | number)[]) => this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const trackingKeys = [`id:${lead.person.providerId}`, ...(lead.person.publicIdentifier ? [`in:${lead.person.publicIdentifier.toLowerCase()}`] : [])];
    return {
      exportedAt: new Date(now).toISOString(),
      note:
        'Alle Daten, die das Outreach-Cockpit zu dieser Person gespeichert hat: Profil- und Firmendaten, KI-Einschätzung, Score, Verlauf mit allen Nachrichten sowie Protokolle zu LinkedIn-Aktionen, Firmendaten-Anfragen und der Tracking-Liste.',
      lead,
      events: this.events(id),
      related: {
        linkedinActions: rows('SELECT id, founder, kind, status, detail, day, at FROM linkedin_actions WHERE lead_id = ? ORDER BY at', id),
        linkedinMessagesSeen: rows('SELECT message_id, at FROM linkedin_seen_messages WHERE lead_id = ? ORDER BY at', id),
        enrichmentRequests: rows('SELECT source, requested_at FROM enrichment_requests WHERE lead_id = ? ORDER BY requested_at', id),
        autoSearchChecked: rows('SELECT founder, checked_at FROM auto_search_checked WHERE provider_id = ? ORDER BY checked_at', lead.person.providerId),
        trackingList: rows(`SELECT key, setter, sheet, status FROM tracking_profiles WHERE key IN (${trackingKeys.map(() => '?').join(', ')})`, ...trackingKeys),
      },
    };
  }

  /** Wurde dieser Treffer schon einmal als „Verloren“ gelöscht? */
  wasDeleted(hit: { providerId: string; publicIdentifier?: string | null }): boolean {
    const check = this.db.prepare('SELECT 1 FROM deleted_leads WHERE fingerprint = ?');
    return fingerprints(hit).some((fingerprint) => check.get(fingerprint) !== undefined);
  }

  /** Übergabe an das CRM speichern (Vertrag `LeadCrmState`) – sofort nach dem Anlegen in Close, vor der Notiz. */
  setCrm(id: string, crm: LeadCrmState): void {
    this.db.prepare('UPDATE leads SET crm = ? WHERE id = ?').run(JSON.stringify(crm), id);
  }

  /** Einschätzung des Gesprächs speichern (Vertrag `LeadConversation`). */
  setConversation(id: string, conversation: LeadConversation): void {
    this.db.prepare('UPDATE leads SET conversation = ? WHERE id = ?').run(JSON.stringify(conversation), id);
    if (conversation.replyIntent === 'interested' || conversation.replyIntent === 'question') this.syncLearning();
  }

  /** Gibt es echte Leads (aus Live-Läufen oder der Tracking-Liste)? Dann gilt: Demo-Daten nie zurücksetzen oder einspielen. */
  hasRealLeads(): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM leads WHERE json_extract(origin, '$.kind') = 'tracking' OR (json_extract(origin, '$.kind') = 'search' AND json_extract(origin, '$.mode') = 'live') LIMIT 1")
        .get() !== undefined
    );
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM leads').get() as { n: number }).n;
  }

  list(filter: LeadFilter = {}): { leads: CockpitLead[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.owner) {
      where.push('owner = ?');
      params.push(filter.owner);
    }
    if (filter.stages?.length) {
      const stageIn = `stage IN (${filter.stages.map(() => '?').join(', ')})`;
      where.push(filter.withBoardColumns ? `(${stageIn} OR board_column IS NOT NULL)` : stageIn);
      params.push(...filter.stages);
    }
    if (filter.categories?.length) {
      where.push(`json_extract(assessment, '$.category') IN (${filter.categories.map(() => '?').join(', ')})`);
      params.push(...filter.categories);
    }
    const query = filter.query?.trim().toLowerCase();
    if (query) {
      for (const word of query.split(/\s+/)) {
        where.push(`instr(search_text, ?) > 0`);
        params.push(word);
      }
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM leads ${clause}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM leads ${clause} ORDER BY ${
          filter.sort === 'score'
            ? 'score_total IS NULL, score_total DESC, last_activity_at ASC'
            : filter.sort === 'recent'
              ? 'last_activity_at DESC'
              : 'last_activity_at ASC'
        }, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit ?? 500, filter.offset ?? 0) as unknown as LeadRow[];
    return { leads: rows.map(toLead), total };
  }

  get(id: string): CockpitLead | null {
    const row = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as LeadRow | undefined;
    return row ? toLead(row) : null;
  }

  /**
   * Firmen-Dubletten (27.10.): alle Firmen im Cockpit (jede Stufe, auch „Verloren“) nach `companyKeys` – je Schlüssel
   * der erste Lead mit Besitzer, Stufe und Personen-/Firmenname für den Grund in der Lead-Suche.
   */
  companyIndex(): Map<string, { owner: string; stage: string; person: string; company: string }> {
    const rows = this.db.prepare('SELECT owner, stage, person, company FROM leads ORDER BY created_at').all() as { owner: string; stage: string; person: string; company: string }[];
    const index = new Map<string, { owner: string; stage: string; person: string; company: string }>();
    for (const row of rows) {
      const company = JSON.parse(row.company) as CockpitLead['company'];
      const person = JSON.parse(row.person) as CockpitLead['person'];
      for (const key of companyKeys(company)) {
        if (!index.has(key)) index.set(key, { owner: row.owner, stage: row.stage, person: `${person.firstName} ${person.lastName}`.trim(), company: company.name });
      }
    }
    return index;
  }

  /** Wurde schon ein Lead dieser Firma als „Verloren“ gelöscht (Fingerabdruck der Firma, seit 27.10.)? */
  companyWasDeleted(company: { name?: string | null; website?: string | null }): boolean {
    const check = this.db.prepare('SELECT 1 FROM deleted_leads WHERE fingerprint = ?');
    return companyFingerprints(company).some((fingerprint) => check.get(fingerprint) !== undefined);
  }

  findByProviderId(providerId: string): CockpitLead | null {
    const row = this.db.prepare('SELECT * FROM leads WHERE provider_id = ?').get(providerId) as LeadRow | undefined;
    return row ? toLead(row) : null;
  }

  /**
   * Dubletten-Abgleich der Lead-Suche: Lead mit derselben Provider-ID oder derselben öffentlichen LinkedIn-Kennung.
   * Gilt unabhängig davon, was der Browser als „bekannt“ mitschickt.
   */
  findExisting(hit: { providerId: string; publicIdentifier?: string | null }): CockpitLead | null {
    const byId = this.findByProviderId(hit.providerId);
    if (byId || !hit.publicIdentifier) return byId;
    return this.findByPublicIdentifier(hit.publicIdentifier);
  }

  /** Lead mit dieser öffentlichen LinkedIn-Kennung (Teil des Profil-Links), Groß-/Kleinschreibung egal. */
  findByPublicIdentifier(publicIdentifier: string): CockpitLead | null {
    const row = this.db.prepare('SELECT * FROM leads WHERE public_identifier = ? LIMIT 1').get(publicIdentifier.toLowerCase()) as LeadRow | undefined;
    return row ? toLead(row) : null;
  }

  events(leadId: string): LeadEvent[] {
    const rows = this.db.prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY at ASC, rowid ASC').all(leadId) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertLead(lead: CockpitLead): void {
    this.db
      .prepare(
        `INSERT INTO leads (id, provider_id, public_identifier, owner, stage, search_text, person, company, assessment, meta_ads,
           score, score_total, enrichment, origin, template, follow_ups_sent, next_step, created_at, updated_at,
           last_contact_at, last_reply_at, last_activity_at, hiring)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lead.id,
        lead.person.providerId,
        lead.person.publicIdentifier?.toLowerCase() ?? null,
        lead.owner,
        lead.stage,
        searchText(lead),
        JSON.stringify(lead.person),
        JSON.stringify(lead.company),
        lead.assessment ? JSON.stringify(lead.assessment) : null,
        lead.metaAds ? JSON.stringify(lead.metaAds) : null,
        lead.score ? JSON.stringify(lead.score) : null,
        lead.score?.total ?? null,
        lead.enrichment ? JSON.stringify(lead.enrichment) : null,
        JSON.stringify(lead.origin),
        lead.template,
        lead.followUpsSent,
        lead.nextStep,
        lead.createdAt,
        lead.updatedAt,
        lead.lastContactAt,
        lead.lastReplyAt,
        lead.lastActivityAt,
        lead.hiring ? JSON.stringify(lead.hiring) : null,
      );
  }

  private insertEvent(event: Omit<LeadEvent, 'id'>, clientId: string | null = null): LeadEvent {
    const full: LeadEvent = { id: randomUUID(), ...event };
    this.db
      .prepare('INSERT INTO lead_events (id, lead_id, kind, at, by, actor, title, text, label, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(full.id, full.leadId, full.kind, full.at, full.by, full.actor ?? null, full.title, full.text, full.label, clientId);
    return full;
  }

  /** Nur eingetragene Anfragen (Vertrag `UnsentInvitesResponse`): Stufe „Anfrage gesendet“, nicht über das Cockpit gesendet. */
  unsentInvites(owner?: AuthFounderId): CockpitLead[] {
    return this.list({ ...(owner ? { owner } : {}), stages: ['invited'], limit: 100_000 })
      .leads.filter((lead) => !lead.linkedin?.invitationId)
      .sort((a, b) => (a.lastContactAt ?? a.lastActivityAt) - (b.lastContactAt ?? b.lastActivityAt));
  }

  /**
   * Zurück auf „Neu“, damit die Anfrage echt rausgeht (11.10.). Die alten „Anfrage gesendet“-Ereignisse werden zu Notizen
   * – sie zählen dann nicht mehr fürs Tageslimit und das Dashboard. Null = passt nicht (mehr).
   */
  requeueUnsentInvite(id: string, by: AuthFounderId | null, now = Date.now(), actor: string | null = null): CockpitLead | null {
    return this.transaction(() => {
      const lead = this.get(id);
      if (!lead || lead.stage !== 'invited' || lead.linkedin?.invitationId) return null;
      this.db
        .prepare("UPDATE lead_events SET kind = 'note', title = 'Anfrage nur eingetragen – nicht auf LinkedIn gesendet' WHERE lead_id = ? AND kind = 'invite_sent'")
        .run(id);
      this.db
        .prepare("UPDATE leads SET stage = 'new', last_contact_at = NULL, snoozed_until = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now, now, id);
      this.insertEvent({
        leadId: id,
        kind: 'stage_changed',
        at: now,
        by,
        actor,
        title: 'Zurück auf „Neu“ – die Anfrage war nur eingetragen und geht jetzt echt raus',
        text: null,
        label: null,
      });
      return this.get(id);
    });
  }

  /** LinkedIn-Stand am Lead ersetzen (z. B. gefundene Unterhaltung nach dem Chat-Abgleich), ohne Verlaufseintrag. */
  setLinkedInState(id: string, state: LeadLinkedInState): void {
    this.db.prepare('UPDATE leads SET linkedin = ? WHERE id = ?').run(JSON.stringify(state), id);
  }

  /**
   * Fällige Follow-ups einlösen (Wunsch des Nutzers 20.10.): Lead in die geplante Spalte, Plan weg, Verlaufseintrag.
   * Gibt es die Spalte nicht mehr, bleibt nur der Verlaufseintrag. Seit 22.10. (Wiedervorlage) steht der Lead danach
   * wieder in den Aufgaben (`follow_up_due`); ein verlorener oder übergebener Lead wird dafür wieder geöffnet.
   * Gibt die Zahl der eingelösten Pläne zurück.
   */
  releaseDueFollowUps(now = Date.now()): number {
    const rows = this.db
      .prepare("SELECT id, follow_up_plan FROM leads WHERE follow_up_plan IS NOT NULL AND json_extract(follow_up_plan, '$.at') <= ?")
      .all(now) as { id: string; follow_up_plan: string }[];
    if (!rows.length) return 0;
    return this.transaction(() => {
      for (const row of rows) {
        const plan = JSON.parse(row.follow_up_plan) as FollowUpPlan;
        const lead = this.get(row.id);
        if (!lead) continue;
        const exists = plan.column ? !!this.db.prepare('SELECT 1 FROM board_columns WHERE id = ?').get(plan.column) : false;
        const reopen = lead.stage === 'lost' || lead.stage === 'handed_over';
        const stage = reopen ? this.reopenStage(lead) : lead.stage;
        this.db
          .prepare(
            'UPDATE leads SET follow_up_plan = NULL, follow_up_due = ?, stage = ?, board_column = COALESCE(?, board_column), snoozed_until = NULL, updated_at = ?, last_activity_at = ? WHERE id = ?',
          )
          .run(plan.at, stage, exists ? plan.column : null, now, now, row.id);
        if (reopen) {
          this.insertEvent({ leadId: row.id, kind: 'reopened', at: now, by: null, actor: null, title: `Wieder geöffnet · ${LEAD_STAGE_LABELS[stage]} · Wiedervorlage`, text: null, label: null });
        }
        this.insertEvent({
          leadId: row.id,
          kind: exists ? 'stage_changed' : 'note',
          at: now,
          by: null,
          actor: null,
          title: exists
            ? `Follow-up fällig – jetzt in „${plan.columnName}“ und in den Aufgaben`
            : plan.column
              ? `Follow-up fällig (Spalte „${plan.columnName}“ gibt es nicht mehr) – wieder in den Aufgaben`
              : 'Wiedervorlage fällig – wieder in den Aufgaben',
          text: null,
          label: exists ? BOARD_COLUMN_LABEL : null,
        });
      }
      return rows.length;
    });
  }

  /** Wurde diese Meldung (clientId) für den Lead schon gebucht? */
  hasClientEvent(leadId: string, clientId: string): boolean {
    return this.db.prepare('SELECT 1 FROM lead_events WHERE lead_id = ? AND client_id = ?').get(leadId, clientId) !== undefined;
  }

  /** „Für heute überspringen“ (null = aufheben). */
  snooze(id: string, until: number | null, now = Date.now()): CockpitLead {
    const lead = this.get(id);
    if (!lead) throw new LeadNotFoundError();
    this.db.prepare('UPDATE leads SET snoozed_until = ?, updated_at = ? WHERE id = ?').run(until, now, id);
    return this.get(id)!;
  }

  /** Heute (ab `since`) gesendete Vernetzungsanfragen je Gründer – zählen gegen das Tageslimit neuer Leads. */
  invitesSince(since: number): Partial<Record<AuthFounderId, number>> {
    const rows = this.db
      .prepare(
        `SELECT l.owner AS owner, COUNT(*) AS n FROM lead_events e JOIN leads l ON l.id = e.lead_id
         WHERE e.kind = 'invite_sent' AND e.at >= ? GROUP BY l.owner`,
      )
      .all(since) as Array<{ owner: AuthFounderId; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.owner, row.n]));
  }

  /**
   * Vernetzungsanfragen seit `since` je **LinkedIn-Account**, über den sie gingen (`linkedin.sentBy`, sonst der
   * Besitzer) – für Tageslimit und Account-Wechsel (Wunsch des Nutzers 12.10.).
   */
  invitesByAccount(since: number): Partial<Record<AuthFounderId, number>> {
    // Gleiche Zählung wie `LinkedInGuard.usage` (25.10.): dazu Anfragen ohne Lead im Verlauf (Test-Anfrage, gelöschter Lead).
    const rows = this.db
      .prepare(
        `SELECT account, SUM(n) AS n FROM (
           SELECT COALESCE(json_extract(l.linkedin, '$.sentBy'), l.owner) AS account, COUNT(*) AS n
           FROM lead_events e JOIN leads l ON l.id = e.lead_id
           WHERE e.kind = 'invite_sent' AND e.at >= ? GROUP BY account
           UNION ALL
           SELECT a.founder AS account, COUNT(*) AS n FROM linkedin_actions a
           WHERE a.kind = 'invite' AND a.status = 'sent' AND a.at >= ?
             AND (a.lead_id IS NULL OR NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id))
           GROUP BY a.founder
         ) GROUP BY account`,
      )
      .all(since, since) as Array<{ account: AuthFounderId; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.account, row.n]));
  }

  /** Über welchen Account die Anfrage ging (Eintragen von Hand) – Erstnachricht und Follow-ups laufen dann ebenso. */
  setLinkedInAccount(id: string, account: AuthFounderId): void {
    const lead = this.get(id);
    if (!lead) return;
    const state: LeadLinkedInState = { ...(lead.linkedin ?? { invitationId: null, invitedAt: null, chatId: null, chatStartedAt: null }), sentBy: account };
    this.db.prepare('UPDATE leads SET linkedin = ? WHERE id = ?').run(JSON.stringify(state), id);
  }

  /** Letzter „Termin vereinbart“ je Lead in der Stufe Termin (optional nur eines Gründers) – für neue Antworten im Stapel. */
  meetingsBookedAt(owner?: AuthFounderId | null): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT e.lead_id AS lead_id, MAX(e.at) AS at FROM lead_events e JOIN leads l ON l.id = e.lead_id
         WHERE e.kind = 'meeting_booked' AND l.stage = 'meeting'${owner ? ' AND l.owner = ?' : ''} GROUP BY e.lead_id`,
      )
      .all(...(owner ? [owner] : [])) as { lead_id: string; at: number }[];
    return Object.fromEntries(rows.map((row) => [row.lead_id, row.at]));
  }

  /** Offene neue Leads (Stufe `new`) je Gründer – Maßstab für die Verteilung. */
  private newBacklog(): Partial<Record<AuthFounderId, number>> {
    const rows = this.db.prepare("SELECT owner, COUNT(*) AS n FROM leads WHERE stage = 'new' GROUP BY owner").all() as Array<{ owner: AuthFounderId; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.owner, row.n]));
  }

  /**
   * Übergabe aus der Lead-Suche (von Hand und automatisch). Bereits bekannte providerIds werden übersprungen und
   * behalten ihren Besitzer. `searcher` = der Gründer, der gesucht hat.
   *
   * Verteilung (`LEAD_DISTRIBUTION=balanced`, Vertrag shared/leads.ts → `LeadDistribution`): Jeder neue Lead geht an
   * den Gründer aus `ownerPool` mit den wenigsten Leads in der Stufe `new` (zählt die eben zugeteilten mit). Bei
   * Gleichstand zuerst an den Suchenden, sonst in der Reihenfolge des Pools. So gleichen sich die Stapel an und ein
   * Stapel aus N Leads wird bei gleichem Rückstand abwechselnd verteilt (Suchender, anderer, Suchender …).
   */
  createFromCards(cards: NewLeadCard[], searcher: AuthFounderId, now = Date.now(), actor: string | null = null): CreateLeadsResponse {
    return this.transaction(() => {
      const created: CockpitLead[] = [];
      const skipped: CreateLeadsResponse['skipped'] = [];
      const seen = new Set<string>();
      const pool = this.options.ownerPool?.() ?? [];
      const backlog = pool.length >= 2 ? this.newBacklog() : {};
      const nextOwner = (): AuthFounderId => {
        if (pool.length < 2) return searcher;
        const order = pool.includes(searcher) ? [searcher, ...pool.filter((founder) => founder !== searcher)] : [...pool];
        // Erster mit dem kleinsten Rückstand – `order` entscheidet den Gleichstand.
        const pick = order.reduce((best, founder) => ((backlog[founder] ?? 0) < (backlog[best] ?? 0) ? founder : best));
        backlog[pick] = (backlog[pick] ?? 0) + 1;
        return pick;
      };
      for (const card of cards) {
        const existing = this.findByProviderId(card.providerId);
        if (existing) {
          skipped.push({ providerId: card.providerId, leadId: existing.id, owner: existing.owner });
          continue;
        }
        if (seen.has(card.providerId)) continue;
        seen.add(card.providerId);
        const owner = nextOwner();
        const lead: CockpitLead = {
          id: randomUUID(),
          owner,
          stage: 'new',
          person: {
            firstName: card.firstName,
            lastName: card.lastName,
            headline: card.headline,
            position: card.position,
            location: card.location,
            providerId: card.providerId,
            publicIdentifier: card.publicIdentifier,
            // Auch die automatische Suche speichert nur http(s)-Adressen (webUrl.ts).
            profileUrl: safeWebUrl(card.profileUrl),
            networkDistance: card.networkDistance,
          },
          company: { name: card.company, website: safeWebUrl(card.website), industry: CATEGORY_LABELS[card.category], region: card.location },
          assessment: { category: card.category, confidence: card.confidence, reason: card.reason, summary: card.summary },
          metaAds: card.metaAds ? { ...card.metaAds, libraryUrl: safeWebUrl(card.metaAds.libraryUrl) } : null,
          hiring: cleanHiring(card.hiring),
          score: null,
          enrichment: null,
          // Automatische Suche markieren – ihre Leads zählen gegen das Tageslimit neuer Leads (dailyTasks.ts).
          // `searchedBy` nur, wenn die Verteilung den Lead einem anderen Gründer gegeben hat.
          origin: {
            kind: 'search',
            runId: card.runId,
            mode: card.mode,
            ...(actor === AUTO_SEARCH_ACTOR ? { auto: true } : {}),
            ...(owner !== searcher ? { searchedBy: searcher } : {}),
          },
          template: null,
          followUpsSent: 0,
          nextStep: null,
          createdAt: now,
          updatedAt: now,
          lastContactAt: null,
          lastReplyAt: null,
          lastActivityAt: now,
        };
        // Score immer selbst berechnen – nie einem Wert aus dem Browser vertrauen.
        lead.score = scoreOf(lead, now);
        this.insertLead(lead);
        this.insertEvent({
          leadId: lead.id,
          kind: 'created',
          at: now,
          by: searcher,
          actor,
          title:
            (card.mode === 'live' ? 'Über die Lead-Suche gefunden (LinkedIn)' : 'Über die Lead-Suche gefunden') +
            (owner !== searcher ? ` · verteilt an ${FOUNDER_NAMES[owner]}` : ''),
          text: card.headline || null,
          label: null,
        });
        this.insertEvent({
          leadId: lead.id,
          kind: 'assessed',
          at: now,
          by: null,
          title: `KI-Einschätzung: ${CATEGORY_LABELS[card.category]} · ${Math.round(card.confidence * 100)} %`,
          text: card.reason,
          label: null,
        });
        // Schon bewertet (z. B. „Qualifizieren“ in der Ergebnisliste) → die Rückmeldung steht gleich am Lead.
        const feedback = this.learning.feedbackFor(lead.person.providerId);
        if (feedback) {
          lead.feedback = feedback;
          this.db.prepare('UPDATE leads SET feedback = ? WHERE id = ?').run(JSON.stringify(feedback), lead.id);
        }
        created.push(lead);
      }
      return { created, skipped };
    });
  }

  /**
   * Persönlicher Kontakt per LinkedIn-Link (`POST /api/leads/contact`): ohne Suche und KI, Stufe aus dem Kontaktgrad.
   * Gibt es die Person schon (LinkedIn-ID oder Profil-Kennung), bleibt alles, wie es ist (`created: false`).
   */
  createContact(
    contact: ContactProfile,
    owner: AuthFounderId,
    now = Date.now(),
    actor: string | null = null,
  ): { lead: CockpitLead; created: boolean } {
    return this.transaction(() => {
      const existing = this.findExisting(contact);
      if (existing) return { lead: existing, created: false };
      const stage: LeadStage = contact.networkDistance === 1 ? 'connected' : contact.pendingInvitation ? 'invited' : 'new';
      const lead: CockpitLead = {
        id: randomUUID(),
        owner,
        stage,
        person: {
          firstName: contact.firstName,
          lastName: contact.lastName,
          headline: contact.headline,
          position: contact.position,
          location: contact.location,
          providerId: contact.providerId,
          publicIdentifier: contact.publicIdentifier,
          profileUrl: safeWebUrl(contact.profileUrl),
          networkDistance: contact.networkDistance,
        },
        company: { name: contact.company, website: safeWebUrl(contact.website), industry: null, region: contact.location },
        assessment: null,
        metaAds: null,
        hiring: null,
        score: null,
        enrichment: null,
        origin: { kind: 'contact' },
        template: null,
        followUpsSent: 0,
        nextStep: null,
        createdAt: now,
        updatedAt: now,
        lastContactAt: null,
        lastReplyAt: null,
        lastActivityAt: now,
      };
      this.insertLead(lead);
      // Nur „angelegt“ – kein `invite_accepted`, sonst zählte das Dashboard eine Annahme, die es nie gab.
      this.insertEvent({
        leadId: lead.id,
        kind: 'created',
        at: now,
        by: owner,
        actor,
        title: `Persönlicher Kontakt – per LinkedIn-Link aufgenommen · ${LEAD_STAGE_LABELS[stage]}`,
        text: contact.headline || null,
        label: null,
      });
      return { lead, created: true };
    });
  }

  /**
   * Bestehende LinkedIn-Unterhaltung eines eben aufgenommenen Kontakts übernehmen (Wunsch des Nutzers 19.10.): jede
   * Nachricht als Ereignis mit ihrem echten Zeitpunkt, älteste zuerst. Stufe: letzte Nachricht vom Kontakt → „Antwort“
   * (du bist dran), sonst „Angeschrieben“. `state.chatId` sorgt dafür, dass der Abgleich neue Antworten erkennt.
   * Nur für Leads in „Vernetzt“ ohne Nachrichten; sonst passiert nichts.
   */
  importChat(id: string, messages: ImportedMessage[], state: LeadLinkedInState, now = Date.now()): CockpitLead {
    return this.transaction(() => {
      const lead = this.get(id);
      if (!lead) throw new LeadNotFoundError();
      const sorted = messages.filter((message) => message.text.trim()).sort((a, b) => a.at - b.at);
      if (lead.stage !== 'connected' || lead.lastContactAt !== null || !sorted.length) return lead;
      for (const message of sorted) {
        this.insertEvent({
          leadId: id,
          kind: message.fromLead ? 'message_received' : 'message_sent',
          at: message.at,
          by: message.fromLead ? null : lead.owner,
          actor: null,
          title: `${message.fromLead ? `Nachricht von ${lead.person.firstName}` : 'Nachricht gesendet'} · aus LinkedIn übernommen`,
          text: message.text.trim(),
          label: null,
        });
      }
      const lastOf = (fromLead: boolean) => sorted.filter((message) => message.fromLead === fromLead).at(-1)?.at ?? null;
      const stage: LeadStage = sorted.at(-1)!.fromLead ? 'replied' : 'contacted';
      this.db
        .prepare('UPDATE leads SET stage = ?, last_contact_at = ?, last_reply_at = ?, linkedin = ?, updated_at = ? WHERE id = ?')
        .run(stage, lastOf(false), lastOf(true), JSON.stringify(state), now, id);
      return this.get(id)!;
    });
  }

  /**
   * Aktion protokollieren und die Stufe nach `LEAD_ACTION_RULES` weiterschalten.
   * `linkedin`: Aktion lief echt über LinkedIn – Titel bekommt „· über LinkedIn“, `state` ersetzt `lead.linkedin`.
   * `actor`: Anzeigename des angemeldeten Kontos (null bei automatischen Ereignissen: Abgleich, Simulation).
   */
  applyAction(
    id: string,
    request: LeadActionRequest,
    by: AuthFounderId | null,
    now = Date.now(),
    linkedin?: { state?: LeadLinkedInState },
    actor: string | null = null,
    /** Eigener Titel für den Verlauf (z. B. „An Close übergeben“). */
    titleOverride?: string,
  ): CockpitLead {
    const result = this.transaction(() => {
      const lead = this.get(id);
      if (!lead) throw new LeadNotFoundError();
      // Wiederholte Meldung (gleiche clientId): nichts buchen – vor der Stufenprüfung, die Stufe hat sich ja schon geändert.
      if (request.clientId && this.hasClientEvent(id, request.clientId)) throw new DuplicateEventError();
      assertTransition(lead, request.action);

      const at = Math.min(request.at ?? now, now);
      const text = request.text?.trim() || null;
      const label = request.label?.trim() || null;
      const next: CockpitLead = { ...lead, stage: LEAD_ACTION_RULES[request.action].to ?? lead.stage, updatedAt: now, lastActivityAt: Math.max(lead.lastActivityAt, at) };
      let title = ACTION_TITLES[request.action];
      const founder = by ? FOUNDER_NAMES[by] : null;

      switch (request.action) {
        case 'reopened':
          next.stage = this.reopenStage(lead);
          title = `Wieder geöffnet · ${LEAD_STAGE_LABELS[next.stage]}`;
          break;
        case 'invite_sent': {
          // Über den Account des anderen Gründers (Account-Wechsel): das gehört in den Verlauf (25.10.) – sonst stand dort
          // „von Nick“, obwohl die Anfrage über Johannes' LinkedIn ging.
          const via = linkedin?.state?.sentBy ?? lead.linkedin?.sentBy;
          title = founder ? `Vernetzungsanfrage gesendet von ${founder}${via && via !== by ? ` · über den Account von ${FOUNDER_NAMES[via]}` : ''}` : title;
          next.lastContactAt = at;
          break;
        }
        case 'message_sent':
          if (lead.stage === 'connected') {
            next.stage = 'contacted';
            next.template = label;
            title = label ? `Erstnachricht · Vorlage ${label} gesendet` : 'Erstnachricht gesendet';
          } else if (lead.stage === 'contacted') {
            // Hinweis: Auch eine Nachricht aus dem Chat („Meine Nachricht“) zählt hier als Follow-up – bewusst so belassen.
            next.followUpsSent = lead.followUpsSent + 1;
            title = `Follow-up ${next.followUpsSent}${label ? ` · Variante ${label}` : ''} gesendet`;
          }
          next.lastContactAt = at;
          break;
        case 'message_received':
          title = `Antwort von ${lead.person.firstName} erhalten`;
          // Er meldet sich selbst – die geplante Wiedervorlage ist überholt, die Antwort steht sofort in den Aufgaben.
          if (lead.followUpPlan) {
            next.followUpPlan = null;
            this.db.prepare('UPDATE leads SET follow_up_plan = NULL WHERE id = ?').run(id);
          }
          next.lastReplyAt = at;
          // Termin steht schon – eine weitere Nachricht wirft den Lead nicht nach „Antwort“ zurück.
          if (lead.stage === 'meeting') next.stage = 'meeting';
          // Neue Antwort gehört sofort in den Stapel – auch wenn der Lead heute übersprungen wurde.
          next.snoozedUntil = null;
          // Neue Antwort, neue Einordnung: die von Hand gesetzte gilt nicht mehr.
          next.replyInterest = null;
          this.db.prepare('UPDATE leads SET reply_interest = NULL WHERE id = ?').run(id);
          break;
      }

      this.db
        .prepare(
          `UPDATE leads SET stage = ?, template = ?, follow_ups_sent = ?, updated_at = ?, last_contact_at = ?,
             last_reply_at = ?, last_activity_at = ?, snoozed_until = ? WHERE id = ?`,
        )
        .run(next.stage, next.template, next.followUpsSent, next.updatedAt, next.lastContactAt, next.lastReplyAt, next.lastActivityAt, next.snoozedUntil ?? null, id);
      // Wiedervorlage erledigt, sobald etwas passiert (Notiz und Wieder öffnen zählen nicht).
      if (lead.followUpDueAt && request.action !== 'note' && request.action !== 'reopened') {
        next.followUpDueAt = null;
        this.db.prepare('UPDATE leads SET follow_up_due = NULL WHERE id = ?').run(id);
      }
      if (titleOverride) title = titleOverride;
      if (linkedin) {
        title = `${title} · über LinkedIn`;
        if (linkedin.state) {
          next.linkedin = linkedin.state;
          this.db.prepare('UPDATE leads SET linkedin = ? WHERE id = ?').run(JSON.stringify(linkedin.state), id);
        }
      }
      this.insertEvent({ leadId: id, kind: request.action, at, by, actor, title, text, label }, request.clientId ?? null);
      return next;
    });
    // Nach dem Speichern (außerhalb der Transaktion): Einschätzung des Gesprächs neu rechnen.
    if (request.action === 'message_received') this.emitReply(id);
    // Termin oder Übergabe = Lead war gut → Lernbeispiel (`shared/learning.ts`).
    if (result.stage === 'meeting' || result.stage === 'handed_over') this.syncLearning();
    return result;
  }

  /**
   * „Wieder öffnen“ (Vertrag `LEAD_ACTION_RULES.reopened`): zurück in die Stufe, die der Verlauf hergibt – Termin
   * vereinbart → `meeting`, geantwortet → `replied`, Nachricht gesendet → `contacted`, angenommen → `connected`,
   * Anfrage gesendet → `invited`, sonst `new`.
   */
  private reopenStage(lead: CockpitLead): LeadStage {
    const kinds = new Set(
      (
        this.db
          .prepare("SELECT DISTINCT kind FROM lead_events WHERE lead_id = ? AND kind IN ('meeting_booked', 'message_sent', 'invite_sent', 'invite_accepted')")
          .all(lead.id) as { kind: string }[]
      ).map((row) => row.kind),
    );
    if (kinds.has('meeting_booked')) return 'meeting';
    if (lead.lastReplyAt !== null) return 'replied';
    if (kinds.has('message_sent') || lead.template !== null || lead.followUpsSent > 0) return 'contacted';
    if (kinds.has('invite_accepted')) return 'connected';
    if (kinds.has('invite_sent') || lead.lastContactAt !== null) return 'invited';
    return 'new';
  }

  update(id: string, patch: UpdateLeadRequest, by: AuthFounderId | null, now = Date.now(), actor: string | null = null): CockpitLead {
    return this.transaction(() => {
      const lead = this.get(id);
      if (!lead) throw new LeadNotFoundError();
      const next: CockpitLead = { ...lead, updatedAt: now };
      if (patch.nextStep !== undefined) next.nextStep = patch.nextStep?.trim() || null;
      const note = (title: string) =>
        this.insertEvent({ leadId: id, kind: 'note', at: now, by, actor, title, text: null, label: null });
      if (patch.dealValue !== undefined && (patch.dealValue ?? null) !== (lead.dealValue ?? null)) {
        next.dealValue = patch.dealValue;
        this.db.prepare('UPDATE leads SET deal_value = ? WHERE id = ?').run(patch.dealValue, id);
        note(patch.dealValue === null ? 'Deal Value entfernt' : `Deal Value: ${formatEuro(patch.dealValue)}`);
      }
      if (patch.feedback !== undefined) {
        // 👍/👎 zur Lead-Qualität: Beispiel für die KI und Ertrag der Suchanfrage (`shared/learning.ts`).
        next.feedback = this.learning.setManual(lead, patch.feedback, now);
        this.db.prepare('UPDATE leads SET feedback = ? WHERE id = ?').run(next.feedback ? JSON.stringify(next.feedback) : null, id);
        if (patch.feedback) {
          const reason = patch.feedback.reason ? ` · ${LEAD_FEEDBACK_REASON_LABELS[patch.feedback.reason]}` : '';
          note(patch.feedback.verdict === 'good' ? 'Lead-Qualität: passt' : `Lead-Qualität: passt nicht${reason}`);
        } else {
          note('Rückmeldung zur Lead-Qualität zurückgenommen');
        }
      }
      if (patch.metaAds) {
        // Von Hand eingetragen: ersetzt die Prüfung der Lead-Suche, Score (Lead-Typ → Vorlage) neu rechnen.
        next.metaAds = manualMetaAds(patch.metaAds, lead.company.name, lead.metaAds);
        next.score = scoreOf(next, now) ?? lead.score ?? null;
        this.db
          .prepare('UPDATE leads SET meta_ads = ?, score = ?, score_total = ? WHERE id = ?')
          .run(JSON.stringify(next.metaAds), next.score ? JSON.stringify(next.score) : null, next.score?.total ?? null, id);
        note(`Meta-Ads von Hand: ${metaAdsLabel(next.metaAds)}`);
      }
      if (patch.hiring !== undefined) {
        // Hiring-Signal von Hand: ersetzt das der Lead-Suche – die Erstnachricht schlägt dann die Recruiting-Vorlage vor.
        const role = patch.hiring?.role?.replace(/\s+/g, ' ').trim().slice(0, HIRING_ROLE_MAX_LENGTH) || null;
        next.hiring = patch.hiring ? { role, source: 'manual', evidence: null } : null;
        this.db.prepare('UPDATE leads SET hiring = ? WHERE id = ?').run(next.hiring ? JSON.stringify(next.hiring) : null, id);
        note(next.hiring ? `Sucht Mitarbeiter (von Hand)${role ? `: ${role}` : ''}` : 'Sucht keine Mitarbeiter (von Hand)');
      }
      if (patch.boardColumn !== undefined) {
        if (patch.boardColumn !== null && !this.db.prepare('SELECT 1 FROM board_columns WHERE id = ?').get(patch.boardColumn)) {
          throw new UnknownBoardColumnError();
        }
        this.db.prepare('UPDATE leads SET board_column = ? WHERE id = ?').run(patch.boardColumn, id);
        if (patch.boardColumn && patch.boardColumn !== lead.boardColumn) {
          // Eigene Spalten liegen im Board hinter „Antwort“ – das Dashboard zählt den Lead als geantwortet (20.10.).
          const column = this.db.prepare('SELECT name FROM board_columns WHERE id = ?').get(patch.boardColumn) as { name: string };
          this.insertEvent({ leadId: id, kind: 'stage_changed', at: now, by, actor, title: `In Spalte „${column.name}“ verschoben`, text: null, label: BOARD_COLUMN_LABEL });
        }
        if (patch.boardColumn) next.boardColumn = patch.boardColumn;
        else delete next.boardColumn;
      }
      if (patch.stage && patch.stage !== lead.stage) {
        // Von Hand verschoben (Board, Wunsch des Nutzers 19.10.): nur die Stufe – Zähler entstehen nur über Aktionen.
        next.stage = patch.stage;
        next.lastActivityAt = now;
        this.db.prepare('UPDATE leads SET stage = ? WHERE id = ?').run(patch.stage, id);
        // „Vernetzt“ war falsch (20.10., Wunsch des Nutzers: zurücksetzen): die Annahme aus dem Verlauf nehmen, sonst
        // zählt das Dashboard sie weiter. Nimmt die Person später wirklich an, trägt der Abgleich sie neu ein.
        if (lead.stage === 'connected' && (patch.stage === 'invited' || patch.stage === 'new')) {
          this.db.prepare("DELETE FROM lead_events WHERE lead_id = ? AND kind = 'invite_accepted'").run(id);
        }
        this.insertEvent({
          leadId: id,
          kind: 'stage_changed',
          at: now,
          by,
          actor,
          title: `Von Hand verschoben: ${LEAD_STAGE_LABELS[lead.stage]} → ${LEAD_STAGE_LABELS[patch.stage]}`,
          text: null,
          // Zielstufe – das Dashboard zählt eine Verschiebung nach „Antwort“ und weiter als Antwort.
          label: patch.stage,
        });
      }
      if (patch.replyInterest !== undefined && (patch.replyInterest ?? null) !== (lead.replyInterest ?? null)) {
        next.replyInterest = patch.replyInterest;
        this.db.prepare('UPDATE leads SET reply_interest = ? WHERE id = ?').run(patch.replyInterest, id);
        note(patch.replyInterest ? `Antwort eingeordnet: ${REPLY_INTEREST_LABELS[patch.replyInterest]}` : 'Antwort wieder nach der Einschätzung eingeordnet');
      }
      if (patch.followUpPlan !== undefined) {
        if (patch.followUpPlan === null) {
          if (lead.followUpPlan) note('Geplantes Follow-up entfernt');
          next.followUpPlan = null;
          // Stand er in der Spalte des Plans, zurück in seine Stufe.
          if (lead.followUpPlan?.column && lead.boardColumn === lead.followUpPlan.column) {
            delete next.boardColumn;
            this.db.prepare('UPDATE leads SET board_column = NULL WHERE id = ?').run(id);
          }
        } else {
          // Spalte fehlt → automatisch die „Follow“-Spalte (22.10.), aber nur im Antwort-Bereich (Antwort, Termin, schon in
          // einer eigenen Spalte) – eigene Spalten zählen im Dashboard als geantwortet. null → bewusst keine.
          const replied = lead.stage === 'replied' || lead.stage === 'meeting' || !!lead.boardColumn;
          const auto = replied ? (this.boardColumns().find((entry) => /follow/i.test(entry.name))?.id ?? null) : null;
          const wanted = patch.followUpPlan.column === undefined ? auto : patch.followUpPlan.column;
          const column = wanted ? (this.db.prepare('SELECT id, name FROM board_columns WHERE id = ?').get(wanted) as { id: string; name: string } | undefined) : null;
          if (wanted && !column) throw new InvalidFollowUpError('Diese Spalte gibt es nicht (mehr) – bitte eine andere wählen.');
          if (patch.followUpPlan.at <= now) throw new InvalidFollowUpError('Der Zeitpunkt für das Follow-up muss in der Zukunft liegen.');
          if (patch.followUpPlan.at > now + FOLLOW_UP_MAX_MS) throw new InvalidFollowUpError('Höchstens ein Jahr im Voraus.');
          next.followUpPlan = { at: patch.followUpPlan.at, column: column?.id ?? null, columnName: column?.name ?? null };
          // Ab sofort in der Spalte (22.10.: „wer ein Follow-up bekommt, steht im Board unter Follow-up“).
          if (column && lead.boardColumn !== column.id) {
            next.boardColumn = column.id;
            this.db.prepare('UPDATE leads SET board_column = ? WHERE id = ?').run(column.id, id);
          }
          const day = new Date(patch.followUpPlan.at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
          note(column ? `Follow-up geplant: jetzt in „${column.name}“, ab ${day} wieder in den Aufgaben` : `Wiedervorlage geplant: ab ${day} wieder in den Aufgaben`);
        }
        this.db.prepare('UPDATE leads SET follow_up_plan = ? WHERE id = ?').run(next.followUpPlan ? JSON.stringify(next.followUpPlan) : null, id);
        // Neuer Plan oder Plan weg: eine offene Wiedervorlage ist damit erledigt.
        if (lead.followUpDueAt) {
          next.followUpDueAt = null;
          this.db.prepare('UPDATE leads SET follow_up_due = NULL WHERE id = ?').run(id);
        }
      }
      if (patch.owner && patch.owner !== lead.owner) {
        next.owner = patch.owner;
        next.lastActivityAt = now;
        this.insertEvent({
          leadId: id,
          kind: 'owner_changed',
          at: now,
          by,
          actor,
          title: `Zuständig: ${FOUNDER_NAMES[patch.owner]} (vorher ${FOUNDER_NAMES[lead.owner]})`,
          text: null,
          label: null,
        });
      }
      this.db
        .prepare('UPDATE leads SET owner = ?, next_step = ?, updated_at = ?, last_activity_at = ? WHERE id = ?')
        .run(next.owner, next.nextStep, next.updatedAt, next.lastActivityAt, id);
      return next;
    });
  }

  // ── Chats ──────────────────────────────────────────────────────────────

  /** Leads mit mindestens einer Nachricht, neueste Nachricht zuerst (Vertrag `ConversationSummary`). */
  conversations(owner?: AuthFounderId): ConversationSummary[] {
    // Gründer-Filter und Lead-Daten gleich in SQL (kein Nachladen je Lead).
    const rows = this.db
      .prepare(
        `SELECT l.*, e.kind AS msg_kind, e.text AS msg_text, e.at AS msg_at, c.n AS msg_n, c.replies AS msg_replies
         FROM lead_events e
         JOIN (SELECT lead_id, MAX(at) AS last_at, COUNT(*) AS n, SUM(kind = 'message_received') AS replies FROM lead_events
               WHERE kind IN ('message_sent', 'message_received') GROUP BY lead_id) c
           ON c.lead_id = e.lead_id AND c.last_at = e.at
         JOIN leads l ON l.id = e.lead_id
         WHERE e.kind IN ('message_sent', 'message_received')${owner ? ' AND l.owner = ?' : ''}
         ORDER BY e.at DESC`,
      )
      .all(...(owner ? [owner] : [])) as unknown as (LeadRow & { msg_kind: string; msg_text: string | null; msg_at: number; msg_n: number; msg_replies: number })[];
    const seen = new Set<string>();
    const result: ConversationSummary[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const from = row.msg_kind === 'message_received' ? 'lead' : 'founder';
      const lead = toLead(row);
      result.push({
        lead,
        lastMessage: { text: row.msg_text ?? '', from, at: row.msg_at },
        messageCount: row.msg_n,
        awaitingReply: from === 'lead',
        account: lead.linkedin?.sentBy ?? lead.owner,
        replies: row.msg_replies ?? 0,
      });
    }
    return result;
  }

  // ── Eigene Board-Spalten ─────────────────────────────────────────────────

  boardColumns(): BoardColumn[] {
    return this.db.prepare('SELECT id, name, position FROM board_columns ORDER BY position, created_at').all() as unknown as BoardColumn[];
  }

  addBoardColumn(name: string, now = Date.now()): BoardColumn {
    const clean = name.trim();
    if (this.boardColumns().some((column) => column.name.toLowerCase() === clean.toLowerCase())) throw new DuplicateBoardColumnError();
    const position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM board_columns').get() as { next: number }).next;
    const column: BoardColumn = { id: randomUUID(), name: clean, position };
    this.db.prepare('INSERT INTO board_columns (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(column.id, column.name, column.position, now);
    return column;
  }

  renameBoardColumn(id: string, name: string): BoardColumn | null {
    const clean = name.trim();
    if (this.boardColumns().some((column) => column.id !== id && column.name.toLowerCase() === clean.toLowerCase())) throw new DuplicateBoardColumnError();
    const result = this.db.prepare('UPDATE board_columns SET name = ? WHERE id = ?').run(clean, id);
    return Number(result.changes) ? (this.boardColumns().find((column) => column.id === id) ?? null) : null;
  }

  /** Reihenfolge aller Spalten und eigene Namen der Stufen-Spalten (22.10.). */
  boardLayout(): BoardLayout {
    const read = (key: string) => (this.db.prepare('SELECT value FROM board_layout WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const stageNames = JSON.parse(read('stage_names') ?? '{}') as BoardLayout['stageNames'];
    return { order: orderedBoardKeys(LEAD_STAGES, this.boardColumns(), JSON.parse(read('order') ?? '[]') as string[]), stageNames };
  }

  /** Neue Reihenfolge. Unbekannte oder doppelte Schlüssel → Fehler; fehlende hängt `orderedBoardKeys` an. */
  setBoardOrder(order: string[]): BoardLayout {
    const known = new Set(orderedBoardKeys(LEAD_STAGES, this.boardColumns()));
    if (new Set(order).size !== order.length || order.some((key) => !known.has(key))) throw new InvalidBoardOrderError();
    this.db.prepare('INSERT INTO board_layout (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('order', JSON.stringify(order));
    return this.boardLayout();
  }

  /** Eigener Name für eine Stufen-Spalte (null/leer = Standardname). */
  renameBoardStage(stage: LeadStage, name: string | null): BoardLayout {
    const names = { ...this.boardLayout().stageNames };
    const clean = name?.trim();
    if (clean) names[stage] = clean;
    else delete names[stage];
    this.db
      .prepare('INSERT INTO board_layout (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('stage_names', JSON.stringify(names));
    return this.boardLayout();
  }

  /** Spalte löschen – ihre Leads kehren in die Spalte ihrer Stufe zurück. false = gab es nicht. */
  deleteBoardColumn(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare('UPDATE leads SET board_column = NULL WHERE board_column = ?').run(id);
      return Number(this.db.prepare('DELETE FROM board_columns WHERE id = ?').run(id).changes) > 0;
    });
  }

  /**
   * Ergebnis bzw. Zwischenstand der Clay-Anreicherung speichern. Bei `done` wird der Score neu berechnet und ein
   * Ereignis `enriched` geschrieben (mit altem → neuem Score).
   */
  setEnrichment(id: string, enrichment: CompanyEnrichment, now = Date.now()): CockpitLead {
    return this.transaction(() => {
      const lead = this.get(id);
      if (!lead) throw new LeadNotFoundError();
      const next: CockpitLead = { ...lead, enrichment, updatedAt: now };
      next.score = scoreOf(next, now) ?? lead.score ?? null;
      if (enrichment.status === 'done') {
        const before = lead.score ? formatScore(lead.score.total) : null;
        const after = next.score ? `${formatScore(next.score.total)} (${SCORE_TIER_LABELS[next.score.tier]})` : null;
        this.insertEvent({
          leadId: id,
          kind: 'enriched',
          at: now,
          by: null,
          title: enrichedTitle(enrichment),
          text: after ? (before ? `Score ${before} → ${after}` : `Score ${after}`) : null,
          label: null,
        });
      }
      this.db
        .prepare('UPDATE leads SET enrichment = ?, score = ?, score_total = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(enrichment), next.score ? JSON.stringify(next.score) : null, next.score?.total ?? null, now, id);
      return next;
    });
  }

  /** IDs der Leads für die Meta-Nachprüfung (`shared/metaRecheck.ts`): ohne verlorene, älteste zuerst. */
  metaRecheckIds(): string[] {
    return (this.db.prepare("SELECT id FROM leads WHERE stage <> 'lost' ORDER BY created_at, id").all() as { id: string }[]).map((row) => row.id);
  }

  /**
   * Ergebnis der Meta-Nachprüfung speichern: Score (Lead-Typ → Vorlage) neu rechnen, ein Eintrag im Verlauf nur, wenn
   * sich der Stand ändert. Ein von Hand eingetragener Stand gewinnt immer – dann bleibt alles, wie es ist (null).
   */
  setCheckedMetaAds(id: string, check: MetaAdsCheck, now = Date.now()): CockpitLead | null {
    return this.transaction(() => {
      const lead = this.get(id);
      if (!lead) throw new LeadNotFoundError();
      if (lead.metaAds?.manual) return null;
      const next: CockpitLead = { ...lead, metaAds: check, updatedAt: now };
      next.score = scoreOf(next, now) ?? lead.score ?? null;
      this.db
        .prepare('UPDATE leads SET meta_ads = ?, score = ?, score_total = ? WHERE id = ?')
        .run(JSON.stringify(check), next.score ? JSON.stringify(next.score) : null, next.score?.total ?? null, id);
      if (lead.metaAds?.state !== check.state) {
        const via = check.source === 'person' ? ' (über den privaten Namen)' : '';
        this.insertEvent({ leadId: id, kind: 'note', at: now, by: null, title: `Meta-Ads nachgeprüft: ${metaAdsLabel(check)}${via}`, text: null, label: null });
      }
      return next;
    });
  }

  /** Leads aus der Zeit vor Scoring v1 nachträglich bewerten (beim Start). Gibt die Anzahl zurück. */
  backfillScores(now = Date.now()): number {
    const rows = this.db.prepare('SELECT * FROM leads WHERE score IS NULL AND assessment IS NOT NULL').all() as unknown as LeadRow[];
    const update = this.db.prepare('UPDATE leads SET score = ?, score_total = ? WHERE id = ?');
    for (const lead of rows.map(toLead)) {
      const score = scoreOf(lead, now)!;
      update.run(JSON.stringify(score), score.total, lead.id);
    }
    return rows.length;
  }

  /** Simulation: alle Leads löschen und die Demo-Leads neu anlegen (Zeitstempel relativ zu jetzt). */
  resetDemo(now = Date.now()): number {
    const replied: string[] = [];
    const count = this.transaction(() => {
      // Simulation: auch die anonymen Zahlen gelöschter Demo-Leads, sonst zählte das Dashboard sie doppelt.
      this.db.exec('DELETE FROM leads; DELETE FROM lead_events_archive;');
      this.learning.reset();
      for (const seed of DEMO_SEED) {
        const times = seed.events.map((event) => now + event.offsetMs);
        const contacts = seed.events.filter((e) => e.kind === 'invite_sent' || e.kind === 'message_sent').map((e) => now + e.offsetMs);
        const replies = seed.events.filter((e) => e.kind === 'message_received').map((e) => now + e.offsetMs);
        // Hiring-Signal der Demo steht im ersten Ereignis („Signal: Sucht: Vertriebsmitarbeiter (m/w/d) – …“).
        const hiringRole = seed.events.find((e) => e.kind === 'created')?.text?.match(/^Signal: Sucht: (.+?)(?: – |$)/)?.[1] ?? null;
        const lead: CockpitLead = {
          id: randomUUID(),
          owner: seed.owner,
          stage: seed.stage,
          person: seed.person,
          company: seed.company,
          assessment: seed.assessment,
          metaAds: seed.metaAds ?? null,
          hiring: hiringRole ? { role: hiringRole, source: 'profile', evidence: 'Offene Stelle auf LinkedIn und Jobportalen' } : null,
          score: null,
          enrichment: null,
          origin: { kind: 'demo' },
          template: seed.template,
          followUpsSent: seed.followUpsSent,
          nextStep: seed.nextStep,
          createdAt: Math.min(...times, now),
          updatedAt: now,
          lastContactAt: contacts.length ? Math.max(...contacts) : null,
          lastReplyAt: replies.length ? Math.max(...replies) : null,
          lastActivityAt: times.length ? Math.max(...times) : now,
        };
        // Simulation: Wer schon angefragt wurde, ist bereits angereichert; Leads in „Neu“ zum Ausprobieren nicht.
        if (seed.stage !== 'new') {
          lead.enrichment = { source: 'mock', status: 'done', requestedAt: lead.createdAt, receivedAt: lead.createdAt, error: null, ...mockValues(lead.company) };
        }
        lead.score = scoreOf(lead, now);
        this.insertLead(lead);
        for (const event of seed.events) {
          this.insertEvent({ leadId: lead.id, kind: event.kind, at: now + event.offsetMs, by: event.by, title: event.title, text: event.text, label: event.label });
        }
        if (replies.length) replied.push(lead.id);
      }
      return DEMO_SEED.length;
    });
    for (const id of replied) this.emitReply(id, true);
    return count;
  }
}
