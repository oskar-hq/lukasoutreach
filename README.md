# Outreach Cockpit – Instanz Lukas

> **Diese Instanz:** eigene Kopie für Lukas (CEO), läuft unter **https://lukas.ylvalabs.de** auf einem eigenen
> Hostinger-VPS, parallel zur bisherigen Installation (`oskar-hq/Scraper`, crm.ylvalabs.de). Ziel und Umbauplan:
> [`docs/LUKAS.md`](docs/LUKAS.md).
>
> **Neuer Server in einem Schritt** (als root, fragt nach GitHub-Benutzer + Token mit Lesezugriff auf dieses Repo):
>
> ```bash
> git config --global credential.helper store && git clone https://github.com/oskar-hq/lukasoutreach.git ~/outreach-cockpit && cd ~/outreach-cockpit && bash deploy/install.sh lukas.ylvalabs.de
> ```
>
> Das Skript installiert Docker, schaltet die Firewall ein (22/80/443), legt die `.env` an, startet alles mit HTTPS
> und gibt den Einrichtungs-Link für das erste Konto aus. Alles Weitere in der Oberfläche.

LinkedIn-Outreach-Cockpit. Tagesstapel, Leads und Verlauf kommen aus der Datenbank des Backends (`/api/tasks`,
`/api/leads`) – Entscheidungen bleiben nach Neuladen und Neustart erhalten.

Dazu kommt das Modul **Lead-Suche** mit einem kleinen Backend (`server/`): Es findet neue Leads über Unipile, filtert
Dubletten, reichert Profile an, lässt eine KI (Anthropic) qualifizieren und legt die passenden Leads in den Tagesstapel.

**Echter Betrieb (seit 07.10.):** Die Software kennt keinen Demo- oder Simulationsmodus mehr. Mit dem Update vom 07.10.
löscht das Backend einmalig alle erfundenen Daten aus der Demo-Zeit (Demo-Leads, Leads aus simulierten Läufen samt
Nachrichten und Verlauf, simulierte LinkedIn-Aktionen, den Modus-Schalter in den Einstellungen). Echte Leads aus der
Tracking-Liste und aus Live-Läufen bleiben. Eine Simulation ohne Netz gibt es nur noch für automatische Tests und die
lokale Entwicklung (`LEAD_SEARCH_MODE=mock` über die Umgebung).

Aufbau und Datenstruktur: siehe [`PLAN.md`](PLAN.md). Design-Regeln für dieses und künftige Projekte: [`DESIGN.md`](DESIGN.md).

## Starten mit Docker (z. B. auf dem Proxmox-Server)

Voraussetzung: Docker mit Compose-Plugin (in einem Proxmox-LXC-Container muss dafür
„Nesting“ aktiviert sein, in einer VM ist nichts weiter nötig).

```bash
git clone -b main https://github.com/oskar-hq/lukasoutreach.git outreach-cockpit
cd outreach-cockpit
cp .env.example .env          # einmalig, danach Schlüssel eintragen (oder später unter Einstellungen)
echo "WEB_BIND=8080" >> .env  # Heimnetz ohne Caddy: im ganzen Netz erreichbar (Standard: nur 127.0.0.1)
docker compose up -d --build
```

Das Repo ist privat: Git fragt beim Klonen nach Benutzername und Passwort – als Passwort einen
GitHub-Token mit Lesezugriff auf `oskar-hq/lukasoutreach` eingeben (siehe unten).

Danach läuft das Cockpit unter **http://<server-ip>:8080**. Ohne `WEB_BIND=8080` in der `.env` lauscht das Frontend seit
der Sicherheitsprüfung (08.10.) nur noch auf `127.0.0.1:8080` – richtig für einen öffentlichen Server mit Caddy, im
Heimnetz (z. B. Proxmox) muss `WEB_BIND=8080` gesetzt sein. Das erste Konto legst du über den Einrichtungs-Link an
(siehe „Anmeldung (Konten)“): `docker compose logs backend | grep Einrichtung`.
Es starten zwei Container: `outreach-cockpit-demo` (nginx, Frontend) und `outreach-cockpit-backend` (API).
Das Backend ist nicht von außen erreichbar; nginx leitet `/api/` intern weiter.

| Aufgabe | Befehl |
| --- | --- |
| Status / Logs | `docker compose ps` · `docker compose logs -f backend` |
| Neue Version einspielen | **Einstellungen → Software-Update** (ein Klick oder nachts automatisch) – einmal einrichten, siehe „Updates“ |
| `.env` geändert (z. B. Modus) | `docker compose up -d` (Backend wird neu erstellt) |
| Stoppen | `docker compose down` |
| Anderer Port (z. B. 80) | in der `.env` `WEB_BIND=80` (nur lokal: `WEB_BIND=127.0.0.1:80`) |

Die Container starten nach einem Server-Neustart automatisch wieder (`restart: unless-stopped`).

### Öffentlicher Server (VPS, z. B. Hostinger)

Ein VPS hängt direkt im Internet. Ohne Schutz könnte jeder das Cockpit öffnen und mit dem verbundenen LinkedIn-Account
suchen. Deshalb läuft dort **Caddy** davor (HTTPS mit automatischem Zertifikat), und das Cockpit verlangt eine
**Anmeldung mit eigenem Konto** (siehe „Anmeldung (Konten)“). Das Frontend ist nur noch intern erreichbar.

```bash
# 1. Docker installieren (falls noch nicht da) und Firewall: nur SSH, HTTP, HTTPS
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw --force enable

# 2. Code holen (Token als Passwort, siehe „GitHub-Token“ unten)
git config --global credential.helper store
git clone -b main https://github.com/oskar-hq/lukasoutreach.git outreach-cockpit
cd outreach-cockpit
cp .env.example .env

# 3. .env ausfüllen (siehe unten), dann starten
nano .env
docker compose --profile public up -d --build

# 4. Erstes Konto: Einrichtungs-Link aus dem Protokoll öffnen (nur er legt das erste Gründer-Konto an)
docker compose logs backend | grep Einrichtung
```

In der `.env` für den öffentlichen Server zusätzlich (Abschnitt „Öffentlicher Server“ in `.env.example`):

| Variable | Wert |
| --- | --- |
| `WEB_BIND` | `127.0.0.1:8080` (seit 08.10. der Standard, darf auch fehlen) – Frontend nur intern, von außen nur über Caddy. **Nie `8080` allein:** Docker umgeht die Firewall (ufw), dann wäre das Cockpit unter `http://<Server-IP>:8080` ohne HTTPS erreichbar |
| `SITE_ADDRESS` | Domain, deren DNS-A-Eintrag auf die Server-IP zeigt, z. B. `cockpit.deine-domain.de` → HTTPS automatisch. Ohne Domain `:80` (dann nur HTTP – Passwörter gehen unverschlüsselt, und es braucht `AUTH_COOKIE_SECURE=false`; nur übergangsweise) |
| `TRUST_PROXY_HOPS` | `1` (Standard). Ein vorhandenes `2` stört nicht – es wirkt wie `1`, siehe „Sicherheit“ |

Updates: in der Oberfläche unter **Einstellungen → Software-Update** (siehe „Updates“). Von Hand immer mit Profil:
`docker compose --profile public up -d --build`, sonst wird Caddy nicht mit gestartet. Die Tracking-Liste muss auf
jedem Server einmal hochgeladen werden.

### Sicherheit

Eingebaut: Passwörter mit scrypt, Sitzungs-Cookie `HttpOnly`/`Secure`/`SameSite=Lax`, Begrenzung der Fehlversuche,
Schutz gegen fremde Formulare, Rechte je Rolle im Backend, Geheimnisse verschlüsselt (Schlüssel nie in Sicherungen),
Passwort-Abfrage vor Herunterladen/Wiederherstellen (Updates seit 23.10. mit einem Klick ohne Passwort). nginx setzt Sicherheits-Header (CSP nur eigene Skripte,
keine Einbettung in fremde Seiten, HSTS); API-Antworten landen nie im Browser-Cache, Fehler zeigen keine internen
Details, Protokolle enthalten keine Suchbegriffe und sind je Dienst auf 3 × 10 MB begrenzt.

Nach der Sicherheitsprüfung vom 08.10. zusätzlich:

- **Frontend-Port** standardmäßig nur `127.0.0.1:8080` (`WEB_BIND`), Heimnetz ohne Caddy: `WEB_BIND=8080`.
- **Echte Client-IP für die Sperre:** nginx übernimmt `X-Forwarded-For` nur von Proxys aus privaten Netzen (Caddy im
  Docker-Netz; `set_real_ip_from` in `nginx.conf`) und gibt dem Backend genau eine Adresse weiter. Das Backend vertraut
  nur nginx – `TRUST_PROXY_HOPS` 1 und 2 wirken gleich (2 aus älteren `.env`-Dateien bleibt gültig), 0 = keinem
  Proxy. Wer den Port direkt erreicht, kann so keine fremde IP vortäuschen. Grenze: Im Heimnetz ohne Caddy könnte ein
  Gerät im selben privaten Netz eine Adresse vortäuschen.
- **Erstes Konto nur mit Einrichtungs-Link** (`/registrieren#setup=…`, Schlüssel in `DATA_DIR/setup-token` bzw.
  `SETUP_TOKEN`) – sonst könnte ein Fremder, der die frische Installation zuerst öffnet, Gründer werden.
- **Gründer-Konten:** je Gründer (`nick`, `johannes`) höchstens eines; nur Gründer legen Gründer-Konten an oder geben
  sie frei (Admins: Admins und Mitarbeiter). Jede Einladung, jeder Passwort-Link, jede Freigabe und jedes Entfernen
  eines Kontos erscheint bei **allen Gründern** an der Glocke (und in Slack, falls eingerichtet) – mit dem Namen,
  wer es war. Ein Passwort-Link für den anderen Gründer bleibt möglich (Notfall), ist aber nie unbemerkt.
- **Links nur http(s):** Profil-, Website- und Werbebibliothek-Adressen nimmt das Backend nur mit `http(s)://` oder
  ohne Schema an; die Oberfläche setzt Links nur für http(s).
- **Mitarbeiter** übergeben Leads nicht an fremde Gründer und ändern keine Board-Spalten.
- **Registrieren:** Jeder Versuch zählt in der Sperre (5 pro Stunde und IP), bevor sich zeigt, ob ein Name vergeben ist.
- **Große Uploads** (20 MB) nur für die Tracking-Liste, sonst 1 MB je Anfrage.

Nach der Sicherheitsprüfung vom 09.10. zusätzlich:

- **Sperre auch bei gleichzeitigen Anfragen:** Jeder Login- und Passwort-Versuch zählt, bevor das Passwort geprüft
  wird – 30 parallele Fehlversuche bringen nicht mehr als 10 Prüfungen.
- **Wiederherstellen ändert keinen Zugang:** Konten, Passwörter, Rollen und offene Registrierungen bleiben auf dem
  jetzigen Stand, alle Sitzungen und Einladungslinks sind danach ungültig (alle melden sich neu an), Meldungen über
  Konten bleiben. Alle Gründer bekommen „Sicherung wiederhergestellt von …“ (Glocke + Slack nach dem Neustart).
- **Schlüssel anzeigen und Sicherung herunterladen** melden sich ebenfalls bei allen Gründern (Glocke + Slack), mit
  Namen. Ungelesene Meldungen über Konten fallen nie aus der Liste der Glocke.
- **`SETUP_TOKEN`** braucht mindestens 24 Zeichen. Ein kürzerer Wert wird ignoriert (Warnung im Protokoll); ohne Konto
  gilt dann der Zufallsschlüssel aus dem Datenordner.

Prüfliste für den öffentlichen Server:

- `docker ps` zeigt beim Frontend `127.0.0.1:8080->80/tcp` (nicht `0.0.0.0:8080`) – sonst `WEB_BIND` in der `.env`
  entfernen oder auf `127.0.0.1:8080` setzen.
- Unter Einstellungen steht bei „Proxys vor dem Backend“ „Der Server sieht dich gerade als …“: Das muss deine echte
  IP sein, nicht die eines Containers (`172.…`). Sonst teilen sich alle die Sperre nach Fehlversuchen.
- **IPv6:** Hat die Domain einen AAAA-Eintrag, kommen IPv6-Besucher über Dockers userland-proxy alle mit der
  Gateway-Adresse des Docker-Netzes an – dann teilen sie sich die Sperre nach Fehlversuchen (ein Fremder sperrt alle
  aus). Entweder keinen AAAA-Eintrag setzen (`dig AAAA crm.example.de` bleibt leer) oder IPv6 im Compose-Netz
  einschalten (`enable_ipv6: true`), damit die echte Adresse ankommt. Prüfen mit IPv6: „Der Server sieht dich gerade
  als …“ muss deine IPv6-Adresse zeigen.
- Konten → nur die erwarteten Gründer-, Admin- und Mitarbeiter-Konten; Meldungen „Neues Konto eingeladen“ /
  „Passwort-Link erzeugt“ an der Glocke, die du nicht kennst, sofort prüfen.
- SSH nur mit Schlüssel (`PasswordAuthentication no`), fail2ban an.
- GitHub: Branch-Schutz für `main` (nur per PR) – der Update-Dienst spielt jeden Stand dort ein.
- Heruntergeladene Sicherungen enthalten alle Leads unverschlüsselt: nur verschlüsselt ablegen, danach löschen.

### Updates

Neue Versionen spielt das Cockpit selbst ein: Gibt es eine neue Version, steht ganz oben in den **Einstellungen** der Knopf
**„Update“** – ein Klick, kein Passwort. **Einstellungen → Software-Update** zeigt dasselbe plus die installierte Version. Nachts automatisch: „Updates nachts automatisch
einspielen“ und die Uhrzeit (deutsche Zeit) in den Einstellungen – dann nur, wenn es etwas Neues gibt, und nie während
einer Lead-Suche (dann eine Stunde später). Während eines Updates ist das Cockpit 1–5 Minuten nicht erreichbar und lädt
danach von selbst neu.

**Einmal einrichten** – das nächste Update ein letztes Mal von Hand, im Projektordner. Vorher sichern (ein Update von Hand
sichert nicht von selbst): **Einstellungen → Sicherungen → „Jetzt sichern“** oder im Terminal:

```bash
cd outreach-cockpit
docker compose exec backend node dist/server/src/backupCli.js    # Sofort-Sicherung „manuell-…“ im Datenordner
git pull && docker compose --profile public up -d --build    # ohne Caddy: docker compose up -d --build
```

Das startet zusätzlich den Container `outreach-cockpit-updater` (Update-Dienst). Ab dann geht alles per Knopf.

So funktioniert er: Er holt die Änderungen des Branches, auf dem der Server steht (wie `git pull --ff-only`), und baut
Frontend, Backend und – falls es läuft – Caddy neu (`docker compose up -d --build`). Dafür hat er Zugriff auf Docker und
den Projektordner; er ist nur im internen Docker-Netz erreichbar (nur das Backend kommt an ihn heran) und nur mit einem
Schlüssel, den er beim ersten Start im Volume `updater-shared` anlegt. Für git nutzt er die Zugangsdaten des Servers
(`~/.git-credentials`, `~/.ssh`, `~/.gitconfig`, nur lesend) und arbeitet als Besitzer des Projektordners.

- `docker compose` immer **in einer Shell im Projektordner** starten: Die Compose-Datei bindet den Ordner über
  `${PWD}` unter demselben Pfad ein (sonst findet `docker compose` im Update-Dienst `.env` und `deploy/Caddyfile`
  nicht) und das Home-Verzeichnis über `${HOME}`. Beides setzt die Shell. **Nicht mit sudo starten** (den Benutzer
  in die Docker-Gruppe aufnehmen) oder in der `.env` `UPDATER_PROJECT_DIR` (Projektordner) und `UPDATER_GIT_HOME`
  (Home mit den git-Zugangsdaten) setzen. Findet der Dienst keine Zugangsdaten, steht genau das als Grund in der
  Oberfläche.
- Nach dem Update startet er das Frontend neu, falls nur das Backend neu erstellt wurde (nginx kennt sonst dessen alte
  Adresse nicht).
- Scheitert das Bauen (oder wird unterbrochen), bleibt „Update einspielen“ möglich, auch ohne neue Commits. Während
  einer Lead-Suche wird nicht aktualisiert.
- Ändert ein Update den Update-Dienst selbst, baut ein kurzer Hilfs-Container ihn danach neu.
- **Vor jedem Update** (Knopf und nachts) sichert das Backend die Datenbank als `vor-update-…` (es bleiben die letzten
  3, wie alle Sicherungen höchstens 7 Tage). Geht diese Sicherung nicht (z. B. Platte voll), startet das Update nicht
  und die Oberfläche bzw. die Neuigkeiten sagen warum. Zurück nach einem missglückten Update: diese Sicherung
  wiederherstellen.
- **Scheitert das nächtliche Update erst beim Bauen/Neustarten**, merkt das Backend es am Protokoll des Dienstes
  (`updater-state.json`) und meldet „Automatisches Update fehlgeschlagen“ in den Neuigkeiten und an Slack – einmal je
  Lauf. Ein späteres erfolgreiches Update räumt die Meldung weg.
- **Aufräumen:** Nach einem erfolgreichen Update löscht der Dienst verwaiste Docker-Abbilder (`docker image prune -f`)
  und Bau-Cache, der älter als 7 Tage ist (`docker builder prune -f --filter until=168h`). Geht das nicht, bleibt das
  Update trotzdem erfolgreich. Wirkt erst, nachdem der Update-Dienst selbst einmal mit dieser Version neu gebaut wurde
  (passiert beim Update von selbst).
- Lokale Änderungen im Projektordner auf dem Server verhindern das Update (`--ff-only`) – der Grund steht dann in der
  Oberfläche.
- Ohne eingerichteten Dienst zeigt die Oberfläche „Der Update-Dienst ist noch nicht eingerichtet …“. In den
  automatischen Tests (`LEAD_SEARCH_MODE=mock`) ohne Dienst sind Versionen und Update nur gespielt.

### Bestehende Installation (alte Demo ohne Lead-Suche) ersetzen

Die neue Version nutzt dieselben Container-Namen und denselben Port – die alte muss vorher gestoppt werden.
Ihr Ordner bleibt liegen und dient als Rückweg.

```bash
# Ordner der laufenden alten Version herausfinden
docker inspect outreach-cockpit-demo --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
cd <ausgegebener Ordner> && docker compose down && cd ~

# Neue Version holen und starten (Token als Passwort, wird gespeichert)
git config --global credential.helper store
git clone -b main https://github.com/oskar-hq/lukasoutreach.git outreach-cockpit-v2
cd outreach-cockpit-v2
cp .env.example .env
docker compose up -d --build
```

Zurück zur alten Version: im neuen Ordner `docker compose down`, im alten `docker compose up -d`.

**GitHub-Token:** github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens →
Generate new token. Resource owner `oskar-hq`, Repository access „Only select repositories“ → `lukasoutreach`,
Permissions → Repository permissions → Contents: „Read-only“. `credential.helper store` legt den Token im Klartext
in `~/.git-credentials` ab, damit `git pull` später nicht erneut fragt.

## Anmeldung (Konten)

Das Backend hat eigene Konten (Roadmap Phase 1). Gespeichert wird in der Datenbank `cockpit.db` im Docker-Volume
(SQLite, Sicherung per `VACUUM INTO`, siehe „Datenbank und Sicherung“). Passwörter nur als scrypt-Hash, Sitzungs-IDs nur als SHA-256.
Ohne Anmeldung ist die ganze API gesperrt (401). Das frühere
Browser-Passwortfenster (Caddy `basic_auth`) ist entfallen; alte `BASIC_AUTH_*`-Zeilen in der `.env` stören nicht.

**Erstes Konto und Registrierung (08.10.):** Nach der Installation den **Einrichtungs-Link** aus dem Protokoll des
Backends holen und im Browser öffnen:

```bash
docker compose logs backend | grep Einrichtung
# Einrichtung: Noch kein Konto. Öffne diesen Link, um das erste (Gründer-)Konto anzulegen: https://crm.example.de/registrieren#setup=…
```

Nur mit diesem Link steht dort „Gründer-Konto erstellen“ – ohne ihn erklärt die Seite, wo der Link steht. So wird kein
Fremder Gründer, der die frische Installation zufällig zuerst öffnet. Der Schlüssel liegt in `setup-token` im
Datenordner (Rechte 600), bleibt über Neustarts gleich und wird nach dem ersten Konto gelöscht; mit `SETUP_TOKEN` in
der `.env` gilt stattdessen dieser Wert. Ohne `PUBLIC_URL` steht im Protokoll nur `/registrieren#setup=…` – vorne die
Adresse des Cockpits ergänzen. Danach führt ein Einrichtungs-Assistent durch alle Schlüssel (Unipile, Anthropic, Treg,
Meta, Close, Slack) – mit Erklärung, wo der Schlüssel steht, und Verbindungstest; nur LinkedIn ist Pflicht. Danach
fragt er nach dem Tagesziel (wie viele qualifizierte Leads pro Tag, höchstens wie viele Suchläufe) und schaltet die
automatische Suche ein (werktags 07:00). Zum Schluss lässt sich die bisherige Outreach-Liste (Excel, wie die Tracking-Liste der Lead-Suche) hochladen – alle
LinkedIn-Profile darin landen in der Datenbank und werden bei jeder Suche als Dublette aussortiert.
Alle weiteren registrieren sich selbst (Link `https://<deine-domain>/registrieren` oder „Noch kein Konto?“ auf der
Anmeldeseite) und warten, bis ein Gründer oder Admin sie unter **Konten → Warten auf Freigabe** freigibt und die Rolle
wählt. Mitarbeiter können für **mehrere Gründer** arbeiten und wechseln dann oben im Konto-Menü, wessen Stapel sie
abarbeiten. Neue Gründer und Mitarbeiter bekommen beim ersten Anmelden eine kurze Einarbeitung. Schutz: höchstens
5 Registrierungen pro Stunde und IP, höchstens 20 warten gleichzeitig; Wartende sehen nichts außer der Warteseite.

**Rollen** (Vertrag `shared/auth.ts` → „Rollen und Rechte“):

| Rolle | Zuordnung | Darf |
| --- | --- | --- |
| Admin | kein Gründer | alles sehen und eintragen, Einstellungen/Vorlagen ändern, Konten verwalten (Admins und Mitarbeiter einladen, keine Gründer) – sendet **nicht** über LinkedIn |
| Gründer | `nick` oder `johannes` (je eines) | wie bisher; verwaltet Einstellungen und **alle** Konten wie ein Admin (lädt jede Rolle ein, als einziger auch Gründer) |
| Mitarbeiter | ein oder mehrere Gründer, für die er arbeitet | deren Tagesstapel abarbeiten und über deren LinkedIn-Account senden – keine Einstellungen, Vorlagen nur lesen, keine Konten |

Ereignisse zeigen, wer sie gebucht hat (z. B. „Anna für Nick“).

**Konten verwaltest du in der Software:** Konto-Menü oben rechts → **Konten** (Admins und Gründer). Dort neue Konten
einladen (der Link wird kopiert und an die Person geschickt), „Neuer Passwort-Link“ bei vergessenem Passwort und
Konten entfernen. Das letzte Admin- oder Gründer-Konto lässt sich nicht entfernen – so kommt immer jemand an die Konten.

Die folgenden Server-Befehle braucht es nur noch **im Notfall** (z. B. alle Passwörter vergessen) – das erste Konto
legst du im Browser an:

```bash
# Konto anlegen (Passwort wird verdeckt abgefragt, mind. 10 Zeichen)
# Zuordnung: nick | johannes (Gründer) · admin (Admin) · mit --mitarbeiter: Mitarbeiter dieses Gründers
docker compose exec backend node dist/server/src/accountsCli.js add nick nick "Nick"
docker compose exec backend node dist/server/src/accountsCli.js add johannes johannes "Johannes"
docker compose exec backend node dist/server/src/accountsCli.js add oskar admin "Oskar"
docker compose exec backend node dist/server/src/accountsCli.js add anna nick "Anna" --mitarbeiter
# Konten mit Rolle anzeigen · Passwort ändern · Konto entfernen (beendet jeweils alle Sitzungen des Kontos)
docker compose exec backend node dist/server/src/accountsCli.js list
docker compose exec backend node dist/server/src/accountsCli.js password nick
docker compose exec backend node dist/server/src/accountsCli.js remove nick
```

**Einladungslinks** (statt Passwort am Server): Nick oder Johannes richten ihr Konto über einen Link selbst ein.

```bash
# Neues Konto per Link (gilt 7 Tage, nur einmal) – Ausgabe ist nur der Link
docker compose exec backend node dist/server/src/accountsCli.js invite nick nick "Nick"
docker compose exec backend node dist/server/src/accountsCli.js invite anna nick "Anna" --mitarbeiter
# Passwort vergessen: Link für ein bestehendes Konto (gilt 24 Stunden, ersetzt das Passwort)
docker compose exec backend node dist/server/src/accountsCli.js invite nick --reset
# Offene Links widerrufen
docker compose exec backend node dist/server/src/accountsCli.js uninvite nick
```

Den Link nur direkt an die Person schicken (z. B. Signal), nicht öffentlich. Ein neuer Link, `add`, `password` und
`remove` machen offene Links desselben Namens ungültig. Voraussetzung: `PUBLIC_URL` in der `.env`.

| Variable | Wert |
| --- | --- |
| `PUBLIC_URL` | Adresse der Seite für Einladungslinks, z. B. `https://lukas.ylvalabs.de` (mit Secure-Cookie nur `https://`) |
| `AUTH_COOKIE_SECURE` | Standard `true`. **`false` nur ohne HTTPS** (Testserver im Heimnetz über http), sonst klappt dort keine Anmeldung |
| `TRUST_PROXY_HOPS` | Proxys vor dem Backend: `1` = nginx (Standard, auch mit Caddy – nginx prüft Caddys Adresse selbst). `2` aus älteren Einrichtungen wirkt wie `1`, `0` = keinem Proxy vertrauen |
| `SETUP_TOKEN` | Optional: fester Schlüssel für den Einrichtungs-Link des ersten Kontos, mindestens 24 Zeichen (kürzer: ignoriert, Warnung im Protokoll). Leer = Zufall in `DATA_DIR/setup-token`, Link im Protokoll (`grep Einrichtung`) |
| `AUTH_DEMO_ACCOUNTS` | Nur Entwicklung/E2E: Testkonten `nick`/`johannes` (Gründer), `admin` (Admin) und `mitarbeiter` („Anna“, Mitarbeiter von Nick) mit Passwort `demo`. Startet nur zusammen mit `AUTH_COOKIE_SECURE=false`, **nie auf einem öffentlichen Server** |

Nur in den automatischen Tests (`LEAD_SEARCH_MODE=mock`) legt das Backend bei leerer Datenbank 30 erfundene Test-Leads an.

Lokal mit `npm run dev:all` sind die Testkonten automatisch an. Konten lokal: `npm run accounts --prefix server -- list`.

## Tagesstapel

Was heute ansteht, berechnet das Backend aus den Leads (`GET /api/tasks`): Antworten, fällige Follow-ups,
Erstnachrichten und neue Leads (die besten nach Score, rund 15 % bewusst aus der mittleren Stufe), dazu
„braucht Aufmerksamkeit“ (Anfrage lange offen, alle Follow-ups ohne Antwort, Termin nicht übergeben).
Heute gesendete Vernetzungsanfragen zählen gegen das Tageslimit neuer Leads; frisch aus der Lead-Suche übergebene
Leads sind immer dabei. „Für heute überspringen“ nimmt einen Lead bis Mitternacht aus dem Stapel, eine neue Antwort holt ihn sofort zurück.
„Heute“ zählt nach deutscher Zeit (`LINKEDIN_TIMEZONE`, Standard `Europe/Berlin`).

**Wiedervorlage („Später“, 22.10.):** Jeder Lead lässt sich pausieren und an einem Tag wieder in die Aufgaben holen –
im Stapel mit „Später“ (W, Schnellwahl 2 Tage, 4 Tage, 1 Woche, 2 Wochen oder eigenes Datum, Z nimmt es zurück), auf der Startseite bei „alle Follow-ups
gesendet“ mit „In 2 Wochen wieder“ oder im Lead-Panel unter Daten → Follow-up (Datum frei, optional zusätzlich eine
Board-Spalte). Bis dahin fehlt der Lead in Aufgaben und „Braucht Aufmerksamkeit“; ab dem Tag (8 Uhr) steht er als
Follow-up wieder da – auch nach allen Follow-ups, ein verlorener Lead wird dafür wieder geöffnet und nicht nach
`LOST_DELETE_DAYS` gelöscht. Antwortet er vorher, ist der Plan erledigt und die Antwort steht sofort in den Aufgaben.

**Jede Antwort in die Aufgaben (22.10.):** Der LinkedIn-Abgleich holt auch Antworten von Leads in „Verloren“ und
„Übergeben“ – sie werden wieder geöffnet und stehen als Antwort in den Aufgaben und in den Chats. Einen ausgemachten
Termin trägst du per Knopf ein („Termin vereinbart“ auf der Antwort-Karte, im Chat oder im Lead-Panel) – keine KI.

**Meine / Alle (16.10.):** Auf der Startseite wählt ein Gründer, ob nur seine Aufgaben im Stapel stehen oder auch die
des anderen Gründers (die Wahl bleibt im Browser gespeichert). Aufgaben des anderen Gründers erledigst du in dessen
Namen: Text mit dessen Grußformel, Anfragen zählen auf dessen Tageslimit, im Verlauf steht „von Nick“ beim Eintrag für Johannes. Die
Karte zeigt „Für Johannes · über Johannes' LinkedIn“ – gesendet wird auf LinkedIn von Hand und im Cockpit eingetragen
(automatisches Senden geht weiter nur für die eigenen Leads).

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `FOLLOWUP_AFTER_DAYS` | `2` | Follow-up fällig nach so vielen Tagen ohne Antwort |
| `MAX_FOLLOW_UPS` | `3` | höchstens so viele Follow-ups, danach „braucht Aufmerksamkeit“ |
| `NEW_LEADS_PER_DAY` | `20` | Karten „Neuer Lead“ pro Gründer und Tag im Tagesstapel (LinkedIn-Tageslimit) – begrenzt nicht die automatische Suche |
| `INVITE_NOTE` | `on` | Notiz zur Vernetzungsanfrage anbieten; `off` blendet sie aus, Anfragen gehen ohne Notiz (Einstellungen → Tagesstapel) |
| `INVITE_STALE_DAYS` | `14` | Anfrage gilt danach als hängend |

## Nachrichten-Vorlagen und KI-Vorschläge

Gesendet wird **von Hand auf LinkedIn** – das Cockpit schlägt nur den Text vor (`shared/messages.ts`).

- **Vorlagen** passend zur Zielgruppe: G1/G2 für Firmen ohne Werbung auf Facebook/Instagram (Greenfield), R1/R2 für
  Firmen, die früher geschaltet und aufgehört haben (Reactivation), Follow-ups F1–F3 (je zwei Varianten) und eine Notiz
  zur Vernetzungsanfrage (N1). Die Texte stehen in `server/src/messages/defaults.ts` und lassen sich in der Software
  ändern (Platzhalter `{{vorname}}`, `{{firma}}`, `{{thema}}`, `{{grussformel}}`); „Zurücksetzen“ holt den Standard.
- **Vorschlag pro Lead:** Erstnachricht (Vorlage nach Lead-Typ), nächstes Follow-up (Stufe nach bisher gesendeten)
  oder Antwort auf die letzte Nachricht des Leads mit Einschätzung (interessiert, Frage, gerade nicht, kein Interesse).
  Live mit `ANTHROPIC_API_KEY` schreibt die KI den Text aus Vorlage, Lead-Daten und Verlauf (Modell `ANTHROPIC_MODEL`,
  höchstens 60 Vorschläge je Gründer und Stunde). Ohne Schlüssel oder wenn die KI ausfällt, kommt die ausgefüllte
  Vorlage mit Hinweis. Die KI erfindet keine Zahlen oder Kunden – was belegbar ist, ergänzt ihr selbst.
- **Gespräch am Lead:** Bei jeder neuen Antwort speichert das Backend eine Einschätzung (interessiert, Frage, gerade
  nicht, kein Interesse) und eine kurze Zusammenfassung des Verlaufs – sofort nach einfachen Regeln, live mit
  `ANTHROPIC_API_KEY` wenige Sekunden später von der KI.

## Einstellungen in der Software

Schlüssel, Grenzen und Regeln lassen sich im Cockpit unter **Einstellungen** (Zahnrad) ändern, ohne auf den Server zu
müssen. Jede Einstellung ist eine Variable der `.env`; es gilt: **in der Software gesetzt → `.env` → Standard**. Das gilt für
den Server **und** für alle Server-Befehle (`accountsCli`, `backupCli`, `liveCheck`, `enrichCli` …).

- **Geheimnisse** (API-Schlüssel, Token) liegen verschlüsselt (AES-256-GCM) in der Datenbank und werden nach dem Speichern
  nie wieder angezeigt (nur „gesetzt · …abcd“). Der Schlüssel dafür ist `SETTINGS_KEY` aus der `.env` (`openssl rand -hex 32`)
  oder – wenn der fehlt – die Datei `settings.key` im Datenordner (Rechte 600, wird beim ersten Geheimnis angelegt). **Sicherungen
  enthalten diesen Schlüssel nicht** – wer eine Sicherung zurückspielt, braucht auch `settings.key` bzw. `SETTINGS_KEY`, sonst
  müssen die Geheimnisse neu eingegeben werden. **Den Schlüssel deshalb getrennt im Passwort-Manager ablegen** – siehe
  „Datenbank und Sicherung → Schlüssel für Geheimnisse“.
- **Passwort:** Wer einen Schlüssel oder eine Adresse mit Schlüssel ändert, gibt sein Passwort noch einmal ein. Zehn
  Fehlversuche sperren für 15 Minuten.
- **Wirkt sofort:** Zugänge, Regeln und Sicherungszeit gelten ohne Neustart. Eine laufende Lead-Suche arbeitet mit
  ihren alten Werten zu Ende.
- **Auf Probe:** `AUTH_COOKIE_SECURE` und `TRUST_PROXY_HOPS` können einen aussperren. Sie gelten sofort, aber nur auf Probe
  (5 Minuten): Man bekommt eine neue Sitzung und muss in ihr „Behalten“ bestätigen. Sonst setzt das Backend von selbst
  zurück – auch nach einem Neustart.
- **Nur über die `.env`:** `DATA_DIR`, `PORT`, `HOST`, `AUTH_DEMO_ACCOUNTS`, `SETTINGS_SAFE_MODE`, `SETTINGS_KEY` (und
  `SITE_ADDRESS`/`WEB_BIND` für Docker/Caddy). Die setzt man einmal beim Einrichten des Servers – im Alltag nie.
- **Alles andere in der Software:** Schlüssel, LinkedIn-Accounts, Grenzen und Arbeitszeiten (Senden über
  LinkedIn), Close und Slack, Sicherungen und Updates, Konten (Konto-Menü → Konten).
- **Notweg, falls eine Einstellung den Zugang stört:**
  `docker compose exec backend node dist/server/src/settingsCli.js list` zeigt, was gesetzt ist (nur Namen),
  `… settingsCli.js reset <SCHLÜSSEL>` bzw. `reset --all` löscht Werte, danach `docker compose up -d backend`.
  Oder `SETTINGS_SAFE_MODE=true` in die `.env`: Das Backend ignoriert dann alle Werte aus der Software.
- **Verlauf:** Wer hat wann welchen Wert geändert (bei Geheimnissen ohne Wert).

## Firmendaten anreichern (Treg)

Seit 05.10. kommen die Firmendaten über **Treg** (treg.to) statt Clay: Das Backend fragt je Lead mit der
Website-Domain den Treg-Dienst `treg.companies.enrich` ab. Treg probiert bis zu 27 Datenanbieter nacheinander, billigste
zuerst, und nimmt den ersten Treffer – etwa 0,2 Cent je Firma, ohne Abo. Hinaus geht nur die Domain, keine Namen und
keine LinkedIn-Daten. Ohne Website wird nichts abgefragt.

**Was ankommt** (echte Tests am 05.10. mit exporo.de und zinsland.de): Mitarbeiterspanne, Branche, Standort,
LinkedIn-Link der Firma. **Tech-Stack (Meta-Pixel), Umsatz und weitere Social-Links** nur, wenn der Anbieter, der den
Treffer liefert, sie mitschickt – das ist nicht garantiert. Der Score nutzt, was da ist; Unbekanntes zählt nicht mit.

**Einrichten:**
1. Auf **treg.to** ein Konto anlegen (Startguthaben 1 $), Guthaben aufladen, Token im Dashboard erzeugen.
2. Token in der Software eintragen: Einstellungen → Firmendaten → Treg-Token, speichern (mit Passwort).
   (`ENRICHMENT_PROVIDER=treg` ist Standard.)
3. Prüfen: in derselben Gruppe **„Treg testen“** (fragt eine bekannte Firma ab, ca. 0,2 Cent). Notweg auf dem Server:
   `enrichCli.js test <domain.de>`.
4. Im Cockpit: am Lead „Firmendaten holen“. Automatisch für neue Leads mit Score Hoch/Mittel erst mit
   `ENRICH_AUTO=true`; höchstens `ENRICH_MAX_PER_DAY` (50) Abrufe am Tag.

Jeder Abruf ist auf `TREG_MAX_COST_USD` (0,05 $) gedeckelt – Treg selbst würde bis 1 $ je Abruf erlauben, wenn nur
teure Anbieter die Firma kennen.

Ist das Treg-Guthaben leer oder der Token falsch, steht das als Satz am Lead, und die automatische Anreicherung
bricht ab, statt weiter zu versuchen.

## Übergabe an Close (CRM)

Hat ein Lead geantwortet oder einen Termin, übergibt ihn ein Klick an Close (`shared/crm.ts`): Das Backend legt in
Close einen Lead an (Firma, Website, Ansprechpartner mit Position und LinkedIn-Link) und hängt eine Notiz an –
Einschätzung der Antwort, Score, deine Notiz und die LinkedIn-Nachrichten. Im Cockpit steht der Lead danach auf
„Übergeben“, mit Link nach Close.

Einrichten: In Close unter **Settings → Developer → API Keys** einen Schlüssel anlegen und im Cockpit unter
**Einstellungen → Close und Slack** eintragen (oder `CLOSE_API_KEY` in der `.env`). Optional `CLOSE_STATUS_ID`
(„stat_…“) für den Status neuer Leads. Ohne Schlüssel bleibt es beim bisherigen „Übergeben“ ohne Close.

**Ein- und ausschalten** (seit 22.10.): Einstellungen → Close und Slack → Close → „An Close übergeben“ (`CRM_HANDOVER`).
Im echten Betrieb ist der Schalter erst einmal **aus** – wir arbeiten mit dem CRM im Cockpit. Dann gibt es nirgends
„An Close übergeben“: Auf der Antwort-Karte ist „Termin vereinbart“ die Haupt-Aktion (sonst „Antwort senden“), das
Lead-Panel bietet keine Übergabe an, der Schritt „Übergabe“ und die Erinnerung „Termin noch nicht übergeben“ fallen weg.
In der Simulation ist er an.

## KI-Assistent („KI fragen“ im Dashboard, seit 22.10.)

Seit 25.10. kein eigener Tab mehr (höchstens fünf Hauptansichten): Dashboard → „KI fragen“.
Ein Chat wie ChatGPT mit Lesezugriff auf alle Outreach-Daten (`shared/assistant.ts`). Oben das Modell wählen (alle
Claude-Modelle, die der Anthropic-Schlüssel freigibt; Standard `ANTHROPIC_MODEL`), Frage eintippen, ↵. Gedacht zum
„zwischen den Zeilen lesen“: Der Assistent liest ganze Gesprächsverläufe in Stapeln (beide Richtungen, mit Position in
der Sequenz und Vorlage), vergleicht z. B. Gespräche mit und ohne Antwort und leitet daraus Tipps ab – welche Nachricht an
welcher Stelle wie wirkt, welche Formulierungen Antworten bringen. Dazu eine vorab gerechnete Sequenz-Auswertung (erste
Antwort je Position, Vorlage, Länge, Frage am Ende, Wochentag, Uhrzeit, Kategorie). Findet auch einzelne Kunden („mit
wem habe ich über … geschrieben?“) – Leads stehen als Link in der Antwort und öffnen das Lead-Panel.

- **Nur lesend:** Der Assistent sendet, ändert und löscht nichts. Mitarbeiter sehen nur die Leads ihrer Gründer.
- **Kosten:** stehen unter jeder Antwort und zählen im Dashboard unter „KI-Assistent“. Eine Gesamtanalyse über viele
  Gespräche liest viel und kostet mit Claude Opus 5.5 grob 0,50–3 €; einfache Fragen wenige Cent. Folgefragen im selben
  Chat sind günstiger (Prompt-Cache).
- **Chats** gehören dem Konto, das sie angelegt hat (links im Verlauf, löschbar). Wechselt man während einer Antwort die
  Ansicht, läuft sie weiter und steht beim Zurückkommen da; „Stopp“ bricht ab.
- **Datenschutz:** Was der Assistent liest, geht an Anthropic (wie bei der Lead-Bewertung). Gespeicherte Chats enthalten
  Auszüge aus Gesprächen – löscht ihr einen Lead, bleiben sie in alten Chats stehen, bis ihr den Chat löscht.
- Simulation: dieselben Werkzeuge, aber eine feste Antwort ohne KI (für Tests und Entwicklung).

## Claude-App verbinden (MCP, seit 22.10.)

Das Cockpit ist auch ein **MCP-Server**: In der Claude-App (Web, Desktop, Handy) einen eigenen Connector anlegen, dann
kann man Claude fragen „Was liegt heute an?“ und die Aufgaben mit Claude abarbeiten – lesen wie der KI-Assistent und
bedienen: Anfragen und Nachrichten senden, Antworten eintragen, Termin, Wiedervorlage, Verloren, Notizen, Stufe/Besitzer/
Deal Value ändern (`shared/mcp.ts`, Code `server/src/mcp/`).

1. Im Cockpit Tab **KI** → „Claude-App verbinden“: Dort steht die Adresse, z. B. `https://lukas.ylvalabs.de/mcp`.
2. claude.ai → Einstellungen → Connectors → eigenen Connector hinzufügen, Adresse eintragen (Client-ID/Secret leer lassen).
   Eigene Connectors brauchen einen bezahlten Claude-Plan (Pro, Max, Team, Enterprise); bei Team/Enterprise legt sie
   ein Owner an. Auf dem Handy erscheinen Connectors aus dem Web automatisch.
3. „Verbinden“ → Claude öffnet das Cockpit → anmelden → **Zulassen**. Fertig.

- **Rechte:** Claude handelt als das Konto, das zugelassen hat – mit dessen Rechten, Tageslimits, Arbeitszeiten und
  Pausen (alles läuft über dieselben Routen wie die Oberfläche). Mitarbeiter sehen nur ihre Gründer.
- **Senden:** Echt über LinkedIn nur, wenn `LINKEDIN_ACTIONS` an ist und der Account des Gründers verbunden ist – sonst
  trägt Claude die Nachricht nur ein und sagt, dass man sie selbst senden muss. Claude zeigt Texte vor dem Senden zur
  Bestätigung (die Claude-App fragt bei sendenden Werkzeugen ohnehin nach).
- **Einstellungen per Chat (seit 31.10.):** „Ich will, dass morgens weniger neue Leads kommen“ – Claude sucht mit
  `find_settings` die passende Einstellung (alle mit Erklärung und aktuellem Wert, dazu automatische Suche und Grenzen
  je LinkedIn-Account), nennt alten und neuen Wert und ändert nach deinem Ja (`change_setting`, `change_auto_search`,
  `change_account_limits` – gleiche Prüfungen, Rechte und Verlauf wie in der Oberfläche). Zugangsschlüssel und Werte mit
  Passwort-Rückfrage gehen nur in der Oberfläche. Gibt es nichts Passendes, sagt Claude „Das ist leider noch nicht
  gebaut. Wende dich bitte an die Entwickler.“
- **Trennen:** im selben Dialog („Trennen“) – das Token ist sofort ungültig. Zugriffstokens gelten 8 h, Claude erneuert
  sie selbst (bis 90 Tage ohne Nutzung).
- **Voraussetzung:** öffentlich per https erreichbar (Caddy) und `PUBLIC_URL` gesetzt. nginx leitet `/mcp` und
  `/.well-known/oauth-*` ans Backend – nach dem Update also auch das Frontend neu bauen (`docker compose up -d --build`).
- **Datenschutz:** Was Claude liest, geht an Anthropic (wie beim KI-Assistenten), läuft aber über euer Claude-Konto.

## Slack bei neuer Antwort

Antwortet ein Lead, schickt das Backend (nur live) eine Nachricht nach Slack: wer, an wen, die Antwort (gekürzt), die
Einschätzung und einen Link ins Cockpit. Kostenlos über einen „Incoming Webhook“ – auch im freien Slack-Plan:

1. In Slack auf api.slack.com/apps → **Create New App** → „From scratch“ → Workspace wählen.
2. **Incoming Webhooks** einschalten → **Add New Webhook to Workspace** → Kanal wählen (z. B. #antworten).
3. Die Adresse `https://hooks.slack.com/services/…` im Cockpit unter **Einstellungen → Close und Slack** eintragen
   (oder `SLACK_WEBHOOK_URL` in der `.env`). Die Adresse ist ein Geheimnis – nicht weitergeben.

Über denselben Webhook kommen auch die **Neuigkeiten** der Glocke oben rechts: neue Registrierung wartet auf Freigabe,
automatische Lead-Suche abgebrochen (z. B. Schlüssel abgelehnt), LinkedIn pausiert, Sicherung oder Update
fehlgeschlagen. Dieselbe Meldung kommt höchstens alle 12 Stunden erneut. Ist das Problem behoben, verschwindet sie
aus der Glocke.

## Löschen nach „kein Interesse“ (Datenschutz)

Leads in der Stufe **Verloren** werden 30 Tage nach der letzten Aktivität endgültig gelöscht, mit Verlauf
(`LOST_DELETE_DAYS`, in der Software unter Einstellungen → Tagesstapel; `off` = nie). Damit niemand erneut
angeschrieben wird, bleibt nur ein Fingerabdruck (SHA-256 der LinkedIn-ID) ohne Namen oder Firma; die Lead-Suche
zeigt solche Treffer als „Früher kein Interesse“. Hinweis: In älteren Sicherungen
(`DATA_DIR/backups`, Standard 7 Tage) stehen gelöschte Leads noch, bis diese Sicherungen rausrotieren.

**Auf Wunsch einer Person (DSGVO):** Im Lead-Panel unter „•••“ (Weitere Aktionen, nur Admin und Gründer):

- **Daten exportieren** (Auskunft, Art. 15): eine JSON-Datei mit allem, was das Cockpit zu dieser Person gespeichert
  hat – Profil- und Firmendaten, KI-Einschätzung, Score, Verlauf mit allen Nachrichten, LinkedIn-Aktionen,
  Firmendaten-Anfragen, Eintrag in der Tracking-Liste (`GET /api/leads/:id/export`).
- **Lead endgültig löschen** (Art. 17): nach einer Rückfrage sofort, in jeder Stufe, über denselben Weg wie das Löschen
  nach der Frist (`DELETE /api/leads/:id`). Es bleibt nur der Fingerabdruck, damit niemand sie erneut anschreibt.
  Die Tracking-Liste (Excel) ändert das Cockpit nicht – dort den Eintrag selbst entfernen, falls nötig.

**Dashboard bleibt vollständig:** Bevor ein Lead gelöscht wird (Frist oder Wunsch), wandern seine zählbaren
Ereignisse anonym in die Tabelle `lead_events_archive` – nur Art, Zeitpunkt, Gründer und Vorlage, ohne Text, Namen
oder Lead-ID. Das Dashboard zählt beide Quellen; der Verlauf schrumpft also nicht mehr mit jedem Löschen.

## Clay (Alternative, nicht in Betrieb)

Nur mit `ENRICHMENT_PROVIDER=clay`. Die Clay-Anbindung bleibt im Code, falls Treg bei kleinen deutschen Firmen zu
wenig findet.

Clay ergänzt Firmendaten, die LinkedIn nicht liefert: **Mitarbeiterzahl, Umsatzschätzung, Tech-Stack der Website
(u. a. Meta-Pixel), Social-Links**. Daraus rechnet das Backend den Score neu (Firmengröße, Online-Präsenz, Meta-Pixel).
Jede Anfrage kostet Clay-Credits – deshalb auf Knopfdruck am Lead oder automatisch nur für neue Leads mit Score
Hoch/Mittel (`CLAY_AUTO_ENRICH`), höchstens `CLAY_MAX_PER_DAY` am Tag. In der Simulation läuft alles mit festen
Beispielwerten, ohne Clay.

**Einrichtung in Clay** (einmalig; Bezeichnungen laut Clay-Doku, vor dem Einrichten dort gegenprüfen):
1. Neue Tabelle → **„Import data from Webhook“**. Die Webhook-Adresse in die Server-`.env` als `CLAY_WEBHOOK_URL`;
   wenn Clay ein Auth-Token anzeigt (nur einmal sichtbar), als `CLAY_WEBHOOK_TOKEN`.
2. Das Cockpit schickt je Lead: `leadId`, `firstName`, `lastName`, `fullName`, `position`, `linkedinUrl`, `location`,
   `company`, `website`, `domain`, `callbackUrl`.
3. In Clay Anreicherungs-Spalten für die vier Felder anlegen (z. B. über `domain`).
4. Zum Schluss eine Spalte **„HTTP API“**: Methode POST, Adresse = `callbackUrl` (bzw.
   `https://<deine Domain>/api/enrichment/clay`), Header `x-cockpit-secret` = Wert von `CLAY_CALLBACK_SECRET`, Body:
   ```json
   { "leadId": "<leadId>", "employees": "<Mitarbeiter>", "revenue": "<Umsatz>", "techStack": "<Tech-Stack>",
     "instagram": "<…>", "facebook": "<…>", "linkedin": "<…>", "youtube": "<…>", "tiktok": "<…>", "x": "<…>" }
   ```
   Werte dürfen Text sein („11-50“, „WordPress, Meta Pixel“), leere Zellen sind in Ordnung. Spalte automatisch
   laufen lassen, sobald die Anreicherung fertig ist.
5. `CLAY_CALLBACK_SECRET` erzeugen (`openssl rand -hex 32`), in die `.env` eintragen, Backend neu starten.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `CLAY_WEBHOOK_URL` | – | Webhook der Clay-Tabelle (ohne: Clay aus) |
| `CLAY_WEBHOOK_TOKEN` | – | optionales Auth-Token des Webhooks |
| `CLAY_CALLBACK_SECRET` | – | Schlüssel für den Rückweg, mind. 24 Zeichen (ohne: Clay aus) |
| `CLAY_AUTO_ENRICH` | live `false`, Simulation `true` | neue Leads mit Score Hoch/Mittel automatisch anreichern |
| `CLAY_MAX_PER_DAY` | `50` | höchstens so viele Anfragen am Tag (UTC) |

## Datenbank und Sicherung

Alles Dauerhafte liegt in **`cockpit.db`** (SQLite) im Docker-Volume `lead-search-data`: Konten, Sitzungen, Leads mit
Verlauf und die Tracking-Liste. Eine früher hochgeladene Tracking-Liste (`tracking.json`) wird beim ersten Start
automatisch übernommen.

Alles unter **Einstellungen → Sicherungen** (nur Admin und Gründer):

- **Täglich um 2 Uhr UTC** sichert das Backend die Datenbank nach `backups/` im selben Volume – von selbst, aus der
  Software heraus (`BACKUP_HOUR_UTC`, in den Einstellungen änderbar, `off` schaltet ab).
- **Jetzt sichern:** Knopf über der Liste (Datei `manuell-…`) – z. B. bevor du etwas an den Einstellungen änderst.
- **Vor jedem Update** automatisch (`vor-update-…`, siehe „Updates“); davon bleiben die letzten 3.
- **Aufräumen:** Jede Sicherung (geplant, von Hand, vor dem Wiederherstellen, vor einem Update) wird nach **7 Tagen**
  gelöscht (`BACKUP_MAX_AGE_DAYS`); die neueste bleibt immer. Zusätzlich je Art höchstens `BACKUP_KEEP` (14) Dateien
  (vor einem Update: 3).
- **Speicherplatz:** Stündlich und vor jeder Sicherung prüft das Backend den freien Platz im Datenordner. Unter 1 GB
  oder unter 10 % frei erscheint „Speicherplatz auf dem Server knapp“ in den Neuigkeiten (und in Slack); die Meldung
  verschwindet, sobald wieder genug frei ist. Der freie Platz steht auch unter Sicherungen.
- **Gesundheit:** `GET /api/health` (ohne Anmeldung) fragt die Datenbank mit einer winzigen Abfrage und antwortet
  503, wenn sie nicht antwortet – für Docker-Healthchecks oder einen Uptime-Dienst.
- **Herunterladen** (z. B. vor einem Umbau): in der Liste, mit deinem Passwort – die Datei enthält alle Leads.
- **Wiederherstellen:** in der Liste, mit deinem Passwort. Das Backend prüft die Sicherung (SQLite
  `integrity_check`, eine beschädigte wird abgelehnt und nichts ändert sich), sichert den jetzigen Stand
  (`vor-wiederherstellen-…`), setzt die Sicherung ein und startet neu (Docker startet es wieder, wenige Sekunden).
  In der Simulation wird nichts ersetzt.
- Notweg ohne Oberfläche: `docker compose exec backend node dist/server/src/backupCli.js` (sofort sichern).
- Die Sicherungen liegen auf demselben Server – gegen den Verlust des ganzen Servers zusätzlich die
  Hostinger-Backups einschalten.

### Schlüssel für Geheimnisse – getrennt aufbewahren (wichtig)

Die API-Schlüssel aus den Einstellungen liegen verschlüsselt in `cockpit.db` – also auch in jeder Sicherung. Der
Schlüssel dazu (`settings.key` im Datenordner bzw. `SETTINGS_KEY` aus der `.env`) ist **nicht** in den Sicherungen.
Geht der Server verloren, ist eine Sicherung ohne diesen Schlüssel zwar vollständig, aber alle gespeicherten
API-Schlüssel müssen neu eingegeben werden.

**Einmal erledigen:** Einstellungen → Sicherungen → **„Schlüssel für Geheimnisse anzeigen“** (mit deinem
Passwort, höchstens 5-mal in 15 Minuten) und den Wert im Passwort-Manager ablegen – getrennt von den Sicherungen.
Kommt der Schlüssel aus `SETTINGS_KEY`, sagt die Oberfläche nur das; dann den Wert aus der `.env` ablegen. Zum
Wiederherstellen auf einem neuen Server den Wert als `SETTINGS_KEY` in die `.env` schreiben (oder als
`settings.key` in den Datenordner legen, Rechte 600).

## Lead-Suche einrichten

```bash
cp .env.example .env
nano .env        # Werte eintragen, siehe unten – oder später im Cockpit unter Einstellungen
docker compose up -d --build
```

In der `.env` mindestens setzen:

| Variable | Wert |
| --- | --- |
| `UNIPILE_DSN` | DSN aus dem Unipile-Dashboard, z. B. `https://api68.unipile.com:19881` |
| `UNIPILE_API_KEY` | Access Token aus dem Unipile-Dashboard |
| `ANTHROPIC_API_KEY` | Schlüssel aus der Anthropic Console – **optional**: ohne ihn werden Leads gefunden und angereichert, aber nicht bewertet („Nicht bewertet“) |
| `META_ACCESS_TOKEN` | Token für die Meta-Werbebibliothek (siehe [Meta-Ads-Filter](#meta-ads-filter)) – **optional**: ohne ihn bleiben qualifizierte Leads „Meta-Ads nicht geprüft“ |

Optional: `UNIPILE_ACCOUNT_ID` (Such-Account; sonst der erste verbundene LinkedIn-Account – bei Sales Navigator einer
mit Sales Navigator), `UNIPILE_SEARCH_API=sales_navigator` (nur mit Sales-Navigator-Lizenz des Such-Accounts), `UNIPILE_LOCATION_ID` (LinkedIn-ID der Region),
`ANTHROPIC_MODEL` (Standard `claude-opus-5-5`), `MAX_RESULTS` (Voreinstellung, höchstens 1000), `SEARCH_HITS_PER_RUN`
(Suchtreffer pro Lauf, Standard 400, 20–1000 – siehe [KI-Vorprüfung](#ki-vorprüfung-1110)), `QUALIFY_MIN_CONFIDENCE` (Standard 0,6),
`LEAD_DISTRIBUTION` (`owner` Standard | `balanced`, siehe unten), `AI_USD_EUR_RATE` (Kurs $ → € für die KI-Kosten,
Standard 0,86), `META_GRAPH_VERSION` (Standard `v26.0`).
Fehlt ein Pflichtwert, zeigt die Lead-Suche, welcher – und startet nicht.

Der LinkedIn-Account muss bei Unipile verbunden sein. Solange das nicht der Fall ist (oder er neu verbunden werden muss),
zeigt die Lead-Suche „Noch kein LinkedIn-Account verbunden“ und lässt sich nicht starten. Geprüft wird nur die
Account-Liste bei Unipile (keine LinkedIn-Aktion), alle 30 Sekunden oder per „Jetzt prüfen“. Sobald der Account
verbunden ist, ist die Suche ohne Neustart startklar.

**Mehrere LinkedIn-Accounts, feste Unipile-Limits (seit 17.10.).** Gescraped – gesucht und Profile gelesen – wird
über **alle** bei Unipile verbundenen, startklaren LinkedIn-Accounts, also auch über reine Scraping-Accounts.
Vernetzungsanfragen und Nachrichten gehen dagegen **nur** über die Accounts der Gründer (`UNIPILE_ACCOUNT_NICK` /
`UNIPILE_ACCOUNT_JOHANNES`). Je Account und Tag (deutsche Zeit) gelten fest die Empfehlungen von Unipile, über alle
Läufe zusammen gezählt (Datenbank, übersteht Neustarts) – kein Wert in Einstellungen oder `.env` hebt sie an:

| Was | je Account und Tag |
| --- | --- |
| Profilabrufe (Profil und Firmenseite) | 100 |
| Suchtreffer | 1.000 (klassisch) bzw. 2.500 (Sales Navigator) |
| Vernetzungsanfragen | höchstens 80 am Tag und 200 in 7 Tagen (Einstellung darf niedriger sein) |
| Nachrichten | höchstens 100 (Einstellung darf niedriger sein) |

**Die Gründer-Accounts sind stärker geschützt:** Beim Scrapen kommen sie erst dran, wenn die reinen Scraping-Accounts
voll sind, und dann nur mit dem halben Limit (50 Profile, 500 bzw. 1.250 Suchtreffer am Tag). Profile ruft unter den
Scraping-Accounts immer der mit den wenigsten Abrufen am Tag ab. Die Suche bleibt bei einem Account, bis sein
Kontingent voll ist, dann übernimmt der nächste. **Firmenseiten** (zählen wie ein Profil) laufen nie über die
Gründer-Accounts, sondern von unten in der Such-Reihenfolge – die am wenigsten aufgewärmten Accounts zuerst (02.11.);
sie werden nie weggelassen: Ist kein Account dafür mehr frei, liest die Suche kein weiteres Profil und stoppt
(„Tageslimit für Firmenseiten erreicht“); ein schon gelesener Lead kommt auf die Warteliste und ist morgen zuerst dran. Ein Lauf ruft höchstens so viele
Profile ab, wie alle Accounts zusammen noch dürfen; der Rest wartet auf den nächsten Lauf („Tageslimit der
LinkedIn-Accounts erreicht – beim nächsten Lauf dran“). Ist alles verbraucht, startet ein Lauf gar nicht erst
(„Tageslimit aller LinkedIn-Accounts erreicht“). `UNIPILE_ACCOUNT_ID` legt nur fest, welcher Account zuerst drankommt.
Mit Sales Navigator suchen nur Accounts, für die Unipile Sales Navigator meldet (und `UNIPILE_ACCOUNT_ID`). Kontakte,
offene Anfragen und Kontaktgrad der reinen Scraping-Accounts spielen für den Dubletten-Abgleich keine Rolle.

**Tagesstapel bei nicht verbundenem Account (18.10.):** Ist für einen Gründer kein LinkedIn-Account zugeordnet (der
andere hat einen) oder meldet Unipile ihn getrennt/gestört, sind seine Aufgaben pausiert – unter „Meine“ steht „Der
LinkedIn-Account ist gerade nicht verbunden. Verbinde ihn bitte erneut, um weiterzuarbeiten.“ Seine **neuen Leads**
stehen beim anderen Gründer („übernommen von …“), solange dessen Tageslimit für Anfragen reicht; mit der Anfrage wird
der andere Gründer Besitzer. Erstnachrichten, Follow-ups und Antworten warten auf den eigenen Account. Ist Unipile nicht
erreichbar oder für niemanden ein Account zugeordnet, wird nichts pausiert. Nach dem Neuverbinden und Zuordnen geht es
beim nächsten Laden des Stapels (spätestens nach einer Minute) von selbst weiter.

**Gründer-Account bei Unipile getrennt (Entscheidung 17.10., Nicks gesperrter Account):** Die Suche läuft trotzdem weiter
und stellt keine Leads zurück, über den Account läuft nichts. Leads, die schon mit diesem Gründer vernetzt sind, können
dann doppelt auftauchen (bewusst in Kauf genommen). Der Hinweis steht über dem Suchformular. Wird der Account wieder
verbunden, ist er ab dem nächsten Lauf von selbst wieder dabei – vergibt Unipile dabei eine neue ID, unter
Einstellungen → LinkedIn neu zuordnen.

**Zwei LinkedIn-Accounts (je Gründer einer, einer mit Sales Navigator).** Welche ID wohin gehört (IDs aus
„Accounts laden“ bzw. dem Verbindungstest):

| Variable | Account |
| --- | --- |
| `UNIPILE_ACCOUNT_ID` | Account, der beim Scrapen **zuerst** drankommt – bei `UNIPILE_SEARCH_API=sales_navigator` der Account **mit** Sales Navigator |
| `UNIPILE_ACCOUNT_NICK` / `UNIPILE_ACCOUNT_JOHANNES` | je Gründer sein eigener Account – nur über diese wird vernetzt und geschrieben |
| `UNIPILE_WARMUP_ACCOUNTS` | reine Scraping-Accounts, die aufgewärmt werden (siehe unten) – scrapen weiter wie alle anderen |
| `UNIPILE_ACCOUNTS_USED` | nur diese Unipile-Accounts nutzt das Cockpit (leer = alle). Wichtig, wenn sich mehrere Cockpits einen Unipile-Zugang teilen – in der Software unter Einstellungen → LinkedIn-Accounts per „Nicht nutzen“/„Nutzen“. Gründer- und Aufwärm-Accounts zählen immer dazu |

**Accounts aufwärmen** (seit 21.10.): Neue Scraping-Accounts ohne Kontakte sehen in der Suche fast nur anonyme
„LinkedIn Mitglied“-Treffer. In Einstellungen → LinkedIn-Accounts per „Aufwärmen“ gewählte Accounts schicken darum zu
zufälligen Zeiten in der Arbeitszeit Vernetzungsanfragen **ohne Notiz** an qualifizierte Leads und Profile der
Tracking-Liste (Excel) – höchstens `LINKEDIN_WARMUP_PER_DAY` (≤ 17) am Tag, in den ersten Wochen 6 → 10 → 14. Gezählt
wird nur, was die Automatik sendet; jede Person bekommt höchstens eine Aufwärm-Anfrage. Nur mit `LINKEDIN_ACTIONS=on`;
Limit- oder Zugangsfehler pausieren nur diesen Account. Stand je Account unter dem Namen („heute x von y“).

**Grenzen und Reihenfolge je Account** (seit 21.10., Einstellungen → LinkedIn-Accounts): Je Account lassen sich
Suchtreffer, Profilabrufe und Vernetzungsanfragen pro Tag einstellen (leer = Standard, nie über den Unipile-Grenzen).
Fällt ein Such-Account aus (LinkedIn-Limit, Zugang weg, Unipile antwortet nicht), übernimmt der nächste – der Lauf
läuft weiter (seit 22.10.). Der ausgefallene Account bleibt eine Weile außen vor (Limit 6 h, Zugang 1 h, keine Antwort
15 Min., Hinweis in der Lead-Suche); erst wenn alle ausgefallen oder am Limit sind, bricht der Lauf mit dem Grund ab.
Die Anfragen-Grenze gilt für alles über den Account – Senden der Gründer wie Aufwärmen. Alle Accounts lassen
sich per Pfeil ordnen: der vordere wird bis zu seiner Grenze genutzt, dann der nächste. Seit 22.10. auch die Gründer
(z. B. ganz nach oben); ohne eigenen Platz kommen sie zuletzt. Ohne Reihenfolge verteilt die Suche gleichmäßig. Gespeichert in `linkedin_account_prefs` (Migration 38).

Ist Sales Navigator eingestellt und Unipile meldet für den ersten Such-Account kein Sales Navigator, warnt die
Lead-Suche (Hinweis über dem Formular und im Log).

**Dubletten über alle Gründer-Accounts.** Neu ist ein Lead nur, wenn er mit **keinem** Gründer-Account vernetzt ist
und von **keinem** eine offene Vernetzungsanfrage hat. Seit 17.10. (Scrapen reihum über alle Accounts) lädt die Suche für **jeden** Gründer-Account dessen Kontakte
(`GET /users/relations`) und gesendete Anfragen (`GET /users/invite/sent`). Grund in der Liste: „Bereits vernetzt mit Johannes“ bzw.
„Vernetzungsanfrage von Johannes bereits offen“. Abgeglichen wird über Provider-ID **und** öffentliche Kennung, einmal
im Dubletten-Filter und noch einmal nach dem Profilabruf (Sales-Navigator-Treffer tragen eine andere ID; erst das
Profil liefert die klassische). Sparsam für LinkedIn: 100 Kontakte je Seite, höchstens 100 Seiten, 1–2,5 s Pause
zwischen den Seiten; die Kontakte bleiben 12 Stunden, die Anfragen 1 Stunde zwischengespeichert (nur im Speicher, nach
Neustart oder Änderung der Einstellungen neu). **Lässt sich ein Gründer-Account nicht prüfen** (getrennt, keine
Unipile-Sitzung, Limit), läuft die Suche weiter, aber alle sonst neuen Leads werden **zurückgestellt** („Kontakte von
Johannes nicht prüfbar (…) – beim nächsten Lauf dran“, kein Profilabruf) – lieber später als doppelt angeschrieben. Der
Hinweis steht dann auch über dem Suchformular. Das gilt nur, wenn der Account verbunden ist, sich aber gerade nicht
abfragen lässt – ist er bei Unipile getrennt oder gestört, läuft die Suche weiter (siehe oben). Abhilfe: Account im Unipile-Dashboard neu verbinden oder – wenn der
Gründer gar nicht mitmacht – `UNIPILE_ACCOUNT_<NAME>` leeren.

**Neue Leads auf beide Gründer verteilen (`LEAD_DISTRIBUTION`, Einstellungen → Lead-Suche).** Gesucht wird immer
über den Such-Account (`UNIPILE_ACCOUNT_ID`, z. B. der mit Sales Navigator). Wem die gefundenen Leads gehören – und
damit, über wessen LinkedIn-Account Vernetzungsanfragen und Nachrichten gehen –, legt diese Einstellung fest:

| Wert | Wirkung |
| --- | --- |
| `owner` (Standard) | Wer sucht (von Hand oder per Zeitplan), bekommt alle neuen Leads – wie bisher. |
| `balanced` | „Auf beide Gründer verteilen“: Jeder neue Lead geht an den Gründer mit den **wenigsten Leads in der Stufe „Neu“**; bei Gleichstand an den, der gesucht hat. Ein Lauf mit 7 Leads bei gleichem Rückstand ergibt also 4 : 3. So bleiben beide Stapel gleich voll und jeder Account unter seinem Tageslimit. |

Verteilt wird nur, wenn bei **beiden** Gründern ein eigener LinkedIn-Account eingetragen ist
(`UNIPILE_ACCOUNT_NICK`/`UNIPILE_ACCOUNT_JOHANNES`, verschiedene Accounts) – sonst gilt `owner`. Dubletten behalten
ihren Besitzer. Ein zugeteilter Lead nennt im Verlauf „· verteilt an Johannes“ und trägt `origin.searchedBy` (wer
gesucht hat). Weil die Dublettenprüfung oben alle Gründer-Accounts abdeckt, ist ein neuer Lead mit keinem davon
vernetzt – auch nicht mit dem, dem er zugeteilt wird. Tagesstapel und Tageslimit gelten je Besitzer; das Tagesziel
der automatischen Suche zählt alle Leads des Laufs für den Zeitplan, der gesucht hat.

**Unipile braucht ein laufendes Abo.** Der Testzeitraum endet nach einigen Tagen; danach antwortet Unipile auf jede
Anfrage mit HTTP 503 `errors/no_client_session` („No client session is currently running“). Das ist **kein
LinkedIn-Limit**: Suche, Verbindungstest und LinkedIn-Aktionen melden dann „Unipile-Sitzung nicht aktiv“ – Abo und
Account-Status im Unipile-Dashboard prüfen und den Account bei Bedarf neu verbinden. Damit das auch auffällt, wenn
Suche und LinkedIn-Aktionen aus sind, fragt der Server im Live-Modus 2 Minuten nach dem Start und danach alle 4 Stunden
die Account-Liste ab (nur lesend, eine Anfrage) und meldet ein Problem einmal in den Neuigkeiten (und an Slack); klappt
es wieder, verschwindet die Meldung. Andere 5xx-Fehler nennt die Oberfläche „Unipile meldet einen Fehler“ – meist eine
Störung bei Unipile, selten ein verstecktes LinkedIn-Limit; der Lauf bricht trotzdem vorsichtshalber ab.

Schutz des LinkedIn-Accounts im Live-Modus:

- Profilabrufe pro Lauf **frei einstellbar** bis 1000 (bis 11.10. fest 25 – auf Wunsch des Nutzers aufgehoben; viele
  Profile pro Tag erhöhen das Risiko, dass LinkedIn den Account einschränkt)
- **zufällige Pausen von 3–8 Sekunden** zwischen Profilabrufen; Profilbesuche ohne Benachrichtigung (`notify=false`)
- immer nur **ein Lauf gleichzeitig**
- bei **Limit- oder Zugangsfehlern** (429, 401, 403, 5xx) bricht der Lauf sofort ab und die Oberfläche erklärt, warum.
  Bereits qualifizierte Leads lassen sich trotzdem übergeben.

Ein Live-Lauf mit 15 Profilen dauert wegen der Pausen ca. 2–3 Minuten.

### Meta-Ads-Filter

Am besten passen Firmen, bei denen Meta-Ads **nicht laufen**: Entweder haben sie es nie probiert, oder sie haben ihre
Anzeigen wieder abgeschaltet. Wer gerade Anzeigen schaltet, fliegt **nicht** raus (seit 07.10.): Diese Leads kommen
markiert („Aktive Meta-Ads – von Hand prüfen“) in den Tagesstapel – dort wird oft viel Budget verbrannt, und jemand
schaut sich die Kampagnen vor der Ansprache an. Deshalb prüft die Pipeline jeden Lead, den die
KI als Kapitalanlage-Vertrieb, Finanzdienstleister oder Bauträger mit eigenem Vertrieb einstuft, in der offiziellen **Meta-Werbebibliothek** (Ad Library API):

| Ergebnis | Bedeutung | Im Lauf |
| --- | --- | --- |
| Keine Meta-Ads gefunden | keine eigenen Anzeigen in Deutschland in den letzten 12 Monaten | qualifiziert |
| Meta-Ads beendet am … | eigene Anzeigen gefunden, aber keine läuft mehr (mit Datum der letzten) | qualifiziert |
| Aktive Meta-Ads | mindestens eine eigene Anzeige läuft gerade | geht markiert in den Tagesstapel („Aktive Ads“, von Hand prüfen) |
| Meta-Ads nicht geprüft | kein Token, keine Firma im Profil oder Meta-Fehler | qualifiziert, mit Hinweis |

So funktioniert der Abgleich: Gesucht wird nach dem Firmennamen ohne Rechtsform (z. B. „Muster Wohnbau“), ohne eigenen
Treffer zusätzlich nach der Website-Domain. Treffer anderer Werbetreibender („Fremdtreffer“, etwa ein Portal, das
dasselbe Projekt bewirbt) zählen nicht. Eigene Anzeigen erkennt der Abgleich am Seitennamen oder am Link auf die
Firmen-Website. Jede Zeile in der Ergebnistabelle hat einen Link **„In der Werbebibliothek ansehen“**, so lässt sich
jedes Ergebnis mit einem Klick nachprüfen. Meta zeigt Anzeigen in der EU bis ein Jahr nach ihrer letzten Ausspielung.
Was länger als ein Jahr aus ist, erscheint daher als „Keine Meta-Ads gefunden“. Der Abgleich fragt nur die
Werbebibliothek ab (1–4 Abfragen pro qualifiziertem Lead), keine LinkedIn-Aktion.

**Privater Name (seit 15.10.):** Manche schalten die Anzeigen nicht über die Firma, sondern über ihr eigenes Profil.
Schaltet die Firma nicht gerade selbst, sucht der Abgleich deshalb zusätzlich nach „Vorname Nachname“. Eine Seite zählt
nur, wenn Vor- und Nachname im Seitennamen stehen. Das stärkere Ergebnis gewinnt (aktiv vor beendet vor keine). Im
Lead-Panel steht dann „… · über den privaten Namen“.

**Alle Leads nachprüfen (seit 15.10.):** Leads, die vor dem Token gesucht wurden, stehen auf „Meta-Ads nicht geprüft“.
Sobald ein neuer Token gespeichert ist, prüft der Server alle Leads im Cockpit nach (außer „Verloren“ und von Hand
eingetragenen Ständen). Von Hand geht das unter Einstellungen → Meta-Werbebibliothek → „Jetzt alle prüfen“; dort steht
auch der Fortschritt. Score und Lead-Typ (welche Vorlage vorgeschlagen wird) werden neu gerechnet, ein geänderter Stand
steht im Verlauf des Leads. Meldet Meta ein Limit, wartet die Nachprüfung etwa eine Stunde und macht dann weiter.

**Token besorgen (einmalig, ca. 15 Minuten plus Wartezeit bei Meta):**

1. Mit dem Facebook-Konto unter [facebook.com/ID](https://www.facebook.com/ID) die Identität bestätigen
   (Ausweis; Meta braucht dafür teils einige Tage). Ohne Bestätigung lehnt die API ab.
2. Auf [developers.facebook.com](https://developers.facebook.com) eine App anlegen (Typ „Business“ oder „Andere“).
3. Im [Graph API Explorer](https://developers.facebook.com/tools/explorer/) die App wählen und
   „Generate Access Token“ klicken.
4. Der Token gilt nur 1–2 Stunden. Für einen Token mit **60 Tagen** Laufzeit im
   [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/) „Extend Access Token“ klicken.
5. Den Token in der Software eintragen: Einstellungen → Meta-Werbebibliothek → Access Token, speichern, dann
   **„Verbindung testen“**.

Läuft der Token ab, bricht die Suche mit „Meta-Token ungültig oder abgelaufen“ ab. Dann die Schritte 3–5 wiederholen.

Für Entwickler: prüfen, ob der Abgleich bei euch stimmt, am besten mit Firmen, deren Stand ihr kennt (z. B. aus der
Spalte „Meta Ads“ der Tracking-Liste):

```bash
docker compose exec backend node dist/server/src/liveCheck.js --meta "Firma mit aktiven Ads GmbH" "Firma ohne Ads GmbH"
```

### Echte LinkedIn-Aktionen (Vernetzen, Nachrichten)

Mit Phase 3 sendet das Cockpit Vernetzungsanfragen und Nachrichten **echt** über Unipile – jeder Gründer über
seinen eigenen LinkedIn-Account. Standard: **aus**. In der Simulation läuft alles ohne LinkedIn.

**Einschalten – alles in der Software, Einstellungen → „Senden über LinkedIn“:**
1. Johannes' LinkedIn-Account zusätzlich im Unipile-Dashboard verbinden (falls er selbst senden soll).
2. **„Accounts laden“** zeigt die bei Unipile verbundenen Accounts – je Account „Für Nick“ bzw. „Für Johannes“ klicken.
3. **„Echt über LinkedIn senden“** auf „An“ stellen, Grenzen und Arbeitszeit prüfen, **Speichern** (mit Passwort).
4. **Test-LinkedIn-Account:** das Profil eines Test-Accounts (Zweit-Account oder Kollege, muss ein Kontakt 1. Grades
   sein) eintragen und **„Prüfen“** – die Software zeigt Name, Überschrift und Link zur Kontrolle und speichert ihn.
   Dann **„Test-Nachricht senden“** (nur an Kontakte 1. Grades) oder **„Test-Vernetzungsanfrage senden“** (nur an
   Nicht-Kontakte): genau eine echte Nachricht bzw. Anfrage an diesen Account, nie an einen Lead. Geht auch, solange
   „Echt über LinkedIn senden“ aus ist – gut, um nach jedem Update zu prüfen, ob alles ankommt. Je Art höchstens eine
   pro Minute, zählt zum Tageslimit.
5. Tageszähler, Pausen und „Jetzt abgleichen“ stehen auf der Startseite.

(Die Server-Befehle `linkedinCli.js konten|status|test-anfrage|abgleich|fortsetzen` gibt es weiterhin als Notweg.)

**Schutz** (Backend erzwingt): je Account höchstens `LINKEDIN_INVITES_PER_DAY` (20, fest höchstens 80) Anfragen am Tag und
`LINKEDIN_INVITES_PER_WEEK` (80, fest höchstens 200) in 7 Tagen, `LINKEDIN_MESSAGES_PER_DAY` (40, fest höchstens 100)
Nachrichten – nur über die Gründer-Accounts, nie über reine Scraping-Accounts; nur
`LINKEDIN_WORK_HOURS`/`LINKEDIN_WORK_DAYS` (Mo–Fr 8–19 Uhr, `LINKEDIN_TIMEZONE`); 3–8 s Pause zwischen zwei Aktionen
(`LINKEDIN_PAUSE_SECONDS`); jede Aktion wird protokolliert. Seit 25.10. zählen gesendete und von Hand eingetragene
Anfragen gemeinsam gegen dieselbe Grenze – je Account, über den sie gingen (vorher zählte jeder Weg nur sich selbst und
ließ zusammen mehr durch als eingestellt). Meldet LinkedIn ein Limit, pausiert der Account einen Tag,
bei Zugangsfehlern 6 Stunden – aufheben auf der Startseite mit **„Pause aufheben“** (nur, wenn der Grund behoben ist). Gesendet wird immer über den
Account des **Besitzers** des Leads (seit 18.10.): Erledigt Nick unter „Alle“ eine Aufgabe von Johannes, geht sie über
Johannes' Account und zählt auf dessen Limit; im Verlauf steht „von Nick“.

**Account-Wechsel** (seit 12.10., `LINKEDIN_ACCOUNT_FALLBACK`, Standard an): Anfragen zählen je LinkedIn-Account, über
den sie gingen. Ist der eigene Account voll, geht die nächste Anfrage über den Account des anderen Gründers – beim
echten Senden wie beim Eintragen von Hand; die Karte „Neuer Lead“ sagt das. Der Lead bleibt beim Besitzer, merkt sich
aber den Account (`linkedin.sentBy`): Erstnachricht, Follow-ups und der Abgleich laufen darüber. Der Tagesstapel zeigt
dann bis zu 2 × `NEW_LEADS_PER_DAY` neue Leads; gesperrt wird erst, wenn beide Accounts voll sind.

**Antworten und angenommene Anfragen** holt das Backend alle `LINKEDIN_SYNC_MINUTES` (15) Minuten selbst ab
(nur lesend). Antworten werden nur in Unterhaltungen erkannt, die über das Cockpit begonnen wurden.

### Persönliche Kontakte per Link (19.10.)

Leads → **Kontakt hinzufügen**: den Link zum LinkedIn-Profil von jemandem einfügen, mit dem du schon vernetzt bist. Das
Cockpit liest das Profil **einmal** über deinen LinkedIn-Account (ohne Suche, ohne Benachrichtigung) und legt einen
normalen Lead an – ohne KI-Einstufung. Ist die Person ein Kontakt 1. Grades, wird die bestehende LinkedIn-Unterhaltung
übernommen (bis 100 Nachrichten): letzte Nachricht von ihr → „Antwort“ (du bist dran), sonst „Angeschrieben“, ohne Chat
„Vernetzt“ mit Erstnachricht im Tagesstapel. Neue Antworten erkennt danach der normale Abgleich. Braucht nur den
Unipile-Zugang und den unter Einstellungen gewählten LinkedIn-Account des Gründers, nicht „Echt senden“. Gibt es die
Person schon, öffnet sich der vorhandene Lead.

### Chats nachträglich abgleichen (19.10.)

Der normale Abgleich (alle `LINKEDIN_SYNC_MINUTES`) holt seit 20.10. erst die Liste der LinkedIn-Chats mit neuer
Aktivität und liest nur deren Nachrichten – auch bei Leads, die von Hand angeschrieben wurden. Ein einzelner nicht
lesbarer Chat bricht ihn nicht mehr ab; nur ein echtes Limit oder ein Zugangsfehler pausiert den Account.

War ein Gründer-Account eine Zeit lang bei Unipile getrennt (z. B. LinkedIn-Sperre), fehlen dem Cockpit Nachrichten aus
dieser Zeit. Nach dem erneuten Verbinden **einmal** unter **Einstellungen → LinkedIn → „Chats abgleichen“** klicken (mit Rückfrage): Für alle vernetzten Leads
holt das Cockpit den aktuellen LinkedIn-Verlauf (bis 100 Nachrichten je Chat) und übernimmt, was fehlt – Antworten und
eigene Nachrichten, mit echtem Zeitpunkt. Doppelt wird nichts. Läuft im Hintergrund mit den normalen Pausen (bei vielen
Chats ein paar Minuten), sendet nie etwas. Braucht den Unipile-Zugang, nicht „Echt senden“.

### Verbindungstest: Was liefert Unipile wirklich?

Nach `docker compose up -d --build` im Ordner der Installation:

```bash
docker compose exec backend node dist/server/src/liveCheck.js
```

Der Test ist nur lesend und sparsam: Account-Liste, Region, je eine Suche mit 5 Treffern (klassisch und – falls der
Account Sales Navigator hat – Sales Navigator), 1 Profil (ohne Benachrichtigung), 1 Firmenprofil, offene Einladungen,
je Gründer-Account die Zahl der Kontakte (höchstens 3 Seiten) und offenen Anfragen, die im Dubletten-Filter mitzählen,
und – mit Anthropic-Key – 1 KI-Bewertung, mit Meta-Token außerdem die Meta-Werbebibliothek für die gefundene Firma.
Er zeigt Anfragen, Treffer und gekürzte Rohdaten mit den echten Feldnamen.
Keine Vernetzungsanfragen, keine Nachrichten.

### Tracking-Liste (bereits angeschriebene Leads)

In der Lead-Suche unter dem Formular **„Tracking-Liste hochladen“** die Outreach-Tracking-Excel wählen. Alle
LinkedIn-Profil-Links aus allen Blättern werden übernommen (mit Setter, Blatt und Status); Treffer, die dort stehen,
landen im Dubletten-Filter als „Bereits im Tracking · Nick · July 2026 · Angenommen“. Gespeichert wird nur dieser
Profil-Index, nicht der Rest der Datei – im Docker-Volume `lead-search-data`, also auch nach Neustarts und Updates.
„Aktualisieren“ lädt eine neuere Fassung, „Entfernen“ löscht den Index.

Hinweis: Sales-Navigator-Links (`/sales/lead/…`) lassen sich nur im Sales-Navigator-Modus zuordnen; alle normalen
Profil-Links (`/in/…`) in beiden Modi.

Verwendete Unipile-Endpunkte (alle aus der Unipile-Dokumentation): `GET /api/v1/accounts`,
`GET /api/v1/linkedin/search/parameters`, `POST /api/v1/linkedin/search`, `GET /api/v1/users/invite/sent`,
`GET /api/v1/users/{id}`, `GET /api/v1/linkedin/company/{id}`. Meta: `GET https://graph.facebook.com/{version}/ads_archive`
(Ad Library API, mit `ad_type=ALL`, `ad_reached_countries=["DE"]`, `ad_active_status`, `search_terms`).

### Deal Value, Meta-Ads von Hand, {{metapause}} (11.10.)

- **Deal Value:** Im Lead-Panel unter „Daten“ je Lead in ganzen Euro (`PATCH /api/leads/:id` `dealValue`, Verlauf
  „Deal Value: 25.000 €“). Das Dashboard zeigt unter „Überblick“ den **offenen Deal Value** (alle Leads außer
  „Verloren“) mit Balken je Stufe, filterbar nach Gründer.
- **Meta-Ads von Hand:** Solange kein Meta-Token eingetragen ist, prüft die Lead-Suche keine Anzeigen. Im Lead-Panel
  „Meta-Ads: Nie geschaltet | Aus (seit Datum) | Läuft“ eintragen – „Aus“ macht den Lead zur **Reactivation**: andere
  Erstnachricht (Vorlagen R…) statt Greenfield (G…), Score wird neu gerechnet.
- **Notiz aus → Vorlagen ausgegraut:** Ist die Notiz zur Vernetzungsanfrage aus (`INVITE_NOTE=off`), ist die Kategorie
  „Vernetzungsanfrage“ unter Einstellungen → Vorlagen ausgegraut mit Hinweis, dass sie nicht verwendet wird.
- **Platzhalter `{{metapause}}`** in Vorlagen: „seit rund 4 Monaten“ (bzw. Wochen/Jahre, ohne Datum „seit einiger
  Zeit“) – gedacht für die Reactivation-Erstnachricht.
- **Sperre für Vernetzungsanfragen:** „Vernetzungsanfragen pro Tag (Sperre)“ (`LINKEDIN_INVITES_PER_DAY`, Standard 20,
  Einstellungen → Senden über LinkedIn) und „in 7 Tagen“ (`LINKEDIN_INVITES_PER_WEEK`, 80) gelten je Account (seit 12.10.,
  mit Account-Wechsel siehe oben) jetzt auch
  für von Hand eingetragene Anfragen: Ist die Zahl erreicht, lehnt der Server weitere ab (429 `invite_limit`), die Karte
  „Neuer Lead“ sperrt „Vernetzen“ mit Hinweis – bis morgen.
- **Angenommene Anfragen automatisch:** Der Abgleich (alle `LINKEDIN_SYNC_MINUTES`, Standard 15, und beim Öffnen des
  Cockpits) prüft über Unipile die neuesten Kontakte jedes Gründer-Accounts und setzt eingetragene Anfragen auf
  „Vernetzt“ – seit 11.10. **auch wenn von Hand gesendet wird** (`LINKEDIN_ACTIONS` aus), nur lesend. Voraussetzung:
  Unipile eingerichtet und der LinkedIn-Account des Gründers unter Einstellungen → Senden über LinkedIn zugeordnet.
  Der Knopf „Anfrage angenommen“ bleibt nur als Notlösung.
- **Nur eingetragene Anfragen nachsenden:** Wurde mit „von Hand“ „Anfrage eintragen“ geklickt, ohne auf LinkedIn zu
  senden, stehen die Leads in „Anfrage gesendet“, obwohl nichts rausging. Einstellungen → Senden über LinkedIn →
  „Nur eingetragene Anfragen nachsenden“ listet sie (Stufe „Anfrage gesendet“, nicht über das Cockpit gesendet) und
  setzt die gewählten zurück auf „Neu“: Sie kommen wieder als „Neuer Lead“ in den Tagesstapel, die alte Buchung wird zur
  Notiz und zählt nicht mehr gegen Tageslimit und Dashboard. Vorher „Echt über LinkedIn senden“ einschalten.
- **Senden von Hand vs. echt:** Ist „Echt über LinkedIn senden“ (`LINKEDIN_ACTIONS`) aus, trägt der Tagesstapel
  Anfragen und Nachrichten nur ein – auf LinkedIn geht nichts raus (die Karte sagt das jetzt deutlich). Die
  Test-Anfrage unter Einstellungen sendet dagegen immer echt.

### KI-Vorprüfung (11.10.)

Rückmeldung des Kunden: von 50 Treffern 0 passend, nur 15 wirklich angesehen. Ursache: Die Position filtert den
Jobtitel, das **Stichwort** sucht LinkedIn aber im ganzen Profil – „Geschäftsführer“ + „Kapitalanlage“ oder
„Vermögensaufbau“ findet vor allem Finanz- und Versicherungsberater. Deshalb jetzt:

1. **Suche:** bis `SEARCH_HITS_PER_RUN` Treffer (Standard 400, mindestens Profile pro Lauf). Seit 12.10. zählt die
   Warteliste (im letzten Lauf zurückgestellte Treffer) mit: Sie kommt zuerst dran (ohne erneute KI-Vorprüfung), neu
   gesucht wird nur der Rest. Nach dem Lauf lässt sich jeder aussortierte Lead von Hand qualifizieren. Alle Kombinationen aus Stichwort × Position reihum
   (erst Seite 1 jeder Kombination, dann Seite 2 …), höchstens 200 Suchseiten je Lauf (bei 400 Treffern 80). Die Region wird jetzt nach Namen
   gewählt (auch Deutschland ↔ Germany), nicht mehr blind der erste Vorschlag von LinkedIn.
2. **Dubletten-Filter** wie bisher.
3. **KI-Vorprüfung:** Die KI sieht nur Name, Headline und Ort aus der Suche (Pakete à 40, kein LinkedIn-Aufruf) und
   sortiert klar Unpassendes aus („Vorprüfung: …“, Status `screened_out`) – Versicherung, Finanzberatung, Makler,
   Hausverwaltung, falsche Region. Im Zweifel bleibt ein Treffer drin. „Passt vermutlich“ wird zuerst gelesen.
   Fällt die Vorprüfung aus, läuft die Suche ohne sie weiter.
4. **Profil lesen** (im Trichter früher „angereichert“): nur das LinkedIn-Profil + Firmenseite über Unipile, kein
   Treg/Clay. „Profile pro Lauf“ (bis 1000) und die Grenzen je LinkedIn-Account am Tag – das sind die
   Profilbesuche, die LinkedIn sieht. Über welchen Account gesucht wird: Einstellungen → LinkedIn (Unipile) →
   „Such-Account der Lead-Suche“ (setzt `UNIPILE_ACCOUNT_ID`, „Account ändern“ in der Lead-Suche führt dorthin).
5. KI-Einstufung und Meta-Ads wie bisher.

Trichter: Treffer → ohne Dubletten → vorgeprüft → Profil gelesen → passend → ohne Meta-Ads.
**Tipp:** Stichwörter wie „Vermögensaufbau“ ziehen fast nur Finanzberater an – lieber weglassen.

**Vorlagen des Kunden (12.10.):** Standard sind jetzt die Outreach-Nachrichten des Kunden – „Meta Ads nie“ Option 1/2
(G1/G2), „Meta Ads aus seit“ (R1, dazu R2 als Kurzvariante), Follow-up 1–3 (je eine). Neuer Platzhalter `{{metastopp}}`
(„vor rund 4 Monaten“). Schon in der Software geänderte Vorlagen bleiben; „Zurücksetzen“ übernimmt die neuen Texte.

**Start-Dialog (12.10.):** „Suche starten“ öffnet einen Dialog mit Profile pro Lauf und den Einstellungen der
Lead-Suche (Suchtreffer, Mindestsicherheit, Ohne KI qualifizieren, Verteilung); „Jetzt suchen“ speichert sie (gelten auch
für spätere und automatische Suchen) und startet.

**Qualifizierung günstiger und weniger streng (12.10., Kunde: „sortiert krass viele aus, die es worth it sind“, „für 1 €
30 Leads“):** Der KI-Prompt war „streng, im Zweifel nicht qualifiziert, unter 0.6 immer false“ – „Mindestsicherheit der
KI“ wirkte nach unten deshalb nicht. Jetzt schätzt die KI ausgewogen, die Schwelle legt nur `QUALIFY_MIN_CONFIDENCE`
fest. Neu `AUTO_QUALIFY_TERMS` (Einstellungen → Lead-Suche → „Ohne KI qualifizieren“): Steht ein Stichwort in Headline,
Position oder Firmenname eines Entscheiders und kein Gegenbeleg (Versicherung, Finanzberatung, Makler, Hausverwaltung …),
gilt der Lead ohne KI-Aufruf als qualifiziert (nur live; Meta-Ads werden trotzdem geprüft). Haiku 5.5 bekommt jetzt
`effort: low` (vorher gar keinen Wert → Standard „medium“).

**Suchgedächtnis (11.10., Nutzer: „findet jedes Mal dieselben Kunden“):** LinkedIn sortiert eine Suche immer gleich –
früher fing jeder Lauf wieder bei Seite 1 an. Jetzt merkt sich der Server (nur live, Migration 28):
- **Wo jede Suchanfrage steht** (Cursor, Tiefe bis 100 Seiten): Der nächste Lauf blättert dort weiter. Ausgeschöpfte
  Anfragen ruhen 30 Tage, dann fangen sie vorne an. Ein abgelaufener Cursor → die Anfrage beginnt neu, kein Abbruch.
- **Mehr Suchanfragen:** außer Stichwort × Position auch Stichwort im **Firmennamen** × Position („… Projektentwicklung
  GmbH“) und bei Deutschland/Österreich dieselben Suchen **je Bundesland** (LinkedIn zeigt je Suche nur die ersten
  Treffer). Teilregionen, die LinkedIn nicht kennt, werden übersprungen.
- **Ertrag je Anfrage:** neue Treffer, „passt vermutlich“ (Vorprüfung), qualifiziert. Seite für Seite kommt die Anfrage
  dran, die am meisten verspricht – unbekannte vor ausgelaugten, ergiebige vor allen. 12 Seiten am Stück ohne neuen
  Treffer: unbekannte Anfragen gelten für den Lauf als gesättigt; noch einmal 12 → Schluss.
- **Geprüfte Profile aller Läufe** (auch von Hand, 90 Tage) zählen nicht zur Trefferzahl („In einem früheren Lauf
  bereits geprüft“) und werden nie zweimal gelesen.
- **Warteliste:** Was wegen „Profile pro Lauf“ zurückgestellt wurde, bekommt der nächste Lauf zuerst (14 Tage).

### Lernen aus Lead-Qualität (13.10.)

Der Scraper wird mit jeder Rückmeldung treffsicherer – ohne Training, ab dem nächsten Lauf:

- **Automatisch (ohne Klick):** Leads, die interessiert antworten oder eine Frage stellen, einen Termin vereinbaren oder
  ans CRM übergeben werden, zählen als „passt“.
- **Von Hand (ein Klick):** Im Lead-Panel unter „Lead-Qualität bewerten“ → **Passt / Passt nicht**, bei „Passt nicht“
  optional ein Grund (Makler, Finanzberater, kein Entscheider …). Nochmal klicken nimmt es zurück. „Qualifizieren“ in der
  Ergebnisliste der Lead-Suche zählt als „passt“. Von Hand geht vor automatisch.
- **Wirkung:** Die KI-Bewertung und die Vorprüfung bekommen die jüngsten 24 Rückmeldungen (je Hälfte passt/passt nicht)
  als Beispiele mit – nur Headline, Position, Firma, Branche und Urteil, ohne Namen. Die Suche merkt sich, welche
  Suchanfrage (Stichwort × Position × Region) welches Profil fand: Anfragen mit „passt“ kommen öfter dran, „passt nicht“
  drückt sie nach hinten. Mehrkosten: die Beispiele liegen im zwischengespeicherten Teil des Prompts.
- **Dashboard → Lernen:** Beispiele für die KI, passt/passt nicht, Trefferquote je Woche, ergiebige Suchanfragen und
  Hinweise (z. B. „Stichwort X bringt bei ‚Ohne KI qualifizieren‘ mehrfach Finanzberater“). Hinweise setzt die Software
  nicht selbst um.
- **Datenschutz:** Rückmeldungen gehören zum Lead und werden mit ihm gelöscht (sofort oder nach `LOST_DELETE_DAYS`).

### Automatische Lead-Suche

Je Gründer ein Zeitplan (Wochentage + Uhrzeit, optional eine **2. Uhrzeit** für zwei Läufe am Tag, eigenes
Suchprofil, an/aus), den Gründer selbst und Admins ändern (`/api/auto-search*`, Vertrag `shared/autoSearch.ts`).
Mitarbeiter sehen ihn nicht.

- **Wann:** Der Server prüft alle 20 Sekunden, ob die geplante Minute da ist – Uhrzeit immer in **Europe/Berlin**,
  Sommer-/Winterzeit wird berücksichtigt (fällt die Uhrzeit in die übersprungene Stunde Ende März, entfällt der Lauf
  an diesem Tag; die doppelte Stunde Ende Oktober löst nur einmal aus).
- **Tagesziel (08.10.):** Optional „x qualifizierte Leads pro Tag, höchstens y Suchläufe“ (im Einrichtungs-Assistenten
  oder unter Einstellungen → Automatische Suche). Nach jedem erfolgreichen Lauf startet nach 5 Minuten Pause der
  nächste, bis x Leads im Tagesstapel sind oder y Läufe gelaufen sind (je Lauf so viele Profile wie eingestellt, Suchläufe pro Tag bis 100). Schluss
  für den Tag, wenn ein Lauf kein ungeprüftes Profil mehr fand (Suche ausgeschöpft), nach 3 Läufen am Stück ohne neuen
  Lead (seit 11.10.; vorher schon nach einem), bei Fehler oder LinkedIn-Limit und
  beim Tageslimit an Profilabrufen. Gezählt wird für den Tag des Termins, auch wenn ein Lauf über Mitternacht geht.
  „Jetzt einmal ausführen“ zählt mit und sucht seit 22.10. genauso bis zum Tagesziel weiter (auch bei ausgeschaltetem
  Zeitplan, gezählt ab dem Klick). Ohne Ziel: ein Lauf je Termin bzw. Klick.
  In der Pause zwischen zwei Läufen zeigt „Nächster Lauf“ „Sucht weiter – heute, 12:10“ (seit 22.10.).
  „Neue Leads pro Tag“ (`NEW_LEADS_PER_DAY`) ist etwas anderes: die Zahl der Karten im Tagesstapel.
- **KI-Tagesbudget (11.10., Wunsch des Nutzers: „nach so viel Geld abbrechen, nicht nach so vielen Läufen“):** Je
  Zeitplan „KI-Tagesbudget in €“ (Standard 10 €, 0 = ohne – dann gilt wieder „höchstens y Suchläufe“). Mit Budget
  sucht der Server weiter, bis das Tagesziel erreicht oder das Budget aufgebraucht ist (höchstens 100 Läufe). Ein
  Lauf liest keine weiteren Profile mehr, sobald das Budget erreicht ist („KI-Tagesbudget erreicht – beim nächsten
  Lauf dran“, die Treffer kommen auf die Warteliste); ist es schon vorher aufgebraucht, wird der Termin übersprungen
  und „Jetzt ausführen“ meldet es. Gezählt werden die KI-Kosten der automatischen Läufe des Gründers.
- **KI-Kosten im Dashboard (11.10.):** Jeder Aufruf der Claude-API (Vorprüfung, Einstufung, Textvorschläge,
  Antworten auswerten) wird mit den Token aus der Antwort gezählt und mit den Listenpreisen des Modells in Euro
  umgerechnet (Migration 29, `AI_USD_EUR_RATE`). Das Dashboard zeigt (jede Minute neu berechnet) den Durchschnitt **je
  qualifiziertem Lead** (alle KI-Kosten ÷ Leads aus der Lead-Suche seit Beginn der Aufzeichnung) und **je
  abgeschlossenem Lead** (÷ davon in „Übergeben“), dazu Monat, Gesamt, je Zweck und wie oft der offene Deal Value die
  Kosten deckt. Eine Schätzung – maßgeblich bleibt die Rechnung in der Anthropic-Konsole.
  **Guthaben leer** (Anthropic antwortet 400 „credit balance is too low“): Der Lauf bricht mit „Anthropic-Guthaben
  aufgebraucht“ ab (Neuigkeit in der Glocke), liest keine weiteren Profile, die offenen Treffer kommen beim nächsten Lauf
  zuerst dran. Abhilfe: console.anthropic.com → Plans & Billing, am besten automatisches Aufladen. Die
  Simulation zeigt Beispielwerte.
- **Profilabrufe am Tag:** Es bremsen nur die Grenzen je LinkedIn-Account (Einstellungen → LinkedIn-Accounts), gesucht
  wird reihum in der eingestellten Reihenfolge. Sind alle Accounts voll, endet der Lauf mit „Tageslimit aller
  LinkedIn-Accounts erreicht“ und die Suche hört für heute auf. Die frühere gemeinsame Grenze
  `AUTO_SEARCH_PROFILES_PER_DAY` (aus der Zeit mit einem Such-Account) gibt es seit 31.10. nicht mehr – ein Wert in
  `.env` oder in den Einstellungen wird ignoriert.
- **Warum heute Schluss war:** Hört die Suche vor dem Tagesziel auf, steht der Grund unter dem Tagesziel (alle
  LinkedIn-Accounts voll, KI-Budget, Läufe, Suche ausgeschöpft, mehrere Läufe ohne Lead).
- **Ohne KI keine automatische Suche:** Fehlt im echten Betrieb der Anthropic-Schlüssel (`.env` und Einstellungen),
  starten geplante Läufe nicht („übersprungen“ + Neuigkeit) – sonst würden dieselben Profile jeden Tag unbewertet neu
  abgerufen. Bleiben die Leads eines Laufs überwiegend unbewertet (Anthropic nicht erreichbar) und kommt kein Lead
  dazu, steht der Lauf als „fehlgeschlagen: KI-Bewertung fehlgeschlagen …“ da (Neuigkeit), ohne Folgeläufe.
- **Kein Nachholen:** Ist der Server zur geplanten Zeit aus (Update, Neustart), fällt der Lauf aus – der nächste
  kommt am nächsten geplanten Tag. Ein Neustart in derselben Minute startet nicht doppelt. Wartete ein fälliger
  Termin beim Neustart noch (Suche belegt), steht er danach als „übersprungen – Server wurde neu gestartet“ da.
- **Was passiert:** dieselbe Suche wie von Hand (Profile pro Lauf wie eingestellt, Pausen 3–8 s, Abbruch bei Limit-/Zugangsfehlern,
  immer nur ein Lauf gleichzeitig). Qualifizierte Leads landen direkt im Tagesstapel des Gründers (mit
  `LEAD_DISTRIBUTION=balanced` auf beide Gründer verteilt, siehe oben), im Verlauf mit „Automatische Suche“. Profile, die eine automatische Suche schon geprüft hat, werden 90 Tage lang nicht noch einmal
  abgerufen und zählen bei der Suche nicht mit – sie blättert dafür weiter (höchstens 200 Suchseiten je Lauf, klassisch je
  Kombination bis zu 10 Seiten). Dasselbe gilt für Treffer, die die KI-Vorprüfung aussortiert hat. Läuft gerade eine andere Suche, wartet der Termin bis zu 30 Minuten, sonst „übersprungen“. Sind beide
  Gründer zur selben Zeit dran, laufen sie nacheinander.
- **Kontingent:** Jeder Lauf kostet Unipile-/LinkedIn-Abrufe (bis zu 200 Suchseiten + bis zu `maxResults` Profile) sowie
  Anthropic-Aufrufe – tägliche Läufe beider Gründer zählen gegen dieselben Grenzen der LinkedIn-Accounts. Die Grenzen je Account
  stellst du unter Einstellungen → LinkedIn-Accounts ein.
- Live-Modus nicht vollständig eingerichtet → der Lauf steht als „fehlgeschlagen“ mit dem Grund im Zeitplan.

## Lokal entwickeln

```bash
npm install && npm install --prefix server
npm run dev:all       # Frontend http://localhost:5173 + Backend :8787 (liest ../.env)
# oder getrennt:  npm run server:dev   und   npm run dev
npm run build         # Produktions-Build nach dist/
npm run typecheck     # Frontend + Backend
npm run server:test   # Backend-Tests (Pipeline, Validierung, Live-Adapter gegen nachgebaute Unipile-/Anthropic-Server)
npm run test:e2e      # Playwright-Durchlauf inkl. Lead-Suche (startet Backend im Mock-Modus selbst)
npm run verify        # alles, was die CI prüft (verify:backend + verify:frontend)
```

### Mit zwei Claude-Agents parallel (Frontend + Backend)

Das Repo ist so aufgeteilt, dass zwei Claude-Agents gleichzeitig arbeiten können, auch mit verschiedenen
Claude-Accounts: einer am Frontend, einer am Backend. Regeln für die Agents: `CLAUDE.md` (lesen sie automatisch).
Einrichtung und Startnachrichten für dich: [`docs/agents/README.md`](docs/agents/README.md).
Lagebild, wer gerade woran arbeitet: `npm run agents:status`.

## Bedienung

- **Login:** Mit Backend-Login (ab Roadmap Phase 1) melden sich Nick und Johannes mit Name und Passwort an, auf Wunsch
  „angemeldet bleiben“. Läuft die Sitzung ab, erscheint wieder die Anmeldung, danach geht es weiter. Ohne Backend-Login
  (`/api/auth/me` liefert 404, nur lokale Entwicklung) bleibt die Auswahl: Nick oder Johannes wählen. Jeder sieht nur seine eigenen
  Aufgaben, Nachrichten enden mit seiner Grußformel.
- **Einstellungen:** Konto-Menü oben rechts (Admins und Gründer). Die erste Seite zeigt **alle** Bereiche auf einmal
  (Suche auch nach einzelnen Werten), ein Klick → Bereich → Unterseite: **Auf einen Blick** (was fehlt), **Outreach**
  (Lead-Suche, Automatische Suche, Senden über LinkedIn mit Accounts und Test-Nachricht, Tagesstapel, Vorlagen),
  **Verbindungen** (Unipile, KI, Meta, Firmendaten, Close und Slack – je mit „Verbindung testen“) und **System**
  (Software-Update, Sicherungen, Server und Anmeldung, Verlauf). Neue Version: Knopf „Update“ ganz oben, ohne Passwort.
  Jede Seite gleich aufgebaut: oben ein großer Knopf (z. B. „Verbindung testen“), darunter nur die wichtigen Werte,
  Schalter gelten sofort; alles Technische steht unter „Erweitert“. Werte gelten nach dem Speichern sofort;
  Schlüssel nur mit Passwort und danach nie wieder sichtbar. Server-Werte gelten erst auf Probe.
  **Sicherungen**: anlegen, herunterladen und wiederherstellen – Herunterladen und Wiederherstellen mit Passwort. Einziger Notweg, falls die Seite gar nicht
  mehr erreichbar ist: `SETTINGS_SAFE_MODE=true` in der `.env`.
- **Vorlagen:** Einstellungen → „Vorlagen“ (oder im Dashboard „Vorlagen bearbeiten“). Alle Texte (Notiz zur
  Anfrage N1, Erstnachrichten G1/G2/R1/R2, Follow-ups F1A–F3B) mit Vorschau, Platzhaltern zum Einfügen und
  „Zurücksetzen“. Unbekannte Platzhalter und zu lange Notizen werden vor dem Speichern gemeldet. Die Karten im
  Tagesstapel füllen diese Texte aus: Erstnachricht passend zur Zielgruppe des Leads (Greenfield oder Reactivation),
  Follow-ups je Stufe; gemeldet wird die ID der Vorlage (Auswertung im Dashboard).
- **Konto einrichten:** Ein Einladungslink (`…/einladung#…`, erzeugt unter „Konten“) öffnet
  „Konto einrichten“: Passwort zweimal eingeben, danach ist man angemeldet. Der Link gilt einmal und läuft ab.
- **Automatische Suche:** Einstellungen → „Automatische Suche“ (Gründer: eigener Plan, Admin: beide).
  Wochentage, Uhrzeit (deutsche Zeit) und Suchprofil; der Server sucht dann selbst, neue Leads landen direkt im
  Tagesstapel („von Automatische Suche“ im Verlauf). „Jetzt einmal ausführen“ startet sofort; die Startseite zeigt den
  nächsten Lauf. **Zielgruppen-Mix (seit 27.10., vorher 70/30 mit Bauträgern):** Jeder Lauf sucht nur eine Zielgruppe –
  Kapitalanlage-Vertriebe oder Finanzdienstleister, keine Bauträger mehr. Der Anteil steht im Regler „Zielgruppen-Mix“
  (10er-Schritte, Standard 50 % = im Wechsel). Die Stichwörter des Profils werden dafür aufgeteilt
  (Finanz-Begriffe wie „Finanzdienstleister“, „Finanzvertrieb“, „Allfinanz“ für FDL-Läufe, der Rest ohne Bauträger-Begriffe
  für Kapitalanlage). Die Seite zeigt, wen der nächste Lauf sucht.
- **Zielgruppe (Kundengespräch 27.10.):** Mittelgroße Kapitalanlage-Vertriebe und Finanzdienstleister (FDL) mit
  Geschäftsführung – keine Einzelberater, keine Konzerne (DVAG, Swiss Life Select, MLP, OVB … sortiert eine feste Liste
  zusätzlich zur KI aus). Bauträger nur noch mit eigenem Vertrieb. Die manuelle Suche hat dafür ein Dropdown
  „Zielgruppe“ (Beide · Kapitalanlage-Vertriebe · Finanzdienstleister), auch im Start-Dialog. Vorlagen gibt es je
  Segment: Kapitalanlage (Kundentexte) und Finanzdienstleister (eigene Erstnachrichten und Follow-ups 1–3, Entwürfe ohne
  Zahlen – Fallstudien unter Einstellungen → Vorlagen ergänzen); eigene Vorlagen bekommen beim Anlegen „Für: …“.
  Aufwärm-Accounts schicken ihre Anfragen je zur Hälfte an Finanzdienstleister und an die übrigen Leads.
  Entscheider: am besten die Geschäftsführung, sonst hohe Entscheidungsträger (Prokurist, Vertriebsdirektor, Head of
  Sales); Berater, Mitarbeiter und Teamleiter fliegen raus. **Firmen-Dubletten:** Steht schon jemand derselben Firma im
  Cockpit (jede Stufe, auch „Verloren“, Vergleich über Firmenname ohne Rechtsform und Website-Domain) oder wurde ein
  Lead der Firma gelöscht, fliegt jeder weitere Kontakt als „Gleiche Firma schon im Cockpit“ raus; je Lauf zählt nur
  der erste qualifizierte Kontakt einer Firma.
- **Antworten direkt in der Antwort-Karte:** selbst schreiben oder „Antwort vorschlagen“ (KI) – der Vorschlag landet
  im Antwortfeld und lässt sich anpassen. „Antwort senden“ (über LinkedIn) bzw. „als gesendet eintragen“. Danach ist die
  Antwort-Aufgabe erledigt, bis die Person wieder schreibt.
- **Chats:** eigener Reiter in der Kopfleiste – alle Gespräche wie in einem Messenger (neueste zuerst, Punkt = Antwort
  offen). Rechts der Verlauf mit Eingabefeld: eigene Nachricht senden bzw. eintragen oder eine Antwort von LinkedIn
  eintragen. Seit 25.10. standardmäßig **alle** Chats beider Accounts; „Aktiv“ zeigt nur Chats, in denen der Lead
  mindestens einmal geantwortet hat; darunter wechselt man zwischen den LinkedIn-Accounts. An jedem Chat steht der
  Account, über den er wirklich läuft (der, über den die Anfrage ging – nicht zwingend der Besitzer).
- **Aktive Gespräche nachfassen (25.10.):** Hat ein Lead einmal geantwortet und kam die letzte Nachricht von dir, steht
  er nach `FOLLOWUP_AFTER_DAYS` (2) Tagen wieder unter den Follow-ups – und danach alle 2 Tage wieder, ohne Höchstzahl,
  bis er antwortet oder als verloren markiert ist (Termin ausgenommen).
- **Eigene Spalten im Leads-Board:** „+ Eigene Spalte“ (z. B. „Meeting Close“), Leads per Ziehen hineinlegen (die Stufe
  bleibt), umbenennen, löschen. Ohne Maus: im Lead-Panel „Spalte im Board“. In Stufen-Spalten lässt sich nur nach
  „Termin“ und „Verloren“ ziehen – die übrigen Stufen ändern sich über die Aufgaben.
- **Board frei anordnen (22.10.):** Fährt man über einen Spaltenkopf, erscheinen ‹ › (Spalte nach links/rechts) und der
  Stift (umbenennen) – für alle Spalten, auch Stufen wie „Antwort“. Die Funktion der Stufe bleibt, nur Name und Platz im
  Board ändern sich (leerer Name = Standardname). Gilt für alle Konten; Mitarbeiter können nur ansehen.
- **Verloren = Archiv (22.10.):** Verlorene Leads stehen nicht mehr im Board oder in der Tabelle (auch nicht in eigenen
  Spalten). Die kleine Spalte „Verloren“ zeigt nur „N archiviert · ansehen“ – dort wie in „Zuletzt gelöscht“ suchen und
  „Wieder öffnen“. Auf „Verloren“ ziehen markiert weiter als verloren. Schreibt ein verlorener Lead wieder, holt ihn der
  Chat-Abgleich von selbst zurück (Stufe Antwort, Aufgabe). „Übergebene zeigen“ im Ansicht-Menü blendet Übergebene ein.
- **Follow-up → Spalte (22.10.):** Wird für einen Lead im Antwort-Bereich (Antwort, Termin oder schon in einer eigenen
  Spalte) ein Follow-up geplant – im Lead-Panel, mit „Später“ (W) oder über Claude –, steht er **sofort** in der eigenen
  Spalte mit „Follow“ im Namen (z. B. „Follow Up“) und kommt am Tag wieder in die Aufgaben. Plan entfernen holt ihn
  zurück in seine Stufe. Leads vor einer Antwort bleiben in ihrer Stufe (eigene Spalten zählen im Dashboard als Antwort).
- **Einstellungen:** oben „Auf einen Blick“ – was noch fehlt, welche Schlüssel gesetzt sind, wie viel gesucht und
  gesendet wird; ein Klick springt zum Feld. Abschnitte sind als Zugang (Schlüssel), Grenzen und Regeln oder System
  gekennzeichnet.
- **Aussortiert in der Lead-Suche:** In der Liste steht ein kurzer Grund („Falsche Branche“, „Einschätzung zu unsicher“),
  beim Aufklappen unter „Warum aussortiert“ die Erklärung. Die Prozentzahl der KI ist die Sicherheit ihrer Einordnung –
  90 % „Makler“ heißt: ziemlich sicher die falsche Branche, nicht „passt zu 90 %“.
- **Rollen:** **Admin** (kein eigener Tagesstapel): im Konto-Menü „Aufgaben von Nick/Johannes“ wählen, Entscheidungen
  nur eintragen, nichts über LinkedIn senden. **Gründer:** wie bisher, dazu Einstellungen und alle Konten. **Mitarbeiter:** arbeitet den Stapel seines
  Gründers ab und sendet in dessen Namen, ohne Einstellungen; Leads anderer Gründer nur ansehen. Im Verlauf steht bei
  fremden Buchungen „von Anna für Nick“.
- **Konten:** Konto-Menü → „Konten“ (Admins und Gründer). „Konto einladen“ erzeugt einen Link zum Weitergeben (jede
  Rolle); je Konto „Neuer Passwort-Link“ und „Entfernen“. Das letzte Admin- oder Gründer-Konto bleibt immer.
- **Startseite:** zeigt nur, wie viele Aufgaben heute anstehen, und den Button **„Aufgaben für heute abarbeiten“** (oder `↵`).
  Über die kleinen Zahlen darunter („3 Antworten“, „5 neue Leads“ …) lässt sich gezielt nur eine Aufgabenart abarbeiten.
- **Fokus-Modus:** Jede Aufgabe füllt den ganzen Bildschirm, unten stehen immer genau zwei Entscheidungen.
  Alternativ die Seite wie eine Karte **nach rechts (Ja) oder links (Nein) wischen** – mit Maus, Trackpad oder Finger.
  `↵` (oder `→`) Ja / Senden / Vernetzen · `←` Nein / Nicht senden / Kein Interesse · `1`/`2` Vorlage bzw. Variante (`3` eigene Nachricht) ·
  `E` bearbeiten · `V` Verlauf · `S` Antwort heute überspringen · `Z` rückgängig · `Esc` zurück zur Startseite.
  In der Close-Vorschau `↵` übergeben (im Notizfeld `⌘/Strg + ↵`). Im Textfeld `⌘/Strg + ↵` senden.
- **Antwort und Close:** Die Antwort-Karte zeigt oben die Einschätzung der Antwort und eine kurze Zusammenfassung des
  Verlaufs. „An Close übergeben“ legt den Lead in Close an, optional mit Notiz. Für Leads mit Termin geht das im
  Lead-Panel (Haupt-Aktion bzw. unter „•••“), danach steht oben der Link nach Close. Ohne Close-Schlüssel kopierst du die
  Angaben und trägst die Übergabe nur ein.
- **Speichern:** Jede Entscheidung wird nach **5 Sekunden** gespeichert – so lange geht `Z` (die Leiste in der Meldung
  läuft ab; über die URL `?undo=2` änderbar). Beim Schließen der Seite oder Abmelden geht sie sofort raus, offline
  wartet sie und wird nachgetragen; eine Wiederholung bucht der Server nur einmal. „Nicht senden“ und „Heute
  überspringen“ nehmen die Aufgabe bis Mitternacht aus dem Stapel – auf allen Geräten, `Z` hebt es wieder auf.
- **Leads:** alle Leads aus der Datenbank als **Board** (eine Spalte je Stufe) oder **Tabelle**; „Meine“/„Alle“,
  sortiert nach „Länger nichts passiert“ oder Score, Suche nach Name und Firma. Klick öffnet das Lead-Panel.
- **Lead-Panel** (Klick auf den Namen, Redesign 15.10., öffnet im Vollbild – am Desktop zweispaltig): oben Chips (Score, Lead-Typ, Kontaktgrad, LinkedIn,
  Werbebibliothek, Close) und die **Statuskarte** (Stufe, Schritt x von 7, was als Nächstes zu tun ist). Drei Reiter:
  **Übersicht** (Warum dieser Lead, Daten – nächster Schritt, Deal Value, Meta-Ads, Hiring, Zuständig – und
  Lead-Qualität), **Verlauf** (neuester Eintrag oben) und **Analyse** (Score mit ICP-Teilen, Hard-Filter, **„Firmendaten
  holen“**). Unten die **eine Haupt-Aktion** der Stufe (z. B. „Anfrage gesendet“, „Antwort eintragen“), daneben Notiz
  und „•••“ mit allem anderen (Nachricht, Termin, Übergabe, verloren, an den anderen Gründer übergeben, Export,
  Löschen). Bearbeitet wird in Sheets. Am Desktop per Tastatur: ↵ Haupt-Aktion, N Notiz, M weitere Aktionen, 1–3 bzw. V
  Reiter, Esc schließt erst das Sheet, dann das Panel. Gilt sofort, ohne Rückgängig-Fenster; solange eine
  Entscheidung zum Lead noch nicht gespeichert ist, wartet das Panel darauf.
- **Senden über LinkedIn (Phase 3):** Mit `LINKEDIN_ACTIONS=on` gehen „Vernetzen“ und
  „Senden“ (nach dem Rückgängig-Fenster) über den LinkedIn-Account des angemeldeten Gründers. Die Startseite zeigt die
  Tageszähler, eine Pause oder „außerhalb der Arbeitszeit“ und „Jetzt abgleichen“ (angenommene Anfragen, neue
  Antworten); lehnt das Backend ab (Limit, Pause …), kommt die Karte mit dem Grund zurück.
- **Ohne LinkedIn-Aktionen** (Standard, oder kein Account verbunden): Das Cockpit sendet nichts selbst – die Knöpfe
  heißen „Anfrage eintragen“, „Als gesendet eintragen“, Nachrichten lassen sich kopieren, jede Karte verlinkt das
  LinkedIn-Profil.
- **Lead-Suche:** Suchprofil prüfen → `↵` startet. Der Trichter zählt live hoch, darunter sieht man je Lead den aktuellen
  Schritt. Am Ende steht die Ergebnistabelle mit Kategorie, Sicherheit und Begründung der KI. Seit 25.10. speichert der
  **Server** die Qualifizierten am Ende des Laufs selbst in den Tagesstapel (auch nach Abbruch) – kein Klick, kein
  Rückgängig-Fenster, nichts geht beim Neuladen verloren. `↵` startet sie direkt im Fokus-Modus.
- **Lead-Historie:** auf den Namen der Person klicken.
- **Dashboard:** echte Zahlen aus dem Verlauf aller Leads (`GET /api/dashboard`) – drei Ansichten (Überblick,
  Templates, Nick vs. Johannes), filterbar nach Gründer, letzte 8 Wochen mit Vergleich zur Vorwoche. Jede gespeicherte
  Entscheidung zählt sofort mit.

## Inhalte anpassen

| Was | Datei |
| --- | --- |
| Nachrichtentexte | in der Software: Einstellungen → Vorlagen (Standardtexte: `server/src/messages/defaults.ts`; `src/data/templates.ts` nur noch für die Test-Leads) |
| Gründer, Grußformeln | `src/data/founders.ts` |
| Erfundene Test-Leads der automatischen Tests (Quelle des Seeds im Backend, `server/scripts/buildDemoSeed.ts`) | `src/data/leads.ts` |
| Simulierte Treffer der Lead-Suche (nur Tests) | `server/src/adapters/mock/mockData.ts` |
| Einlesen der Tracking-Liste | `server/src/tracking/tracking.ts` |
| Prompt der KI-Qualifizierung | `server/src/qualify/prompt.ts` |
| Voreinstellungen des Suchprofils, Kategorien | `shared/leadSearch.ts` |
| Farben, Schrift | `src/index.css` (`@theme`) |

Alle Personen und Firmen der Testdaten (`src/data/`, `server/src/adapters/mock/`) sind frei erfunden.
