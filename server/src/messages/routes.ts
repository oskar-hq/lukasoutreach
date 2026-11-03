import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import {
  INVITE_NOTE_LIMIT,
  TEMPLATE_MAX_LENGTH,
  TEMPLATE_CATEGORIES,
  TEMPLATE_PLACEHOLDERS,
  TEMPLATE_SEGMENTS,
  unknownPlaceholders,
  type MessageKind,
  type MessagesErrorCode,
  type TemplateSegment,
  type TemplatesResponse,
} from '../../../shared/messages.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { LeadStore } from '../leads/leadStore.js';
import { SuggestError, SuggestionService } from './suggest.js';
import { TemplateNotFoundError, TemplateRuleError, TemplateStore } from './templateStore.js';

/** Routen laut Vertrag `shared/messages.ts`. Ohne Sitzung greift schon der Hook aus `auth.ts` (401). */

const IdParams = z.object({ id: z.string().min(1).max(64) });
const UpdateSchema = z.object({
  name: z.string().trim().min(1, 'Der Name darf nicht leer sein.').max(80, 'Der Name darf höchstens 80 Zeichen haben.').optional(),
  text: z.string().trim().min(1, 'Bitte einen Text eingeben.').max(TEMPLATE_MAX_LENGTH, `Der Text darf höchstens ${TEMPLATE_MAX_LENGTH} Zeichen haben.`),
  // Segment (27.10.): null = für alle Leads, fehlt = bleibt.
  segment: z.enum(TEMPLATE_SEGMENTS as [TemplateSegment, ...TemplateSegment[]], `segment muss null oder eins davon sein: ${TEMPLATE_SEGMENTS.join(', ')}.`).nullable().optional(),
});
const CreateSchema = UpdateSchema.extend({
  category: z.enum(
    TEMPLATE_CATEGORIES.map((category) => category.id) as [string, ...string[]],
    `category muss eins davon sein: ${TEMPLATE_CATEGORIES.map((category) => category.id).join(', ')}.`,
  ),
});
const SuggestSchema = z.object({
  kind: z.enum(['first', 'followup', 'reply'], 'kind muss „first“, „followup“ oder „reply“ sein.'),
  templateId: z.string().trim().min(1).max(64).optional(),
});

function sendError(reply: FastifyReply, status: number, code: MessagesErrorCode | 'invalid_request', message: string, retryAfter?: number) {
  if (retryAfter) reply.header('Retry-After', String(retryAfter));
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

/** Gleiche Regeln für neue und geänderte Texte: bekannte Platzhalter, Notiz zur Vernetzungsanfrage höchstens 300 Zeichen. */
function textProblem(kind: MessageKind, text: string): string | null {
  const unknown = unknownPlaceholders(text);
  if (unknown.length) {
    const allowed = TEMPLATE_PLACEHOLDERS.map((key) => `{{${key}}}`).join(', ');
    return `Unbekannte Platzhalter: ${unknown.map((key) => `{{${key}}}`).join(', ')}. Erlaubt sind ${allowed}.`;
  }
  if (kind === 'invite_note' && text.length > INVITE_NOTE_LIMIT) {
    return `Die Notiz zur Vernetzungsanfrage darf höchstens ${INVITE_NOTE_LIMIT} Zeichen haben.`;
  }
  return null;
}

export interface MessagesRouteDeps {
  config: Config;
  db: Database;
  leads: LeadStore;
  /** Nur Tests: nachgebauter Anthropic-Server. */
  anthropicBaseURL?: string;
}

export function registerMessageRoutes(app: FastifyInstance, { config, db, leads, anthropicBaseURL }: MessagesRouteDeps) {
  const templates = new TemplateStore(db);
  const suggestions = new SuggestionService({ config, templates, anthropicBaseURL });

  app.get('/api/templates', async (): Promise<TemplatesResponse> => ({ templates: templates.list() }));

  app.put('/api/templates/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const current = params.success ? templates.get(params.data.id) : null;
    if (!current) return sendError(reply, 404, 'not_found', 'Vorlage nicht gefunden.');
    const body = UpdateSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_template', body.error.issues.map((issue) => issue.message).join(' '));
    const problem = textProblem(current.kind, body.data.text);
    if (problem) return sendError(reply, 400, 'invalid_template', problem);
    const updated = templates.update(current.id, body.data, request.authUser?.username ?? null);
    request.log.info({ template: current.id, by: request.authUser?.username ?? null }, 'Vorlage geändert');
    return updated;
  });

  app.post('/api/templates/:id/reset', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Vorlage nicht gefunden.');
    try {
      return templates.reset(params.data.id);
    } catch (error) {
      if (error instanceof TemplateNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      throw error;
    }
  });

  app.post('/api/templates', async (request, reply) => {
    const body = CreateSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_template', body.error.issues.map((issue) => issue.message).join(' '));
    const category = TEMPLATE_CATEGORIES.find((entry) => entry.id === body.data.category)!;
    const problem = textProblem(category.kind, body.data.text);
    if (problem) return sendError(reply, 400, 'invalid_template', problem);
    try {
      const created = templates.create(category.id, body.data, request.authUser?.username ?? null);
      request.log.info({ template: created.id, by: request.authUser?.username ?? null }, 'Vorlage angelegt');
      return reply.status(201).send(created);
    } catch (error) {
      if (error instanceof TemplateRuleError) return sendError(reply, 409, error.code, error.message);
      throw error;
    }
  });

  app.delete('/api/templates/:id', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Vorlage nicht gefunden.');
    try {
      templates.remove(params.data.id, request.authUser?.username ?? null);
      request.log.info({ template: params.data.id, by: request.authUser?.username ?? null }, 'Vorlage gelöscht');
      return { ok: true };
    } catch (error) {
      if (error instanceof TemplateNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      if (error instanceof TemplateRuleError) return sendError(reply, 409, error.code, error.message);
      throw error;
    }
  });

  app.post('/api/leads/:id/suggest', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    const lead = params.success ? leads.get(params.data.id) : null;
    if (!lead) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const body = SuggestSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    try {
      return await suggestions.suggest(lead, leads.events(lead.id), body.data, request.authUser);
    } catch (error) {
      if (error instanceof SuggestError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
  });
}
