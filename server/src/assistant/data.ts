import type { AuthFounderId } from '../../../shared/auth.js';
import { AUTH_FOUNDER_IDS, defaultFounderName } from '../../../shared/auth.js';
import { CATEGORY_LABELS, type LeadCategory } from '../../../shared/leadSearch.js';
import { LEAD_STAGE_LABELS, type CockpitLead, type LeadStage } from '../../../shared/leads.js';
import type { Database } from '../db/database.js';
import type { LeadStore } from '../leads/leadStore.js';

/**
 * Daten für den KI-Assistenten (Vertrag `shared/assistant.ts`) – nur lesend, als kompakter Text für Claude. Der Kern ist
 * der ganze Gesprächsverlauf je Lead (beide Richtungen, mit Position in der Sequenz und Vorlage), damit Claude „zwischen
 * den Zeilen lesen“ kann; dazu eine vorab gerechnete Sequenz-Auswertung, die sonst viele Lesevorgänge kosten würde.
 * `scope` = Gründer, deren Leads das Konto sehen darf (null = alle).
 */

const TIME_ZONE = 'Europe/Berlin';
/** Längere Nachrichten werden in Stapeln gekürzt – im Detail eines Leads stehen sie ganz. */
const BATCH_MESSAGE_CHARS = 1500;
export const CONVERSATIONS_MAX_LIMIT = 150;
const SEARCH_MAX_LIMIT = 50;
const FIND_MAX_LIMIT = 100;

export type ConversationOutcome = 'all' | 'replied' | 'no_reply' | 'interested' | 'not_interested' | 'meeting' | 'lost';

interface ThreadMessage {
  dir: 'out' | 'in';
  at: number;
  text: string;
  /** Vorlage bzw. Variante (z. B. G1, F2A) – nur eigene Nachrichten. */
  label: string | null;
  /** Nur eigene Nachrichten: 1 = Erstnachricht, 2 = zweite Nachricht … */
  position: number | null;
}

interface Thread {
  lead: CockpitLead;
  invitedAt: number | null;
  inviteNote: string | null;
  acceptedAt: number | null;
  meetingAt: number | null;
  lostAt: number | null;
  messages: ThreadMessage[];
}

interface EventRow {
  lead_id: string;
  kind: string;
  at: number;
  text: string | null;
  label: string | null;
}

const dateFormat = new Intl.DateTimeFormat('de-DE', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('de-DE', { timeZone: TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat('de-DE', { timeZone: TIME_ZONE, weekday: 'short' });
const hourFormat = new Intl.DateTimeFormat('de-DE', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' });

const when = (at: number) => `${dateFormat.format(at)} ${timeFormat.format(at)}`;
const day = (at: number) => dateFormat.format(at);
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)} %` : '–');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} … [gekürzt, ${text.length} Zeichen]` : text);
const nameOf = (lead: CockpitLead) => `${lead.person.firstName} ${lead.person.lastName}`.trim();
const linkOf = (lead: CockpitLead) => `[${nameOf(lead)}](lead:${lead.id})`;
const categoryOf = (lead: CockpitLead) => (lead.assessment ? CATEGORY_LABELS[lead.assessment.category] : 'ohne Kategorie');

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function hoursText(ms: number | null): string {
  if (ms === null) return '–';
  const hours = ms / 3_600_000;
  return hours < 48 ? `${Math.round(hours)} Std.` : `${Math.round(hours / 24)} Tage`;
}

export class AssistantData {
  constructor(
    private readonly leads: LeadStore,
    private readonly db: Database,
  ) {}

  /** Alle Leads im Sichtbereich mit ihrem Gesprächsverlauf. */
  private threads(scope: AuthFounderId[] | null): Thread[] {
    const owners = scope ?? [...AUTH_FOUNDER_IDS];
    const leads = owners.flatMap((owner) => this.leads.list({ owner, limit: 1_000_000, sort: 'recent' }).leads);
    if (!leads.length) return [];
    const byId = new Map(leads.map((lead) => [lead.id, lead]));
    const rows = this.db
      .prepare(
        "SELECT lead_id, kind, at, text, label FROM lead_events WHERE kind IN ('invite_sent', 'invite_accepted', 'message_sent', 'message_received', 'meeting_booked', 'lost') ORDER BY at ASC, rowid ASC",
      )
      .all() as unknown as EventRow[];
    const threads = new Map<string, Thread>();
    for (const lead of leads) threads.set(lead.id, { lead, invitedAt: null, inviteNote: null, acceptedAt: null, meetingAt: null, lostAt: null, messages: [] });
    for (const row of rows) {
      const thread = byId.has(row.lead_id) ? threads.get(row.lead_id)! : null;
      if (!thread) continue;
      switch (row.kind) {
        case 'invite_sent':
          thread.invitedAt ??= row.at;
          if (row.text?.trim()) thread.inviteNote = row.text.trim();
          break;
        case 'invite_accepted':
          thread.acceptedAt ??= row.at;
          break;
        case 'meeting_booked':
          thread.meetingAt ??= row.at;
          break;
        case 'lost':
          thread.lostAt = row.at;
          break;
        case 'message_sent':
        case 'message_received': {
          if (!row.text?.trim()) break;
          const dir = row.kind === 'message_sent' ? 'out' : 'in';
          const position = dir === 'out' ? thread.messages.filter((message) => message.dir === 'out').length + 1 : null;
          thread.messages.push({ dir, at: row.at, text: row.text.trim(), label: dir === 'out' ? row.label : null, position });
          break;
        }
      }
    }
    return [...threads.values()];
  }

  // ── Sequenz-Auswertung ──────────────────────────────────────────────────

  /**
   * Was sich nicht vom Dashboard ablesen lässt: Wirkung je Position in der Sequenz (Erstnachricht, 2., 3. …), je Vorlage,
   * Länge, Frage am Ende, Wochentag/Uhrzeit, Kategorie, Gründer, Notiz zur Anfrage. „Antwort nach Nachricht n“ = die
   * erste Antwort des Leads kam nach der n-ten eigenen Nachricht und vor der nächsten.
   */
  analysis(scope: AuthFounderId[] | null): string {
    const threads = this.threads(scope);
    const contacted = threads.filter((thread) => thread.messages.some((message) => message.dir === 'out'));
    const lines: string[] = [];
    const replied = contacted.filter((thread) => thread.messages.some((message) => message.dir === 'in'));
    const meetings = threads.filter((thread) => thread.meetingAt !== null || thread.lead.stage === 'meeting' || thread.lead.stage === 'handed_over');
    lines.push('# Outreach-Auswertung (vorab gerechnet)');
    lines.push(
      `Leads im Sichtbereich: ${threads.length} · angefragt: ${threads.filter((thread) => thread.invitedAt).length} · angenommen: ${threads.filter((thread) => thread.acceptedAt).length} · angeschrieben: ${contacted.length} · geantwortet: ${replied.length} (${percent(replied.length, contacted.length)} der Angeschriebenen) · Termine: ${meetings.length} (${percent(meetings.length, replied.length)} der Antwortenden)`,
    );

    // Annahme der Vernetzungsanfrage mit/ohne Notiz.
    const invited = threads.filter((thread) => thread.invitedAt);
    const withNote = invited.filter((thread) => thread.inviteNote);
    const withoutNote = invited.filter((thread) => !thread.inviteNote);
    lines.push(
      `Anfragen mit Notiz: ${withNote.length}, angenommen ${percent(withNote.filter((thread) => thread.acceptedAt).length, withNote.length)} · ohne Notiz: ${withoutNote.length}, angenommen ${percent(withoutNote.filter((thread) => thread.acceptedAt).length, withoutNote.length)}`,
    );

    // Je Position: erste Antwort nach Nachricht n.
    const firstReplyAfter = new Map<number, number>();
    const reached = new Map<number, number>();
    const replyDelay: number[] = [];
    type Bucket = { sent: number; replies: number };
    const add = (map: Map<string, Bucket>, key: string, reply: boolean) => {
      const bucket = map.get(key) ?? { sent: 0, replies: 0 };
      bucket.sent += 1;
      if (reply) bucket.replies += 1;
      map.set(key, bucket);
    };
    const byLabel = new Map<string, Bucket>();
    const byLength = new Map<string, Bucket>();
    const byQuestion = new Map<string, Bucket>();
    const byWeekday = new Map<string, Bucket>();
    const byHour = new Map<string, Bucket>();
    for (const thread of contacted) {
      const firstReply = thread.messages.find((message) => message.dir === 'in') ?? null;
      const outbound = thread.messages.filter((message) => message.dir === 'out');
      outbound.forEach((message, index) => {
        // Nur Nachrichten bis zur ersten Antwort – danach ist es ein Gespräch, keine Sequenz mehr.
        if (firstReply && message.at > firstReply.at) return;
        const next = outbound[index + 1];
        const triggered = !!firstReply && firstReply.at >= message.at && (!next || firstReply.at < next.at);
        const position = message.position!;
        reached.set(position, (reached.get(position) ?? 0) + 1);
        if (triggered) {
          firstReplyAfter.set(position, (firstReplyAfter.get(position) ?? 0) + 1);
          replyDelay.push(firstReply.at - message.at);
        }
        add(byLabel, `#${position} ${message.label ?? 'ohne Vorlage (frei geschrieben)'}`, triggered);
        const length = message.text.length;
        add(byLength, length < 300 ? 'unter 300 Zeichen' : length < 600 ? '300–600 Zeichen' : length < 1000 ? '600–1000 Zeichen' : 'über 1000 Zeichen', triggered);
        add(byQuestion, /\?\s*(\S+\s*){0,12}$/.test(message.text) ? 'endet mit einer Frage' : 'ohne Frage am Ende', triggered);
        add(byWeekday, weekdayFormat.format(message.at), triggered);
        const hour = Number(hourFormat.format(message.at));
        add(byHour, hour < 9 ? 'vor 9 Uhr' : hour < 12 ? '9–12 Uhr' : hour < 15 ? '12–15 Uhr' : hour < 18 ? '15–18 Uhr' : 'ab 18 Uhr', triggered);
      });
    }
    lines.push('', '## Erste Antwort je Position in der Sequenz');
    lines.push('| Nachricht | erreicht (Leads) | erste Antwort danach | Quote |', '|---|---|---|---|');
    for (const position of [...reached.keys()].sort((a, b) => a - b)) {
      const count = reached.get(position)!;
      const replies = firstReplyAfter.get(position) ?? 0;
      lines.push(`| ${position === 1 ? '1 (Erstnachricht)' : position} | ${count} | ${replies} | ${percent(replies, count)} |`);
    }
    lines.push(`Antwortzeit (Median, ab der auslösenden Nachricht): ${hoursText(median(replyDelay))}`);

    const table = (title: string, map: Map<string, Bucket>, sort: 'key' | 'sent' = 'sent') => {
      lines.push('', `## ${title}`, '| | gesendet | erste Antwort danach | Quote |', '|---|---|---|---|');
      const entries = [...map.entries()].sort((a, b) => (sort === 'key' ? a[0].localeCompare(b[0], 'de') : b[1].sent - a[1].sent));
      for (const [key, bucket] of entries) lines.push(`| ${key} | ${bucket.sent} | ${bucket.replies} | ${percent(bucket.replies, bucket.sent)} |`);
    };
    table('Je Position und Vorlage/Variante (bis zur ersten Antwort)', byLabel, 'key');
    table('Nach Länge der Nachricht', byLength);
    table('Frage am Ende der Nachricht', byQuestion);
    table('Nach Wochentag des Sendens', byWeekday);
    table('Nach Uhrzeit des Sendens (deutsche Zeit)', byHour, 'key');

    // Kategorien und Gründer: Antwort- und Terminquote.
    const group = (title: string, keyOf: (thread: Thread) => string) => {
      const map = new Map<string, { contacted: number; replied: number; meetings: number; interested: number }>();
      for (const thread of contacted) {
        const key = keyOf(thread);
        const entry = map.get(key) ?? { contacted: 0, replied: 0, meetings: 0, interested: 0 };
        entry.contacted += 1;
        if (thread.messages.some((message) => message.dir === 'in')) entry.replied += 1;
        if (thread.meetingAt !== null || thread.lead.stage === 'meeting' || thread.lead.stage === 'handed_over') entry.meetings += 1;
        if (thread.lead.conversation?.replyIntent === 'interested') entry.interested += 1;
        map.set(key, entry);
      }
      lines.push('', `## ${title}`, '| | angeschrieben | geantwortet | interessiert | Termine |', '|---|---|---|---|---|');
      for (const [key, entry] of [...map.entries()].sort((a, b) => b[1].contacted - a[1].contacted)) {
        lines.push(`| ${key} | ${entry.contacted} | ${entry.replied} (${percent(entry.replied, entry.contacted)}) | ${entry.interested} | ${entry.meetings} (${percent(entry.meetings, entry.contacted)}) |`);
      }
    };
    group('Nach Kategorie', (thread) => categoryOf(thread.lead));
    group('Nach Gründer (Besitzer des Leads)', (thread) => defaultFounderName(thread.lead.owner));

    // Einschätzung der letzten Antwort.
    const intents = new Map<string, number>();
    for (const thread of replied) {
      const intent = thread.lead.conversation?.replyIntent ?? 'nicht eingeschätzt';
      intents.set(intent, (intents.get(intent) ?? 0) + 1);
    }
    lines.push('', '## Einschätzung der letzten Antwort (KI)', ...[...intents.entries()].map(([intent, count]) => `- ${intent}: ${count}`));
    lines.push(
      '',
      'Hinweis: Zahlen zeigen nur, *wo* etwas wirkt. *Warum* steht in den Gesprächen selbst – dafür `read_conversations` (z. B. outcome=replied gegen outcome=no_reply vergleichen).',
    );
    return lines.join('\n');
  }

  // ── Gesprächsverläufe ───────────────────────────────────────────────────

  conversations(
    scope: AuthFounderId[] | null,
    options: { outcome?: ConversationOutcome; category?: LeadCategory | null; owner?: AuthFounderId | null; offset?: number; limit?: number },
  ): { text: string; count: number; total: number } {
    const outcome = options.outcome ?? 'all';
    const matches = this.threads(scope)
      .filter((thread) => thread.messages.length > 0 || thread.inviteNote)
      .filter((thread) => !options.category || thread.lead.assessment?.category === options.category)
      .filter((thread) => !options.owner || thread.lead.owner === options.owner)
      .filter((thread) => {
        const hasReply = thread.messages.some((message) => message.dir === 'in');
        switch (outcome) {
          case 'replied':
            return hasReply;
          case 'no_reply':
            return !hasReply && thread.messages.some((message) => message.dir === 'out');
          case 'interested':
            return hasReply && thread.lead.conversation?.replyIntent === 'interested';
          case 'not_interested':
            return hasReply && thread.lead.conversation?.replyIntent === 'not_interested';
          case 'meeting':
            return thread.meetingAt !== null || thread.lead.stage === 'meeting' || thread.lead.stage === 'handed_over';
          case 'lost':
            return thread.lead.stage === 'lost';
          default:
            return true;
        }
      })
      .sort((a, b) => b.lead.lastActivityAt - a.lead.lastActivityAt);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(CONVERSATIONS_MAX_LIMIT, Math.max(1, options.limit ?? 50));
    const page = matches.slice(offset, offset + limit);
    const header =
      `Gespräche ${page.length ? offset + 1 : 0}–${offset + page.length} von ${matches.length} (Filter: ${outcome}${options.category ? `, ${CATEGORY_LABELS[options.category]}` : ''}${options.owner ? `, ${defaultFounderName(options.owner)}` : ''}). ` +
      (offset + page.length < matches.length ? `Weitere mit offset=${offset + page.length}.` : 'Das sind alle.') +
      '\n→ = eigene Nachricht (#n = Position in der Sequenz, Vorlage), ← = Antwort des Leads.';
    return { text: [header, ...page.map((thread) => this.transcript(thread, BATCH_MESSAGE_CHARS))].join('\n\n'), count: page.length, total: matches.length };
  }

  private transcript(thread: Thread, maxChars: number): string {
    const { lead } = thread;
    const lines = [
      `### ${linkOf(lead)} · ${lead.company.name || 'Firma unbekannt'} · ${lead.person.position || lead.person.headline || ''} · ${categoryOf(lead)}${lead.score ? ` · Score ${lead.score.total}` : ''} · Stufe ${LEAD_STAGE_LABELS[lead.stage as LeadStage]} · ${defaultFounderName(lead.owner)}`,
    ];
    const milestones: string[] = [];
    if (thread.invitedAt) milestones.push(`Anfrage ${day(thread.invitedAt)}${thread.inviteNote ? ` mit Notiz: „${oneLine(clip(thread.inviteNote, 400))}“` : ' ohne Notiz'}`);
    if (thread.acceptedAt) milestones.push(`angenommen ${day(thread.acceptedAt)}`);
    if (thread.meetingAt) milestones.push(`Termin vereinbart ${day(thread.meetingAt)}`);
    if (lead.stage === 'lost' && thread.lostAt) milestones.push(`verloren ${day(thread.lostAt)}`);
    if (lead.conversation?.replyIntent) milestones.push(`Einschätzung: ${lead.conversation.replyIntent}`);
    if (milestones.length) lines.push(milestones.join(' · '));
    for (const message of thread.messages) {
      const text = oneLine(clip(message.text, maxChars));
      lines.push(message.dir === 'out' ? `→ #${message.position}${message.label ? ` ${message.label}` : ''} · ${when(message.at)}: ${text}` : `← ${when(message.at)}: ${text}`);
    }
    return lines.join('\n');
  }

  // ── Suche ───────────────────────────────────────────────────────────────

  /** Volltext über alle Nachrichten und Anfrage-Notizen: alle Wörter müssen vorkommen (Groß-/Kleinschreibung egal). */
  searchMessages(scope: AuthFounderId[] | null, query: string, limit = 20): string {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 'Bitte Suchwörter angeben.';
    const hits: string[] = [];
    let total = 0;
    for (const thread of this.threads(scope).sort((a, b) => b.lead.lastActivityAt - a.lead.lastActivityAt)) {
      const texts = [...thread.messages.map((message) => ({ message, text: message.text })), ...(thread.inviteNote ? [{ message: null, text: thread.inviteNote }] : [])];
      const found = texts.find((entry) => words.every((word) => entry.text.toLowerCase().includes(word)));
      if (!found) continue;
      total += 1;
      if (hits.length >= Math.min(SEARCH_MAX_LIMIT, limit)) continue;
      const index = found.text.toLowerCase().indexOf(words[0]);
      const snippet = oneLine(found.text.slice(Math.max(0, index - 120), index + 240));
      const where = found.message ? `${found.message.dir === 'out' ? 'eigene Nachricht' : 'Antwort'} vom ${day(found.message.at)}` : 'Notiz zur Anfrage';
      hits.push(`- ${linkOf(thread.lead)} · ${thread.lead.company.name} · Stufe ${LEAD_STAGE_LABELS[thread.lead.stage]} · ${where}: „…${snippet}…“`);
    }
    if (!total) return `Keine Nachricht mit „${query}“ gefunden.`;
    return [`${total} ${total === 1 ? 'Lead' : 'Leads'} mit „${query}“${total > hits.length ? ` (die ${hits.length} neuesten)` : ''}:`, ...hits].join('\n');
  }

  /** Leads nach Name, Firma, Position (wie die Suche in der Leads-Ansicht), optional Stufe und Kategorie. */
  findLeads(scope: AuthFounderId[] | null, options: { query?: string; stage?: LeadStage | null; category?: LeadCategory | null; limit?: number }): string {
    const owners = scope ?? [...AUTH_FOUNDER_IDS];
    const limit = Math.min(FIND_MAX_LIMIT, Math.max(1, options.limit ?? 30));
    const found = owners
      .flatMap((owner) =>
        this.leads.list({
          owner,
          query: options.query,
          stages: options.stage ? [options.stage] : undefined,
          categories: options.category ? [options.category] : undefined,
          sort: 'recent',
          limit: 1_000_000,
        }).leads,
      )
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    if (!found.length) return 'Keine passenden Leads.';
    const lines = found
      .slice(0, limit)
      .map((lead) => `- ${linkOf(lead)} · ${lead.company.name} · ${lead.person.position || lead.person.headline} · ${categoryOf(lead)} · Stufe ${LEAD_STAGE_LABELS[lead.stage]} · zuletzt aktiv ${day(lead.lastActivityAt)} · ${defaultFounderName(lead.owner)}`);
    return [`${found.length} ${found.length === 1 ? 'Lead' : 'Leads'}${found.length > limit ? ` (die ${limit} zuletzt aktiven)` : ''}:`, ...lines].join('\n');
  }

  /** Ein Lead komplett: Profil, Einschätzung, Score, ganzer Verlauf ungekürzt. null = nicht im Sichtbereich. */
  leadDetail(scope: AuthFounderId[] | null, id: string): string | null {
    const lead = this.leads.get(id);
    if (!lead || (scope && !scope.includes(lead.owner))) return null;
    const thread = this.threads([lead.owner]).find((entry) => entry.lead.id === id)!;
    const lines = [
      this.transcript(thread, 20_000).split('\n')[0],
      `Profil: ${lead.person.headline} · ${lead.person.location ?? 'Ort unbekannt'} · Website ${lead.company.website ?? '–'} · LinkedIn ${lead.person.profileUrl ?? '–'}`,
      lead.assessment ? `KI-Einstufung: ${CATEGORY_LABELS[lead.assessment.category]} – ${lead.assessment.reason} ${lead.assessment.summary}` : 'Keine KI-Einstufung.',
      lead.nextStep ? `Nächster Schritt: ${lead.nextStep}` : '',
      lead.conversation?.summary ? `Zusammenfassung des Gesprächs: ${lead.conversation.summary}` : '',
      '',
      'Verlauf:',
      ...this.leads.events(id).map((event) => `- ${when(event.at)} · ${event.title}${event.text ? `: ${oneLine(event.text)}` : ''}`),
    ];
    return lines.filter((line) => line !== '').join('\n');
  }
}
