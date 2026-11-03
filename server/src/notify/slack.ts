import type { FastifyBaseLogger } from 'fastify';
import { defaultFounderName, type AuthFounderId } from '../../../shared/auth.js';
import type { AppNotification } from '../../../shared/notifications.js';
import type { Config } from '../config.js';
import type { LeadStore } from '../leads/leadStore.js';

/**
 * Slack-Nachricht bei neuer Antwort eines Leads (Vertrag `shared/leads.ts`, Einstellung `SLACK_WEBHOOK_URL`).
 * Slack „Incoming Webhook“: POST mit JSON `{ text }` an die Webhook-Adresse – kostenlos, auch im freien Slack-Plan.
 * Nur live (die Simulation schickt nichts) und nie beim Demo-Reset. Fehler werden nur geloggt.
 */

const INTENT_LABELS: Record<string, string> = {
  interested: 'Interessiert',
  question: 'Hat eine Frage',
  not_now: 'Gerade nicht',
  not_interested: 'Kein Interesse',
  unclear: 'Unklar',
};

/** Slack-Steuerzeichen in fremdem Text entschärfen (laut Slack-Doku: &, <, >). */
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface SlackDeps {
  config: Config;
  leads: LeadStore;
  log: FastifyBaseLogger;
  /** Name eines Gründers (aus seinem Konto), ohne Angabe „Nick“/„Johannes“. */
  founderName?: (id: AuthFounderId) => string;
  fetch?: typeof fetch;
}

export class SlackNotifier {
  private readonly pending = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: SlackDeps) {
    this.unsubscribe = deps.leads.onReply((leadId, { fromReset }) => {
      if (fromReset) return;
      const job = this.notify(leadId).finally(() => this.pending.delete(job));
      this.pending.add(job);
    });
  }

  /**
   * Neuigkeit vom Programm (Vertrag shared/notifications.ts) – nur live mit Webhook, wie die Antworten. Wer etwas
   * beheben muss, steht in der Meldung selbst.
   */
  system(notification: AppNotification): void {
    const { config } = this.deps;
    const webhook = config.slack.webhookUrl;
    if (config.mode !== 'live' || !webhook) return;
    const icon = notification.severity === 'error' ? ':red_circle:' : notification.severity === 'warning' ? ':warning:' : ':information_source:';
    const lines = [`${icon} *${escape(notification.title)}*`, escape(clip(notification.text, 600))];
    if (notification.count > 1) lines.push(`_${notification.count}× seit ${new Date(notification.createdAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })}_`);
    if (config.auth.publicUrl) lines.push(`<${config.auth.publicUrl}|Im Cockpit öffnen>`);
    const job = this.post(webhook, lines.join('\n'), { notification: notification.kind }).finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Nur Tests und Herunterfahren. */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await this.idle();
  }

  private async notify(leadId: string): Promise<void> {
    const { config } = this.deps;
    const webhook = config.slack.webhookUrl;
    if (config.mode !== 'live' || !webhook) return;
    const lead = this.deps.leads.get(leadId);
    if (!lead) return;
    const reply = this.deps.leads.events(leadId).filter((event) => event.kind === 'message_received').at(-1);
    const founder = this.deps.founderName?.(lead.owner) ?? defaultFounderName(lead.owner);
    const lines = [`*Neue Antwort an ${founder}:* ${escape(`${lead.person.firstName} ${lead.person.lastName}`)} (${escape(lead.company.name)})`];
    if (reply?.text) lines.push(`> ${escape(clip(reply.text.replace(/\s+/g, ' ').trim(), 300))}`);
    if (lead.conversation) lines.push(`Einschätzung: ${INTENT_LABELS[lead.conversation.replyIntent] ?? lead.conversation.replyIntent}`);
    if (config.auth.publicUrl) lines.push(`<${config.auth.publicUrl}|Im Cockpit öffnen>`);
    await this.post(webhook, lines.join('\n'), { leadId });
  }

  private async post(webhook: string, text: string, context: Record<string, string>): Promise<void> {
    try {
      const response = await (this.deps.fetch ?? fetch)(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      // Adresse enthält das Geheimnis – nie loggen.
      if (!response.ok) this.deps.log.warn({ ...context, status: response.status }, 'Slack-Nachricht abgelehnt');
    } catch (error) {
      this.deps.log.warn({ ...context, err: error instanceof Error ? error.name : 'Fehler' }, 'Slack nicht erreichbar');
    }
  }
}
