import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { authRole, defaultFounderName, workingFounders, type AuthFounderId, type AuthRole, type AuthUser } from '../../../shared/auth.js';
import {
  NOTIFICATION_LIMIT,
  NOTIFICATION_MAX_AGE_DAYS,
  NOTIFICATION_SLACK_REPEAT_HOURS,
  type AppNotification,
  type NotificationKind,
  type NotificationListResponse,
  type NotificationSeverity,
  type NotificationTarget,
} from '../../../shared/notifications.js';
import type { Database } from '../db/database.js';

/**
 * Neuigkeiten vom Programm (Vertrag `shared/notifications.ts`): Meldungen des Servers für die Glocke oben rechts und
 * zusätzlich für Slack. Gleiche Meldungen (gleicher `key`) werden zusammengefasst; ist das Problem behoben, löscht
 * `resolve` sie wieder. Gesehen-Stand je Konto als Zeitpunkt (`notification_seen`).
 */

/** `founders`: nur Gründer-Konten (z. B. Änderungen an Konten – auch Admins sollen sie nicht verbergen können). */
export type NotificationAudience = 'managers' | 'all' | 'founders';

export interface RaiseInput {
  /** Fasst Wiederholungen zusammen, z. B. `search:auto:nick` oder `registration:anna`. */
  key: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  text: string;
  audience?: NotificationAudience;
  founder?: AuthFounderId | null;
  needsFounder?: boolean;
  target?: NotificationTarget | null;
  /**
   * false: Gibt es die Meldung schon, bleibt sie unverändert (z. B. beim Start für schon wartende Registrierungen).
   * Standard true: zählt hoch und rückt nach vorn.
   */
  repeat?: boolean;
}

interface Row {
  id: string;
  key: string;
  kind: string;
  severity: string;
  title: string;
  text: string;
  audience: string;
  founder: string | null;
  needs_founder: number;
  target: string | null;
  count: number;
  created_at: number;
  updated_at: number;
  slack_at: number | null;
}

export interface NotificationDeps {
  db: Database;
  log: FastifyBaseLogger;
  /** Meldung an Slack (nur live mit Webhook – entscheidet der Empfänger). */
  slack?: (notification: AppNotification) => void;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class NotificationCenter {
  private readonly now: () => number;

  constructor(private readonly deps: NotificationDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Meldung anlegen oder (gleicher Schlüssel) zusammenfassen. Fehler werden nur geloggt – Meldungen dürfen nie stören. */
  raise(input: RaiseInput): void {
    try {
      this.raiseOrThrow(input);
    } catch (error) {
      this.deps.log.error({ key: input.key, err: error instanceof Error ? error.message : String(error) }, 'Meldung nicht gespeichert');
    }
  }

  /** Wie `raise`, aber Fehler werden geworfen (z. B. beim Schreiben in die bereitgelegte Kopie einer Sicherung). */
  raiseOrThrow(input: RaiseInput): void {
    const now = this.now();
    this.prune(now);
    const existing = this.deps.db.prepare('SELECT * FROM notifications WHERE key = ?').get(input.key) as Row | undefined;
    if (existing && input.repeat === false) return;
    let row: Row;
    if (existing) {
      row = {
        ...existing,
        severity: input.severity,
        title: input.title,
        text: input.text,
        needs_founder: input.needsFounder ? 1 : 0,
        target: input.target ? JSON.stringify(input.target) : null,
        count: existing.count + 1,
        updated_at: now,
      };
      this.deps.db
        .prepare('UPDATE notifications SET severity = ?, title = ?, text = ?, needs_founder = ?, target = ?, count = ?, updated_at = ? WHERE id = ?')
        .run(row.severity, row.title, row.text, row.needs_founder, row.target, row.count, row.updated_at, row.id);
    } else {
      row = {
        id: randomUUID(),
        key: input.key,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        text: input.text,
        audience: input.audience ?? 'all',
        founder: input.founder ?? null,
        needs_founder: input.needsFounder ? 1 : 0,
        target: input.target ? JSON.stringify(input.target) : null,
        count: 1,
        created_at: now,
        updated_at: now,
        slack_at: null,
      };
      this.deps.db
        .prepare(
          `INSERT INTO notifications (id, key, kind, severity, title, text, audience, founder, needs_founder, target, count, created_at, updated_at, slack_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(row.id, row.key, row.kind, row.severity, row.title, row.text, row.audience, row.founder, row.needs_founder, row.target, row.count, row.created_at, row.updated_at);
    }
    this.deps.log.info({ key: row.key, kind: row.kind, count: row.count }, 'Meldung');
    // Slack: neue Meldung sofort, Wiederholung höchstens alle NOTIFICATION_SLACK_REPEAT_HOURS Stunden.
    if (this.deps.slack && (row.slack_at === null || now - row.slack_at >= NOTIFICATION_SLACK_REPEAT_HOURS * 60 * 60 * 1000)) {
      this.deps.db.prepare('UPDATE notifications SET slack_at = ? WHERE id = ?').run(now, row.id);
      this.deps.slack(toNotification(row, false));
    }
  }

  /**
   * Slack für Meldungen nachholen, die ohne Slack gespeichert wurden (`slack_at` leer) – z. B. „Sicherung
   * wiederhergestellt“: Sie steht schon in der eingespielten Datenbank, Slack geht erst nach dem Neustart raus.
   */
  sendPendingSlack(prefix: string): number {
    if (!this.deps.slack) return 0;
    try {
      const rows = this.deps.db
        .prepare("SELECT * FROM notifications WHERE slack_at IS NULL AND key LIKE ? ESCAPE '\\' ORDER BY created_at")
        .all(`${escapeLike(prefix)}%`) as unknown as Row[];
      const now = this.now();
      for (const row of rows) {
        this.deps.db.prepare('UPDATE notifications SET slack_at = ? WHERE id = ?').run(now, row.id);
        this.deps.slack(toNotification(row, false));
      }
      return rows.length;
    } catch (error) {
      this.deps.log.error({ prefix, err: error instanceof Error ? error.message : String(error) }, 'Slack-Nachricht nicht nachgeholt');
      return 0;
    }
  }

  /** Steht die Meldung mit diesem Schlüssel gerade offen? Fehler zählen als „nein“ (Meldungen dürfen nie stören). */
  isActive(key: string): boolean {
    try {
      return this.deps.db.prepare('SELECT 1 FROM notifications WHERE key = ?').get(key) !== undefined;
    } catch {
      return false;
    }
  }

  /** Problem behoben: Meldung löschen. */
  resolve(key: string): void {
    try {
      this.deps.db.prepare('DELETE FROM notifications WHERE key = ?').run(key);
    } catch (error) {
      this.deps.log.error({ key, err: error instanceof Error ? error.message : String(error) }, 'Meldung nicht gelöscht');
    }
  }

  /** Alle Meldungen mit Schlüssel-Anfang `prefix` löschen, außer `keep`. */
  resolveExcept(prefix: string, keep: readonly string[]): void {
    const keepSet = new Set(keep);
    const rows = this.deps.db.prepare("SELECT key FROM notifications WHERE key LIKE ? ESCAPE '\\'").all(`${escapeLike(prefix)}%`) as { key: string }[];
    for (const row of rows) if (!keepSet.has(row.key)) this.resolve(row.key);
  }

  /** Was dieses Konto sieht (Vertrag „Wer sieht was“), neueste zuerst. */
  list(user: Pick<AuthUser, 'username' | 'founder' | 'role' | 'founders'>): NotificationListResponse {
    const now = this.now();
    this.prune(now);
    const rows = this.deps.db.prepare('SELECT * FROM notifications ORDER BY updated_at DESC, created_at DESC').all() as unknown as Row[];
    const seenAt = this.seenAt(user.username);
    const role = authRole(user);
    const own = workingFounders(user);
    let others = 0;
    const notifications = rows
      .filter((row) => {
        if (row.audience === 'founders' && role !== 'founder') return false;
        if (role === 'assistant') {
          if (row.audience === 'managers') return false;
          if (row.founder && !own.includes(row.founder as AuthFounderId)) return false;
        }
        return true;
      })
      // Ungelesene Änderungen an Konten (und Sicherheits-Ereignisse) immer zeigen – auch über NOTIFICATION_LIMIT
      // hinaus, damit viele andere Meldungen sie nicht aus der Liste schieben. Dazu die neuesten N übrigen.
      .filter((row) => isAlwaysShown(row, seenAt) || others++ < NOTIFICATION_LIMIT)
      .map((row) => toNotification(row, row.updated_at > seenAt));
    return { notifications, unread: notifications.filter((item) => item.unread).length };
  }

  /** Alles bis jetzt gilt für dieses Konto als gesehen. */
  markSeen(username: string): void {
    this.deps.db
      .prepare('INSERT INTO notification_seen (username, seen_at) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET seen_at = excluded.seen_at')
      .run(username, this.now());
  }

  /** Noch nie eine Meldung (bzw. alle behoben)? */
  isEmpty(): boolean {
    return this.deps.db.prepare('SELECT 1 FROM notifications LIMIT 1').get() === undefined;
  }

  /** Simulation (Demo-Reset): alles leeren und zwei Beispiel-Meldungen anlegen, damit die Glocke etwas zeigt. */
  resetDemo(): void {
    this.deps.db.exec('DELETE FROM notifications; DELETE FROM notification_seen;');
    const now = this.now();
    // Ohne Slack: Beispiele sind keine echten Probleme.
    const quiet = new NotificationCenter({ ...this.deps, slack: undefined, now: () => now - 2 * 60 * 60 * 1000 });
    quiet.raise(NOTICES.backupFailed('Beispiel aus der Simulation'));
    const later = new NotificationCenter({ ...this.deps, slack: undefined, now: () => now - 20 * 60 * 1000 });
    later.raise(
      NOTICES.autoSearchFailed(
        'nick',
        defaultFounderName('nick'),
        'Zugang abgelehnt: Unipile hat den API-Schlüssel nicht angenommen (Beispiel aus der Simulation). Prüf den Schlüssel unter Einstellungen → LinkedIn (Unipile).',
      ),
    );
  }

  private seenAt(username: string): number {
    const row = this.deps.db.prepare('SELECT seen_at FROM notification_seen WHERE username = ?').get(username) as { seen_at: number } | undefined;
    return row?.seen_at ?? 0;
  }

  private prune(now: number): void {
    this.deps.db.prepare('DELETE FROM notifications WHERE updated_at < ?').run(now - NOTIFICATION_MAX_AGE_DAYS * DAY_MS);
  }
}

/** Ungelesene Gründer-Meldung über Konten oder Sicherheit – fällt nie aus der Liste. */
function isAlwaysShown(row: Row, seenAt: number): boolean {
  return row.kind === 'account_change' && row.audience === 'founders' && row.updated_at > seenAt;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toNotification(row: Row, unread: boolean): AppNotification {
  let target: NotificationTarget | null = null;
  try {
    target = row.target ? (JSON.parse(row.target) as NotificationTarget) : null;
  } catch {
    target = null;
  }
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    severity: row.severity as NotificationSeverity,
    title: row.title,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    count: row.count,
    founder: (row.founder as AuthFounderId | null) ?? null,
    needsFounder: row.needs_founder === 1,
    target,
    unread,
  };
}

// ───────────────────────────── Meldungen der einzelnen Stellen ─────────────────────────────

/** Was an einem Konto passiert ist (Sicherheitsprüfung 08.10.: jede Änderung landet bei allen Gründern). */
export interface AccountChange {
  action: 'invited' | 'reset_link' | 'approved' | 'removed';
  /** Wer es getan hat (Anzeigename und Anmeldename). */
  by: { username: string; name: string };
  /** Betroffenes Konto. */
  username: string;
  name: string;
  role: AuthRole;
  founder: AuthFounderId | null;
}

/** Heikle Aktionen unter „Sicherungen und Updates“, die alle Gründer erfahren. */
export type SecurityAction = 'settings_key' | 'backup_download' | 'backup_restore';

const ROLE_TEXT: Record<AuthRole, string> = { admin: 'Admin', founder: 'Gründer', assistant: 'Mitarbeiter' };

const TIME = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Welcher Bereich der Einstellungen zu einer Fehlermeldung der Suche passt (Ids aus `settingsNav.ts`). */
function searchSection(message: string): string {
  if (/anthropic|\bKI\b|Modell/i.test(message)) return 'anthropic';
  if (/meta/i.test(message)) return 'meta';
  if (/unipile|linkedin/i.test(message)) return 'unipile';
  return 'auto';
}

export const NOTICES = {
  registration: (username: string, name: string): RaiseInput => ({
    key: `registration:${username}`,
    kind: 'registration',
    severity: 'info',
    title: `${name} hat sich registriert`,
    text: `${name} (Anmeldename ${username}) wartet auf Freigabe. Unter Konten legst du Rolle und Gründer fest – oder lehnst ab.`,
    audience: 'managers',
    needsFounder: true,
    target: { view: 'accounts' },
    repeat: false,
  }),
  /** `skipped`: Lauf gar nicht gestartet (z. B. Tageslimit erreicht, KI-Schlüssel fehlt) – Warnung statt Fehler. */
  autoSearchFailed: (founder: AuthFounderId, founderName: string, message: string, skipped = false): RaiseInput => ({
    key: `search:auto:${founder}`,
    kind: 'search_failed',
    severity: skipped ? 'warning' : 'error',
    title: `Automatische Lead-Suche für ${founderName} ${skipped ? 'übersprungen' : 'abgebrochen'}`,
    text: message,
    founder,
    needsFounder: true,
    target: { view: 'settings', section: searchSection(message) },
  }),
  linkedinPaused: (founder: AuthFounderId, founderName: string, until: number, reason: string): RaiseInput => ({
    key: `linkedin:pause:${founder}`,
    kind: 'linkedin_paused',
    severity: 'warning',
    title: `LinkedIn für ${founderName} pausiert`,
    text: `${reason} Das Cockpit sendet bis ${TIME.format(until)} Uhr nichts über diesen Account.`,
    founder,
    needsFounder: false,
    target: { view: 'home' },
  }),
  backupFailed: (reason: string): RaiseInput => ({
    key: 'backup:scheduled',
    kind: 'backup_failed',
    severity: 'warning',
    title: 'Sicherung fehlgeschlagen',
    text: `Die nächtliche Sicherung der Datenbank hat nicht geklappt (${reason}). Leg unter Einstellungen → Sicherungen von Hand eine an.`,
    needsFounder: true,
    target: { view: 'settings', section: 'backup' },
  }),
  accountChange: (change: AccountChange, founderName: (id: AuthFounderId) => string = defaultFounderName): RaiseInput => {
    const role = change.role === 'admin' || !change.founder ? ROLE_TEXT[change.role] : `${ROLE_TEXT[change.role]} (${founderName(change.founder)})`;
    const who = `${change.by.name} (${change.by.username})`;
    const whom = `${change.name} (${change.username}, ${role})`;
    const [title, text] = {
      invited: ['Neues Konto eingeladen', `${who} hat einen Einladungslink für ${whom} erzeugt.`],
      reset_link: ['Passwort-Link erzeugt', `${who} hat einen Link „Passwort neu setzen“ für ${whom} erzeugt. Wer ihn einlöst, kann sich mit diesem Konto anmelden.`],
      approved: ['Registrierung freigegeben', `${who} hat ${whom} freigegeben.`],
      removed: ['Konto entfernt', `${who} hat ${whom} entfernt.`],
    }[change.action];
    const sensitive = change.action === 'reset_link' || change.role !== 'assistant';
    return {
      // Jede Änderung einzeln (nie zusammengefasst oder von selbst gelöscht).
      key: `account:${randomUUID()}`,
      kind: 'account_change',
      severity: sensitive ? 'warning' : 'info',
      title,
      text: `${text} Warst du das nicht oder kennst du die Person nicht, prüf unter Konten, wer Zugang hat.`,
      audience: 'founders',
      needsFounder: true,
      target: { view: 'accounts' },
    };
  },
  /**
   * Heikle Aktion unter Einstellungen → Sicherungen und Updates (Sicherheitsprüfung 09.10.): Schlüssel für Geheimnisse
   * angezeigt, Sicherung heruntergeladen oder wiederhergestellt. Wie Änderungen an Konten bei allen Gründern
   * (`account_change`, Glocke + Slack), jede einzeln. `restore:` – Slack geht erst nach dem Neustart raus.
   */
  securityAction: (action: SecurityAction, by: { username: string; name: string }, detail: { backup?: string; when?: string } = {}): RaiseInput => {
    const who = `${by.name} (${by.username})`;
    const backup = detail.when ? `die Sicherung vom ${detail.when}` : 'eine Sicherung';
    const [title, text] = {
      settings_key: [
        'Schlüssel für Geheimnisse angezeigt',
        `${who} hat sich den Schlüssel für Geheimnisse anzeigen lassen. Mit ihm und einer Sicherung lassen sich alle gespeicherten API-Schlüssel lesen.`,
      ],
      backup_download: [
        'Sicherung heruntergeladen',
        `${who} hat ${backup}${detail.backup ? ` (${detail.backup})` : ''} heruntergeladen. Sie enthält alle Leads und Konten.`,
      ],
      backup_restore: [
        `Sicherung wiederhergestellt von ${by.name}`,
        `${who} hat ${backup} eingespielt. Konten und Passwörter blieben auf dem jetzigen Stand, alle mussten sich neu anmelden.`,
      ],
    }[action];
    return {
      key: `${action === 'backup_restore' ? 'restore' : 'security'}:${randomUUID()}`,
      kind: 'account_change',
      severity: 'warning',
      title,
      text: `${text} Warst du das nicht, prüf unter Konten, wer Zugang hat, und ändere dein Passwort.`,
      audience: 'founders',
      needsFounder: true,
      target: { view: 'settings', section: 'backup' },
    };
  },
  updateFailed: (reason: string): RaiseInput => ({
    key: 'update:auto',
    kind: 'update_failed',
    severity: 'warning',
    title: 'Automatisches Update fehlgeschlagen',
    text: `${reason} Unter Einstellungen → Software-Update geht es mit einem Klick von Hand.`,
    needsFounder: true,
    target: { view: 'settings', section: 'update' },
  }),
  unipileDown: (message: string): RaiseInput => ({
    key: 'unipile:down',
    kind: 'unipile_down',
    severity: 'error',
    title: 'Unipile antwortet nicht wie erwartet',
    text: `${message} Solange das so ist, laufen Lead-Suche und LinkedIn-Aktionen nicht.`,
    // Beheben können es Gründer und Admins (Einstellungen → Unipile), Mitarbeiter nicht.
    audience: 'managers',
    needsFounder: true,
    target: { view: 'settings', section: 'unipile' },
    // Alle paar Stunden geprüft: einmal melden (auch nur einmal an Slack), nicht bei jeder Prüfung neu.
    repeat: false,
  }),
  diskLow: (free: string, percent: number): RaiseInput => ({
    key: 'disk:low',
    kind: 'disk_low',
    severity: 'warning',
    title: 'Speicherplatz auf dem Server knapp',
    text: `Im Datenordner sind nur noch ${free} frei (${percent} %). Sicherungen und Updates können daran scheitern. Räum auf dem Server auf (z. B. alte Docker-Abbilder) oder vergrößere den Speicher.`,
    needsFounder: true,
    target: { view: 'settings', section: 'backup' },
    // Stündlich geprüft: nicht jede Stunde neu melden, solange es knapp bleibt.
    repeat: false,
  }),
} as const;

/** Routen laut Vertrag (`shared/notifications.ts`). `sync` gleicht vorher ab (z. B. entschiedene Registrierungen). */
export function registerNotificationRoutes(app: FastifyInstance, { center, sync }: { center: NotificationCenter; sync?: () => void }) {
  const listFor = (request: FastifyRequest) => {
    sync?.();
    return center.list(request.authUser!);
  };
  app.get('/api/notifications', async (request, reply) => {
    if (!request.authUser) return reply.status(401).send({ error: { code: 'unauthorized', message: 'Bitte melde dich an.' } });
    return listFor(request);
  });
  app.post('/api/notifications/seen', async (request, reply) => {
    if (!request.authUser) return reply.status(401).send({ error: { code: 'unauthorized', message: 'Bitte melde dich an.' } });
    center.markSeen(request.authUser.username);
    return listFor(request);
  });
}
