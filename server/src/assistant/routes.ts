import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ASSISTANT_QUESTION_MAX_LENGTH, type AssistantChatListResponse, type AssistantModelsResponse, type AssistantStreamEvent } from '../../../shared/assistant.js';
import { authRole, workingFounders, type AuthFounderId, type AuthUser } from '../../../shared/auth.js';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { AnthropicModels } from '../ai/models.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { LeadStore } from '../leads/leadStore.js';
import { AssistantData } from './data.js';
import { AssistantBusyError, AssistantService } from './service.js';
import { AssistantStore } from './store.js';

/** Routen laut Vertrag `shared/assistant.ts`. Jedes Konto sieht nur seine eigenen Chats. */

const IdParams = z.object({ id: z.string().min(1).max(64) });
/** Nur Claude-Modelle (IDs wie „claude-opus-5-5“). */
const ModelSchema = z.string().trim().regex(/^claude-[a-z0-9.-]{1,60}$/, 'Bitte ein Claude-Modell wählen.');
const CreateSchema = z.object({ model: ModelSchema.optional() });
const AskSchema = z.object({
  text: z.string().trim().min(1, 'Bitte eine Frage eingeben.').max(ASSISTANT_QUESTION_MAX_LENGTH, `Höchstens ${ASSISTANT_QUESTION_MAX_LENGTH} Zeichen.`),
  model: ModelSchema.optional(),
});
/** Herzschlag im Stream – Proxys schließen sonst lange stille Verbindungen (Claude liest gerade viele Gespräche). */
const HEARTBEAT_MS = 15_000;

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

/** Wessen Leads das Konto sehen darf – wie im Cockpit: Mitarbeiter nur ihre Gründer, sonst alle (null). */
function scopeOf(user: AuthUser | null): AuthFounderId[] | null {
  return user && authRole(user) === 'assistant' ? workingFounders(user) : null;
}

export function registerAssistantRoutes(
  app: FastifyInstance,
  { config, db, leads, anthropicBaseURL }: { config: Config; db: Database; leads: LeadStore; anthropicBaseURL?: string },
) {
  const store = new AssistantStore(db);
  const service = new AssistantService({ config, data: new AssistantData(leads, db), store, anthropicBaseURL });
  const models = new AnthropicModels({ baseURL: anthropicBaseURL });
  const userOf = (request: { authUser?: AuthUser | null }) => request.authUser ?? null;
  // Ohne Anmeldung (Übergang/Tests) ein gemeinsames Postfach.
  const nameOf = (request: { authUser?: AuthUser | null }) => request.authUser?.username ?? '-';

  app.get('/api/assistant/models', async (): Promise<AssistantModelsResponse> => {
    const list = await models.list(config.anthropic.apiKey, config.mode);
    return {
      models: list.models.filter((model) => model.id.startsWith('claude-')).map((model) => ({ id: model.id, label: model.label })),
      defaultModel: config.anthropic.model,
      source: list.source,
      ...(list.notice ? { notice: list.notice } : {}),
    };
  });

  app.get('/api/assistant/chats', async (request): Promise<AssistantChatListResponse> => ({ chats: store.list(nameOf(request)) }));

  app.post('/api/assistant/chats', async (request, reply) => {
    const body = CreateSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    return reply.status(201).send(store.create(nameOf(request), body.data.model ?? config.anthropic.model));
  });

  app.get('/api/assistant/chats/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const chat = params.success ? store.get(nameOf(request), params.data.id) : null;
    if (!chat) return sendError(reply, 404, 'not_found', 'Diesen Chat gibt es nicht (mehr).');
    return chat;
  });

  app.delete('/api/assistant/chats/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success || !store.delete(nameOf(request), params.data.id)) return sendError(reply, 404, 'not_found', 'Diesen Chat gibt es nicht (mehr).');
    return { ok: true };
  });

  // Antwort abbrechen („Stopp“). Schließt der Browser nur die Verbindung (Seitenwechsel), läuft die Antwort weiter und
  // steht beim nächsten Öffnen des Chats da.
  app.post('/api/assistant/chats/:id/stop', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success || !store.summary(nameOf(request), params.data.id)) return sendError(reply, 404, 'not_found', 'Diesen Chat gibt es nicht (mehr).');
    return { stopped: service.stop(params.data.id) };
  });

  app.post('/api/assistant/chats/:id/messages', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const chat = params.success ? store.summary(nameOf(request), params.data.id) : null;
    if (!chat) return sendError(reply, 404, 'not_found', 'Diesen Chat gibt es nicht (mehr).');
    const body = AskSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    if (service.isBusy(chat.id)) return sendError(reply, 409, 'busy', new AssistantBusyError().message);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let open = true;
    res.on('close', () => {
      open = false;
    });
    const emit = (event: AssistantStreamEvent) => {
      if (open) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => open && res.write(': ping\n\n'), HEARTBEAT_MS);
    try {
      await service.ask(nameOf(request), chat.id, body.data.text, body.data.model ?? chat.model, scopeOf(userOf(request)), emit);
    } catch (error) {
      request.log.error({ err: error instanceof Error ? error.message : String(error) }, 'KI-Assistent: Antwort fehlgeschlagen');
      emit({ type: 'error', message: error instanceof AssistantBusyError ? error.message : 'Die Antwort ist fehlgeschlagen.' });
    } finally {
      clearInterval(heartbeat);
      if (open) res.end();
    }
  });

  app.addHook('onClose', async () => service.stopAll());
}
