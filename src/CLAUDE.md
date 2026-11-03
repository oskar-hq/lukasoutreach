# Frontend-Agent

Gilt für alles in `src/`, `tests/`, `public/` und die Frontend-Konfiguration in der Wurzel (siehe Tabelle in
`/CLAUDE.md`). Die Regeln dort (Rollen, Vertrag, Git, Handoff) gelten zusätzlich.

## Stack
React 19 · Vite 8 · TypeScript · Tailwind CSS v4 (Tokens per `@theme` in `src/index.css`) · `motion/react`
(`MotionConfig reducedMotion="user"`) · lucide-react · Recharts.

## Design – `DESIGN.md` ist verbindlich
- Schwarz & Weiß, Akzent `#2997ff` nur für Hervorhebungen, nie flächig. Weißer Primär-Button.
- Eine Haupt-Aktion pro Bildschirm. Typografie statt Kästen.
- Bewegung nur über `transform`/`opacity`, kurz; `prefers-reduced-motion` respektieren.
- Tastatur zuerst: ↵ Haupt-Aktion · ← ablehnen · Esc zurück · Z rückgängig. Kürzel sichtbar auf den Buttons.
- Texte Deutsch, „du“. Mobil (390 px) und Desktop (1440 px) prüfen – keine horizontale Scrollleiste.
- **Jedes Feature auch als iOS-Web-App** (Home-Bildschirm): Tab-Leiste unten, Safe Areas über `--safe-*`/`--nav-*`/
  `--app-h` aus `src/index.css`, nie feste Leistenhöhen. Regeln: `DESIGN.md` → „Mobil = native iOS-App“.

## Aufbau
- `src/components/leadSearch/` – Modul Lead-Suche (Formular, Trichter, Live-Liste, Ergebnistabelle).
  `status.ts` übersetzt `LeadStatus` in Beschriftung, Ton und Schritt.
- `src/lib/leadSearchApi.ts` – **die einzige Stelle, die mit dem Backend spricht** (fetch + EventSource/SSE).
- `src/state/demo.tsx` – Zustand der Demo (Reducer). Übergebene Leads werden zu Karten im Tagesstapel.
- `src/data/` – erfundene Demo-Daten des Cockpits. `src/components/stack|lead|dashboard|ui` – restliches Cockpit.
- Typen aus `shared/leadSearch.ts` importieren, nicht nachbauen.

## Arbeiten
- `npm run dev:all` startet Vite + Backend im Mock-Modus. Entwickle immer gegen die Simulation, nie gegen Live.
- Braucht die Oberfläche Daten, die das Backend noch nicht liefert: Wunsch in `docs/agents/frontend.md` unter
  „Brauche von der anderen Seite“ (Feldname, Typ, Bedeutung, Beispielwert). Optional darf das Frontend das Feld
  selbst additiv und *optional* in `shared/` anlegen (`contract: …`) und tolerant damit umgehen, solange der Mock es
  noch nicht liefert – Befüllen in Mock und Live macht das Backend.
- Neue `LeadStatus`-Werte vom Backend: in `status.ts` (`VIEWS`, `RANK`) und ggf. im Trichter ergänzen.

## Tests
- E2E mit Playwright in `tests/*.spec.ts`; der Test startet Backend (Mock, `MOCK_SPEED=0.15`) und Vite-Preview selbst.
- `npm run verify:frontend` vor jedem PR. Ändert sich Verhalten, Tests anpassen – nie Tests löschen, um grün zu werden.
- Optische Kontrolle: Screenshots per Playwright bei 1440 × 900 und 390 × 844.

## Nach dem Fertigstellen – immer, auch bei kleinen Änderungen (Wunsch des Nutzers)
1. **Screenshots** aller geänderten Ansichten bei 1440 × 900 und 390 × 844 ansehen (Mock-Backend, Playwright):
   Layout, keine horizontale Scrollleiste, Design laut `DESIGN.md`.
2. **Eigenes Code-Review** des ganzen Diffs mit frischem Blick (`/code-review` o. Ä.): Randfälle, Annahmen über das
   Backend gegen dessen Code prüfen, Befunde beheben, verify erneut laufen lassen.
3. **CI abwarten**, bis sie auf dem PR grün ist (PR beobachten, Fehler beheben) – erst dann „fertig“ melden.
4. Dem Nutzer sagen, was davon geprüft wurde und was nicht.
