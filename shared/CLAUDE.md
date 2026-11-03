# Vertrag zwischen Frontend und Backend

`leadSearch.ts` (Lead-Suche), `auth.ts` (Anmeldung), `leads.ts` (Leads/Pipeline), `scoring.ts` (Lead-Score), `tasks.ts` (Tagesstapel), `enrichment.ts` (Clay), `settings.ts` (Einstellungen), `linkedin.ts` (LinkedIn-Aktionen), `dashboard.ts` (Kennzahlen), `messages.ts` (Vorlagen, KI-Vorschläge), `autoSearch.ts` (automatische Lead-Suche), `learning.ts` (Lernen aus Lead-Qualität), `crm.ts` (Übergabe an Close), `system.ts` (Sicherungen, Updates), `assistant.ts` (KI-Assistent), `mcp.ts` (MCP-Server für die Claude-App) und `notifications.ts` (Neuigkeiten) werden von **beiden** Seiten
importiert (Vite und Node) – Änderungen hier treffen immer beide Agents.

- Ohne Imports und ohne Laufzeit-Abhängigkeiten halten (nur Typen, Konstanten, kleine reine Funktionen). Ausnahme:
  `import type` aus einer anderen Vertragsdatei, mit `.js`-Endung (z. B. `leads.ts` → `./leadSearch.js`).
- **Nur additiv:** neue optionale Felder, neue Konstanten/Hilfsfunktionen. Umbenennen, Entfernen oder Bedeutung
  ändern nur nach Ankündigung im Handoff und Zustimmung des Nutzers.
- Eigener Commit `contract: …`, danach `npm run typecheck` (prüft Frontend **und** Backend). Bricht die andere
  Seite, dort nur den minimalen Fix machen, damit es kompiliert.
- In deiner Handoff-Datei unter „Vertragsänderungen“ eintragen: was, warum, ab welchem Branch/PR.
- Neue HTTP-Routen oder geänderte Antworten zusätzlich in der API-Tabelle in `PLAN.md` nachtragen.
