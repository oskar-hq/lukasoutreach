import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Datenbank des Cockpits: eine SQLite-Datei im `DATA_DIR` (im Container ein Docker-Volume).
 * Eingebaut in Node 22 (`node:sqlite`), keine zusätzliche Abhängigkeit. Sicherung = `VACUUM INTO` (`db/backup.ts`).
 *
 * Migrationen laufen beim Öffnen der Reihe nach und nur einmal (`PRAGMA user_version`).
 * Neue Tabellen → neuer Eintrag am Ende von MIGRATIONS, bestehende Einträge nie ändern.
 */

export const DATABASE_FILE = 'cockpit.db';

const MIGRATIONS: string[] = [
  // 1 · Konten und Sitzungen (Roadmap Phase 1)
  `
  CREATE TABLE users (
    username      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    founder       TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  -- Gespeichert wird nur der SHA-256 der Sitzungs-ID, nie die ID selbst.
  -- Ohne Fremdschlüssel: Sitzungen der Testkonten (nur im Speicher) liegen ebenfalls hier.
  CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    remember     INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX sessions_username ON sessions (username);
  CREATE INDEX sessions_expires_at ON sessions (expires_at);
  `,
  // 2 · Leads und Verlauf (Roadmap Phase 2). Verschachtelte Angaben (Person, Firma, KI, Meta, Herkunft) als JSON,
  // alles, wonach gefiltert oder sortiert wird, als eigene Spalte.
  `
  CREATE TABLE leads (
    id               TEXT PRIMARY KEY,
    provider_id      TEXT NOT NULL UNIQUE,
    owner            TEXT NOT NULL,
    stage            TEXT NOT NULL,
    search_text      TEXT NOT NULL,
    person           TEXT NOT NULL,
    company          TEXT NOT NULL,
    assessment       TEXT,
    meta_ads         TEXT,
    origin           TEXT NOT NULL,
    template         TEXT,
    follow_ups_sent  INTEGER NOT NULL DEFAULT 0,
    next_step        TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    last_contact_at  INTEGER,
    last_reply_at    INTEGER,
    last_activity_at INTEGER NOT NULL
  );
  CREATE INDEX leads_owner_stage ON leads (owner, stage);
  CREATE INDEX leads_last_activity ON leads (last_activity_at);
  CREATE TABLE lead_events (
    id      TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,
    at      INTEGER NOT NULL,
    by      TEXT,
    title   TEXT NOT NULL,
    text    TEXT,
    label   TEXT
  );
  CREATE INDEX lead_events_lead ON lead_events (lead_id, at);
  `,
  // 3 · Dubletten-Abgleich: öffentliche LinkedIn-Kennung der Leads, Tracking-Liste (Excel) und kleine Einstellungen.
  `
  ALTER TABLE leads ADD COLUMN public_identifier TEXT;
  UPDATE leads SET public_identifier = lower(json_extract(person, '$.publicIdentifier'));
  CREATE INDEX leads_public_identifier ON leads (public_identifier);
  -- Schlüssel wie in tracking.ts: „in:<kennung>“ oder „id:<provider-id>“
  CREATE TABLE tracking_profiles (
    key    TEXT PRIMARY KEY,
    setter TEXT,
    sheet  TEXT NOT NULL,
    status TEXT
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 4 · Scoring v1: Score als JSON, Gesamtwert eigene Spalte (Sortierung „höchster Score zuerst“).
  `
  ALTER TABLE leads ADD COLUMN score TEXT;
  ALTER TABLE leads ADD COLUMN score_total REAL;
  CREATE INDEX leads_score_total ON leads (score_total);
  `,
  // 5 · Einladungslinks (Vertrag shared/auth.ts): nur der SHA-256 des Tokens, einmal benutzbar, mit Ablauf.
  `
  CREATE TABLE invitations (
    id_hash    TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    name       TEXT NOT NULL,
    founder    TEXT NOT NULL,
    reset      INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  CREATE INDEX invitations_username ON invitations (username);
  `,
  // 6 · Clay-Anreicherung (Vertrag shared/enrichment.ts): Ergebnis als JSON am Lead, jede Anfrage protokolliert
  //     (Tageslimit = Credits; bleibt beim Zurücksetzen der Demo-Leads stehen, daher ohne Fremdschlüssel).
  `
  ALTER TABLE leads ADD COLUMN enrichment TEXT;
  CREATE TABLE enrichment_requests (
    lead_id      TEXT NOT NULL,
    source       TEXT NOT NULL,
    requested_at INTEGER NOT NULL
  );
  CREATE INDEX enrichment_requests_at ON enrichment_requests (requested_at);
  `,
  // 7 · Echte LinkedIn-Aktionen (Vertrag shared/linkedin.ts): Zustand am Lead, Protokoll jeder Aktion (Grundlage der
  //     Limits, bleibt beim Zurücksetzen der Demo stehen), bereits verarbeitete Nachrichten, Pausen je Gründer.
  `
  ALTER TABLE leads ADD COLUMN linkedin TEXT;
  CREATE TABLE linkedin_actions (
    id         TEXT PRIMARY KEY,
    founder    TEXT NOT NULL,
    account_id TEXT,
    lead_id    TEXT,
    kind       TEXT NOT NULL,
    status     TEXT NOT NULL,
    detail     TEXT,
    day        TEXT NOT NULL,
    at         INTEGER NOT NULL
  );
  CREATE INDEX linkedin_actions_founder ON linkedin_actions (founder, kind, at);
  CREATE TABLE linkedin_seen_messages (
    message_id TEXT PRIMARY KEY,
    lead_id    TEXT NOT NULL,
    at         INTEGER NOT NULL
  );
  CREATE TABLE linkedin_pauses (
    founder      TEXT PRIMARY KEY,
    paused_until INTEGER NOT NULL,
    reason       TEXT NOT NULL
  );
  `,
  // 8 · Einstellungen in der Software (Vertrag shared/settings.ts): Werte (Geheimnisse verschlüsselt), Stand
  //     (`version`), Verlauf (nie mit Geheimnissen) und höchstens eine offene Probe-Änderung.
  `
  CREATE TABLE settings_values (
    key        TEXT PRIMARY KEY,
    secret     INTEGER NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE settings_meta (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );
  INSERT INTO settings_meta (id, version) VALUES (1, 1);
  CREATE TABLE settings_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    username   TEXT NOT NULL,
    ip         TEXT,
    key        TEXT NOT NULL,
    action     TEXT NOT NULL,
    from_value TEXT,
    to_value   TEXT
  );
  CREATE TABLE settings_trial (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    keys         TEXT NOT NULL,
    previous     TEXT NOT NULL,
    reverts_at   INTEGER NOT NULL,
    username     TEXT NOT NULL,
    session_hash TEXT NOT NULL
  );
  `,
  // 9 · Nachrichten-Vorlagen (Vertrag shared/messages.ts): nur in der Software angepasste Texte – die Standardtexte
  //     stehen im Code (`messages/defaults.ts`).
  `
  CREATE TABLE message_templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    text       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
  `,
  // 10 · Tagesstapel: „für heute überspringen“ und Kennung gegen doppelt gebuchte Meldungen (Vertrag shared/leads.ts).
  `
  ALTER TABLE leads ADD COLUMN snoozed_until INTEGER;
  ALTER TABLE lead_events ADD COLUMN client_id TEXT;
  CREATE UNIQUE INDEX lead_events_client ON lead_events (lead_id, client_id) WHERE client_id IS NOT NULL;
  `,
  // 11 · Rollen und Konten (Vertrag shared/auth.ts → „Rollen und Rechte“): `role` an Konten und Einladungen,
  //      `founder` darf NULL sein (Admin). SQLite kann NOT NULL nicht per ALTER entfernen → Tabellen neu anlegen und
  //      kopieren (läuft wie jede Migration in einer Transaktion). Bestehende Konten und Links werden `founder`.
  //      Ereignisse bekommen `actor` (Anzeigename des Kontos, das gebucht hat).
  `
  CREATE TABLE users_v11 (
    username      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'founder', 'assistant')),
    founder       TEXT,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    CHECK ((role = 'admin') = (founder IS NULL))
  );
  INSERT INTO users_v11 (username, name, role, founder, password_hash, created_at, updated_at)
    SELECT username, name, 'founder', founder, password_hash, created_at, updated_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_v11 RENAME TO users;

  CREATE TABLE invitations_v11 (
    id_hash    TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'founder', 'assistant')),
    founder    TEXT,
    reset      INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    CHECK ((role = 'admin') = (founder IS NULL))
  );
  INSERT INTO invitations_v11 (id_hash, username, name, role, founder, reset, created_at, expires_at, used_at)
    SELECT id_hash, username, name, 'founder', founder, reset, created_at, expires_at, used_at FROM invitations;
  DROP TABLE invitations;
  ALTER TABLE invitations_v11 RENAME TO invitations;
  CREATE INDEX invitations_username ON invitations (username);

  ALTER TABLE lead_events ADD COLUMN actor TEXT;
  `,
  // 12 · Automatische Lead-Suche (Vertrag shared/autoSearch.ts): Zeitplan je Gründer (Profil als JSON), letzter Lauf
  //      und Kennung des zuletzt ausgelösten Termins (gegen doppeltes Auslösen, auch nach Neustart), dazu die Profile,
  //      die automatische Suchen schon geprüft haben (werden nach `AUTO_SEARCH_CHECKED_DAYS` Tagen gelöscht).
  `
  CREATE TABLE auto_search_schedules (
    founder    TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL,
    days       TEXT NOT NULL,
    time       TEXT NOT NULL,
    profile    TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );
  CREATE TABLE auto_search_state (
    founder  TEXT PRIMARY KEY,
    last_run TEXT,
    last_key TEXT
  );
  CREATE TABLE auto_search_checked (
    founder     TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    checked_at  INTEGER NOT NULL,
    PRIMARY KEY (founder, provider_id)
  );
  CREATE INDEX auto_search_checked_at ON auto_search_checked (checked_at);
  `,
  // 13 · Gespräch am Lead (Vertrag shared/messages.ts → LeadConversation): Einschätzung der Antwort + Zusammenfassung.
  `
  ALTER TABLE leads ADD COLUMN conversation TEXT;
  `,
  // 14 · Übergabe an Close (Vertrag shared/crm.ts): Close-ID und Link am Lead.
  `
  ALTER TABLE leads ADD COLUMN crm TEXT;
  `,
  // 15 · Datenschutz (Vertrag shared/leads.ts → Löschen): Fingerabdrücke gelöschter Leads (SHA-256 der LinkedIn-ID bzw.
  //      des Profil-Namens, ohne Namen/Firma), damit sie nie wieder vorgeschlagen werden.
  `
  CREATE TABLE deleted_leads (
    fingerprint TEXT PRIMARY KEY,
    deleted_at  INTEGER NOT NULL
  );
  `,
  // 16 · Echter Betrieb (Wunsch des Nutzers 07.10.): alles Erfundene aus der Demo-Zeit löschen – Demo-Leads und Leads
  //      aus simulierten Läufen samt Verlauf (Nachrichten, Antworten), ihre Anfragen an Firmendaten, simulierte
  //      LinkedIn-Aktionen (Accounts `mock-…`) und der Modus-Schalter aus den Einstellungen (Wert und Verlauf).
  //      Echt bleibt, was `isRealLead` (leadStore.ts) als echt erkennt: Tracking-Liste und Live-Läufe.
  `
  CREATE TEMP TABLE fake_leads AS
    SELECT id FROM leads
    WHERE NOT (json_extract(origin, '$.kind') = 'tracking'
      OR (json_extract(origin, '$.kind') = 'search' AND json_extract(origin, '$.mode') = 'live'));
  DELETE FROM enrichment_requests WHERE lead_id IN (SELECT id FROM fake_leads);
  DELETE FROM linkedin_seen_messages WHERE lead_id IN (SELECT id FROM fake_leads);
  DELETE FROM linkedin_actions WHERE lead_id IN (SELECT id FROM fake_leads) OR account_id LIKE 'mock-%';
  DELETE FROM lead_events WHERE lead_id IN (SELECT id FROM fake_leads);
  DELETE FROM leads WHERE id IN (SELECT id FROM fake_leads);
  DROP TABLE fake_leads;
  DELETE FROM settings_values WHERE key IN ('LEAD_SEARCH_MODE', 'MOCK_SPEED');
  DELETE FROM settings_history WHERE key IN ('LEAD_SEARCH_MODE', 'MOCK_SPEED');
  `,
  // 17 · Automatische Suche 70/30 (Vertrag shared/autoSearch.ts → AutoSearchFocus): bisherige Läufe je Zielgruppe.
  `
  ALTER TABLE auto_search_state ADD COLUMN focus_counts TEXT;
  `,
  // 18 · Eigene Spalten im Leads-Board (Vertrag shared/leads.ts → BoardColumn) und die Spalte am Lead.
  `
  CREATE TABLE board_columns (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE leads ADD COLUMN board_column TEXT;
  `,
  // 19 · Registrierung und Einarbeitung (Vertrag shared/auth.ts → „Registrierung und Einarbeitung“): Mitarbeiter für
  //      mehrere Gründer (`founders` als JSON-Liste, nur bei Mitarbeitern), offene Einführung (`onboarding`, bestehende
  //      Konten: keine), offene Registrierungen bis zur Freigabe in eigener Tabelle (ohne Rolle, nur Name + Hash).
  `
  ALTER TABLE users ADD COLUMN founders TEXT;
  ALTER TABLE users ADD COLUMN onboarding TEXT;
  ALTER TABLE invitations ADD COLUMN founders TEXT;
  CREATE TABLE registrations (
    username      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  `,
  // 20 · Tagesziel der automatischen Suche (Vertrag shared/autoSearch.ts → „Tagesziel“): x qualifizierte Leads pro Tag,
  //      höchstens y Läufe; Stand heute als JSON am Zustand.
  `
  ALTER TABLE auto_search_schedules ADD COLUMN daily_target INTEGER;
  ALTER TABLE auto_search_schedules ADD COLUMN max_rounds INTEGER;
  ALTER TABLE auto_search_state ADD COLUMN today TEXT;
  `,
  // 21 · Neuigkeiten vom Programm (Vertrag shared/notifications.ts): Meldungen (gleicher `key` = zusammengefasst) und
  //      je Konto, bis wann es alles gesehen hat.
  `
  CREATE TABLE notifications (
    id            TEXT PRIMARY KEY,
    key           TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL,
    severity      TEXT NOT NULL,
    title         TEXT NOT NULL,
    text          TEXT NOT NULL,
    audience      TEXT NOT NULL,
    founder       TEXT,
    needs_founder INTEGER NOT NULL,
    target        TEXT,
    count         INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    slack_at      INTEGER
  );
  CREATE TABLE notification_seen (
    username TEXT PRIMARY KEY,
    seen_at  INTEGER NOT NULL
  );
  `,
  // 22 · Anonyme Zahlen fürs Dashboard (Vertrag shared/leads.ts → Löschen): Bevor ein Lead gelöscht wird (Frist nach
  //      „Verloren“ oder sofort auf Wunsch), wandern seine zählbaren Ereignisse hierher – nur Art, Zeitpunkt, Gründer und
  //      Vorlage, ohne Text, Namen oder Lead-ID. `group_id` ist eine neue Zufallskennung je gelöschtem Lead (für
  //      „erste Nachricht“, „erste Antwort“ und Follow-up-Stufen), die auf nichts mehr verweist.
  `
  CREATE TABLE lead_events_archive (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    owner    TEXT NOT NULL,
    template TEXT,
    kind     TEXT NOT NULL,
    at       INTEGER NOT NULL,
    by       TEXT,
    label    TEXT
  );
  CREATE INDEX lead_events_archive_group ON lead_events_archive (group_id, at);
  CREATE INDEX lead_events_archive_at ON lead_events_archive (at);
  `,
  // 23 · Automatische Suche (Vertrag shared/autoSearch.ts): fälliger, noch wartender Termin je Gründer (JSON – nach einem
  //      Neustart wird er als übersprungen gemeldet statt still zu verschwinden) und Profilabrufe je Tag (Zeitzone der
  //      automatischen Suche) für das Tageslimit des gemeinsamen Such-Accounts.
  `
  ALTER TABLE auto_search_state ADD COLUMN pending TEXT;
  CREATE TABLE auto_search_profile_fetches (
    day   TEXT PRIMARY KEY,
    count INTEGER NOT NULL
  );
  `,
  // 24 · Schnellere Abfragen über den Verlauf: Ereignisse nach Art und Zeit (heutige Anfragen, Dashboard, Termine);
  //      (lead_id, at) gibt es seit 2 schon – IF NOT EXISTS, falls ein anderer Zweig ihn auch anlegt.
  `
  CREATE INDEX IF NOT EXISTS lead_events_kind_at ON lead_events (kind, at);
  CREATE INDEX IF NOT EXISTS lead_events_lead ON lead_events (lead_id, at);
  `,
  // 25 · Eigene Vorlagen (Vertrag shared/messages.ts → Kategorien, A bis Z): Zeilen mit `kind` sind in der Software
  //      angelegt, Zeilen ohne `kind` überschreiben einen Standardtext. `deleted_at` blendet eine Vorlage aus (die ID
  //      bleibt belegt, damit die Auswertung je Vorlage nicht durcheinanderkommt).
  `
  ALTER TABLE message_templates ADD COLUMN kind TEXT;
  ALTER TABLE message_templates ADD COLUMN stage INTEGER;
  ALTER TABLE message_templates ADD COLUMN audience TEXT;
  ALTER TABLE message_templates ADD COLUMN created_at INTEGER;
  ALTER TABLE message_templates ADD COLUMN deleted_at INTEGER;
  `,
  // 26 · Automatische Suche 2× am Tag (Vertrag shared/autoSearch.ts → `secondTime`, Wunsch des Kunden 11.10.).
  `
  ALTER TABLE auto_search_schedules ADD COLUMN second_time TEXT;
  `,
  // 27 · Deal Value je Lead (Vertrag shared/leads.ts → `dealValue`, Wunsch des Nutzers 11.10.), ganze Euro.
  `
  ALTER TABLE leads ADD COLUMN deal_value INTEGER;
  `,
  // 28 · Suchgedächtnis (Wunsch des Nutzers 11.10.: „findet jedes Mal dieselben Kunden“): je Suchanfrage (Stichwort ×
  //      Position × Feld × Region) Cursor, Tiefe und Ertrag – der nächste Lauf blättert weiter statt wieder ab Seite 1.
  //      `search_checked`: alle in irgendeinem Lauf (auch von Hand) geprüften Profile. `search_backlog`: zurückgestellte
  //      Treffer (Limit erreicht), die der nächste Lauf zuerst bekommt – sonst blätterte die Suche an ihnen vorbei.
  `
  CREATE TABLE search_queries (
    key          TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    cursor       TEXT,
    pages        INTEGER NOT NULL DEFAULT 0,
    hits         INTEGER NOT NULL DEFAULT 0,
    fresh        INTEGER NOT NULL DEFAULT 0,
    likely       INTEGER NOT NULL DEFAULT 0,
    qualified    INTEGER NOT NULL DEFAULT 0,
    exhausted_at INTEGER,
    updated_at   INTEGER NOT NULL
  );
  CREATE TABLE search_checked (
    provider_id TEXT PRIMARY KEY,
    checked_at  INTEGER NOT NULL
  );
  CREATE INDEX search_checked_at ON search_checked (checked_at);
  CREATE TABLE search_backlog (
    provider_id TEXT PRIMARY KEY,
    hit         TEXT NOT NULL,
    source      TEXT,
    added_at    INTEGER NOT NULL
  );
  `,
  // 29 · KI-Kosten (Vertrag shared/dashboard.ts → `aiCost`, Wunsch des Nutzers 11.10.): je Aufruf der Claude-API die
  //      Token laut `usage` und die daraus berechneten Kosten in Dollar (Listenpreis zum Zeitpunkt des Aufrufs), bei der
  //      Lead-Suche mit Lauf-ID. Tagesbudget der automatischen Suche in Euro (`daily_budget_eur`).
  `
  CREATE TABLE ai_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            INTEGER NOT NULL,
    purpose       TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read    INTEGER NOT NULL,
    cache_write   INTEGER NOT NULL,
    cost_usd      REAL NOT NULL,
    run_id        TEXT
  );
  CREATE INDEX ai_usage_at ON ai_usage (at);
  CREATE INDEX ai_usage_run ON ai_usage (run_id);
  ALTER TABLE auto_search_schedules ADD COLUMN daily_budget_eur REAL;
  `,
  // 30 · Warteliste mit Vorprüfung (Wunsch des Nutzers 12.10.: die Warteliste abarbeiten, ohne jedes Mal zu zahlen):
  //      die Einschätzung der KI-Vorprüfung (`PrescreenVerdict` als JSON) – der nächste Lauf prüft den Treffer nicht neu.
  `
  ALTER TABLE search_backlog ADD COLUMN prescreen TEXT;
  `,
  // 31 · Lernen aus Lead-Qualität (Wunsch des Nutzers 13.10., `shared/learning.ts`): Rückmeldung am Lead (`feedback`),
  //      Beispiele für die KI je LinkedIn-Profil (ohne Namen; gelöscht mit dem Lead), welche Suchanfrage ein Profil fand
  //      (`search_lead_source`, 90 Tage) und Ertrag je Anfrage aus echten Ergebnissen (`good`/`bad`).
  `
  ALTER TABLE leads ADD COLUMN feedback TEXT;
  CREATE TABLE lead_feedback (
    provider_id TEXT PRIMARY KEY,
    verdict     TEXT NOT NULL,
    source      TEXT NOT NULL,
    reason      TEXT,
    note        TEXT,
    outcome     TEXT,
    category    TEXT,
    headline    TEXT,
    position    TEXT,
    company     TEXT,
    industry    TEXT,
    quick_term  TEXT,
    at          INTEGER NOT NULL
  );
  CREATE INDEX lead_feedback_at ON lead_feedback (at);
  CREATE TABLE search_lead_source (
    provider_id TEXT PRIMARY KEY,
    query_key   TEXT NOT NULL,
    at          INTEGER NOT NULL
  );
  ALTER TABLE search_queries ADD COLUMN good INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE search_queries ADD COLUMN bad INTEGER NOT NULL DEFAULT 0;
  `,
  // 32 · Hiring-Signal (Wunsch des Nutzers 13.10., `LeadHiring` in `shared/leadSearch.ts`): Die Firma sucht Mitarbeiter –
  //      aus der Lead-Suche oder von Hand; die Erstnachricht schlägt dann eine Recruiting-Vorlage vor.
  `
  ALTER TABLE leads ADD COLUMN hiring TEXT;
  `,
  // 33 · Feste Unipile-Limits je LinkedIn-Account (Wunsch des Nutzers 17.10.): Suchtreffer und Profilabrufe je
  //      Account und Tag – die Lead-Suche verteilt sich auf alle Accounts und geht bei keinem über das Limit.
  `
  CREATE TABLE linkedin_account_usage (
    day        TEXT NOT NULL,
    account_id TEXT NOT NULL,
    kind       TEXT NOT NULL,
    count      INTEGER NOT NULL,
    PRIMARY KEY (day, account_id, kind)
  );
  `,
  // 34 · Antwort von Hand einordnen (Wunsch des Nutzers 19.10.): interessiert / nicht interessiert, teilt die
  //      Board-Spalte „Antwort“. NULL = nach der Einschätzung der Antwort (`replyInterestOf` in `shared/leads.ts`).
  `
  ALTER TABLE leads ADD COLUMN reply_interest TEXT;
  `,
  // 35 · Dashboard zählt von Hand verschobene Leads (Wunsch des Nutzers 20.10.): Zielstufe als label nachtragen.
  `
  UPDATE lead_events SET label = CASE
      WHEN title LIKE 'Von Hand verschoben:%→ Antwort' THEN 'replied'
      WHEN title LIKE 'Von Hand verschoben:%→ Termin' THEN 'meeting'
      WHEN title LIKE 'Von Hand verschoben:%→ Übergeben' THEN 'handed_over'
      ELSE label END
    WHERE kind = 'stage_changed' AND label IS NULL;
  `,
  // 36 · Follow-up planen (Wunsch des Nutzers 20.10.): { at, column, columnName } als JSON, NULL = keins.
  `
  ALTER TABLE leads ADD COLUMN follow_up_plan TEXT;
  `,
  // 37 · Accounts aufwärmen (Wunsch des Nutzers 21.10.): eine Zeile je angefragter Person (Schlüssel wie in
  //      tracking.ts) – jede Person höchstens einmal, von einem Account. `day` = Kalendertag (deutsche Zeit).
  `
  CREATE TABLE warmup_invites (
    target_key  TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    source      TEXT NOT NULL,
    provider_id TEXT,
    status      TEXT NOT NULL,
    detail      TEXT,
    at          INTEGER NOT NULL,
    day         TEXT NOT NULL
  );
  CREATE INDEX warmup_invites_account_day ON warmup_invites (account_id, day);
  CREATE TABLE warmup_pauses (
    account_id TEXT PRIMARY KEY,
    until      INTEGER NOT NULL,
    reason     TEXT NOT NULL
  );
  `,
  // 38 · Einstellungen je LinkedIn-Account (Wunsch des Nutzers 21.10.): Such-Reihenfolge und eigene Tagesgrenzen
  //      (NULL = Standard, siehe `linkedin/accountPrefs.ts`).
  `
  CREATE TABLE linkedin_account_prefs (
    account_id             TEXT PRIMARY KEY,
    position               INTEGER,
    profiles_per_day       INTEGER,
    search_results_per_day INTEGER,
    invites_per_day        INTEGER
  );
  `,
  // 39 · Wiedervorlage (Wunsch des Nutzers 22.10.): eingelöster Plan – der Lead steht wieder in den Aufgaben, bis man
  //      etwas tut. ms des Plans, NULL = keine offene Wiedervorlage.
  `
  ALTER TABLE leads ADD COLUMN follow_up_due INTEGER;
  `,
  // 40 · KI-Assistent (Wunsch des Nutzers 22.10.): Chats je Konto. `api_messages` = Verlauf für die Anthropic-API
  //      (Fragen, Antworten samt Werkzeugaufrufen und -ergebnissen, unverändert – so bleibt der Verlauf gleich und der
  //      Cache warm); `assistant_messages` = was die Oberfläche zeigt.
  `
  CREATE TABLE assistant_chats (
    id           TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    title        TEXT NOT NULL,
    model        TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    api_messages TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX assistant_chats_user ON assistant_chats (username, updated_at);
  CREATE TABLE assistant_messages (
    id       TEXT PRIMARY KEY,
    chat_id  TEXT NOT NULL REFERENCES assistant_chats (id) ON DELETE CASCADE,
    role     TEXT NOT NULL,
    text     TEXT NOT NULL,
    at       INTEGER NOT NULL,
    model    TEXT,
    tools    TEXT,
    cost_eur REAL,
    failed   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX assistant_messages_chat ON assistant_messages (chat_id, at);
  `,
  // 41 · MCP-Server für die Claude-App (Wunsch des Nutzers 22.10.): OAuth 2.1 – registrierte Clients (dynamisch), offene
  //      Anmeldeanfragen, einmalige Codes und Tokens. Codes und Tokens nur als SHA-256-Hash.
  `
  CREATE TABLE mcp_clients (
    client_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE mcp_auth_requests (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    state          TEXT,
    code_challenge TEXT NOT NULL,
    scope          TEXT,
    expires_at     INTEGER NOT NULL
  );
  CREATE TABLE mcp_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    username       TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at     INTEGER NOT NULL
  );
  CREATE TABLE mcp_tokens (
    id                 TEXT PRIMARY KEY,
    client_id          TEXT NOT NULL,
    username           TEXT NOT NULL,
    access_hash        TEXT NOT NULL UNIQUE,
    refresh_hash       TEXT NOT NULL UNIQUE,
    access_expires_at  INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    created_at         INTEGER NOT NULL,
    last_used_at       INTEGER
  );
  CREATE INDEX mcp_tokens_user ON mcp_tokens (username);
  `,
  // 42 · Board frei anordnen (Vertrag shared/leads.ts → BoardLayout, Wunsch des Nutzers 22.10.): Reihenfolge aller Spalten
  //      und eigene Namen für Stufen-Spalten, als Schlüssel/Wert (order, stage_names – JSON).
  `
  CREATE TABLE board_layout (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 43 · Neue Zielgruppe (Kundengespräch 27.10.): Automatische Läufe 50/50 Kapitalanlage/Finanzdienstleister statt 70/30
  //      mit Bauträgern – die Zählung beginnt neu (sonst kämen erst viele Finanzdienstleister-Läufe am Stück). Eigene
  //      Vorlagen bekommen ein Segment (Vertrag shared/messages.ts → TemplateSegment), NULL = für alle.
  `
  UPDATE auto_search_state SET focus_counts = NULL;
  ALTER TABLE message_templates ADD COLUMN segment TEXT;
  `,
  // 44 · Anteil Kapitalanlage/Finanzdienstleister der automatischen Läufe je Gründer (Regler, Wunsch des Nutzers 27.10.,
  //      Vertrag shared/autoSearch.ts → kapitalanlagePercent). NULL = Standard 50.
  `
  ALTER TABLE auto_search_schedules ADD COLUMN kapitalanlage_percent INTEGER;
  `,
  // 45 · Bauträger raus (Kundengespräch 27.10., Nutzer 28.10.: gespeicherte Zeitpläne zeigten noch „Bauträger“,
  //      „Projektentwicklung“): Stichwörter mit Bauträger-Begriffen bekommen die neuen Standard-Stichwörter
  //      (shared/leadSearch.ts → DEFAULT_SEARCH_PROFILE). Positionen, Region und Anzahl bleiben.
  `
  UPDATE auto_search_schedules
     SET profile = json_set(profile, '$.keywords', json('["Kapitalanlage","Immobilienvertrieb","Finanzdienstleister","Finanzvertrieb"]'))
   WHERE EXISTS (
     SELECT 1 FROM json_each(auto_search_schedules.profile, '$.keywords')
      WHERE lower(value) IN ('bauträger', 'projektentwicklung', 'projektentwickler', 'wohnungsbau')
   );
  `,
];

export type Database = DatabaseSync;

/** Öffnet (und legt bei Bedarf an) die Datenbank im Datenordner und bringt das Schema auf den neuesten Stand. */
export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, DATABASE_FILE));
  // WAL: Server und Konten-Befehl dürfen gleichzeitig auf die Datei zugreifen.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** Schema auf den Stand `target` bringen (Standard: neuester). `target` nur für Tests (Migration alter Datenbanken). */
export function migrate(db: Database, target = MIGRATIONS.length): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = current; version < Math.min(target, MIGRATIONS.length); version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
