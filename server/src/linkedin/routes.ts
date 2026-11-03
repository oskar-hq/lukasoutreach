import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { CONTACT_PROFILE_MAX_LENGTH, LEAD_STAGE_LABELS, type AddContactResponse, type LeadDetailResponse } from '../../../shared/leads.js';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import {
  INVITE_NOTE_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
  type ChatSyncStatus,
  type LinkedInAccountsResponse,
  type LinkedInWarmupResponse,
  type LinkedInAccountLimits,
  type LinkedInTestInviteResponse,
  type LinkedInTestConnectResponse,
  type LinkedInTestMessageResponse,
  type LinkedInTestProfileResponse,
} from '../../../shared/linkedin.js';
import { DuplicateEventError, LeadNotFoundError, type LeadStore } from '../leads/leadStore.js';
import { ROLE_MESSAGES, actingFounder, actorFor, assistantDenial } from '../auth/roles.js';
import type { FounderAccounts } from './founderAccounts.js';
import { LinkedInError, type LinkedInService } from './service.js';
import type { WarmupService } from './warmup.js';
import { ACCOUNT_LIMIT_MAX, type AccountPrefsStore } from './accountPrefs.js';

const AccountIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const AccountOrderSchema = z.object({ ids: z.array(AccountIdSchema).max(50) });
const limitField = (max: number) => z.number().int().min(0).max(max).nullable().optional();
const AccountLimitsSchema = z
  .object({
    profilesPerDay: limitField(ACCOUNT_LIMIT_MAX.profilesPerDay),
    searchResultsPerDay: limitField(ACCOUNT_LIMIT_MAX.searchResultsPerDay),
    invitesPerDay: limitField(ACCOUNT_LIMIT_MAX.invitesPerDay),
  })
  .strict();

/**
 * Routen laut Vertrag `shared/linkedin.ts`. Gesendet wird für den Besitzer des Leads über dessen Account (seit 18.10.,
 * vorher nur für den Gründer des Kontos). Admin-Konten (ohne Gründer) lehnt schon der Hook in `auth/auth.ts` ab (403 not_allowed, `auth/roles.ts`),
 * Mitarbeiter auf Leads anderer Gründer der Hook in `leads/routes.ts`.
 */

const IdParams = z.object({ id: z.string().min(1).max(64) });
const clientId = z.string().trim().min(1).max(64).optional();
const InviteSchema = z.object({
  message: z.string().trim().max(INVITE_NOTE_MAX_LENGTH, `Die Notiz darf höchstens ${INVITE_NOTE_MAX_LENGTH} Zeichen haben.`).optional(),
  clientId,
});
const MessageSchema = z.object({
  clientId,
  text: z.string().trim().min(1, 'Bitte einen Text eingeben.').max(MESSAGE_MAX_LENGTH, `Höchstens ${MESSAGE_MAX_LENGTH} Zeichen.`),
  label: z.string().trim().max(40).optional(),
});

const founderField = z.enum(AUTH_FOUNDER_IDS, `Gründer muss ${AUTH_FOUNDER_IDS.join(' oder ')} sein.`);
/** LinkedIn-Profil-Link (https://www.linkedin.com/in/…) oder öffentliche Kennung. */
const PROFILE_URL = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#\s]+)\/?(?:[?#].*)?$/i;
const PROFILE_ID = /^[A-Za-z0-9_%-]{2,100}$/;
const PROFILE_RULE = 'Bitte einen LinkedIn-Profil-Link (https://www.linkedin.com/in/…) oder die Kennung aus dem Link angeben.';
const TestInviteSchema = z.object({
  founder: founderField,
  profile: z.string(PROFILE_RULE).trim().min(1, PROFILE_RULE).max(300, PROFILE_RULE),
  message: z.string().trim().max(INVITE_NOTE_MAX_LENGTH, `Die Notiz darf höchstens ${INVITE_NOTE_MAX_LENGTH} Zeichen haben.`).optional(),
});
const ResumeSchema = z.object({ founder: founderField });
const ChatSyncSchema = z.object({ founder: founderField.optional() });
const ContactSchema = z.object({
  profile: z.string(PROFILE_RULE).trim().min(1, PROFILE_RULE).max(CONTACT_PROFILE_MAX_LENGTH, PROFILE_RULE),
  owner: founderField.optional(),
});
const TestProfileSchema = z.object({ founder: founderField, profile: z.string(PROFILE_RULE).trim().min(1, PROFILE_RULE).max(300, PROFILE_RULE) });
const TestConnectSchema = z.object({
  founder: founderField,
  message: z.string().trim().max(INVITE_NOTE_MAX_LENGTH, `Die Notiz darf höchstens ${INVITE_NOTE_MAX_LENGTH} Zeichen haben.`).optional(),
});
const TestMessageSchema = z.object({
  founder: founderField,
  text: z.string('Bitte einen Text eingeben.').trim().min(1, 'Bitte einen Text eingeben.').max(MESSAGE_MAX_LENGTH, `Höchstens ${MESSAGE_MAX_LENGTH} Zeichen.`),
});

/** Profil-Link oder Kennung → öffentliche Kennung (wie `linkedinCli test-anfrage`); null = ungültig. */
export function profileIdentifier(input: string): string | null {
  const text = input.trim();
  const fromUrl = text.match(PROFILE_URL)?.[1];
  let identifier = fromUrl ?? text;
  try {
    identifier = decodeURIComponent(identifier);
  } catch {
    return null;
  }
  return fromUrl ? (identifier.length > 0 && identifier.length <= 100 && !/[\s/]/.test(identifier) ? identifier : null) : PROFILE_ID.test(text) ? identifier : null;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, retryAfter?: number) {
  if (retryAfter) reply.header('Retry-After', String(retryAfter));
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

export function registerLinkedInRoutes(
  app: FastifyInstance,
  {
    leads,
    linkedin,
    founderAccounts,
    warmup,
    accountPrefs,
  }: { leads: LeadStore; linkedin: LinkedInService; founderAccounts?: FounderAccounts; warmup?: WarmupService; accountPrefs?: AccountPrefsStore },
) {
  const detail = (id: string): LeadDetailResponse => ({ lead: leads.get(id)!, events: leads.events(id) });

  /**
   * Für wen gesendet wird (Wunsch des Nutzers 18.10.): immer für den **Besitzer des Leads** und über dessen Account –
   * auch wenn der andere Gründer die Aufgabe unter „Alle“ erledigt; `actor` = wer geklickt hat. Gehört ein neuer Lead
   * einem Gründer, dessen LinkedIn-Account nicht verbunden ist, wird vorher der Klickende (sonst der andere) Besitzer –
   * wie beim Eintragen von Hand (`POST /api/leads/:id/events`).
   */
  const ownerFor = async (id: string, user: Parameters<typeof actorFor>[0], invite: boolean): Promise<AuthFounderId | null> => {
    const lead = leads.get(id);
    if (!lead) return actingFounder(user);
    if (!invite || lead.stage !== 'new' || !founderAccounts) return lead.owner;
    const available = await founderAccounts.available();
    if (available[lead.owner]) return lead.owner;
    const me = actingFounder(user);
    const to = me && available[me] ? me : (AUTH_FOUNDER_IDS.find((id) => id !== lead.owner && available[id]) ?? null);
    if (!to) return lead.owner;
    leads.update(id, { owner: to }, to, Date.now(), actorFor(user, to));
    return to;
  };

  const handle = async (reply: FastifyReply, id: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      if (error instanceof DuplicateEventError) return { ...detail(id), duplicate: true };
      if (error instanceof LeadNotFoundError) return sendError(reply, 404, 'not_found', error.message);
      if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
    return detail(id);
  };

  app.get('/api/linkedin/status', async () => linkedin.status());

  app.post('/api/linkedin/sync', async () => linkedin.sync());

  // Chats nachträglich abgleichen (Vertrag shared/linkedin.ts, 19.10.): läuft im Hintergrund, Fortschritt per GET.
  app.get('/api/linkedin/chat-sync', async (): Promise<ChatSyncStatus> => linkedin.chatSyncStatus);

  app.post('/api/linkedin/chat-sync', async (request, reply) => {
    const body = ChatSyncSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    const founder = body.data.founder;
    const denied = founder ? assistantDenial(request.authUser ?? null, founder, (id) => linkedin.founderName(id)) : null;
    if (denied) return sendError(reply, 403, 'not_allowed', denied);
    try {
      const { started } = linkedin.startChatSync(founder);
      if (started) request.log.info({ founder: founder ?? 'alle', by: request.authUser?.username }, 'Chat-Abgleich gestartet');
      return reply.status(started ? 202 : 200).send(linkedin.chatSyncStatus);
    } catch (error) {
      if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
  });

  // ── Einrichten in der Oberfläche (Rechte: Hook in auth.ts → `roleDenial`) ──

  app.get('/api/linkedin/accounts', async (_request, reply) => {
    try {
      const body: LinkedInAccountsResponse = { accounts: await linkedin.unipileAccounts() };
      return body;
    } catch (error) {
      if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
  });

  // Einstellungen je Account (21.10.): eigene Tagesgrenzen und Such-Reihenfolge – gleiche Rechte wie die Account-Liste.
  app.put('/api/linkedin/accounts/order', async (request, reply) => {
    const body = AccountOrderSchema.safeParse(request.body ?? {});
    if (!body.success || !accountPrefs) return sendError(reply, 400, 'invalid_request', 'Bitte die Accounts in der gewünschten Reihenfolge schicken.');
    accountPrefs.setOrder(body.data.ids);
    return { ok: true };
  });

  app.put('/api/linkedin/accounts/:id/limits', async (request, reply) => {
    const id = AccountIdSchema.safeParse((request.params as { id?: string }).id);
    const body = AccountLimitsSchema.safeParse(request.body ?? {});
    if (!id.success || !body.success || !accountPrefs) {
      return sendError(reply, 400, 'invalid_request', `Grenzen: ganze Zahlen ab 0 – Profile höchstens ${ACCOUNT_LIMIT_MAX.profilesPerDay}, Suchtreffer ${ACCOUNT_LIMIT_MAX.searchResultsPerDay.toLocaleString('de-DE')}, Anfragen ${ACCOUNT_LIMIT_MAX.invitesPerDay}; leer = Standard.`);
    }
    const { profilesPerDay, searchResultsPerDay, invitesPerDay } = accountPrefs.setLimits(id.data, body.data);
    const result: LinkedInAccountLimits = { profilesPerDay, searchResultsPerDay, invitesPerDay };
    return result;
  });

  // Accounts aufwärmen (21.10.): Stand je Account – gleiche Rechte wie die Account-Liste.
  app.get('/api/linkedin/warmup', async () => {
    const body: LinkedInWarmupResponse = warmup ? warmup.status() : { mode: linkedin.mode, accounts: [], poolLeft: 0 };
    return body;
  });

  app.post('/api/linkedin/test-invite', async (request, reply) => {
    const body = TestInviteSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    const identifier = profileIdentifier(body.data.profile);
    if (!identifier) return sendError(reply, 400, 'invalid_request', PROFILE_RULE);
    // Gründer nur über den eigenen Account (Admins und Mitarbeiter sperrt schon der Hook, `roleDenial`).
    const user = request.authUser;
    if (user && user.founder !== body.data.founder) return sendError(reply, 403, 'not_allowed', ROLE_MESSAGES.linkedinOwnAccount);
    if (linkedin.mode === 'mock') {
      const simulated: LinkedInTestInviteResponse = { ok: true, message: 'Simulation – nichts gesendet.' };
      return simulated;
    }
    try {
      const { name } = await linkedin.testInvite(body.data.founder, identifier, body.data.message);
      request.log.info({ founder: body.data.founder, by: request.authUser?.username }, 'LinkedIn-Test-Anfrage gesendet');
      const sent: LinkedInTestInviteResponse = { ok: true, message: `Anfrage an ${name} gesendet.` };
      return sent;
    } catch (error) {
      if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
  });

  // Test-LinkedIn-Account (Vertrag shared/linkedin.ts): prüfen, speichern, genau eine Test-Nachricht senden.
  app.get('/api/linkedin/test-profile', async (): Promise<LinkedInTestProfileResponse> => ({ profile: linkedin.testProfile() }));

  app.put('/api/linkedin/test-profile', async (request, reply) => {
    const body = TestProfileSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    const identifier = profileIdentifier(body.data.profile);
    if (!identifier) return sendError(reply, 400, 'invalid_request', PROFILE_RULE);
    const user = request.authUser;
    if (user && user.founder !== body.data.founder) return sendError(reply, 403, 'not_allowed', ROLE_MESSAGES.linkedinOwnAccount);
    try {
      const response: LinkedInTestProfileResponse = { profile: await linkedin.setTestProfile(body.data.founder, identifier) };
      return response;
    } catch (error) {
      if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
  });

  app.delete('/api/linkedin/test-profile', async (): Promise<LinkedInTestProfileResponse> => {
    linkedin.clearTestProfile();
    return { profile: null };
  });

  app.post('/api/linkedin/test-message', async (request, reply) => {
    const body = TestMessageSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    const user = request.authUser;
    if (user && user.founder !== body.data.founder) return sendError(reply, 403, 'not_allowed', ROLE_MESSAGES.linkedinOwnAccount);
    try {
      const { name } = await linkedin.testMessage(body.data.founder, body.data.text);
      const simulated = linkedin.mode === 'mock';
      if (!simulated) request.log.info({ founder: body.data.founder, by: request.authUser?.username }, 'LinkedIn-Test-Nachricht gesendet');
      const response: LinkedInTestMessageResponse = { ok: true, message: simulated ? `Test – an ${name} wurde nichts gesendet.` : `Test-Nachricht an ${name} gesendet. Schau auf LinkedIn nach, ob sie angekommen ist.` };
      return response;
    } catch (error) {
      if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
  });

  app.post('/api/linkedin/test-connect', async (request, reply) => {
    const body = TestConnectSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    const user = request.authUser;
    if (user && user.founder !== body.data.founder) return sendError(reply, 403, 'not_allowed', ROLE_MESSAGES.linkedinOwnAccount);
    try {
      const { name } = await linkedin.testConnect(body.data.founder, body.data.message);
      const simulated = linkedin.mode === 'mock';
      if (!simulated) request.log.info({ founder: body.data.founder, by: request.authUser?.username }, 'LinkedIn-Test-Vernetzungsanfrage gesendet');
      const response: LinkedInTestConnectResponse = {
        ok: true,
        message: simulated ? `Test – an ${name} wurde keine Anfrage gesendet.` : `Test-Vernetzungsanfrage an ${name} gesendet. Schau auf LinkedIn nach, ob sie angekommen ist.`,
      };
      return response;
    } catch (error) {
      if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
      throw error;
    }
  });

  app.post('/api/linkedin/resume', async (request, reply) => {
    const body = ResumeSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    // Mitarbeiter nur für den eigenen Gründer; Gründer und Admin für beide.
    const denied = assistantDenial(request.authUser ?? null, body.data.founder, (id) => linkedin.founderName(id));
    if (denied) return sendError(reply, 403, 'not_allowed', denied);
    return linkedin.resume(body.data.founder);
  });

  /**
   * Persönlicher Kontakt per Link (Vertrag `shared/leads.ts`, Wunsch des Nutzers 19.10.): ein Profilabruf über den
   * Account des Besitzers, dann Lead anlegen – oder den vorhandenen zurückgeben. Keine Suche, keine KI, nichts gesendet.
   */
  app.post('/api/leads/contact', async (request, reply) => {
    const body = ContactSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    const identifier = profileIdentifier(body.data.profile);
    if (!identifier) return sendError(reply, 400, 'invalid_request', PROFILE_RULE);
    const user = request.authUser ?? null;
    const owner = body.data.owner ?? actingFounder(user);
    if (!owner) return sendError(reply, 400, 'invalid_request', 'Bitte angeben, wem der Kontakt gehört (owner).');
    const denial = assistantDenial(user, owner, (id) => linkedin.founderName(id));
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
    // Schon da (Kennung aus dem Link)? Dann ohne Profilabruf antworten.
    const known = leads.findByPublicIdentifier(identifier);
    let result;
    if (known) {
      result = { lead: known, created: false, imported: 0, chatFailed: false };
    } else {
      try {
        const contact = await linkedin.lookupContact(owner, identifier);
        result = { ...leads.createContact(contact, owner, Date.now(), actorFor(user, owner)), imported: 0, chatFailed: false };
        // Vernetzt: bestehende Unterhaltung gleich mitnehmen (Wunsch des Nutzers 19.10.).
        if (result.created && result.lead.stage === 'connected') {
          const chat = await linkedin.importContactChat(result.lead.id);
          if (chat) result = { ...result, lead: chat.lead, imported: chat.imported };
          else result = { ...result, chatFailed: true };
        }
      } catch (error) {
        if (error instanceof LinkedInError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
        throw error;
      }
    }
    const { lead, created, imported, chatFailed } = result;
    const name = [lead.person.firstName, lead.person.lastName].filter(Boolean).join(' ');
    const chatText = imported
      ? ` ${imported === 1 ? 'Eine Nachricht' : `${imported} Nachrichten`} aus dem LinkedIn-Chat übernommen.`
      : chatFailed
        ? ' Den LinkedIn-Chat konnte das Cockpit gerade nicht lesen.'
        : '';
    const response: AddContactResponse = {
      lead,
      created,
      importedMessages: imported,
      message: created
        ? `${name} ist jetzt unter „${LEAD_STAGE_LABELS[lead.stage]}“.${lead.stage === 'new' ? ' Ihr seid auf LinkedIn noch nicht vernetzt.' : ''}${chatText}`
        : `${name} gibt es schon – unter „${LEAD_STAGE_LABELS[lead.stage]}“ bei ${linkedin.founderName(lead.owner)}.`,
    };
    if (created) request.log.info({ leadId: lead.id, owner }, 'Persönlicher Kontakt per Link aufgenommen');
    return reply.status(created ? 201 : 200).send(response);
  });

  app.post('/api/leads/:id/linkedin/invite', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const body = InviteSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    return handle(reply, params.data.id, async () => {
      const before = leads.get(params.data.id)?.owner ?? null;
      const owner = await ownerFor(params.data.id, request.authUser, true);
      try {
        return await linkedin.invite(params.data.id, owner, body.data.message, actorFor(request.authUser, owner), body.data.clientId);
      } catch (error) {
        // Übernommen, aber nichts gesendet (Limit, Pause, Fehler): zurück zum bisherigen Besitzer – „Mit der Anfrage
        // gehört der Lead dir“ gilt erst, wenn die Anfrage wirklich rausging (25.10.).
        const now = leads.get(params.data.id);
        if (before && owner && owner !== before && now && now.owner === owner && now.stage === 'new') {
          leads.update(params.data.id, { owner: before }, before, Date.now(), actorFor(request.authUser, before));
        }
        throw error;
      }
    });
  });

  app.post('/api/leads/:id/linkedin/message', async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return sendError(reply, 404, 'not_found', 'Lead nicht gefunden.');
    const body = MessageSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.issues.map((issue) => issue.message).join(' '));
    return handle(reply, params.data.id, async () => {
      const owner = await ownerFor(params.data.id, request.authUser, false);
      return linkedin.message(params.data.id, owner, body.data.text, body.data.label, actorFor(request.authUser, owner), body.data.clientId);
    });
  });
}
