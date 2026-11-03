import type { FastifyInstance } from 'fastify';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { MetaRecheckBusyError, MetaRecheckUnavailableError, type MetaRecheckService } from './metaRecheck.js';

/** Routen der Meta-Nachprüfung (Vertrag `shared/metaRecheck.ts`) – unter `/api/settings`, also nur Admin und Gründer. */
export function registerMetaRecheckRoutes(app: FastifyInstance, { service }: { service: MetaRecheckService }): void {
  app.get('/api/settings/meta-recheck', async () => service.status());

  app.post('/api/settings/meta-recheck', async (request, reply) => {
    const fail = (status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } } satisfies ApiErrorBody);
    try {
      const status = service.start();
      request.log.info({ total: status.total }, 'Meta-Nachprüfung von Hand gestartet');
      return reply.status(202).send(status);
    } catch (error) {
      if (error instanceof MetaRecheckBusyError) return fail(409, 'running', error.message);
      if (error instanceof MetaRecheckUnavailableError) return fail(400, 'config', error.message);
      throw error;
    }
  });
}
