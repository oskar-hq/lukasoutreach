import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import { CONTACT_PROFILE_MAX_LENGTH, type LeadDetailResponse } from '../../../shared/leads.js';
import {
  LEAD_FIELD_KEY_PATTERN,
  LEAD_FIELD_VALUE_MAX_LENGTH,
  LEAD_FIELDS_MAX,
  LEAD_IMPORT_MAX_ITEMS,
  COMPANY_SEARCH_MAX_COMPANIES,
  COMPANY_SEARCH_MAX_RESULTS,
  type LeadAddResponse,
  type LeadImportResponse,
} from '../../../shared/leadImport.js';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { actingFounder, actorFor, assistantDenial } from '../auth/roles.js';
import { profileIdentifier } from '../linkedin/routes.js';
import { LinkedInError } from '../linkedin/service.js';
import type { LeadImportQueue } from './importQueue.js';
import { LeadNotFoundError, type LeadStore } from './leadStore.js';

/** Routen des Listen-Imports (Vertrag `shared/leadImport.ts`). */

const founderField = z.enum(AUTH_FOUNDER_IDS, `Besitzer muss ${AUTH_FOUNDER_IDS.join(' oder ')} sein.`);
const FieldsSchema = z
  .record(
    z.string().regex(LEAD_FIELD_KEY_PATTERN, 'Feldnamen: klein, a–z, 0–9 und _, mit Buchstabe vorn, höchstens 40 Zeichen.'),
    z.string().max(LEAD_FIELD_VALUE_MAX_LENGTH, `Feldwerte höchstens ${LEAD_FIELD_VALUE_MAX_LENGTH} Zeichen.`),
  )
  .refine((fields) => Object.keys(fields).length <= LEAD_FIELDS_MAX, `Höchstens ${LEAD_FIELDS_MAX} Felder.`);
const ItemSchema = z.object({
  profile: z.string().trim().min(1, 'Profil-Link fehlt.').max(CONTACT_PROFILE_MAX_LENGTH),
  owner: founderField.optional(),
  category: z.string().trim().max(80).optional(),
  note: z.string().trim().max(2000).optional(),
  fields: FieldsSchema.optional(),
});
const ImportSchema = z.object({ items: z.array(ItemSchema).min(1, 'Mindestens ein Link.').max(LEAD_IMPORT_MAX_ITEMS, `Höchstens ${LEAD_IMPORT_MAX_ITEMS} Links je Aufruf.`) });
const StatusQuery = z.object({ owner: founderField.optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
const IdParams = z.object({ id: z.string().min(1).max(64) });
const FieldsBody = z.object({ fields: FieldsSchema });
const CompanySearchSchema = z.object({
  companies: z
    .array(z.string().trim().min(2, 'Firmenname zu kurz.').max(200))
    .min(1, 'Mindestens eine Firma.')
    .max(COMPANY_SEARCH_MAX_COMPANIES, `Höchstens ${COMPANY_SEARCH_MAX_COMPANIES} Firmen je Aufruf.`),
  title: z.string().trim().min(2).max(100).optional(),
  limit: z.number().int().min(1).max(COMPANY_SEARCH_MAX_RESULTS).optional(),
  owner: founderField.optional(),
  import: z.boolean().optional(),
  category: z.string().trim().max(80).optional(),
  fields: FieldsSchema.optional(),
});

function sendError(reply: FastifyReply, status: number, code: string, message: string, retryAfter?: number) {
  if (retryAfter) reply.header('Retry-After', String(retryAfter));
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}
const issues = (error: z.ZodError) => error.issues.map((issue) => issue.message).join(' ');

export function registerLeadImportRoutes(
  app: FastifyInstance,
  {
    queue,
    leads,
    founderName,
    detail,
    categories = () => [],
  }: {
    queue: LeadImportQueue;
    leads: LeadStore;
    founderName: (id: AuthFounderId) => string;
    detail: (id: string) => LeadDetailResponse | null;
    /** Eigene Kategorien (`LEAD_CATEGORY_LIST`); leer = jede erlaubt. */
    categories?: () => readonly string[];
  },
): void {
  /** Fehlertext, wenn die Kategorie nicht in der Liste steht – sonst null. */
  const categoryProblem = (category: string | undefined): string | null => {
    const allowed = categories();
    if (!category || !allowed.length || allowed.includes(category.trim().toLowerCase())) return null;
    return `Unbekannte Kategorie „${category}“ – erlaubt: ${allowed.join(', ')} (Einstellungen → Tagesstapel → Eigene Kategorien).`;
  };
  app.post('/api/leads/add', async (request, reply) => {
    const parsed = ItemSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const user = request.authUser ?? null;
    const owner = parsed.data.owner ?? actingFounder(user);
    if (!owner) return sendError(reply, 400, 'invalid_request', 'Bitte angeben, wem der Lead gehört (owner).');
    const denial = assistantDenial(user, owner, founderName);
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
    const identifier = profileIdentifier(parsed.data.profile);
    if (!identifier) return sendError(reply, 400, 'invalid_request', 'Bitte einen LinkedIn-Profil-Link (https://www.linkedin.com/in/…) angeben.');
    const badCategory = categoryProblem(parsed.data.category);
    if (badCategory) return sendError(reply, 400, 'invalid_request', badCategory);
    try {
      const result = await queue.addNow(parsed.data, identifier.toLowerCase(), owner, actorFor(user, owner));
      const body: LeadAddResponse = { status: result.status, leadId: result.lead.id, message: result.message };
      return reply.status(result.status === 'created' ? 201 : 200).send(body);
    } catch (error) {
      if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
  });

  app.post('/api/leads/import', async (request, reply) => {
    const parsed = ImportSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const user = request.authUser ?? null;
    const fallback = actingFounder(user);
    for (const item of parsed.data.items) {
      const owner = item.owner ?? fallback;
      if (!owner) return sendError(reply, 400, 'invalid_request', 'Bitte angeben, wem die Leads gehören (owner).');
      const denial = assistantDenial(user, owner, founderName);
      if (denial) return sendError(reply, 403, 'not_allowed', denial);
    }
    const owner = (parsed.data.items[0]?.owner ?? fallback)!;
    // Unbekannte Kategorie: dieser Link als Fehler, der Rest wird eingereiht (Reihenfolge der Antwort wie die Eingabe).
    const problems = parsed.data.items.map((item) => categoryProblem(item.category));
    const accepted = parsed.data.items.filter((_item, index) => !problems[index]);
    const queuedResults = queue.enqueue(
      accepted.map((item) => ({ ...item, identifier: profileIdentifier(item.profile) })),
      owner,
      actorFor(user, owner),
    );
    let next = 0;
    const results = parsed.data.items.map((item, index) =>
      problems[index] ? { profile: item.profile.trim(), status: 'invalid' as const, message: problems[index]! } : queuedResults[next++],
    );
    const owners = [...new Set(parsed.data.items.map((item) => item.owner ?? fallback!))];
    const status = queue.status(owners, 0);
    const body: LeadImportResponse = {
      results,
      queued: results.filter((result) => result.status === 'queued').length,
      duplicates: results.filter((result) => result.status === 'duplicate').length,
      invalid: results.filter((result) => result.status === 'invalid').length,
      waiting: status.counts.queued,
      message: status.message,
    };
    return reply.status(202).send(body);
  });

  app.get('/api/leads/import/status', async (request, reply) => {
    const parsed = StatusQuery.safeParse(request.query ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const user = request.authUser ?? null;
    const visible = AUTH_FOUNDER_IDS.filter((id) => !assistantDenial(user, id, founderName));
    const owners = parsed.data.owner ? visible.filter((id) => id === parsed.data.owner) : visible;
    return queue.status(owners, parsed.data.limit ?? 20);
  });

  app.post('/api/leads/company-search', async (request, reply) => {
    const parsed = CompanySearchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const user = request.authUser ?? null;
    const owner = parsed.data.owner ?? actingFounder(user);
    if (!owner) return sendError(reply, 400, 'invalid_request', 'Bitte angeben, über wessen Account gesucht wird (owner).');
    const denial = assistantDenial(user, owner, founderName);
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
    const badCategory = categoryProblem(parsed.data.category);
    if (badCategory) return sendError(reply, 400, 'invalid_request', badCategory);
    return queue.searchCompanies({ ...parsed.data, owner }, actorFor(user, owner));
  });

  /** Freie Felder eines vorhandenen Leads setzen (leerer Wert löscht das Feld). */
  app.put('/api/leads/:id/fields', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const parsed = FieldsBody.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', issues(parsed.error));
    const lead = leads.get(params.data.id);
    if (!lead) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const user = request.authUser ?? null;
    const denial = assistantDenial(user, lead.owner, founderName);
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
    try {
      leads.setFields(lead.id, parsed.data.fields, lead.owner, Date.now(), actorFor(user, lead.owner));
    } catch (error) {
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      throw error;
    }
    return detail(lead.id);
  });
}
