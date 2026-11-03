import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/database.js';

/**
 * Sitzungen laut Vertrag (`shared/auth.ts`):
 * - ohne „angemeldet bleiben“: endet nach 12 Stunden ohne Anfrage;
 * - mit „angemeldet bleiben“: gilt 30 Tage ab Login (fest, verlängert sich nicht);
 * - liegen in der Datenbank und überleben einen Neustart.
 * Gespeichert wird nur der SHA-256 der Sitzungs-ID – wer die Datei liest, kann keine Sitzung übernehmen.
 */

export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
/** „Zuletzt gesehen“ höchstens einmal pro Minute schreiben, nicht bei jeder Anfrage. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface Session {
  username: string;
  remember: boolean;
}

interface SessionRow {
  username: string;
  remember: number;
  last_seen_at: number;
  expires_at: number;
}

function hashId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

/** Für Verweise auf eine Sitzung, ohne die ID selbst zu speichern (z. B. Probe-Änderung der Einstellungen). */
export const hashSessionId = hashId;

export class SessionStore {
  constructor(private readonly db: Database) {}

  /** Neue Sitzung, gibt die Sitzungs-ID für das Cookie zurück. */
  create(username: string, remember: boolean, now = Date.now()): string {
    this.prune(now);
    const id = randomBytes(32).toString('base64url');
    const expiresAt = now + (remember ? REMEMBER_MS : IDLE_TIMEOUT_MS);
    this.db
      .prepare('INSERT INTO sessions (id_hash, username, remember, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashId(id), username, remember ? 1 : 0, now, now, expiresAt);
    return id;
  }

  /** Gültige Sitzung oder null. Verlängert Sitzungen ohne „angemeldet bleiben“ bei jeder Anfrage. */
  get(id: string, now = Date.now()): Session | null {
    if (!id) return null;
    const key = hashId(id);
    const row = this.db
      .prepare('SELECT username, remember, last_seen_at, expires_at FROM sessions WHERE id_hash = ?')
      .get(key) as SessionRow | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(key);
      return null;
    }
    if (now - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      const expiresAt = row.remember ? row.expires_at : now + IDLE_TIMEOUT_MS;
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(now, expiresAt, key);
    }
    return { username: row.username, remember: row.remember === 1 };
  }

  delete(id: string): void {
    if (id) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashId(id));
  }

  deleteByHash(hash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash);
  }

  /** Passwort geändert oder Konto entfernt → alle Sitzungen dieses Kontos beenden. */
  /**
   * Alle Sitzungen eines Kontos beenden – auch die Verbindungen der Claude-App (MCP-Tokens, Sicherheitsprüfung 29.10.):
   * Passwort zurückgesetzt oder Konto entfernt heißt, dass auch ein verbundener Client neu freigegeben werden muss.
   * Sonst bliebe das Refresh-Token 90 Tage gültig – und würde bei einem neuen Konto gleichen Namens wieder wirksam.
   */
  deleteForUser(username: string): number {
    this.db.prepare('DELETE FROM mcp_tokens WHERE username = ?').run(username);
    return Number(this.db.prepare('DELETE FROM sessions WHERE username = ?').run(username).changes);
  }

  prune(now = Date.now()): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }
}
