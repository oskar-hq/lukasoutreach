import type { DashboardDay, DashboardResponse, FollowUpStat, TemplateStat } from '../../../shared/dashboard';
import { formatInt } from '../../lib/format';
import type { FounderId } from '../../state/types';

/** Sichtbar sind 8 Wochen, die 8 davor dienen als Vergleich (Backend liefert standardmäßig 112 Tage). */
export const VISIBLE_DAYS = 56;

export type Scope = 'all' | FounderId;

export type Direction = 'up' | 'down' | 'flat';

/**
 * Quote höchstens 100 %; ohne Nenner null. Annahmen und Antworten einer Woche können zu Anfragen aus Vorwochen
 * gehören – bei wenigen Leads läge die Quote sonst über 100 %.
 */
export const rate = (a: number, b: number): number | null => (b ? Math.min(1, a / b) : null);

/** Prozent ohne Nachkommastelle. */
export const pct = (ratio: number) => `${formatInt(Math.round(ratio * 100))} %`;

const bySign = (value: number): Direction => (value > 0 ? 'up' : 'down');

/** Veränderung einer Anzahl zur Woche davor – ehrlich auch bei 0 in der Vorwoche. */
export function countDelta(cur: number, prev: number): { delta: string; direction: Direction } {
  if (cur === prev) return { delta: cur ? '±0 %' : '–', direction: 'flat' };
  if (prev === 0) return { delta: `+${formatInt(cur)}`, direction: 'up' };
  const change = Math.round(((cur - prev) / prev) * 100);
  if (change === 0) return { delta: '±0 %', direction: 'flat' };
  return { delta: `${change > 0 ? '+' : '−'}${formatInt(Math.abs(change))} %`, direction: bySign(change) };
}

/** Veränderung einer Quote in Prozentpunkten; fehlt in einer Woche der Nenner, „–“. */
export function rateDelta(cur: number | null, prev: number | null): { delta: string; direction: Direction } {
  if (cur === null || prev === null) return { delta: '–', direction: 'flat' };
  const points = Math.round((cur - prev) * 100);
  if (points === 0) return { delta: '±0 Pp.', direction: 'flat' };
  return { delta: `${points > 0 ? '+' : '−'}${formatInt(Math.abs(points))} Pp.`, direction: bySign(points) };
}

export interface DayStat {
  /** Mittag des Tages (ms), damit Datumsanzeige und Kalenderwoche nicht an der Zeitzone kippen. */
  date: number;
  requests: number;
  accepted: number;
  messaged: number;
  replies: number;
  meetings: number;
  handovers: number;
}

export interface RateStat {
  key: string;
  /** Kurz für die Achse (z. B. „G1“). */
  label: string;
  /** Ausführlich für den Tooltip (z. B. „G1 · Greenfield · Kanal noch offen“). */
  title?: string;
  sent: number;
  replies: number;
  rate: number;
}

const founders = (scope: Scope): FounderId[] => (scope === 'all' ? ['nick', 'johannes'] : [scope]);

function toDayStat(day: DashboardDay): DayStat {
  const [year, month, date] = day.date.split('-').map(Number);
  const { date: _date, ...counts } = day;
  return { date: new Date(year, month - 1, date, 12).getTime(), ...counts };
}

/** Tageswerte des Bereichs – „Gesamt“ ist die Summe beider Gründer. */
export function daysFor(data: DashboardResponse, scope: Scope): DayStat[] {
  const lists = founders(scope).map((founder) => data.days[founder] ?? []);
  const base = lists[0] ?? [];
  return base.map((day, index) => {
    const total = toDayStat(day);
    for (const list of lists.slice(1)) {
      const other = list[index];
      if (!other) continue;
      total.requests += other.requests;
      total.accepted += other.accepted;
      total.messaged += other.messaged;
      total.replies += other.replies;
      total.meetings += other.meetings;
      total.handovers += other.handovers;
    }
    return total;
  });
}

export function sumDays(days: DayStat[]) {
  return days.reduce(
    (acc, day) => ({
      requests: acc.requests + day.requests,
      accepted: acc.accepted + day.accepted,
      messaged: acc.messaged + day.messaged,
      replies: acc.replies + day.replies,
      meetings: acc.meetings + day.meetings,
      handovers: acc.handovers + day.handovers,
    }),
    { requests: 0, accepted: 0, messaged: 0, replies: 0, meetings: 0, handovers: 0 },
  );
}

/** Die letzten `count` Wochen (je 7 Tage, die jüngste endet heute), älteste zuerst. */
export function weeks(days: DayStat[], count: number): DayStat[][] {
  const result: DayStat[][] = [];
  for (let i = count; i > 0; i--) result.push(days.slice(Math.max(0, days.length - i * 7), days.length - (i - 1) * 7));
  return result.filter((week) => week.length > 0);
}

/**
 * Antwortquote je Vorlage der Erstnachricht. `nameOf` liefert den Namen aus `GET /api/templates`; Labels ohne
 * Vorlage (z. B. A/B/C aus der Zeit vor den neuen Vorlagen) heißen „Vorlage A (alt)“.
 */
export function templateStats(
  data: DashboardResponse,
  scope: Scope,
  nameOf: (id: string) => string | null = () => null,
  /** Ohne geladene Vorlagen nichts als „alt“ markieren – es ist nur unbekannt. */
  namesKnown = true,
): RateStat[] {
  const byTemplate = new Map<string, { sent: number; replies: number }>();
  for (const founder of founders(scope)) {
    for (const stat of data.templates[founder] ?? ([] as TemplateStat[])) {
      const entry = byTemplate.get(stat.template) ?? { sent: 0, replies: 0 };
      entry.sent += stat.messaged;
      entry.replies += stat.replied;
      byTemplate.set(stat.template, entry);
    }
  }
  return [...byTemplate.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'de'))
    .map(([template, { sent, replies }]) => {
      const name = nameOf(template);
      return {
        key: template,
        label: name || !namesKnown ? template : `${template} (alt)`,
        title: name ? `${template} · ${name}` : namesKnown ? `Vorlage ${template} (alt)` : `Vorlage ${template}`,
        sent,
        replies,
        rate: sent ? replies / sent : 0,
      };
    });
}

/** Antwortquote je Stufe: 0 = Erstnachricht, dann Follow-up 1, 2 … */
export function followUpStats(data: DashboardResponse, scope: Scope): RateStat[] {
  const byStage = new Map<number, { sent: number; replies: number }>();
  for (const founder of founders(scope)) {
    for (const stat of data.followUps[founder] ?? ([] as FollowUpStat[])) {
      const entry = byStage.get(stat.stage) ?? { sent: 0, replies: 0 };
      entry.sent += stat.reached;
      entry.replies += stat.replied;
      byStage.set(stat.stage, entry);
    }
  }
  return [...byStage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, { sent, replies }]) => ({
      key: String(stage),
      label: stage === 0 ? 'Erstnachricht' : `Follow-up ${stage}`,
      sent,
      replies,
      rate: sent ? replies / sent : 0,
    }));
}
