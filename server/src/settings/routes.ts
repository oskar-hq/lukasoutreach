import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import type { SettingsResponse } from '../../../shared/settings.js';
import { REMEMBER_MS } from '../auth/sessions.js';
import { SESSION_COOKIE, cookieHeader, readCookie } from '../auth/auth.js';
import type { Config } from '../config.js';
import { SettingsError, type Actor, type SettingsService } from './service.js';

/** Routen `/api/settings/*` laut Vertrag `shared/settings.ts`. Alle verlangen eine angemeldete Sitzung. */

function sendError(reply: FastifyReply, error: SettingsError) {
  if (error.retryAfter) reply.header('Retry-After', String(error.retryAfter));
  const body: ApiErrorBody = { error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } };
  return reply.status(error.status).send(body);
}

export function registerSettingsRoutes(app: FastifyInstance, { service, config }: { service: SettingsService; config: Config }) {
  /** Angemeldeter Nutzer oder 401 – auch dann, wenn die Pflicht-Sitzung (Übergang/Tests) aus ist. */
  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.authUser) throw new SettingsError(401, 'unauthorized', 'Bitte melde dich an.');
    const origin = request.headers.origin;
    return {
      username: request.authUser.username,
      ip: request.ip ?? null,
      sessionId: readCookie(request, SESSION_COOKIE),
      origin: typeof origin === 'string' ? origin : null,
    };
  };

  const guarded =
    <T>(work: (request: FastifyRequest, reply: FastifyReply, actor: Actor) => Promise<T> | T) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await work(request, reply, actorOf(request));
      } catch (error) {
        if (error instanceof SettingsError) return sendError(reply, error);
        throw error;
      }
    };

  /** Die Adresse, die das Backend jetzt sieht – nach einer Änderung von TRUST_PROXY_HOPS neu gelesen. */
  const withIp = (response: SettingsResponse, request: FastifyRequest): SettingsResponse => ({ ...response, clientIp: request.ip ?? response.clientIp });

  app.get('/api/settings', guarded((request, _reply, actor) => withIp(service.get(actor.ip ?? '-'), request)));

  app.put(
    '/api/settings',
    guarded(async (request, reply, actor) => {
      const result = await service.update(request.body as never, actor);
      if (result.newSession) {
        // Neue Sitzung der Probe – mit den Cookie-Einstellungen, die jetzt gelten (config wurde schon ersetzt).
        reply.header('Set-Cookie', cookieHeader(config, result.newSession.id, result.newSession.remember ? REMEMBER_MS / 1000 : null));
      }
      return withIp(result.response, request);
    }),
  );

  app.post('/api/settings/trial/confirm', guarded(async (request, _reply, actor) => withIp(await service.confirmTrial(actor), request)));
  app.post('/api/settings/trial/revert', guarded(async (request, _reply, actor) => withIp(await service.revertTrialBy(actor), request)));

  app.post(
    '/api/settings/test',
    guarded((request, _reply, actor) => {
      const body = request.body as { service?: unknown } | undefined;
      return service.test(typeof body?.service === 'string' ? body.service : '', actor);
    }),
  );

  app.get('/api/settings/history', guarded(() => service.history()));
  app.get('/api/settings/models', guarded(() => service.models()));
}
