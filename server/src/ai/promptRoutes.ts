import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { ASSISTANT_DEFAULT_PROMPT } from '../assistant/service.js';
import { SUGGEST_SYSTEM_PROMPT } from '../messages/aiWriter.js';
import { CONVERSATION_DEFAULT_PROMPT } from '../messages/conversation.js';
import { PRESCREEN_SYSTEM_PROMPT } from '../qualify/prescreen.js';
import { QUALIFICATION_SYSTEM_PROMPT } from '../qualify/prompt.js';
import { PROMPT_KEYS, PROMPT_LABELS, PROMPT_MAX_LENGTH, type PromptKey, type PromptStore } from './prompts.js';

/**
 * Eigene KI-Prompts (Lukas-Instanz 19.11.) – unter `/api/settings/…`, damit dieselben Rechte gelten wie bei den
 * Einstellungen (nur Gründer und Admin). Nur über die Claude-App bedient (MCP `list_prompts`, `set_prompt`).
 *   GET /api/settings/prompts        → { prompts: PromptInfo[] }
 *   PUT /api/settings/prompts/:key   { text: string | null } → PromptInfo (null = Standard wiederherstellen)
 */

export interface PromptInfo {
  key: PromptKey;
  label: string;
  help: string;
  custom: boolean;
  /** Wirksamer eigener Text bzw. der Standard (bei „assistant“ nur der erste Absatz). */
  text: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

const DEFAULTS: Record<PromptKey, string> = {
  qualify: QUALIFICATION_SYSTEM_PROMPT,
  prescreen: PRESCREEN_SYSTEM_PROMPT.replace(/^\[cockpit:vorpruefung\]\s*/, ''),
  writer: SUGGEST_SYSTEM_PROMPT.replace(/^\[cockpit:vorschlag\]\s*/, ''),
  conversation: CONVERSATION_DEFAULT_PROMPT,
  assistant: ASSISTANT_DEFAULT_PROMPT.slice(0, ASSISTANT_DEFAULT_PROMPT.indexOf('\n\n')),
};

const KeyParams = z.object({ key: z.enum(PROMPT_KEYS) });
const Body = z.object({ text: z.string().trim().min(20, 'Mindestens 20 Zeichen.').max(PROMPT_MAX_LENGTH, `Höchstens ${PROMPT_MAX_LENGTH} Zeichen.`).nullable() });

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

export function registerPromptRoutes(app: FastifyInstance, { store }: { store: PromptStore }): void {
  const info = (key: PromptKey): PromptInfo => {
    const stored = store.get(key);
    return {
      key,
      ...PROMPT_LABELS[key],
      custom: !!stored,
      text: stored?.text ?? DEFAULTS[key],
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  };

  app.get('/api/settings/prompts', async () => ({ prompts: PROMPT_KEYS.map(info) }));

  app.put('/api/settings/prompts/:key', async (request, reply) => {
    const params = KeyParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', `Unbekannter Prompt – erlaubt: ${PROMPT_KEYS.join(', ')}.`);
    const body = Body.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    if (body.data.text === null) store.reset(params.data.key);
    else store.set(params.data.key, body.data.text, request.authUser?.username ?? null);
    request.log.info({ prompt: params.data.key, reset: body.data.text === null, by: request.authUser?.username ?? null }, 'KI-Prompt geändert');
    return info(params.data.key);
  });
}
