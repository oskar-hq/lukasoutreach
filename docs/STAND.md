# Stand und Übergabe

Für neue Chats und Agents: Hier steht, wo das Projekt steht, was offen ist und was schon entschieden wurde.
Stand: 08.10.2026. Bei größeren Änderungen bitte aktualisieren (gemeinsame Datei, knapp halten).

## Wo läuft was

| | |
| --- | --- |
| Repo | `oskar-hq/lukasoutreach`, Integrations-Branch `main` (Standard-Branch). Kopie von `oskar-hq/Scraper` @ `72be0b0` (03.11.2026). Arbeit auf eigenen Branches plus PR, siehe `CLAUDE.md` |
| Zweck | Instanz für Lukas (CEO): VCs + Startups im DACH-Raum, Events als Signal, Firmen-Kette – siehe `docs/LUKAS.md` |
| Produktivserver | Hostinger-VPS `187.126.25.54`, Hostname `srv2125119` → **https://lukas.ylvalabs.de** |
| Installation dort | `~/outreach-cockpit`, Ersteinrichtung `bash deploy/install.sh lukas.ylvalabs.de`, danach Updates unter Einstellungen → System |
| Schutz | Caddy mit HTTPS (Let's Encrypt) + Anmeldung im Cockpit. Firewall ufw: nur 22, 80, 443 |
| DNS | Cloudflare (Nameserver von `ylvalabs.de`, Domain selbst bei Strato registriert – DNS-Einträge bei Strato wirken nicht): A-Eintrag `lukas` → `187.126.25.54`, Proxy aus (nur DNS), kein AAAA |
| CI | GitHub Actions bei jedem PR gegen `main` |

Geheimnisse liegen **nur** in `~/outreach-cockpit/.env` auf dem Server (Rechte 600), nie im Repo oder Chat.

Der Rest dieser Datei beschreibt den übernommenen Stand des Bestands-Projekts (Scraper) und gilt technisch weiter;
Zielgruppe, Vorlagen und Signal werden nach `docs/LUKAS.md` umgebaut.

## Was ist echt

**Alles (Entscheidung 07.10.):** keine Demo-Hinweise, kein „Demo zurücksetzen“, kein Modus-Schalter, kein simulierter
Slack-Ping. Migration 16 löscht beim Update einmalig alle erfundenen Daten (Demo-Leads, Leads aus simulierten Läufen
samt Nachrichten und Verlauf, simulierte LinkedIn-Aktionen, Modus-Wert in den Einstellungen). Die Simulation
(`LEAD_SEARCH_MODE=mock`, 30 erfundene Test-Leads) gibt es nur noch über die Umgebung für automatische Tests und die
lokale Entwicklung; der Standard des Backends ist der echte Betrieb.

| Bereich | Stand |
| --- | --- |
| Login, Rollen, Konten | **echt:** eigene Konten mit Pflicht-Sitzung, Einladungslinks. Rollen (#36–#38): **Admin** (sieht alles, verwaltet Konten, sendet nicht), **Gründer**, **Mitarbeiter** (arbeitet für einen oder mehrere Gründer, keine Einstellungen). Seite „Konten“ im Cockpit, Server-Befehl `accountsCli.js` nur noch für Notfälle. **Neu (08.10.):** erstes Konto im Browser (wird Gründer, Einrichtungs-Assistent für alle Schlüssel), Selbst-Registrierung mit Freigabe unter Konten, Einarbeitung für neue Konten |
| Lead-Suche | **echt:** Unipile-Suche (je Stichwort × Position, max. 8 Suchen), Dubletten-Abgleich mit Datenbank, Tracking-Liste und offenen Anfragen, Profil + Firma, KI-Einstufung (Anthropic), Scoring v1, Meta-Ads-Filter (Code fertig, Token fehlt) |
| Automatische Lead-Suche | **echt** (#39–#43): Zeitplan je Gründer unter Einstellungen → „Automatische Suche“, läuft im Hintergrund, neue Leads landen im Tagesstapel. Nach dem Update **aus**, bis ein Gründer ihn einschaltet. Kostet je Lauf Unipile- und Anthropic-Kontingent |
| Datenbank | **echt:** SQLite `cockpit.db` im Docker-Volume (Konten, Sitzungen, Leads + Verlauf, Tracking-Liste, Vorlagen, Einstellungen, Zeitplan), tägliche Sicherung |
| Tagesstapel, Leads-Ansicht, Lead-Panel | **echt** (#27–#29, #34/#35, #41): Aufgaben aus `/api/tasks`, Entscheidungen gespeichert (Rückgängig-Fenster, sicher gegen doppelte Buchung), „für heute überspringen“, „heute“ nach deutscher Zeit, Board + Tabelle |
| Vorlagen und KI-Vorschläge | **echt** (#23, #24, #33): Greenfield/Reactivation-Vorlagen, unter Einstellungen → Vorlagen bearbeitbar; je Kategorie mindestens eine, bis zu 26 (A–Z) selbst anlegen und löschen (09.10.); Knopf „Vorschlag“ schreibt per KI (Anthropic) |
| Dashboard | **echt** (#19, #32): aus `GET /api/dashboard`, je Gründer und Zeitraum |
| Firmendaten (Treg) | **Code echt** (#20/#21, #28): „Firmendaten holen“ im Lead-Panel. Live, sobald `TREG_TOKEN` gesetzt ist (Entscheidung 05.10.: Treg statt Clay, Clay bleibt als Alternative im Code) |
| Einstellungen | **echt** (#22, #17): Schlüssel, Grenzen und Regeln in der Oberfläche ändern, Geheimnisse verschlüsselt, Probe-Änderung, Notfallmodus, Verlauf, Verbindungstest (auch Treg, Close, Slack). LinkedIn-Accounts zuordnen und Test-LinkedIn-Account mit Test-Nachricht und Test-Vernetzungsanfrage in der Software (07.10.) |
| System (ohne Shell) | **neu** (06.10.): Einstellungen → System: Updates per Knopf oder nachts (Update-Dienst `deploy/updater`, einmal mit dem nächsten Update von Hand einrichten), Sicherungen anlegen, herunterladen, wiederherstellen. Gründer verwalten alle Konten – Server-Befehle nur noch bei der Ersteinrichtung oder im Notfall |
| Vernetzen, Nachrichten | **Gesendet wird von Hand** (Entscheidung 05.10.): Text kopieren, auf LinkedIn senden, im Cockpit eintragen. Der Code für echtes Senden über Unipile (#18, #31) ist fertig, bleibt aber aus (`LINKEDIN_ACTIONS=off`) |
| Antworten, Einschätzung, Slack | Antwort-Karte und Lead-Panel zeigen die Einschätzung der Antwort und eine Zusammenfassung des Verlaufs (#46). Jede neue Antwort geht live an Slack, sobald `SLACK_WEBHOOK_URL` gesetzt ist (#48). Ohne `LINKEDIN_ACTIONS=on` werden Annahmen und Antworten aber weiter von Hand eingetragen |
| Übergabe an Close | **echt** (#47 + Oberfläche): „An Close übergeben“ auf der Antwort-Karte und im Lead-Panel legt den Lead per API in Close an (mit Notiz), Link nach Close im Lead-Panel. Ohne `CLOSE_API_KEY`: Angaben kopieren und nur eintragen |
| Löschen (Datenschutz) | **echt** (#48): Leads „Verloren“ werden nach `LOST_DELETE_DAYS` (Standard 30) gelöscht; ein Fingerabdruck verhindert erneutes Anschreiben |

Weiter geht es nach `docs/ROADMAP.md`. **Alle Phasen sind gebaut** (Phase 3 bewusst ausgeschaltet, siehe oben). Offen sind
vor allem Schritte des Nutzers (unten) – Schlüssel eintragen, Verträge, Limits.

## Offene Punkte (Nutzer)

Stand 04.10. laut Nutzer – alles andere (Schlüssel erneuert, Server-Updates/fail2ban, Proxmox, Tracking-Liste,
Verbindungstest, Konten und eigene Passwörter) ist erledigt.

- [ ] **Vor dem nächsten Update (wichtig):** Heim-/Proxmox-Installationen ohne Caddy `WEB_BIND=8080` in die `.env`
      eintragen – sonst ist das Cockpit nach dem Update nur noch unter `127.0.0.1:8080` erreichbar (neuer Standard).
      Nach dem Update unter Einstellungen → Sicherungen → „Schlüssel für Geheimnisse anzeigen“ den
      Schlüssel in den Passwort-Manager legen.
- [ ] **Sicherheit (08.10.):** auf dem Server prüfen, dass das Frontend nur intern lauscht (`docker ps` →
      `127.0.0.1:8080`, sonst `WEB_BIND=127.0.0.1:8080` in die `.env` – Docker umgeht ufw), `TRUST_PROXY_HOPS=1` (ein altes `2` wirkt wie `1`), SSH nur
      mit Schlüssel; auf GitHub Branch-Schutz für `main` einschalten (README → Sicherheit).
- [ ] Optional ein Admin-Konto einladen (Konto-Menü → Konten → Konto einladen) und unter Einstellungen → „Automatische
      Suche“ den Zeitplan festlegen und einschalten.
- [ ] Meta: sobald die Identitätsbestätigung durch ist, Token erzeugen und eintragen (README → Meta-Ads-Filter, bzw.
      künftig in der Software unter Einstellungen).
- [ ] Hostinger: automatische Backups im hPanel einschalten, falls noch nicht geschehen.
- [ ] Anthropic: Ausgabenlimit auf console.anthropic.com setzen, damit die KI-Kosten nicht ausufern.
- [ ] Datenschutz: Auftragsverarbeitungsverträge mit Hostinger, Unipile, Anthropic, Treg und Slack abschließen
      (nur als Person möglich).
- [ ] Server **ein letztes Mal von Hand** aktualisieren (richtet den Update-Dienst ein): `cd ~/outreach-cockpit && git pull && docker compose --profile public up -d --build` – danach Updates unter Einstellungen → System.
- [ ] Nach dem Update (07.10.) prüfen: In der `.env` auf dem Server darf `LEAD_SEARCH_MODE` nicht auf `mock` stehen
      (am besten die Zeile löschen – Standard ist jetzt echt). Danach sind Leads, Aufgaben und Dashboard ohne Demo-Daten.
- [ ] Close: API-Schlüssel von den Kunden besorgen, unter Einstellungen → CRM und Slack eintragen, dann eine
      Test-Übergabe.
- [ ] Slack: Incoming Webhook anlegen und eintragen (README → Slack bei neuer Antwort).
- [ ] Treg statt Clay (05.10.): Konto auf treg.to anlegen (zahlen Nick und Johannes), Guthaben aufladen, Token als
      `TREG_TOKEN` in die `.env`, dann `enrichCli.js test <domain>` (README → Firmendaten anreichern).
- [ ] *Erst wenn gewünscht (heute wird von Hand gesendet):* LinkedIn-Aktionen einschalten: Account-IDs mit `linkedinCli.js konten`, in die `.env`
      `UNIPILE_ACCOUNT_NICK`, `LINKEDIN_ACTIONS=on`, dann **eine** Test-Nachricht an den Test-LinkedIn-Account (README → Echte
      LinkedIn-Aktionen). Für Johannes: seinen LinkedIn-Account zusätzlich bei Unipile verbinden.

## Offene technische Fragen

- **LinkedIn-Suche:** Mit ODER-Verknüpfung kam im echten Test nur 1 Treffer. Umgestellt auf Einzelsuchen je
  Stichwort × Position (Commit `34c5249`), aber noch nicht im echten Lauf bestätigt. Alternative: Sales Navigator
  (`UNIPILE_SEARCH_API=sales_navigator`), wenn die Lizenz da ist.
- **Meta-Abgleich:** Nach Firmenname plus Website-Domain, Fremdtreffer werden aussortiert. Nicht gegen die echte
  Meta-API getestet, weil die Entwicklungsumgebung sie nicht erreicht.
- **Echtes Senden über Unipile:** gebaut (`POST /api/v1/users/invite`, Nachrichten, Abgleich), aber nie live
  getestet. Vor dem Einschalten: Test-LinkedIn-Account eintragen und eine Test-Nachricht schicken (README → Echte LinkedIn-Aktionen).

## Bisherige Entscheidungen

- **Echter Betrieb (07.10.):** Alles, was an die Demo erinnert, ist weg – Hinweise, Modus-Schalter, „Demo
  zurücksetzen“, simulierter Slack-Ping und alle erfundenen Daten in der Datenbank.
- **CRM (06.10.):** Die Kunden nutzen Close – heiße Leads gehen per API nach Close. Slack-Benachrichtigung bei
  neuer Antwort ja. Leads mit „kein Interesse“ werden nach 1 Monat gelöscht.
- **Zielgruppe (neu seit 27.10., Kundengespräch):** Geschäftsführer/Inhaber **mittelgroßer** Kapitalanlage-Vertriebe und
  **Finanzdienstleister (FDL)** in Deutschland, 2./3. Grad – keine Einzelberater, keine Konzerne (DVAG & Co., feste Liste
  `server/src/qualify/targetGroup.ts`). Bauträger nur mit eigenem Vertrieb (Markt zu klein, verkaufen meist über
  Kapitalanlage-Vertriebe). Meta-Ads-Signal unverändert. Vorlagen segmentiert (Kapitalanlage / Finanzdienstleister),
  Aufwärmen mischt beide Gruppen. Bis 27.10.: Kapitalanlage-Vertriebe und Bauträger/Projektentwickler.
- **Pain-Point:** Am besten Firmen **ohne aktive Meta-Ads** (nie probiert oder beendet). Seit 07.10. werden Firmen mit
  aktiven Ads **nicht** mehr aussortiert, sondern markiert in den Tagesstapel gelegt – jemand prüft die Kampagnen von
  Hand (dort wird oft viel Geld verbrannt). Der Pitch lautet „wir machen das besser bei euch“.
- **Zielgruppen-Mix (27.10., vorher 70/30 Kapitalanlage/Bauträger seit 07.10.):** steckt in den automatischen
  Suchläufen – Anteil Kapitalanlage/Finanzdienstleister per Regler je Gründer (Standard 50 %), Zählung am 27.10. neu.
- **Firmen-Dubletten (27.10.):** je Firma ein Lead – weitere Kontakte derselben Firma (auch nach Absage/Löschung) fliegen
  in der Lead-Suche raus.
- **Arbeitsfluss (07.10.):** Antworten direkt in der Antwort-Karte schreiben, Chats-Reiter (Messenger-Ansicht), eigene
  Spalten im Leads-Board mit Ziehen und Ablegen, Einstellungen mit Übersicht „Auf einen Blick“.
- **Aussortier-Grund (07.10.):** „Falsche Branche“ statt der erkannten Kategorie („Makler“, „Sonstige“), Erklärung beim
  Aufklappen.
- **Follow-ups (07.10.):** nach 2 Tagen ohne Antwort im Tagesstapel, mit Hinweis auf der Startseite (Namen, Klick öffnet
  die Follow-ups). Keine Slack-Nachricht dafür (Entscheidung des Nutzers). Gesendet wird weiter von Hand.
- **Sicherungen (07.10.):** täglich automatisch aus der Software, von Hand jederzeit; jede wird nach 7 Tagen gelöscht.
- **Lead-Suche nach Kunden-Feedback (11.10.):** Bis zu 400 Treffer pro Lauf (`SEARCH_HITS_PER_RUN`), alle
  Stichwort×Position-Kombinationen, danach **KI-Vorprüfung** anhand der Headline (klar Unpassendes ohne Profilbesuch
  raus), erst dann Profil lesen und streng einstufen. „Angereichert“ heißt jetzt „Profil gelesen“ (nur LinkedIn, kein
  Treg/Clay). Profilbesuche pro Lauf zunächst 25, am selben Tag auf Wunsch des Nutzers auf 1000 (Läufe/Tag 100) angehoben; der
  Such-Account ist unter Einstellungen → LinkedIn (Unipile) per Klick wählbar. Ursache der 0 Treffer: Stichwörter sucht LinkedIn im ganzen Profil (Finanzberater).
- **Feste Unipile-Limits, mehrere Accounts (17.10.):** Nach der Sperre eines Accounts von Nick kommen zwei weitere
  LinkedIn-Accounts dazu. Gescraped (Suche + Profile) wird reihum über **alle** Unipile-Accounts, je Account und Tag fest
  höchstens 100 Profilabrufe und 1.000 Suchtreffer (Sales Navigator 2.500); Vernetzen und Nachrichten nur über Nick und
  Johannes (Anfragen ≤ 80/Tag, ≤ 200/7 Tage, Nachrichten ≤ 100). Die Gründer-Accounts scrapen erst, wenn die beiden
  Scraping-Accounts voll sind, und nur mit halbem Limit. Nicks Account ist gesperrt und bei Unipile getrennt – die Suche
  läuft ohne ihn weiter (Doppelte bewusst in Kauf genommen), nach dem Neuverbinden ist er von selbst wieder dabei.
  Details: README → „Mehrere LinkedIn-Accounts“.
- **LinkedIn-Schutz:**
  - Profile pro Lauf bis 1000 und bis 100 automatische Läufe am Tag (Entscheidung des Nutzers 11.10., vorher 25 bzw. 10 –
    Risiko für den Account trägt der Nutzer), Pausen 3–8 s, Profilbesuche ohne Benachrichtigung;
  - immer nur ein Lauf gleichzeitig;
  - Abbruch bei Limit- und Zugangsfehlern;
  - keine echten Aktionen ohne ausdrücklichen Auftrag.
- **Nur dokumentierte Endpunkte** von Unipile, Anthropic und Meta. Secrets nie in Code, Logs oder Fehlermeldungen.
- **Zwei Agents:** Frontend und Backend parallel mit getrennten Bereichen. Der Vertrag liegt in `shared/`, die
  Abstimmung in den Handoff-Dateien unter `docs/agents/`.
- **Senden von Hand** (05.10.): keine automatischen LinkedIn-Aktionen; das Cockpit schlägt Texte vor, gesendet wird
  auf LinkedIn, eingetragen im Cockpit.
- **Treg statt Clay** für Firmendaten (05.10.).
- **Rollen** (06.10.): Admin ohne Gründer, Gründer, Mitarbeiter, die für einen Gründer arbeiten. Mitarbeiter dürfen
  Leads suchen, Nachrichten im Namen ihres Gründers rausschicken und eintragen, aber keine Schlüssel, Einstellungen, Vorlagen oder Konten ändern.
- **Automatische Suche** (06.10.): Gründer legen den Zeitplan fest, Mitarbeiter dürfen Suchen starten.
- **CRM** (06.10.): Übergabe heißer Leads später direkt per **Close-API**.

## Zusammenarbeit mit dem Nutzer

- Deutsch, „du“, Schritt für Schritt. Server-Befehle einzeln geben, mit Hinweis, was als Ausgabe erwartet wird.
- Der Nutzer arbeitet viel mit Screenshots. Sind darin Schlüssel oder Passwörter zu sehen: nie wiederholen, auf
  Erneuerung hinweisen.
- Gemergt wird nur auf Ansage des Nutzers oder durch ihn selbst auf GitHub.
