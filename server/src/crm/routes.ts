import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { HANDOVER_NOTE_MAX_LENGTH } from '../../../shared/crm.js';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import type { LeadDetailResponse } from '../../../shared/leads.js';
import { actingFounder, actorFor } from '../auth/roles.js';
import { DuplicateEventError, InvalidTransitionError, LeadNotFoundError, type LeadStore } from '../leads/leadStore.js';
import { CrmError, type CrmService } from './service.js';

/** Routen laut Vertrag `shared/crm.ts`. Rechte (eigene Leads, Admin) prüft schon der Hook in `leads/routes.ts`. */

const IdParams = z.object({ id: z.string().min(1).max(64) });
const HandoverSchema = z.object({
  note: z.string().trim().max(HANDOVER_NOTE_MAX_LENGTH, `Die Notiz darf höchstens ${HANDOVER_NOTE_MAX_LENGTH} Zeichen haben.`).optional(),
  clientId: z.string().trim().min(1).max(64).optional(),
});

function sendError(reply: FastifyReply, status: number, code: string, message: string, retryAfter?: number) {
  if (retryAfter) reply.header('Retry-After', String(retryAfter));
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

export function registerCrmRoutes(app: FastifyInstance, { leads, crm }: { leads: LeadStore; crm: CrmService }) {
  const detail = (id: string): LeadDetailResponse => ({ lead: leads.get(id)!, events: leads.events(id) });

  app.get('/api/crm/status', async () => crm.status());

  app.post('/api/leads/:id/handover', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const body = HandoverSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    const id = params.data.id;
    const by = actingFounder(request.authUser) ?? leads.get(id)?.owner ?? null;
    try {
      await crm.handover(id, by, body.data, actorFor(request.authUser, by));
    } catch (error) {
      if (error instanceof DuplicateEventError) return { ...detail(id), duplicate: true };
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      if (error instanceof InvalidTransitionError) return sendError(reply, 409, 'invalid_transition', error.message);
      if (error instanceof CrmError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
    return detail(id);
  });
}
