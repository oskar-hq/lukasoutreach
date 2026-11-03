import { authRole, canEditBoardColumns, canEditSettings, defaultFounderName, canManageAccounts, canSendOnLinkedIn, workingFounders, type AuthFounderId, type AuthUser } from '../../../shared/auth.js';

/**
 * Rechte je Rolle laut Vertrag (`shared/auth.ts` → „Rollen und Rechte“), zentral an einer Stelle.
 * Der Hook in `auth.ts` fragt `roleDenial` für jede angemeldete `/api/*`-Anfrage; ein Satz heißt 403 `not_allowed`.
 * Die Prüfung nutzt die Helfer aus dem Vertrag, damit Oberfläche und Backend dasselbe entscheiden.
 */

/** Sätze für 403 `not_allowed` – die Oberfläche zeigt sie so an. */
export const ROLE_MESSAGES = {
  settings: 'Mitarbeiter-Konten können die Einstellungen nicht sehen oder ändern.',
  system: 'Mitarbeiter-Konten können Sicherungen und Updates nicht sehen oder auslösen.',
  templates: 'Mitarbeiter-Konten können Vorlagen nur lesen, nicht ändern.',
  accounts: 'Mitarbeiter-Konten können keine Konten verwalten.',
  linkedin: 'Admin-Konten senden nicht über LinkedIn – trag die Aktion ein.',
  tracking: 'Mitarbeiter-Konten können die Tracking-Liste nicht ersetzen oder löschen.',
  demoReset: 'Mitarbeiter-Konten können die Simulation nicht zurücksetzen.',
  boardColumns: 'Mitarbeiter-Konten können die Spalten im Board nicht anlegen, umbenennen oder löschen – das machen Admin oder Gründer.',
  autoSearch: 'Mitarbeiter-Konten können die automatische Lead-Suche nicht sehen oder ändern.',
  autoSearchFounder: 'Du kannst nur deinen eigenen Zeitplan der automatischen Suche sehen und ändern.',
  linkedinSetup: 'Mitarbeiter-Konten können LinkedIn nicht einrichten – das machen Admin oder Gründer.',
  linkedinTestInvite: 'Admin-Konten senden nicht über LinkedIn – Test-Anfrage und Test-Nachricht schickt der Gründer über seinen eigenen Account.',
  linkedinOwnAccount: 'Ein Test geht nur über deinen eigenen LinkedIn-Account.',
  leadData: 'Mitarbeiter-Konten können Leads nicht exportieren oder endgültig löschen – das machen Admin oder Gründer.',
} as const;

/** Name eines Gründers für Meldungen – im Server `AccountStore.founderName` (Name aus dem Gründer-Konto). */
export type FounderNameOf = (id: AuthFounderId) => string;

/** 403-Satz, wenn ein Mitarbeiter für einen anderen Gründer arbeiten will (Stapel, Lead, Übergabe). */
export function foreignFounderMessage(
  own: AuthFounderId | readonly AuthFounderId[] | null,
  other: AuthFounderId,
  nameOf: FounderNameOf = defaultFounderName,
): string {
  const list = own === null ? [] : typeof own === 'string' ? [own] : own;
  const ownName = list.length ? list.map(nameOf).join(' und ') : 'deinen Gründer';
  return `Als Mitarbeiter arbeitest du nur für ${ownName} – das hier gehört ${nameOf(other)}.`;
}

/**
 * Mitarbeiter nur für ihre Gründer (Vertrag „Rollen und Rechte“, `founders`): null = erlaubt, sonst der 403-Satz.
 * Gründer und Admin dürfen alles; ohne Anmeldung (Übergang) ebenfalls.
 */
export function assistantDenial(
  user: Pick<AuthUser, 'founder' | 'role' | 'founders'> | null,
  owner: AuthFounderId,
  nameOf: FounderNameOf = defaultFounderName,
): string | null {
  if (!user || authRole(user) !== 'assistant') return null;
  const own = workingFounders(user);
  return own.includes(owner) ? null : foreignFounderMessage(own, owner, nameOf);
}

/**
 * Über wessen Account eine Aktion an einem Lead läuft (LinkedIn senden, Übergabe): Gründer und Admin wie bisher
 * `founder`; Mitarbeiter null = Besitzer des Leads. Dass der Lead einem ihrer Gründer gehört, prüft schon
 * `assistantDenial` (preHandler der Lead-Routen).
 */
export function actingFounder(user: Pick<AuthUser, 'founder' | 'role'> | null): AuthFounderId | null {
  if (!user || authRole(user) === 'assistant') return null;
  return user.founder;
}

/**
 * `LeadEvent.actor`: Anzeigename, wenn nicht der Gründer selbst bucht (Admin, Mitarbeiter, Gründer für einen anderen
 * Gründer). Bucht ein Gründer-Konto für sich selbst (`by` = sein Gründer) oder ohne Anmeldung → null.
 */
export function actorFor(user: Pick<AuthUser, 'founder' | 'role' | 'name'> | null, by: AuthFounderId | null): string | null {
  if (!user) return null;
  if (authRole(user) === 'founder' && user.founder === by) return null;
  return user.name;
}

/**
 * Zeitplan der automatischen Suche (Vertrag shared/autoSearch.ts): Gründer nur den eigenen, Admin beide; ohne
 * Anmeldung (Übergang) ebenfalls beide. Mitarbeiter sperrt schon `roleDenial`. null = erlaubt, sonst der 403-Satz.
 */
export function autoSearchDenial(user: Pick<AuthUser, 'founder' | 'role'> | null, founder: AuthFounderId): string | null {
  if (!user) return null;
  const role = authRole(user);
  if (role === 'assistant') return ROLE_MESSAGES.autoSearch;
  if (role === 'founder' && user.founder !== founder) return ROLE_MESSAGES.autoSearchFounder;
  return null;
}

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Pfad liegt unter `prefix` (genau oder mit `/…` dahinter) – `/api/settingsX` zählt nicht. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

const LINKEDIN_SEND = /^\/api\/leads\/[^/]+\/linkedin\/(invite|message)\/?$/;
/** Einrichten in der Oberfläche (Vertrag shared/linkedin.ts): wie Einstellungen nur Admin und Gründer. */
const LINKEDIN_SETUP = /^\/api\/linkedin\/(accounts(\/[^/]+(\/limits)?)?|warmup|test-invite|test-profile|test-message|test-connect)\/?$/;
/** Test-Anfrage und Test-Nachricht senden echt: wie Senden im Cockpit nie mit einem Admin-Konto. */
const LINKEDIN_TEST_INVITE = /^\/api\/linkedin\/(test-invite|test-message|test-connect)\/?$/;
/** Betroffenenrechte (Vertrag shared/leads.ts): Auskunft und endgültiges Löschen nur Admin und Gründer. */
const LEAD_EXPORT = /^\/api\/leads\/[^/]+\/export\/?$/;
const LEAD_ITEM = /^\/api\/leads\/[^/]+\/?$/;

/** null = erlaubt, sonst der Satz für 403 `not_allowed`. `path` ohne Query. */
export function roleDenial(user: Pick<AuthUser, 'founder' | 'role'>, method: string, path: string): string | null {
  if (!canEditSettings(user)) {
    if (under(path, '/api/settings')) return ROLE_MESSAGES.settings;
    if (under(path, '/api/system')) return ROLE_MESSAGES.system;
    if (under(path, '/api/templates') && !READ_METHODS.has(method)) return ROLE_MESSAGES.templates;
    if (LINKEDIN_SETUP.test(path)) return ROLE_MESSAGES.linkedinSetup;
  }
  if (!canManageAccounts(user) && under(path, '/api/accounts')) return ROLE_MESSAGES.accounts;
  // Board-Spalten gelten für alle: nur Gründer und Admin ändern sie (lesen dürfen alle).
  if (!canEditBoardColumns(user) && under(path, '/api/board/columns') && !READ_METHODS.has(method)) return ROLE_MESSAGES.boardColumns;
  // Wirkung über alle Gründer hinweg (wie Einstellungen): nur Gründer und Admin.
  if (authRole(user) === 'assistant') {
    if (path === '/api/lead-search/tracking' && !READ_METHODS.has(method)) return ROLE_MESSAGES.tracking;
    if (path === '/api/leads/demo/reset') return ROLE_MESSAGES.demoReset;
    // Automatische Lead-Suche (Vertrag shared/autoSearch.ts): wie Einstellungen – auch nicht lesen.
    if (under(path, '/api/auto-search')) return ROLE_MESSAGES.autoSearch;
    if (LEAD_EXPORT.test(path) || (method === 'DELETE' && LEAD_ITEM.test(path))) return ROLE_MESSAGES.leadData;
  }
  if (!canSendOnLinkedIn(user) && method === 'POST') {
    if (LINKEDIN_SEND.test(path)) return ROLE_MESSAGES.linkedin;
    if (LINKEDIN_TEST_INVITE.test(path)) return ROLE_MESSAGES.linkedinTestInvite;
  }
  return null;
}
