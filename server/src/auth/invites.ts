import { createHash, randomBytes } from 'node:crypto';
import { INVITE_PATH, INVITE_VALID_DAYS, RESET_VALID_HOURS, type AuthFounderId, type AuthRole } from '../../../shared/auth.js';
import type { Database } from '../db/database.js';
import { foundersColumn, readFounders } from './accounts.js';

/**
 * Einladungslinks laut Vertrag (`shared/auth.ts` → „Einladungslinks“):
 * - Token = 32 Zufallsbytes base64url, gespeichert nur als SHA-256;
 * - einmal benutzbar (`used_at`), mit Ablauf (neues Konto `INVITE_VALID_DAYS` Tage, `--reset` `RESET_VALID_HOURS` h);
 * - ein neuer Link für denselben Namen macht offene Links dieses Namens ungültig.
 */

export const INVITE_VALID_MS = INVITE_VALID_DAYS * 24 * 60 * 60 * 1000;
export const RESET_VALID_MS = RESET_VALID_HOURS * 60 * 60 * 1000;

/** Form des Tokens im Link (43 Zeichen base64url) – alles andere ist sicher ungültig. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface Invite {
  username: string;
  name: string;
  /** Rolle des neuen Kontos (bei `reset` ohne Bedeutung – das Konto behält seine). */
  role: AuthRole;
  /** null = Admin-Konto. */
  founder: AuthFounderId | null;
  /** Nur Mitarbeiter mit mehreren Gründern (`founder` ist der erste). */
  founders?: AuthFounderId[];
  /** true = Link ersetzt das Passwort eines bestehenden Kontos. */
  reset: boolean;
  expiresAt: number;
}

interface InviteRow {
  username: string;
  name: string;
  role: string;
  founder: string | null;
  founders: string | null;
  reset: number;
  expires_at: number;
}

function toInvite(row: InviteRow): Invite {
  const invite: Invite = {
    username: row.username,
    name: row.name,
    role: row.role as AuthRole,
    founder: row.founder as AuthFounderId | null,
    reset: row.reset === 1,
    expiresAt: row.expires_at,
  };
  const founders = readFounders(invite.role, invite.founder, row.founders);
  if (founders) invite.founders = founders;
  return invite;
}

const INVITE_COLUMNS = 'username, name, role, founder, founders, reset, expires_at';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** `<PUBLIC_URL>/einladung#<token>` */
export function inviteLink(publicUrl: string, token: string): string {
  return `${publicUrl}${INVITE_PATH}#${token}`;
}

export class InviteStore {
  constructor(private readonly db: Database) {}

  /** Neuer Link; offene Links desselben Namens werden ungültig. Gibt das Token zurück (nur hier im Klartext). */
  create(invite: Omit<Invite, 'expiresAt'>, now = Date.now()): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + (invite.reset ? RESET_VALID_MS : INVITE_VALID_MS);
    this.db.exec('BEGIN');
    try {
      this.revoke(invite.username, now);
      this.db
        .prepare('INSERT INTO invitations (id_hash, username, name, role, founder, founders, reset, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(hashToken(token), invite.username, invite.name, invite.role, invite.founder, foundersColumn(invite.founders), invite.reset ? 1 : 0, now, expiresAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { token, expiresAt };
  }

  /** Offener, nicht abgelaufener Link – verändert nichts. */
  find(token: string, now = Date.now()): Invite | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const row = this.db
      .prepare(`SELECT ${INVITE_COLUMNS} FROM invitations WHERE id_hash = ? AND used_at IS NULL AND expires_at > ?`)
      .get(hashToken(token), now) as InviteRow | undefined;
    return row ? toInvite(row) : null;
  }

  /**
   * Nicht eingelöste Links (je Name der neueste), auch abgelaufene – für die Liste unter „Konten“
   * (`pending`, `inviteExpiresAt` ggf. in der Vergangenheit). Widerrufene zählen als eingelöst. Ohne Token.
   */
  unused(): Invite[] {
    const rows = this.db
      .prepare(`SELECT ${INVITE_COLUMNS} FROM invitations WHERE used_at IS NULL ORDER BY created_at ASC, rowid ASC`)
      .all() as unknown as InviteRow[];
    const latest = new Map<string, Invite>();
    for (const row of rows) latest.set(row.username, toInvite(row));
    return [...latest.values()];
  }

  /** Neuester nicht eingelöster Link eines Namens (auch abgelaufen) oder null. */
  latestUnused(username: string): Invite | null {
    const row = this.db
      .prepare(`SELECT ${INVITE_COLUMNS} FROM invitations WHERE username = ? AND used_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(username) as InviteRow | undefined;
    return row ? toInvite(row) : null;
  }

  /** Neuester offener (nicht abgelaufener) Link eines Namens oder null. */
  latestOpen(username: string, now = Date.now()): Invite | null {
    const invite = this.latestUnused(username);
    return invite && invite.expiresAt > now ? invite : null;
  }

  /**
   * Link einlösen – nur, wenn er in diesem Moment noch offen ist. Muss innerhalb einer Transaktion laufen,
   * zusammen mit dem Anlegen des Kontos. Zwei gleichzeitige Versuche: genau einer bekommt true.
   */
  consume(token: string, now = Date.now()): boolean {
    if (!TOKEN_PATTERN.test(token)) return false;
    const result = this.db
      .prepare('UPDATE invitations SET used_at = ? WHERE id_hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(now, hashToken(token), now);
    return Number(result.changes) === 1;
  }

  /** Offene Links eines Namens ungültig machen (neuer Link, `add`, `password`, `remove`, `uninvite`). */
  revoke(username: string, now = Date.now()): number {
    return Number(
      this.db.prepare('UPDATE invitations SET used_at = ? WHERE username = ? AND used_at IS NULL AND expires_at > ?').run(now, username, now).changes,
    );
  }

  /** Alle nicht eingelösten Links eines Namens erledigen, auch abgelaufene (Konto/Einladung entfernt). */
  discard(username: string, now = Date.now()): number {
    return Number(this.db.prepare('UPDATE invitations SET used_at = ? WHERE username = ? AND used_at IS NULL').run(now, username).changes);
  }

  /** Alte Einträge (benutzt oder abgelaufen, älter als 30 Tage) aufräumen. */
  prune(now = Date.now()): void {
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM invitations WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)').run(cutoff, cutoff);
  }
}
