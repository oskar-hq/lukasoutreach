# Plan – LinkedIn Outreach Cockpit (Demo)

Frontend (React) mit Backend (`server/`): Tagesstapel, Leads und Verlauf in der Datenbank, Demo-Daten nur in der Simulation.

## Stack
- React 19 + Vite + TypeScript, Tailwind CSS v4
- `motion` für Karten- und Panel-Animationen, `recharts` für das Dashboard, `lucide-react` für Icons
- Schrift: System-Font (SF Pro auf dem Mac), Inter als gebündelter Fallback
- Auslieferung: Docker (Node-Build → nginx), `docker-compose.yml`

## Datenstruktur (`src/data`, `src/state/types.ts`)
- `founders.ts` – Nick und Johannes inkl. Grußformel
- `templates.ts` – **alle Nachrichtentexte als Konstanten** (Erstnachricht A/B/C, Follow-up A/B/C je Stufe 1–3) mit Platzhaltern `{{vorname}}`, `{{firma}}`, `{{stelle}}`, `{{thema}}`, `{{grussformel}}`
- `leads.ts` – 30 erfundene Leads. Jeder Lead gehört genau einem Gründer und steht an einer Stelle der Pipeline (`lead` → `first` → `followup` → `reply`). Daraus entsteht genau eine Karte pro Lead. Zwei Antworten kommen erst per Slack-Ping dazu.
  - Lead: Name, Position, Firma, Branche, Region, Signal (Meta Ads / Stellenanzeige), KI-Zusammenfassung, KI-Einschätzung inkl. Begründung
  - Verlauf: welches Template, welche Follow-ups, Antworten des Leads – Nachrichten und Timeline werden daraus mit relativen Zeitstempeln erzeugt
- `dashboard.ts` – 16 Wochen Tageswerte je Gründer aus einem festen Zufalls-Seed (8 Wochen sichtbar, der Rest für Vorperioden-Vergleiche)

## Zustand (`src/state/`)
- `demo.tsx` – `useReducer` + Context: Gründer, Ansicht, Filter, **Stapel der Sitzung** (Aufgaben aus
  `GET /api/tasks`, Reihenfolge, Entscheidungen mit Speicherstand, abgelehnte und veraltete Aufgaben),
  Verlauf je Lead (`GET /api/leads/:id`, Zwischenspeicher mit `updatedAt`), Slack-Ping, Panel, Lead-Suche.
  Eine `epoch` (Anmeldung, Abmeldung, Zurücksetzen) verwirft verspätete Antworten.
- `cockpit.tsx` – Verbindung zum Backend: Laden und Aktualisieren (alle 60 s, beim Zurückkehren, nach dem
  Speichern), Entscheidungen, Übergabe aus der Lead-Suche, „Demo zurücksetzen“, Slack-Ping (Simulation).
- `outbox.ts` – Ausgangskorb: Entscheidungen gehen erst nach dem Rückgängig-Fenster (5 s) an
  `POST /api/leads/:id/events` (bzw. die Übergabe an `POST /api/leads`), je Lead nacheinander, beim Schließen der
  Seite per `keepalive`, offline wartend mit Wiederholung. Eingetragene Meldungen tragen eine `clientId` (Aufgabe +
  Stand des Leads), der Server bucht Wiederholungen nur einmal; über LinkedIn prüft er vorher, ob die Aktion schon
  angekommen ist. „Rückgängig“ = Auftrag streichen, solange er nicht gestartet ist.
- Zuordnung Entscheidung → Aktion: Vernetzen `invite_sent`, Nicht geeignet `lost`, Erst-/Follow-up-Nachricht
  `message_sent` (Vorlage/Variante als `label`), Übergabe nach Close `handed_over`, Kein Interesse `lost`,
  Nicht senden / Heute überspringen `POST /api/leads/:id/snooze` bis Mitternacht (Ortszeit), `Z` → `DELETE`.

## Komponenten
Minimalistisches Prinzip: pro Bildschirm genau eine Sache.

- `pages/Login` – Auswahl Nick / Johannes
- `layout/TopNav` – Navigation (Aufgaben, Dashboard), Nutzer, Reset; `DemoBadge` unten links
- `stack/HomeView` – Startseite: Anzahl offener Aufgaben, ein Button „Aufgaben für heute abarbeiten“
- `stack/FocusView` – Fokus-Modus ohne Navigation: schlanke Kopfleiste (Beenden, Fortschritt, Filter),
  darunter immer genau eine Aufgabe als ganze Seite, Übergangsanimation zur nächsten, „Erledigt“-Seite
  - `LeadCard`, `FirstMessageCard`, `FollowUpCard`, `ReplyCard` – je eine Seite mit zwei Entscheidungen unten
  - `MessageEditor` (Textfeld mit farbig hinterlegten Variablen), `ChatThread`, `CloseExportModal`
  - `ActivityToasts` („wird gesendet…“ → „Gesendet ✓“, mit Rückgängig; im Fokus-Modus in der Kopfleiste)
- `lead/LeadPanel` – Seitenpanel mit vollständiger Timeline
- `slack/SlackToast` – simulierter Slack-Ping nach ~20 s
- `dashboard/*` – Überblick (KPIs, Verlauf, Funnel), Templates, Nick vs. Johannes

## Tests
Playwright-Durchlauf: Login → Startseite → alle Aufgaben per Tastatur → „Erledigt“ → Slack-Ping → Reset.

---

# Modul „Lead-Suche“

Ziel: im Kunden-Call zeigen, wie neue Leads (GF/Inhaber von Kapitalanlage-Vertrieben und Bauträgern in
Deutschland, ohne bestehende Verbindung) automatisch gefunden, gefiltert, qualifiziert und in den Tagesstapel
gelegt werden. Neu ist ein kleines Backend – API-Keys liegen ausschließlich dort.

## Dateistruktur

```
shared/leadSearch.ts          Gemeinsame Typen + Konstanten (Frontend und Backend nutzen dieselbe Datei)
shared/auth.ts · leads.ts     Vertrag Anmeldung (Phase 1) und Leads/Pipeline (Phase 2)
shared/scoring.ts             Vertrag Lead-Score (Scoring v1: ICP, Hard-Filter, Meta-Evidenz, Lead-Typ)
shared/tasks.ts               Vertrag Tagesstapel (Phase 5: fällige Aufgaben je Gründer, „braucht Aufmerksamkeit“)
server/                       Backend: Node.js 22 + TypeScript + Fastify
  src/index.ts                Start (Port 8787)
  src/app.ts                  Fastify-App mit allen Routen (für Tests ohne Port startbar)
  src/config.ts               Umgebungsvariablen lesen + prüfen
  src/db/database.ts          SQLite (node:sqlite) im DATA_DIR: cockpit.db + Migrationen
  src/db/backup.ts            Tägliche Sicherung (VACUUM INTO) nach DATA_DIR/backups · src/backupCli.ts sofort
  src/auth/                   Anmeldung: Konten, Sitzungen, Begrenzung der Fehlversuche, Routen /api/auth/*
  src/accountsCli.ts          Server-Befehl: Konten anlegen, Passwort ändern, entfernen
  src/leads/                  Leads + Verlauf in SQLite, Routen /api/leads/*, Demo-Leads für die Simulation
  src/scoring/score.ts        Scoring v1 (regelbasiert, erklärbar) – in der Lead-Suche und beim Speichern
  src/tasks/dailyTasks.ts     Tagesstapel aus den Leads (Regeln: Follow-up-Abstand, Tageslimit, Exploration)
  src/pipeline/adapter.ts     Schnittstelle LeadSearchAdapter (Adapter-Pattern) + AdapterError
  src/pipeline/runner.ts      Die Pipeline – in beiden Modi identisch
  src/pipeline/runStore.ts    Läufe im Speicher + Event-Abos (Server-Sent Events)
  src/qualify/schema.ts       Zod-Schema der KI-Ausgabe + strenge Qualifizierungsregel
  src/qualify/prompt.ts       Prompt für die KI-Qualifizierung
  src/adapters/mock/          Simulation: 40 erfundene Treffer, simulierte Verzögerungen
  src/adapters/live/          Unipile-Client, Live-Adapter, Anthropic-Qualifizierer, Meta-Werbebibliothek
  src/ads/metaAds.ts          Meta-Ads-Auswertung (eigene Anzeigen vs. Fremdtreffer, aktiv/beendet/keine)
  src/tracking/tracking.ts    Tracking-Excel einlesen; Index in der Datenbank (Dubletten-Quelle)
  test/                       node:test (Pipeline, Schema, Live-Adapter gegen Fake-Server)
  Dockerfile
src/components/leadSearch/    Frontend-Modul (Seite, Formular, Trichter, Live-Liste, Ergebnistabelle)
src/lib/leadSearchApi.ts      HTTP + EventSource zum Backend
nginx.conf                    leitet /api/ an den Backend-Container weiter (SSE ungepuffert)
docker-compose.yml            frontend (nginx) + backend, .env nur für das Backend
.env.example                  Vorlage für alle Variablen (.env selbst ist in .gitignore)
```

## Datenmodell (`shared/leadSearch.ts`)

| Typ | Inhalt |
| --- | --- |
| `SearchProfile` | `keywords[]`, `positions[]`, `region`, `maxResults` (1–1000, bis 11.10. 1–25) – Kontaktgrad ist fest 2./3. |
| `SearchHit` (Schritt 1) | `providerId` (LinkedIn-/Provider-ID), `publicIdentifier`, Name, `headline`, `location`, `networkDistance`, `profileUrl`, `pendingInvitation?` |
| `EnrichedProfile` (Schritt 3) | `headline`, `position`, `companyName`, `companyDescription`, `companyWebsite`, `companyIndustry`, `location` |
| `Qualification` (Schritt 4) | `category` (7 Kategorien), `qualified`, `confidence` 0–1, `reason` (1 Satz), `summary` (2 Sätze für die Karte) |
| `MetaAdsCheck` (Schritt 4b) | `state` (`none` · `stopped` · `active` · `unchecked`), eigene/aktive Anzeigen, `lastStop`, Werbetreibender, Fremdtreffer, Link in die Werbebibliothek |
| `PipelineLead` | `hit` + `status` (aktueller Schritt bzw. Endzustand) + `note` (Grund) + `profile?` + `qualification?` + `metaAds?` |
| `RunSnapshot` | Lauf: `id`, `mode`, `profile`, `status`, `phase`, `leads[]`, `funnel`, `error?`, `handedOff` |
| `RunEvent` | Server-Sent Events: `run` (Snapshot), `phase`, `leads` (geänderte Leads), `end` |
| `NewLeadCard` (Schritt 5) | Übergabe-Format für eine Karte „Neuer Lead“ im Tagesstapel |

Lead-Status: `found` → `unique` → (KI-Vorprüfung, klar unpassend: `screened_out`) → `enriching` → `enriched` → `qualifying` → `checking_ads` → `qualified` | `ads_active`
(KI sagt nein: `rejected`);
aussortiert vorher: `duplicate` (schon im Cockpit / schon geprüft), `invited` (offene Vernetzungsanfrage),
`connected` (bereits vernetzt), `deferred` (Limit pro Lauf erreicht), `failed` (Abruf fehlgeschlagen).

Trichter: **Treffer** (alle) → **nach Dubletten-Filter** → **vorgeprüft** (KI anhand der Headline, 11.10.) →
**Profil gelesen** (früher „angereichert“) → **passende Firma** (KI) →
**ohne aktive Meta-Ads** (= qualifiziert, übergabebereit) – wird immer aus den
Lead-Status berechnet (`funnelOf`), damit Zahlen und Liste nie auseinanderlaufen.

## Schnittstelle (Adapter-Pattern)

```ts
interface LeadSearchAdapter {
  mode: 'mock' | 'live';
  search(profile, ctx): Promise<SearchHit[]>;                 // Schritt 1
  pendingInvitations(ctx): Promise<Set<string>>;              // für Schritt 2
  prescreen?(hits, ctx): Promise<Map<id, PrescreenVerdict>>;  // Schritt 2b: KI-Vorprüfung nur mit Suchdaten
  pauseBeforeProfile(ctx): Promise<void>;                     // live: zufällig 3–8 s
  enrich(hit, ctx): Promise<EnrichResult>;                    // Schritt 3
  qualify(hit, profile, ctx): Promise<Qualification>;         // Schritt 4 (Rohausgabe → Zod → strenge Regel)
  checkMetaAds(hit, profile, ctx): Promise<MetaAdsCheck>;     // Schritt 4b: nur für von der KI Qualifizierte
}
```

Der `runner` ruft die Schritte nacheinander auf und ist für beide Modi identisch: Suche → Dubletten-Filter
(gegen die vom Browser gemeldeten Leads, die Leads in der Datenbank, die Tracking-Liste, bereits geprüfte Treffer,
offene Anfragen, 1. Grad) → KI-Vorprüfung (Headline/Ort, Pakete à 40, „no“ → `screened_out`) → Anreicherung
(höchstens `maxResults` Profile, „passt vermutlich“ zuerst, Rest „zurückgestellt“) → KI-Qualifizierung (läuft parallel zur nächsten Pause) →
Meta-Werbebibliothek (wer gerade Anzeigen schaltet, geht seit 07.10. markiert mit – „Aktive Meta-Ads, von Hand prüfen“) →
Übergabe. Limit-, Auth- und Konfigurationsfehler brechen den Lauf ab; bereits qualifizierte Leads bleiben übergebbar.

### HTTP-API

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/api/lead-search/config` | Modus, Voreinstellungen, Limits, ob Live-Modus vollständig konfiguriert ist |
| POST | `/api/lead-search/runs` | Lauf starten (Suchprofil + bekannte Provider-IDs aus der Demo) |
| GET | `/api/lead-search/runs/:id` | Snapshot eines Laufs |
| GET | `/api/lead-search/runs/:id/events` | Live-Fortschritt als Server-Sent Events |
| POST | `/api/lead-search/runs/:id/cancel` | Lauf abbrechen |
| POST | `/api/lead-search/runs/:id/handoff` | Schritt 5: qualifizierte Leads als `NewLeadCard[]` |
| POST | `/api/lead-search/runs/:id/leads/:leadId/qualify` | Lead nach dem Lauf von Hand qualifizieren (`ManualQualifyResponse`) |
| POST | `/api/auth/login` | Anmelden (`LoginRequest` → `AuthResponse` + Sitzungs-Cookie), Typen in `shared/auth.ts` |
| POST | `/api/auth/logout` | Abmelden, Sitzung und Cookie löschen |
| GET | `/api/auth/me` | Angemeldeter Nutzer oder 401 `unauthorized` |
| POST | `/api/auth/invite/check` | Einladungslink prüfen (`InviteCheckRequest` → `InviteInfo`, 404 `invite_invalid`) |
| POST | `/api/auth/invite/accept` | Passwort festlegen, Konto anlegen bzw. Passwort ersetzen, angemeldet (`AuthResponse`) |
| GET | `/api/accounts` | Konten (`AccountListResponse`): Admin und Gründer alle, Mitarbeiter 403 |
| POST | `/api/accounts/invite` | Einladungslink erzeugen (`CreateInviteRequest` → `{ token, expiresAt }`), auch „Passwort neu setzen“ |
| DELETE | `/api/accounts/:username` | Konto entfernen (Sitzungen enden, offene Links ungültig); nie das eigene, Testkonten oder das letzte eingelöste Admin-/Gründer-Konto (400). Lehnt auch eine offene Registrierung ab |
| POST | `/api/accounts/:username/approve` | Registrierung freigeben (`ApproveRequest`: Rolle, Gründer, bei Mitarbeitern `founders`) → `AccountInfo` |
| GET | `/api/auth/setup` | Ohne Sitzung: `SetupInfo` (`firstAccount` = noch kein Konto, wer sich registriert, wird Gründer) |
| POST | `/api/auth/register` | Ohne Sitzung: selbst registrieren (`RegisterRequest` → `AuthResponse` + Cookie). Erstes Konto Gründer mit `onboarding: 'setup'`, sonst `awaitingApproval` (alles außer `/api/auth/*` → 403 `awaiting_approval`) |
| POST | `/api/auth/onboarding/done` | Einrichtung bzw. Einarbeitung erledigt (`onboarding` → null) |
| GET | `/api/auto-search` | Zeitpläne der automatischen Lead-Suche (`AutoSearchListResponse`), Gründer eigener, Admin beide |
| PUT | `/api/auto-search/:founder` | Zeitplan speichern (`AutoSearchUpdate`, mit KI-Tagesbudget `dailyBudgetEur` und Zielgruppen-Mix `kapitalanlagePercent`) |
| POST | `/api/auto-search/:founder/run` | Jetzt einmal ausführen → 202 `{ runId }` · 409 busy |
| GET | `/api/leads` | Leads (`?owner=&stage=a,b&category=a,b&q=&limit=&offset=&sort=activity\|score\|recent&columns=1`), `columns=1` mit `stage`: zusätzlich Leads in eigenen Board-Spalten, Standard: am längsten ohne Aktivität zuerst, `recent`: zuletzt bearbeitet zuerst – Typen in `shared/leads.ts` |
| GET | `/api/leads/:id` | Lead mit Verlauf (`LeadDetailResponse`) |
| POST | `/api/leads` | Übergabe aus der Lead-Suche (`NewLeadCard[]`) → neue Leads, Dubletten je providerId übersprungen |
| POST | `/api/linkedin/chat-sync` | Chats nachträglich mit LinkedIn abgleichen (Hintergrund, `ChatSyncStatus`; `GET` = Fortschritt) – fehlende Nachrichten beider Seiten übernehmen |
| POST | `/api/leads/contact` | Persönlicher Kontakt per LinkedIn-Link (`AddContactRequest`): ein Profilabruf über den Account des Besitzers, bei 1. Grad bestehenden Chat übernehmen → 201 `AddContactResponse` · 200 schon da |
| POST | `/api/leads/:id/events` | Aktion melden (Anfrage, Nachricht, Antwort, Termin, …) → Stufe nach `LEAD_ACTION_RULES` (auch `reopened` = „Wieder öffnen“ aus Verloren/Übergeben), 409 wenn unpassend; mit `clientId` nie doppelt gebucht |
| GET | `/api/leads/unsent-invites` | Leads in „Anfrage gesendet“, deren Anfrage nicht über das Cockpit rausging (nur eingetragen) |
| POST | `/api/leads/unsent-invites/requeue` | `{ ids }` → zurück auf „Neu“ (alte Buchung wird Notiz), `{ requeued, skipped }` |
| PATCH | `/api/leads/:id` | Follow-up planen bzw. Wiedervorlage (`followUpPlan`: bis Datum pausiert, dann wieder in den Aufgaben, optional in eine eigene Spalte), Stufe von Hand (`stage`, Board – auch zurück), Antwort einordnen (`replyInterest`: interessiert/nicht interessiert), zuständigen Gründer, nächsten Schritt, eigene Board-Spalte (`boardColumn`), Deal Value (`dealValue`, Euro), Meta-Ads von Hand (`metaAds`), Hiring-Signal von Hand (`hiring`: `{ role }` bzw. `null`) oder 👍/👎 zur Lead-Qualität (`feedback`, `shared/learning.ts`) ändern |
| GET | `/api/learning` | Was der Scraper aus Rückmeldungen gelernt hat (`LearningSummary`): Beispiele für die KI, Trefferquote je Woche, beste/schwächste Suchanfragen, Hinweise |
| GET | `/api/leads/:id/export` | Auskunft (DSGVO Art. 15): alle gespeicherten Daten des Leads als JSON-Datei (`LeadDataExport`); nur Admin/Gründer |
| DELETE | `/api/leads/:id` | Sofort endgültig löschen (Art. 17, gleicher Weg wie die Frist nach „Verloren“: Fingerabdruck bleibt, Dashboard-Zahlen anonym) → `DeleteLeadResponse`; nur Admin/Gründer |
| GET | `/api/conversations` | Chats: Leads mit Nachrichten, neueste zuerst (`?owner=`), je Chat `account` (über welchen Account) und `replies` (25.10.) |
| GET/POST | `/api/board/columns` | Eigene Board-Spalten auflisten / anlegen (`{ name }`) |
| PATCH/DELETE | `/api/board/columns/:id` | Eigene Spalte umbenennen / löschen (Leads kehren in ihre Stufe zurück) |
| PUT | `/api/board/columns/order` | Reihenfolge aller Spalten `{ order }` (Schlüssel `stage:…`/`custom:…`) → `BoardColumnsResponse` mit `layout` |
| PATCH | `/api/board/columns/stage/:stage` | Eigener Name einer Stufen-Spalte `{ name }` (null/leer = Standard) → `BoardColumnsResponse` |
| GET/PUT/DELETE | `/api/linkedin/test-profile` | Test-LinkedIn-Account prüfen und speichern |
| POST | `/api/linkedin/test-message`, `/api/linkedin/test-connect` | Genau eine Test-Nachricht bzw. Test-Vernetzungsanfrage an den Test-Account |
| POST | `/api/leads/demo/reset` | Nur Tests (`LEAD_SEARCH_MODE=mock`): Test-Leads neu anlegen |
| GET | `/api/tasks` | Tagesstapel aus den Leads (`?owner=`, Standard: angemeldeter Gründer; `?owner=all` = beide Gründer, `owner: null` in der Antwort, Mitarbeiter nur mit allen Gründern) + „braucht Aufmerksamkeit“ – Typen in `shared/tasks.ts` |
| POST | `/api/leads/:id/snooze` | „Für heute überspringen“ (`{ until? }`, Standard nächster Tag) · `DELETE` hebt es auf |
| GET | `/api/enrichment/status` | Firmendaten (Treg, alternativ Clay): Quelle, Modus (`mock`/`live`/`off`), automatisch an?, Tageslimit, heute verbraucht – Typen in `shared/enrichment.ts` |
| POST | `/api/leads/:id/enrich` | Firmendaten holen (Treg: Ergebnis sofort) → 202 `LeadDetailResponse` (pending/done), 409 `enrichment_off`, 429 `enrichment_limit` |
| POST | `/api/enrichment/clay` | Rückkanal von Clay (ohne Sitzung, Header `x-cockpit-secret`) – nicht fürs Frontend |
| GET | `/api/linkedin/status` | Echte LinkedIn-Aktionen: Modus (`mock`/`live`/`off`), je Gründer Account, Limits, Pause; Arbeitszeit – Typen in `shared/linkedin.ts` |
| POST | `/api/leads/:id/linkedin/invite` | Vernetzungsanfrage echt senden (`{ message? }`) → `LeadDetailResponse`; 409/429/503 laut `LinkedInErrorCode` |
| POST | `/api/leads/:id/linkedin/message` | Erstnachricht bzw. Follow-up echt senden (`{ text, label? }`) → `LeadDetailResponse` |
| GET | `/api/assistant/models` | KI-Assistent: Claude-Modelle laut Anthropic, Standard – Typen in `shared/assistant.ts` |
| GET/POST | `/api/assistant/chats` | Chats des Kontos (neueste zuerst) bzw. neuen Chat anlegen `{ model? }` |
| GET/DELETE | `/api/assistant/chats/:id` | Chat mit Nachrichten bzw. löschen |
| POST | `/api/assistant/chats/:id/messages` | Frage `{ text, model? }` → Antwort als `text/event-stream` (start · tool · text · done/error) · 409 busy |
| POST | `/api/assistant/chats/:id/stop` | laufende Antwort abbrechen |
| GET | `/.well-known/oauth-protected-resource(/mcp)` · `/.well-known/oauth-authorization-server` | MCP-Server für die Claude-App: OAuth-Metadaten (RFC 9728/8414) – Typen in `shared/mcp.ts` |
| POST | `/api/oauth/register` · GET `/api/oauth/authorize` · POST `/api/oauth/token` | OAuth 2.1 ohne Sitzung: Client registrieren, → Freigabe `/?mcp_consent=<id>`, Tokens (PKCE S256, Refresh) |
| GET/POST | `/api/oauth/consent/:id` | Freigabe anzeigen bzw. `{ approve }` → `{ redirect }` zurück zu Claude |
| GET/DELETE | `/api/mcp/connections(/:id)` | eigene Verbindungen + Connector-Adresse bzw. trennen |
| POST | `/mcp` | MCP (Streamable HTTP, zustandslos), `Authorization: Bearer` · 401 mit `WWW-Authenticate` |
| GET | `/api/crm/status` | Übergabe an Close: Modus (`mock`/`live`/`off`), `handover` (Einstellung `CRM_HANDOVER`, false = ausgeblendet) – Typen in `shared/crm.ts` |
| POST | `/api/leads/:id/handover` | Lead an Close übergeben (`{ note?, clientId? }`) → Stufe „Übergeben“, `lead.crm`; 409 `crm_off`/`invalid_transition`, 502/429/503 |
| GET | `/api/dashboard` | Dashboard aus echten Zahlen (`?days=112`): Tageswerte je Gründer, Antwortquote je Vorlage und Follow-up-Stufe, Pipeline je Stufe, Deal Value, KI-Kosten (`aiCost`) – Typen in `shared/dashboard.ts` |
| POST | `/api/linkedin/sync` | Angenommene Anfragen und Antworten jetzt abholen → `LinkedInSyncResponse` (live zusätzlich alle 15 min automatisch) |
| GET | `/api/linkedin/accounts` | Bei Unipile verbundene LinkedIn-Accounts zur Auswahl (`LinkedInAccountsResponse`, `assignedTo` aus den Einstellungen); nur Admin/Gründer · 409 ohne Unipile-Zugang · 503 |
| POST | `/api/linkedin/test-invite` | Genau eine Test-Vernetzungsanfrage (`LinkedInTestInviteRequest`), gleiche Grenzen, Warteschlange und Pause; Simulation sendet nichts; nur der Gründer über seinen eigenen Account (Admin, Mitarbeiter, fremder Gründer → 403) |
| POST | `/api/linkedin/resume` | Pause eines Accounts aufheben (`LinkedInResumeRequest` → `LinkedInStatusResponse`); Mitarbeiter nur für seinen Gründer |
| GET | `/api/settings` | Einstellungen (Wert bzw. bei Geheimnissen nur „gesetzt · …abcd“, Quelle Software/.env/Standard) – Typen in `shared/settings.ts` |
| PUT | `/api/settings` | Einstellungen ändern (`null` = zurück zur .env), bei Schlüsseln mit Passwort, Server-Werte nur auf Probe |
| POST | `/api/settings/trial/confirm` · `/revert` | Probe-Änderung behalten bzw. sofort zurücksetzen |
| POST | `/api/settings/test` | Verbindung zu Unipile, Anthropic, Meta, Treg (ein Abruf, ca. 0,2 Cent), Close (`GET /api/v1/me/`) oder Slack (Testnachricht) mit den gespeicherten Werten prüfen |
| GET | `/api/settings/history` | Wer hat wann was geändert (ohne Werte) |
| GET | `/api/settings/models` | Claude-Modelle zur Auswahl (live von Anthropic, sonst eingebaut) |
| GET | `/api/settings/meta-recheck` | Stand der Meta-Nachprüfung aller Leads (`shared/metaRecheck.ts`) |
| POST | `/api/settings/meta-recheck` | Meta-Nachprüfung starten (202, 409 läuft schon, 400 ohne Token); startet auch beim Speichern eines neuen Tokens |
| GET | `/api/notifications` | Neuigkeiten vom Programm für dieses Konto (neueste zuerst, `unread`) – Typen in `shared/notifications.ts`; Registrierungen nur Admin/Gründer, Mitarbeiter nur für ihre Gründer |
| POST | `/api/notifications/seen` | Alles bis jetzt gilt für dieses Konto als gesehen → neue Liste |
| GET | `/api/system/backups` | Sicherungen (neueste zuerst, Art geplant/von Hand/vor dem Wiederherstellen/vor einem Update), nächster Termin, freier Speicherplatz (`disk`) – Typen in `shared/system.ts`; nur Admin/Gründer |
| POST | `/api/system/backups` | Jetzt sichern → `BackupInfo` · 409 busy |
| POST | `/api/system/backups/:name/download` | Datei mit Passwort (`{ password }`, Fehlversuche wie bei den Einstellungen) |
| POST | `/api/system/backups/:name/restore` | Mit Passwort: prüfen, Stand vorher sichern, einsetzen, Backend startet neu → 202 (Simulation: nur Hinweis) |
| GET | `/api/system/update` | Laufender und neuester Stand, Änderungen, letzter Lauf, nächster automatischer Versuch (über den Update-Dienst `deploy/updater`; Simulation ohne Dienst) |
| POST | `/api/system/update/check` | Jetzt bei GitHub nachsehen (höchstens alle 10 s) |
| POST | `/api/system/update` | Update einspielen mit Passwort (wenn `behind > 0` oder `pendingBuild`); vorher Sicherung `vor-update-…` → 202 `state: running` · 409 update_running/up_to_date/busy (Lead-Suche läuft) · 503 updater_unavailable/backup_failed |
| POST | `/api/system/settings-key` | Schlüssel für die Geheimnisse der Einstellungen mit Passwort (`SettingsKeyResponse`; aus `SETTINGS_KEY` nur der Hinweis), höchstens 5× je 15 min |
| GET | `/api/templates` | Nachrichten-Vorlagen (Standard bzw. angepasst) – Typen in `shared/messages.ts` |
| PUT | `/api/templates/:id` | Vorlage ändern (`{ text, name?, segment? }`, nur bekannte Platzhalter; `segment` nur bei eigenen) · `POST /api/templates/:id/reset` = Standardtext |
| POST | `/api/templates` | Eigene Vorlage anlegen (`{ category, text, name?, segment? }`, Segment seit 27.10.) · 409 `template_limit` ab 26 je Kategorie (A–Z) |
| DELETE | `/api/templates/:id` | Vorlage löschen → `{ ok: true }` · 409 `last_template` (die letzte einer Kategorie bleibt) |
| POST | `/api/leads/:id/suggest` | Textvorschlag (`{ kind: first\|followup\|reply, templateId? }`): live von der KI, sonst ausgefüllte Vorlage; bei `reply` mit Einschätzung der Antwort. Gesendet wird von Hand |

Ab dem Login (Roadmap Phase 1) verlangen alle `/api/*`-Routen eine Sitzung, außer `/api/health`, `/api/auth/login`,
`/api/auth/logout`, den beiden Einladungs-Routen, `/api/auth/setup`, `/api/auth/register` und dem Clay-Rückkanal (`AUTH_OPEN_ROUTES`). Ohne Sitzung: 401 `unauthorized`. Cookie, Sitzungsdauer, Begrenzung der
Fehlversuche und Testkonten (nur mit `AUTH_DEMO_ACCOUNTS=true`) stehen im Kopf von `shared/auth.ts`.

## Frontend

- **Anmeldung** (`src/state/auth.tsx`, `src/pages/Login.tsx`): Beim Start fragt die Oberfläche `/api/auth/me`.
  200 → Cockpit des zugeordneten Gründers, 401 → Anmeldeformular, 404 → Demo-Auswahl (Backend ohne Login).
  Jede 401 `unauthorized` einer geschützten Route (und eine Prüfung beim Zurückkehren in den Tab) führt zurück zur
  Anmeldung mit „Sitzung abgelaufen“. War der Server beim Start nicht erreichbar, prüft die Seite alle 5 s erneut.
  Abmelden über das Kontomenü; ist der Server dabei nicht erreichbar, bleibt die Sitzung und das Menü sagt es.
- **Einstellungen** (`src/components/settings/`, Zahnrad in der Kopfleiste, nur mit echter Anmeldung): alle Werte
  aus `shared/settings.ts`, gruppiert. Entwurf → „Speichern“ (PUT mit `version`), bei `reauth` Dialog mit Passwort,
  bei `confirm` Rückfrage, Probe-Änderungen mit Restzeit und „Behalten“, Verbindungstest je Dienst, Verlauf.
  Prüfungen wie im Backend schon im Browser (Grenzen, Adressen, `boundSecret`).
- **Registrierung und Einarbeitung** (`src/pages/Register.tsx`, `src/components/onboarding/`): Die Anmeldeseite
  fragt `/api/auth/setup`; ohne Konto gibt es nur „Gründer-Konto erstellen“, danach den Einrichtungs-Assistenten
  (`SetupWizard`, speichert über `/api/settings` und testet je Dienst). `/registrieren` öffnet das Registrieren fürs
  Team; Wartende sehen `WaitingForApproval` (fragt alle 5 s `/me`), neue Konten `WorkIntro`. Freigabe unter Konten
  (`ApproveDialog`), Mitarbeiter mit mehreren Gründern wechseln im Konto-Menü („Aufgaben von“).
- **Einladung** (`src/pages/Invite.tsx`): `/einladung#<token>` zeigt „Konto einrichten“. Das Token wird sofort aus
  der Adresse entfernt und nur im Body geschickt (`/api/auth/invite/check`, `/accept`). Nach dem Festlegen des
  Passworts ist man angemeldet und landet auf `/`.
- Neuer Menüpunkt „Lead-Suche“ (`view: 'search'`), Modus-Hinweis „Simulation“ / „Live“ in der Kopfleiste.
- Seite in zwei Zuständen: **Suchprofil** (Formular + „Suche starten ↵“) und **Lauf** (Trichter mit
  hochzählenden Zahlen, Live-Liste mit aktuellem Schritt je Lead; danach Ergebnistabelle – die Qualifizierten hat der
  Server am Ende des Laufs schon angelegt (`run.saved`, 25.10.), „Jetzt abarbeiten ↵“).
- **Cockpit aus der Datenbank:** Startseite und Fokus-Modus lesen `GET /api/tasks` (Reihenfolge vom Backend,
  neue Antworten hinter die aktuelle Aufgabe), Karten und Lead-Panel den Verlauf aus `GET /api/leads/:id`.
  Übergabe „In den Tagesstapel“ → `POST /api/leads` (gespeichert beim Weiterarbeiten, übergebene Leads zuerst),
  Ohne LinkedIn-Aktionen heißen die Knöpfe „eintragen“. (Seit 07.10. kein „Demo zurücksetzen“ mehr – echter Betrieb.)

## Live-Modus (Unipile + Anthropic)

| Schritt | Unipile-Endpunkt | Hinweis |
| --- | --- | --- |
| Account | `GET /api/v1/accounts` | nur ohne `UNIPILE_ACCOUNT_ID`: erster LinkedIn-Account |
| Region | `GET /api/v1/linkedin/search/parameters?type=LOCATION` (Sales Navigator: `REGION`) | oder `UNIPILE_LOCATION_ID` |
| 1. Suche | `POST /api/v1/linkedin/search` | `api: classic`: je eine einfache Suche pro Kombination aus einem Stichwort (`keywords`) und einer Position (`advanced_keywords.title`), dazu `location` und `network_distance: [2, 3]`; höchstens 8 Suchen pro Lauf, Treffer zusammengeführt. ODER-Verknüpfungen lieferten im echten Test nur 1 Treffer. `account_id`/`limit` in der Query, 10 Treffer pro Suche |
| 2. Offene Anfragen | `GET /api/v1/users/invite/sent` | zusätzlich `pending_invitation` aus der Suche und `invitation` aus dem Profil |
| 3. Profil | `GET /api/v1/users/{provider_id}?linkedin_sections=experience&notify=false` | aktuelle Position aus `work_experience` |
| 3. Firma | `GET /api/v1/linkedin/company/{company_id}` | Beschreibung, Website, Branche |
| 4. KI | Anthropic Messages API mit strukturierter Ausgabe (`output_config.format`, Zod-Schema) | Modell über `ANTHROPIC_MODEL` |

Quellen: Unipile-Dokumentation (developer.unipile.com) und das offizielle Unipile-Node-SDK, dessen Typen die
Antwortformate (Suchtreffer, Profil, Firma, Einladungen) festlegen.

Schutz: höchstens `MAX_RESULTS_LIMIT` (1000, bis 11.10. 25) Profilabrufe pro Lauf (Runner + Adapter), zufällig 3–8 s Pause zwischen Profilabrufen, 1,5–3 s vor
dem Firmenabruf, 2–4 s zwischen Suchseiten, nur ein Lauf gleichzeitig. 429, 401, 403 und 5xx brechen den Lauf ab;
404 bei einem einzelnen Profil betrifft nur diesen Lead.
