# Backend-Agent

Gilt für alles in `server/` sowie `.env.example`. Die Regeln aus `/CLAUDE.md` (Rollen, Vertrag, Git, Handoff)
gelten zusätzlich.

## Stack
Node 22 · Fastify 5 · zod 4 · `@anthropic-ai/sdk` · exceljs · tsx. ESM mit `NodeNext`: relative Importe immer mit
`.js`-Endung, den Vertrag über `../../shared/leadSearch.js` (Pfadtiefe beachten).

## Aufbau
- `src/app.ts` – alle HTTP-Routen (`/api/lead-search/*`, SSE unter `/runs/:id/events`).
- `src/config.ts` – Umgebungsvariablen. Neue Variable → hier, in `/.env.example` und in der README-Tabelle.
- `src/pipeline/runner.ts` – die Pipeline, **für Simulation und Live identisch**. `adapter.ts` – Schnittstelle
  `LeadSearchAdapter`, `AdapterError` (`fatal` = Lauf abbrechen).
- `src/adapters/mock/` – Simulation (40 erfundene Treffer, `mockData.ts`). `src/adapters/live/` – Unipile-Client,
  Anthropic-Qualifizierer, Meta-Werbebibliothek, Live-Adapter.
- `src/ads/metaAds.ts` – Ads-Auswertung · `src/qualify/` – Prompt + Schema · `src/tracking/` – Tracking-Excel ·
  `src/liveCheck.ts` – Verbindungstest auf dem Server (nur lesend).

## Regeln
- **Adapter-Pattern:** Jede neue Fähigkeit in **beiden** Adaptern (Mock und Live), gleiche Datenstrukturen.
- **Mock ist Vertrag:** deterministisch, Trichter 40 → 33 → 15 → 7 → 5. Ändern sich die Zahlen, im selben Commit
  `test/mockPipeline.test.ts` **und** die E2E-Erwartungen in `/tests/` anpassen und im Handoff melden.
- Neue Felder im Vertrag (`shared/`) nur additiv; immer auch im Mock befüllen, damit das Frontend dagegen bauen kann.
- **Nur dokumentierte Endpunkte** (Unipile v1, Anthropic Messages, Meta `ads_archive`). Clients schlank auf `fetch`.
- **Secrets** nie in Fehlermeldungen, Logs oder Antworten (Token schwärzen, siehe `metaAdLibrary.ts`).
- **Feste Unipile-Limits je Account und Tag** (17.10., `linkedin/accountUsage.ts` → `UNIPILE_LIMITS`): 100 Profile,
  1.000/2.500 Suchtreffer, Anfragen ≤ 80/Tag und 200/7 Tage, Nachrichten ≤ 100. Gescraped wird reihum über alle
  Unipile-Accounts, gesendet nur über die Gründer-Accounts. Gründer-Accounts scrapen zuletzt und mit halbem Limit
  (`FOUNDER_SCRAPE_LIMITS`). Nicht anheben ohne ausdrücklichen Auftrag des Nutzers. Firmenseiten nie über
  Gründer-Accounts, sondern von unten in der Such-Reihenfolge (`companyAccount`, 02.11.) – und nie weglassen:
  kein Platz mehr → Lauf stoppt, angefangener Lead auf die Warteliste.
- **LinkedIn-Schutz bleibt:** Profile pro Lauf bis `MAX_RESULTS_LIMIT` (seit 11.10. 1000 auf Wunsch des Nutzers, vorher 25), Pausen 3–8 s, `notify=false`,
  ein Lauf gleichzeitig, Abbruch bei Limit-/Zugangsfehlern. Keine Vernetzungsanfragen oder Nachrichten senden ohne
  ausdrücklichen Auftrag des Nutzers.
- Fehler für die Oberfläche verständlich auf Deutsch (`AdapterError` mit Titel + Satz, was zu tun ist).

## Tests
- `server/test/*.test.ts` mit `node:test`; Live-Tests laufen gegen nachgebaute Server (`test/fakeServers.ts`) –
  **nie echtes Netz in Tests**.
- `npm run verify:backend` vor jedem PR. Echte Verbindung prüft der Nutzer auf dem Server:
  `docker compose exec backend node dist/server/src/liveCheck.js`.
