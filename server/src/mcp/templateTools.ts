import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TEMPLATE_CATEGORIES, TEMPLATE_MAX_LENGTH, TEMPLATE_PLACEHOLDERS, templateCategory, type MessageTemplate, type TemplatesResponse } from '../../../shared/messages.js';
import type { CockpitCall } from './settingsTools.js';

/**
 * Vorlagen per Claude-App schreiben (Lukas-Instanz 19.11., Vertrag `shared/messages.ts`): anlegen, ändern, löschen –
 * über dieselben Routen wie Einstellungen → Vorlagen (gleiche Prüfung der Platzhalter, höchstens 26 je Kategorie,
 * die letzte einer Kategorie bleibt).
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const CATEGORY_IDS = TEMPLATE_CATEGORIES.map((category) => category.id) as [string, ...string[]];
const CATEGORY_TEXT = TEMPLATE_CATEGORIES.map((category) => `${category.id} = ${category.label}`).join(', ');

export function describeTemplate(template: MessageTemplate): string {
  const category = templateCategory(template);
  return `### ${template.id} · ${template.name}\nKategorie: ${category ?? '–'}${template.custom ? ' · eigene Vorlage' : template.isDefault ? ' · Standardtext' : ' · angepasst'}\n${template.description}\n\n${template.text}`;
}

export function registerTemplateTools(server: McpServer, call: CockpitCall): void {
  const placeholders = async () => {
    const result = await call<TemplatesResponse>('GET', '/api/templates');
    return result.ok ? [...TEMPLATE_PLACEHOLDERS, ...(result.body.fieldPlaceholders ?? [])] : [...TEMPLATE_PLACEHOLDERS];
  };

  server.registerTool(
    'create_template',
    {
      title: 'Vorlage anlegen',
      description: `Neue Nachrichten-Vorlage anlegen. Kategorien: ${CATEGORY_TEXT}. Höchstens 26 je Kategorie. Platzhalter: die festen ({{vorname}}, {{firma}}, {{grussformel}} …) und die freien Felder aus der Einstellung „Freie Felder der Leads“ (z. B. {{aufhaenger}}) – list_templates zeigt alle erlaubten.`,
      inputSchema: {
        category: z.enum(CATEGORY_IDS),
        name: z.string().trim().min(1).max(80).optional().describe('Name, z. B. „VC · Funding-Runde“'),
        text: z.string().trim().min(1).max(TEMPLATE_MAX_LENGTH),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ category, name, text }) => {
      const result = await call<MessageTemplate>('POST', '/api/templates', { category, text, ...(name ? { name } : {}) });
      if (!result.ok) return fail(result.message);
      return ok(`Angelegt:\n${describeTemplate(result.body)}`);
    },
  );

  server.registerTool(
    'update_template',
    {
      title: 'Vorlage ändern',
      description: 'Text (und optional Namen) einer vorhandenen Vorlage ersetzen. ID aus list_templates. Gleiche Prüfung wie in Einstellungen → Vorlagen.',
      inputSchema: {
        template_id: z.string().trim().min(1).max(64),
        text: z.string().trim().min(1).max(TEMPLATE_MAX_LENGTH),
        name: z.string().trim().min(1).max(80).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ template_id, text, name }) => {
      const result = await call<MessageTemplate>('PUT', `/api/templates/${encodeURIComponent(template_id)}`, { text, ...(name ? { name } : {}) });
      if (!result.ok) return fail(result.message);
      return ok(`Gespeichert:\n${describeTemplate(result.body)}`);
    },
  );

  server.registerTool(
    'delete_template',
    {
      title: 'Vorlage löschen',
      description: 'Eine Vorlage löschen (die letzte einer Kategorie bleibt immer). Standardtexte lassen sich ebenso löschen, solange eine andere Vorlage in der Kategorie bleibt. Vorher mit dem Nutzer abstimmen.',
      inputSchema: { template_id: z.string().trim().min(1).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ template_id }) => {
      const result = await call<{ ok: true }>('DELETE', `/api/templates/${encodeURIComponent(template_id)}`);
      if (!result.ok) return fail(result.message);
      return ok(`Vorlage ${template_id} gelöscht.`);
    },
  );

  server.registerTool(
    'template_placeholders',
    {
      title: 'Erlaubte Platzhalter',
      description: 'Alle Platzhalter, die Vorlagen enthalten dürfen – feste und freie Felder der Leads.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ok((await placeholders()).map((key) => `{{${key}}}`).join(', ')),
  );
}
