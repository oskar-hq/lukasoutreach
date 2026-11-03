import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACCOUNT_NAME_MAX_LENGTH,
  AUTH_FOUNDER_IDS,
  AUTH_OPEN_ROUTES,
  MAX_OPEN_REGISTRATIONS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type AuthErrorCode,
  type AuthResponse,
  type AuthUser,
  type InviteInfo,
  type SetupInfo,
} from '../../../shared/auth.js';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { SETUP_TOKEN_MIN_LENGTH, type Config } from '../config.js';
import type { Database } from '../db/database.js';
import { registerAccountRoutes } from './accountRoutes.js';
import type { AccountChange } from '../notify/notifications.js';
import { AccountStore, USERNAME_RULE, founderTakenMessage, normalizeUsername, onboardingFor, publicAccount, validUsername, type Account } from './accounts.js';
import { InviteStore } from './invites.js';
import { dummyPasswordHash, hashPassword, passwordLengthOk, verifyPassword } from './password.js';
import { InviteLimiter, LoginLimiter, REGISTER_RULE } from './rateLimit.js';
import { roleDenial } from './roles.js';
import { REMEMBER_MS, SessionStore } from './sessions.js';
import { SetupTokenStore, setupLink } from './setupToken.js';

/**
 * Anmeldung und Sitzung laut Vertrag `shared/auth.ts`:
 * Routen `/api/auth/login|logout|me`, Sitzungs-Cookie, Begrenzung der Fehlversuche, Schutz gegen fremde Formulare
 * und – mit `requireSession` – 401 für alle übrigen `/api/*`-Routen ohne gültige Sitzung.
 */

export const SESSION_COOKIE = 'cockpit_session';

/**
 * Interne Aufrufe im Namen eines Kontos (MCP-Server, `server/src/mcp/`): Claude bedient das Cockpit über dieselben Routen
 * wie die Oberfläche – mit denselben Rechten, Limits und Prüfungen. Nur über `app.inject` im selben Prozess: Das
 * Geheimnis entsteht beim Start zufällig und verlässt den Prozess nie; von außen lässt sich der Header nicht nutzen.
 */
const INTERNAL_SECRET = randomBytes(32).toString('hex');
const INTERNAL_HEADER = 'x-cockpit-internal';
const INTERNAL_USER_HEADER = 'x-cockpit-user';

export function internalAuthHeaders(username: string): Record<string, string> {
  return { [INTERNAL_HEADER]: INTERNAL_SECRET, [INTERNAL_USER_HEADER]: username };
}

function internalUsername(request: FastifyRequest): string | null {
  const secret = request.headers[INTERNAL_HEADER];
  const username = request.headers[INTERNAL_USER_HEADER];
  if (typeof secret !== 'string' || typeof username !== 'string' || secret.length !== INTERNAL_SECRET.length) return null;
  return timingSafeEqual(Buffer.from(secret), Buffer.from(INTERNAL_SECRET)) ? username : null;
}

const LoginSchema = z.object({
  username: z.string().max(100),
  password: z.string().max(200),
  remember: z.boolean().optional(),
});

const MESSAGES: Record<AuthErrorCode, string> = {
  unauthorized: 'Bitte melde dich an.',
  invalid_credentials: 'Name oder Passwort ist falsch.',
  too_many_attempts: 'Zu viele Fehlversuche.',
  invalid_request: 'Bitte gib Name und Passwort ein.',
  forbidden: 'Diese Anfrage kommt nicht von dieser Seite und wurde abgelehnt.',
  invite_invalid: 'Dieser Link gilt nicht mehr – er ist abgelaufen oder wurde schon benutzt. Bitte frag nach einem neuen.',
  weak_password: `Das Passwort braucht ${PASSWORD_MIN_LENGTH} bis ${PASSWORD_MAX_LENGTH} Zeichen.`,
  not_allowed: 'Dafür fehlen deinem Konto die Rechte.',
  not_found: 'Dieses Konto gibt es nicht.',
  account_exists: 'Diesen Anmeldenamen gibt es schon.',
  awaiting_approval: 'Dein Konto wartet noch auf Freigabe durch einen Gründer.',
  setup_required:
    'Das erste Konto legst du nur über den Einrichtungs-Link an. Er steht im Protokoll des Servers: docker compose logs backend | grep Einrichtung',
};

const RegisterSchema = z.object({
  username: z.string('Bitte gib einen Anmeldenamen ein.').max(100, USERNAME_RULE),
  name: z.string(`Bitte gib deinen Namen ein (1 bis ${ACCOUNT_NAME_MAX_LENGTH} Zeichen).`),
  password: z.string('Bitte gib ein Passwort ein.'),
  remember: z.boolean().optional(),
  setupToken: z.string().max(200).optional(),
});

const REGISTER_MESSAGES = {
  name: `Bitte gib deinen Namen ein (1 bis ${ACCOUNT_NAME_MAX_LENGTH} Zeichen).`,
  password: 'Bitte gib ein Passwort ein.',
  full: 'Gerade warten schon sehr viele Registrierungen auf Freigabe. Bitte frag einen Gründer, ob er sie durchsieht, und versuch es dann noch einmal.',
  exists: 'Diesen Anmeldenamen gibt es schon. Bitte wähle einen anderen oder melde dich an.',
} as const;

/** Einladung: eigene Sätze für fehlende Angaben. */
const INVITE_MISSING_TOKEN = 'Der Link ist unvollständig. Bitte öffne ihn noch einmal genau so, wie du ihn bekommen hast.';
const INVITE_MISSING_PASSWORD = 'Bitte gib ein Passwort ein.';

declare module 'fastify' {
  interface FastifyRequest {
    /** Angemeldeter Nutzer (gesetzt für geschützte Routen und `/api/auth/me`). */
    authUser: AuthUser | null;
  }
}

export interface AuthOptions {
  config: Config;
  db: Database;
  /** Ohne gültige Sitzung antworten alle `/api/*`-Routen außer `AUTH_OPEN_ROUTES` mit 401. */
  requireSession: boolean;
  limiter?: LoginLimiter;
  inviteLimiter?: InviteLimiter;
  /** Registrierungen je IP (Vertrag: 5 pro Stunde). */
  registerLimiter?: InviteLimiter;
  /** Neue Registrierung wartet auf Freigabe – für Neuigkeiten (`shared/notifications.ts`). */
  onRegistered?: (registration: { username: string; name: string }) => void;
  /** Änderung an Konten (`/api/accounts*`) – Neuigkeit an alle Gründer (Sicherheitsprüfung 08.10.). */
  onAccountChange?: (change: AccountChange) => void;
}

function sendAuthError(reply: FastifyReply, status: number, code: AuthErrorCode, message = MESSAGES[code]) {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}

export function cookieHeader(config: Config, value: string, maxAgeSeconds: number | null): string {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== null) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (config.auth.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(reply: FastifyReply, config: Config) {
  reply.header('Set-Cookie', cookieHeader(config, '', 0));
}

/** Minuten für die Meldung, aufgerundet („Bitte warte 15 Minuten.“). */
function waitMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${MESSAGES.too_many_attempts} Bitte warte ${minutes === 1 ? 'eine Minute' : `${minutes} Minuten`} und versuch es dann noch einmal.`;
}

function pathOf(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerAuth(
  app: FastifyInstance,
  {
    config,
    db,
    requireSession,
    limiter = new LoginLimiter(),
    inviteLimiter = new InviteLimiter(),
    registerLimiter = new InviteLimiter(REGISTER_RULE),
    onRegistered,
    onAccountChange,
  }: AuthOptions,
) {
  const accounts = new AccountStore(db);
  const setupToken = new SetupTokenStore(config.dataDir, config.auth.setupToken);
  const sessions = new SessionStore(db);
  const invites = new InviteStore(db);
  const openRoutes = new Set(AUTH_OPEN_ROUTES);

  app.decorateRequest('authUser', null);

  app.addHook('onReady', async () => {
    if (config.auth.demoAccounts) {
      await accounts.enableDemoAccounts();
      app.log.warn('Testkonten nick/johannes/admin/mitarbeiter (Passwort „demo“) sind eingeschaltet – nur für Entwicklung und Tests.');
    }
    // Dummy-Hash vorab berechnen, damit schon der erste Fehlversuch mit unbekanntem Namen gleich lange dauert.
    await dummyPasswordHash();
    invites.prune();
    if (config.auth.setupTokenIgnored) {
      app.log.warn(
        `SETUP_TOKEN ist kürzer als ${SETUP_TOKEN_MIN_LENGTH} Zeichen und wird ignoriert – setz einen längeren Wert (z. B. openssl rand -hex 32) oder lass ihn leer.` +
          (setupMode() ? ' Für das erste Konto gilt der Zufallsschlüssel aus dem Datenordner (Link folgt).' : ''),
      );
    }
    // Noch kein Konto: Einrichtungs-Link ins Protokoll (nur er legt das erste Konto an). Sonst alte Datei weg.
    if (setupMode()) {
      logSetupLink();
    } else if (accounts.storedCount() > 0) {
      setupToken.clear();
    }
  });

  /** Antworten von `/api/auth/*` tragen die Namen der Gründer (Vertrag `AuthUser.founderNames`). */
  const withFounderNames = (user: AuthUser): AuthUser => ({ ...user, founderNames: accounts.founderNames() });

  /** Nutzer zur Sitzungs-ID aus dem Cookie – null, wenn Sitzung oder Konto fehlen. */
  function currentUser(request: FastifyRequest): AuthUser | null {
    const internal = internalUsername(request);
    if (internal) {
      const account = accounts.find(internal);
      return account ? publicAccount(account) : null;
    }
    const id = readCookie(request, SESSION_COOKIE);
    if (!id) return null;
    const session = sessions.get(id);
    const account = session ? accounts.find(session.username) : null;
    return account ? publicAccount(account) : null;
  }

  app.addHook('onRequest', async (request, reply) => {
    // Das erkannte Routenmuster, nicht die rohe Adresse: Der Router dekodiert %-Zeichen („/%61pi/settings“ trifft
    // „/api/settings“), ein Vergleich mit der rohen Adresse ließe sich so umgehen. Ohne Treffer (404) die Adresse.
    const path = request.routeOptions.url ?? pathOf(request.url);
    if (!path.startsWith('/api/')) return;

    // Schutz gegen Formulare fremder Seiten. Ohne Header (z. B. curl) schützt SameSite=Lax.
    const site = request.headers['sec-fetch-site'];
    if (!SAFE_METHODS.has(request.method) && typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return sendAuthError(reply, 403, 'forbidden');
    }

    if (openRoutes.has(path) || path === '/api/auth/me') return;
    // Angemeldeten Nutzer immer ermitteln (z. B. Zuständigkeit neuer Leads) – auch solange die Pflicht noch aus ist.
    request.authUser = currentUser(request);
    if (requireSession && !request.authUser) {
      if (readCookie(request, SESSION_COOKIE)) clearCookie(reply, config);
      return sendAuthError(reply, 401, 'unauthorized');
    }
    // Registriert, aber noch nicht freigegeben: nur `/api/auth/*` (Vertrag „Registrierung und Einarbeitung“).
    if (request.authUser?.awaitingApproval && !path.startsWith('/api/auth/')) return sendAuthError(reply, 403, 'awaiting_approval');
    // Rechte der Rolle (Vertrag „Rollen und Rechte“) – zentral für alle Routen.
    const denial = request.authUser ? roleDenial(request.authUser, request.method, path) : null;
    if (denial) return sendAuthError(reply, 403, 'not_allowed', denial);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    const username = parsed.success ? normalizeUsername(parsed.data.username) : '';
    if (!parsed.success || !username || !parsed.data.password) return sendAuthError(reply, 400, 'invalid_request');

    // Prüfen und zählen in einem Schritt, vor dem ersten `await` – gleichzeitige Anfragen kommen sonst alle durch.
    const retryAfter = limiter.reserve(request.ip, username);
    if (retryAfter > 0) {
      reply.header('Retry-After', String(retryAfter));
      return sendAuthError(reply, 429, 'too_many_attempts', waitMessage(retryAfter));
    }

    const account = accounts.find(username);
    // Unbekannter Name: trotzdem einen Hash prüfen – gleiche Antwortzeit, gleiche Meldung.
    const valid = await verifyPassword(parsed.data.password, account?.passwordHash ?? (await dummyPasswordHash()));
    if (!account || !valid) {
      // Fehlversuch ist schon gezählt (`reserve`).
      request.log.info({ username, ip: request.ip }, 'Login fehlgeschlagen');
      return sendAuthError(reply, 401, 'invalid_credentials');
    }

    limiter.release(request.ip, username);
    // Immer eine neue Sitzungs-ID; eine mitgeschickte alte Sitzung wird beendet.
    const previous = readCookie(request, SESSION_COOKIE);
    if (previous) sessions.delete(previous);
    const remember = parsed.data.remember === true;
    const id = sessions.create(account.username, remember);
    reply.header('Set-Cookie', cookieHeader(config, id, remember ? REMEMBER_MS / 1000 : null));
    request.log.info({ username: account.username }, 'Login erfolgreich');
    const body: AuthResponse = { user: withFounderNames(publicAccount(account)) };
    return body;
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const id = readCookie(request, SESSION_COOKIE);
    if (id) sessions.delete(id);
    clearCookie(reply, config);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = currentUser(request);
    if (!user) {
      if (readCookie(request, SESSION_COOKIE)) clearCookie(reply, config);
      return sendAuthError(reply, 401, 'unauthorized');
    }
    const body: AuthResponse = { user: withFounderNames(user) };
    return body;
  });

  // ── Registrierung und Einarbeitung (Vertrag shared/auth.ts → „Registrierung und Einarbeitung“) ──

  /**
   * Noch kein Konto: Wer sich jetzt mit dem Einrichtungs-Link registriert, wird Gründer (ohne Link 403, es entsteht
   * auch keine wartende Registrierung). Mit Testkonten (Entwicklung, E2E) nie – dort meldet man sich mit ihnen an.
   */
  const setupMode = () => !accounts.demoEnabled && accounts.storedCount() === 0;
  const firstAccount = setupMode;

  /** Einrichtungs-Link anlegen (falls nötig) und ins Protokoll schreiben. */
  function logSetupLink(): void {
    const link = setupLink(config.auth.publicUrl, setupToken.ensure());
    app.log.warn(
      `Einrichtung: Noch kein Konto. Öffne diesen Link, um das erste (Gründer-)Konto anzulegen: ${link}` +
        (config.auth.publicUrl ? '' : ' – vorne die Adresse des Cockpits ergänzen, z. B. https://crm.example.de'),
    );
  }

  /**
   * Fallen die Konten nach dem Start auf 0 (alle gelöscht), gab es beim Start keinen Schlüssel – dann jetzt anlegen und
   * den Link ins Protokoll schreiben, sonst bekäme die erste Registrierung immer 403 ohne Ausweg.
   */
  function ensureSetupToken(): void {
    if (setupMode() && !setupToken.exists()) logSetupLink();
  }

  app.get('/api/auth/setup', async () => {
    ensureSetupToken();
    const body: SetupInfo = { firstAccount: firstAccount() };
    return body;
  });

  app.post('/api/auth/register', async (request, reply) => {
    const parsed = RegisterSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendAuthError(reply, 400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join(' '));
    const username = normalizeUsername(parsed.data.username);
    if (!validUsername(username)) return sendAuthError(reply, 400, 'invalid_request', USERNAME_RULE);
    const name = parsed.data.name.trim();
    if (!name || name.length > ACCOUNT_NAME_MAX_LENGTH) return sendAuthError(reply, 400, 'invalid_request', REGISTER_MESSAGES.name);
    if (!parsed.data.password) return sendAuthError(reply, 400, 'invalid_request', REGISTER_MESSAGES.password);

    const retryAfter = registerLimiter.retryAfter(request.ip);
    if (retryAfter > 0) {
      reply.header('Retry-After', String(retryAfter));
      return sendAuthError(reply, 429, 'too_many_attempts', waitMessage(retryAfter));
    }
    if (!firstAccount() && accounts.registrationCount() >= MAX_OPEN_REGISTRATIONS) {
      reply.header('Retry-After', '3600');
      return sendAuthError(reply, 429, 'too_many_attempts', REGISTER_MESSAGES.full);
    }
    if (!passwordLengthOk(parsed.data.password)) return sendAuthError(reply, 400, 'weak_password');
    // Jeder Versuch zählt, bevor sich zeigt, ob der Name vergeben ist – sonst ließen sich Anmeldenamen beliebig oft
    // durchprobieren. Auch erfolgreiche Registrierungen zählen (gegen massenhaft angelegte Konten).
    registerLimiter.failure(request.ip);
    // Erstes Konto nur mit dem Einrichtungs-Link (Vergleich in konstanter Zeit).
    ensureSetupToken();
    const setupOk = setupToken.matches(parsed.data.setupToken);
    if (firstAccount() && !setupOk) {
      request.log.warn({ ip: request.ip }, 'Erstes Konto ohne gültigen Einrichtungs-Link abgelehnt');
      return sendAuthError(reply, 403, 'setup_required');
    }
    const taken = () => accounts.taken(username) || invites.latestOpen(username) !== null;
    if (taken()) return sendAuthError(reply, 409, 'account_exists', REGISTER_MESSAGES.exists);

    const passwordHash = await hashPassword(parsed.data.password);
    const remember = parsed.data.remember === true;
    const now = Date.now();
    let user: Account | null = null;
    let sessionId = '';
    db.exec('BEGIN IMMEDIATE');
    try {
      // Erneut in der Transaktion: Zwei gleichzeitige Registrierungen – genau eine wird Gründer, Namen nie doppelt.
      if (!taken()) {
        if (firstAccount() && setupOk) {
          const founder: Account = { username, name, founder: AUTH_FOUNDER_IDS[0], role: 'founder', onboarding: 'setup' };
          accounts.saveHash(founder, passwordHash, now);
          user = founder;
        } else {
          accounts.saveRegistration({ username, name, passwordHash, createdAt: now });
          user = { username, name, founder: null, role: 'assistant', awaitingApproval: true };
        }
        sessions.deleteForUser(username);
        sessionId = sessions.create(username, remember, now);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (!user) return sendAuthError(reply, 409, 'account_exists', REGISTER_MESSAGES.exists);
    if (!user.awaitingApproval) setupToken.clear();

    const previous = readCookie(request, SESSION_COOKIE);
    if (previous) sessions.delete(previous);
    reply.header('Set-Cookie', cookieHeader(config, sessionId, remember ? REMEMBER_MS / 1000 : null));
    request.log.info({ username, ip: request.ip, result: user.awaitingApproval ? 'awaiting_approval' : 'first_founder' }, 'Registrierung');
    if (user.awaitingApproval) onRegistered?.({ username, name });
    const response: AuthResponse = { user: withFounderNames(publicAccount(user)) };
    return response;
  });

  app.post('/api/auth/onboarding/done', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return sendAuthError(reply, 401, 'unauthorized');
    if (user.awaitingApproval) return sendAuthError(reply, 403, 'awaiting_approval');
    accounts.setOnboarding(user.username, null);
    const account = accounts.find(user.username);
    const body: AuthResponse = { user: withFounderNames(account ? publicAccount(account) : { ...user, onboarding: null }) };
    return body;
  });

  // ── Einladungslinks (Vertrag shared/auth.ts → „Einladungslinks“) ──
  // Geloggt werden nur Anmeldename, IP und Ergebnis – nie Token, Hash, Passwort oder Body.

  const inviteBlocked = (request: FastifyRequest, reply: FastifyReply) => {
    const retryAfter = inviteLimiter.retryAfter(request.ip);
    if (retryAfter <= 0) return null;
    reply.header('Retry-After', String(retryAfter));
    return sendAuthError(reply, 429, 'too_many_attempts', waitMessage(retryAfter));
  };

  const inviteInvalid = (request: FastifyRequest, reply: FastifyReply, route: 'check' | 'accept') => {
    inviteLimiter.failure(request.ip);
    request.log.info({ ip: request.ip, route, result: 'invite_invalid' }, 'Einladungslink ungültig');
    return sendAuthError(reply, 404, 'invite_invalid');
  };

  app.post('/api/auth/invite/check', async (request, reply) => {
    const body = request.body as { token?: unknown } | undefined;
    if (typeof body?.token !== 'string' || !body.token) return sendAuthError(reply, 400, 'invalid_request', INVITE_MISSING_TOKEN);
    const blocked = inviteBlocked(request, reply);
    if (blocked) return blocked;

    const invite = invites.find(body.token);
    if (!invite) return inviteInvalid(request, reply, 'check');
    const account = accounts.findStored(invite.username);
    request.log.info({ username: invite.username, ip: request.ip, route: 'check', result: 'ok' }, 'Einladungslink geprüft');
    const info: InviteInfo = {
      username: invite.username,
      name: account?.name ?? invite.name,
      founder: account ? account.founder : invite.founder,
      role: account ? account.role : invite.role,
      expiresAt: invite.expiresAt,
      accountExists: Boolean(account),
    };
    return info;
  });

  app.post('/api/auth/invite/accept', async (request, reply) => {
    const body = request.body as { token?: unknown; password?: unknown; remember?: unknown; name?: unknown } | undefined;
    if (typeof body?.token !== 'string' || !body.token) return sendAuthError(reply, 400, 'invalid_request', INVITE_MISSING_TOKEN);
    if (typeof body.password !== 'string' || !body.password) return sendAuthError(reply, 400, 'invalid_request', INVITE_MISSING_PASSWORD);
    // Eigener Name (optional, nur neue Konten): wie bei der Registrierung 1–ACCOUNT_NAME_MAX_LENGTH Zeichen.
    const ownName = typeof body.name === 'string' ? body.name.trim() : undefined;
    if (body.name !== undefined && (!ownName || ownName.length > ACCOUNT_NAME_MAX_LENGTH)) {
      return sendAuthError(reply, 400, 'invalid_request', REGISTER_MESSAGES.name);
    }
    const blocked = inviteBlocked(request, reply);
    if (blocked) return blocked;

    // Erst den Link prüfen – ohne Passwort-Hash, damit ungültige Links nichts kosten.
    const invite = invites.find(body.token);
    if (!invite) return inviteInvalid(request, reply, 'accept');
    // Zu kurz/zu lang: Link bleibt gültig, man kann es gleich noch einmal versuchen.
    if (!passwordLengthOk(body.password)) return sendAuthError(reply, 400, 'weak_password');

    const passwordHash = await hashPassword(body.password);
    const remember = body.remember === true;
    const now = Date.now();
    let user: AuthUser | null = null;
    let sessionId = '';
    let occupied: string | null = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Je Gründer höchstens ein Gründer-Konto – auch für Links von vor dieser Regel (Link bleibt dann unverbraucht).
      const other = invite.role === 'founder' && invite.founder && !accounts.findStored(invite.username) ? accounts.founderAccount(invite.founder, invite.username) : null;
      if (other && invite.founder) occupied = founderTakenMessage(accounts.founderName(invite.founder), other.username);
      // Einlösen nur, wenn der Link jetzt noch offen ist – zwei gleichzeitige Versuche: genau einer gewinnt.
      if (!occupied && invites.consume(body.token, now)) {
        const existing = accounts.findStored(invite.username);
        if (existing) {
          accounts.setPasswordHash(existing.username, passwordHash, now);
          user = publicAccount(existing);
        } else {
          const created: Account = {
            username: invite.username,
            name: ownName || invite.name,
            founder: invite.founder,
            role: invite.role,
            onboarding: onboardingFor(invite.role),
          };
          if (invite.founders) created.founders = invite.founders;
          accounts.saveHash(created, passwordHash, now);
          user = publicAccount(created);
        }
        // Alle Sitzungen dieses Namens beenden (auch beim Anlegen), dann neue Sitzung wie beim Login.
        sessions.deleteForUser(user.username);
        sessionId = sessions.create(user.username, remember, now);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (occupied) return sendAuthError(reply, 409, 'account_exists', occupied);
    if (!user) return inviteInvalid(request, reply, 'accept');

    limiter.success(user.username);
    const previous = readCookie(request, SESSION_COOKIE);
    if (previous) sessions.delete(previous);
    reply.header('Set-Cookie', cookieHeader(config, sessionId, remember ? REMEMBER_MS / 1000 : null));
    request.log.info({ username: user.username, ip: request.ip, route: 'accept', result: invite.reset ? 'password_reset' : 'account_created' }, 'Einladung eingelöst');
    const response: AuthResponse = { user: withFounderNames(user) };
    return response;
  });

  // Konten verwalten (Vertrag „Rollen und Rechte“ → `/api/accounts*`).
  registerAccountRoutes(app, { db, accounts, sessions, invites, onAccountChange });

  return { accounts, sessions, invites };
}
