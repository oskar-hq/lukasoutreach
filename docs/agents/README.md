# Zwei Claude-Agents parallel: Frontend + Backend

Anleitung für dich (Mensch). Die Regeln für die Agents stehen in `/CLAUDE.md`, die lesen sie automatisch.

## So ist das Repo aufgeteilt

- **Frontend-Agent:** `src/`, `tests/`, Vite/Playwright-Konfiguration, `DESIGN.md`
- **Backend-Agent:** `server/`, `.env.example`
- **Vertrag dazwischen:** `shared/leadSearch.ts` + HTTP-API. Änderungen nur additiv, als eigener kleiner PR.
- **Abstimmung:** Jeder Agent führt seine Handoff-Datei (`frontend.md` / `backend.md` hier im Ordner). Beim
  Sitzungsstart bekommt jeder automatisch ein Lagebild: was der andere gerade macht und ob er den Vertrag ändert.
- **Sicherheitsnetz:** Will ein Agent eine Datei des anderen ändern, fragt Claude Code dich vorher.
  Bei jedem Pull Request prüft die CI auf GitHub beide Seiten inklusive Browser-Tests.

## Einmalig einrichten

1. **GitHub-Zugriff für beide Claude-Accounts.** Der GitHub-Nutzer hinter jedem Account braucht Zugriff auf
   `oskar-hq/lukasoutreach` (Mitglied der Organisation oder Collaborator). In jedem Claude-Account unter
   claude.ai/connect-github GitHub verbinden.
2. **Rolle festlegen (empfohlen).** In Claude Code im Web für jeden Account die Umgebung öffnen: das Umgebungsmenü in
   der Titelleiste der Sitzung, dann „Edit“. Dort eine Umgebungsvariable anlegen:
   - Account A: `AGENT_ROLE=frontend`
   - Account B: `AGENT_ROLE=backend`

   Gilt ab der nächsten neuen Sitzung. Ohne die Variable funktioniert alles auch, nur fragt Claude Code dann nicht
   nach, wenn ein Agent in den Bereich des anderen schreiben will.
3. **Lokal statt im Web?** Nie beide im selben Ordner. Getrennte Ordner per Worktree, dann mit Rolle starten:
   ```bash
   git worktree add ../Scraper-frontend -b frontend/start origin/main
   git worktree add ../Scraper-backend  -b backend/start  origin/main
   cd ../Scraper-frontend && AGENT_ROLE=frontend claude
   cd ../Scraper-backend  && AGENT_ROLE=backend claude
   ```
   Laufen beide Dev-Server gleichzeitig, bekommt einer andere Ports:
   `API_PORT=8788 WEB_PORT=5174 npm run dev:all`.

## Startnachrichten zum Kopieren

**Frontend-Sitzung:**
> Du bist der Frontend-Agent laut CLAUDE.md. Lies src/CLAUDE.md und das Lagebild. Aufgabe: …

**Backend-Sitzung:**
> Du bist der Backend-Agent laut CLAUDE.md. Lies server/CLAUDE.md und das Lagebild. Aufgabe: …

## Ablauf bei einem Feature, das beide Seiten braucht

1. **Backend zuerst, klein:** neues Feld im Vertrag + Simulation liefert es → PR `[contract] …` → du sagst „merge“.
2. **Dann parallel:** Das Backend baut den Live-Teil, das Frontend baut die Oberfläche gegen die Simulation.
3. Jeder öffnet seinen PR gegen `main`. Sobald die CI grün ist, sagst du „merge“.
4. Muss ein Agent dem anderen etwas sagen, schreibt er es in seine Handoff-Datei und gibt dir einen Satz zum
   Weiterleiten. Direkt miteinander reden können zwei verschiedene Accounts nicht.

Den aktuellen Stand siehst du jederzeit mit `npm run agents:status`.

## Server aktualisieren

Der Server zieht weiterhin `main`. Nach einem Merge wie gewohnt:
`git pull && docker compose up -d --build`.
