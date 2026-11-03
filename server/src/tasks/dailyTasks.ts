import { createHash } from 'node:crypto';
import { defaultFounderName, type AuthFounderId } from '../../../shared/auth.js';
import type { CockpitLead } from '../../../shared/leads.js';
import { LEAD_TYPE_LABELS, SCORE_TIER_LABELS } from '../../../shared/scoring.js';
import { TASK_TYPES, type AttentionItem, type DailyTask, type TaskType, type TasksResponse } from '../../../shared/tasks.js';

/**
 * Tagesstapel aus den Leads der Datenbank (Vertrag `shared/tasks.ts`) – eine reine Funktion, für Simulation und Live
 * gleich. Erledigt wird eine Aufgabe über die Aktion am Lead; danach fällt sie beim nächsten Abruf heraus.
 */

export interface TaskRules {
  followUpAfterDays: number;
  maxFollowUps: number;
  newLeadsPerDay: number;
  inviteStaleDays: number;
  /** Notiz zur Vernetzungsanfrage anbieten (`INVITE_NOTE`). */
  inviteNote: boolean;
  /** Übergabe an Close an (`CRM_HANDOVER`) – sonst keine Erinnerung „Termin noch nicht übergeben“. Fehlt = an. */
  handover?: boolean;
}

/** Anteil der neuen Leads, der bewusst aus der mittleren Score-Stufe kommt. */
export const EXPLORATION_SHARE = 0.15;

const DAY = 24 * 60 * 60 * 1000;

function daysSince(time: number, now: number): number {
  return Math.max(0, Math.floor((now - time) / DAY));
}

function dayText(days: number): string {
  if (days === 0) return 'heute';
  return days === 1 ? 'seit 1 Tag' : `seit ${days} Tagen`;
}

/**
 * Stabile Reihenfolge je Tag (gleiche Auswahl beim erneuten Laden, morgen eine andere). `todayStart` ist der Beginn
 * des Kalendertags in Ortszeit (Europe/Berlin) – der Wechsel kommt um Mitternacht Ortszeit, nicht um 0 Uhr UTC.
 */
function dailyRank(leadId: string, todayStart: number): string {
  return createHash('sha256').update(`${todayStart}:${leadId}`).digest('hex');
}

const scoreOf = (lead: CockpitLead) => lead.score?.total ?? 0;

/** Neue Leads je Gründer: die besten nach Score, plus ~15 % aus der mittleren Stufe (Exploration). */
function pickNewLeads(leads: CockpitLead[], limit: number, todayStart: number): { lead: CockpitLead; exploration: boolean }[] {
  const sorted = [...leads].sort((a, b) => scoreOf(b) - scoreOf(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (sorted.length <= limit) return sorted.map((lead) => ({ lead, exploration: false }));

  const exploreSlots = Math.max(limit >= 5 ? 1 : 0, Math.round(limit * EXPLORATION_SHARE));
  const main = sorted.slice(0, limit - exploreSlots);
  const rest = sorted.slice(limit - exploreSlots);
  const medium = rest
    .filter((lead) => lead.score?.tier === 'medium')
    .sort((a, b) => dailyRank(a.id, todayStart).localeCompare(dailyRank(b.id, todayStart)));
  const explored = medium.slice(0, exploreSlots);
  // Zu wenige mittlere: mit den nächstbesten auffüllen.
  const filler = rest.filter((lead) => !explored.includes(lead)).slice(0, exploreSlots - explored.length);
  return [
    ...main.map((lead) => ({ lead, exploration: false })),
    ...explored.map((lead) => ({ lead, exploration: true })),
    ...filler.map((lead) => ({ lead, exploration: false })),
  ];
}

function newLeadReason(lead: CockpitLead): string {
  if (lead.origin.kind === 'contact') return 'Persönlicher Kontakt – per Link aufgenommen';
  if (!lead.score) return 'Neuer Lead – noch nicht bewertet';
  return `Score ${SCORE_TIER_LABELS[lead.score.tier]} · ${LEAD_TYPE_LABELS[lead.score.leadType]}`;
}

/** Antwort-Aufgabe – je Antwort eine eigene ID, eine zweite Antwort am selben Tag ist wieder offen, nicht „erledigt“. */
function replyTask(lead: CockpitLead, since: number, now: number): DailyTask {
  const days = daysSince(since, now);
  return {
    id: `${lead.id}:reply:${since}`,
    type: 'reply',
    lead,
    dueSince: since,
    reason: days === 0 ? 'Hat heute geantwortet' : `Antwort ${dayText(days)} offen`,
  };
}

/**
 * `invitesToday`: heute (Ortszeit, ab `todayStart`) gesendete Vernetzungsanfragen je Gründer – sie zählen gegen `newLeadsPerDay`, damit nach
 * jeder Anfrage nicht ein weiterer Lead nachrückt.
 */
export function computeTasks(
  allLeads: CockpitLead[],
  owner: AuthFounderId | null,
  rules: TaskRules,
  now = Date.now(),
  invitesToday: Partial<Record<AuthFounderId, number>> = {},
  /** Beginn von „heute“ (ms, Ortszeit) – ohne Angabe UTC-Tag. */
  todayStart = Math.floor(now / DAY) * DAY,
  /** Letzter „Termin vereinbart“ je Lead-ID (Stufe Termin) – erst eine Antwort danach ist eine neue Antwort. */
  meetingsBookedAt: Record<string, number> = {},
  /**
   * Neue Leads anderer Gründer, deren LinkedIn-Account gerade nicht verbunden ist (17.10.): Nur mit `owner` – sie füllen
   * die Plätze, die nach dessen eigenen neuen Leads heute noch frei sind (`adoptedFrom`).
   */
  adopt: CockpitLead[] = [],
  /**
   * Nur ohne `owner` („Alle“, 24.10.): Plätze eines Gründers, die seine eigenen neuen Leads heute nicht füllen, bekommt
   * der andere – gesendet wird dann über den zweiten Account (`LINKEDIN_ACCOUNT_FALLBACK`). „Meine“ zeigt nur die
   * Plätze des eigenen Accounts.
   */
  shareFreeSlots = false,
): TasksResponse {
  // Übersprungene Leads („für heute überspringen“) fehlen, bis die Zeit um ist – ebenso Leads mit geplanter
  // Wiedervorlage (22.10.): bis dahin pausiert der Workflow ganz.
  const paused = (lead: CockpitLead) => (!!lead.snoozedUntil && lead.snoozedUntil > now) || (!!lead.followUpPlan && lead.followUpPlan.at > now);
  const leads = (owner ? allLeads.filter((lead) => lead.owner === owner) : allLeads).filter((lead) => !paused(lead));
  const followUpMs = rules.followUpAfterDays * DAY;
  const byType: Record<TaskType, DailyTask[]> = { reply: [], followup: [], first: [], lead: [] };
  const attention: AttentionItem[] = [];
  const newLeads = new Map<AuthFounderId, CockpitLead[]>();

  for (const lead of leads) {
    // Fällige Wiedervorlage: wieder eine Nachricht schreiben – auch nach allen Follow-ups und ohne Wartezeit.
    const due = lead.followUpDueAt ?? null;
    const resume = (): void => {
      const number = lead.followUpsSent + 1;
      byType.followup.push({
        id: `${lead.id}:followup:${number}:${due}`,
        type: 'followup',
        lead,
        dueSince: due!,
        reason: `Wiedervorlage – geplant für ${new Date(due!).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'numeric' })}`,
        followUpNumber: number,
        resumed: true,
      });
    };
    // Aktives Gespräch (Wunsch des Kunden 25.10.): Der Lead hat mindestens einmal geantwortet, die letzte Nachricht
    // kam von uns. Nach FOLLOWUP_AFTER_DAYS Ruhe wieder ein Follow-up – alle FOLLOWUP_AFTER_DAYS Tage neu (die ID hängt
    // an der letzten eigenen Nachricht), ohne Höchstzahl, bis er antwortet oder als verloren markiert ist.
    const activeFollowUp = (): void => {
      const last = lead.lastContactAt!;
      if (now - last < followUpMs) return;
      byType.followup.push({
        id: `${lead.id}:followup:active:${last}`,
        type: 'followup',
        lead,
        dueSince: last + followUpMs,
        reason: `Aktives Gespräch – keine Antwort auf deine Nachricht ${dayText(daysSince(last, now))}, nachfassen`,
        followUpNumber: lead.followUpsSent + 1,
        active: true,
      });
    };
    const awaitingThem = lead.lastReplyAt !== null && lead.lastContactAt !== null && lead.lastContactAt > lead.lastReplyAt;
    switch (lead.stage) {
      case 'replied': {
        // Schon geantwortet (eigene Nachricht nach der letzten Antwort): keine Antwort-Aufgabe, bis die Person wieder
        // schreibt – nach FOLLOWUP_AFTER_DAYS Ruhe aber ein Follow-up (aktives Gespräch).
        if (awaitingThem) {
          if (due) resume();
          else activeFollowUp();
          break;
        }
        byType.reply.push(replyTask(lead, lead.lastReplyAt ?? lead.lastActivityAt, now));
        break;
      }
      case 'contacted': {
        if (due) {
          resume();
          break;
        }
        // Hat schon einmal geantwortet (z. B. wieder geöffnet): aktives Gespräch, keine Höchstzahl an Follow-ups.
        if (awaitingThem) {
          activeFollowUp();
          break;
        }
        const last = lead.lastContactAt ?? lead.lastActivityAt;
        const silent = daysSince(last, now);
        if (now - last < followUpMs) break;
        if (lead.followUpsSent >= rules.maxFollowUps) {
          attention.push({
            lead,
            reason: 'followups_done',
            detail: `Alle ${rules.maxFollowUps} Follow-ups gesendet, keine Antwort ${dayText(silent)}`,
            days: silent,
          });
          break;
        }
        const number = lead.followUpsSent + 1;
        byType.followup.push({
          id: `${lead.id}:followup:${number}`,
          type: 'followup',
          lead,
          dueSince: last + followUpMs,
          reason: `Keine Antwort ${dayText(silent)} – Follow-up ${number} von ${rules.maxFollowUps}`,
          followUpNumber: number,
        });
        break;
      }
      case 'connected': {
        const days = daysSince(lead.lastActivityAt, now);
        byType.first.push({
          id: `${lead.id}:first`,
          type: 'first',
          lead,
          dueSince: lead.lastActivityAt,
          reason: days === 0 ? 'Heute vernetzt – Erstnachricht fehlt' : `Vernetzt ${dayText(days)} – Erstnachricht fehlt`,
        });
        break;
      }
      case 'new': {
        const list = newLeads.get(lead.owner) ?? [];
        list.push(lead);
        newLeads.set(lead.owner, list);
        break;
      }
      case 'invited': {
        const days = daysSince(lead.lastContactAt ?? lead.lastActivityAt, now);
        if (days >= rules.inviteStaleDays) {
          attention.push({ lead, reason: 'invite_stale', detail: `Anfrage ${dayText(days)} offen`, days });
        }
        break;
      }
      case 'meeting': {
        // Antwort nach dem Termin (die Stufe bleibt „Termin“): wieder eine Antwort-Aufgabe – bis du antwortest.
        const answered = Math.max(lead.lastContactAt ?? 0, meetingsBookedAt[lead.id] ?? 0);
        if (lead.lastReplyAt !== null && lead.lastReplyAt > answered) byType.reply.push(replyTask(lead, lead.lastReplyAt, now));
        else if (due) resume();
        const days = daysSince(lead.lastActivityAt, now);
        if (rules.handover !== false) attention.push({ lead, reason: 'meeting_open', detail: `Termin vereinbart, ${dayText(days)} nicht übergeben`, days });
        break;
      }
    }
  }

  // Neue Leads: Tageslimit je Gründer (LinkedIn-Limit gilt je Account), abzüglich der heute schon gesendeten Anfragen.
  // Heute aus der Lead-Suche übergebene Leads sind immer dabei – wer gerade gesucht hat, will sie sofort im Stapel sehen.
  const today = todayStart;
  const freeSlots = new Map<AuthFounderId, number>();
  const spare = new Map<AuthFounderId, CockpitLead[]>();
  for (const [founder, list] of newLeads) {
    // Nur Leads aus einer Suche von Hand – die automatische Suche (`origin.auto`) zählt gegen das Tageslimit.
    // Ebenso heute per Link aufgenommene Kontakte (noch nicht vernetzt).
    // Fällige Wiedervorlage ist wie frisch: immer dabei, über dem Tageslimit.
    const isFresh = (lead: CockpitLead) =>
      !!lead.followUpDueAt || (((lead.origin.kind === 'search' && !lead.origin.auto) || lead.origin.kind === 'contact') && lead.createdAt >= today);
    const fresh = list.filter(isFresh).sort((a, b) => scoreOf(b) - scoreOf(a) || a.id.localeCompare(b.id));
    const older = list.filter((lead) => !isFresh(lead));
    const slots = Math.max(0, rules.newLeadsPerDay - (invitesToday[founder] ?? 0) - fresh.length);
    // Leads aus einer Suche von Hand (oder per Link) von früheren Tagen zuerst (Kundengespräch 25.10.: sonst rutschten
    // sie am Tag nach der Suche hinter hunderte automatisch gefundene und „verschwanden“), dann wie bisher nach Score.
    const handPicked = older
      .filter((lead) => (lead.origin.kind === 'search' && !lead.origin.auto) || lead.origin.kind === 'contact')
      .sort((a, b) => scoreOf(b) - scoreOf(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, slots);
    const handIds = new Set(handPicked.map((lead) => lead.id));
    const fromOlder = [
      ...handPicked.map((lead) => ({ lead, exploration: false })),
      ...(slots > handPicked.length ? pickNewLeads(older.filter((lead) => !handIds.has(lead.id)), slots - handPicked.length, todayStart) : []),
    ];
    const picked = [...fresh.map((lead) => ({ lead, exploration: false })), ...fromOlder];
    freeSlots.set(founder, slots - fromOlder.length);
    const taken = new Set(fromOlder.map((entry) => entry.lead.id));
    spare.set(founder, older.filter((lead) => !taken.has(lead.id)));
    for (const { lead, exploration } of picked) {
      byType.lead.push({
        id: `${lead.id}:lead`,
        type: 'lead',
        lead,
        dueSince: lead.createdAt,
        reason: exploration ? `${newLeadReason(lead)} · zum Vergleich ausgewählt` : newLeadReason(lead),
        ...(exploration ? { exploration: true } : {}),
      });
    }
  }

  // „Alle“ mit zweitem Account: freie Plätze des einen Gründers füllen die übrigen neuen Leads des anderen.
  if (!owner && shareFreeSlots) {
    // Heute schon über die eigenen Plätze hinaus angeschriebene Leads haben Plätze des anderen verbraucht.
    const founders = [...new Set<AuthFounderId>([...newLeads.keys(), ...(Object.keys(invitesToday) as AuthFounderId[])])];
    const overflow = (id: AuthFounderId) => Math.max(0, (invitesToday[id] ?? 0) - rules.newLeadsPerDay);
    for (const helper of founders) {
      // Ein Gründer ohne eigene neue Leads hat seine ganzen Plätze frei (abzüglich heute gesendeter Anfragen).
      const own = freeSlots.get(helper) ?? Math.max(0, rules.newLeadsPerDay - (invitesToday[helper] ?? 0));
      const used = founders.filter((id) => id !== helper).reduce((sum, id) => sum + overflow(id), 0);
      freeSlots.set(helper, Math.max(0, own - used));
    }
    for (const [founder, rest] of spare) {
      for (const helper of founders.filter((id) => id !== founder)) {
        if (!rest.length) break;
        const free = freeSlots.get(helper) ?? 0;
        if (free <= 0) continue;
        const extra = pickNewLeads(rest, free, todayStart).map((entry) => entry.lead);
        freeSlots.set(helper, free - extra.length);
        const ids = new Set(extra.map((lead) => lead.id));
        rest.splice(0, rest.length, ...rest.filter((lead) => !ids.has(lead.id)));
        for (const lead of extra) {
          byType.lead.push({
            id: `${lead.id}:lead`,
            type: 'lead',
            lead,
            dueSince: lead.createdAt,
            reason: `${newLeadReason(lead)} · Platz von ${defaultFounderName(helper)}`,
          });
        }
      }
    }
  }

  // Übernommene Leads (Account des Besitzers nicht verbunden): nur in freie Plätze, nach den eigenen.
  if (owner && adopt.length) {
    const ownPicked = byType.lead.length;
    const free = Math.max(0, rules.newLeadsPerDay - (invitesToday[owner] ?? 0) - ownPicked);
    const open = adopt.filter((lead) => lead.stage === 'new' && lead.owner !== owner && (!lead.snoozedUntil || lead.snoozedUntil <= now));
    for (const { lead, exploration } of free > 0 ? pickNewLeads(open, free, todayStart) : []) {
      byType.lead.push({
        id: `${lead.id}:lead`,
        type: 'lead',
        // Im Stapel schon als Lead des übernehmenden Gründers (sein Account, sein Limit) – Besitzer wird er mit der Anfrage.
        lead: { ...lead, owner },
        dueSince: lead.createdAt,
        reason: `${newLeadReason(lead)} · übernommen von ${defaultFounderName(lead.owner)}`,
        adoptedFrom: lead.owner,
        ...(exploration ? { exploration: true } : {}),
      });
    }
  }

  const byAge = (a: DailyTask, b: DailyTask) => a.dueSince - b.dueSince || a.id.localeCompare(b.id);
  byType.reply.sort(byAge);
  byType.followup.sort(byAge);
  byType.first.sort(byAge);
  byType.lead.sort((a, b) => scoreOf(b.lead) - scoreOf(a.lead) || byAge(a, b));
  attention.sort((a, b) => b.days - a.days || a.lead.id.localeCompare(b.lead.id));

  return {
    tasks: TASK_TYPES.flatMap((type) => byType[type]),
    counts: { reply: byType.reply.length, followup: byType.followup.length, first: byType.first.length, lead: byType.lead.length },
    attention,
    owner,
    generatedAt: now,
    rules: { ...rules },
    invitesToday: owner ? { [owner]: invitesToday[owner] ?? 0 } : { ...invitesToday },
  };
}
