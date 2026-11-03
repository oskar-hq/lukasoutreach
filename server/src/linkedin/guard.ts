import { createHash, randomUUID } from 'node:crypto';
import type { AuthFounderId } from '../../../shared/auth.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';

/**
 * Schutzgrenzen für echte LinkedIn-Aktionen (Vertrag `shared/linkedin.ts`): Arbeitszeit, Tages-/Wochenlimits aus dem
 * Protokoll `linkedin_actions`, Pausen nach Limit- oder Zugangsfehlern (`linkedin_pauses`, überstehen einen Neustart).
 */

export type ActionKind = 'invite' | 'message';
export type ActionStatus = 'sent' | 'failed';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

interface LocalTime {
  /** YYYY-MM-DD in der Zeitzone. */
  day: string;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

/** Ein Formatierer je Zeitzone – das Anlegen ist teuer, `localTime` läuft oft (Planer, Abfragen alle paar Sekunden). */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

export function localTime(now: number, timeZone: string): LocalTime {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday] ?? 1,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function withinWorkHours(config: Config['linkedin'], now: number): boolean {
  const local = localTime(now, config.workHours.timeZone);
  return config.workHours.days.includes(local.weekday) && local.hour >= config.workHours.fromHour && local.hour < config.workHours.toHour;
}

/** Sekunden bis Mitternacht in der Zeitzone (für Retry-After beim Tageslimit). */
export function secondsUntilMidnight(now: number, timeZone: string): number {
  const local = localTime(now, timeZone);
  return Math.max(1, 24 * 3600 - (local.hour * 3600 + local.minute * 60 + local.second));
}

/** Beginn des Kalendertags in der Zeitzone (ms) – „heute“ im Tagesstapel. */
export function localDayStart(now: number, timeZone: string): number {
  const local = localTime(now, timeZone);
  return now - (now % 1000) - (local.hour * 3600 + local.minute * 60 + local.second) * 1000;
}

/** Nächste Mitternacht in der Zeitzone (ms). */
export function nextLocalMidnight(now: number, timeZone: string): number {
  return now - (now % 1000) + secondsUntilMidnight(now, timeZone) * 1000;
}

/** Stabile Zahl je Text – Simulation: welche Anfrage „angenommen“ wird, wer „antwortet“. */
export function stableNumber(text: string): number {
  return createHash('sha256').update(text).digest()[0];
}

export interface Usage {
  invitesToday: number;
  invitesWeek: number;
  messagesToday: number;
  /** Ältester Versand der letzten 7 Tage (für Retry-After beim Wochenlimit). */
  oldestInviteInWeek: number | null;
}

export class LinkedInGuard {
  constructor(
    private readonly db: Database,
    private readonly config: Config['linkedin'],
    /** Eigene Tagesgrenze für Anfragen je Gründer-Account (21.10.), sonst `invitesPerDay`. */
    private readonly invitesPerDayFor: (founder: AuthFounderId) => number | undefined = () => undefined,
  ) {}

  /** Anfragen am Tag für diesen Gründer: eigene Grenze am Account, sonst die allgemeine. */
  invitesPerDay(founder: AuthFounderId): number {
    return this.invitesPerDayFor(founder) ?? this.config.invitesPerDay;
  }

  record(entry: { founder: AuthFounderId; accountId: string | null; leadId: string | null; kind: ActionKind; status: ActionStatus; detail: string | null }, now: number): void {
    this.db
      .prepare('INSERT INTO linkedin_actions (id, founder, account_id, lead_id, kind, status, detail, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        randomUUID(),
        entry.founder,
        entry.accountId,
        entry.leadId,
        entry.kind,
        entry.status,
        entry.detail,
        localTime(now, this.config.workHours.timeZone).day,
        now,
      );
  }

  /**
   * Eine Zählung für alle Wege (25.10., Kundengespräch „27 von 20“): Vernetzungsanfragen zählen aus dem Verlauf der
   * Leads je Account, über den sie gingen (`linkedin.sentBy`, sonst der Besitzer) – egal ob über Unipile gesendet oder
   * von Hand eingetragen. Dazu Anfragen ohne Lead im Verlauf (Test-Anfrage, gelöschter Lead) aus `linkedin_actions`.
   * Vorher zählte der Server beim Senden nur `linkedin_actions`, beim Eintragen nur den Verlauf – beide zusammen
   * ließen mehr Anfragen durch als eingestellt.
   */
  private invitesSince(founder: AuthFounderId, since: number): { count: number; oldest: number | null } {
    const fromEvents = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(e.at) AS oldest FROM lead_events e JOIN leads l ON l.id = e.lead_id
         WHERE e.kind = 'invite_sent' AND e.at >= ? AND COALESCE(json_extract(l.linkedin, '$.sentBy'), l.owner) = ?`,
      )
      .get(since, founder) as { n: number; oldest: number | null };
    const withoutLead = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(a.at) AS oldest FROM linkedin_actions a
         WHERE a.founder = ? AND a.kind = 'invite' AND a.status = 'sent' AND a.at >= ?
           AND (a.lead_id IS NULL OR NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id))`,
      )
      .get(founder, since) as { n: number; oldest: number | null };
    const oldest = [fromEvents.oldest, withoutLead.oldest].filter((at): at is number => at !== null);
    return { count: fromEvents.n + withoutLead.n, oldest: oldest.length ? Math.min(...oldest) : null };
  }

  usage(founder: AuthFounderId, now: number): Usage {
    const day = localTime(now, this.config.workHours.timeZone).day;
    // Nachrichten genauso (25.10.): Verlauf je Account (gesendet, eingetragen oder aus LinkedIn übernommen – alle gingen
    // über diesen Account raus) plus Test-Nachrichten ohne Lead.
    const since = localDayStart(now, this.config.workHours.timeZone);
    const fromEvents = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM lead_events e JOIN leads l ON l.id = e.lead_id
         WHERE e.kind = 'message_sent' AND e.at >= ? AND COALESCE(json_extract(l.linkedin, '$.sentBy'), l.owner) = ?`,
      )
      .get(since, founder) as { n: number };
    const withoutLead = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM linkedin_actions a WHERE a.founder = ? AND a.kind = 'message' AND a.status = 'sent' AND a.day = ?
           AND (a.lead_id IS NULL OR NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id))`,
      )
      .get(founder, day) as { n: number };
    const messages = { n: fromEvents.n + withoutLead.n };
    const week = this.invitesSince(founder, now - 7 * DAY_MS + 1);
    return {
      invitesToday: this.invitesSince(founder, localDayStart(now, this.config.workHours.timeZone)).count,
      invitesWeek: week.count,
      messagesToday: messages.n,
      oldestInviteInWeek: week.oldest,
    };
  }

  /** null = erlaubt, sonst { Satz, Sekunden bis es wieder geht }. */
  limitReached(founder: AuthFounderId, kind: ActionKind, now: number): { message: string; retryAfter: number } | null {
    const usage = this.usage(founder, now);
    const untilMidnight = secondsUntilMidnight(now, this.config.workHours.timeZone);
    if (kind === 'invite') {
      const perDay = this.invitesPerDay(founder);
      if (usage.invitesToday >= perDay) {
        return { message: `Tageslimit für Vernetzungsanfragen erreicht (${perDay}) – morgen geht es weiter.`, retryAfter: untilMidnight };
      }
      if (usage.invitesWeek >= this.config.invitesPerWeek) {
        const retryAfter = usage.oldestInviteInWeek ? Math.max(1, Math.ceil((usage.oldestInviteInWeek + 7 * DAY_MS - now) / 1000)) : untilMidnight;
        return { message: `Wochenlimit für Vernetzungsanfragen erreicht (${this.config.invitesPerWeek} in 7 Tagen).`, retryAfter };
      }
      return null;
    }
    if (usage.messagesToday >= this.config.messagesPerDay) {
      return { message: `Tageslimit für Nachrichten erreicht (${this.config.messagesPerDay}) – morgen geht es weiter.`, retryAfter: untilMidnight };
    }
    return null;
  }

  pause(founder: AuthFounderId): { until: number; reason: string } | null {
    const row = this.db.prepare('SELECT paused_until, reason FROM linkedin_pauses WHERE founder = ?').get(founder) as
      | { paused_until: number; reason: string }
      | undefined;
    return row ? { until: row.paused_until, reason: row.reason } : null;
  }

  activePause(founder: AuthFounderId, now: number): { until: number; reason: string } | null {
    const pause = this.pause(founder);
    return pause && pause.until > now ? pause : null;
  }

  setPause(founder: AuthFounderId, until: number, reason: string): void {
    this.db
      .prepare('INSERT INTO linkedin_pauses (founder, paused_until, reason) VALUES (?, ?, ?) ON CONFLICT(founder) DO UPDATE SET paused_until = excluded.paused_until, reason = excluded.reason')
      .run(founder, until, reason);
  }

  clearPause(founder: AuthFounderId): boolean {
    return Number(this.db.prepare('DELETE FROM linkedin_pauses WHERE founder = ?').run(founder).changes) > 0;
  }

  /** true, wenn die Nachricht neu ist (und merkt sie sich). */
  /** Diese Nachricht hat das Cockpit schon gebucht (Abgleich oder Chat-Import). */
  seen(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM linkedin_seen_messages WHERE message_id = ?').get(messageId);
  }

  markSeen(messageId: string, leadId: string, now: number): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO linkedin_seen_messages (message_id, lead_id, at) VALUES (?, ?, ?)').run(messageId, leadId, now).changes) > 0;
  }
}
