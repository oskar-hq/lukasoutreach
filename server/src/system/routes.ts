import { createReadStream } from 'node:fs';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import type { BackupInfo, BackupListResponse, RestoreResponse, SettingsKeyResponse, UpdateStatusResponse } from '../../../shared/system.js';
import type { AccountStore } from '../auth/accounts.js';
import { verifyPassword } from '../auth/password.js';
import { Counter, type LoginLimiter } from '../auth/rateLimit.js';
import type { Config } from '../config.js';
import { NOTICES, type RaiseInput } from '../notify/notifications.js';
import { readSettingsKey } from '../settings/crypto.js';
import { BackupError, germanDateTime, type BackupService } from './backups.js';
import { SystemError, type UpdateService } from './updates.js';

/**
 * Routen `/api/system/*` laut Vertrag `shared/system.ts`. Alle verlangen eine Sitzung; Mitarbeiter sperrt schon
 * `roleDenial` (403 not_allowed). Passwort-Abfragen (Herunterladen, Wiederherstellen) zählen Fehlversuche im
 * selben Zähler wie die Einstellungen (`SettingsService.limiter`): je IP und Konto, Sperre → 429.
 */

export interface SystemRouteDeps {
  config: Config;
  backups: BackupService;
  updates: UpdateService;
  accounts: AccountStore;
  limiter: LoginLimiter;
  /** Läuft gerade eine Lead-Suche? (Wiederherstellen erst danach.) */
  runActive: () => boolean;
  /** Backend neu starten, nachdem die Antwort raus ist (Docker startet es wieder). Ohne Angabe: nichts. */
  restart?: () => void;
  /** Meldung an alle Gründer (Glocke + Slack): Schlüssel angezeigt, Sicherung heruntergeladen. */
  notify?: (notice: RaiseInput) => void;
  log: FastifyBaseLogger;
}

interface Actor {
  username: string;
  name: string;
  ip: string;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, retryAfter?: number) {
  if (retryAfter) reply.header('Retry-After', String(retryAfter));
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(status).send(body);
}

/** Schlüssel für Geheimnisse: höchstens 5-mal je Konto in 15 Minuten anzeigen (zusätzlich zur Passwort-Sperre). */
const SETTINGS_KEY_RULE = { max: 5, windowMs: 15 * 60 * 1000 };

export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps) {
  const { backups, updates } = deps;
  const keyViews = new Counter(SETTINGS_KEY_RULE);

  const actorOf = (request: FastifyRequest): Actor => {
    if (!request.authUser) throw new SystemError(401, 'unauthorized', 'Bitte melde dich an.');
    return { username: request.authUser.username, name: request.authUser.name, ip: request.ip ?? '-' };
  };

  /** Passwort wie bei den Einstellungen: erst Sperre, dann fehlt (zählt nicht), dann falsch (zählt). */
  const reauth = async (request: FastifyRequest, actor: Actor): Promise<void> => {
    const now = Date.now();
    const tooMany = (retryAfter: number) =>
      new SystemError(429, 'too_many_attempts', `Zu viele Fehlversuche. Bitte warte ${Math.max(1, Math.ceil(retryAfter / 60))} Minuten.`, retryAfter);
    const blocked = deps.limiter.retryAfter(actor.ip, actor.username, now);
    if (blocked > 0) throw tooMany(blocked);
    const password = (request.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || !password) throw new SystemError(403, 'reauth_failed', 'Bitte gib dein Passwort ein.');
    // Vor dem `await` zählen – gleichzeitige Anfragen kämen sonst alle an der Sperre vorbei.
    const retryAfter = deps.limiter.reserve(actor.ip, actor.username, now);
    if (retryAfter > 0) throw tooMany(retryAfter);
    const account = deps.accounts.find(actor.username);
    const valid = account ? await verifyPassword(password, account.passwordHash) : false;
    if (!valid) {
      deps.log.info({ username: actor.username, ip: actor.ip }, 'System: Passwort falsch');
      throw new SystemError(403, 'reauth_failed', 'Das Passwort stimmt nicht.');
    }
    deps.limiter.release(actor.ip, actor.username);
  };

  const guarded =
    <T>(work: (request: FastifyRequest, reply: FastifyReply, actor: Actor) => Promise<T> | T) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await work(request, reply, actorOf(request));
      } catch (error) {
        if (error instanceof SystemError) return sendError(reply, error.status, error.code, error.message, error.retryAfter);
        if (error instanceof BackupError) return sendError(reply, error.status, error.code, error.message);
        throw error;
      }
    };

  const nameOf = (request: FastifyRequest) => String((request.params as { name?: string }).name ?? '');

  // ── Sicherungen ──

  app.get('/api/system/backups', guarded((): BackupListResponse => backups.list()));

  app.post('/api/system/backups', guarded((_request, _reply, actor): BackupInfo => {
    const info = backups.create('manual');
    deps.log.info({ username: actor.username, file: info.name }, 'Sicherung von Hand angelegt');
    return info;
  }));

  app.post(
    '/api/system/backups/:name/download',
    guarded(async (request, reply, actor) => {
      // Name zuerst: Unbekannte Sicherung → 404 ohne Passwortprüfung (kostet keinen Versuch).
      const info = backups.info(nameOf(request));
      await reauth(request, actor);
      const file = backups.file(info.name);
      deps.log.info({ username: actor.username, file: info.name }, 'Sicherung heruntergeladen');
      deps.notify?.(NOTICES.securityAction('backup_download', actor, { backup: info.name, when: germanDateTime(info.createdAt) }));
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${info.name}"`)
        .header('Content-Length', String(info.size))
        .header('Cache-Control', 'no-store')
        .send(createReadStream(file));
    }),
  );

  app.post(
    '/api/system/backups/:name/restore',
    guarded(async (request, reply, actor) => {
      const info = backups.info(nameOf(request));
      await reauth(request, actor);
      const when = germanDateTime(info.createdAt);
      if (deps.config.mode === 'mock') {
        const response: RestoreResponse = {
          message: `Simulation: Die Sicherung vom ${when} würde jetzt eingespielt und das Cockpit neu gestartet – es wurde nichts geändert.`,
          safetyBackup: null,
        };
        return reply.status(202).send(response);
      }
      if (backups.restorePending) throw new SystemError(409, 'busy', 'Eine Wiederherstellung läuft schon – das Cockpit startet gleich neu.');
      if (deps.runActive()) throw new SystemError(409, 'busy', 'Gerade läuft eine Lead-Suche – bitte warte, bis sie fertig ist.');
      // Die Meldung an alle Gründer steht in der eingespielten Datenbank; Slack geht nach dem Neustart raus.
      const { safetyBackup } = backups.prepareRestore(info.name, NOTICES.securityAction('backup_restore', actor, { backup: info.name, when }));
      deps.log.warn({ username: actor.username, file: info.name, safetyBackup }, 'Sicherung wird wiederhergestellt – Neustart');
      const response: RestoreResponse = { message: `Sicherung vom ${when} wird eingespielt – das Cockpit startet neu. Danach meldest du dich neu an.`, safetyBackup };
      // Erst antworten, dann neu starten.
      reply.raw.once('finish', () => deps.restart?.());
      return reply.status(202).send(response);
    }),
  );

  // ── Schlüssel für Geheimnisse (zum Ablegen im Passwort-Manager) ──

  app.post(
    '/api/system/settings-key',
    guarded(async (request, reply, actor) => {
      const now = Date.now();
      const blocked = keyViews.blockedFor(actor.username, now);
      if (blocked > 0) {
        const seconds = Math.ceil(blocked / 1000);
        throw new SystemError(429, 'too_many_attempts', `Du hast den Schlüssel gerade oft angezeigt. Bitte warte ${Math.max(1, Math.ceil(seconds / 60))} Minuten.`, seconds);
      }
      // Anzeige vor dem `await` zählen (gleichzeitige Anfragen); falsches Passwort nimmt sie wieder zurück.
      keyViews.hit(actor.username, now);
      try {
        await reauth(request, actor);
      } catch (error) {
        keyViews.unhit(actor.username);
        throw error;
      }
      const { source, key } = readSettingsKey(deps.config.dataDir, deps.config.settings.key);
      // Nur wer und wann – nie der Schlüssel selbst.
      deps.log.warn({ username: actor.username, ip: actor.ip, source }, 'Schlüssel für Geheimnisse angezeigt');
      deps.notify?.(NOTICES.securityAction('settings_key', actor));
      const message =
        source === 'env'
          ? 'Der Schlüssel kommt aus SETTINGS_KEY in der .env des Servers. Leg genau diesen Wert in deinem Passwort-Manager ab – das Cockpit zeigt ihn nicht an.'
          : source === 'file'
            ? 'Leg diesen Schlüssel in deinem Passwort-Manager ab, getrennt von den Sicherungen. Ohne ihn lassen sich die gespeicherten Geheimnisse einer Sicherung nicht mehr lesen.'
            : 'Es gibt noch keinen Schlüssel – er entsteht mit dem ersten gespeicherten Geheimnis (z. B. einem API-Schlüssel in den Einstellungen).';
      const body: SettingsKeyResponse = { source, key, message };
      return reply.header('Cache-Control', 'no-store').send(body);
    }),
  );

  // ── Updates ──

  app.get('/api/system/update', guarded((): Promise<UpdateStatusResponse> => updates.status()));

  app.post('/api/system/update/check', guarded((): Promise<UpdateStatusResponse> => updates.check()));

  app.post(
    '/api/system/update',
    // Ohne Passwort (Wunsch des Nutzers 23.10.): ein Klick genügt. Es wird nur der Integrations-Branch eingespielt,
    // vorher sichert das Backend die Datenbank; Mitarbeiter sperrt `roleDenial`.
    guarded(async (_request, reply, actor) => {
      const status = await updates.start(actor.name);
      deps.log.warn({ username: actor.username, simulated: status.simulated }, 'Update gestartet');
      return reply.status(202).send(status);
    }),
  );
}
