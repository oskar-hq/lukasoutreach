import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUTH_FOUNDER_IDS, defaultFounderName, type AuthFounderId, type AuthUser } from '../../../shared/auth.js';
import { LEAD_CATEGORIES } from '../../../shared/leadSearch.js';
import { LEAD_STAGES, LEAD_STAGE_LABELS, type CockpitLead, type LeadDetailResponse } from '../../../shared/leads.js';
import type { LinkedInStatusResponse } from '../../../shared/linkedin.js';
import { MCP_LEAD_PARAM } from '../../../shared/mcp.js';
import type { TemplatesResponse } from '../../../shared/messages.js';
import { TASK_TYPE_LABELS, type TasksResponse } from '../../../shared/tasks.js';
import { CONVERSATIONS_MAX_LIMIT, type AssistantData } from '../assistant/data.js';
import { internalAuthHeaders } from '../auth/auth.js';
import { SETTINGS_INSTRUCTIONS, registerSettingsTools } from './settingsTools.js';

/**
 * Werkzeuge des MCP-Servers (Vertrag `shared/mcp.ts`) für ein angemeldetes Konto. Lesen wie der KI-Assistent
 * (`assistant/data.ts`); Aufgaben und Aktionen über dieselben Routen wie die Oberfläche (`app.inject` im Namen des
 * Kontos) – damit gelten Rechte, Tageslimits, Arbeitszeiten, Pausen und Dubletten-Schutz unverändert.
 */

export interface McpContext {
  app: FastifyInstance;
  user: AuthUser;
  /** Wessen Leads das Konto sehen darf (null = alle). */
  scope: AuthFounderId[] | null;
  data: AssistantData;
  /** Adresse des Cockpits für Lead-Links, z. B. https://lukas.ylvalabs.de */
  baseUrl: string;
}

const INSTRUCTIONS = `Outreach-Cockpit eines kleinen Teams, das über LinkedIn Kapitalanlage-Vertriebe und Finanzdienstleister anschreibt (früher auch Bauträger). Ablauf je Lead: Vernetzungsanfrage → Erstnachricht → Follow-ups → Antwort → Termin.
Du kannst alles lesen (Gespräche, Auswertungen, Leads) und das Cockpit bedienen: Aufgaben von heute (todays_tasks) abarbeiten, Anfragen und Nachrichten senden, Antworten eintragen, Termine, Wiedervorlagen, Verloren.
Arbeitsweise bei Aufgaben: erst lead_detail lesen, für Erstnachrichten und Follow-ups die passende Vorlage (list_templates) nehmen und Platzhalter wie {{vorname}} selbst füllen. Vor jedem Senden den Text dem Nutzer zeigen, außer er hat ausdrücklich gesagt, ohne Rückfrage zu senden. Gesendet wird über den LinkedIn-Account des Lead-Besitzers; ist echtes Senden aus, wird nur eingetragen – dann sag dem Nutzer, dass er selbst auf LinkedIn senden muss.
Antworte auf Deutsch, per du. Leads als Markdown-Link wie in den Ergebnissen.
${SETTINGS_INSTRUCTIONS}`;

const leadId = z.string().trim().min(1).max(64).describe('ID des Leads (aus den Ergebnissen, „lead_id“)');

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
/** Sendet auf LinkedIn – nicht rückgängig zu machen. */
const SEND = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'outreach-cockpit', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const { app, user, scope, data, baseUrl } = ctx;

  /** Lead-Links der Datenschicht (`lead:<id>`) auf Adressen im Cockpit umschreiben – klickbar in der Claude-App. */
  const links = (text: string) => text.replace(/\]\(lead:([^)\s]+)\)/g, (_match, id: string) => `](${baseUrl}/?${MCP_LEAD_PARAM}=${encodeURIComponent(id)}) (lead_id: ${id})`);
  const linkOf = (lead: CockpitLead) => `[${lead.person.firstName} ${lead.person.lastName}](${baseUrl}/?${MCP_LEAD_PARAM}=${encodeURIComponent(lead.id)})`;

  /** Route des Cockpits im Namen des Kontos aufrufen. */
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object): Promise<{ ok: true; body: T } | { ok: false; message: string }> => {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}), headers: internalAuthHeaders(user.username) });
    const body = response.json() as T & { error?: { message?: string } | string };
    if (response.statusCode >= 400) {
      const error = typeof body?.error === 'object' ? body.error?.message : undefined;
      return { ok: false, message: error ?? `Fehler ${response.statusCode}` };
    }
    return { ok: true, body };
  };
  const leadPath = (id: string, suffix = '') => `/api/leads/${encodeURIComponent(id)}${suffix}`;
  const after = (detail: LeadDetailResponse, what: string) => `${what}: ${linkOf(detail.lead)} – jetzt in „${LEAD_STAGE_LABELS[detail.lead.stage]}“.`;

  // ── Lesen ───────────────────────────────────────────────────────────────

  server.registerTool(
    'todays_tasks',
    {
      title: 'Aufgaben von heute',
      description:
        'Was heute ansteht (wie der Tagesstapel im Cockpit): Antworten, fällige Follow-ups, Erstnachrichten, neue Leads zum Vernetzen, dazu „Braucht Aufmerksamkeit“. Jede Aufgabe mit lead_id und Grund.',
      inputSchema: { scope: z.enum(['mine', 'all']).optional().describe('mine = eigene Aufgaben (Standard), all = beide Gründer') },
      annotations: READ,
    },
    async ({ scope: which }) => {
      const owner = which === 'all' ? 'all' : user.founder;
      const result = await call<TasksResponse>('GET', owner ? `/api/tasks?owner=${owner}` : '/api/tasks');
      if (!result.ok) return fail(result.message);
      const { tasks, attention, accountPaused } = result.body;
      const lines = [`# Aufgaben (${owner === 'all' ? 'beide Gründer' : owner ? defaultFounderName(owner) : 'alle'})`];
      if (accountPaused?.length) lines.push(`Pausiert (LinkedIn-Account nicht verbunden): ${accountPaused.map(defaultFounderName).join(', ')}`);
      if (!tasks.length) lines.push('Nichts offen – alles erledigt.');
      for (const type of ['reply', 'followup', 'first', 'lead'] as const) {
        const ofType = tasks.filter((task) => task.type === type);
        if (!ofType.length) continue;
        lines.push('', `## ${TASK_TYPE_LABELS[type]} (${ofType.length})`);
        for (const task of ofType) {
          const lead = task.lead;
          lines.push(
            `- ${linkOf(lead)} · ${lead.company.name} · ${task.reason}${task.followUpNumber ? ` · Follow-up ${task.followUpNumber}` : ''} · Besitzer ${defaultFounderName(lead.owner)} (lead_id: ${lead.id})`,
          );
        }
      }
      if (attention.length) {
        lines.push('', `## Braucht Aufmerksamkeit (${attention.length})`);
        for (const item of attention) lines.push(`- ${linkOf(item.lead)} · ${item.detail} (lead_id: ${item.lead.id})`);
      }
      return ok(lines.join('\n'));
    },
  );

  server.registerTool(
    'outreach_analysis',
    {
      title: 'Outreach-Auswertung',
      description:
        'Vorab gerechnete Auswertung über alle Leads: Trichter, erste Antwort je Position in der Sequenz (Erstnachricht, 2., 3. Nachricht …), je Vorlage, Länge, Frage am Ende, Wochentag, Uhrzeit, Kategorie, Gründer. Das Warum steht in den Gesprächen (read_conversations).',
      annotations: READ,
    },
    async () => ok(links(data.analysis(scope))),
  );

  server.registerTool(
    'read_conversations',
    {
      title: 'Gespräche lesen',
      description: `Ganze Gesprächsverläufe vieler Leads auf einmal (beide Richtungen, Position in der Sequenz, Vorlage, Zeitpunkte, Ergebnis), neueste zuerst. Bis ${CONVERSATIONS_MAX_LIMIT} je Aufruf, blättern mit offset.`,
      inputSchema: {
        outcome: z.enum(['all', 'replied', 'no_reply', 'interested', 'not_interested', 'meeting', 'lost']).optional(),
        category: z.enum(LEAD_CATEGORIES).optional(),
        owner: z.enum(AUTH_FOUNDER_IDS).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(CONVERSATIONS_MAX_LIMIT).optional(),
      },
      annotations: READ,
    },
    async (input) => ok(links(data.conversations(scope, input).text)),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Nachrichten durchsuchen',
      description: 'Volltextsuche über alle Nachrichten (beide Richtungen) und Anfrage-Notizen. Alle Wörter müssen vorkommen.',
      inputSchema: { query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).optional() },
      annotations: READ,
    },
    async ({ query, limit }) => ok(links(data.searchMessages(scope, query, limit))),
  );

  server.registerTool(
    'find_leads',
    {
      title: 'Leads suchen',
      description: 'Leads nach Name, Firma oder Position, optional nach Stufe und Kategorie.',
      inputSchema: {
        query: z.string().trim().max(200).optional(),
        stage: z.enum(LEAD_STAGES).optional(),
        category: z.enum(LEAD_CATEGORIES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    async (input) => ok(links(data.findLeads(scope, input))),
  );

  server.registerTool(
    'lead_detail',
    {
      title: 'Lead im Detail',
      description: 'Ein Lead komplett: Profil, KI-Einstufung, Zusammenfassung, ganzer Verlauf ungekürzt.',
      inputSchema: { lead_id: leadId },
      annotations: READ,
    },
    async ({ lead_id }) => {
      const detail = data.leadDetail(scope, lead_id);
      return detail ? ok(links(detail)) : fail('Diesen Lead gibt es nicht (oder er gehört nicht zu deinen Gründern).');
    },
  );

  server.registerTool(
    'list_templates',
    {
      title: 'Vorlagen',
      description: 'Nachrichten-Vorlagen des Teams (Erstnachrichten Greenfield/Reactivation, Follow-ups je Stufe, Notiz zur Anfrage) mit ID und Text. Platzhalter wie {{vorname}} selbst füllen.',
      annotations: READ,
    },
    async () => {
      const result = await call<TemplatesResponse>('GET', '/api/templates');
      if (!result.ok) return fail(result.message);
      return ok(result.body.templates.map((template) => `### ${template.id} · ${template.name}${template.stage ? ` (Follow-up ${template.stage})` : ''}\n${template.description}\n\n${template.text}`).join('\n\n'));
    },
  );

  server.registerTool(
    'linkedin_status',
    {
      title: 'LinkedIn-Status',
      description: 'Ob das Cockpit echt über LinkedIn sendet oder nur einträgt, Arbeitszeit, Tageslimits und Pausen je Gründer.',
      annotations: READ,
    },
    async () => {
      const result = await call<LinkedInStatusResponse>('GET', '/api/linkedin/status');
      if (!result.ok) return fail(result.message);
      const status = result.body;
      const lines = [
        `Senden: ${status.mode === 'off' ? 'aus – Aktionen werden nur eingetragen, gesendet wird von Hand auf LinkedIn' : status.mode === 'mock' ? 'Simulation' : 'echt über LinkedIn'}`,
        `Arbeitszeit: ${status.workHours.fromHour}–${status.workHours.toHour} Uhr (${status.withinWorkHours ? 'gerade innerhalb' : 'gerade außerhalb – echtes Senden geht erst wieder in der Arbeitszeit'})`,
        ...status.accounts.map(
          (account) =>
            `- ${defaultFounderName(account.founder)}: ${account.connected ? 'verbunden' : 'kein Account'} · Anfragen heute ${account.invitesToday.used}/${account.invitesToday.limit} · Nachrichten heute ${account.messagesToday.used}/${account.messagesToday.limit}${account.pausedUntil ? ` · pausiert: ${account.pauseReason ?? ''}` : ''}`,
        ),
      ];
      return ok(lines.join('\n'));
    },
  );

  // ── Bedienen ────────────────────────────────────────────────────────────

  /** Echt über LinkedIn senden, wenn das Cockpit sendet und der Account verbunden ist – sonst nur eintragen. */
  const sendsFor = async (founder: AuthFounderId): Promise<boolean> => {
    const status = await call<LinkedInStatusResponse>('GET', '/api/linkedin/status');
    if (!status.ok || status.body.mode === 'off') return false;
    return !!status.body.accounts.find((account) => account.founder === founder)?.connected;
  };
  const loadLead = async (id: string) => call<LeadDetailResponse>('GET', leadPath(id));

  server.registerTool(
    'send_connection_request',
    {
      title: 'Vernetzungsanfrage senden',
      description:
        'Vernetzungsanfrage an einen neuen Lead – über den LinkedIn-Account des Besitzers, wenn das Cockpit echt sendet (sonst nur eingetragen). Optional mit Notiz (Vorlage der Art „Notiz zur Anfrage“).',
      inputSchema: {
        lead_id: leadId,
        note: z.string().trim().max(300).optional().describe('Notiz zur Anfrage (höchstens 300 Zeichen, LinkedIn-Grenze)'),
        only_record: z.boolean().optional().describe('true = nur eintragen (schon von Hand auf LinkedIn gesendet)'),
      },
      annotations: SEND,
    },
    async ({ lead_id, note, only_record }) => {
      const lead = await loadLead(lead_id);
      if (!lead.ok) return fail(lead.message);
      const clientId = randomUUID();
      const real = !only_record && (await sendsFor(lead.body.lead.owner));
      const result = real
        ? await call<LeadDetailResponse>('POST', leadPath(lead_id, '/linkedin/invite'), { ...(note ? { message: note } : {}), clientId })
        : await call<LeadDetailResponse>('POST', leadPath(lead_id, '/events'), { action: 'invite_sent', ...(note ? { text: note } : {}), clientId });
      if (!result.ok) return fail(result.message);
      return ok(`${after(result.body, real ? 'Vernetzungsanfrage über LinkedIn gesendet' : 'Vernetzungsanfrage eingetragen')}${real ? '' : ` Nicht über LinkedIn gesendet – bitte selbst senden: ${lead.body.lead.person.profileUrl ?? 'Profil im Cockpit'}`}`);
    },
  );

  server.registerTool(
    'send_message',
    {
      title: 'Nachricht senden',
      description:
        'Nachricht an einen Lead: Erstnachricht (Stufe Vernetzt), Follow-up (Angeschrieben) oder Antwort im Gespräch (Antwort/Termin). Geht über den LinkedIn-Account, über den vernetzt wurde, wenn das Cockpit echt sendet – sonst nur eingetragen. template_id = verwendete Vorlage (z. B. G1, F2A) für die Auswertung.',
      inputSchema: {
        lead_id: leadId,
        text: z.string().trim().min(1).max(8000),
        template_id: z.string().trim().max(40).optional(),
        only_record: z.boolean().optional().describe('true = nur eintragen (schon von Hand auf LinkedIn gesendet)'),
      },
      annotations: SEND,
    },
    async ({ lead_id, text, template_id, only_record }) => {
      const lead = await loadLead(lead_id);
      if (!lead.ok) return fail(lead.message);
      const sender = lead.body.lead.linkedin?.sentBy ?? lead.body.lead.owner;
      const clientId = randomUUID();
      const real = !only_record && (await sendsFor(sender));
      const label = template_id ? { label: template_id } : {};
      const result = real
        ? await call<LeadDetailResponse>('POST', leadPath(lead_id, '/linkedin/message'), { text, ...label, clientId })
        : await call<LeadDetailResponse>('POST', leadPath(lead_id, '/events'), { action: 'message_sent', text, ...label, clientId });
      if (!result.ok) return fail(result.message);
      return ok(`${after(result.body, real ? 'Nachricht über LinkedIn gesendet' : 'Nachricht eingetragen')}${real ? '' : ' Nicht über LinkedIn gesendet – bitte selbst senden.'}`);
    },
  );

  const simple = (
    name: string,
    title: string,
    description: string,
    build: (input: { lead_id: string; text?: string }) => object,
    what: string,
    withText?: { required: boolean; describe: string },
  ) =>
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: withText
          ? { lead_id: leadId, text: withText.required ? z.string().trim().min(1).max(8000).describe(withText.describe) : z.string().trim().max(2000).optional().describe(withText.describe) }
          : { lead_id: leadId },
        annotations: WRITE,
      },
      async (input: { lead_id: string; text?: string }) => {
        const result = await call<LeadDetailResponse>('POST', leadPath(input.lead_id, '/events'), { ...build(input), clientId: randomUUID() });
        return result.ok ? ok(after(result.body, what)) : fail(result.message);
      },
    );

  simple('record_reply', 'Antwort eintragen', 'Antwort des Leads eintragen (z. B. von LinkedIn kopiert, falls der Abgleich sie noch nicht geholt hat).', ({ text }) => ({ action: 'message_received', text }), 'Antwort eingetragen', {
    required: true,
    describe: 'Text der Antwort',
  });
  simple('book_meeting', 'Termin vereinbart', 'Lead nach „Termin“: Ein Termin ist ausgemacht.', () => ({ action: 'meeting_booked' }), 'Termin eingetragen');
  simple('mark_lost', 'Verloren', 'Lead als verloren markieren (kein Interesse, passt nicht).', ({ text }) => ({ action: 'lost', ...(text ? { text } : {}) }), 'Als verloren markiert', {
    required: false,
    describe: 'Grund (optional)',
  });
  simple('add_note', 'Notiz', 'Notiz in den Verlauf des Leads schreiben.', ({ text }) => ({ action: 'note', text }), 'Notiz gespeichert', { required: true, describe: 'Notiz' });
  simple('reopen_lead', 'Wieder öffnen', 'Verlorenen oder übergebenen Lead wieder öffnen.', () => ({ action: 'reopened' }), 'Wieder geöffnet');

  server.registerTool(
    'skip_today',
    { title: 'Heute überspringen', description: 'Lead für heute aus den Aufgaben nehmen (morgen wieder da).', inputSchema: { lead_id: leadId }, annotations: WRITE },
    async ({ lead_id }) => {
      const result = await call<LeadDetailResponse>('POST', leadPath(lead_id, '/snooze'), {});
      return result.ok ? ok(`Für heute übersprungen: ${linkOf(result.body.lead)}.`) : fail(result.message);
    },
  );

  server.registerTool(
    'schedule_follow_up',
    {
      title: 'Wiedervorlage',
      description: 'Lead pausieren und an einem Tag wieder in die Aufgaben holen (auch nach allen Follow-ups oder verloren). Entweder date oder in_days.',
      inputSchema: {
        lead_id: leadId,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Tag JJJJ-MM-TT'),
        in_days: z.number().int().min(1).max(366).optional().describe('in so vielen Tagen'),
      },
      annotations: WRITE,
    },
    async ({ lead_id, date, in_days }) => {
      const day = date ?? (in_days ? berlinDate(Date.now() + in_days * 24 * 60 * 60 * 1000) : null);
      if (!day) return fail('Bitte date oder in_days angeben.');
      const at = berlinMorning(day);
      const result = await call<LeadDetailResponse>('PATCH', leadPath(lead_id), { followUpPlan: { at } });
      if (!result.ok) return fail(result.message);
      return ok(`Wiedervorlage für ${linkOf(result.body.lead)} am ${new Date(at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })} – bis dahin pausiert.`);
    },
  );

  server.registerTool(
    'update_lead',
    {
      title: 'Lead ändern',
      description: 'Stufe von Hand setzen, nächsten Schritt, Deal Value (Euro) oder zuständigen Gründer ändern.',
      inputSchema: {
        lead_id: leadId,
        stage: z.enum(LEAD_STAGES).optional(),
        next_step: z.string().trim().max(300).nullable().optional(),
        deal_value: z.number().int().min(0).nullable().optional(),
        owner: z.enum(AUTH_FOUNDER_IDS).optional(),
      },
      annotations: WRITE,
    },
    async ({ lead_id, stage, next_step, deal_value, owner }) => {
      const patch = {
        ...(stage ? { stage } : {}),
        ...(next_step !== undefined ? { nextStep: next_step } : {}),
        ...(deal_value !== undefined ? { dealValue: deal_value } : {}),
        ...(owner ? { owner } : {}),
      };
      if (!Object.keys(patch).length) return fail('Nichts zu ändern angegeben.');
      const result = await call<LeadDetailResponse>('PATCH', leadPath(lead_id), patch);
      return result.ok ? ok(after(result.body, 'Geändert')) : fail(result.message);
    },
  );

  // ── Einstellungen (31.10.) ──────────────────────────────────────────────
  registerSettingsTools(server, call);

  return server;
}

/** „JJJJ-MM-TT“ des Zeitpunkts in deutscher Zeit. */
function berlinDate(at: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(at);
}

/** 8 Uhr deutscher Zeit an diesem Tag (Sommer- und Winterzeit) – wie die Wiedervorlage im Cockpit. */
export function berlinMorning(day: string): number {
  const guess = Date.parse(`${day}T08:00:00Z`);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(guess));
  return guess - (hour - 8) * 60 * 60 * 1000;
}
