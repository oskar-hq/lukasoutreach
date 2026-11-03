/**
 * Vertrag für die Einstellungen in der Software – wird von Frontend (Vite) und Backend (Node) importiert.
 * Ohne Imports und ohne Laufzeit-Abhängigkeiten.
 *
 * Ziel (Wunsch des Nutzers): API-Schlüssel, Grenzen und Regeln in der Oberfläche ändern, ohne auf den Server zu
 * müssen. Jede Einstellung entspricht einer Variable der `.env` (`key` = Name der Variable). Entscheidungen des
 * Nutzers (04.10.): jedes angemeldete Konto darf ändern; so viel wie möglich in die Software.
 *
 * Routen (alle mit Sitzung):
 *   GET  /api/settings                → SettingsResponse
 *   PUT  /api/settings                SettingsUpdateRequest → SettingsResponse
 *                                     400 invalid_setting (mit `field`) · 403 reauth_failed · 409 setting_read_only |
 *                                     settings_changed | trial_pending | busy | live_leads_exist · 429 too_many_attempts
 *   POST /api/settings/trial/confirm  → SettingsResponse · 409 no_trial | trial_session_mismatch
 *   POST /api/settings/trial/revert   → SettingsResponse · 409 no_trial
 *   POST /api/settings/test           SettingsTestRequest → SettingsTestResponse · 429 too_many_attempts
 *   GET  /api/settings/history        → SettingsHistoryResponse (neueste zuerst, höchstens 100)
 *   GET  /api/settings/models         → AnthropicModelsResponse (Claude-Modelle zur Auswahl, siehe dort)
 *
 * ── Werte ──
 * Reihenfolge: in der Software gesetzt → `.env` → Standard. Gilt für den Server UND alle Server-Befehle
 * (`accountsCli`, `backupCli`, `liveCheck`): eine gemeinsame Funktion liest `.env` plus Software-Werte aus dem
 * `DATA_DIR`, mit derselben Entschlüsselung und demselben Notfallmodus. Meldungen nennen „Einstellungen oder .env“.
 *
 * Kodierung in GET und PUT:
 *   - integer/number: JSON-Zahl (integer ganzzahlig). `allowOff`: zusätzlich der Text `'off'`.
 *   - boolean: true/false. choice: genau ein `options`-Wert.
 *   - text/url/secret: Text. `''` = ausdrücklich „nicht gesetzt“ – überdeckt die `.env` (`source: 'software'`).
 *   - `null` in PUT löscht den Software-Wert (dann gilt wieder `.env` bzw. Standard). Fehlt ein Schlüssel in
 *     `changes`, bleibt er unverändert.
 *   - url: nur die Adresse ohne Pfad, Query, Fragment und Zugangsdaten (`new URL(v).origin`), abschließendes `/`
 *     wird entfernt, nur `https://` (http nur für localhost/127.0.0.1). `UNIPILE_DSN` darf ohne Schema kommen
 *     (wird zu https://) und muss auf `.unipile.com` enden. `PUBLIC_URL` mit `http://` nur, wenn
 *     `AUTH_COOKIE_SECURE` wirksam aus ist. Gilt für Werte aus der Software; die `.env` bleibt wie bisher.
 *   - `pattern` (falls gesetzt): Regulärer Ausdruck für text. GET liefert immer den normalisierten Wert.
 *   - min/max gelten nur für PUT. Werte aus der `.env` zeigt GET so, wie das Backend sie wirksam verwendet.
 *
 * ── PUT ──
 * Ganz oder gar nicht. Reihenfolge der Prüfungen:
 *   1. Body/unbekannter Schlüssel → 400 `invalid_setting` (`field`).
 *   2. Nur-.env-Schlüssel → 409 `setting_read_only`. Notfallmodus: nur `null`-Werte erlaubt, sonst 409.
 *   3. `version` veraltet (jemand anderes hat inzwischen gespeichert) → 409 `settings_changed`.
 *   4. Probe-Schlüssel nicht allein in einem PUT → 400; offene Probe und wieder ein Probe-Schlüssel → 409
 *      `trial_pending`.
 *   5. Werte und Querregeln gegen den zusammengeführten Stand → 400 `invalid_setting` (`field` = erster betroffener
 *      Schlüssel in `SETTING_KEYS`-Reihenfolge). Querregeln: `AUTH_COOKIE_SECURE` true nicht zusammen mit
 *      Testkonten; `AUTH_COOKIE_SECURE` muss zum Protokoll der Anfrage passen (`Origin` mit http:// → nur false,
 *      mit https:// → nur true); `PUBLIC_URL` siehe oben; Adresse mit gebundenem Geheimnis (`boundSecret`) nur
 *      zusammen mit einem neuen Wert für dieses Geheimnis im selben PUT.
 *   6. Sperre der Fehlversuche → 429 mit Retry-After (ohne Passwortprüfung).
 *   7. `reauth`: Passwort fehlt → 403 `reauth_failed` (zählt nicht); falsch → 403 (zählt wie ein Login-Fehlversuch).
 *      Gilt auch für `null` und `''`.
 *   8. Speichern, Verlauf schreiben, sofort wirksam machen.
 *
 * Wirkung ohne Neustart (Ziel des Nutzers 06.10.: nie auf die Shell): Adapter für Unipile, Anthropic, Meta, Clay, Treg,
 * Close und Slack werden neu gebaut, die LinkedIn-Grenzen, Arbeitszeiten, Accounts und `LINKEDIN_ACTIONS` gelten ab
 * der nächsten Aktion (der Abgleich plant neu), Regeln gelten ab der
 * nächsten Abfrage, die Sicherung plant neu, die Client-IP für die Sperre berechnet das Backend selbst aus
 * X-Forwarded-For und dem wirksamen `TRUST_PROXY_HOPS`. Ein laufender Lauf der Lead-Suche arbeitet mit seinen alten
 * Werten zu Ende.
 *
 * Modus: Die Software läuft immer echt; einen Schalter gibt es nicht mehr (07.10.). Nur automatische Tests und die
 * lokale Entwicklung starten das Backend über die Umgebung in der Simulation (`LEAD_SEARCH_MODE=mock`).
 *
 * ── Geheimnisse (`type: 'secret'`) ──
 *   - verlassen das Backend nach dem Speichern nie wieder: GET liefert nur `{ set, hint }`, `hint` = letzte 4 Zeichen
 *     (nur ab 12 Zeichen, sonst null). Nie in Logs, Fehlermeldungen, Testergebnissen oder im Verlauf.
 *   - Adressen, an die ein Geheimnis oder Lead-Daten gehen (`UNIPILE_DSN`, `CLAY_WEBHOOK_URL`, `PUBLIC_URL` als
 *     Rückweg für Clay und Basis der Einladungslinks), brauchen dieselbe Passwortabfrage. Mit `boundSecret`
 *     muss das Geheimnis beim Ändern der Adresse neu eingegeben werden.
 *   - verschlüsselt gespeichert (z. B. AES-256-GCM). Schlüssel: `SETTINGS_KEY` aus der `.env` (32 Byte, base64 oder
 *     64 Hex-Zeichen); fehlt er, erzeugt das Backend beim ersten Geheimnis `DATA_DIR/settings.key` (Rechte 600).
 *     Sicherungen kopieren nur die Datenbank, nie den Schlüssel. Nicht entschlüsselbar → Wert wird ignoriert
 *     (Warnung ohne Wert im Log, `problem` in GET).
 *
 * ── Start ──
 * Ein ungültiger oder nicht lesbarer Software-Wert lässt den Start nie scheitern: Er wird übersprungen (es gilt
 * `.env`/Standard), im Log nur mit Schlüssel gewarnt und in GET als `problem` gemeldet. Nur Fehler in der `.env`
 * dürfen den Start verhindern. Eine abgelaufene Probe wird vor dem Start zurückgesetzt.
 *
 * ── Probe-Änderung (`trial: true`) ──
 * Gilt sofort, aber nur auf Probe. Die PUT-Antwort setzt eine NEUE Sitzung mit den neuen Einstellungen
 * (Set-Cookie); `trial/confirm` gelingt nur mit genau dieser neuen Sitzung (sonst 409 `trial_session_mismatch`) –
 * so ist bewiesen, dass der Browser sich mit dem neuen Wert anmelden kann. Die alte Sitzung gilt bis zum Ende der
 * Probe weiter. Ohne Bestätigung bis `revertsAt` setzt das Backend zurück (Dauer `SETTINGS_TRIAL_SECONDS`, für Tests
 * über die Umgebung verkürzbar; maßgeblich ist `revertsAt`). Zurücksetzen (`trial/revert`) darf jedes Konto.
 * `clientIp` in der Antwort zeigt, welche Adresse das Backend gerade sieht (für `TRUST_PROXY_HOPS`).
 *
 * ── Notfallmodus ──
 * `SETTINGS_SAFE_MODE=true` in der `.env`: Das Backend ignoriert alle Software-Werte und nutzt nur `.env`/Standard.
 * GET meldet `safeMode: true` und zeigt unter `stored`, was in der Software gespeichert ist; PUT erlaubt nur `null`
 * (löschen, mit Passwort wie oben). Eine offene Probe wird zurückgesetzt. Zusätzlich auf dem Server:
 * `settingsCli reset <SCHLÜSSEL>|--all` (Ausgabe ohne Werte). Danach `docker compose up -d backend`.
 *
 * ── Nur über die `.env` (`readOnlyReason`) ──
 * Was der Server zum Starten braucht, was Docker/Caddy lesen (`ENV_ONLY_OUTSIDE_SETTINGS`) und die Testkonten
 * (bekanntes Passwort). Das wird nur bei der Einrichtung des Servers einmal gesetzt. GET zeigt sie mit Wert (keine
 * Geheimnisse) und Begründung; PUT → 409 `setting_read_only`.
 *
 * `LINKEDIN_PAUSE_SECONDS`: „von-bis“, von ≥ 3 und bis ≥ von, höchstens 600 – kleinere Pausen → 400 (Schutzgrenze aus
 * CLAUDE.md). `LINKEDIN_WORK_HOURS`: von < bis. `LINKEDIN_TIMEZONE`: muss eine gültige IANA-Zeitzone sein.
 *
 * ── Verlauf und Test ──
 * Verlauf: jede Änderung mit Zeit, Konto, IP, Schlüssel und Aktion; bei Nicht-Geheimnissen auch alter und neuer
 * Wert, bei Geheimnissen nie (auch kein hint). Fehlgeschlagene Passwortabfragen nur ins Log (Konto, IP, Schlüssel).
 * Verbindungstest: mit den gespeicherten Werten, harmloser dokumentierter Abruf ohne Kosten und ohne LinkedIn-Aktion
 * (Unipile: Account-Liste; Anthropic: Modell-Liste; Meta: eine Abfrage der Werbebibliothek; Close: `GET /api/v1/me/`;
 * Treg: ein dokumentierter Abruf ohne Kosten, falls es einen gibt – sonst eine Firma für ca. 0,2 Cent, das sagt dann
 * `message`; Slack: schickt die Nachricht „Test aus dem Outreach Cockpit – Slack ist verbunden.“ in den Kanal – das ist
 * gewollt, sie ist der Beweis). `message` nur aus festen
 * Sätzen (verbunden + Account-Name / Zugang abgelehnt / nicht erreichbar / Zeitüberschreitung / unerwartete Antwort
 * HTTP <Status>), nie mit Antworttext fremder Server. Begrenzung: je Dienst alle 10 s einmal, 20 pro Stunde je Konto
 * → 429. In Tests (Simulation) ohne Netz: `ok: true` ohne Verbindung. Clay hat keinen Test, weil
 * jeder Aufruf eine Zeile in der Clay-Tabelle anlegt.
 *
 * E2E: Ein PUT mit allen änderbaren Schlüsseln = `null` setzt alles zurück (mit Passwort).
 */

export const SETTINGS_TRIAL_SECONDS = 300;

/** Standard für `AUTO_QUALIFY_TERMS` – nur eindeutige Begriffe für eigene Projekte bzw. Kapitalanlage-Immobilien. */
export const AUTO_QUALIFY_DEFAULT_TERMS = ['Projektentwicklung', 'Projektentwickler', 'Bauträger', 'Wohnbau', 'Kapitalanlageimmobilien', 'Immobilien als Kapitalanlage'] as const;

export type SettingType = 'secret' | 'text' | 'url' | 'integer' | 'number' | 'boolean' | 'choice';

export const SETTING_GROUPS = ['leadSearch', 'unipile', 'linkedin', 'anthropic', 'meta', 'clay', 'crm', 'tasks', 'backup', 'server'] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const SETTING_GROUP_LABELS: Record<SettingGroup, string> = {
  leadSearch: 'Lead-Suche',
  unipile: 'LinkedIn (Unipile)',
  linkedin: 'Senden über LinkedIn',
  anthropic: 'KI-Bewertung (Anthropic)',
  meta: 'Meta-Werbebibliothek',
  clay: 'Firmendaten (Treg, Clay)',
  crm: 'CRM und Slack',
  tasks: 'Tagesstapel',
  backup: 'Sicherung und Updates',
  server: 'Server und Anmeldung',
};

export const SETTING_KEYS = [
  'MAX_RESULTS',
  'SEARCH_HITS_PER_RUN',
  'QUALIFY_MIN_CONFIDENCE',
  'AUTO_QUALIFY_TERMS',
  'LEAD_DISTRIBUTION',
  'UNIPILE_DSN',
  'UNIPILE_API_KEY',
  'UNIPILE_ACCOUNT_ID',
  'UNIPILE_SEARCH_API',
  'UNIPILE_LOCATION_ID',
  'UNIPILE_FETCH_COMPANY',
  'LINKEDIN_ACTIONS',
  'UNIPILE_ACCOUNT_NICK',
  'UNIPILE_ACCOUNT_JOHANNES',
  'UNIPILE_WARMUP_ACCOUNTS',
  'UNIPILE_ACCOUNTS_USED',
  'LINKEDIN_WARMUP_PER_DAY',
  'INVITE_NOTE',
  'LINKEDIN_INVITES_PER_DAY',
  'LINKEDIN_ACCOUNT_FALLBACK',
  'LINKEDIN_INVITES_PER_WEEK',
  'LINKEDIN_MESSAGES_PER_DAY',
  'LINKEDIN_WORK_HOURS',
  'LINKEDIN_WORK_DAYS',
  'LINKEDIN_TIMEZONE',
  'LINKEDIN_PAUSE_SECONDS',
  'LINKEDIN_SYNC_MINUTES',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'META_ACCESS_TOKEN',
  'META_GRAPH_VERSION',
  'ENRICHMENT_PROVIDER',
  'TREG_TOKEN',
  'TREG_MAX_COST_USD',
  'ENRICH_AUTO',
  'ENRICH_MAX_PER_DAY',
  'CLAY_WEBHOOK_URL',
  'CLAY_WEBHOOK_TOKEN',
  'CLAY_CALLBACK_SECRET',
  'CRM_HANDOVER',
  'CLOSE_API_KEY',
  'CLOSE_STATUS_ID',
  'SLACK_WEBHOOK_URL',
  'FOLLOWUP_AFTER_DAYS',
  'MAX_FOLLOW_UPS',
  'NEW_LEADS_PER_DAY',
  'INVITE_STALE_DAYS',
  'LOST_DELETE_DAYS',
  'BACKUP_HOUR_UTC',
  'BACKUP_KEEP',
  'BACKUP_MAX_AGE_DAYS',
  'UPDATE_AUTO',
  'UPDATE_HOUR',
  'PUBLIC_URL',
  'AUTH_COOKIE_SECURE',
  'TRUST_PROXY_HOPS',
  'DATA_DIR',
  'PORT',
  'HOST',
  'SETTINGS_SAFE_MODE',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingDefinition {
  key: SettingKey;
  group: SettingGroup;
  label: string;
  /** Ein bis zwei Sätze für die Oberfläche („du“). */
  help: string;
  type: SettingType;
  /** Nur bei `choice`. */
  options?: readonly { value: string; label: string }[];
  /** `integer`/`number`: Grenzen (einschließlich). */
  min?: number;
  max?: number;
  /** `secret`/`text`: Mindestlänge. */
  minLength?: number;
  /** `integer`: zusätzlich der Text „off“ erlaubt (z. B. Sicherung aus). */
  allowOff?: boolean;
  /** `text`: Regulärer Ausdruck (Quelle für `new RegExp`), den der Wert erfüllen muss. */
  pattern?: string;
  /** Adresse, an die dieses Geheimnis geht: Beim Ändern der Adresse muss es im selben PUT neu kommen. */
  boundSecret?: SettingKey;
  /** Vor dem Speichern das Passwort erneut abfragen. */
  reauth?: boolean;
  /** Nur auf Probe ändern (siehe Dateikopf). */
  trial?: boolean;
  /** Rückfrage vor dem Speichern je Zielwert (`String(value)`), z. B. beim Wechsel in den Live-Modus. */
  confirm?: Partial<Record<string, string>>;
  /** Gesetzt: nur über die `.env` änderbar, mit Begründung für die Oberfläche. */
  readOnlyReason?: string;
  /**
   * `text` mit Auswahlliste vom Server (Wunsch des Nutzers 12.10.: Modell per Dropdown statt Code abtippen):
   * `anthropic_models` → `GET /api/settings/models`. Eigene Werte bleiben erlaubt (z. B. ein Modell, das die Liste
   * noch nicht kennt).
   */
  optionsFrom?: 'anthropic_models';
}

/** Ein Claude-Modell zur Auswahl. `label` = Anzeigename von Anthropic („Claude Opus 5.5“). */
export interface AnthropicModelOption {
  id: string;
  label: string;
  /** Erscheinungsdatum (ISO) laut Anthropic – neueste zuerst. null bei der eingebauten Liste. */
  createdAt: string | null;
}

/**
 * `GET /api/settings/models` (Rechte wie `/api/settings`): verfügbare Claude-Modelle. Live über die Models-API von
 * Anthropic (`GET /v1/models`, eine Stunde zwischengespeichert) – so tauchen neue Modelle von selbst auf. Ohne
 * Schlüssel, in der Simulation oder wenn Anthropic nicht antwortet: `ANTHROPIC_BUILTIN_MODELS` mit `notice`.
 */
export interface AnthropicModelsResponse {
  models: AnthropicModelOption[];
  source: 'anthropic' | 'builtin';
  notice?: string;
}

/** Eingebaute Auswahl (Stand Oktober 2026), falls die Liste von Anthropic nicht abrufbar ist. */
export const ANTHROPIC_BUILTIN_MODELS: readonly AnthropicModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', createdAt: null },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', createdAt: null },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', createdAt: null },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', createdAt: null },
  { id: 'claude-opus-5', label: 'Claude Opus 5', createdAt: null },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', createdAt: null },
];

const ENV_ONLY_START = 'Braucht der Server schon beim Start – nur über die .env auf dem Server änderbar.';

export const SETTINGS: readonly SettingDefinition[] = [
  // ── Lead-Suche ──
  // Kein Modus-Schalter mehr (07.10.): Die Software läuft immer echt. Die Simulation (`LEAD_SEARCH_MODE=mock`,
  // `MOCK_SPEED`) gibt es nur noch über die Umgebung für automatische Tests und lokale Entwicklung.
  { key: 'MAX_RESULTS', group: 'leadSearch', label: 'Max. Profile pro Lauf (Voreinstellung)', help: 'Jedes Profil ist ein Besuch über einen der LinkedIn-Accounts – die Suche verteilt sich auf alle bei Unipile verbundenen, jeder ruft höchstens 100 Profile am Tag ab (feste Empfehlung von Unipile). Zwischen zwei Profilen liegen 3–8 Sekunden Pause; meldet LinkedIn ein Limit, bricht der Lauf ab. Viele Profile pro Lauf erhöhen das Risiko, dass LinkedIn den Account einschränkt.', type: 'integer', min: 1, max: 1000 },
  {
    key: 'SEARCH_HITS_PER_RUN',
    group: 'leadSearch',
    label: 'Suchtreffer pro Lauf',
    help: 'So viele LinkedIn-Treffer sieht ein Lauf durch (Dubletten-Filter und KI-Vorprüfung anhand der Headline), mindestens so viele wie Profile pro Lauf. Treffer, die im letzten Lauf übrig blieben (Warteliste), kommen zuerst dran und zählen mit – neu gesucht wird nur der Rest. Kostet nur Suchseiten, keine Profilbesuche – Profile werden nur für die vielversprechenden abgerufen.',
    type: 'integer',
    min: 20,
    max: 1000,
  },
  { key: 'QUALIFY_MIN_CONFIDENCE', group: 'leadSearch', label: 'Mindestsicherheit der KI', help: 'Unter diesem Wert (0 bis 1) gilt ein Lead nie als qualifiziert.', type: 'number', min: 0, max: 1 },
  {
    // Wunsch des Kunden 12.10.: eindeutige Fälle ohne KI qualifizieren – spart KI-Kosten.
    key: 'AUTO_QUALIFY_TERMS',
    group: 'leadSearch',
    label: 'Ohne KI qualifizieren bei',
    help: 'Stichwörter mit Komma getrennt. Steht eines davon in Headline, Position oder Firmenname eines Entscheiders (Geschäftsführer, Inhaber …), gilt der Lead ohne KI-Aufruf als qualifiziert – außer bei Versicherung, Finanzberatung, Makler oder Hausverwaltung. „off“ schaltet es aus. Vorsicht mit „Kapitalanlage“ oder „Vermögensaufbau“: so beschreiben sich vor allem Finanzberater.',
    type: 'text',
    pattern: '^[^<>{}]{0,500}$',
  },
  {
    // Verteilung neuer Leads (Regel in `shared/leads.ts` → `LeadDistribution`).
    key: 'LEAD_DISTRIBUTION',
    group: 'leadSearch',
    label: 'Neue Leads verteilen',
    help: 'Gesucht wird immer über den Such-Account (Sales Navigator). „Auf beide Gründer verteilen“ teilt neue Leads gleichmäßig auf Nick und Johannes auf – so gehen Vernetzungsanfragen und Nachrichten über beide LinkedIn-Accounts raus und jeder Account bleibt unter seinem Limit. Braucht bei beiden Gründern einen eingetragenen LinkedIn-Account.',
    type: 'choice',
    options: [
      { value: 'owner', label: 'Wer sucht, bekommt die Leads' },
      { value: 'balanced', label: 'Auf beide Gründer verteilen' },
    ],
  },

  // ── Unipile ──
  {
    key: 'UNIPILE_DSN',
    group: 'unipile',
    label: 'DSN',
    help: 'Adresse aus dem Unipile-Dashboard, z. B. https://api68.unipile.com:19881. Beim Ändern den Access Token neu eingeben.',
    type: 'url',
    reauth: true,
    boundSecret: 'UNIPILE_API_KEY',
  },
  { key: 'UNIPILE_API_KEY', group: 'unipile', label: 'Access Token', help: 'Aus dem Unipile-Dashboard.', type: 'secret', reauth: true },
  { key: 'UNIPILE_ACCOUNT_ID', group: 'unipile', label: 'LinkedIn-Account-ID', help: 'Leer = erster verbundener LinkedIn-Account.', type: 'text' },
  {
    key: 'UNIPILE_SEARCH_API',
    group: 'unipile',
    label: 'Suche',
    help: 'Sales Navigator nur mit passender Lizenz.',
    type: 'choice',
    options: [
      { value: 'classic', label: 'LinkedIn (normal)' },
      { value: 'sales_navigator', label: 'Sales Navigator' },
    ],
  },
  { key: 'UNIPILE_LOCATION_ID', group: 'unipile', label: 'Regions-ID', help: 'Leer = wird aus dem Feld „Region“ der Suche ermittelt.', type: 'text' },
  { key: 'UNIPILE_FETCH_COMPANY', group: 'unipile', label: 'Firmenprofil abrufen', help: 'Beschreibung und Website der Firma – ein zusätzlicher Abruf pro Lead.', type: 'boolean' },

  // ── Senden über LinkedIn (Phase 3, `shared/linkedin.ts`) ──
  {
    key: 'LINKEDIN_ACTIONS',
    group: 'linkedin',
    label: 'Echt über LinkedIn senden',
    help: 'Aus: Du sendest auf LinkedIn selbst und trägst es im Cockpit ein. An: Vernetzen und Nachrichten gehen per Klick über den LinkedIn-Account des Gründers.',
    type: 'choice',
    options: [
      { value: 'off', label: 'Aus (von Hand)' },
      { value: 'on', label: 'An (Cockpit sendet)' },
    ],
    reauth: true,
    confirm: {
      on: 'Ab jetzt sendet das Cockpit echt über LinkedIn – mit den Grenzen und Arbeitszeiten unten. Mach zuerst eine Test-Anfrage an einen Kollegen.',
    },
  },
  {
    key: 'UNIPILE_ACCOUNT_NICK',
    group: 'linkedin',
    label: 'LinkedIn-Account von Nick',
    help: 'Über welchen bei Unipile verbundenen Account Nick sendet. Aus der Liste wählen.',
    type: 'text',
    pattern: '^[A-Za-z0-9_-]{1,64}$',
    reauth: true,
  },
  {
    key: 'UNIPILE_ACCOUNT_JOHANNES',
    group: 'linkedin',
    label: 'LinkedIn-Account von Johannes',
    help: 'Über welchen bei Unipile verbundenen Account Johannes sendet. Aus der Liste wählen.',
    type: 'text',
    pattern: '^[A-Za-z0-9_-]{1,64}$',
    reauth: true,
  },
  {
    // Wunsch des Nutzers 21.10.: reine Scraping-Accounts wachsen nebenbei ins Netzwerk der Branche (bessere Suchtreffer).
    key: 'UNIPILE_WARMUP_ACCOUNTS',
    group: 'linkedin',
    label: 'Accounts aufwärmen',
    help: 'Diese Accounts schicken zu zufälligen Zeiten in der Arbeitszeit Vernetzungsanfragen (ohne Notiz) an qualifizierte Leads und Profile aus der Tracking-Liste – damit sie ins Netzwerk der Branche kommen und bessere Suchtreffer liefern. Gescraped wird über sie weiter. Nicht für die Accounts der Gründer. Unter „LinkedIn-Accounts“ per Klick wählen.',
    type: 'text',
    pattern: '^([A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64})*)?$',
  },
  {
    // Instanz Lukas 03.11.: derselbe Unipile-Zugang wie im anderen Cockpit – dessen Accounts bleiben hier unberührt.
    key: 'UNIPILE_ACCOUNTS_USED',
    group: 'linkedin',
    label: 'Accounts in diesem Cockpit',
    help: 'Nur diese bei Unipile verbundenen Accounts nutzt dieses Cockpit zum Suchen, Profile-Lesen und Senden – alle anderen ignoriert es (z. B. die eines anderen Cockpits mit demselben Unipile-Zugang). Leer = alle. Gründer- und Aufwärm-Accounts zählen immer dazu. Unter „LinkedIn-Accounts“ per Klick wählen.',
    type: 'text',
    pattern: '^([A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64})*)?$',
  },
  {
    key: 'LINKEDIN_WARMUP_PER_DAY',
    group: 'linkedin',
    label: 'Aufwärmen: Anfragen pro Tag',
    help: 'Höchstens so viele Anfragen schickt jeder Aufwärm-Account am Tag (höchstens 17 – es sind private Accounts, was jemand selbst sendet, soll noch Platz haben). In den ersten Wochen langsamer: 6, dann 10, dann 14.',
    type: 'integer',
    min: 0,
    max: 17,
  },
  { key: 'LINKEDIN_INVITES_PER_DAY', group: 'linkedin', label: 'Vernetzungsanfragen pro Tag (Sperre)', help: 'Je LinkedIn-Account. Ist die Zahl erreicht, sperrt das Cockpit weitere Anfragen über diesen Account bis morgen – beim echten Senden und beim Eintragen von Hand (mit „Zweiten Account nutzen“ geht es über den anderen weiter). LinkedIn wird bei mehr als etwa 20 pro Tag misstrauisch.', type: 'integer', min: 0, max: 50 },
  {
    // Wunsch des Nutzers 12.10.: 40 neue Leads am Tag – sind die 20 Anfragen des eigenen Accounts weg, geht es über den
    // Account des anderen Gründers weiter.
    key: 'LINKEDIN_ACCOUNT_FALLBACK',
    group: 'linkedin',
    label: 'Zweiten Account nutzen, wenn deiner voll ist',
    help: 'An: Hat dein Account sein Tageslimit an Anfragen erreicht, gehen weitere über den Account des anderen Gründers – der Tagesstapel zeigt dann bis zu doppelt so viele neue Leads. Erstnachricht und Follow-ups laufen danach über denselben Account, denn nur dort besteht die Verbindung. Aus: jeder nur über den eigenen Account.',
    type: 'choice',
    options: [
      { value: 'on', label: 'An' },
      { value: 'off', label: 'Aus' },
    ],
  },
  { key: 'LINKEDIN_INVITES_PER_WEEK', group: 'linkedin', label: 'Vernetzungsanfragen in 7 Tagen (Sperre)', help: 'Je Gründer, gleitend über die letzten 7 Tage – sperrt wie das Tageslimit, auch beim Eintragen von Hand.', type: 'integer', min: 0, max: 200 },
  { key: 'LINKEDIN_MESSAGES_PER_DAY', group: 'linkedin', label: 'Nachrichten pro Tag', help: 'Je Account – Erstnachrichten und Follow-ups zusammen. Höchstens 100 (Empfehlung von Unipile).', type: 'integer', min: 0, max: 100 },
  {
    key: 'LINKEDIN_WORK_HOURS',
    group: 'linkedin',
    label: 'Arbeitszeit (Uhr von–bis)',
    help: 'Nur in dieser Zeit wird gesendet, z. B. „8-19“.',
    type: 'text',
    pattern: '^([01]?[0-9]|2[0-4])-([01]?[0-9]|2[0-4])$',
  },
  {
    key: 'LINKEDIN_WORK_DAYS',
    group: 'linkedin',
    label: 'Arbeitstage',
    help: '1 = Montag … 7 = Sonntag, z. B. „1-5“ (Mo–Fr) oder „1-5,7“.',
    type: 'text',
    pattern: '^[1-7](-[1-7])?(,[1-7](-[1-7])?)*$',
  },
  { key: 'LINKEDIN_TIMEZONE', group: 'linkedin', label: 'Zeitzone', help: 'Für Arbeitszeit und „heute“, z. B. Europe/Berlin.', type: 'text', pattern: '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$' },
  {
    key: 'LINKEDIN_PAUSE_SECONDS',
    group: 'linkedin',
    label: 'Pause zwischen zwei Aktionen (Sekunden von–bis)',
    help: 'Zufällige Pause je Account, z. B. „3-8“. Unter 3 Sekunden geht nicht – Schutz des Accounts.',
    type: 'text',
    pattern: '^[0-9]{1,3}-[0-9]{1,3}$',
  },
  { key: 'LINKEDIN_SYNC_MINUTES', group: 'linkedin', label: 'Antworten abholen alle … Minuten', help: 'Angenommene Anfragen und neue Antworten automatisch abholen. 0 = aus.', type: 'integer', min: 0, max: 1440 },

  // ── Anthropic ──
  { key: 'ANTHROPIC_API_KEY', group: 'anthropic', label: 'API-Schlüssel', help: 'Aus console.anthropic.com. Ohne Schlüssel werden Leads nicht von der KI bewertet.', type: 'secret', reauth: true },
  {
    key: 'ANTHROPIC_MODEL',
    group: 'anthropic',
    label: 'Modell',
    help: 'Modell für die Einstufung der Leads. Die Liste kommt von Anthropic – neue Modelle erscheinen von selbst. Größere Modelle urteilen genauer, kosten aber mehr je Lead.',
    type: 'text',
    optionsFrom: 'anthropic_models',
  },

  // ── Meta ──
  { key: 'META_ACCESS_TOKEN', group: 'meta', label: 'Access Token', help: 'Läuft nach 60 Tagen ab. Ohne Token bleiben Leads „Meta-Ads nicht geprüft“.', type: 'secret', reauth: true },
  { key: 'META_GRAPH_VERSION', group: 'meta', label: 'Graph-API-Version', help: 'z. B. v26.0', type: 'text', pattern: '^v?\\d+(\\.\\d+)?$' },

  // ── Firmendaten (Treg, alternativ Clay) ──
  {
    key: 'ENRICHMENT_PROVIDER',
    group: 'clay',
    label: 'Quelle der Firmendaten',
    help: 'Treg fragt je Firma bis zu 27 Datenanbieter ab (ca. 0,2 Cent). Clay braucht eine eigene Tabelle und ein Abo.',
    type: 'choice',
    options: [
      { value: 'treg', label: 'Treg' },
      { value: 'clay', label: 'Clay' },
    ],
  },
  { key: 'TREG_TOKEN', group: 'clay', label: 'Treg-Token', help: 'Aus dem Dashboard auf treg.to. Ohne Token werden keine Firmendaten geholt.', type: 'secret', reauth: true },
  { key: 'TREG_MAX_COST_USD', group: 'clay', label: 'Höchstpreis je Abruf (US-Dollar)', help: 'Obergrenze für eine Firma. Üblich sind etwa 0,002 $.', type: 'number', min: 0.001, max: 1 },
  { key: 'ENRICH_AUTO', group: 'clay', label: 'Neue Leads automatisch anreichern', help: 'Nur Score Hoch/Mittel. Kostet je Abruf.', type: 'boolean' },
  { key: 'ENRICH_MAX_PER_DAY', group: 'clay', label: 'Höchstens pro Tag', help: 'Obergrenze der Abrufe pro Tag.', type: 'integer', min: 0, max: 10000 },
  {
    key: 'CLAY_WEBHOOK_URL',
    group: 'clay',
    label: 'Clay: Webhook-Adresse',
    help: 'Nur bei Quelle Clay. Aus der Clay-Tabelle („Import data from Webhook“), nur https.',
    type: 'secret',
    reauth: true,
    boundSecret: 'CLAY_WEBHOOK_TOKEN',
  },
  { key: 'CLAY_WEBHOOK_TOKEN', group: 'clay', label: 'Clay: Webhook-Token', help: 'Optional, wird als x-clay-webhook-auth mitgeschickt.', type: 'secret', reauth: true },
  {
    key: 'CRM_HANDOVER',
    group: 'crm',
    label: 'An Close übergeben',
    help: 'Aus (Standard): Wir arbeiten mit dem CRM im Cockpit – Leads bleiben hier, „An Close übergeben“ ist überall ausgeblendet. An: Knopf „An Close übergeben“ auf der Antwort-Karte und im Lead-Panel.',
    type: 'boolean',
  },
  {
    key: 'CLOSE_API_KEY',
    group: 'crm',
    label: 'Close: API-Schlüssel',
    help: 'In Close unter Settings → Developer → API Keys anlegen. Ohne Schlüssel werden Leads nur im Cockpit als übergeben markiert.',
    type: 'secret',
    reauth: true,
  },
  {
    key: 'CLOSE_STATUS_ID',
    group: 'crm',
    label: 'Close: Status für neue Leads',
    help: 'Optional, z. B. „stat_…“ aus Close. Leer = Standard-Status in Close.',
    type: 'text',
    pattern: '^stat_[A-Za-z0-9]+$',
  },
  {
    key: 'SLACK_WEBHOOK_URL',
    group: 'crm',
    label: 'Slack: Webhook für neue Antworten',
    help: 'In Slack eine App mit „Incoming Webhooks“ anlegen und die Adresse (https://hooks.slack.com/…) hier eintragen. Kostenlos. Leer = keine Slack-Nachricht.',
    type: 'secret',
    reauth: true,
  },
  { key: 'CLAY_CALLBACK_SECRET', group: 'clay', label: 'Clay: Schlüssel für den Rückweg', help: 'Mindestens 24 Zeichen. Derselbe Wert steht in der Clay-Tabelle.', type: 'secret', minLength: 24, reauth: true },

  // ── Tagesstapel ──
  { key: 'FOLLOWUP_AFTER_DAYS', group: 'tasks', label: 'Follow-up nach Tagen', help: 'So viele Tage ohne Antwort, dann ist ein Follow-up fällig.', type: 'integer', min: 1, max: 60 },
  { key: 'MAX_FOLLOW_UPS', group: 'tasks', label: 'Höchstens Follow-ups', help: 'Danach steht der Lead unter „braucht Aufmerksamkeit“.', type: 'integer', min: 0, max: 10 },
  { key: 'NEW_LEADS_PER_DAY', group: 'tasks', label: 'Neue Leads pro Tag', help: 'Je Gründer: so viele Karten „Neuer Lead“ zeigt der Tagesstapel am Tag (passt zum LinkedIn-Tageslimit). Die automatische Suche begrenzt das nicht – sie sucht höchstens Läufe × Profile pro Lauf und bis zu den Grenzen der LinkedIn-Accounts.', type: 'integer', min: 0, max: 100 },
  {
    // Wunsch des Nutzers 11.10.: Notiz zur Vernetzungsanfrage ausschaltbar.
    key: 'INVITE_NOTE',
    group: 'tasks',
    label: 'Notiz zur Vernetzungsanfrage',
    help: 'An: Auf der Karte „Neuer Lead“ lässt sich eine kurze Notiz (höchstens 300 Zeichen) mitschicken. Aus: Anfragen gehen immer ohne Notiz, das Feld ist ausgeblendet.',
    type: 'choice',
    options: [
      { value: 'on', label: 'An' },
      { value: 'off', label: 'Aus' },
    ],
  },
  {
    key: 'LOST_DELETE_DAYS',
    group: 'tasks',
    label: '„Verloren“ löschen nach Tagen',
    help: 'Leads mit „kein Interesse“ (Stufe Verloren) werden nach so vielen Tagen gelöscht. Wer gelöscht ist, wird trotzdem nie wieder vorgeschlagen. „off“ = nie löschen.',
    type: 'integer',
    min: 1,
    max: 3650,
    allowOff: true,
  },
  { key: 'INVITE_STALE_DAYS', group: 'tasks', label: 'Anfrage hängt nach Tagen', help: 'So lange offen, dann braucht die Anfrage Aufmerksamkeit.', type: 'integer', min: 1, max: 365 },

  // ── Sicherung ──
  {
    key: 'BACKUP_HOUR_UTC',
    group: 'backup',
    label: 'Uhrzeit der Sicherung (UTC)',
    help: '0–23 oder „off“. 2 = 3 bzw. 4 Uhr deutscher Zeit.',
    type: 'integer',
    min: 0,
    max: 23,
    allowOff: true,
    reauth: true,
    confirm: { off: 'Dann wird die Datenbank nicht mehr täglich gesichert. Wirklich ausschalten?' },
  },
  {
    key: 'BACKUP_KEEP',
    group: 'backup',
    label: 'Aufbewahrte Sicherungen',
    help: 'Ältere werden beim nächsten Lauf gelöscht.',
    type: 'integer',
    min: 1,
    max: 365,
    reauth: true,
  },
  {
    key: 'BACKUP_MAX_AGE_DAYS',
    group: 'backup',
    label: 'Sicherungen löschen nach (Tagen)',
    help: 'Gilt für geplante und von Hand angelegte Sicherungen. Die neueste bleibt immer.',
    type: 'integer',
    min: 1,
    max: 365,
    reauth: true,
  },

  // ── Updates (`shared/system.ts`) ──
  { key: 'UPDATE_AUTO', group: 'backup', label: 'Updates nachts automatisch einspielen', help: 'Gibt es eine neue Version, spielt der Server sie zur Uhrzeit unten selbst ein (ein paar Minuten nicht erreichbar).', type: 'boolean' },
  { key: 'UPDATE_HOUR', group: 'backup', label: 'Uhrzeit der Updates (deutsche Zeit)', help: '0–23, z. B. 3 = 3 Uhr nachts.', type: 'integer', min: 0, max: 23 },

  // ── Server und Anmeldung ──
  {
    key: 'PUBLIC_URL',
    group: 'server',
    label: 'Öffentliche Adresse',
    help: 'Basis für Einladungslinks und Rückweg für Clay, z. B. https://lukas.ylvalabs.de.',
    type: 'url',
    reauth: true,
  },
  {
    key: 'AUTH_COOKIE_SECURE',
    group: 'server',
    label: 'Anmeldung nur über HTTPS',
    help: 'Muss zur Adresse passen: an bei https, aus nur ohne HTTPS (z. B. Testserver im Heimnetz). Gilt erst auf Probe.',
    type: 'boolean',
    reauth: true,
    trial: true,
  },
  {
    key: 'TRUST_PROXY_HOPS',
    group: 'server',
    label: 'Proxys vor dem Backend',
    help: 'Das Backend vertraut nur nginx; nginx prüft selbst, ob die Anfrage von Caddy kam. 1 und 2 wirken deshalb gleich (2 = Caddy + nginx, ältere Einrichtung). Richtig, wenn unten deine eigene öffentliche IP steht.',
    type: 'integer',
    min: 1,
    max: 2,
    reauth: true,
    trial: true,
  },
  { key: 'DATA_DIR', group: 'server', label: 'Datenordner', help: 'Hier liegen Datenbank, Sicherungen und diese Einstellungen.', type: 'text', readOnlyReason: 'Die Einstellungen liegen selbst in diesem Ordner – nur über die .env änderbar.' },
  { key: 'PORT', group: 'server', label: 'Port des Backends', help: 'nginx leitet /api an diesen Port weiter.', type: 'integer', readOnlyReason: ENV_ONLY_START },
  { key: 'HOST', group: 'server', label: 'Adresse des Backends', help: 'Netzwerkadresse im Container.', type: 'text', readOnlyReason: ENV_ONLY_START },
  {
    key: 'SETTINGS_SAFE_MODE',
    group: 'server',
    label: 'Notfallmodus',
    help: 'Ignoriert alle Werte aus der Software und nutzt nur die .env.',
    type: 'boolean',
    readOnlyReason: 'Der Notweg, falls eine Einstellung den Zugang stört – deshalb nur über die .env.',
  },
];

/**
 * Nur in der `.env`, nicht im Katalog: Domain (`SITE_ADDRESS`) und Freigabe (`WEB_BIND`) liest Docker bzw. Caddy,
 * `SETTINGS_KEY` schützt die gespeicherten Geheimnisse selbst.
 */
export const ENV_ONLY_OUTSIDE_SETTINGS = ['SITE_ADDRESS', 'WEB_BIND', 'SETTINGS_KEY'] as const;

export type SettingValue = string | number | boolean;

/** Woher der wirksame Wert kommt. */
export type SettingSource = 'software' | 'env' | 'default';

export interface SettingState {
  key: SettingKey;
  source: SettingSource;
  /** Woher `fallback` stammt. */
  fallbackSource?: 'env' | 'default';
  /** Gespeicherter Software-Wert ist ungültig oder nicht lesbar und wird ignoriert – fertiger deutscher Satz. */
  problem?: string;
  /** Nur im Notfallmodus: was in der Software gespeichert ist (Geheimnisse nur als `{ set, hint }`). */
  stored?: { value?: SettingValue | null; secret?: { set: boolean; hint: string | null } };
  /** Wirksamer Wert – fehlt bei Geheimnissen. null = nicht gesetzt. */
  value?: SettingValue | null;
  /** Wert aus `.env` bzw. Standard, der ohne Software-Wert gälte – fehlt bei Geheimnissen. */
  fallback?: SettingValue | null;
  /** Nur bei Geheimnissen: wirksam gesetzt? `hint` = letzte 4 Zeichen (ab 12 Zeichen), sonst null. */
  secret?: { set: boolean; hint: string | null };
  /** Nur bei Geheimnissen: gälte ohne Software-Wert einer aus der `.env`? */
  fallbackSecret?: { set: boolean; hint: string | null };
}

export interface SettingsTrial {
  keys: SettingKey[];
  /** Ohne Bestätigung bis hierhin (Millisekunden seit 1970) setzt das Backend zurück. */
  revertsAt: number;
  username: string;
}

export interface SettingsResponse {
  settings: SettingState[];
  trial: SettingsTrial | null;
  safeMode: boolean;
  /** Stand der Einstellungen; im PUT mitschicken, sonst kann ein anderer Speichervorgang überschrieben werden. */
  version: number;
  /** Serverzeit (Millisekunden seit 1970) – für die Restzeit der Probe. */
  serverTime: number;
  /** Adresse, die das Backend für diese Anfrage sieht (mit wirksamem `TRUST_PROXY_HOPS`). */
  clientIp: string;
}

export interface SettingsUpdateRequest {
  /** Schlüssel → neuer Wert; `null` = Wert aus der Software löschen. Nicht genannte bleiben unverändert. */
  changes: Partial<Record<SettingKey, SettingValue | null>>;
  /** Nötig, sobald eine Änderung `reauth: true` hat. */
  password?: string;
  /** `version` aus der letzten Antwort – veraltet → 409 `settings_changed`. */
  version?: number;
}

export type SettingsTestService = 'unipile' | 'anthropic' | 'meta' | 'treg' | 'close' | 'slack';

export interface SettingsTestRequest {
  service: SettingsTestService;
}

export interface SettingsTestResponse {
  ok: boolean;
  /** Fertiger deutscher Satz, z. B. „Verbunden: LinkedIn-Account Nick“ oder der Grund des Fehlers. */
  message: string;
}

export type SettingsHistoryAction = 'set' | 'reset' | 'trial' | 'confirmed' | 'reverted';

export interface SettingsHistoryEntry {
  at: number;
  username: string;
  ip?: string;
  key: SettingKey;
  action: SettingsHistoryAction;
  /** Nur bei Nicht-Geheimnissen: vorher und nachher (`null` = nicht in der Software gesetzt). */
  from?: SettingValue | null;
  to?: SettingValue | null;
}

export interface SettingsHistoryResponse {
  entries: SettingsHistoryEntry[];
}

/**
 * Fehlercodes (`ApiErrorBody.error.code`, Meldung als fertiger deutscher Satz):
 * - `invalid_setting` (400) – Wert oder Querregel verletzt; `error.field` nennt den Schlüssel;
 * - `reauth_failed` (403) – Passwort fehlt oder ist falsch;
 * - `setting_read_only` (409) – nur über die `.env` änderbar bzw. im Notfallmodus nur Löschen erlaubt;
 * - `settings_changed` (409) – inzwischen hat jemand anderes gespeichert (neu laden);
 * - `trial_pending` (409) – es läuft schon eine Probe-Änderung;
 * - `no_trial` (409) – keine Probe-Änderung offen;
 * - `trial_session_mismatch` (409) – Bestätigen nur mit der neuen Sitzung aus der Probe;
 * - `busy` (409) – Lead-Suche läuft (bei `LEAD_SEARCH_MODE`);
 * - `live_leads_exist` (409) – Demo-Daten zurücksetzen/einspielen, obwohl es Leads aus Live-Läufen gibt;
 * - `too_many_attempts` (429) – Sperre nach Fehlversuchen bzw. Verbindungstest zu oft.
 */
export type SettingsErrorCode =
  | 'invalid_setting'
  | 'reauth_failed'
  | 'setting_read_only'
  | 'settings_changed'
  | 'trial_pending'
  | 'no_trial'
  | 'trial_session_mismatch'
  | 'busy'
  | 'live_leads_exist'
  | 'too_many_attempts';

/** Definition zu einem Schlüssel (für Oberfläche und Prüfung im Backend). */
export function settingDefinition(key: SettingKey): SettingDefinition {
  const definition = SETTINGS.find((entry) => entry.key === key);
  if (!definition) throw new Error(`Unbekannte Einstellung: ${key}`);
  return definition;
}
