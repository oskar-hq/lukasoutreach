import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthFounderId } from '../../../shared/auth.js';
import type { LeadDetailResponse } from '../../../shared/leads.js';
import {
  LEAD_FIELD_KEY_PATTERN,
  LEAD_FIELD_VALUE_MAX_LENGTH,
  LEAD_IMPORT_MAX_ITEMS,
  type LeadAddResponse,
  type LeadImportResponse,
  type LeadImportStatusResponse,
} from '../../../shared/leadImport.js';
import type { CockpitCall } from './settingsTools.js';

/**
 * Listen-Import per Claude-App (Lukas-Instanz 19.11., Vertrag `shared/leadImport.ts`): Leads aus einer fertigen Liste
 * anlegen – einzeln sofort (`add_lead`), bis 100 auf einmal über die Warteschlange (`import_leads`), Stand
 * (`import_status`) und freie Felder an vorhandenen Leads (`set_lead_fields`).
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export const IMPORT_INSTRUCTIONS =
  'Leads aus einer Liste: einzeln mit add_lead (sofort), viele mit import_leads (bis 100 je Aufruf, Warteschlange hält das Tageslimit für Profilabrufe ein, Rest am nächsten Tag), Fortschritt mit import_status. Importierte Leads haben keine KI-Einstufung und keinen Meta-Check. Freie Felder (z. B. welle, testgruppe, aufhaenger) mit fields bzw. set_lead_fields – stehen in lead_detail, damit du Platzhalter wie {{aufhaenger}} beim Ausfüllen einer Vorlage selbst füllen kannst.';

const fieldsSchema = z
  .record(z.string().regex(LEAD_FIELD_KEY_PATTERN), z.string().max(LEAD_FIELD_VALUE_MAX_LENGTH))
  .describe('Freie Felder, z. B. {"welle": "1", "testgruppe": "B", "aufhaenger": "…"}. Namen klein: a–z, 0–9, _.');
const itemShape = {
  profile: z.string().trim().min(1).max(500).describe('LinkedIn-Profil-Link (https://www.linkedin.com/in/…)'),
  owner: z.string().trim().min(1).max(80).optional().describe('Sender (Name oder ID, z. B. „Lukas“); ohne Angabe das eigene Konto'),
  category: z.string().trim().max(80).optional().describe('Kategorie, z. B. startup_gruender, vc_platform – steht im Feld „kategorie“'),
  note: z.string().trim().max(2000).optional().describe('Notiz in den Verlauf'),
  fields: fieldsSchema.optional(),
};

export function registerImportTools(
  server: McpServer,
  call: CockpitCall,
  resolveOwner: (value: string) => AuthFounderId | null,
  senders: string,
  linkOf: (id: string, label: string) => string,
): void {
  /** Sender aus Name oder ID – wirft mit verständlichem Text, wenn unbekannt. */
  const ownerOf = (value: string | undefined): AuthFounderId | undefined => {
    if (!value) return undefined;
    const owner = resolveOwner(value);
    if (!owner) throw new Error(`Unbekannter Sender „${value}“ – bekannt: ${senders}.`);
    return owner;
  };
  server.registerTool(
    'add_lead',
    {
      title: 'Lead anlegen',
      description:
        'Einen Lead per LinkedIn-Link sofort anlegen: ein Profilabruf über den LinkedIn-Account des Besitzers, keine KI-Vorprüfung, kein Meta-Check, nichts gesendet. Stufe: nicht vernetzt → Neu, offene Anfrage → Anfrage gesendet, vernetzt → Vernetzt. Gibt es die Person schon, bleibt sie unverändert (Dublette). Mehrere Personen derselben Firma sind erlaubt. Für viele Links import_leads nehmen.',
      inputSchema: itemShape,
      annotations: WRITE,
    },
    async (input) => {
      let owner: AuthFounderId | undefined;
      try {
        owner = ownerOf(input.owner);
      } catch (error) {
        return fail((error as Error).message);
      }
      const result = await call<LeadAddResponse>('POST', '/api/leads/add', { ...input, owner });
      if (!result.ok) return fail(result.message);
      const { status, leadId, message } = result.body;
      return ok(`${status === 'created' ? 'Angelegt' : 'Dublette'}: ${message} ${linkOf(leadId, 'Im Cockpit öffnen')}`);
    },
  );

  server.registerTool(
    'import_leads',
    {
      title: 'Leads importieren',
      description: `Bis ${LEAD_IMPORT_MAX_ITEMS} LinkedIn-Links auf einmal einreihen. Abgerufen wird im Hintergrund (3–8 s Pause, nie über das Tageslimit für Profilabrufe des Accounts; ist es voll, geht es am nächsten Tag weiter). Antwort je Link: in der Warteschlange, Dublette oder Fehler. Fortschritt mit import_status.`,
      inputSchema: { items: z.array(z.object(itemShape)).min(1).max(LEAD_IMPORT_MAX_ITEMS) },
      annotations: WRITE,
    },
    async ({ items }) => {
      let resolved;
      try {
        resolved = items.map((item) => ({ ...item, owner: ownerOf(item.owner) }));
      } catch (error) {
        return fail((error as Error).message);
      }
      const result = await call<LeadImportResponse>('POST', '/api/leads/import', { items: resolved });
      if (!result.ok) return fail(result.message);
      const body = result.body;
      const label = { queued: 'Warteschlange', duplicate: 'Dublette', invalid: 'Fehler' } as const;
      const lines = [
        `# Import: ${body.queued} eingereiht, ${body.duplicates} Dubletten, ${body.invalid} Fehler`,
        body.message,
        '',
        ...body.results.map((entry) => `- ${entry.profile} · ${label[entry.status]}${entry.status === 'queued' ? '' : ` · ${entry.message}`}${entry.leadId ? ` (lead_id: ${entry.leadId})` : ''}`),
      ];
      return ok(lines.join('\n'));
    },
  );

  server.registerTool(
    'import_status',
    {
      title: 'Stand des Imports',
      description: 'Was aus der Import-Warteschlange schon abgerufen ist: Zahlen je Ergebnis, Profilabrufe heute je Besitzer, Pause mit Grund und die letzten Einträge (neueste zuerst).',
      inputSchema: {
        owner: z.string().trim().min(1).max(80).optional().describe('Sender (Name oder ID)'),
        limit: z.number().int().min(1).max(200).optional().describe('So viele letzte Einträge (Standard 20)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ owner, limit }) => {
      const query = new URLSearchParams();
      if (owner) {
        const resolved = resolveOwner(owner);
        if (!resolved) return fail(`Unbekannter Sender „${owner}“ – bekannt: ${senders}.`);
        query.set('owner', resolved);
      }
      if (limit) query.set('limit', String(limit));
      const result = await call<LeadImportStatusResponse>('GET', `/api/leads/import/status${query.size ? `?${query}` : ''}`);
      if (!result.ok) return fail(result.message);
      const body = result.body;
      const label = { queued: 'wartet', created: 'angelegt', duplicate: 'Dublette', failed: 'Fehler' } as const;
      const today = Object.entries(body.profilesToday).map(([id, room]) => `${id} ${room!.used}/${room!.limit}`);
      const lines = [
        '# Import-Warteschlange',
        body.message,
        today.length ? `Profilabrufe heute: ${today.join(' · ')}` : '',
        '',
        ...body.recent.map(
          (entry) =>
            `- ${entry.profile} · ${label[entry.status]}${entry.message && entry.status !== 'queued' ? ` · ${entry.message}` : ''}${entry.leadId ? ` · ${linkOf(entry.leadId, 'öffnen')}` : ''}`,
        ),
      ];
      return ok(lines.filter((line, index) => line !== '' || index === 3).join('\n'));
    },
  );

  server.registerTool(
    'set_lead_fields',
    {
      title: 'Freie Felder setzen',
      description: 'Freie Felder eines vorhandenen Leads setzen oder ändern (z. B. welle, testgruppe, fit, aufhaenger, firma_stage). Leerer Wert löscht das Feld, andere Felder bleiben.',
      inputSchema: { lead_id: z.string().trim().min(1).max(64), fields: fieldsSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ lead_id, fields }) => {
      const result = await call<LeadDetailResponse>('PUT', `/api/leads/${encodeURIComponent(lead_id)}/fields`, { fields });
      if (!result.ok) return fail(result.message);
      const now = result.body.lead.fields ?? {};
      const list = Object.entries(now).map(([key, value]) => `${key}: ${value}`);
      return ok(`Gespeichert: ${linkOf(lead_id, `${result.body.lead.person.firstName} ${result.body.lead.person.lastName}`)}\n${list.length ? list.join('\n') : 'Keine Felder mehr.'}`);
    },
  );
}
