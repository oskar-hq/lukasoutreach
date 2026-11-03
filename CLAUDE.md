# Outreach Cockpit + Lead-Suche – Anweisungen für Claude

LinkedIn-Outreach-Cockpit, **Instanz für Lukas** (lukas.ylvalabs.de) – Kopie von `oskar-hq/Scraper`. Ziel und Umbauplan: `docs/LUKAS.md` (zu Beginn jeder Sitzung lesen).
- **Frontend:** React 19 + Vite + TypeScript + Tailwind v4, liegt in der Repo-Wurzel (`src/`, `tests/` …).
- **Backend:** Node 22 + Fastify in `server/`. Pipeline Suche → Dubletten → Anreicherung → KI → Meta-Ads → Übergabe,
  im Modus `mock` (Simulation) oder `live` (Unipile, Anthropic, Meta-Werbebibliothek).
- **Vertrag zwischen beiden:** `shared/leadSearch.ts` (Typen) und die HTTP-Routen unter `/api/lead-search/*`
  (Tabelle in `PLAN.md`).
- Details: `PLAN.md` (Architektur), `README.md` (Betrieb), `DESIGN.md` (verbindliches Design).
- **Zu Beginn jeder Sitzung lesen:** `docs/STAND.md` (wo läuft was, was ist echt/Demo, offene Punkte) und
  `docs/ROADMAP.md` (Plan von der Demo zur richtigen Software, nächste Phase).

## Zwei Agents arbeiten gleichzeitig

An diesem Repo arbeiten **zwei Claude-Agents parallel** – meist mit verschiedenen Claude-Accounts, also ohne
gemeinsames Gedächtnis und ohne direkten Draht zueinander. Einer baut das **Frontend**, einer das **Backend**.

**Deine Rolle** – in dieser Reihenfolge:
1. Was der Nutzer sagt („Du bist der Frontend-Agent“).
2. Umgebungsvariable `AGENT_ROLE` (`frontend` | `backend`).
3. Sonst: frag nach, bevor du etwas änderst.

Nenne deine Rolle zu Beginn der Sitzung in einem Satz. Lies danach die Anweisungen deines Bereichs:
`src/CLAUDE.md` (Frontend) bzw. `server/CLAUDE.md` (Backend).

Beim Sitzungsstart zeigt dir ein Hook das **Lagebild** (aktive Branches, Vertragsänderungen, Handoff des anderen).
Von Hand: `npm run agents:status`. Lies es, bevor du loslegst.

## Wem gehört was

| Bereich | Dateien |
| --- | --- |
| **Frontend** | `src/**`, `public/**`, `tests/**` (E2E), `index.html`, `vite.config.ts`, `playwright.config.ts`, `tsconfig*.json` (Wurzel), `package.json` + `package-lock.json` (Wurzel), `Dockerfile` (Wurzel), `nginx.conf`, `DESIGN.md`, `docs/agents/frontend.md` |
| **Backend** | `server/**` (inkl. Mock-Daten, Tests, `server/Dockerfile`), `.env.example`, `docs/agents/backend.md` |
| **Gemeinsam** | `shared/**` (Vertrag), `docker-compose.yml`, `README.md`, `PLAN.md`, alle `CLAUDE.md`, `scripts/`, `.claude/`, `.github/`, `docs/agents/README.md` |

- **Fremden Bereich nicht anfassen.** Brauchst du dort etwas, schreib es in deine Handoff-Datei unter
  „Brauche von der anderen Seite“ und sag dem Nutzer einen Satz zum Weitergeben.
- **Ausnahmen** (klein halten, im Handoff erwähnen):
  1. Deine Vertragsänderung bricht die Typprüfung der anderen Seite → minimaler Fix dort, nur damit es kompiliert
     (z. B. neuer Eintrag in einem `Record<LeadStatus, …>`).
  2. Backend ändert die Mock-Zahlen → die E2E-Erwartungen in `tests/` im selben Commit anpassen.
- **Gemeinsame Dateien:** nur den eigenen Abschnitt ändern, knapp, keine Umformatierung.
- Leitplanke: Ist `AGENT_ROLE` gesetzt, fragt Claude Code den Nutzer, bevor du eine Datei des anderen Bereichs
  bearbeitest (`.claude/settings.json` → `scripts/agent-scope.mjs`). Nicht über Bash umgehen.

## Der Vertrag (`shared/leadSearch.ts` + HTTP-API)

- Einzige Schnittstelle: Typen aus `shared/` und `/api/lead-search/*`. Das Frontend spricht nur über
  `src/lib/leadSearchApi.ts` mit dem Backend.
- **Nur additiv ändern:** neue *optionale* Felder, neue Hilfsfunktionen, neue Routen. Umbenennen, Entfernen oder die
  Bedeutung ändern ist ein Bruch → vorher im Handoff ankündigen und den Nutzer fragen.
- Neue Werte in Union-Typen (z. B. `LeadStatus`) brechen die Typprüfung des Frontends → Ausnahme 1 oben.
- Vertragsänderungen als **eigener kleiner Commit `contract: …`**, früh pushen und als eigenen PR zuerst mergen
  lassen, damit die andere Seite darauf aufbauen kann.
- **Der Mock-Modus gehört zum Vertrag.** Jedes neue Feld liefert auch die Simulation. Das Frontend entwickelt und
  testet nur gegen den Mock. Die Simulation ergibt stabile Zahlen: Trichter 40 → 33 → 15 → 7 → 5.
- Feature für beide Seiten: ① Backend liefert Vertrag + Mock (kleiner PR) → ② parallel: Backend baut Live,
  Frontend baut die Oberfläche gegen den Mock.

## Git-Ablauf

- **Integrations-Branch: `main`** (Standard-Branch auf GitHub, der Server zieht von dort).
  Nie direkt darauf committen.
- Jeder Agent arbeitet auf seinem **eigenen Branch**. In Claude Code im Web ist das der vorgegebene Branch, sonst
  `frontend/<thema>` bzw. `backend/<thema>`. Fremde Branches nie pushen oder force-pushen.
- Vor dem Start und vor jedem PR: `git fetch origin && git merge origin/main`.
- Klein und oft: ein PR pro abgeschlossener Sache gegen `main`. Titel beginnt mit
  `[frontend]`, `[backend]` oder `[contract]`.
- PR erst, wenn `npm run verify:frontend` bzw. `npm run verify:backend` lokal grün ist. Die CI
  (`.github/workflows/ci.yml`) prüft beide Seiten und muss grün sein. **Gemergt wird nur auf Ansage des Nutzers.**
- Keine Massen-Umformatierungen und keine Dateiumbenennungen ohne Absprache (erzeugen Merge-Konflikte).

## Abstimmung über Handoff-Dateien

- `docs/agents/frontend.md` und `docs/agents/backend.md` – **jeder schreibt nur seine eigene**, die andere liest er.
- Aktualisieren bei jedem Push: Woran ich arbeite (Branch) · Fertig (PRs) · Brauche von der anderen Seite ·
  Vertragsänderungen · Hinweise. Alte Einträge kürzen, die Datei bleibt kurz.
- `npm run agents:status` zeigt den neuesten Stand beider Dateien von allen Branches, auch vor dem Merge.

## Befehle

| Zweck | Befehl |
| --- | --- |
| Abhängigkeiten | `npm ci` (Frontend) · `npm ci --prefix server` (Backend) |
| Entwickeln | `npm run dev:all` (beides) · `npm run dev` (nur Vite, braucht Backend auf 8787) · `npm run server:dev` |
| Prüfen Frontend | `npm run verify:frontend` (Typprüfung, Build, Playwright-E2E gegen Mock-Backend) |
| Prüfen Backend | `npm run verify:backend` (Typprüfung + node:test mit Fake-Servern) |
| Alles | `npm run verify` |
| Lagebild | `npm run agents:status` |

Zwei Agents auf **einem Rechner**: getrennte Ordner (`git worktree`), nie derselbe Ordner. Andere Ports:
`API_PORT=8788 WEB_PORT=5174 npm run dev:all` und `E2E_API_PORT=8792 E2E_WEB_PORT=4176 npm run verify:frontend`.

## Regeln für beide

- Oberfläche und Meldungen auf Deutsch, Ansprache „du“. Code-Kommentare auf Deutsch wie im Bestand.
- **Secrets** nur in `.env` (nie committen, nie in Logs, Fehlermeldungen oder Chat). Beispielwerte nur in `.env.example`.
- Nur **dokumentierte** API-Endpunkte (Unipile, Anthropic, Meta). Nichts erfinden.
- Keine echten LinkedIn- oder Meta-Aktionen ohne ausdrücklichen Auftrag des Nutzers. Die Schutzgrenzen bleiben:
  Profile pro Lauf und Läufe pro Tag stellt der Nutzer selbst ein (seit 11.10. bis 1000 bzw. 100, vorher fest 25),
  3–8 s Pausen, Abbruch bei Limit- und Zugangsfehlern.
- **Fertig heißt:** verify grün, Handoff-Datei aktualisiert, `README.md`/`PLAN.md` bei geändertem Verhalten angepasst
  (nur eigener Abschnitt), PR offen, dem Nutzer in 2–3 Sätzen gesagt, was jetzt geht und was die andere Seite wissen muss.
