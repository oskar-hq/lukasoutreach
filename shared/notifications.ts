/**
 * Neuigkeiten vom Programm (Wunsch des Nutzers 08.10.): eine Glocke oben rechts neben dem Konto-Menü. Dort landen
 * Meldungen des Servers – keine Chats, sondern was jemand wissen oder beheben muss: neue Registrierung wartet auf
 * Freigabe, Lead-Suche abgebrochen (Schlüssel abgelehnt, Dienst nicht erreichbar …), LinkedIn pausiert, Sicherung oder
 * Update fehlgeschlagen (auch wenn das nächtliche Update erst beim Bauen scheitert), Speicherplatz knapp.
 * Wenn alles läuft, kommt hier fast nichts an.
 *
 *   GET  /api/notifications       → 200 NotificationListResponse (neueste zuerst, höchstens `NOTIFICATION_LIMIT` –
 *                                   dazu immer alle ungelesenen `account_change`, auch über die Grenze hinaus)
 *   POST /api/notifications/seen  → 200 NotificationListResponse (alles bis jetzt gilt für dieses Konto als gesehen)
 *
 * Wer sieht was:
 *   - `audience: 'managers'` (z. B. Registrierungen) nur Gründer und Admins – Konten verwalten nur sie.
 *   - Änderungen an Konten (`account_change`) nur Gründer – die Inhaber sehen, wer welches Konto angelegt hat.
 *   - `audience: 'all'` alle Konten. Betrifft eine Meldung einen Gründer (`founder`), sehen Mitarbeiter sie nur, wenn
 *     sie für diesen Gründer arbeiten.
 *   - `needsFounder`: Beheben können nur Gründer oder Admins (Schlüssel, Einstellungen). Mitarbeiter sehen dazu
 *     „Sag … Bescheid“ mit den Namen der Gründer (`AuthUser.founderNames`).
 *
 * Gleiche Meldungen werden zusammengefasst (`count`, `updatedAt` wandert nach vorn), statt die Liste zu füllen. Ist
 * das Problem behoben (z. B. nächster Suchlauf klappt, Registrierung entschieden), verschwindet die Meldung von selbst.
 * Nach `NOTIFICATION_MAX_AGE_DAYS` ohne Wiederholung ebenfalls.
 *
 * Slack: Jede neue Meldung geht zusätzlich an Slack (`SLACK_WEBHOOK_URL`, nur im echten Betrieb); eine Wiederholung
 * derselben Meldung höchstens alle `NOTIFICATION_SLACK_REPEAT_HOURS` Stunden.
 *
 * Simulation: Der Demo-Reset legt zwei Beispiel-Meldungen an (Suchlauf abgebrochen, Sicherung fehlgeschlagen), damit
 * die Oberfläche etwas zu zeigen hat. Registrierungen erzeugen in jedem Modus echte Meldungen.
 */

import type { AuthFounderId } from './auth.js';

/**
 * `account_change`: Konto eingeladen, freigegeben, Passwort-Link erzeugt oder entfernt; außerdem Schlüssel für
 * Geheimnisse angezeigt, Sicherung heruntergeladen oder wiederhergestellt – nur für Gründer sichtbar.
 * `unipile_down`: Die regelmäßige Prüfung (nur live, alle paar Stunden) bekommt von Unipile keinen startklaren
 * LinkedIn-Account – z. B. Testzeitraum/Abo abgelaufen (`no_client_session`), Token abgelehnt, Account getrennt.
 * Nur Gründer und Admins (`audience: 'managers'`). „Nicht erreichbar“ erst nach zwei Prüfungen in Folge. Verschwindet,
 * sobald die Prüfung wieder klappt oder sie aus ist (Simulation, Token entfernt).
 */
export const NOTIFICATION_KINDS = ['registration', 'search_failed', 'linkedin_paused', 'backup_failed', 'update_failed', 'account_change', 'disk_low', 'unipile_down'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** `info` = zur Kenntnis (z. B. Registrierung), `warning` = bald kümmern, `error` = etwas läuft nicht. */
export type NotificationSeverity = 'info' | 'warning' | 'error';

/** Wohin ein Klick auf die Meldung führt. `section` = Bereich der Einstellungen (`settingsNav.ts`). */
export type NotificationTarget = { view: 'accounts' } | { view: 'search' } | { view: 'home' } | { view: 'settings'; section?: string };

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  /** Kurz, z. B. „Lead-Suche abgebrochen“. */
  title: string;
  /** Ein bis zwei Sätze: was passiert ist und was zu tun ist (Ansprache „du“). */
  text: string;
  /** Erstes Auftreten (ms). */
  createdAt: number;
  /** Letztes Auftreten (ms) – danach wird sortiert. */
  updatedAt: number;
  /** Wie oft seit `createdAt` (≥ 1). */
  count: number;
  /** Betrifft nur diesen Gründer (z. B. sein LinkedIn-Account), sonst null. */
  founder: AuthFounderId | null;
  /** Beheben können nur Gründer oder Admins. */
  needsFounder: boolean;
  target: NotificationTarget | null;
  /** Neu für dieses Konto (seit dem letzten „gesehen“ aufgetreten). */
  unread: boolean;
}

export interface NotificationListResponse {
  notifications: AppNotification[];
  /** Anzahl `unread` – für den Punkt an der Glocke. */
  unread: number;
}

export const NOTIFICATION_LIMIT = 50;
export const NOTIFICATION_MAX_AGE_DAYS = 14;
export const NOTIFICATION_SLACK_REPEAT_HOURS = 12;

/** „Nick“, „Nick und Johannes“, „Anna, Ben und Carla“ – für „Sag … Bescheid“. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`;
}
