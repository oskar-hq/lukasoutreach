import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACCOUNT_NAME_MAX_LENGTH,
  AUTH_FOUNDER_IDS,
  AUTH_ROLES,
  authRole,
  canManageAccounts,
  invitableRoles,
  type AccountInfo,
  type AccountListResponse,
  type AuthErrorCode,
  type AuthFounderId,
  type AuthUser,
  type CreateInviteResponse,
} from '../../../shared/auth.js';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import type { Database } from '../db/database.js';
import {
  USERNAME_RULE,
  assistantFounders,
  compareAccounts,
  founderTakenMessage,
  normalizeUsername,
  onboardingFor,
  roleProblem,
  validUsername,
  type Account,
  type AccountStore,
} from './accounts.js';
import type { AccountChange } from '../notify/notifications.js';
import type { InviteStore } from './invites.js';
import type { SessionStore } from './sessions.js';

/**
 * Konten verwalten laut Vertrag (`shared/auth.ts` → „Rollen und Rechte“):
 *   GET    /api/accounts            Admin und Gründer alle, Mitarbeiter 403
 *   POST   /api/accounts/invite     Einladungslink (neues Konto) oder `reset` (Passwort neu setzen)
 *   DELETE /api/accounts/:username  Konto entfernen bzw. offene Einladung zurückziehen bzw. Registrierung ablehnen
 *   POST   /api/accounts/:username/approve  offene Registrierung freigeben (Rolle und Gründer festlegen)
 * Dieselbe Einladungs-Logik wie `accountsCli invite` (`InviteStore`). Das Token steht nur in der Antwort – nie im Log.
 */

const MESSAGES = {
  unauthorized: 'Bitte melde dich an.',
  notAllowed: 'Mitarbeiter-Konten können keine Konten verwalten.',
  founderOnly: 'Gründer-Konten können nur Gründer anlegen oder freigeben. Als Admin lädst du Admins und Mitarbeiter ein.',
  lastManager:
    'Das ist das letzte Konto, das Konten verwalten kann (Admin oder Gründer). Lade zuerst ein weiteres Admin- oder Gründer-Konto ein und lass es den Link einlösen.',
  ownAccount: 'Dein eigenes Konto kannst du hier nicht entfernen.',
  demoRemove: 'Testkonten stehen nur im Speicher und lassen sich nicht entfernen.',
  demoReset: 'Testkonten haben das feste Passwort „demo“ und lassen sich nicht zurücksetzen.',
  notFound: 'Dieses Konto gibt es nicht.',
  exists: 'Diesen Anmeldenamen gibt es schon. Für ein neues Passwort wähle „Passwort neu setzen“.',
  name: `Bitte gib einen Anzeigenamen mit 1 bis ${ACCOUNT_NAME_MAX_LENGTH} Zeichen ein.`,
  role: 'Bitte wähle eine Rolle: Admin, Gründer oder Mitarbeiter.',
  noRegistration: 'Diese Registrierung gibt es nicht mehr – vielleicht hat schon jemand anderes freigegeben oder abgelehnt.',
} as const;

const founderEnum = z.enum(AUTH_FOUNDER_IDS, `Gründer muss ${AUTH_FOUNDER_IDS.join(' oder ')} sein.`);

const InviteSchema = z.object({
  username: z.string('Bitte gib einen Anmeldenamen ein.').max(100, USERNAME_RULE),
  name: z.string(MESSAGES.name).optional(),
  role: z.enum(AUTH_ROLES, MESSAGES.role).optional(),
  founder: founderEnum.nullable().optional(),
  founders: z.array(founderEnum).max(AUTH_FOUNDER_IDS.length * 2).optional(),
  reset: z.boolean('reset muss true oder false sein.').optional(),
});

const ApproveSchema = z.object({
  role: z.enum(AUTH_ROLES, MESSAGES.role),
  founder: founderEnum.nullable().optional(),
  founders: z.array(founderEnum).max(AUTH_FOUNDER_IDS.length * 2).optional(),
});

/** 403-Satz, wenn die Rolle nicht eingeladen/freigegeben werden darf. */
function roleRefusal(user: AuthUser): string {
  return authRole(user) === 'assistant' ? MESSAGES.notAllowed : MESSAGES.founderOnly;
}

function sendError(reply: FastifyReply, status: number, code: AuthErrorCode, message: string) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

export interface AccountRouteDeps {
  db: Database;
  accounts: AccountStore;
  sessions: SessionStore;
  invites: InviteStore;
  /** Jede Änderung an Konten (Einladung, Passwort-Link, Freigabe, Entfernen) – Neuigkeit an alle Gründer + Slack. */
  onAccountChange?: (change: AccountChange) => void;
}

/**
 * Rolle mit Kontenverwaltung (Admin, Gründer). Seit „nie auf die Shell“ (06.10.) verwalten Gründer Konten wie Admins:
 * alle sehen, jede Rolle einladen, alle zurücksetzen und entfernen.
 */
function managesAccounts(role: Account['role']): boolean {
  return canManageAccounts({ role, founder: null });
}

/** Angaben für `AccountInfo` (ohne Einführung und Hash). */
function accountInfo(account: Account): Pick<AccountInfo, 'username' | 'name' | 'role' | 'founder' | 'founders'> {
  const info: Pick<AccountInfo, 'username' | 'name' | 'role' | 'founder' | 'founders'> = {
    username: account.username,
    name: account.name,
    role: account.role,
    founder: account.founder,
  };
  if (account.founders) info.founders = [...account.founders];
  return info;
}

/** Ablauf eines noch gültigen Links eines bestehenden Kontos (abgelaufene: null). */
function openExpiry(invite: { expiresAt: number } | undefined, now: number): number | null {
  return invite && invite.expiresAt > now ? invite.expiresAt : null;
}

export function registerAccountRoutes(app: FastifyInstance, { db, accounts, sessions, invites, onAccountChange }: AccountRouteDeps) {
  /** Gibt es für `founder` schon ein Gründer-Konto oder eine offene Gründer-Einladung unter einem anderen Namen? */
  const founderTaken = (founder: AuthFounderId, username: string, now = Date.now()): string | null => {
    const account = accounts.founderAccount(founder, username);
    if (account) return founderTakenMessage(accounts.founderName(founder), account.username);
    const invite = invites
      .unused()
      .find((item) => !item.reset && item.role === 'founder' && item.founder === founder && item.username !== username && item.expiresAt > now);
    return invite ? founderTakenMessage(accounts.founderName(founder), `eingeladen als ${invite.username}`) : null;
  };
  const changed = (user: AuthUser, change: Omit<AccountChange, 'by'>) => {
    try {
      onAccountChange?.({ ...change, by: { username: user.username, name: user.name } });
    } catch (error) {
      app.log.error({ err: error instanceof Error ? error.message : String(error) }, 'Neuigkeit zur Kontoänderung nicht gespeichert');
    }
  };

  /** Angemeldet und darf Konten verwalten – sonst Antwort 401/403 (der Hook in `auth.ts` prüft schon, hier doppelt). */
  const manager = (request: FastifyRequest, reply: FastifyReply): AuthUser | null => {
    const user = request.authUser;
    if (!user) {
      sendError(reply, 401, 'unauthorized', MESSAGES.unauthorized);
      return null;
    }
    if (!canManageAccounts(user)) {
      sendError(reply, 403, 'not_allowed', MESSAGES.notAllowed);
      return null;
    }
    return user;
  };

  app.get('/api/accounts', async (request, reply) => {
    const user = manager(request, reply);
    if (!user) return reply;
    const now = Date.now();
    const unused = new Map(invites.unused().map((invite) => [invite.username, invite]));
    const entries = new Map<string, AccountInfo>();
    for (const account of accounts.list()) {
      entries.set(account.username, { ...accountInfo(account), demo: false, pending: false, inviteExpiresAt: openExpiry(unused.get(account.username), now) });
    }
    for (const account of accounts.listDemo()) {
      if (!entries.has(account.username)) entries.set(account.username, { ...accountInfo(account), demo: true, pending: false, inviteExpiresAt: null });
    }
    // Nicht eingelöste Einladungen für Konten, die es noch nicht gibt – auch abgelaufene (dann ist ein neuer Link nötig).
    for (const invite of unused.values()) {
      if (entries.has(invite.username) || invite.reset || roleProblem(invite.role, invite.founder)) continue;
      entries.set(invite.username, {
        username: invite.username,
        name: invite.name,
        role: invite.role,
        founder: invite.founder,
        ...(invite.founders ? { founders: invite.founders } : {}),
        demo: false,
        pending: true,
        inviteExpiresAt: invite.expiresAt,
      });
    }
    // Offene Registrierungen zuerst (älteste oben) – sie warten auf eine Entscheidung.
    const waiting: AccountInfo[] = accounts.listRegistrations().map((registration) => ({
      username: registration.username,
      name: registration.name,
      role: 'assistant',
      founder: null,
      awaitingApproval: true,
      registeredAt: registration.createdAt,
      demo: false,
      pending: false,
      inviteExpiresAt: null,
    }));
    const body: AccountListResponse = { accounts: [...waiting, ...[...entries.values()].sort(compareAccounts)] };
    return body;
  });

  app.post('/api/accounts/invite', async (request, reply) => {
    const user = manager(request, reply);
    if (!user) return reply;
    const parsed = InviteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join(' '));
    const username = normalizeUsername(parsed.data.username);
    if (!validUsername(username)) return sendError(reply, 400, 'invalid_request', USERNAME_RULE);

    let invite: { username: string; name: string; role: Account['role']; founder: Account['founder']; founders?: Account['founders']; reset: boolean };
    if (parsed.data.reset === true) {
      // Passwort neu setzen: Name, Rolle und Gründer bleiben, Angaben dazu werden ignoriert.
      if (accounts.isDemo(username)) return sendError(reply, 400, 'invalid_request', MESSAGES.demoReset);
      const target = accounts.findStored(username);
      if (!target) return sendError(reply, 404, 'not_found', MESSAGES.notFound);
      invite = { username, name: target.name, role: target.role, founder: target.founder, founders: target.founders, reset: true };
    } else {
      const role = parsed.data.role;
      if (!role) return sendError(reply, 400, 'invalid_request', MESSAGES.role);
      if (!invitableRoles(user).includes(role)) return sendError(reply, 403, 'not_allowed', roleRefusal(user));
      let founder = parsed.data.founder ?? null;
      // Abwärtsverträglich: Lädt ein Gründer einen Mitarbeiter ohne Angabe des Gründers ein, arbeitet der für ihn.
      if (founder === null && role === 'assistant' && authRole(user) === 'founder') founder = user.founder;
      const problem = roleProblem(role, founder);
      if (problem) return sendError(reply, 400, 'invalid_request', problem);
      const occupied = role === 'founder' && founder ? founderTaken(founder, username) : null;
      if (occupied) return sendError(reply, 409, 'account_exists', occupied);
      const name = (parsed.data.name ?? '').trim();
      if (!name || name.length > ACCOUNT_NAME_MAX_LENGTH) return sendError(reply, 400, 'invalid_request', MESSAGES.name);
      // Vergeben: echtes Konto, Testkonto oder offene Registrierung (ein Link würde sonst ein zweites Konto anlegen).
      if (accounts.taken(username)) return sendError(reply, 409, 'account_exists', MESSAGES.exists);
      // Eine offene Einladung desselben Namens wird ersetzt (`invites.create` macht ältere Links ungültig).
      invite = { username, name, role, founder, founders: assistantFounders(role, founder, parsed.data.founders), reset: false };
    }

    // Ein neuer Link macht ältere Links desselben Namens ungültig (wie beim Befehl).
    const { token, expiresAt } = invites.create(invite);
    request.log.info({ username, role: invite.role, reset: invite.reset, by: user.username }, 'Einladungslink erzeugt');
    changed(user, { action: invite.reset ? 'reset_link' : 'invited', username, name: invite.name, role: invite.role, founder: invite.founder });
    const body: CreateInviteResponse = { token, username, expiresAt };
    return body;
  });

  app.post('/api/accounts/:username/approve', async (request, reply) => {
    const user = manager(request, reply);
    if (!user) return reply;
    const raw = (request.params as { username?: unknown }).username;
    const username = normalizeUsername(typeof raw === 'string' ? raw : '');
    const parsed = ApproveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join(' '));
    const role = parsed.data.role;
    if (!invitableRoles(user).includes(role)) return sendError(reply, 403, 'not_allowed', roleRefusal(user));
    let founder = parsed.data.founder ?? null;
    // Wie beim Einladen: Gibt ein Gründer einen Mitarbeiter ohne Angabe frei, arbeitet der für ihn.
    if (founder === null && role === 'assistant' && authRole(user) === 'founder') founder = user.founder;
    const problem = roleProblem(role, founder);
    if (problem) return sendError(reply, 400, 'invalid_request', problem);

    let approved: Account | null = null;
    let occupied: string | null = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const registration = accounts.registration(username);
      // In der Transaktion: Je Gründer höchstens ein Gründer-Konto – auch bei zwei gleichzeitigen Freigaben.
      occupied = registration && role === 'founder' && founder ? founderTaken(founder, username) : null;
      // Nur, solange niemand anderes schon entschieden hat und der Name nicht inzwischen vergeben ist.
      if (registration && !occupied && !accounts.exists(username)) {
        const account: Account = { username, name: registration.name, role, founder, onboarding: onboardingFor(role) };
        const founders = assistantFounders(role, founder, parsed.data.founders);
        if (founders) account.founders = founders;
        accounts.saveHash(account, registration.passwordHash);
        accounts.removeRegistration(username);
        approved = account;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (occupied) return sendError(reply, 409, 'account_exists', occupied);
    if (!approved) return sendError(reply, 404, 'not_found', MESSAGES.noRegistration);
    request.log.info({ username, role, by: user.username }, 'Registrierung freigegeben');
    changed(user, { action: 'approved', username, name: approved.name, role, founder });
    const body: AccountInfo = { ...accountInfo(approved), demo: false, pending: false, inviteExpiresAt: null };
    return body;
  });

  app.delete('/api/accounts/:username', async (request, reply) => {
    const user = manager(request, reply);
    if (!user) return reply;
    const raw = (request.params as { username?: unknown }).username;
    const username = normalizeUsername(typeof raw === 'string' ? raw : '');
    if (username === user.username) return sendError(reply, 400, 'invalid_request', MESSAGES.ownAccount);

    // Offene Registrierung ablehnen: Eintrag und Sitzungen weg, ein Konto gleichen Namens gibt es nicht.
    if (!accounts.exists(username) && accounts.registration(username)) {
      let ended = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        accounts.removeRegistration(username);
        ended = sessions.deleteForUser(username);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      request.log.info({ username, by: user.username, sessions: ended }, 'Registrierung abgelehnt');
      return { ok: true };
    }
    if (accounts.isDemo(username)) return sendError(reply, 400, 'invalid_request', MESSAGES.demoRemove);

    // Konto oder – ohne Konto – die neueste nicht eingelöste Einladung (auch abgelaufen).
    const target = accounts.findStored(username) ?? (accounts.exists(username) ? null : invites.latestUnused(username));
    if (!target && !accounts.exists(username)) return sendError(reply, 404, 'not_found', MESSAGES.notFound);
    // Nie das letzte eingelöste Konto mit Kontenverwaltung – sonst käme niemand mehr ohne Shell an die Konten.
    // Testkonten zählen nicht (nur im Speicher, nur zum Ausprobieren); offene Einladungen auch nicht.
    if (target && accounts.exists(username) && managesAccounts(target.role)) {
      const others = accounts.list().filter((account) => account.username !== username && managesAccounts(account.role));
      if (others.length === 0) return sendError(reply, 400, 'invalid_request', MESSAGES.lastManager);
    }

    let ended = 0;
    let revoked = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      accounts.remove(username);
      revoked = invites.discard(username);
      ended = sessions.deleteForUser(username);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    request.log.info({ username, by: user.username, sessions: ended, invites: revoked }, 'Konto entfernt');
    if (target) changed(user, { action: 'removed', username, name: target.name, role: target.role, founder: target.founder });
    return { ok: true };
  });
}
