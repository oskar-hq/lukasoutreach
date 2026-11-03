import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import type { DashboardDay, DashboardResponse, FollowUpStat, TemplateStat } from '../../../shared/dashboard.js';
import { LEAD_STAGES, type LeadEventKind, type LeadStage } from '../../../shared/leads.js';
import type { Database } from '../db/database.js';
import { aiCostSummary } from '../ai/usage.js';
import { localTime } from '../linkedin/guard.js';

/**
 * Dashboard aus dem Verlauf der Leads (Vertrag `shared/dashboard.ts`) – für Simulation und Live gleich. Gelöschte
 * Leads zählen weiter über ihre anonymen Ereignisse (`lead_events_archive`, Migration 22), sonst schrumpfte der
 * Verlauf mit jedem Löschen.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ereignisse, die das Dashboard zählt – nur die bleiben beim Löschen eines Leads anonym erhalten. */
export const DASHBOARD_EVENT_KINDS: readonly LeadEventKind[] = ['invite_sent', 'invite_accepted', 'message_sent', 'message_received', 'meeting_booked', 'handed_over', 'stage_changed'];

/** `stage_changed.label` für „in eine eigene Board-Spalte verschoben“. */
export const BOARD_COLUMN_LABEL = 'board_column';

/**
 * Antwort für das Dashboard (Wunsch des Nutzers 20.10.: „alles ab Antwort im Board zählt als geantwortet“): eine
 * eingegangene Nachricht, ein Termin, eine Übergabe – oder ein Lead, den jemand von Hand nach „Antwort“, „Termin“,
 * „Übergeben“ oder in eine eigene Spalte gezogen hat (`stage_changed`, Ziel in `label`).
 */
const REPLY_STAGES = ['replied', 'meeting', 'handed_over'];
const isReply = (event: { kind: string; label: string | null }) =>
  event.kind === 'message_received' ||
  event.kind === 'meeting_booked' ||
  event.kind === 'handed_over' ||
  (event.kind === 'stage_changed' && (REPLY_STAGES.includes(event.label ?? '') || event.label === BOARD_COLUMN_LABEL));

/** Lead, der heute im Board ab „Antwort“ liegt (Stufe oder eigene Spalte) – für Leads ohne passendes Ereignis. */
export interface DashboardReplyLead {
  id: string;
  owner: string;
  template: string | null;
  last_activity_at: number;
}
const KINDS = DASHBOARD_EVENT_KINDS;

export interface DashboardEventRow {
  lead_id: string;
  owner: string;
  template: string | null;
  kind: string;
  at: number;
  label: string | null;
}

/** Alle Tage (YYYY-MM-DD) bis einschließlich heute in der Zeitzone, älteste zuerst. */
export function dayRange(now: number, days: number, timeZone: string): string[] {
  const [y, m, d] = localTime(now, timeZone).day.split('-').map(Number);
  const today = Date.UTC(y, m - 1, d);
  return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

const emptyDay = (date: string): DashboardDay => ({ date, requests: 0, accepted: 0, messaged: 0, replies: 0, meetings: 0, handovers: 0 });

export function computeDashboard(
  rows: DashboardEventRow[],
  pipelineRows: { owner: string; stage: string; n: number; value?: number | null }[],
  options: { now: number; days: number; timeZone: string; maxFollowUps: number },
  replyLeads: DashboardReplyLead[] = [],
): DashboardResponse {
  const { now, days, timeZone, maxFollowUps } = options;
  const dates = dayRange(now, days, timeZone);
  const inRange = new Set(dates);
  const isFounder = (owner: string): owner is AuthFounderId => (AUTH_FOUNDER_IDS as readonly string[]).includes(owner);

  const byDay = {} as Record<AuthFounderId, Map<string, DashboardDay>>;
  const templates = {} as Record<AuthFounderId, Map<string, TemplateStat>>;
  const followUps = {} as Record<AuthFounderId, FollowUpStat[]>;
  const pipeline = {} as Record<AuthFounderId, Record<LeadStage, number>>;
  for (const founder of AUTH_FOUNDER_IDS) {
    byDay[founder] = new Map(dates.map((date) => [date, emptyDay(date)]));
    templates[founder] = new Map();
    followUps[founder] = Array.from({ length: maxFollowUps + 1 }, (_, stage) => ({ stage, reached: 0, replied: 0 }));
    pipeline[founder] = Object.fromEntries(LEAD_STAGES.map((stage) => [stage, 0])) as Record<LeadStage, number>;
  }

  // Ereignisse je Lead gruppieren (Zeilen kommen nach Lead und Zeit sortiert).
  const leads = new Map<string, DashboardEventRow[]>();
  for (const row of rows) {
    if (!isFounder(row.owner)) continue;
    const list = leads.get(row.lead_id) ?? [];
    list.push(row);
    leads.set(row.lead_id, list);
  }

  // Rückwirkend: Leads im Antwort-Bereich ohne passendes Ereignis (z. B. früher in eine eigene Spalte gezogen) gelten
  // zum Zeitpunkt ihrer letzten Aktivität als geantwortet.
  for (const lead of replyLeads) {
    if (!isFounder(lead.owner)) continue;
    const events = leads.get(lead.id) ?? [];
    if (events.some(isReply)) continue;
    events.push({ lead_id: lead.id, owner: lead.owner, template: lead.template, kind: 'stage_changed', at: lead.last_activity_at, label: BOARD_COLUMN_LABEL });
    events.sort((a, b) => a.at - b.at);
    leads.set(lead.id, events);
  }

  for (const events of leads.values()) {
    const founder = events[0].owner as AuthFounderId;
    const day = (at: number) => byDay[founder].get(localTime(at, timeZone).day);
    const sent = events.filter((event) => event.kind === 'message_sent');
    const firstReply = events.find(isReply);

    for (const event of events) {
      const bucket = day(event.at);
      if (!bucket) continue;
      if (event.kind === 'invite_sent') bucket.requests++;
      else if (event.kind === 'invite_accepted') bucket.accepted++;
      else if (event.kind === 'meeting_booked') bucket.meetings++;
      else if (event.kind === 'handed_over') bucket.handovers++;
    }
    if (sent[0]) {
      const bucket = day(sent[0].at);
      if (bucket) bucket.messaged++;
    }
    if (firstReply) {
      const bucket = day(firstReply.at);
      if (bucket) bucket.replies++;
    }

    // Vorlagen und Follow-up-Stufen: nur Leads, deren Erstnachricht im Zeitraum liegt.
    const first = sent[0];
    if (!first || !inRange.has(localTime(first.at, timeZone).day)) continue;
    // Reihenfolge im Verlauf statt Zeitstempel vergleichen (gleiche Zeit ist möglich, z. B. beim Nachtragen).
    const firstIndex = events.indexOf(first);
    const replyIndex = events.findIndex((event, index) => index > firstIndex && isReply(event));
    const template = events[0].template ?? first.label;
    if (template) {
      const stat = templates[founder].get(template) ?? { template, messaged: 0, replied: 0 };
      stat.messaged++;
      if (replyIndex >= 0) stat.replied++;
      templates[founder].set(template, stat);
    }
    // Stufe s gilt als erreicht, wenn die s-te Nachricht vor der Antwort gesendet wurde; die Antwort zählt für die
    // letzte Stufe davor. Nachrichten nach der Antwort sind Gespräch, keine Follow-ups.
    const sentIndexes = events.flatMap((event, index) => (event.kind === 'message_sent' ? [index] : []));
    for (let stage = 0; stage <= maxFollowUps && stage < sentIndexes.length; stage++) {
      if (replyIndex >= 0 && sentIndexes[stage] > replyIndex) break;
      followUps[founder][stage].reached++;
      const next = sentIndexes[stage + 1];
      if (replyIndex >= 0 && (next === undefined || replyIndex < next)) {
        followUps[founder][stage].replied++;
        break;
      }
    }
  }

  // Deal Value je Stufe (Summe der eingetragenen Werte, 11.10.).
  const dealValue = {} as Record<AuthFounderId, Record<LeadStage, number>>;
  for (const founder of AUTH_FOUNDER_IDS) dealValue[founder] = Object.fromEntries(LEAD_STAGES.map((stage) => [stage, 0])) as Record<LeadStage, number>;
  for (const row of pipelineRows) {
    if (isFounder(row.owner) && (LEAD_STAGES as readonly string[]).includes(row.stage)) {
      pipeline[row.owner][row.stage as LeadStage] = row.n;
      dealValue[row.owner][row.stage as LeadStage] = row.value ?? 0;
    }
  }

  const sortTemplates = (map: Map<string, TemplateStat>) => [...map.values()].sort((a, b) => a.template.localeCompare(b.template));
  return {
    from: dates[0],
    to: dates[dates.length - 1],
    timeZone,
    generatedAt: now,
    days: { nick: [...byDay.nick.values()], johannes: [...byDay.johannes.values()] },
    templates: { nick: sortTemplates(templates.nick), johannes: sortTemplates(templates.johannes) },
    followUps,
    pipeline,
    dealValue,
  };
}

export function loadDashboard(
  db: Database,
  options: { now: number; days: number; timeZone: string; maxFollowUps: number; usdToEur?: number; liveOnly?: boolean },
): DashboardResponse {
  const since = options.now - (options.days + 1) * DAY_MS;
  const placeholders = KINDS.map(() => '?').join(', ');
  // Für Vorlagen und Stufen auch ältere Nachrichten desselben Leads laden (die Erstnachricht kann im Zeitraum liegen,
  // die Antwort danach) – deshalb nach Lead filtern, nicht nach Zeit des einzelnen Ereignisses.
  const rows = db
    .prepare(
      `SELECT e.lead_id, l.owner, l.template, e.kind, e.at, e.label
         FROM lead_events e JOIN leads l ON l.id = e.lead_id
        WHERE e.kind IN (${placeholders})
          AND e.lead_id IN (SELECT DISTINCT lead_id FROM lead_events WHERE at >= ?)
        ORDER BY e.lead_id, e.at, e.rowid`,
    )
    .all(...KINDS, since) as unknown as DashboardEventRow[];
  // Gelöschte Leads: anonyme Ereignisse, gruppiert wie ein Lead (eigene Zufallskennung, kollidiert nicht mit Lead-IDs).
  const archived = db
    .prepare(
      `SELECT 'archiv:' || group_id AS lead_id, owner, template, kind, at, label
         FROM lead_events_archive
        WHERE kind IN (${placeholders})
          AND group_id IN (SELECT DISTINCT group_id FROM lead_events_archive WHERE at >= ?)
        ORDER BY group_id, at, id`,
    )
    .all(...KINDS, since) as unknown as DashboardEventRow[];
  const pipelineRows = db.prepare('SELECT owner, stage, COUNT(*) AS n, COALESCE(SUM(deal_value), 0) AS value FROM leads GROUP BY owner, stage').all() as unknown as {
    owner: string;
    stage: string;
    n: number;
    value: number;
  }[];
  // Leads, die im Board ab „Antwort“ liegen: Stufe Antwort/Termin/Übergeben oder eine eigene Spalte (20.10.).
  const replyLeads = db
    .prepare(
      `SELECT id, owner, template, last_activity_at FROM leads
        WHERE (stage IN ('replied', 'meeting', 'handed_over') OR board_column IS NOT NULL) AND last_activity_at >= ?`,
    )
    .all(since) as unknown as DashboardReplyLead[];
  const dashboard = computeDashboard([...rows, ...archived], pipelineRows, options, replyLeads);
  // KI-Kosten (11.10.): für beide Gründer zusammen, gegen den offenen Deal Value.
  dashboard.aiCost = aiCostSummary(db, {
    from: dashboard.from,
    to: dashboard.to,
    usdToEur: options.usdToEur ?? 0.86,
    dayOf: (at) => localTime(at, options.timeZone).day,
    liveOnly: options.liveOnly,
  });
  return dashboard;
}
