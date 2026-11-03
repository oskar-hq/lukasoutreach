/**
 * Vertrag für Sicherungen und Software-Updates in der Oberfläche – wird von Frontend (Vite) und Backend (Node)
 * importiert. Nur Typen und Konstanten.
 *
 * Ziel des Nutzers (06.10.): „Ich soll in keiner Situation in die Shell müssen.“ Was bisher `backupCli`,
 * `docker compose exec … ls data/backups` und `git pull && docker compose … up -d --build` war, geht hier per Klick.
 * Nur Konten mit `canEditSettings` (Admin, Gründer); Mitarbeiter → 403 not_allowed. Alle Routen mit Sitzung.
 *
 * ── Sicherungen ──
 *   GET  /api/system/backups                   → 200 BackupListResponse (neueste zuerst)
 *   POST /api/system/backups                   → 200 BackupInfo (jetzt sichern) · 409 busy (Sicherung läuft schon)
 *   POST /api/system/backups/:name/download    BackupPasswordRequest → 200 Datei (application/octet-stream,
 *                                              Content-Disposition attachment) · 403 reauth_failed · 404 not_found ·
 *                                              429 too_many_attempts. POST mit Passwort, weil die Datei alle Leads
 *                                              enthält; das Passwort zählt wie bei den Einstellungen als Fehlversuch.
 *   POST /api/system/backups/:name/restore     BackupPasswordRequest → 202 RestoreResponse · 403 · 404 · 409 busy ·
 *                                              429. Ablauf: erst den jetzigen Stand sichern (`vor-wiederherstellen-…`),
 *                                              dann die Sicherung prüfen (SQLite `integrity_check`, sonst 400
 *                                              invalid_backup und nichts geändert), dann einspielen und das Backend
 *                                              neu starten (Docker startet es wieder). Alle Sitzungen bleiben gültig,
 *                                              wenn sie in der Sicherung stehen – sonst neu anmelden.
 *                                              Simulation: nichts wird ersetzt, nur 202 mit Hinweis.
 *   `name` erfüllt `BACKUP_NAME_PATTERN`, sonst 404 (kein Pfad, keine Punkte davor). Geplant wird weiter über
 *   `BACKUP_HOUR_UTC`/`BACKUP_KEEP` (Einstellungen → Sicherung und Updates).
 *   Vor jedem Update (Knopf und nachts) sichert das Backend die Datenbank als `vor-update-…` (Art `before_update`,
 *   es bleiben die letzten `BEFORE_UPDATE_KEEP`, wie alle Arten höchstens `BACKUP_MAX_AGE_DAYS` Tage). Scheitert diese
 *   Sicherung, startet das Update nicht (503 `backup_failed` mit Satz).
 *   `BackupListResponse.disk`: freier Platz im Datenordner (fehlt bei älterem Backend). Wird es knapp (unter
 *   `DISK_LOW_BYTES` oder `DISK_LOW_PERCENT` %), meldet das Backend es zusätzlich in den Neuigkeiten (`disk_low`).
 *
 * ── Schlüssel für Geheimnisse ──
 *   POST /api/system/settings-key              BackupPasswordRequest → 200 SettingsKeyResponse · 403 reauth_failed ·
 *                                              429 too_many_attempts. Zeigt den Schlüssel, mit dem die Geheimnisse der
 *                                              Einstellungen verschlüsselt sind (zum Ablegen im Passwort-Manager –
 *                                              ohne ihn sind sie nach dem Verlust des Servers nicht mehr lesbar).
 *                                              Kommt er aus `SETTINGS_KEY` (.env), nennt die Antwort nur das.
 *
 * ── Updates ──
 *   GET  /api/system/update                    → 200 UpdateStatusResponse (ohne Netz; zuletzt geprüfter Stand)
 *   POST /api/system/update/check              → 200 UpdateStatusResponse (jetzt bei GitHub nachsehen) ·
 *                                              503 updater_unavailable · 429 too_many_attempts (höchstens 1× je 10 s)
 *   POST /api/system/update                    UpdateRequest → 202 UpdateStatusResponse (`state: 'running'`) ·
 *                                              ohne Passwort (seit 23.10.) · 409 update_running | up_to_date | busy (Lead-Suche
 *                                              läuft gerade) ·
 *                                              503 updater_unavailable · 429 too_many_attempts
 *   „Etwas einzuspielen“ heißt: `behind > 0` ODER `pendingBuild` (Code schon geholt, aber Bauen/Starten scheiterte
 *   oder wurde unterbrochen) – dann geht „Update einspielen“ (auch nachts) noch einmal, statt „aktuell“ zu melden.
 *   Ein Update spielt den Integrations-Branch des Servers ein (wie `git pull`) und baut und startet die Software neu
 *   (wie `docker compose … up -d --build`). Das Backend ist dabei 1–5 Minuten nicht erreichbar; die Oberfläche fragt
 *   `GET /api/system/update` nach, bis es wieder antwortet, und lädt dann neu. `lastRun` übersteht den Neustart.
 *   Automatisch: `UPDATE_AUTO` + `UPDATE_HOUR` (deutsche Zeit) – nur wenn es etwas Neues gibt, nie während einer
 *   Lead-Suche (dann eine Stunde später erneut).
 *
 *   Technik (nur Backend/Server): ein kleiner Update-Dienst als eigener Container (`deploy/updater`) mit Zugriff auf
 *   Docker und das Projekt-Verzeichnis, nur im internen Docker-Netz erreichbar und nur mit gemeinsamem Schlüssel.
 *   Einmal einrichten mit dem letzten Update von Hand (README → Updates). Fehlt der Dienst: `available: false` mit
 *   `reason` (fertiger Satz für die Oberfläche).
 *   Simulation (`LEAD_SEARCH_MODE=mock` ohne Update-Dienst): erfundene Versionen; „Update“ dauert ein paar Sekunden
 *   und meldet danach „aktuell“ – es wird nichts eingespielt.
 *
 * Fehlercodes (`ApiErrorBody.error.code`, Meldung als fertiger deutscher Satz): `not_allowed` (403), `reauth_failed`
 * (403), `not_found` (404), `invalid_backup` (400), `busy` (409), `update_running` (409), `up_to_date` (409),
 * `updater_unavailable` (503), `backup_failed` (503, Sicherung vor dem Update ging nicht), `too_many_attempts`
 * (429, Retry-After).
 */

export const BACKUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.db$/;

export interface BackupInfo {
  /** Dateiname, z. B. „cockpit-2026-10-06-0200.db“. */
  name: string;
  /** Größe in Bytes. */
  size: number;
  /** Erstellt (ms). */
  createdAt: number;
  /** Wie entstanden: geplant, von Hand, automatisch vor dem Wiederherstellen oder vor einem Update. */
  kind: 'scheduled' | 'manual' | 'before_restore' | 'before_update';
}

export interface BackupListResponse {
  backups: BackupInfo[];
  /** Nächste geplante Sicherung (ms) oder null (aus). */
  nextAt: number | null;
  /** So viele geplante Sicherungen werden aufbewahrt (`BACKUP_KEEP`). */
  keep: number;
  /** Sicherungen (jeder Art) werden nach so vielen Tagen gelöscht (`BACKUP_MAX_AGE_DAYS`, Standard 7) – fehlt bei älterem Backend. */
  maxAgeDays?: number;
  /** Letzte Sicherung fehlgeschlagen: fertiger Satz, sonst null. */
  lastError: string | null;
  /** Freier Platz im Datenordner – fehlt bei älterem Backend oder wenn er sich nicht lesen ließ. */
  disk?: DiskSpaceInfo;
}

/** Freier Speicherplatz im Datenordner (`DATA_DIR`). */
export interface DiskSpaceInfo {
  /** Frei für das Backend (Bytes). */
  freeBytes: number;
  /** Größe des Datenträgers (Bytes). */
  totalBytes: number;
  /** Knapp: unter `DISK_LOW_BYTES` oder unter `DISK_LOW_PERCENT` % frei. */
  low: boolean;
  /** Zuletzt geprüft (ms). */
  checkedAt: number;
}

/** Unter 1 GB frei gilt als knapp … */
export const DISK_LOW_BYTES = 1024 * 1024 * 1024;
/** … oder unter 10 % frei. */
export const DISK_LOW_PERCENT = 10;
/** So viele Sicherungen „vor dem Update“ bleiben. */
export const BEFORE_UPDATE_KEEP = 3;

export interface SettingsKeyResponse {
  /** `file`: Schlüsseldatei im Datenordner (Wert in `key`) · `env`: aus `SETTINGS_KEY` · `none`: noch kein Geheimnis gespeichert. */
  source: 'file' | 'env' | 'none';
  /** Nur bei `file`: der Schlüssel (base64) zum Ablegen im Passwort-Manager. */
  key: string | null;
  /** Fertiger Satz für die Oberfläche. */
  message: string;
}

export interface BackupPasswordRequest {
  password: string;
}

export interface RestoreResponse {
  /** Fertiger Satz, z. B. „Sicherung vom 06.10. wird eingespielt – das Cockpit startet neu.“ */
  message: string;
  /** Name der Sicherung des Stands vorher (null in der Simulation). */
  safetyBackup: string | null;
}

export interface VersionInfo {
  /** Kurzer Commit (7 Zeichen). */
  commit: string;
  /** Erste Zeile der Commit-Nachricht bzw. Titel des PRs. */
  title: string;
  /** Zeitpunkt des Commits (ms). */
  date: number;
}

export type UpdateState = 'idle' | 'running' | 'failed' | 'done';

export interface UpdateRun {
  startedAt: number;
  finishedAt: number | null;
  /** null, solange es läuft. */
  ok: boolean | null;
  /** Fertiger Satz, z. B. „Auf c0ffee1 aktualisiert.“ oder der Grund des Fehlers (ohne Geheimnisse). */
  message: string;
  /** Automatisch nachts oder per Klick (Anzeigename des Kontos). */
  by: string;
}

export interface UpdateStatusResponse {
  /** Update-Dienst erreichbar. */
  available: boolean;
  /** Bei `available: false`: fertiger Satz, warum (z. B. „Der Update-Dienst ist noch nicht eingerichtet …“). */
  reason: string | null;
  /** Läuft gerade. */
  current: VersionInfo | null;
  /** Neueste Version im Integrations-Branch (zuletzt geprüft) oder null. */
  latest: VersionInfo | null;
  /** So viele neue Commits; 0 = aktuell (außer `pendingBuild`). */
  behind: number;
  /** Code ist schon geholt, aber das letzte Bauen/Starten scheiterte oder wurde unterbrochen – erneut einspielen. */
  pendingBuild?: boolean;
  /** Was neu ist, neueste zuerst, höchstens `UPDATE_CHANGES_MAX`. */
  changes: VersionInfo[];
  /** Zuletzt bei GitHub nachgesehen (ms) oder null. */
  checkedAt: number | null;
  state: UpdateState;
  lastRun: UpdateRun | null;
  /** Aus den Einstellungen `UPDATE_AUTO`/`UPDATE_HOUR`. */
  auto: { enabled: boolean; hour: number };
  /** Nächster automatischer Versuch (ms) oder null. */
  nextAutoAt: number | null;
  /** Simulation – es wird nichts eingespielt. */
  simulated: boolean;
}

export interface UpdateRequest {
  /** Früher Pflicht, seit 23.10. ohne Bedeutung (Update ohne Passwort) – alte Oberflächen schicken es noch mit. */
  password?: string;
}

export const UPDATE_CHANGES_MAX = 30;

export type SystemErrorCode =
  | 'not_allowed'
  | 'reauth_failed'
  | 'not_found'
  | 'invalid_backup'
  | 'busy'
  | 'update_running'
  | 'up_to_date'
  | 'updater_unavailable'
  | 'backup_failed'
  | 'too_many_attempts';
