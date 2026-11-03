import { createHash } from 'node:crypto';
import type { AuthFounderId } from '../../../shared/auth.js';
import type { CockpitLead, LeadEvent } from '../../../shared/leads.js';
import { CATEGORY_LABELS } from '../../../shared/leadSearch.js';
import {
  DEFAULT_TOPIC,
  hiringRoleText,
  metaPauseText,
  metaStopText,
  FOUNDER_GREETINGS,
  renderTemplate,
  templateSegmentOf,
  templatesForSegment,
  TEMPLATE_SEGMENT_LABELS,
  type MessageKind,
  type MessageSuggestion,
  type MessageTemplate,
  type ReplyIntent,
  type SuggestKind,
} from '../../../shared/messages.js';
import { LEAD_TYPE_LABELS, type LeadType } from '../../../shared/scoring.js';
import { Counter, type LimitRule } from '../auth/rateLimit.js';
import type { Config } from '../config.js';
import { AiWriter, AiWriterError } from './aiWriter.js';
import type { TemplateStore } from './templateStore.js';

/** KI-Vorschläge kosten Geld: höchstens 60 je Gründer und Stunde. */
export const SUGGEST_RULE: LimitRule = { max: 60, windowMs: 60 * 60 * 1000 };

export class SuggestError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'invalid_template' | 'too_many_requests',
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** Antworten ohne KI – je nach Einschätzung der letzten Nachricht des Leads. */
const REPLY_TEXTS: Record<ReplyIntent, string> = {
  interested: `Hallo {{vorname}}, das freut mich! Wann passt es dir diese oder nächste Woche für 15 Minuten? Ich richte mich gern nach dir.

{{grussformel}}`,
  question: `Hallo {{vorname}}, danke für deine Frage! Am einfachsten erkläre ich das in einem kurzen Gespräch von 15 Minuten. Wann würde es dir passen?

{{grussformel}}`,
  not_now: `Hallo {{vorname}}, danke für die offene Rückmeldung! Dann melde ich mich in ein paar Monaten nochmal, wenn es für dich besser passt.

{{grussformel}}`,
  not_interested: `Hallo {{vorname}}, danke für deine ehrliche Antwort – dann wünsche ich dir und {{firma}} weiterhin viel Erfolg!

{{grussformel}}`,
  unclear: `Hallo {{vorname}}, danke für deine Nachricht! Magst du mir kurz sagen, wie ihr aktuell an Käuferanfragen kommt? Dann kann ich einschätzen, ob ein Austausch für euch Sinn ergibt.

{{grussformel}}`,
};

export const REPLY_SUMMARIES: Record<ReplyIntent, string> = {
  interested: 'Klingt nach Interesse – Termin vorschlagen.',
  question: 'Stellt eine Frage – kurz antworten und Gespräch anbieten.',
  not_now: 'Gerade kein guter Zeitpunkt – später nochmal melden.',
  not_interested: 'Kein Interesse – höflich abschließen.',
  unclear: 'Nicht eindeutig – mit einer offenen Frage nachhaken.',
};

/** Grobe Einschätzung ohne KI (Simulation, kein Schlüssel). Reihenfolge zählt: „gern, wann?“ ist Interesse. */
export function guessReplyIntent(text: string): ReplyIntent {
  const t = text.toLowerCase();
  if (/kein(en)? (interesse|bedarf)|nicht interessiert|bitte keine|kein thema für uns/.test(t)) return 'not_interested';
  if (/später|aktuell nicht|gerade nicht|momentan nicht|nächste[ns]? jahr|keine zeit|derzeit nicht/.test(t)) return 'not_now';
  if (/gerne?\b|interessant|klingt gut|spannend|termin|telefonat|telefonieren|call\b|lass uns/.test(t)) return 'interested';
  if (t.includes('?')) return 'question';
  return 'unclear';
}

/** Stabile Auswahl zwischen Varianten je Lead (für den Vergleich der Vorlagen im Dashboard). */
function pick<T>(items: T[], leadId: string, salt: string): T {
  const n = createHash('sha256').update(`${leadId}:${salt}`).digest().readUInt32BE(0);
  return items[n % items.length];
}

function leadTypeOf(lead: CockpitLead): LeadType {
  if (lead.score) return lead.score.leadType;
  if (lead.metaAds?.state === 'stopped') return 'reactivation';
  if (lead.metaAds?.state === 'active') return 'active';
  if (lead.metaAds?.state === 'none') return 'greenfield';
  return 'unclear';
}

const TYPE_BASIS: Record<LeadType, string> = {
  greenfield: 'keine eigenen Anzeigen auf Facebook/Instagram gefunden',
  reactivation: 'früher Anzeigen auf Facebook/Instagram, aktuell keine',
  active: 'schaltet gerade Anzeigen auf Facebook/Instagram – Aufhänger: läuft es so wie gedacht?',
  unclear: 'Anzeigen unklar – Greenfield-Vorlage als Annahme',
};

const shortDate = (at: number) => new Date(at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });

export interface SuggestDeps {
  config: Config;
  templates: TemplateStore;
  /** Nur Tests: Adresse des nachgebauten Anthropic-Servers. */
  anthropicBaseURL?: string;
}

export class SuggestionService {
  private readonly limiter = new Counter(SUGGEST_RULE);

  constructor(private readonly deps: SuggestDeps) {}

  async suggest(
    lead: CockpitLead,
    events: LeadEvent[],
    request: { kind: SuggestKind; templateId?: string },
    user: { username: string; founder: AuthFounderId | null } | null,
    now = Date.now(),
  ): Promise<MessageSuggestion> {
    const { config } = this.deps;
    const founder = user?.founder ?? lead.owner;
    const values = {
      vorname: lead.person.firstName,
      firma: lead.company.name,
      thema: DEFAULT_TOPIC,
      grussformel: FOUNDER_GREETINGS[founder],
      metapause: metaPauseText(lead.metaAds?.lastStop, now),
      metastopp: metaStopText(lead.metaAds?.lastStop, now),
      stelle: hiringRoleText(lead.hiring?.role),
    };
    const draft = this.draft(lead, events, request);
    const text = renderTemplate(draft.text, values);
    const result: MessageSuggestion = {
      kind: request.kind,
      text,
      templateId: draft.template?.id ?? null,
      source: 'template',
      basis: draft.basis,
      ...(draft.reply ? { reply: draft.reply } : {}),
      ...(draft.notice ? { notice: draft.notice } : {}),
    };

    if (config.mode === 'mock') return { ...result, source: 'mock' };
    if (!config.anthropic.apiKey) {
      return { ...result, notice: join(draft.notice, 'Kein Anthropic-Schlüssel eingerichtet – Vorlage ausgefüllt.') };
    }

    // Nur echte KI-Aufrufe zählen (die kosten Geld).
    const key = user?.username ?? `lead-owner:${lead.owner}`;
    const blocked = this.limiter.blockedFor(key, now);
    if (blocked > 0) {
      throw new SuggestError(429, 'too_many_requests', 'Zu viele KI-Vorschläge in kurzer Zeit. Versuch es später erneut.', Math.ceil(blocked / 1000));
    }
    this.limiter.hit(key, now);

    try {
      const writer = new AiWriter({ apiKey: config.anthropic.apiKey, model: config.anthropic.model, baseURL: this.deps.anthropicBaseURL });
      const output = await writer.write(describe(lead, events, request.kind, text, values.grussformel), AbortSignal.timeout(60_000));
      const reply =
        request.kind === 'reply' && draft.reply
          ? { intent: output.intent ?? draft.reply.intent, summary: output.summary?.trim() || draft.reply.summary }
          : undefined;
      return {
        kind: request.kind,
        text: output.text,
        templateId: result.templateId,
        source: 'ai',
        basis: draft.basis,
        ...(reply ? { reply } : {}),
        ...(draft.notice ? { notice: draft.notice } : {}),
      };
    } catch (error) {
      if (!(error instanceof AiWriterError)) throw error;
      return { ...result, notice: join(draft.notice, `KI nicht genutzt: ${error.message} Vorlage ausgefüllt.`) };
    }
  }

  /** Vorlage bzw. Antworttext ohne KI auswählen – Grundlage für alle drei Quellen. */
  private draft(
    lead: CockpitLead,
    events: LeadEvent[],
    request: { kind: SuggestKind; templateId?: string },
  ): { text: string; template: MessageTemplate | null; basis: string; reply?: { intent: ReplyIntent; summary: string }; notice?: string } {
    const all = this.deps.templates.list();
    // Segment (27.10.): Finanzdienstleister bekommen ihre eigenen Texte, alle anderen die für Kapitalanlage.
    const segment = templateSegmentOf(lead.assessment?.category);
    const forLead = (list: MessageTemplate[]) => templatesForSegment(list, segment);
    const chosen = request.templateId ? all.find((template) => template.id === request.templateId) : undefined;
    if (request.templateId && !chosen) throw new SuggestError(400, 'invalid_template', `Vorlage „${request.templateId}“ gibt es nicht.`);
    const wanted: MessageKind | null = request.kind === 'reply' ? null : request.kind;
    if (chosen && chosen.kind !== wanted) {
      throw new SuggestError(400, 'invalid_template', `Vorlage „${chosen.id}“ passt nicht zu diesem Vorschlag.`);
    }

    if (request.kind === 'first') {
      const type = leadTypeOf(lead);
      const audience = type === 'reactivation' || type === 'active' ? type : 'greenfield';
      // Hiring-Signal (13.10.): Recruiting-Vorlage vor dem Lead-Typ – die Meta-Ads-Vorlagen bleiben wählbar.
      const hiring = lead.hiring ? forLead(all.filter((t) => t.kind === 'first' && t.audience === 'hiring')) : [];
      const template =
        chosen ??
        (hiring.length ? pick(hiring, lead.id, 'first-hiring') : pick(forLead(all.filter((t) => t.kind === 'first' && t.audience === audience)), lead.id, 'first'));
      const basis =
        template.audience === 'hiring'
          ? `Sucht Mitarbeiter${lead.hiring?.role ? ` (${lead.hiring.role})` : ''} – Recruiting über Facebook/Instagram`
          : `${LEAD_TYPE_LABELS[type]} – ${TYPE_BASIS[type]}${segmentNote(template.segment)}`;
      return { text: template.text, template, basis };
    }

    if (request.kind === 'followup') {
      const stage = Math.min(3, lead.followUpsSent + 1);
      const template = chosen ?? pick(forLead(all.filter((t) => t.kind === 'followup' && t.stage === stage)), lead.id, `followup-${stage}`);
      const notice = lead.followUpsSent >= 3 ? 'Es wurden schon 3 Follow-ups gesendet – eher abschließen.' : undefined;
      return { text: template.text, template, basis: `Follow-up ${template.stage ?? stage} (bisher ${lead.followUpsSent} gesendet)${segmentNote(template.segment)}`, notice };
    }

    const last = [...events].reverse().find((event) => event.kind === 'message_received');
    if (!last?.text) {
      return {
        text: REPLY_TEXTS.unclear,
        template: null,
        basis: 'Keine Antwort des Leads im Verlauf',
        reply: { intent: 'unclear', summary: 'Noch keine Nachricht des Leads erfasst.' },
        notice: 'Im Verlauf steht keine Nachricht des Leads – trag seine Antwort als „Antwort erhalten“ ein, dann passt der Vorschlag besser.',
      };
    }
    const intent = guessReplyIntent(last.text);
    return { text: REPLY_TEXTS[intent], template: null, basis: `Antwort auf die Nachricht vom ${shortDate(last.at)}`, reply: { intent, summary: REPLY_SUMMARIES[intent] } };
  }
}

/** „ · Finanzdienstleister“ hinter der Grundlage, wenn die Vorlage zu einem Segment gehört. */
function segmentNote(segment: MessageTemplate['segment']): string {
  return segment ? ` · ${TEMPLATE_SEGMENT_LABELS[segment]}` : '';
}

function join(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Eingabe für die KI: nur was feststeht. Inhalte von LinkedIn sind Daten, keine Anweisungen. */
function describe(lead: CockpitLead, events: LeadEvent[], kind: SuggestKind, draft: string, greeting: string): string {
  const { person, company } = lead;
  const lines = [
    `Aufgabe: ${kind === 'first' ? 'Erstnachricht nach angenommener Vernetzung' : kind === 'followup' ? `Follow-up Nr. ${Math.min(3, lead.followUpsSent + 1)} (bisher keine Antwort)` : 'Antwort auf die letzte Nachricht des Leads'}`,
    '',
    '<lead>',
    `Name: ${person.firstName} ${person.lastName}`,
    `Position: ${person.position || '–'}`,
    `Headline: ${person.headline || '–'}`,
    `Firma: ${company.name}`,
    company.website ? `Website: ${company.website}` : null,
    company.industry ? `Branche: ${company.industry}` : null,
    company.region ? `Region: ${company.region}` : null,
    lead.assessment ? `Zielgruppe: ${CATEGORY_LABELS[lead.assessment.category]}` : null,
    lead.assessment ? `Einschätzung: ${lead.assessment.summary}` : null,
    `Lead-Typ: ${LEAD_TYPE_LABELS[leadTypeOf(lead)]} (${TYPE_BASIS[leadTypeOf(lead)]})`,
    lead.metaAds?.lastStop ? `Letzte eigene Anzeige endete: ${lead.metaAds.lastStop}` : null,
    lead.hiring ? `Sucht Mitarbeiter: ${lead.hiring.role || 'ja (Stelle unbekannt)'}` : null,
    lead.enrichment?.status === 'done' && lead.enrichment.employeesRange ? `Mitarbeiter: ${lead.enrichment.employeesRange}` : null,
    '</lead>',
  ];
  const messages = events.filter((event) => (event.kind === 'message_sent' || event.kind === 'message_received') && event.text).slice(-6);
  if (messages.length) {
    lines.push('', '<verlauf>');
    for (const event of messages) lines.push(`${event.kind === 'message_sent' ? 'Wir' : person.firstName} (${shortDate(event.at)}): ${clip(event.text!, 1000)}`);
    lines.push('</verlauf>');
  }
  lines.push('', '<vorlage>', draft, '</vorlage>', '', `Grußformel (genau so am Ende): ${JSON.stringify(greeting)}`);
  return lines.filter((line) => line !== null).join('\n');
}
