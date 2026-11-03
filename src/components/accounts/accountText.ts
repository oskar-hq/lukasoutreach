import {
  ACCOUNT_NAME_MAX_LENGTH,
  ACCOUNT_USERNAME_PATTERN,
  AUTH_ROLE_LABELS,
  INVITE_PATH,
  INVITE_VALID_DAYS,
  RESET_VALID_HOURS,
  type AccountInfo,
  type AuthFounderId,
  type AuthRole,
} from '../../../shared/auth';
import { FOUNDERS } from '../../data/founders';
import { ApiError } from '../../lib/leadSearchApi';

/** Texte und Prüfungen der Seite „Konten“ (Regeln in `shared/auth.ts` → „Rollen und Rechte“). */

export const founderName = (founder: AuthFounderId) => FOUNDERS[founder].name;

/** „Nick“, „Nick und Johannes“ */
export const founderNames = (founders: readonly AuthFounderId[]) => founders.map(founderName).join(' und ');

/** „Admin“, „Gründer“, „Mitarbeiter für Nick“, „Mitarbeiter für Nick und Johannes“. */
export function roleText(account: Pick<AccountInfo, 'role' | 'founder' | 'founders'>): string {
  if (account.role === 'assistant' && account.founder) {
    return `${AUTH_ROLE_LABELS.assistant} für ${founderNames(account.founders?.length ? account.founders : [account.founder])}`;
  }
  return AUTH_ROLE_LABELS[account.role];
}

/** Kurze Erklärung je Rolle im Einladungsformular (Admin wählt). */
export const ROLE_HINTS: Record<AuthRole, string> = {
  admin: 'Sieht beide Tagesstapel, trägt Entscheidungen ein, verwaltet Einstellungen und Konten. Sendet nichts über LinkedIn.',
  founder: 'Eigener Tagesstapel und LinkedIn-Account, verwaltet Einstellungen und Konten.',
  assistant: 'Arbeitet die Tagesstapel der gewählten Gründer ab und sendet in deren Namen. Keine Einstellungen.',
};

/** Erklärung, wenn ein Gründer einlädt (er darf nur Mitarbeiter einladen). */
export const ASSISTANT_HINT_FOR_FOUNDER = 'Mitarbeiter arbeiten deine Aufgaben ab und senden in deinem Namen – Einstellungen sehen sie nicht.';

/** Anmeldename so, wie das Backend ihn vergleicht. */
export const normalizeUsername = (value: string) => value.trim().toLowerCase();

export function usernameProblem(value: string): string | null {
  const username = normalizeUsername(value);
  if (!username) return 'Bitte gib einen Anmeldenamen ein.';
  if (!ACCOUNT_USERNAME_PATTERN.test(username)) {
    return 'Der Anmeldename braucht 2–40 Zeichen: Kleinbuchstaben, Ziffern, Punkt, Unterstrich oder Bindestrich – vorne ein Buchstabe oder eine Ziffer.';
  }
  return null;
}

export function nameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Bitte gib einen Anzeigenamen ein.';
  if (name.length > ACCOUNT_NAME_MAX_LENGTH) return `Der Anzeigename darf höchstens ${ACCOUNT_NAME_MAX_LENGTH} Zeichen haben.`;
  return null;
}

/** Link, den die Oberfläche zum Kopieren zeigt. Das Token kommt nur einmal vom Server und bleibt nur im Speicher. */
export const inviteLink = (token: string) => `${window.location.origin}${INVITE_PATH}#${token}`;

const dateFormat = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** „13.10., 14:05“ */
export const formatExpiry = (ms: number) => dateFormat.format(ms);

export function validityText(reset: boolean, expiresAt: number): string {
  const span = reset ? `${RESET_VALID_HOURS} Stunden` : `${INVITE_VALID_DAYS} Tage`;
  return `Gilt ${span} und nur einmal – bis ${formatExpiry(expiresAt)} Uhr.`;
}

export const NOT_ALLOWED = 'Dafür fehlen deinem Konto die Rechte.';

/** Fehler aus `/api/accounts*` als ein deutscher Satz. */
export function accountError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === 'not_allowed') return NOT_ALLOWED;
  if (error.code === 'offline') return 'Der Server ist gerade nicht erreichbar. Versuch es gleich noch einmal.';
  // Ältere Backends: Route fehlt (404 ohne Code bzw. Fastifys „Not Found“).
  if (error.status === 404 && error.code === 'error') return 'Konten verwalten gibt es auf diesem Server noch nicht – das kommt mit dem nächsten Update.';
  if (error.code === 'error') return fallback;
  return error.message || fallback;
}
