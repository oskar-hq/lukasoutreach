import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authRole, type AuthFounderId, type AuthUser } from '../../../shared/auth.js';
import {
  FEEDBACK_ANSWER_MAX,
  FEEDBACK_IMAGES_MAX,
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_TEXT_MAX,
  type FeedbackCreateRequest,
  type FeedbackItem,
} from '../../../shared/feedback.js';
import type { NotificationCenter } from '../notify/notifications.js';
import { FeedbackError, FeedbackStore } from './store.js';

/** Fenster mit Bildschirmfoto und bis zu drei eigenen Bildern – größer als der Standard (1 MB). */
const FEEDBACK_BODY_LIMIT = 16 * 1024 * 1024;

const CreateSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS).nullish(),
  text: z.string().max(FEEDBACK_TEXT_MAX),
  context: z.record(z.string(), z.unknown()).optional(),
  images: z.array(z.string()).max(FEEDBACK_IMAGES_MAX).optional(),
});
const UpdateSchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  answer: z.string().max(FEEDBACK_ANSWER_MAX).nullable().optional(),
});

function sendError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({ error: { code: status === 404 ? 'not_found' : status === 403 ? 'not_allowed' : 'invalid_request', message } });
}

/**
 * Feedback vom Kunden (Vertrag `shared/feedback.ts`). Neue Meldungen erscheinen bei Gründern und Admins in der Glocke
 * (und in Slack, wenn eingerichtet); ändert sich der Stand, bekommt der Melder eine Meldung.
 */
export function registerFeedbackRoutes(app: FastifyInstance, deps: { store: FeedbackStore; notifications: NotificationCenter }): void {
  const { store, notifications } = deps;
  const canManage = (role: string) => role === 'founder' || role === 'admin';

  app.post('/api/feedback', { bodyLimit: FEEDBACK_BODY_LIMIT }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return sendError(reply, 401, 'Bitte melde dich an.');
    const parsed = CreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'Die Meldung ließ sich nicht lesen – versuch es bitte noch einmal.');
    try {
      const item = store.create(parsed.data as FeedbackCreateRequest, { username: user.username, name: user.name, founder: user.founder }, Date.now());
      notifications.raise({
        key: `feedback:new:${item.id}`,
        kind: 'feedback',
        severity: 'info',
        title: `Feedback #${item.number} von ${item.by}: ${FEEDBACK_KIND_LABELS[item.kind]}`,
        text: item.text.length > 280 ? `${item.text.slice(0, 280)}…` : item.text,
        audience: 'managers',
        target: { view: 'feedback' },
        repeat: false,
      });
      return reply.status(201).send(item);
    } catch (error) {
      if (error instanceof FeedbackError) return sendError(reply, error.status, error.message);
      throw error;
    }
  });

  app.get('/api/feedback', async (request, reply) => {
    const user = request.authUser;
    if (!user) return sendError(reply, 401, 'Bitte melde dich an.');
    const query = z
      .object({ status: z.enum([...FEEDBACK_STATUSES, 'open'] as const).optional(), mine: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
      .safeParse(request.query);
    const options = query.success ? query.data : {};
    // Mitarbeiter sehen nur ihre eigenen Meldungen.
    const onlyOwn = options.mine === '1' || authRole(user) === 'assistant';
    return { items: store.list({ status: options.status ?? null, username: onlyOwn ? user.username : null, limit: options.limit }) };
  });

  const visible = (item: FeedbackItem | null, user: AuthUser) => !!item && (authRole(user) !== 'assistant' || item.username === user.username);

  app.get('/api/feedback/:id', async (request, reply) => {
    const user = request.authUser;
    if (!user) return sendError(reply, 401, 'Bitte melde dich an.');
    const item = store.get((request.params as { id: string }).id);
    if (!visible(item, user)) return sendError(reply, 404, 'Meldung nicht gefunden.');
    return item;
  });

  app.get('/api/feedback/:id/images/:n', async (request, reply) => {
    const user = request.authUser;
    if (!user) return sendError(reply, 401, 'Bitte melde dich an.');
    const params = request.params as { id: string; n: string };
    const item = store.get(params.id);
    if (!visible(item, user)) return sendError(reply, 404, 'Bild nicht gefunden.');
    const image = store.image(item!.id, Number(params.n));
    if (!image) return sendError(reply, 404, 'Bild nicht gefunden.');
    return reply.header('content-type', image.type).header('cache-control', 'private, max-age=3600').send(image.data);
  });

  app.patch('/api/feedback/:id', async (request, reply) => {
    const user = request.authUser;
    if (!user) return sendError(reply, 401, 'Bitte melde dich an.');
    if (!canManage(authRole(user))) return sendError(reply, 403, 'Den Stand einer Meldung ändern nur Gründer und Admins.');
    const parsed = UpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'Ungültige Änderung.');
    try {
      const { before, after } = store.update((request.params as { id: string }).id, parsed.data, Date.now());
      if (before.status !== after.status || before.answer !== after.answer) {
        notifications.raise({
          key: `feedback:status:${after.id}`,
          kind: 'feedback',
          severity: 'info',
          title: `Deine Meldung #${after.number}: ${FEEDBACK_STATUS_LABELS[after.status]}`,
          text: after.answer ?? `„${after.text.length > 120 ? `${after.text.slice(0, 120)}…` : after.text}“ – Stand: ${FEEDBACK_STATUS_LABELS[after.status]}.`,
          audience: 'all',
          founder: (store.founderOf(after.id) as AuthFounderId | null) ?? null,
          target: { view: 'feedback' },
        });
        // Die Meldung „neues Feedback“ ist damit erledigt.
        if (after.status !== 'new') notifications.resolve(`feedback:new:${after.id}`);
      }
      return after;
    } catch (error) {
      if (error instanceof FeedbackError) return sendError(reply, error.status, error.message);
      throw error;
    }
  });
}
