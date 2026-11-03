import {
  ACCOUNT_USERNAME_PATTERN,
  AUTH_FOUNDER_IDS,
  AUTH_ROLES,
  defaultFounderName,
  type AuthFounderId,
  type AuthRole,
  type AuthUser,
  type OnboardingKind,
} from '../../../shared/auth.js';
import type { Database } from '../db/database.js';
import { hashPassword } from './password.js';

/**
 * Konten: in der Datenbank, angelegt per Einladungslink (Seite „Konten“ oder `accountsCli invite`) oder per
 * Server-Befehl (`accountsCli add`). Testkonten (`AUTH_DEMO_ACCOUNTS=true`) liegen nur im Speicher und überdecken nie
 * ein echtes Konto.
 *
 * Rollen laut Vertrag (`shared/auth.ts` → „Rollen und Rechte“): admin ⇒ founder null; founder/assistant ⇒ founder
 * gesetzt. Das Backend liefert `role` immer mit. Mitarbeiter können für mehrere Gründer arbeiten (`founders`, der
 * erste ist immer `founder`).
 *
 * Offene Registrierungen (Vertrag → „Registrierung und Einarbeitung“) liegen in einer eigenen Tabelle ohne Rolle.
 * `find` liefert sie als Konto mit `awaitingApproval`, damit Anmeldung und Sitzung wie gewohnt funktionieren.
 */

/** Konto mit fester Rolle (im Backend nie ohne). */
export type Account = AuthUser & { role: AuthRole };

export interface StoredAccount extends Account {
  passwordHash: string;
}

/** Testkonten laut Vertrag (`shared/auth.ts`): nick / johannes / admin / mitarbeiter, Passwort jeweils „demo“. */
export const DEMO_PASSWORD = 'demo';
const DEMO_USERS: Account[] = [
  { username: 'nick', name: 'Nick', founder: 'nick', role: 'founder' },
  { username: 'johannes', name: 'Johannes', founder: 'johannes', role: 'founder' },
  { username: 'admin', name: 'Admin', founder: null, role: 'admin' },
  { username: 'mitarbeiter', name: 'Anna', founder: 'nick', role: 'assistant' },
];

/** Anmeldename wie im Vertrag: trim + klein. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isFounderId(value: unknown): value is AuthFounderId {
  return typeof value === 'string' && (AUTH_FOUNDER_IDS as readonly string[]).includes(value);
}

/**
 * Gründer eines Mitarbeiters: `founder` vorne, dann die übrigen aus `extra` in Vertragsreihenfolge, ohne Doppelte.
 * Unbekannte Werte fallen weg. undefined, wenn es nur `founder` ist oder die Rolle kein Mitarbeiter (Vertrag: `founders`
 * nur bei Mitarbeitern mit mehreren Gründern – sonst bleiben Antworten wie bisher).
 */
export function assistantFounders(role: AuthRole, founder: AuthFounderId | null, extra: readonly unknown[] | null | undefined): AuthFounderId[] | undefined {
  if (role !== 'assistant' || !founder) return undefined;
  const wanted = new Set<AuthFounderId>([founder, ...(extra ?? []).filter(isFounderId)]);
  const founders = [founder, ...AUTH_FOUNDER_IDS.filter((id) => id !== founder && wanted.has(id))];
  return founders.length > 1 ? founders : undefined;
}

function parseFounders(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Gespeicherte Liste (JSON) – nur, wenn sie mehr sagt als `founder` allein. */
export function foundersColumn(founders: readonly AuthFounderId[] | undefined): string | null {
  return founders && founders.length > 1 ? JSON.stringify(founders) : null;
}

export function readFounders(role: AuthRole, founder: AuthFounderId | null, raw: string | null): AuthFounderId[] | undefined {
  return assistantFounders(role, founder, parseFounders(raw));
}

function isOnboarding(value: unknown): value is OnboardingKind {
  return value === 'setup' || value === 'intro';
}

/** Einführung, die ein neues Konto bekommt: Admins keine, Gründer und Mitarbeiter die Einarbeitung. */
export function onboardingFor(role: AuthRole): OnboardingKind | null {
  return role === 'admin' ? null : 'intro';
}

export function isRole(value: unknown): value is AuthRole {
  return typeof value === 'string' && (AUTH_ROLES as readonly string[]).includes(value);
}

export function validUsername(value: string): boolean {
  return ACCOUNT_USERNAME_PATTERN.test(value);
}

/** Satz für die Meldung bei ungültigem Anmeldenamen. */
export const USERNAME_RULE = 'Anmeldename: 2–40 Zeichen, Kleinbuchstaben, Ziffern, Punkt, Bindestrich oder Unterstrich.';

/**
 * Passen Rolle und Gründer zusammen? null = ja, sonst ein Satz, was nicht stimmt.
 * admin ⇒ founder null; founder/assistant ⇒ founder gesetzt.
 */
export function roleProblem(role: AuthRole, founder: AuthFounderId | null): string | null {
  if (role === 'admin') return founder === null ? null : 'Ein Admin-Konto gehört zu keinem Gründer.';
  return isFounderId(founder) ? null : `Für die Rolle ${role === 'founder' ? 'Gründer' : 'Mitarbeiter'} bitte den Gründer angeben (${AUTH_FOUNDER_IDS.join(' oder ')}).`;
}

/** Satz, wenn es für diesen Gründer schon ein Gründer-Konto (oder eine offene Gründer-Einladung) gibt. */
export function founderTakenMessage(founderName: string, username: string): string {
  return `Für ${founderName} gibt es schon ein Gründer-Konto (${username}). Je Gründer gibt es nur eines – lade ein Mitarbeiter- oder Admin-Konto ein oder entferne zuerst das alte.`;
}

/** Sortierung laut Vertrag: Admins, Gründer, Mitarbeiter, jeweils nach Anmeldename. */
export function compareAccounts(a: Pick<Account, 'role' | 'username'>, b: Pick<Account, 'role' | 'username'>): number {
  return AUTH_ROLES.indexOf(a.role) - AUTH_ROLES.indexOf(b.role) || a.username.localeCompare(b.username);
}

interface UserRow {
  username: string;
  name: string;
  role: string;
  founder: string | null;
  founders: string | null;
  onboarding: string | null;
  password_hash: string;
}

interface RegistrationRow {
  username: string;
  name: string;
  password_hash: string;
  created_at: number;
}

/** Offene Registrierung (Vertrag → „Registrierung und Einarbeitung“). */
export interface Registration {
  username: string;
  name: string;
  passwordHash: string;
  createdAt: number;
}

const USER_COLUMNS = 'username, name, role, founder, founders, onboarding, password_hash';

/** Zeile → Konto; Zeilen, deren Rolle/Gründer nicht passen (von Hand geändert), gelten als nicht vorhanden. */
function toAccount(row: UserRow): StoredAccount | null {
  if (!isRole(row.role)) return null;
  const founder = row.founder === null ? null : isFounderId(row.founder) ? row.founder : undefined;
  if (founder === undefined || roleProblem(row.role, founder)) return null;
  const account: StoredAccount = { username: row.username, name: row.name, founder, role: row.role, passwordHash: row.password_hash };
  const founders = readFounders(row.role, founder, row.founders);
  if (founders) account.founders = founders;
  if (isOnboarding(row.onboarding)) account.onboarding = row.onboarding;
  return account;
}

function toRegistration(row: RegistrationRow): Registration {
  return { username: row.username, name: row.name, passwordHash: row.password_hash, createdAt: row.created_at };
}

/** Registrierung als Konto für Anmeldung und Sitzung: ohne Rechte, bis jemand freigibt. */
function pendingAccount(registration: Registration): StoredAccount {
  return {
    username: registration.username,
    name: registration.name,
    founder: null,
    role: 'assistant',
    awaitingApproval: true,
    passwordHash: registration.passwordHash,
  };
}

/** Nur die öffentlichen Angaben (ohne Hash). */
export function publicAccount(account: Account): Account {
  const result: Account = { username: account.username, name: account.name, founder: account.founder, role: account.role };
  if (account.founders) result.founders = [...account.founders];
  if (account.awaitingApproval) result.awaitingApproval = true;
  if (account.onboarding) result.onboarding = account.onboarding;
  return result;
}

export class AccountStore {
  private demo = new Map<string, StoredAccount>();

  constructor(private readonly db: Database) {}

  /** Testkonten in den Speicher laden (Hash einmal beim Start). */
  async enableDemoAccounts(): Promise<void> {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    for (const user of DEMO_USERS) this.demo.set(user.username, { ...user, passwordHash });
  }

  get demoEnabled(): boolean {
    return this.demo.size > 0;
  }

  /**
   * Echtes Konto vor Testkonto – ein angelegtes „nick“ gilt immer mit seinem eigenen Passwort. Ohne Konto: offene
   * Registrierung (mit `awaitingApproval`), dann Testkonto.
   */
  find(username: string): StoredAccount | null {
    // Auch eine unbrauchbare Zeile (von Hand geändert) überdeckt das Testkonto – nie mit „demo“ hinein.
    const row = this.row(username);
    if (row) return toAccount(row);
    const registration = this.registration(username);
    if (registration) return pendingAccount(registration);
    return this.demo.get(username) ?? null;
  }

  /** Name schon vergeben: Konto, Testkonto oder offene Registrierung (offene Einladungen prüft der Aufrufer). */
  taken(username: string): boolean {
    return this.exists(username) || this.isDemo(username) || this.registration(username) !== null;
  }

  /** Konten im Kontospeicher (ohne Testkonten und Registrierungen). */
  storedCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  registration(username: string): Registration | null {
    const row = this.db.prepare('SELECT username, name, password_hash, created_at FROM registrations WHERE username = ?').get(username) as RegistrationRow | undefined;
    return row ? toRegistration(row) : null;
  }

  /** Offene Registrierungen, älteste zuerst. */
  listRegistrations(): Registration[] {
    const rows = this.db.prepare('SELECT username, name, password_hash, created_at FROM registrations ORDER BY created_at ASC, username ASC').all() as unknown as RegistrationRow[];
    return rows.map(toRegistration);
  }

  registrationCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM registrations').get() as { n: number }).n;
  }

  saveRegistration(registration: Registration): void {
    this.db
      .prepare('INSERT INTO registrations (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(registration.username, registration.name, registration.passwordHash, registration.createdAt);
  }

  removeRegistration(username: string): boolean {
    return Number(this.db.prepare('DELETE FROM registrations WHERE username = ?').run(username).changes) > 0;
  }

  /** Einführung erledigt (null) oder neu setzen. */
  setOnboarding(username: string, onboarding: OnboardingKind | null, now = Date.now()): boolean {
    return Number(this.db.prepare('UPDATE users SET onboarding = ?, updated_at = ? WHERE username = ?').run(onboarding, now, username).changes) > 0;
  }

  /** Testkonto, das gerade gilt (kein echtes Konto gleichen Namens). */
  isDemo(username: string): boolean {
    return this.demo.has(username) && !this.exists(username);
  }

  /** Konten aus dem Kontospeicher (ohne Testkonten). */
  list(): Account[] {
    const rows = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users`).all() as unknown as UserRow[];
    return rows
      .map(toAccount)
      .filter((account): account is StoredAccount => account !== null)
      .map(publicAccount)
      .sort(compareAccounts);
  }

  /**
   * Namen der Gründer für die Oberfläche und Meldungen (Vertrag `AuthUser.founderNames`): je Gründer der Anzeigename
   * seines Gründer-Kontos, bei mehreren das erste nach Anmeldename. Sind Testkonten an (Entwicklung, E2E), gelten sie
   * zuerst – dort sind sie die Gründer, Konten aus Tests ändern die Namen nicht. Ohne Konto fehlt der Eintrag.
   */
  founderNames(): Partial<Record<AuthFounderId, string>> {
    const names: Partial<Record<AuthFounderId, string>> = {};
    for (const account of [...this.listDemo().sort(compareAccounts), ...this.list()]) {
      if (account.role === 'founder' && account.founder && !names[account.founder]) names[account.founder] = account.name;
    }
    return names;
  }

  /** Name eines Gründers für Meldungen: Anzeigename seines Kontos, sonst `defaultFounderName` („Nick“). */
  founderName(id: AuthFounderId): string {
    return this.founderNames()[id] ?? defaultFounderName(id);
  }

  /**
   * Gründer-Konto eines Gründers im Kontospeicher (außer `except`) – je Gründer gibt es höchstens eins
   * (Sicherheitsprüfung 08.10.: kein zweites Gründer-Konto, mit dem jemand im Namen des Gründers arbeitet).
   */
  founderAccount(founder: AuthFounderId, except?: string): Account | null {
    return this.list().find((account) => account.role === 'founder' && account.founder === founder && account.username !== except) ?? null;
  }

  /** Testkonten, die gerade gelten (ohne die von echten Konten überdeckten). */
  listDemo(): Account[] {
    return [...this.demo.values()].filter((account) => !this.exists(account.username)).map(publicAccount);
  }

  /**
   * Legt ein Konto an oder ersetzt Name, Rolle, Gründer und Passwort eines bestehenden. `onboarding` zählt nur beim
   * Anlegen – ein bestehendes Konto behält seine offene Einführung.
   */
  async save(user: Account, password: string, now = Date.now()): Promise<void> {
    this.saveHash(user, await hashPassword(password), now);
  }

  /** Wie `save`, aber mit fertigem Hash – synchron, damit es in eine Transaktion passt. */
  saveHash(user: Account, passwordHash: string, now = Date.now()): void {
    const problem = roleProblem(user.role, user.founder);
    if (problem) throw new Error(problem);
    const founders = foundersColumn(assistantFounders(user.role, user.founder, user.founders));
    this.db
      .prepare(
        `INSERT INTO users (username, name, role, founder, founders, onboarding, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (username) DO UPDATE SET name = excluded.name, role = excluded.role, founder = excluded.founder,
           founders = excluded.founders, password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
      )
      .run(user.username, user.name, user.role, user.founder, founders, user.onboarding ?? null, passwordHash, now, now);
  }

  /** Nur das Passwort eines bestehenden Kontos ersetzen (Name, Rolle und Gründer bleiben). */
  setPasswordHash(username: string, passwordHash: string, now = Date.now()): boolean {
    return Number(this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?').run(passwordHash, now, username).changes) > 0;
  }

  /** Konto aus dem Kontospeicher (ohne Testkonten). */
  findStored(username: string): StoredAccount | null {
    const row = this.row(username);
    return row ? toAccount(row) : null;
  }

  private row(username: string): UserRow | undefined {
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`).get(username) as UserRow | undefined;
  }

  exists(username: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username));
  }

  remove(username: string): boolean {
    return Number(this.db.prepare('DELETE FROM users WHERE username = ?').run(username).changes) > 0;
  }
}
