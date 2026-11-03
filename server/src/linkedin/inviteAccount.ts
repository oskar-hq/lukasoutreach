import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';

/**
 * Über wessen LinkedIn-Account geht die nächste Vernetzungsanfrage? (Wunsch des Nutzers 12.10.: „20 je Account – ist
 * der erste voll, wird auf den anderen umgeswitcht“.) Gezählt wird je Account, über den eine Anfrage ging
 * (`lead.linkedin.sentBy`, sonst der Besitzer) – für Senden über Unipile und Eintragen von Hand gleich.
 */
export interface InviteCounts {
  today: Partial<Record<AuthFounderId, number>>;
  week: Partial<Record<AuthFounderId, number>>;
}

export interface InviteLimits {
  perDay: number;
  /** Eigene Tagesgrenze je Gründer-Account (Einstellung am Account, 21.10.) – ersetzt `perDay` für ihn. */
  perDayFor?: Partial<Record<AuthFounderId, number>>;
  perWeek: number;
  /** `LINKEDIN_ACCOUNT_FALLBACK` */
  fallback: boolean;
}

/** Der andere Gründer (zwei Gründer, ein Account je Gründer). */
export function otherFounder(founder: AuthFounderId): AuthFounderId | null {
  return AUTH_FOUNDER_IDS.find((id) => id !== founder) ?? null;
}

/** Hat dieser Account heute bzw. in 7 Tagen noch Platz? */
export function accountHasRoom(account: AuthFounderId, counts: InviteCounts, limits: InviteLimits): boolean {
  return (counts.today[account] ?? 0) < (limits.perDayFor?.[account] ?? limits.perDay) && (counts.week[account] ?? 0) < limits.perWeek;
}

/**
 * Eigener Account, solange er Platz hat; sonst – mit Fallback – der des anderen Gründers, wenn der Platz hat und
 * `usable` ihn erlaubt (live: eingetragen und nicht pausiert). null = beide voll → Sperre.
 */
export function inviteAccountFor(
  owner: AuthFounderId,
  counts: InviteCounts,
  limits: InviteLimits,
  usable: (account: AuthFounderId) => boolean = () => true,
): AuthFounderId | null {
  if (accountHasRoom(owner, counts, limits)) return owner;
  const other = limits.fallback ? otherFounder(owner) : null;
  if (other && usable(other) && accountHasRoom(other, counts, limits)) return other;
  return null;
}
