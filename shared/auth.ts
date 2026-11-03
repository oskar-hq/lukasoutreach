/**
 * Vertrag für Anmeldung und Sitzung (Roadmap Phase 1) – wird von Frontend (Vite) und Backend (Node) importiert.
 * Wie `leadSearch.ts` ohne Imports und ohne Laufzeit-Abhängigkeiten.
 *
 * Routen:
 *   POST /api/auth/login   LoginRequest → 200 AuthResponse + Sitzungs-Cookie
 *                          400 invalid_request · 401 invalid_credentials · 429 too_many_attempts (mit Retry-After)
 *   POST /api/auth/logout  → 200 { ok: true }, beendet die Sitzung und löscht das Cookie. Auch ohne Sitzung 200.
 *   GET  /api/auth/me      → 200 AuthResponse · 401 unauthorized
 *   POST /api/auth/invite/check   InviteCheckRequest → 200 InviteInfo
 *                                 400 invalid_request · 404 invite_invalid · 429 too_many_attempts (mit Retry-After)
 *   POST /api/auth/invite/accept  AcceptInviteRequest → 200 AuthResponse + Sitzungs-Cookie
 *                                 400 invalid_request | weak_password · 404 invite_invalid · 429 too_many_attempts
 *   GET    /api/accounts                 → 200 AccountListResponse · 403 not_allowed
 *   POST   /api/accounts/invite          CreateInviteRequest → 200 CreateInviteResponse
 *                                        400 invalid_request · 403 not_allowed · 404 not_found (reset, Konto fehlt) ·
 *                                        409 account_exists (neues Konto, Name schon vergeben)
 *   DELETE /api/accounts/:username       → 200 { ok: true } · 403 not_allowed · 404 not_found
 *                                        (lehnt auch eine offene Registrierung ab)
 *   POST   /api/accounts/:username/approve  ApproveRequest → 200 AccountInfo · 400 invalid_request ·
 *                                        403 not_allowed · 404 not_found (keine offene Registrierung)
 *   GET    /api/auth/setup               (ohne Sitzung) → 200 SetupInfo
 *   POST   /api/auth/register            (ohne Sitzung) RegisterRequest → 200 AuthResponse + Sitzungs-Cookie
 *                                        400 invalid_request | weak_password · 409 account_exists ·
 *                                        429 too_many_attempts (mit Retry-After)
 *   POST   /api/auth/onboarding/done     → 200 AuthResponse (Einrichtung bzw. Einarbeitung abgeschlossen)
 *   (Konten verwalten: siehe Abschnitt „Rollen und Rechte“ unten, Registrierung: „Registrierung und Einarbeitung“.)
 *
 * Fehler kommen im bekannten Format `ApiErrorBody` (`{ error: { code, message } }`, siehe `leadSearch.ts`),
 * `message` ist ein fertiger deutscher Satz für die Oberfläche (Ansprache „du“).
 *
 * Geschützte Routen: Ohne gültige Sitzung antworten alle `/api/*`-Routen mit 401 `unauthorized` – außer
 * `AUTH_OPEN_ROUTES`. Das gilt auch für die Server-Sent Events der Lead-Suche (EventSource schickt das Cookie mit).
 * Abgelaufene oder unbekannte Sitzung: 401 plus Set-Cookie, das das alte Cookie löscht (Max-Age=0).
 * Nicht-GET-Anfragen mit Header `Sec-Fetch-Site`, der weder `same-origin` noch `none` ist → 403 `forbidden`
 * (Schutz gegen Formulare von fremden Seiten; fehlt der Header, z. B. bei curl, gilt nur SameSite).
 *
 * Cookie: httpOnly, SameSite=Lax, Path=/, ohne Domain-Attribut (nur dieser Host). Secure immer, außer mit
 * `AUTH_COOKIE_SECURE=false` (lokale Entwicklung, E2E-Tests, Testserver im Heimnetz über http) – nicht aus der
 * Anfrage erraten, denn hinter Caddy und nginx kommt beim Backend immer http an.
 *
 * Sitzung: Login vergibt immer eine neue Sitzungs-ID. Ohne `remember` Sitzungs-Cookie, die Sitzung endet nach
 * 12 Stunden ohne Anfrage. Mit `remember` gelten Cookie und Sitzung 30 Tage ab Login. Sitzungen liegen im
 * `DATA_DIR` und überleben einen Neustart des Backends. Passwort ändern oder Konto entfernen (Server-Befehl)
 * beendet alle Sitzungen dieses Kontos.
 *
 * Anmeldename: Das Backend vergleicht `username` nach trim() und toLowerCase(). Der so bereinigte Name ist auch
 * der Schlüssel der Begrenzung.
 *
 * Begrenzung der Fehlversuche:
 *   - je Client-IP: 10 Fehlversuche in 15 Minuten → 429 bis zum Ende des Fensters;
 *   - je Name: 50 Fehlversuche pro Stunde → 429 (hoch, damit ein Fremder die Gründer nicht einfach aussperrt);
 *   - während einer Sperre 429 ohne Passwortprüfung, auch bei richtigem Passwort;
 *   - unbekannte Namen zählen genauso und kosten gleich viel Zeit (Dummy-Hash);
 *   - ein erfolgreicher Login setzt den Zähler des Namens zurück. Zähler im Speicher, gelten auch im Mock-Modus.
 *   Client-IP aus X-Forwarded-For: Das Backend vertraut genau einem Proxy (nginx), nie `true`. nginx übernimmt die
 *   Adresse von Caddy nur aus privaten Netzen (realip) und gibt genau eine weiter. `TRUST_PROXY_HOPS` 1 und 2 wirken
 *   deshalb gleich (2 aus älteren .env-Dateien bleibt gültig), 0 = keinem Proxy vertrauen.
 *
 * Einladungslinks (Konto selbst einrichten; derselbe Weg für „Passwort vergessen“):
 *   - Befehl `accountsCli invite <anmeldename> [<gründer> [anzeigename]]` gibt den Link aus:
 *     `<PUBLIC_URL><INVITE_PATH>#<token>`. stdout enthält nur diese eine Zeile, alles andere geht nach stderr.
 *     Token: 32 Zufallsbytes base64url (43 Zeichen [A-Za-z0-9_-]), gespeichert nur als SHA-256, Einladungen liegen
 *     in der Datenbank im `DATA_DIR` (Befehl und laufender Server teilen sie).
 *   - PUBLIC_URL (z. B. https://lukas.ylvalabs.de): ein abschließender `/` wird entfernt. Mit `AUTH_COOKIE_SECURE`
 *     an muss sie mit https:// beginnen, sonst bricht der Befehl ab. Fehlt sie, gilt nur bei
 *     `AUTH_COOKIE_SECURE=false` `http://localhost:5173`, sonst bricht der Befehl ab.
 *   - Neues Konto: `gründer` ist Pflicht. Gibt es das Konto schon (nur Kontospeicher, Testkonten zählen nicht),
 *     verlangt der Befehl `--reset` und sagt deutlich, dass der Link das Passwort ersetzt. Gründer und Anzeigename
 *     des Kontos bleiben dann unverändert.
 *   - Gültig `INVITE_VALID_DAYS` Tage, Links für bestehende Konten (`--reset`) nur `RESET_VALID_HOURS` Stunden.
 *     Nur einmal benutzbar. Ungültig werden offene Links eines Namens auch durch einen neuen Link für denselben
 *     Namen, durch `add`, `password`, `remove` und durch `accountsCli uninvite <anmeldename>` (widerruft nur).
 *   - Das Token steht hinter `#`, damit es nicht in Server-Logs oder im Referer landet. Die Oberfläche liest es
 *     einmal, entfernt es sofort aus der Adresse (`history.replaceState`) und hält es nur im Speicher. Sie schickt es
 *     nur im Body (`check`, `accept`) – nie in einer URL. Das Backend loggt bei beiden Routen nur Anmeldename, IP
 *     und Ergebnis, nie Token, Hash, Passwort oder den Body.
 *   - `check` verändert nichts (kein Verbrauch, keine Verlängerung). Unbekannt, abgelaufen oder benutzt → bewusst
 *     dieselbe Antwort 404 `invite_invalid`. `InviteInfo` zeigt bei bestehendem Konto dessen Namen und Gründer.
 *   - `accept` in dieser Reihenfolge: Body ungültig (token oder password kein String) → 400 `invalid_request` →
 *     Sperre → 429 → Token unbekannt/abgelaufen/benutzt → 404 `invite_invalid` (ohne Passwort-Hash zu rechnen) →
 *     Länge außerhalb `PASSWORD_MIN_LENGTH`…`PASSWORD_MAX_LENGTH` → 400 `weak_password` (Token bleibt gültig) →
 *     Hash rechnen → in EINER Transaktion: Token nur einlösen, wenn noch offen (zwei gleichzeitige `accept`:
 *     genau eins 200, das andere 404), Konto anlegen bzw. nur das Passwort ersetzen, alle Sitzungen dieses Namens
 *     beenden (auch beim Anlegen), neue Sitzung und Cookie wie beim Login (mit `remember`).
 *   - Passwortlänge = `password.length` des unveränderten Strings (kein trim) – Oberfläche und Backend zählen gleich.
 *   - Begrenzung: eigener Zähler je IP, getrennt vom Login und ohne Namenszähler. `check` und `accept` mit
 *     404 `invite_invalid` zählen: 10 in 15 Minuten → 429 mit Retry-After. Ein erfolgreiches `accept` setzt den
 *     Login-Namenszähler des Kontos zurück wie ein Login.
 *   - Ältere Backends ohne Einladungen antworten 401 `unauthorized` (Route nicht offen) oder 404 ohne `error.code`.
 *     Nur 404 mit Code `invite_invalid` heißt „Link ungültig“; die Oberfläche zeigt sonst „noch nicht möglich“.
 *   - Gilt in jedem Modus gleich, auch in der Simulation (lokal: `npm run accounts --prefix server -- invite …`).
 *     E2E-Tests mit echten Einladungen nie für `nick`/`johannes`, sondern für eigene Namen.
 *
 * Testkonten: `nick` (founder `nick`) und `johannes` (founder `johannes`), Passwort jeweils `demo` – nur mit
 * `AUTH_DEMO_ACCOUNTS=true`, unabhängig von `LEAD_SEARCH_MODE`. Sie stehen nur im Speicher, nie im Kontospeicher,
 * und das Backend warnt beim Start im Log. Gesetzt wird der Schalter für E2E-Tests und lokale Entwicklung,
 * nie in `.env.example` und nie auf einem öffentlichen Server.
 */

/** Gründer, dem ein Konto zugeordnet ist – entspricht `FounderId` im Frontend. */
export const AUTH_FOUNDER_IDS = ['nick', 'johannes'] as const;

export type AuthFounderId = (typeof AUTH_FOUNDER_IDS)[number];

// ───────────────────────────── Rollen und Rechte ─────────────────────────────
//
// Entscheidung des Nutzers (06.10.): Neben den Gründern gibt es Admin-Konten ohne eigenen Tagesstapel und
// Mitarbeiter-Konten, mit denen die Gründer Arbeit abgeben können.
//
//   admin      – `founder` = null. Sieht die Aufgaben jedes Gründers (`GET /api/tasks?owner=…`, `owner` ist dann
//                Pflicht → sonst 400 invalid_request) und darf Entscheidungen *eintragen* (`POST …/events`, gebucht
//                mit `by` = Gründer des Leads). Sendet nicht über LinkedIn (`/linkedin/invite|message` → 403
//                not_allowed). Darf Einstellungen und Vorlagen ändern und alle Konten verwalten.
//   founder    – `founder` = er selbst. Wie bisher; verwaltet Konten wie ein Admin (Entscheidung 06.10. abends:
//                „nie auf die Shell“ – die Gründer sind die Inhaber und laden auch Admins und Gründer ein).
//   assistant  – „Mitarbeiter“, `founder` = der Gründer, für den er arbeitet. Arbeitet nur dessen Tagesstapel ab
//                (`GET /api/tasks?owner=<anderer>` → 403 not_allowed) und bucht nur auf dessen Leads
//                (`POST …/events`, `PATCH`, `snooze`, LinkedIn auf Leads anderer Gründer → 403; lesen darf er alle).
//                Sendet über den LinkedIn-Account seines Gründers (gebucht mit `by` = dieser Gründer). Darf **keine**
//                Einstellungen sehen oder ändern (`/api/settings*` → 403 not_allowed), keine Vorlagen ändern
//                (`PUT`/`POST` unter `/api/templates` → 403; lesen darf er), die Tracking-Liste nicht ersetzen oder
//                löschen (`PUT`/`DELETE /api/lead-search/tracking` → 403), die Simulation nicht zurücksetzen,
//                keine Board-Spalten anlegen/umbenennen/löschen (`canEditBoardColumns`), Leads keinem fremden Gründer
//                übergeben (`PATCH` mit `owner` außerhalb seiner Gründer → 403) und keine Konten verwalten.
//
// Jedes Ereignis, das ein Admin oder Mitarbeiter über eine Sitzung bucht, trägt zusätzlich `LeadEvent.actor`
// (Anzeigename des Kontos), damit sichtbar bleibt, wer es war – z. B. „Anna für Nick“. Bucht der Gründer selbst
// (Rolle founder, `by` = er), bleibt `actor` leer – die Oberfläche zeigt `actor` immer an, wenn er gesetzt ist.
//
// Konten verwalten (`/api/accounts*`): Konten entstehen immer über einen Einladungslink (wie `accountsCli invite`).
//   - Sichtbar: Admin und Gründer alle Konten; Mitarbeiter → 403 not_allowed.
//     Nicht eingelöste Einladungen erscheinen als `pending`, auch wenn der Link abgelaufen ist (`inviteExpiresAt` in
//     der Vergangenheit) – so sieht man, dass ein neuer Link nötig ist.
//   - Einladen: Gründer jede Rolle, Admins nur Admin und Mitarbeiter (`invitableRoles`, Sicherheitsprüfung 08.10.) –
//     sonst 403 not_allowed. `founder` Pflicht bei founder/assistant, null bei admin. Je Gründer höchstens ein
//     Gründer-Konto: Gibt es schon eines (oder eine offene Gründer-Einladung) für diesen Gründer unter einem anderen
//     Namen → 409 account_exists (auch beim Einlösen und Freigeben).
//   - Jede Einladung, jeder Passwort-Link, jede Freigabe und jedes Entfernen erzeugt eine Neuigkeit für alle Gründer
//     (`shared/notifications.ts`, Art `account_change`, mit Name des Handelnden) und – falls eingerichtet – Slack.
//     So fällt auf, wenn jemand ein Konto übernehmen will; der Weg „Passwort vergessen“ bleibt trotzdem offen.
//   - Anmeldename vergeben → 409 account_exists; das gilt auch für Testkonten. Eine offene Einladung desselben
//     Namens wird ersetzt. `reset: true` = Link „Passwort neu setzen“ für ein bestehendes Konto (Admin und Gründer:
//     alle); Name, Rolle und Gründer bleiben dann unverändert und werden ignoriert.
//   - Antwort enthält das Token einmalig; die Oberfläche baut daraus `<origin><INVITE_PATH>#<token>`. Das Backend
//     loggt das Token nie. Ein neuer Link für denselben Namen macht ältere ungültig (wie beim Befehl).
//   - Entfernen: beendet alle Sitzungen und widerruft offene Links. Nie das eigene Konto (400 invalid_request),
//     nie Testkonten (`demo`, 400), nie das letzte eingelöste Konto mit Kontenverwaltung (Admin oder Gründer) –
//     400 invalid_request, sonst käme niemand mehr ohne Shell an die Konten.
//   - Anmeldenamen: `ACCOUNT_USERNAME_PATTERN`, klein geschrieben (das Backend wendet trim + toLowerCase an).
//
// Testkonten (`AUTH_DEMO_ACCOUNTS=true`): zusätzlich `admin` (Rolle admin) und `mitarbeiter` (Mitarbeiter von Nick,
// Anzeigename „Anna“), Passwort ebenfalls `demo`.

export const AUTH_ROLES = ['admin', 'founder', 'assistant'] as const;

export type AuthRole = (typeof AUTH_ROLES)[number];

export const AUTH_ROLE_LABELS: Record<AuthRole, string> = {
  admin: 'Admin',
  founder: 'Gründer',
  assistant: 'Mitarbeiter',
};

export interface AuthUser {
  /** Anmeldename, klein geschrieben (z. B. „nick“). */
  username: string;
  /** Anzeigename (z. B. „Nick“). */
  name: string;
  /**
   * Gründer, dessen Aufgaben das Cockpit nach der Anmeldung öffnet: bei Gründern sie selbst, bei Mitarbeitern der
   * Gründer, für den sie arbeiten. null = Admin ohne eigenen Tagesstapel (wählt in der Oberfläche einen Gründer).
   */
  founder: AuthFounderId | null;
  /** Fehlt bei älteren Backends – dann gilt `authRole()`. */
  role?: AuthRole;
  /**
   * Nur Mitarbeiter mit mehreren Gründern: alle Gründer, für die das Konto arbeitet (ohne Doppelte), `founder` ist
   * immer der erste. Fehlt sonst (ein Gründer, andere Rollen, ältere Backends) – dann gilt `workingFounders()`.
   */
  founders?: AuthFounderId[];
  /**
   * Registriert, aber noch nicht freigegeben (siehe „Registrierung und Einarbeitung“). Solange true, antworten alle
   * Routen außer `/api/auth/*` mit 403 `awaiting_approval`; `role` ist dann `assistant` und `founder` null – ohne
   * Bedeutung, bis ein Gründer oder Admin freigibt.
   */
  awaitingApproval?: boolean;
  /**
   * Noch offene Einführung nach dem ersten Anmelden: `setup` = Einrichtung mit allen Schlüsseln (nur das allererste
   * Konto einer Installation), `intro` = kurze Einarbeitung in den Arbeitsablauf (neue Gründer und Mitarbeiter).
   * null/fehlt = nichts offen. Erledigt mit `POST /api/auth/onboarding/done`.
   */
  onboarding?: OnboardingKind | null;
  /**
   * Namen der Gründer, wie die Software sie anzeigt (Wunsch des Nutzers 08.10.: jeder gibt bei der Registrierung seinen
   * Namen ein, nichts ist fest „Nick“ oder „Johannes“). Je Gründer der Anzeigename seines Gründer-Kontos; ohne Konto
   * fehlt der Eintrag – dann gilt `defaultFounderName()`. Nur in Antworten von `/api/auth/*` (login, me, register,
   * invite/accept, onboarding/done), fehlt bei älteren Backends.
   */
  founderNames?: Partial<Record<AuthFounderId, string>>;
}

/** Name eines Gründers, solange kein Gründer-Konto einen eigenen liefert: „Nick“, „Johannes“. */
export function defaultFounderName(id: AuthFounderId): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export type OnboardingKind = 'setup' | 'intro';

/**
 * Gründer, deren Tagesstapel das Konto abarbeiten darf: Gründer nur sich selbst, Mitarbeiter `founders` (ältere
 * Backends: `founder`), Admins alle.
 */
export function workingFounders(user: Pick<AuthUser, 'founder' | 'role' | 'founders'>): AuthFounderId[] {
  const role = authRole(user);
  if (role === 'admin') return [...AUTH_FOUNDER_IDS];
  if (role === 'assistant' && user.founders && user.founders.length > 0) return [...user.founders];
  return user.founder ? [user.founder] : [];
}

/** Rolle eines Kontos, tolerant für ältere Backends ohne `role`. */
export function authRole(user: Pick<AuthUser, 'founder' | 'role'>): AuthRole {
  return user.role ?? (user.founder ? 'founder' : 'admin');
}

/** Einstellungen (inkl. Schlüssel) sehen und ändern, Vorlagen ändern. */
export function canEditSettings(user: Pick<AuthUser, 'founder' | 'role'>): boolean {
  return authRole(user) !== 'assistant';
}

/** Seite „Konten“: Konten sehen, einladen, entfernen. */
export function canManageAccounts(user: Pick<AuthUser, 'founder' | 'role'>): boolean {
  return authRole(user) !== 'assistant';
}

/** Über LinkedIn senden (immer mit dem Account von `founder`). Admins tragen nur ein. */
export function canSendOnLinkedIn(user: Pick<AuthUser, 'founder' | 'role'>): boolean {
  return authRole(user) !== 'admin' && user.founder !== null;
}

/**
 * Welche Rollen dieses Konto einladen bzw. freigeben darf. Gründer-Konten legen nur Gründer an (Admins nicht – sonst
 * könnte ein Admin sich selbst ein Gründer-Konto verschaffen); je Gründer gibt es höchstens ein Gründer-Konto.
 */
export function invitableRoles(user: Pick<AuthUser, 'founder' | 'role'>): readonly AuthRole[] {
  const role = authRole(user);
  if (role === 'assistant') return [];
  return role === 'founder' ? AUTH_ROLES : AUTH_ROLES.filter((item) => item !== 'founder');
}

/** Eigene Spalten im Board anlegen, umbenennen, löschen – gilt für alle, deshalb nur Gründer und Admins. */
export function canEditBoardColumns(user: Pick<AuthUser, 'founder' | 'role'>): boolean {
  return authRole(user) !== 'assistant';
}

/** Erlaubte Anmeldenamen (nach trim + toLowerCase): 2–40 Zeichen, a–z, 0–9, Punkt, Unterstrich, Bindestrich. */
export const ACCOUNT_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,39}$/;
export const ACCOUNT_NAME_MAX_LENGTH = 60;

/** Eintrag in `GET /api/accounts`. */
export interface AccountInfo {
  username: string;
  name: string;
  role: AuthRole;
  founder: AuthFounderId | null;
  /** Testkonto (`AUTH_DEMO_ACCOUNTS`) – nur im Speicher, kann nicht entfernt oder zurückgesetzt werden. */
  demo?: boolean;
  /** Konto ist nur eingeladen, der Link wurde noch nicht eingelöst. */
  pending?: boolean;
  /** Ablauf des offenen Einladungslinks (ms), falls es einen gibt. */
  inviteExpiresAt?: number | null;
  /** Nur Mitarbeiter mit mehreren Gründern: alle, für die das Konto arbeitet (`founder` ist der erste). */
  founders?: AuthFounderId[];
  /** Hat sich selbst registriert und wartet auf Freigabe – `role`/`founder` dann ohne Bedeutung (assistant/null). */
  awaitingApproval?: boolean;
  /** Zeitpunkt der Registrierung (ms), nur bei `awaitingApproval`. */
  registeredAt?: number;
}

export interface AccountListResponse {
  /** Sortiert: Admins, Gründer, Mitarbeiter, jeweils nach Anmeldename. */
  accounts: AccountInfo[];
}

export interface CreateInviteRequest {
  username: string;
  /** Pflicht bei neuen Konten (1–`ACCOUNT_NAME_MAX_LENGTH` Zeichen nach trim). */
  name?: string;
  /** Pflicht bei neuen Konten. */
  role?: AuthRole;
  /** Pflicht bei founder/assistant, null bei admin. */
  founder?: AuthFounderId | null;
  /** Nur Mitarbeiter, optional: weitere Gründer, für die er arbeitet. `founder` wird vorne ergänzt, Doppelte entfallen. */
  founders?: AuthFounderId[];
  /** true = Link „Passwort neu setzen“ für ein bestehendes Konto (gilt `RESET_VALID_HOURS`). */
  reset?: boolean;
}

export interface CreateInviteResponse {
  /** Nur in dieser Antwort – die Oberfläche zeigt `<origin><INVITE_PATH>#<token>` zum Kopieren. */
  token: string;
  username: string;
  expiresAt: number;
}

export interface LoginRequest {
  username: string;
  password: string;
  /** „Angemeldet bleiben“: true → Cookie und Sitzung 30 Tage, sonst Sitzungs-Cookie (12 h ohne Anfrage). */
  remember?: boolean;
}

/** Antwort von `POST /api/auth/login` und `GET /api/auth/me`. */
export interface AuthResponse {
  user: AuthUser;
}

/**
 * Fehlercodes der Anmeldung (`ApiErrorBody.error.code`):
 * - `unauthorized` (401) – keine oder abgelaufene Sitzung, jede geschützte Route;
 * - `invalid_credentials` (401) – Name oder Passwort falsch, bewusst dieselbe Meldung für beides;
 * - `too_many_attempts` (429) – zu viele Fehlversuche, Header `Retry-After` in Sekunden;
 * - `invalid_request` (400) – Name oder Passwort fehlt (Einladung: Token oder Passwort fehlt);
 * - `forbidden` (403) – Anfrage von einer fremden Seite (`Sec-Fetch-Site`);
 * - `invite_invalid` (404) – Einladungslink unbekannt, abgelaufen oder benutzt;
 * - `weak_password` (400) – Passwort zu kurz oder zu lang;
 * - `awaiting_approval` (403) – registriert, aber noch nicht freigegeben;
 * - `setup_required` (403) – erstes Konto ohne gültigen Einrichtungs-Link (`RegisterRequest.setupToken`).
 */
export type AuthErrorCode =
  | 'unauthorized'
  | 'invalid_credentials'
  | 'too_many_attempts'
  | 'invalid_request'
  | 'forbidden'
  /** 404 – Einladungslink unbekannt, abgelaufen oder schon benutzt. */
  | 'invite_invalid'
  /** 400 – Passwort zu kurz oder zu lang (`PASSWORD_MIN_LENGTH` … `PASSWORD_MAX_LENGTH`). */
  | 'weak_password'
  /** 403 – die Rolle des Kontos darf das nicht (siehe „Rollen und Rechte“). */
  | 'not_allowed'
  /** 404 – Konto unbekannt (`/api/accounts*`). */
  | 'not_found'
  /** 409 – Anmeldename schon vergeben (neues Konto einladen, registrieren). */
  | 'account_exists'
  /** 403 – Konto ist registriert, wartet aber noch auf Freigabe durch einen Gründer oder Admin. */
  | 'awaiting_approval'
  /** 403 – erstes Konto: Einrichtungs-Link fehlt oder stimmt nicht (siehe „Registrierung und Einarbeitung“). */
  | 'setup_required';

/** Routen, die ohne Sitzung erreichbar sind. Alles andere unter `/api/` verlangt eine Sitzung. */
export const AUTH_OPEN_ROUTES: readonly string[] = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/invite/check',
  '/api/auth/invite/accept',
  '/api/auth/setup',
  '/api/auth/register',
  /** Rückkanal für Clay – mit eigenem geheimen Header statt Sitzung (`shared/enrichment.ts`). */
  '/api/enrichment/clay',
  /** OAuth für den MCP-Server (`shared/mcp.ts`) – ruft die Claude-App ohne Sitzung auf; Freigabe nur mit Sitzung. */
  '/api/oauth/register',
  '/api/oauth/authorize',
  '/api/oauth/token',
];

// ───────────────────────────── Einladungslinks ─────────────────────────────

/** Pfad der Seite „Konto einrichten“. Der Link lautet `<PUBLIC_URL>/einladung#<token>`. */
export const INVITE_PATH = '/einladung';

/** So lange gilt ein Einladungslink für ein neues Konto. */
export const INVITE_VALID_DAYS = 7;

/** So lange gilt ein Link, der das Passwort eines bestehenden Kontos ersetzt („Passwort vergessen“). */
export const RESET_VALID_HOURS = 24;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

export interface InviteCheckRequest {
  token: string;
}

/** Antwort von `POST /api/auth/invite/check` – was die Seite „Konto einrichten“ anzeigt. */
export interface InviteInfo {
  /** Anmeldename, mit dem man sich danach anmeldet (z. B. „nick“). */
  username: string;
  /** Anzeigename (z. B. „Nick“). */
  name: string;
  /** null = Admin-Konto. */
  founder: AuthFounderId | null;
  /** Fehlt bei älteren Backends – dann gilt `authRole()`. */
  role?: AuthRole;
  /** Ablauf des Links, Millisekunden seit 1970. */
  expiresAt: number;
  /** true: Konto gibt es schon – der Link setzt ein neues Passwort („Passwort vergessen“). */
  accountExists: boolean;
}

export interface AcceptInviteRequest {
  token: string;
  password: string;
  /**
   * Nur neue Konten, optional: eigener Name statt des Namens aus der Einladung (1–`ACCOUNT_NAME_MAX_LENGTH` Zeichen
   * nach trim, sonst 400 `invalid_request`). Bei „Passwort neu setzen“ ignoriert.
   */
  name?: string;
  /** Wie beim Login: true → Cookie und Sitzung 30 Tage. */
  remember?: boolean;
}

// ───────────────────────────── Registrierung und Einarbeitung ─────────────────────────────
//
// Wunsch des Nutzers (08.10.): Nach der Installation einmal in die Shell, danach nie wieder. Wer die Seite als Erster
// öffnet, legt sich selbst ein Konto an und wird Gründer; alle weiteren registrieren sich selbst und warten auf
// Freigabe.
//
//   GET  /api/auth/setup → `SetupInfo`. Ohne Sitzung, verändert nichts.
//   POST /api/auth/register → `AuthResponse` + Sitzungs-Cookie (wie Login, mit `remember`).
//     Prüfung in dieser Reihenfolge: Body/Anmeldename/Anzeigename ungültig → 400 `invalid_request` · Sperre (eigener
//     Zähler je IP: 5 Registrierungen pro Stunde, dazu höchstens `MAX_OPEN_REGISTRATIONS` offene) → 429 ·
//     Passwortlänge → 400 `weak_password` · Name vergeben (Konto, Testkonto, offene Registrierung oder offene
//     Einladung) → 409 `account_exists`.
//     - Gibt es noch kein Konto im Kontospeicher (und sind keine Testkonten an): Nur mit dem Einrichtungs-Schlüssel
//       (`setupToken`, Sicherheitsprüfung 08.10.) – sonst 403 `setup_required` (zählt in der Sperre). Das Backend legt
//       ihn beim Start an (oder nimmt `SETUP_TOKEN` aus der .env) und schreibt den Link
//       `<PUBLIC_URL>/registrieren#setup=<schlüssel>` ins Protokoll („Einrichtung: …“). Mit Schlüssel wird das Konto
//       sofort Gründer (`founder` = erster Eintrag aus `AUTH_FOUNDER_IDS`, `onboarding: 'setup'`). Zwei gleichzeitige
//       erste Registrierungen: genau eine wird Gründer, die andere wartet auf Freigabe. Die Oberfläche liest den
//       Schlüssel aus dem Fragment, nimmt ihn sofort aus der Adresse und schickt ihn nur im Body.
//     - Sonst: offene Registrierung, `awaitingApproval: true`. Die Sitzung gilt, aber nur `/api/auth/*` antwortet;
//       alles andere 403 `awaiting_approval`. Die Oberfläche fragt `/api/auth/me`, bis die Freigabe da ist. Anmelden
//       mit Name und Passwort klappt auch vor der Freigabe (gleiche Antwort).
//   POST /api/accounts/:username/approve → `AccountInfo` des neuen Kontos. Admin und Gründer. Rolle und Gründer wie
//     beim Einladen (`roleProblem`, `invitableRoles`: Gründer-Konten nur durch Gründer, je Gründer höchstens eins),
//     Mitarbeiter mit `founders`. Die Sitzungen des Kontos bleiben gültig, `/me`
//     liefert danach das freigegebene Konto mit `onboarding: 'intro'` (Admins: null).
//   DELETE /api/accounts/:username lehnt eine offene Registrierung ab (löscht sie samt Sitzungen).
//   GET /api/accounts zeigt offene Registrierungen mit `awaitingApproval: true` und `registeredAt` (zuerst).
//   POST /api/auth/onboarding/done → `AuthResponse` mit `onboarding: null`. Jede Sitzung für das eigene Konto.
//
// Neue Konten über Einladungslinks bekommen ebenfalls `onboarding: 'intro'` (Admins: null). Konten von vor dieser
// Änderung haben nie eine offene Einführung.

/** Seite „Registrieren“ (Link zum Weitergeben ans Team). */
export const REGISTER_PATH = '/registrieren';

/** Fragment-Anfang des Einrichtungs-Links: `/registrieren#setup=<schlüssel>`. */
export const SETUP_FRAGMENT = 'setup=';

/** Mehr offene Registrierungen nimmt das Backend nicht an (429), bis jemand freigibt oder ablehnt. */
export const MAX_OPEN_REGISTRATIONS = 20;

/** Antwort von `GET /api/auth/setup`. */
export interface SetupInfo {
  /** Noch kein Konto: Die Anmeldeseite zeigt „Gründer-Konto erstellen“ statt der Anmeldung. */
  firstAccount: boolean;
}

export interface RegisterRequest {
  username: string;
  /** Anzeigename, 1–`ACCOUNT_NAME_MAX_LENGTH` Zeichen nach trim. */
  name: string;
  password: string;
  remember?: boolean;
  /** Nur erstes Konto: Schlüssel aus dem Einrichtungs-Link (`#setup=…`). Sonst ignoriert. */
  setupToken?: string;
}

export interface ApproveRequest {
  role: AuthRole;
  /** Pflicht bei founder/assistant, null bei admin. */
  founder: AuthFounderId | null;
  /** Nur Mitarbeiter, optional: alle Gründer, für die er arbeitet (`founder` wird vorne ergänzt). */
  founders?: AuthFounderId[];
}
