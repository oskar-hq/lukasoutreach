# Plan: Von der Demo zur richtigen Software

Stand: 03.10.2026, Fortschritt 06.10.2026. Ziel: Das Outreach Cockpit wird das Arbeitswerkzeug von Ylva Labs für Nick und Johannes.
Es findet passende Leads (Kapitalanlage-Vertrieb, Bauträger ohne aktive Meta-Ads), vernetzt sich auf LinkedIn,
führt durch Erstnachricht, Follow-ups und Antworten und ersetzt die Outreach-Tracking-Excel.

**Fortschritt (06.10., abends):** Alle Phasen sind gebaut, dazu Rollen/Konten, die automatische Lead-Suche, Slack bei
neuer Antwort, Close per API und das Löschen von „Verloren“ nach 30 Tagen. Phase 3 bleibt aus (gesendet wird von Hand).
Offen sind Schritte des Nutzers (Schlüssel, Verträge, Limits). Was genau echt ist: `docs/STAND.md`.

## Grundsätze für alle Phasen

- **Reihenfolge je Phase:** ① Backend liefert Vertrag (`shared/`) + Simulation (kleiner PR) → ② parallel:
  Backend baut den echten Teil, Frontend baut die Oberfläche gegen die Simulation → ③ Abnahme auf dem Server.
- **Simulation bleibt.** Jede neue Funktion hat einen Mock-Modus. So laufen Entwicklung, E2E-Tests und Vorführungen
  ohne echte Daten und ohne Risiko für die LinkedIn-Accounts.
- **Echte LinkedIn-Aktionen nur per Klick** eines Menschen, nie automatisch. Dazu Tageslimits, Pausen und Abbruch bei
  Limit- oder Zugangsfehlern, wie in der Lead-Suche.
- **Design:** `DESIGN.md` gilt weiter (schwarz-weiß, eine Aufgabe pro Bildschirm, Tastatur zuerst).
- **Jede Phase endet produktiv** auf `crm.ylvalabs.de`. Kein Big Bang.

## Phase 1 · Login und Nutzer *(fertig, plus Rollen Admin/Gründer/Mitarbeiter)*

Ziel: Eigene Anmeldung statt Browser-Passwortfenster (Caddy `basic_auth`) und statt Demo-Auswahl „Nick oder Johannes“.

- **Backend:**
  - Konten (Nick, Johannes; erweiterbar), Passwörter gehasht (z. B. argon2/scrypt), dauerhaft gespeichert.
  - Sitzung per Cookie (httpOnly, Secure, SameSite=Lax); alle `/api/*` ohne Sitzung → 401.
  - Begrenzung der Login-Versuche. Konto anlegen und Passwort ändern per Server-Befehl.
- **Vertrag:** `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. Jeder Nutzer ist einem Gründer
  zugeordnet (`nick` | `johannes`).
- **Frontend:** Anmeldeseite im Cockpit-Design, angemeldet bleiben, Abmelden, Weiterleitung bei abgelaufener Sitzung.
  Die Demo-Gründerauswahl entfällt.
- **Fertig, wenn:** Anmeldung auf `crm.ylvalabs.de` läuft, `basic_auth` aus `deploy/Caddyfile` entfernt ist
  (HTTPS bleibt) und die E2E-Tests sich mit Testkonten anmelden.
- Details der Anforderungen: `docs/agents/frontend.md` → „Brauche von der anderen Seite“.

## Phase 2 · Datenbank und echte Leads *(fertig)*

Ziel: Alles bleibt gespeichert. Die Tracking-Excel wird zur Datenbank.

- **Backend:**
  - Datenbank auf dem Server, mit Migrationen. Empfehlung: SQLite im Docker-Volume, reicht für zwei Nutzer und ist
    leicht zu sichern.
  - Datenmodell:
    - **Lead:** Person, Firma, LinkedIn-IDs, zuständiger Gründer, Stufe, KI-Einschätzung, Meta-Ads-Stand, Herkunft;
    - **Ereignisse/Verlauf:** jede Aktion mit Zeitpunkt und Nutzer;
    - **Läufe der Lead-Suche.**
  - **Einmaliger Import der Tracking-Excel** (heute ca. 844 Profile) als Startbestand. Der Upload als Dubletten-Liste
    entfällt danach, die Datenbank ist die Dubletten-Quelle.
  - „In den Tagesstapel“ aus der Lead-Suche speichert in die Datenbank statt in den Browser.
  - Nächtliche Sicherung der Datenbank.
- **Vertrag:** Lead- und Aufgaben-Routen (Liste, Detail, Stufe ändern, Verlauf).
- **Frontend:**
  - Cockpit, Lead-Panel und Historie lesen aus der API statt aus `src/data/`.
  - Zustände für Laden, Leer und Fehler.
  - „Demo zurücksetzen“ und der Demo-Hinweis entfallen; die Demo-Daten bleiben nur im Mock-Modus.
- **Fertig, wenn:** Nach Neuladen und Server-Neustart ist alles noch da, und die Excel wird nicht mehr gepflegt.

## Phase 3 · Echte LinkedIn-Aktionen über Unipile *(gebaut, aus – Entscheidung 05.10.: von Hand senden)*

Ziel: Vernetzen und Nachrichten direkt aus dem Cockpit, für beide Gründer mit ihrem eigenen LinkedIn-Account.

- **Backend:**
  - Johannes' LinkedIn-Account zusätzlich bei Unipile verbinden; jeder Nutzer sendet über seinen eigenen Account.
  - **Vernetzungsanfrage:** `POST /api/v1/users/invite` (im offiziellen Unipile-SDK geprüft: `provider_id`,
    `account_id`, optional `message`).
  - Angenommene Anfragen erkennen, Nachrichten senden, Antworten empfangen: nur über dokumentierte Unipile-Endpunkte
    bzw. Webhooks. Vor dem Bau in der Doku prüfen, nichts erfinden.
  - **Schutz:** Tageslimit je Account, zufällige Pausen, nur zu Arbeitszeiten, Protokoll jeder Aktion, Abbruch bei
    Limit- oder Zugangsfehlern.
  - Erst ein Test-Befehl, der genau eine Anfrage an ein vorgegebenes Profil schickt (z. B. ein Kollege), dann die
    Funktion im Cockpit.
- **Frontend:**
  - „Vernetzen“ und „Senden“ lösen echte Aktionen aus, mit klarem Status („wird gesendet …“ → „Gesendet ✓“),
    Rückgängig, solange noch nicht gesendet, und sichtbarem Tageslimit.
  - Antworten erscheinen als Antwort-Karten.
- **Fertig, wenn:** Eine echte Anfrage plus Erstnachricht laufen vollständig über das Cockpit, und der Verlauf stimmt.

## Phase 4 · Nachrichten-Vorlagen und KI passend zum Pain-Point *(fertig, Meta-Token fehlt)*

Ziel: Die Ansprache passt zur Zielgruppe „Meta-Ads laufen nicht / nie probiert“: „Wir machen das besser bei euch“.

- **Vorlagen:**
  - Die Vorlagen A/B sprechen heute noch von „… gerade Meta Ads schaltet“. Das ist die falsche Zielgruppe, sie werden
    neu geschrieben.
  - Eigene Varianten für „keine Meta-Ads“ und „Meta-Ads beendet“.
  - Vorlagen später in der Oberfläche pflegbar.
- **KI:** Vorschläge für Antworten und Follow-ups (Anthropic), Einschätzung eingehender Antworten. Immer als Vorschlag,
  gesendet wird per Klick.
- **Meta-Ads-Filter scharf schalten:**
  - `META_ACCESS_TOKEN` setzen, sobald die Identität bei Meta bestätigt ist.
  - Den Abgleich mit bekannten Firmen prüfen (`liveCheck.js --meta "Firma"`).

## Phase 5 · Follow-ups, Tagesstapel und Benachrichtigungen *(fertig)*

- Fällige Follow-ups und Aufgaben berechnet das Backend aus den echten Daten (z. B. „3 Tage keine Antwort“).
- Der Tagesstapel zeigt nur das, was heute wirklich ansteht.
- Echte Slack-Benachrichtigung bei jeder neuen Antwort (#48, live mit `SLACK_WEBHOOK_URL`). Ohne automatischen
  Abgleich (`LINKEDIN_ACTIONS=on`) kommen Antworten nur durch Eintragen ins Cockpit – dann meldet Slack das Eintragen.
- *Zusätzlich gebaut:* automatische Lead-Suche nach Zeitplan je Gründer (Einstellungen → „Automatische Suche“).

## Phase 6 · Dashboard und Übergabe ans CRM *(fertig – Close per API, #47)*

- **Dashboard aus echten Zahlen:** Anfragen, Annahmequote, Antworten, Termine – je Gründer und Zeitraum.
- **Übergabe heißer Leads an das CRM:** In der Demo heißt das „Close-Export“. **Entschieden (06.10.): Close per API** –
  Lead mit einem Klick in Close anlegen, API-Schlüssel unter Einstellungen. Nur dokumentierte Close-Endpunkte.

## Durchgehend: Betrieb, Sicherheit, Datenschutz

- **Sicherungen:** Datenbank nächtlich, zusätzlich Hostinger-Backups oder Snapshots. Wiederherstellen einmal testen.
- **Überwachung:** Health-Checks, Benachrichtigung bei Ausfall, Fehlerprotokoll.
- **Geheimnisse:**
  - Schlüssel nur in der Server-`.env`; regelmäßig und nach jeder Offenlegung erneuern.
  - Der Meta-Token läuft alle 60 Tage ab; dafür eine Erinnerung einrichten.
- **Datenschutz (DSGVO):**
  - Es werden personenbezogene Daten von Leads verarbeitet.
  - Auftragsverarbeitungsverträge mit Hostinger, Unipile und Anthropic.
  - Löschkonzept (z. B. „kein Interesse“ → nach X Monaten löschen), nur nötige Daten speichern.
- **Testumgebung:** Der Proxmox-Server läuft im Mock-Modus als Test- und Vorführumgebung. Echt sucht und sendet nur
  `crm.ylvalabs.de`.

## Offene Entscheidungen (Nutzer)

- ~~Datenbank: SQLite oder Postgres~~ → SQLite.
- Tageslimits für Vernetzungsanfragen und Nachrichten je Account (erst nötig, wenn Phase 3 eingeschaltet wird).
- ~~Wird Close als CRM genutzt?~~ → ja, per API (06.10.).
- ~~Löschkonzept~~ → „Verloren“ nach 30 Tagen löschen (`LOST_DELETE_DAYS`, #48).
- Wann wird Johannes' LinkedIn-Account bei Unipile verbunden?
