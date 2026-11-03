import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { defaultFounderName, type AuthFounderId } from '../../../shared/auth.js';
import type { CrmErrorCode, CrmMode, CrmStatusResponse, LeadCrmState } from '../../../shared/crm.js';
import type { CockpitLead, LeadEvent } from '../../../shared/leads.js';
import { REPLY_INTENT_LABELS } from '../../../shared/messages.js';
import { LEAD_TYPE_LABELS, SCORE_TIER_LABELS } from '../../../shared/scoring.js';
import type { Config } from '../config.js';
import { DuplicateEventError, LeadNotFoundError, assertTransition, type LeadStore } from '../leads/leadStore.js';

/**
 * Übergabe an Close (Vertrag `shared/crm.ts`). Nur dokumentierte Endpunkte der Close-API:
 *   POST /api/v1/lead/            Lead mit verschachtelten Kontakten anlegen (name, url, description, status_id, contacts)
 *   POST /api/v1/activity/note/   Notiz am Lead (lead_id, note)
 * Anmeldung: HTTP Basic mit dem API-Schlüssel als Benutzername und leerem Passwort.
 */

export class CrmError extends Error {
  constructor(
    readonly code: CrmErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;
const shortDate = (at: number) => new Date(at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Notiz für Close: Einschätzung, Score, Notiz des Gründers, Verlauf (gekürzt). Nur Text. */
export function handoverNote(lead: CockpitLead, events: LeadEvent[], extra: string | undefined, founderName: string): string {
  const lines = [`Übergeben aus dem Outreach-Cockpit von ${founderName} am ${shortDate(Date.now())}.`];
  if (extra?.trim()) lines.push('', `Notiz: ${extra.trim()}`);
  if (lead.conversation) {
    lines.push('', `Einschätzung der Antwort: ${REPLY_INTENT_LABELS[lead.conversation.replyIntent]} – ${lead.conversation.replySummary}`);
    lines.push(`Verlauf: ${lead.conversation.summary}`);
  }
  if (lead.score) lines.push('', `Score: ${SCORE_TIER_LABELS[lead.score.tier]} · ${LEAD_TYPE_LABELS[lead.score.leadType]}`);
  if (lead.assessment) lines.push(`KI-Einschätzung der Firma: ${lead.assessment.summary}`);
  if (lead.enrichment?.status === 'done' && lead.enrichment.employeesRange) lines.push(`Mitarbeiter: ${lead.enrichment.employeesRange}`);
  if (lead.nextStep) lines.push(`Nächster Schritt: ${lead.nextStep}`);
  const messages = events.filter((event) => (event.kind === 'message_sent' || event.kind === 'message_received') && event.text).slice(-10);
  if (messages.length) {
    lines.push('', 'Nachrichten auf LinkedIn:');
    for (const event of messages) {
      lines.push(`— ${event.kind === 'message_sent' ? founderName : lead.person.firstName}, ${shortDate(event.at)}: ${clip(event.text!.replace(/\s+/g, ' ').trim(), 800)}`);
    }
  }
  return lines.join('\n');
}


export interface CrmDeps {
  config: Config;
  leads: LeadStore;
  log: FastifyBaseLogger;
  /** Name eines Gründers in der Notiz (aus seinem Konto), ohne Angabe „Nick“/„Johannes“. */
  founderName?: (id: AuthFounderId) => string;
  fetch?: typeof fetch;
}

export class CrmService {
  constructor(private readonly deps: CrmDeps) {}

  /** Aus der laufenden Konfiguration – Einstellungen wirken ohne Neustart. */
  get mode(): CrmMode {
    const { config } = this.deps;
    if (config.mode === 'mock') return 'mock';
    return config.close.apiKey ? 'live' : 'off';
  }

  status(): CrmStatusResponse {
    return { provider: 'close', mode: this.mode, handover: this.deps.config.close.handover };
  }

  async handover(
    leadId: string,
    by: AuthFounderId | null,
    request: { note?: string; clientId?: string },
    actor: string | null,
  ): Promise<CockpitLead> {
    const mode = this.mode;
    if (!this.deps.config.close.handover) {
      throw new CrmError('crm_off', 409, 'Die Übergabe an Close ist ausgeschaltet – einschalten unter Einstellungen → CRM und Slack → „An Close übergeben“.');
    }
    if (mode === 'off') {
      throw new CrmError('crm_off', 409, 'Close ist nicht eingerichtet – trag den API-Schlüssel unter Einstellungen → CRM (Close) ein.');
    }
    const lead = this.deps.leads.get(leadId);
    if (!lead) throw new LeadNotFoundError();
    if (request.clientId && this.deps.leads.hasClientEvent(leadId, request.clientId)) throw new DuplicateEventError();
    // Vor dem Anlegen in Close prüfen, ob die Übergabe zur Stufe passt (sonst entstünde ein Lead in Close umsonst).
    assertTransition(lead, 'handed_over');
    const founder = by ?? lead.owner;

    // Schon in Close (z. B. Übergabe vorher an der Stufenänderung gescheitert, oder wieder geöffnet und erneut übergeben):
    // nicht noch einmal anlegen – die neue Notiz kommt trotzdem an den bestehenden Close-Lead.
    let crm = lead.crm ?? null;
    if (!crm || (mode === 'live' && crm.externalId.startsWith('mock-close-'))) {
      crm = mode === 'live' ? await this.createInClose(lead) : { provider: 'close', externalId: `mock-close-${randomUUID().slice(0, 8)}`, url: null, handedOverAt: Date.now() };
      this.deps.leads.setCrm(leadId, crm);
    }
    let noteOk = true;
    if (mode === 'live') {
      noteOk = await this.addNote(crm.externalId, handoverNote(lead, this.deps.leads.events(leadId), request.note, this.deps.founderName?.(founder) ?? defaultFounderName(founder)));
    }
    this.deps.log.info({ leadId, closeLead: crm.externalId, mode }, 'Lead an Close übergeben');
    return this.deps.leads.applyAction(
      leadId,
      { action: 'handed_over', text: request.note?.trim() || undefined, ...(request.clientId ? { clientId: request.clientId } : {}) },
      founder,
      Date.now(),
      undefined,
      actor,
      noteOk ? 'An Close übergeben' : 'An Close übergeben – Notiz fehlt',
    );
  }

  private async createInClose(lead: CockpitLead): Promise<LeadCrmState> {
    const { person, company } = lead;
    const contact: Record<string, unknown> = { name: `${person.firstName} ${person.lastName}`.trim() };
    if (person.position) contact.title = person.position;
    if (person.profileUrl) contact.urls = [{ url: person.profileUrl }];
    const body: Record<string, unknown> = { name: company.name, contacts: [contact] };
    if (company.website) body.url = company.website;
    const description = [lead.assessment?.summary, company.region].filter(Boolean).join(' · ');
    if (description) body.description = clip(description, 500);
    if (this.deps.config.close.statusId) body.status_id = this.deps.config.close.statusId;

    const response = await this.call('/api/v1/lead/', body);
    const json = (await response.json().catch(() => null)) as { id?: unknown; html_url?: unknown } | null;
    if (!json || typeof json.id !== 'string' || !json.id) {
      throw new CrmError('crm_unavailable', 503, 'Close hat keine Lead-ID zurückgegeben – bitte später erneut versuchen.');
    }
    const url = typeof json.html_url === 'string' && /^https:\/\//.test(json.html_url) ? json.html_url : null;
    return { provider: 'close', externalId: json.id, url, handedOverAt: Date.now() };
  }

  /** Notiz anhängen – scheitert sie, bleibt die Übergabe gültig (nur Hinweis im Verlauf). */
  private async addNote(closeLeadId: string, note: string): Promise<boolean> {
    try {
      await this.call('/api/v1/activity/note/', { lead_id: closeLeadId, note });
      return true;
    } catch (error) {
      this.deps.log.warn({ closeLead: closeLeadId, err: error instanceof Error ? error.message : String(error) }, 'Notiz in Close fehlgeschlagen');
      return false;
    }
  }

  private async call(path: string, body: unknown): Promise<Response> {
    const { config } = this.deps;
    const doFetch = this.deps.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${config.close.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Basic mit dem Schlüssel als Benutzername und leerem Passwort (laut Close-Doku).
          Authorization: `Basic ${Buffer.from(`${config.close.apiKey ?? ''}:`).toString('base64')}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new CrmError('crm_unavailable', 503, 'Close ist nicht erreichbar – bitte später erneut versuchen.');
    }
    if (response.ok) return response;
    if (response.status === 401 || response.status === 403) {
      throw new CrmError('crm_auth', 502, 'Close lehnt den API-Schlüssel ab – bitte unter Einstellungen → CRM (Close) prüfen.');
    }
    if (response.status === 429) {
      const retryAfter = Math.max(1, Math.ceil(Number(response.headers.get('retry-after')) || 30));
      throw new CrmError('crm_rate_limited', 429, 'Close meldet zu viele Anfragen – bitte gleich noch einmal versuchen.', retryAfter);
    }
    if (response.status === 400) {
      // Feldfehler (z. B. falsche Status-ID) – Antworttext fremder Server nicht durchreichen.
      throw new CrmError('crm_unavailable', 503, `Close lehnt die Daten ab (HTTP 400) – Status-ID unter Einstellungen → CRM (Close) prüfen.`);
    }
    throw new CrmError('crm_unavailable', 503, `Close antwortet unerwartet (HTTP ${response.status}) – bitte später erneut versuchen.`);
  }
}
