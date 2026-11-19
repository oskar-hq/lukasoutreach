import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PromptInfo } from '../ai/promptRoutes.js';
import { PROMPT_KEYS, PROMPT_MAX_LENGTH } from '../ai/prompts.js';
import type { CockpitCall } from './settingsTools.js';

/** Eigene KI-Prompts per Claude-App (Lukas-Instanz 19.11.) – Routen `/api/settings/prompts`, Rechte wie Einstellungen. */

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const describe = (prompt: PromptInfo, full: boolean) =>
  `### ${prompt.key} · ${prompt.label} · ${prompt.custom ? `eigener Text${prompt.updatedBy ? ` (${prompt.updatedBy})` : ''}` : 'Standard'}\n${prompt.help}${full ? `\n\n${prompt.text}` : ''}`;

export function registerPromptTools(server: McpServer, call: CockpitCall): void {
  server.registerTool(
    'list_prompts',
    {
      title: 'KI-Prompts lesen',
      description: `Die KI-Prompts dieser Instanz (${PROMPT_KEYS.join(', ')}) mit aktuellem Text – Standard oder eigener. Mit key nur einen, ganz.`,
      inputSchema: { key: z.enum(PROMPT_KEYS).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ key }) => {
      const result = await call<{ prompts: PromptInfo[] }>('GET', '/api/settings/prompts');
      if (!result.ok) return fail(result.message);
      const prompts = key ? result.body.prompts.filter((prompt) => prompt.key === key) : result.body.prompts;
      return ok(prompts.map((prompt) => describe(prompt, true)).join('\n\n'));
    },
  );

  server.registerTool(
    'set_prompt',
    {
      title: 'KI-Prompt ändern',
      description:
        'Eigenen Text für einen KI-Prompt speichern (gilt sofort für alle neuen KI-Aufrufe dieser Instanz). Die technischen Ausgabe-Regeln hängt das Cockpit selbst an – schreib nur Zielgruppe, Kriterien, Ton und Angebot. Vorher den Text mit dem Nutzer abstimmen. text: null = Standard wiederherstellen.',
      inputSchema: {
        key: z.enum(PROMPT_KEYS),
        text: z.string().trim().min(20).max(PROMPT_MAX_LENGTH).nullable(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ key, text }) => {
      const result = await call<PromptInfo>('PUT', `/api/settings/prompts/${key}`, { text });
      if (!result.ok) return fail(result.message);
      return ok(`Gespeichert.\n${describe(result.body, false)}`);
    },
  );
}
