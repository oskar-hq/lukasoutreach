# Handoff · Backend-Agent

> Nur der Backend-Agent schreibt hier. Kurz halten, bei jedem Push aktualisieren, Erledigtes nach einer Woche löschen.

## Woran ich arbeite
- **`claude/firmenseiten-von-unten` (02.11., Nutzer: „Unipile zeigt nur 50 Profile über die Main Accounts“, Backend +
  Frontend in einem)** – Ursache: Firmenseite zählt ins Profil-Limit, bei 90 also ~45 Personen. Neu `companyAccount()` im
  Live-Adapter: Firmenseiten **nie über Gründer-Accounts**, sondern von **unten** in der Such-Reihenfolge (am wenigsten
  aufgewärmt), erster mit Platz. **Nie weglassen:** vor jedem Profil muss ein Firmenseiten-Platz frei sein, sonst
  `rate_limit` „Tageslimit für Firmenseiten erreicht“ → Lauf stoppt; `profileCapacity` = min(frei ohne Gründer, alle/2);
  fällt die Firmenseite nach dem Profil aus, übernimmt der nächste Account, sonst Abbruch. Runner: bei `rate_limit`
  wird ein Lead in `enriching` `deferred` („Tageslimit erreicht – beim nächsten Lauf dran“) statt `failed`. Zählt weiter als `profile` beim jeweiligen Account.
  Abbruchtext ohne festes „50 bei den Gründern“. Kein Vertrag. Tests `accountLimits.test.ts` (2 neu).
- **`claude/laughing-darwin-1pgq8m` (31.10., Nutzer; vom Frontend-Agent mit erledigt)** – MCP: Einstellungen per Claude-App,
  `server/src/mcp/settingsTools.ts`: `find_settings` (Katalog mit Hilfe + aktuellem Wert, automatische Suche je Gründer,
  Grenzen je LinkedIn-Account, Hinweise „nur in der Oberfläche“), `change_setting` (über `PUT /api/settings` mit
  `version`; keine Geheimnisse/`reauth`/`trial`/`.env`; `confirm`-Texte erst mit `confirmed: true`),
  `change_auto_search` (Teil-Update, mischt mit dem gespeicherten Plan), `change_account_limits`. Server-Anweisungen:
  erst nachsehen, sonst „Das ist leider noch nicht gebaut. Wende dich bitte an die Entwickler.“ Kein Vertrag. Test `mcp.test.ts`.
- **`claude/sweet-fermi-de271n` (31.10., Nutzer: „Suche stoppt bei 90 Profilen, obwohl 8 Accounts frei sind“)** – Alte
  gemeinsame Tagesgrenze **`AUTO_SEARCH_PROFILES_PER_DAY` ist raus** (Planer, Config, Einstellungskatalog, `.env.example`,
  README). Profilabrufe bremsen nur noch die Grenzen je LinkedIn-Account; alle voll → Lauf `failed` „Tageslimit aller
  LinkedIn-Accounts erreicht“ → Stopp. `AUTO_SEARCH_MESSAGES.profileLimit`, `AUTO_SEARCH_STOP.profileLimit`,
  `profileBudget()` entfernt; `maxResults` wird nicht mehr gekürzt. Zähler `profileFetches` bleibt (Info).
  Test `autoSearch.test.ts` („Keine gemeinsame Tagesgrenze mehr“).
- **`claude/practical-thompson-wknjtb` (29.10., Sicherheitsprüfung auf Wunsch des Nutzers)** – ① MCP-OAuth: Rücksprungadressen
  nur noch Claude-App (`https://*.claude.ai|claude.com`) und localhost (`allowedRedirectUri`) – vorher jede https-Adresse
  (Freigabe-Phishing → Kontozugang). ② `SessionStore.deleteForUser` löscht auch `mcp_tokens` (Passwort neu/Konto entfernt
  trennt die Claude-App). ③ `npm audit fix` (fastify, zod, fast-uri – nur Lockfile). Tests `mcp.test.ts`.
- **`claude/practical-thompson-wknjtb` (28.10., Nutzer)** – Migration 45: gespeicherte Zeitpläne mit Bauträger-Stichwörtern
  bekommen die neuen Standard-Stichwörter (`DEFAULT_SEARCH_PROFILE.keywords`). Test `migration45.test.ts`.
- **`claude/practical-thompson-wknjtb` (27.10. b, Wunsch des Nutzers, Backend + Frontend in einem)** – ① **Firmen-Dubletten**:
  `leads/companyKey.ts` (Name ohne Rechtsform/Satzzeichen, Website-Domain, Selbstständige zählen nicht),
  `leadStore.companyIndex()` + `companyWasDeleted()` (Fingerabdruck `co:` beim Löschen), Runner nach dem Profilabruf:
  „Gleiche Firma schon im Cockpit · Person · Besitzer · Stufe“, „… früher ohne Interesse – gelöscht“, „… schon in diesem
  Lauf“ (je Lauf der erste qualifizierte). ② Prompts: Geschäftsführung bevorzugt, hohe Entscheider (Prokurist,
  Vertriebsdirektor, Head of Sales) erlaubt, Berater/Mitarbeiter/Teamleiter raus. ③ **Zielgruppen-Mix**:
  `AutoSearchSchedule/Update.kapitalanlagePercent` (0–100, 10er, Standard 50), Migration 44, `nextAutoSearchFocus(counts,
  percent)`. Tests `companyDuplicates.test.ts` (neu), `autoSearch.test.ts`.
- **`claude/practical-thompson-wknjtb` (27.10., Kundengespräch „neue Zielgruppe“, Backend + Frontend in einem)** –
  Bauträger raus, **Finanzdienstleister (FDL)** rein. Vertrag (`contract:`-Commit): `LeadCategory 'finanzdienstleister'`
  (qualifizierend), `SearchAudience 'finanzdienstleister'` + `SEARCH_AUDIENCE_OPTIONS`, „beide“ = Kapitalanlage + FDL,
  Presets nur GF-Positionen (`DECISION_MAKER_POSITIONS`); `AutoSearchFocus 'finanzdienstleister'`, **50/50 im Wechsel**
  (`AUTO_SEARCH_KAPITALANLAGE_TENTHS = 5`, `focusOfTerm`), Migration 43 setzt `focus_counts` zurück; `TemplateSegment`
  (`kapitalanlage | finanzdienstleister`, null = alle) an `MessageTemplate`/Create/Update + `templatesForSegment`.
  Backend: KI-Prompt + Vorprüfung (mittelgroß, GF, Bauträger nur mit eigenem Vertrieb), feste Konzern-Liste
  `qualify/targetGroup.ts` (DVAG, Swiss Life Select, MLP, OVB … → „Zu groß (Konzern)“), `quickQualify` stuft Bauträger
  nur mit Vertriebs-Hinweis ein. Vorlagen: Kundentexte = Segment Kapitalanlage, neue FDL-Entwürfe GF1/RF1/SF1/F1F/F2F/F3F,
  Spalte `message_templates.segment`, Vorschlag nimmt das Segment des Leads. Aufwärmen: Leads je zur Hälfte FDL/übrige.
  Mock: Treffer 20 ist jetzt ein FDL (Trichter unverändert). Tests `targetGroup.test.ts` (neu), `messages`, `warmup`,
  `autoSearch`, `liveAdapter`, `qualifyKeywords`.
- **`claude/dazzling-brown-e10lxk` (25.10., Kundengespräch „Frontend tut nicht, was es zeigt“, Backend + Frontend in einem)** –
  ① **Leads aus der Suche von Hand speichert der Server** am Ende des Laufs (`runner.start(…, onEnd)` → `saveRunLeads` in
  `app.ts`, vor dem Ereignis `end`): `run.saved` + `handedOff`. `StartRunRequest.owner` (optional, sonst Gründer der
  Sitzung; Admin ohne owner → wie bisher von Hand). ② **Eine Zählung für Vernetzungsanfragen**: `LinkedInGuard.usage` und
  `leadStore.invitesByAccount` zählen beide den Verlauf je Account (`sentBy`/Besitzer) plus Anfragen ohne Lead aus
  `linkedin_actions` – vorher zählte Senden nur `linkedin_actions`, Eintragen nur den Verlauf („27 von 20“).
  ③ `/api/tasks` liefert auch unter „Alle“ `invitesByAccount`, `inviteViaByOwner`, `invitesPerDayByAccount`.
  ④ **Aktives Gespräch** (`dailyTasks.ts`): Lead hat je geantwortet, letzte Nachricht von uns ≥ `FOLLOWUP_AFTER_DAYS` alt →
  `followup` mit `active: true`, alle 2 Tage neu, ohne Höchstzahl, bis Antwort/Verloren (ersetzt `conversation_quiet`).
  ⑤ `/api/conversations`: `account` (sentBy ?? owner) und `replies`. ⑥ Nachrichten-Tageslimit zählt ebenso aus dem
  Verlauf je Account. ⑦ Neue Leads pro Tag nie über dem Anfragen-Limit des Accounts (`founderStack`, „Alle“).
  ⑧ Leads aus einer Suche von Hand von früheren Tagen haben Vorrang vor automatisch gefundenen. ⑨ Echte Anfrage für
  einen übernommenen Lead scheitert → Besitzer zurück (`linkedin/routes.ts`). ⑩ Verlauf „Vernetzungsanfrage gesendet von
  X · über den Account von Y“. Tests `consistency.test.ts` (neu), `tasks.test.ts`, `autoSearch.test.ts` (manueller Lauf
  dort als Admin, sonst wären die Treffer Dubletten).
- **`claude/great-pascal-o6ef7p` (24.10. b, Wunsch des Nutzers, vom Frontend-Agent mit erledigt)** – „Meine“ = nur der eigene
  Account: gegen „Neue Leads pro Tag“ zählen alle heute angeschriebenen eigenen Leads (`invitesSince`, auch über „Alle“ oder
  den zweiten Account); übernommene Leads eines getrennten Accounts (`adoptedFrom`) nur noch unter „Alle“
  (`founderStack(…, adoptPaused)`). `shareFreeSlots` zieht heute schon verbrauchte Plätze des anderen ab.
  Tests `accountPause.test.ts`, `messages.test.ts`, `tasks.test.ts`.
- **`claude/great-pascal-o6ef7p` (24.10., Wunsch des Nutzers, vom Frontend-Agent mit erledigt)** – „Meine“ zeigt nur die
  Plätze des eigenen Accounts (`founderStack`: `newLeadsPerDay` einfach, nur eigene Anfragen zählen, `inviteAccounts: 1`).
  „Alle“ (`owner=all`) mit `LINKEDIN_ACCOUNT_FALLBACK`: `computeTasks(…, shareFreeSlots)` gibt freie Plätze eines Gründers
  den übrigen neuen Leads des anderen (Grund „· Platz von <Name>“). Senden/Account-Wechsel unverändert. Tests
  `tasks.test.ts`, `messages.test.ts`.
- **`claude/great-pascal-o6ef7p` (23.10., Wunsch des Nutzers, vom Frontend-Agent mit erledigt)** – `POST /api/system/update`
  ohne Passwort: `reauth` dort entfernt (Rolle bleibt geprüft, Sicherung vorher bleibt). `UpdateRequest.password` optional
  und ohne Bedeutung. Test `system.test.ts` angepasst.
- **`claude/festive-tesla-rf5q3l` (22.10. i, Wunsch des Nutzers)** – Follow-up → Spalte sofort: `followUpPlan` ohne `column`
  = „Follow“-Spalte (nur Antwort-Bereich), `board_column` sofort gesetzt; Plan weg → zurück aus dieser Spalte. MCP,
  „Später“ und „In 2 Wochen wieder“ lassen `column` weg. Test `boardStage.test.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. h, Wunsch des Nutzers)** – Board frei anordnen: Migration 42 `board_layout`
  (order, stage_names), `leadStore.boardLayout/setBoardOrder/renameBoardStage`, Routen `PUT /api/board/columns/order`,
  `PATCH /api/board/columns/stage/:stage`; GET/DELETE liefern `layout`. Rechte wie eigene Spalten. Tests `leads.test.ts`, `security.test.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. g, Wunsch des Nutzers)** – **MCP-Server für die Claude-App** (`shared/mcp.ts`, neu):
  `server/src/mcp/oauth.ts` (Migration 41: Clients, Anmeldeanfragen, Codes, Tokens – nur als Hash; PKCE S256, Refresh-Rotation),
  `routes.ts` (Metadaten, `/api/oauth/*`, Freigabe, `/api/mcp/connections`, `/mcp` zustandslos per Streamable HTTP),
  `tools.ts` (lesen: Aufgaben, Analyse, Gespräche, Suche, Lead; bedienen: Anfrage/Nachricht senden – echt nur mit
  LINKEDIN_ACTIONS und verbundenem Account –, Antwort, Termin, Verloren, Notiz, Wieder öffnen, Überspringen, Wiedervorlage,
  Lead ändern). Aktionen über `app.inject` mit internem Header (`auth.internalAuthHeaders`) → dieselben Routen, Rechte,
  Limits. `@modelcontextprotocol/sdk` 1.32.1. Test `mcp.test.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. f, Wunsch des Nutzers)** – **KI-Assistent** (`shared/assistant.ts`, neu): `server/src/assistant/`
  `data.ts` (Sequenz-Auswertung, Gesprächsstapel ≤ 150 mit offset, Volltextsuche, Lead-Suche, Detail – Scope wie Cockpit),
  `service.ts` (Tool-Use-Schleife mit `messages.stream`, Effort high, Prompt-Cache, `fallbacks: "default"` bei Opus 5.5 u. a.;
  API-Verlauf append-only gespeichert; Simulation ohne Netz), `store.ts` (Migration 40 `assistant_chats`/`assistant_messages`),
  `routes.ts` (`/api/assistant/*`, Antwort als SSE, `stop`). `AiPurpose` + `assistant`. Test `assistant.test.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. e, Wunsch des Nutzers)** – Ausfall eines Such-Accounts: `liveAdapter.sideline`
  (rate_limit/auth/provider/network, `SIDELINE_MS` 6 h/1 h/15 Min.) → Profilabruf und Suche (Sales Navigator und klassisch)
  mit dem nächsten Account; erst ohne freien Account Abbruch (`allDownError`, letzter Grund). `setupWarnings` nennt
  pausierte Accounts. Fake-Unipile `downAccounts`, Tests `accountLimits.test.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. d, Wünsche des Nutzers)** – **Wiedervorlage:** `followUpPlan.column` optional
  (null = nur Aufgaben), Plan ≤ 1 Jahr; bis `at` fehlt der Lead in `computeTasks` (auch attention); `releaseDueFollowUps`
  setzt `follow_up_due` (Migration 39, `CockpitLead.followUpDueAt`) und öffnet lost/handed_over wieder; fällig →
  `followup`-Aufgabe (`<id>:followup:<n>:<due>`, auch über MAX_FOLLOW_UPS), `new` → immer dabei. Erledigt mit jeder
  Aktion außer Notiz/Wieder öffnen; `message_received` löscht den Plan; `purgeLost` lässt Leads mit Plan stehen.
  **Abgleich:** `openLeads(founder, true)` – Antworten von lost/handed_over kommen an (wieder offen → Antwort-Aufgabe).
  Tests `boardStage.test.ts`, `chatSync.test.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. c, Wunsch des Nutzers „in der Pause sieht man nicht, dass er noch dran ist“)** –
  `AutoSearchSchedule.followUpAt`/`followUpManual` (optional): eingereihter Folgelauf fürs Tagesziel aus der Warteschlange
  (`planner.followUpOf`). Test in `autoSearch.test.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. b, Wunsch des Nutzers „Close-Übergabe erst einmal aus, wir nutzen das CRM im Cockpit“)** –
  Einstellung `CRM_HANDOVER` (boolean, Gruppe crm; Standard live aus, Simulation an) → `config.close.handover`.
  `GET /api/crm/status` liefert `handover`; `POST /leads/:id/handover` bei aus → 409 crm_off. `computeTasks` ohne
  `meeting_open`, wenn aus (`TaskRules.handover`). Tests `crm.test.ts`, `tasks.test.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10., Wunsch des Nutzers)** – Such-Reihenfolge auch für Gründer-Accounts: mit Platz in
  `linkedin_account_prefs` zählen sie wie Scraping-Accounts (`liveAdapter.founderAtEnd`, Liste in `service.withPrefs`,
  `position` jetzt auch für Gründer); ohne Platz weiter zuletzt. Ihre halben Standard-Grenzen bleiben (unter „Grenzen“ änderbar).
  „Jetzt einmal ausführen“ (`planner.runNow`) sucht wie ein Termin bis `dailyTarget` weiter (`manualChains`, gezählt ab
  dem Klick, auch bei ausgeschaltetem Plan, Folgeläufe mit `manual: true`). Tests `accountLimits.test.ts`, `autoSearch.test.ts`.
- **`claude/accounts-aufwaermen` (21.10., Wunsch des Nutzers)** – Accounts aufwärmen: `linkedin/warmup.ts` (`WarmupService`, Takt 1 Min,
  zufällige Abstände in der Arbeitszeit, Anlauf `WARMUP_RAMP` 6/10/14, Deckel `LINKEDIN_WARMUP_PER_DAY` ≤ 17, nur live mit
  LINKEDIN_ACTIONS). Ziele: Leads + `tracking_profiles` (Profil per `GET /users/{id}`, notify=false), je Person einmal
  (Migration 37 `warmup_invites`, `warmup_pauses`). `GET /api/linkedin/warmup`, `LinkedInUnipileAccount.warmup`,
  Einstellungen `UNIPILE_WARMUP_ACCOUNTS`/`LINKEDIN_WARMUP_PER_DAY`. Mock-Account `mock-scraper`. Test `warmup.test.ts`.
  **Dazu (21.10. b):** Grenzen + Reihenfolge je Account – `linkedin/accountPrefs.ts` (Migration 38 `linkedin_account_prefs`),
  `PUT /api/linkedin/accounts/:id/limits`, `PUT /api/linkedin/accounts/order`; Account-Liste in Such-Reihenfolge mit
  `position`, `limits`, `limitDefaults`. Wirkt in `liveAdapter` (Reihenfolge, Profil-/Suchgrenze), Guard + `inviteLimits`
  (`perDayFor`) und Aufwärmen. Tests `accountLimits.test.ts`, `warmup.test.ts`.
- **`claude/vernetzt-zuruecksetzen` (20.10. e, Wunsch des Nutzers)** – `PATCH { stage }` von „Vernetzt“ nach „Anfrage gesendet“/„Neu“
  löscht die `invite_accepted`-Ereignisse des Leads (Dashboard zählt die falsche Annahme nicht mehr). Test `boardStage.test.ts`.
- **`claude/vernetzt-pruefen` (20.10. d, Meldung des Nutzers „Lead auf Vernetzt, Anfrage auf LinkedIn noch ausstehend“)** –
  `importChatMessages`: eigene Nachricht bei Stufe „Anfrage gesendet“ (Notiz zur Anfrage, InMail) setzt **nicht** mehr
  `invite_accepted` und wird nicht als gesehen gemerkt – Vernetzt nur noch über `GET /users/relations`; danach kommt die
  Nachricht beim nächsten Abgleich. `POST /events { invite_accepted }` bleibt für Tests/API. Test `chatSync.test.ts`.
- **`claude/followup-chat-404` (20.10. c, Meldung des Nutzers „jedes Follow-up: Profil oder Unterhaltung nicht gefunden“)** –
  `message()`: 404 auf `POST /chats/{chatId}/messages` → gemerkte `chatId` verwerfen, neu über `POST /chats` mit der
  `providerId` (neue `chatId` gemerkt, keine Pause). Andere Fehler unverändert. `classify().log` nennt jetzt Pfad und
  Unipile-`detail` (z. B. `HTTP 404 errors/… bei /chats/x/messages: …`). Test in `linkedin.test.ts`.
- **`claude/wonderful-pasteur-koa2lt` (20.10. b, Wunsch des Nutzers „alles ab Antwort im Board zählt als geantwortet“)** – Dashboard `isReply`:
  `message_received`, `meeting_booked`, `handed_over`, `stage_changed` nach Antwort/Termin/Übergeben **oder** in eine eigene
  Spalte (`label = BOARD_COLUMN_LABEL`, neu bei `PATCH boardColumn` und eingelöstem Follow-up). Rückwirkend:
  `loadDashboard` übergibt Leads mit Stufe Antwort/Termin/Übergeben oder `board_column` (`DashboardReplyLead`); ohne
  passendes Ereignis zählen sie am Tag der letzten Aktivität. Doku in `shared/dashboard.ts`. Tests `boardStage.test.ts`.
- **`claude/wonderful-pasteur-koa2lt` (20.10., Meldung des Nutzers „Live-Abgleich geht nicht mehr, Dashboard verzogen“)** –
  **Ursache:** Der Chat-Abgleich hatte bei ~265 Leads die `chatId` gemerkt; der Abgleich alle 10 Min fragte jeden Chat
  einzeln ab, und **ein** Serverfehler (5xx/Timeout) galt als „verstecktes Limit“ → Gründer 1 h pausiert, Abgleich
  abgebrochen – bei jedem Lauf wieder. **Jetzt:** `syncLive` holt erst `GET /chats?account_id&after=` (Aktivität seit dem
  letzten Lauf − 30 Min, nach Start 3 Tage, bis 5 Seiten), ordnet über `chatId` oder `attendee_provider_id` zu (auch von
  Hand angeschriebene Leads) und übernimmt per `importChatMessages` (beide Richtungen, ab `chatStartedAt`). Rückfall ohne
  Liste: je Lead mit Chat und Aktivität < 30 Tagen. `stopsReading()`: beim Lesen brechen nur 429/401/403 ab und pausieren;
  ein kaputter Chat wird übersprungen. Chat-Abgleich-Knopf nur noch für vernetzte Leads (Vernetzt…Termin).
  **Dashboard:** `stage_changed` trägt die Zielstufe in `label` (Migration 35 trägt sie für alte Verschiebungen nach);
  Verschiebung nach Antwort/Termin/Übergeben zählt als Antwort (`isReply`), `stage_changed` gehört zu
  `DASHBOARD_EVENT_KINDS`. **Follow-up planen:** Migration 36 `leads.follow_up_plan`, `PATCH { followUpPlan }`,
  `releaseDueFollowUps()` im `onRequest`-Hook (GET Leads/Aufgaben/Chats/Dashboard). Tests `chatSync`, `boardStage`.
- **`claude/wonderful-pasteur-koa2lt` (19.10. c, Wunsch des Nutzers nach Sperre eines Gründer-Accounts)** – Chats nachträglich abgleichen:
  `POST/GET /api/linkedin/chat-sync` (`LinkedInService.startChatSync`, Hintergrund, Fortschritt in `ChatSyncStatus`).
  Je Lead mit Gespräch (ab Vernetzt immer, sonst mit Chat/Nachricht) Chat über `chatId` oder
  `GET /chat_attendees/{provider_id}/chats`, bis 100 Nachrichten, fehlende über `applyAction` (Titel „… · aus LinkedIn
  übernommen“), Doppeltes raus (`guard.seen`, gleicher Text), verloren/übergeben nur nach letzter Aktivität, eigene
  Nachricht in „Anfrage gesendet“ → vorher `invite_accepted`. Pausen `pauseRange()` (≥ 3 s) zwischen Chats,
  Limit/Zugang → Gründer pausiert, Abbruch für ihn. Gefundene `chatId` wird gemerkt. Test `chatSync.test.ts`.
- **`claude/wonderful-pasteur-koa2lt` (19.10. b, Wunsch des Nutzers; ein Agent für beide Seiten)** – Board frei: `PATCH /api/leads/:id { stage }`
  setzt die Stufe von Hand (auch zurück, Ereignis `stage_changed` „Von Hand verschoben: … → …“, keine Dashboard-Zähler).
  Antwort geteilt: **Migration 34** `leads.reply_interest`, `PATCH { replyInterest }` (Notiz), `message_received` setzt
  zurück; sonst `replyInterestOf` (Vertrag) aus `conversation.replyIntent`. `GET /api/leads?category=` filtert nach
  `json_extract(assessment,'$.category')`. Test `boardStage.test.ts`.
- **`claude/wonderful-pasteur-koa2lt` (19.10., Wunsch des Nutzers; ein Agent für beide Seiten)** – Persönlicher Kontakt per LinkedIn-Link:
  `POST /api/leads/contact` (`linkedin/routes.ts`) liest das Profil **einmal** über den Unipile-Account des Besitzers
  (`LinkedInService.lookupContact`, nur Unipile-Zugang nötig, nicht LINKEDIN_ACTIONS), legt den Lead an
  (`LeadStore.createContact`, `origin.kind='contact'`, ohne KI; 1. Grad → `connected`, offene Anfrage → `invited`, sonst
  `new`) und übernimmt bei 1. Grad den bestehenden Chat (`importContactChat`: `GET /chat_attendees/{provider_id}/chats`
  + `GET /chats/{id}/messages`, bis 100 Nachrichten, `LeadStore.importChat` → `replied`/`contacted`, `linkedin.chatId`,
  Nachrichten als gesehen markiert – der Abgleich bucht nur neue Antworten). Dublette nach Kennung/ID → 200 `created: false`.
  `isRealLead` + `contact`; im Stapel zählen heute aufgenommene `new`-Kontakte als frisch. Test `contact.test.ts`,
  Fake-Unipile `attendeeChats`. Nicht live getestet (Chat-Endpunkt laut Unipile-v1-Doku).
- **`claude/wonderful-bell-vongu4` (18.10. b, Wunsch des Nutzers)** – `POST /api/leads/:id/linkedin/invite|message`
  senden für den **Besitzer des Leads** über dessen Account (vorher 409 `linkedin_not_owner`, wenn der andere Gründer
  klickte), `actor` = wer geklickt hat. Neuer Lead eines pausierten Gründers: der Klickende (sonst der andere) wird
  vorher Besitzer. `FounderAccounts` einmal in `app.ts`, an Lead- und LinkedIn-Routen. Tests `linkedin`, `accountPause`.
- **`claude/wonderful-bell-vongu4` (18.10., Wunsch des Nutzers; ein Agent für beide Seiten)** – Tagesstapel pausiert,
  wenn der LinkedIn-Account eines Gründers nicht verbunden ist (`linkedin/founderAccounts.ts`: nicht zugeordnet, obwohl
  ein anderer zugeordnet ist, oder bei Unipile nicht OK; Unipile nicht erreichbar → nichts pausiert; Liste 60 s im
  Speicher). Vertrag additiv (`contract:`-Commit): `TasksResponse.accountPaused?`, `DailyTask.adoptedFrom?`,
  `ACCOUNT_PAUSED_MESSAGE`. `GET /api/tasks`: pausierter Gründer → leerer Stapel; der andere bekommt dessen neue Leads in
  freie Plätze (`computeTasks(…, adopt)`, `lead.owner` im Stapel = Übernehmer), kein Fallback auf den pausierten
  Account; `owner=all` = Stapel der verbundenen Gründer. `invite_sent` auf Lead eines pausierten Gründers: Besitzer
  wechselt zu dem, der es erledigt (sonst dem anderen), Limit voll → 429 `invite_limit`. Test `accountPause.test.ts`.
- **`claude/wonderful-bell-vongu4` (17.10., Wunsch des Nutzers nach Sperre eines LinkedIn-Accounts)** – Feste
  Unipile-Limits je Account und Tag (`linkedin/accountUsage.ts`, `UNIPILE_LIMITS`, **Migration 33**
  `linkedin_account_usage`): 100 Profilabrufe (Profil + Firma), 1.000 Suchtreffer (Sales Navigator 2.500). Live-Adapter
  scrapt über **alle** startklaren Unipile-Accounts (`scrapeAccounts`/`searchAccounts`, Profil → Account mit den wenigsten
  Abrufen, Suche bleibt bis zum Limit bei einem). Runner: `adapter.profileCapacity()` begrenzt die Profile eines Laufs,
  bei 0 Abbruch `rate_limit` „Tageslimit aller LinkedIn-Accounts erreicht“, Zurückgestellte: „Tageslimit der
  LinkedIn-Accounts erreicht – beim nächsten Lauf dran“. `founderNetworks` prüft jetzt **alle** Gründer-Accounts (auch
  den, der sucht); offene Anfrage/Kontaktgrad aus Suche/Profil zählen nur bei Gründer-Accounts. Senden unverändert nur
  über Nick/Johannes; `LINKEDIN_INVITES_PER_DAY/WEEK`, `LINKEDIN_MESSAGES_PER_DAY` fest gedeckelt auf 80/200/100
  (`shared/settings.ts`: Nachrichten max. 100, Hilfetexte). Warnung „mehrere Accounts, UNIPILE_ACCOUNT_ID leer“ entfällt.
  **Gründer-Accounts geschützt:** scrapen erst, wenn die reinen Scraping-Accounts voll sind, mit halbem Limit
  (`FOUNDER_SCRAPE_LIMITS`: 50 Profile, 500/1.250 Suchtreffer). **Getrennter/gestörter Gründer-Account** (Nick gesperrt,
  Entscheidung des Nutzers): kein Zurückstellen mehr, nur Hinweis in `setupWarnings`; Abruffehler eines verbundenen
  Accounts stellen weiter zurück. Kein Vertrag geändert. Test `accountLimits.test.ts`, `founderNetworks` angepasst.
  **Für das Frontend (optional):** Einstellungen → „Such-Account der Lead-Suche“ heißt jetzt eher „zuerst genutzter
  Account“ – `searching` markiert weiter nur diesen einen; gescraped wird über alle.
- **`claude/lead-detail-implementation-b4rzt8` (16.10., vom Frontend-Agent auf Wunsch des Nutzers)** – `GET /api/tasks`
  nimmt `owner=all` (beide Gründer, `owner: null`; Mitarbeiter 403, wenn nicht für alle). Ereignisse und `PATCH` buchen
  jetzt für den **Besitzer des Leads** (`by = lead.owner`, vorher der Gründer des Kontos), `actor` = wer es war – Nick
  auf Johannes' Lead ergibt „von Nick“ für Johannes, zählt auf Johannes' Limit. Ebenso `requeue`. LinkedIn-Senden
  unverändert (`linkedin_not_owner`). Test `roles.test.ts`.
- **`claude/lead-detail-implementation-b4rzt8` (15.10. b, vom Frontend-Agent auf Wunsch des Nutzers)** – `adLibraryUrl` mit
  Seiten-ID hängt `&search_type=page&media_type=all` an (so verlinkt Facebook die Seite eines Werbetreibenden; ohne zeigte
  die Bibliothek nur das Suchfeld). `manualMetaAds(…, previous)`: von Hand eingetragener Stand behält einen schon
  gefundenen Seiten-Link samt Werbetreibendem. Kein Vertrag geändert. Tests `metaAds.test.ts`, `liveAdapter`.
- **`claude/meta-nachpruefung` (15.10., Wünsche des Nutzers; ein Agent für beide Seiten)** – Vertrag additiv (eigener
  `contract:`-Commit): `MetaAdsCheck.source?` (`company`/`person`), `MetaAdsCheck.checkedAt?`, neu `shared/metaRecheck.ts`
  (`MetaRecheckStatus`, Routen `GET/POST /api/settings/meta-recheck`). Live-Meta-Check sucht zusätzlich nach dem privaten
  Namen der Person, solange die Firma nicht gerade selbst schaltet (`personSearchTerm`, `samePerson`, `mergeAdsChecks`
  in `ads/metaAds.ts`, eine Abfrage mehr). `ads/metaRecheck.ts`: prüft alle Leads außer verlorenen und von Hand
  eingetragenen (`LeadStore.metaRecheckIds`, `setCheckedMetaAds` → Score neu, Verlaufseintrag nur bei geändertem Stand),
  1,5 s Pause, Meta-Limit → 60 min warten und weiter, Token-/Rechtefehler → `failed`. Startet automatisch, wenn in den
  Einstellungen ein neuer `META_ACCESS_TOKEN` gespeichert wird. Tests `metaRecheck.test.ts`, `liveAdapter` (Abfragen +1
  je Lead ohne aktive Firmen-Anzeigen).
- **`claude/hiring-signal` (13.10., Wunsch des Nutzers „Hiring-Signal → zugeschnittene Nachricht, Leute über Social Media
  erreichen, die man anstellen kann“; diesmal ein Agent für beide Seiten)** – Vertrag additiv (eigener `contract:`-Commit):
  `LeadHiring` (`role`, `source` profile/ai/manual, `evidence`), `Qualification.hiring?`, `NewLeadCard.hiring?`,
  `CockpitLead.hiring?`, `UpdateLeadRequest.hiring?` (`{ role? } | null`), `HIRING_ROLE_MAX_LENGTH`;
  `TemplateAudience` + `'hiring'`, Kategorie `first_hiring` (Präfix H), Platzhalter `{{stelle}}` (`hiringRoleText`:
  „Verstärkung als …“). Erkennung `qualify/hiring.ts` ohne KI (Headline/Position/Firmenbeschreibung: „Wir suchen …
  (m/w/d)“, „#hiring“, „Wir stellen ein“) + KI-Feld `hiringRole` (Schema und Prompt der Bewertung), Profil vor KI.
  **Migration 32** `leads.hiring`. Standardvorlage **H1** „Sucht Mitarbeiter · Recruiting“; `suggest.ts` nimmt sie vor dem
  Lead-Typ, sobald der Lead `hiring` hat. Mock: Vossberg (Profil) und Freiberger (KI) – Trichter unverändert. Demo-Leads mit
  „Signal: Sucht: …“ bekommen `hiring`. Tests `hiring.test.ts`, `messages`, `mockPipeline`, `liveAdapter`.
- **`claude/lead-lernen` (13.10., Wunsch des Nutzers „Scraper lernt aus Lead-Qualität, wenig Handarbeit“)** – Vertrag
  `shared/learning.ts` (additiv, eigener `contract:`-Commit): `CockpitLead.feedback`, `UpdateLeadRequest.feedback`,
  `GET /api/learning` (`LearningSummary`). **Migration 31** (`leads.feedback`, `lead_feedback` je Provider-ID ohne Namen,
  `search_lead_source` 90 Tage, `search_queries.good/bad`). `learning/learningStore.ts`: 👍/👎, Ergebnisse automatisch
  (`syncLearning` bei Termin/Übergabe/interessierter Antwort, vor jedem Lauf), Beispiele (`examplesText`, 24, ausgewogen)
  als zweiter Systemblock mit `cache_control` für Bewertung **und** Vorprüfung (`RunContext.examples`, nur live),
  „Qualifizieren“ in der Ergebnisliste = 👍, `queryPriority` mit good/bad, Hinweise. Löschweg löscht Rückmeldungen mit.
  Fake-Anthropic versteht `system` als Blockliste (`systemText`). Test `learning.test.ts`.
- **`claude/suchtreffer-warteliste` (13.10., Wunsch des Nutzers „nicht genug Leads gefunden“)** – Planer speichert,
  warum heute kein Folgelauf kommt: `AutoSearchToday.stopReason` (`AUTO_SEARCH_STOP`: Profillimit mit Vorschlag,
  Budget, Läufe, ausgeschöpft, 3 × leer, Fehler, Tag vorbei), dazu `profileFetches`/`profilesPerDay` im Zeitplan. Ein
  neuer Lauf löscht den Grund. Vertrag additiv (eigener `contract:`-Commit). Test `autoSearch.test.ts`.
- **`claude/suchtreffer-warteliste` (12.10. g, Wunsch des Nutzers)** – Meta-Fehler (Token/Limit/Rechte) brechen den
  Lauf nicht mehr ab, Leads bleiben qualifiziert mit „Meta ungeprüft“. Vorlagen **S1/S2** „Schaltet Meta Ads“ (Vertrag:
  `TemplateAudience` `active`, Kategorie `first_active`, Präfix S). `GET /api/settings/models` (`ai/models.ts`, SDK
  `models.list`, 1 h Cache, sonst `ANTHROPIC_BUILTIN_MODELS`; `SettingDefinition.optionsFrom`). Zielgruppen-Presets
  `SEARCH_PRESETS`. **Account-Wechsel** `LINKEDIN_ACCOUNT_FALLBACK` (Standard on): Anfragen zählen je Account
  (`LeadStore.invitesByAccount`, `linkedin/inviteAccount.ts`), eigener voll → über den anderen (`sentBy`), Nachrichten
  und Abgleich über `sentBy`; Tagesstapel `inviteVia`/`invitesByAccount`, `newLeadsPerDay` × 2. Tests `linkedin`,
  `messages`, `anthropicModels`, `settings`, `liveAdapter`, `dailyTasks`.
- **`claude/suchtreffer-warteliste` (12.10. f, Wunsch des Nutzers)** – Lead von Hand qualifizieren:
  `POST /api/lead-search/runs/:id/leads/:leadId/qualify` (`runner.qualifyManually`, Status aus
  `MANUAL_QUALIFY_STATUSES`, auch ohne Profil → Karte aus Suchdaten, Kategorie `sonstiges`; Warteliste/geprüft
  nachgeführt). `RunSnapshot.costEur` am Laufende. **Migration 30** `search_backlog.prescreen`: Warteliste wird nicht
  erneut vorgeprüft (spart KI-Kosten). Tests `manualQualify.test.ts`, `searchMemory.test.ts`.
- **`claude/suchtreffer-warteliste` (12.10. e, Wunsch des Nutzers)** – „Suchtreffer pro Lauf“ gilt wie eingestellt
  (mind. Profile pro Lauf, `runSearchHits`), keine heimliche Verdopplung mehr (`2 × maxResults`). Warteliste zählt mit:
  erst bis zu `hits` Treffer aus der Warteliste, neu gesucht wird nur der Rest (Warteliste > Treffer → keine Suche, Rest
  wartet). Vertrag additiv: `RunSnapshot.searchPlan` (`RunSearchPlan` hits/backlog/newHits, auch Mock),
  `LeadSearchConfig.backlog` (`SearchMemory.backlogSize`, Simulation 0). Tests `searchMemory.test.ts`, `mockPipeline`.
- **`claude/dreamy-heisenberg-tnoyz3` (12.10. d, Vorlagen des Kunden)** – `messages/defaults.ts`: G1/G2 = „Meta Ads nie“
  Option 1/2, R1 = „Meta Ads aus seit“, R2 = Kurzvariante im selben Stil, F1A–F3A = Follow-ups des Kunden; F1B–F3B
  entfallen (eine Vorlage je Stufe). Vertrag additiv: Platzhalter `{{metastopp}}` („vor rund 4 Monaten“,
  `metaStopText`). In der Software geänderte Texte bleiben (Überschreibungen) – „Zurücksetzen“ holt die neuen.
- **`claude/dreamy-heisenberg-tnoyz3` (12.10. b, Kosten je Lead)** – KI-Prompt ausgewogen statt „streng, unter 0.6 immer
  false“ (Schwelle nur noch `QUALIFY_MIN_CONFIDENCE`); `qualify/keywords.ts` `quickQualify` + Einstellung
  `AUTO_QUALIFY_TERMS` (Vertrag additiv: Schlüssel + `AUTO_QUALIFY_DEFAULT_TERMS`): Stichwort + Entscheider ohne
  Gegenbeleg → qualifiziert ohne KI-Aufruf (nur live, Simulation unverändert); `ai/model.ts` `lowEffort` (Haiku 5.5 mit
  Effort). Tests `qualifyKeywords.test.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (12.10. a)** – Anthropic „credit balance is too low“ (400) → `ai/errors.ts`
  `isCreditExhausted`: Lauf bricht mit `auth` „Anthropic-Guthaben aufgebraucht“ ab (statt Roh-JSON „Anfrage an die KI
  ungültig“), Textvorschläge melden es ebenso. Kein Vertrag geändert. Test `liveAdapter.test.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (11.10. h, KI-Kosten + KI-Tagesbudget)** – **Migration 29** (`ai_usage` mit
  `run_id`, `auto_search_schedules.daily_budget_eur`), `ai/usage.ts` (Listenpreise je Modell, `recordAiUsage` an allen
  vier Claude-Aufrufen, Simulation mit Beispielwerten + simulierten Kosten je Lauf). Vertrag additiv:
  `DashboardResponse.aiCost` (`AiCostSummary`, `AI_PURPOSES`), `AutoSearchSchedule/Update.dailyBudgetEur`,
  `AutoSearchToday.costEur`, `AutoSearchLastRun.costEur`, Feld `dailyBudgetEur`. Planer: mit Budget zählt Geld statt
  `maxRounds`; Termin übersprungen bzw. „Jetzt ausführen“ 400, wenn aufgebraucht; Runner `start(…, { maxCostEur })`
  liest danach keine Profile mehr (Rest `deferred`). `AI_USD_EUR_RATE` (Standard 0,86). `aiCost.perQualifiedEur`/
  `perClosedEur`/`closedLeads`: Ø KI-Kosten je qualifiziertem bzw. übergebenem Lead (Simulation zählt Demo-Leads). Tests `aiCost.test.ts`,
  `autoSearch.test.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (11.10. g, Suchgedächtnis)** – Nutzer: „findet jedes Mal dieselben Kunden“.
  **Migration 28** (`search_queries`, `search_checked`, `search_backlog`), `pipeline/searchMemory.ts`, nur live:
  klassische Suche über `classicQueries` (Stichwort × Position, Stichwort im Firmennamen via
  `advanced_keywords.company`, je Bundesland bei DE/AT); Cursor je Anfrage über Läufe (bis 100 Seiten, ausgeschöpft →
  30 Tage Ruhe, ungültiger Cursor → neu), Auswahl nach Ertrag (`queryPriority`), Sättigung nach 12 leeren Seiten.
  Geprüfte Profile aller Läufe (auch von Hand) zählen nicht (`skip`, Hinweis wie bisher „In einem früheren Lauf
  bereits geprüft“); zurückgestellte Treffer → Warteliste, nächster Lauf zuerst. Automatische Suche: Folgelauf auch
  nach Lauf ohne Lead; Schluss bei 0 ungeprüften Profilen oder 3 Läufen am Stück ohne Lead. Simulation unverändert,
  kein Vertrag geändert (nur Doku in `shared/autoSearch.ts`). Tests `searchMemory.test.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (11.10. f)** – `GET /api/leads/unsent-invites`, `POST …/requeue` (`LeadStore.unsentInvites`,
  `requeueUnsentInvite`: Stufe `invited` ohne `linkedin.invitationId` → `new`, `invite_sent`-Ereignisse → `note`,
  Ereignis `stage_changed`). Vertrag `UnsentInvitesResponse`, `RequeueInvites*`. Test `messages.test.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (11.10. e)** – LinkedIn-Abgleich läuft auch mit `LINKEDIN_ACTIONS` aus (nur lesend,
  `readClient`/`watching`), sobald Unipile eingerichtet ist: erkennt angenommene Anfragen von Hand eingetragener Leads;
  `LinkedInStatusResponse.watching?`. Test `linkedin.test.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (Sperre 11.10. d)** – `POST /api/leads/:id/events` `invite_sent` aus „Neu“ → 429
  `invite_limit`, wenn der Gründer heute `LINKEDIN_INVITES_PER_DAY` bzw. in 7 Tagen `LINKEDIN_INVITES_PER_WEEK` erreicht hat
  (auch von Hand); `GET /api/tasks` liefert `rules.invitesPerDay`. Test `messages.test.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (Wunsch des Nutzers 11.10. c)** – `PATCH /api/leads/:id` mit `dealValue` (Euro,
  **Migration 27** `leads.deal_value`, Verlauf „Deal Value: …“) und `metaAds` von Hand (`manualMetaAds`, Score neu →
  Reactivation/Greenfield); Dashboard `dealValue` je Gründer und Stufe; Platzhalter `{{metapause}}`
  (`metaPauseText`); Einstellung `INVITE_NOTE` → `TasksResponse.rules.inviteNote`. Tests `messages.test.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (Wunsch des Nutzers 11.10. b)** – Grenzen aufgehoben: `MAX_RESULTS_LIMIT` 25 → 1000,
  `AUTO_SEARCH_MAX_ROUNDS_LIMIT` 10 → 100, `AUTO_SEARCH_PROFILES_PER_DAY` bis 20 000, Suchseiten bis 200
  (`MAX_SEARCH_REQUESTS`); viele Profile → mindestens doppelt so viele Treffer. `GET /api/linkedin/accounts` meldet
  `searching` (Such-Account laut `UNIPILE_ACCOUNT_ID` bzw. automatische Wahl). Pausen 3–8 s + Abbruch bei Limit bleiben.
- **`claude/dreamy-heisenberg-tnoyz3` (Kunden-Feedback 11.10., ein Agent baut beide Seiten)** – Lead-Suche findet
  mehr Passendes: **KI-Vorprüfung** nach dem Dubletten-Filter (nur Name/Headline/Ort, Pakete à 40,
  `qualify/prescreen.ts`, Marker `[cockpit:vorpruefung]`) → `screened_out` ohne Profilabruf, „likely“ zuerst angereichert,
  Ausfall → ohne Vorprüfung weiter. Suche bis `SEARCH_HITS_PER_RUN` (neu, Standard 400) Treffer, klassisch alle
  Kombinationen reihum, höchstens 80 Seiten (`maxSearchRequests`). Region per Namen (`pickLocation`). Automatische
  Suche: `secondTime` (**Migration 26** `second_time`), `screened_out` zählt als geprüft. Mock: 2 letzte Treffer
  `screened_out` → 40 → 33 → 31 → 15 → 7 → 5. Schutzgrenze 25 Profile/Lauf unverändert.
- **`claude/vorlagen-einstellungen`** – eigene Vorlagen: `POST /api/templates`, `DELETE /api/templates/:id`
  (Vertrag additiv: `TEMPLATE_CATEGORIES`, `templateCategory`, `templateLetter`, `MessageTemplate.custom?`, Codes
  `template_limit`/`last_template`). **Migration 25**: `message_templates` + `kind/stage/audience/created_at/deleted_at`;
  IDs eigener Vorlagen `G.1`, `F2.3` … (nie wiederverwendet), Löschen blendet nur aus, `reset` holt gelöschte
  Standardtexte zurück. Tests in `messages.test.ts`.
- **`fix/split` (Leads auf beide Gründer verteilen)** – neue Einstellung `LEAD_DISTRIBUTION` (`owner` Standard |
  `balanced`, Gruppe Lead-Suche). Gesucht wird weiter nur über den Such-Account; mit `balanced` gibt
  `LeadStore.createFromCards` (Übergabe von Hand **und** automatische Suche) jeden neuen Lead dem Gründer mit den
  wenigsten Leads in Stufe `new`, bei Gleichstand dem Suchenden – nur wenn beide `UNIPILE_ACCOUNT_NICK`/`_JOHANNES`
  (verschieden) gesetzt sind, sonst wie bisher. Zugeteilte Leads: `origin.searchedBy` + Verlauf „· verteilt an …“.
  Tagesziel der automatischen Suche zählt alle Leads des Laufs für den suchenden Zeitplan. Simulation/Trichter
  unverändert (Standard `owner`). Tests `server/test/leadDistribution.test.ts`, `autoSearch.test.ts`.
- **`claude/pensive-shannon-gzgyij` (Dubletten über beide Gründer-Accounts)** – Lead nur neu, wenn mit keinem
  Gründer-Account (`UNIPILE_ACCOUNT_NICK`/`_JOHANNES`, außer dem Such-Account) vernetzt und ohne offene Anfrage von dort
  (`GET /users/relations` + `/users/invite/sent`, Cache 12 h/1 h, Abgleich Provider-ID + öffentliche Kennung, auch nach
  dem Profilabruf für Sales-Navigator-IDs). Gründer-Account nicht prüfbar → sonst neue Leads `deferred` mit Grund +
  Hinweis in `/config` `warnings`. Warnung bei mehreren LinkedIn-Accounts ohne `UNIPILE_ACCOUNT_ID` bzw. Sales Navigator
  ohne Lizenz. Kein Vertrag geändert (neue Gründe nur als `note` bei `connected`/`invited`/`deferred`), Mock-Trichter
  gleich. **Frontend: nichts nötig**; die Gründe erscheinen als normale Notiz, die Warnungen im bestehenden
  `warnings`-Hinweis. Tests `server/test/founderNetworks.test.ts`.
- **`claude/pensive-shannon-gzgyij` (Review 09.10. b)** – Wiederherstellen übernimmt `deleted_leads` und löscht in der
  Kopie jeden Lead mit so einem Fingerabdruck (`LeadStore.purgeForgotten`, derselbe Löschweg inkl. Archiv); geplante
  automatische Suche wird bei offener Meldung `unipile:down` still `skipped` (`AUTO_SEARCH_MESSAGES.unipileDown`, keine
  Suchmeldung/Slack, „Jetzt ausführen“ versucht es); Bauträger-Begriff ohne nacktes `projekt` („Projektvertrieb“ →
  Kapitalanlage). Tests `ops.test.ts`, `autoSearch.test.ts`. README: vor dem Update von Hand erst sichern.
- **`claude/pensive-shannon-gzgyij`** – Review-Befunde: `SETUP_TOKEN` < 24 Zeichen bricht den Start nicht mehr ab
  (ignoriert + Warnung, `auth.setupTokenIgnored`; ohne Konto gilt der Zufallsschlüssel); Unipile-Prüfung meldet
  `unreachable` erst nach 2 Prüfungen in Folge, löst `unipile:down` auf, wenn die Prüfung aus ist, Meldung nur für
  Gründer/Admins (`audience: 'managers'`); Bauträger-Begriff ohne nacktes `develop` („Business Development“ →
  Kapitalanlage). Tests `unipileWatch.test.ts`, `onboarding`/`auth`/`notifications`/`autoSearch`.
- **`fix/sec2`** – Sicherheitsprüfung 09.10.: Login/Passwort-Abfragen zählen vor dem `await` (`LoginLimiter.reserve`/
  `release`, auch Einstellungen und Schlüssel-Zähler); Wiederherstellen übernimmt jetzige `users`/`registrations`/
  `notification_seen` + `account_change`-Meldungen, leert `sessions`/`invitations`, Meldung „Sicherung
  wiederhergestellt von …“ (Slack nach Neustart, Schlüssel `restore:`); Schlüssel anzeigen + Sicherung herunterladen →
  `account_change` an alle Gründer + Slack (`NOTICES.securityAction`, Ziel Einstellungen → backup); ungelesene
  `account_change` immer in der Liste (über `NOTIFICATION_LIMIT` hinaus); `SETUP_TOKEN` < 24 Zeichen wird ignoriert (Warnung im Log).
  Vertrag nur Kommentar (`shared/notifications.ts`). Tests `server/test/security.test.ts` (S1–S6).
- **`fix/search2`** – Unipile 503 `no_client_session` (Abo/Testzeitraum abgelaufen) überall klar gemeldet
  (`isUnipileSessionDown`, Titel „Unipile-Sitzung nicht aktiv“, Code `auth`, keine LinkedIn-Pause); regelmäßige
  Unipile-Prüfung (`system/unipileWatch.ts`, alle 4 h, neue Meldungsart `unipile_down` – additiv, `contract:`-Commit);
  geprüfte Profile der automatischen Suche gelten für beide Gründer (`checkedShared`); Bauträger-Stichwörter genauer
  (`entwickl` ja, Baufinanzierung/Aufbau nein); Sales Navigator mit `skip` volle Seiten; vom Tageslimit
  übersprungener Termin → Neuigkeit „… übersprungen“. Frontend: optional „Unipile antwortet nicht“ unter Einstellungen →
  Übersicht (die Glocke zeigt es schon).
- **`fix/flow2`** – Tagesstapel: Antwort im Termin (nach letztem `meeting_booked` und eigener Nachricht) ist wieder
  eine Antwort-Aufgabe; automatische Suche setzt `origin.auto` (Vertrag additiv) und zählt gegen `NEW_LEADS_PER_DAY`;
  Close: erneute Übergabe hängt die Notiz an den bestehenden Close-Lead; `/api/tasks` lädt nur Leads des Gründers,
  Chats filtern in SQL ohne N+1; **Migration 24** Index `lead_events(kind, at)`. Tests in `tasks.test.ts`, `crm.test.ts`.
- **`fix/security`** – Befunde der Sicherheitsprüfung 08.10. (beide Seiten): Frontend-Port Standard `127.0.0.1:8080`,
  nginx realip + genau eine `X-Forwarded-For`-Adresse, Backend vertraut höchstens 1 Proxy (`trustedProxyHops`);
  Einrichtungs-Link fürs erste Konto (`setupToken` im Register-Body, `DATA_DIR/setup-token`, `SETUP_TOKEN`, Code
  `setup_required`); je Gründer ein Gründer-Konto, Admins legen keine Gründer an (`invitableRoles`), Neuigkeit
  `account_change` an alle Gründer + Slack; Lead-URLs nur http(s) (`webUrlProblem`, Frontend `safeHref`); Mitarbeiter:
  kein `owner`-Wechsel zu fremden Gründern, keine Board-Spalten (`canEditBoardColumns`); Registrieren zählt vor der
  Namensprüfung; 20 MB nur an `PUT /api/lead-search/tracking`. Tests `server/test/security.test.ts`.
- **`fix/ops`** – Betrieb und Datenschutz (ein Agent baut beide Seiten): Sicherung `vor-update-…` vor jedem Update
  (es bleiben 3; scheitert sie → 503 `backup_failed`, kein Update), nächtlicher Update-Fehler nach dem Start aus
  `updater-state.json` → Meldung + Slack (`UpdateService.watchLastRun`), Update-Dienst räumt nach Erfolg auf
  (`docker image prune -f`, `docker builder prune -f --filter until=168h`), Speicherplatz stündlich/vor Sicherungen
  (`system/disk.ts`, Meldung `disk_low`, `BackupListResponse.disk`), `/api/health` fragt die DB (503), `POST
  /api/system/settings-key`, `GET /api/leads/:id/export` + `DELETE /api/leads/:id` (gleicher Weg wie die Frist,
  `LeadStore.purge`), **Migration 22** `lead_events_archive` (Dashboard zählt gelöschte Leads anonym weiter).
  Vertrag additiv (`contract:`-Commit). Tests `server/test/ops.test.ts`, `updater.test.ts`.
- **`fix/auto-search`** – Automatische Suche nachgebessert: Folgeläufe nur mit neuem Lead und 5 Min Pause
  (`AUTO_SEARCH_FOLLOW_UP_PAUSE_MINUTES`), Suche überspringt geprüfte Profile beim Zählen (`SearchOptions.skip`, Mock +
  Live), ohne Anthropic-Schlüssel kein geplanter Lauf (`skipped` + Neuigkeit), KI-Ausfall → `failed` „KI-Bewertung
  fehlgeschlagen …“, neues Tageslimit `AUTO_SEARCH_PROFILES_PER_DAY` (Einstellung, Gruppe Lead-Suche, alle Läufe
  zählen), wartende Termine überstehen Neustart als `skipped` (Migration 23), Zählen für den Tag des Termins,
  „Kapitalanlage …bau…“ bleibt Kapitalanlage. Vertrag nur additiv (`shared/autoSearch.ts`, `shared/settings.ts`).
- **`fix/workflow`** – Vertrag additiv: Aktion `reopened` (Stufe aus dem Verlauf), `message_received` auch aus lost/handed_over, aus `meeting` bleibt `meeting`; Antwort-Aufgabe `<id>:reply:<lastReplyAt>`; Attention `conversation_quiet`; `GET /api/leads?sort=recent`; Exploration-Tag nach Berliner Zeit.
- **`claude/neuigkeiten`** – Neuigkeiten (Wunsch des Nutzers 08.10., ein Agent baut beide Seiten): `NotificationCenter`
  (`src/notify/notifications.ts`, Migration 21), Quellen Registrierung, abgebrochene automatische Suche, LinkedIn-Pause,
  nächtliche Sicherung, automatisches Update; behoben → Meldung weg. Slack bei jeder neuen Meldung (live, Wiederholung
  höchstens alle 12 h). Simulation: Demo-Reset legt zwei Beispiele an. Gründernamen aus den Konten
  (`AccountStore.founderName`, Testkonten zuerst) statt fester „Nick/Johannes“ in Rollen-Sätzen, LinkedIn, Close, Slack.
  Tests `server/test/notifications.test.ts`.
- **`claude/sicherheit`** – Sicherheits-Prüfung (Wunsch des Nutzers 08.10., ein Agent baut beide Seiten): 5xx-Antworten
  ohne interne Details (`setErrorHandler` in `app.ts`, Code `internal`), API-Antworten `Cache-Control: no-store` +
  `nosniff` (eigene Angaben einer Route gelten), Anfrage-Protokoll ohne Query (`?q=` = Namen), `uuid` per `overrides`
  auf 11.1.1 (npm audit sauber). Tests `server/test/hardening.test.ts`. Keine Vertragsänderung.
- **`claude/onboarding` (3)** – Tagesziel der automatischen Suche: Migration 20, `dailyTarget`/`maxRounds`/`today`,
  Planer reiht Folgeläufe ein (`continueForTarget`), Tests in `server/test/autoSearch.test.ts`.
- **Onboarding ohne Shell** (Wunsch des Nutzers 08.10., ein Agent baut beide Seiten, Branch `claude/onboarding`):
  Migration 19 (`users.founders/onboarding`, `invitations.founders`, Tabelle `registrations`), `GET /api/auth/setup`,
  `POST /api/auth/register` (erstes Konto → Gründer `nick` mit `onboarding: 'setup'`, sonst wartet; 5/h je IP, max.
  20 offen), `POST /api/auth/onboarding/done`, `POST /api/accounts/:username/approve`, Ablehnen per DELETE. Wartende
  Konten: alles außer `/api/auth/*` → 403 `awaiting_approval`. Mitarbeiter mit `founders` (`assistantDenial`,
  `actingFounder` für LinkedIn/Übergabe). Tests `server/test/onboarding.test.ts`.
- **Wünsche 07.10.** (ein Agent baut beide Seiten, Branch `claude/pensive-shannon-gzgyij`): aktive Meta-Ads gehen
  markiert mit in den Tagesstapel (`HANDOFF_STATUSES`, Übergabe 7 statt 5 im Mock, Trichter bleibt 40 → 33 → 15 → 7 → 5),
  70/30 der automatischen Suchläufe (`AutoSearchFocus`, Migration 17; die Mischung im Tagesstapel ist
  wieder raus), Aussortier-Grund „Falsche Branche“ mit Erklärung, Follow-up-Hinweis auf der Startseite (keine
  Slack-Erinnerung, Wunsch des Nutzers), Sicherungen nach 7 Tagen löschen (`BACKUP_MAX_AGE_DAYS`, neue Einstellung), Test-LinkedIn-Account
  (`/api/linkedin/test-profile`, `/test-message`, `/test-connect`) statt Test-Anfrage in der Oberfläche,
  Antwort direkt in der Antwort-Karte, Chats (`GET /api/conversations`), eigene Board-Spalten (`/api/board/columns`,
  `boardColumn`, Migration 18), Einstellungen mit „Auf einen Blick“.
- **Echter Betrieb** (Wunsch des Nutzers 07.10., ein Agent baut beide Seiten, Branch `claude/pensive-shannon-gzgyij`):
  Migration 16 löscht einmalig alles Erfundene (Leads mit `origin` demo oder Simulation samt Verlauf, deren
  Firmendaten-Anfragen und gesehene Nachrichten, LinkedIn-Aktionen mit Account `mock-…`, Einstellungen
  `LEAD_SEARCH_MODE`/`MOCK_SPEED` samt Verlauf). Standard `LEAD_SEARCH_MODE` ist jetzt `live`; `mock` nur noch über die
  Umgebung (Playwright, `scripts/dev-all.mjs`, Tests). Kein Moduswechsel in den Einstellungen, kein Demo-Seed beim
  Speichern von Einstellungen. Mock-Adapter, Demo-Seed und `POST /api/leads/demo/reset` bleiben – nur für Tests.
- `backend/zusammenfassung-punkt` – dein Hinweis: Regel-Zusammenfassung ohne doppelten Punkt nach dem Datum
  („04.10.“ statt „04.10..“); ältere gespeicherte Zusammenfassungen werden beim Start einmal neu geschrieben.

## Fertig (PRs)
- #49 „l is not a function“ (scrollTo im Effekt, Chrome 154) · #50 Demo-Daten mit Vorlagen-IDs + Reactivation-Lead.
- #45–#48 `clientId` für LinkedIn, `lead.conversation`, Close-Übergabe, Slack + Löschen.
- #41 Stapel nach deutscher Zeit, neue Antwort hebt Überspringen auf.
- #30 Stapel-Wünsche (`clientId`, Überspringen, Tageslimit mit heutigen Anfragen, Demo-Labels).
- #18 LinkedIn-Aktionen (Code da, bleibt aus – gesendet wird von Hand) · #19 Dashboard `GET /api/dashboard` ·
  #20/#21 Firmendaten über Treg · #22 Einstellungen-Backend · #23 Phase 4 Vorlagen + KI-Vorschläge.
- Im Auftrag des Nutzers als Frontend gebaut: #24 Knopf „Vorschlag“, #25/#26 schwarzer Bildschirm (`ErrorBoundary`).
- #4 Phase 1 Login (Backend): Konten, Sitzungen, Begrenzung, `/api/auth/*`, Konten-Befehl. Pflicht-Sitzung noch aus.
- #5 Phase 2: Vertrag `shared/leads.ts`, Leads + Verlauf in SQLite, `/api/leads/*`, 30 Demo-Leads in der Simulation.
- #6 Phase 2 Rest: Dubletten gegen die Datenbank, Tracking-Liste in SQLite, tägliche Sicherung. Live auf dem VPS.
- #8 Scoring v1: `shared/scoring.ts`, Feld `score` an Leads, `?sort=score`.
- #9 Pflicht-Sitzung an, Caddy `basic_auth` entfernt. Live auf dem VPS, Anmeldung funktioniert.
- #11 Einladungslinks (Backend zu deinem Vertrag #10): `accountsCli invite|uninvite`, `/api/auth/invite/check|accept`.
- #12 Phase 5 Tagesstapel: `shared/tasks.ts`, `GET /api/tasks`.
- #14 Clay-Anreicherung: `shared/enrichment.ts`, Feld `enrichment`, Simulation + Live, Score neu.
- Zusammen mit deinem #13 geprüft (Stand `41cb4fa`): verify:backend 110 grün, verify:frontend 37 grün.

## Brauche von der anderen Seite
- **31.10.:** Optional: in `AutoSearchSection.tsx` „x Profilabrufe heute“ ohne „von y“ zeigen (Feld `profilesPerDay`
  kommt nicht mehr); E2E `autoSearch.spec.ts` nutzt noch einen alten Stopp-Satz mit „Profile pro Tag“ als Testdaten.
- **Leads auf beide Gründer verteilen (`fix/split`):** Mit `LEAD_DISTRIBUTION=balanced` gehören neue Leads aus einer
  Suche nicht mehr nur dem Suchenden. Bitte:
  1. **Chats-Tab:** Auswahl „Alle“ anbieten – `conversationsApi.list()` **ohne** `owner` aufrufen (liefert beide
     Gründer, auch für Mitarbeiter) – und je Chat zeigen, über wessen Account er läuft: `lead.owner` →
     „über Nicks Account“ / „über Johannes' Account“.
  2. **Übergabe („In den Tagesstapel“):** `POST /api/leads` kann Leads in `created` mit anderem `owner` liefern – die
     Meldung bitte aufteilen („4 Leads bei dir, 3 bei Johannes“) statt alle dem eigenen Stapel zuzuschreiben.
  3. **Lead-Panel/Verlauf (optional):** `origin.searchedBy` → „gefunden von Nick“. Board: Bereich „Alle“ gibt es schon.
  4. **Einstellungen:** `LEAD_DISTRIBUTION` erscheint automatisch (choice, Gruppe Lead-Suche); sinnvoll wäre ein
     Hinweis, wenn `balanced` gewählt ist, aber nicht beide LinkedIn-Accounts eingetragen sind (dann wird nicht
     verteilt).
- **Tagesstapel aus `GET /api/tasks`** statt aus `src/data/` (Phase 2/5 Oberfläche): `tasks` in fertiger Reihenfolge
  (reply → followup → first → lead), `counts` für die Startseite, `attention` für Board/Übersicht. Aufgabe erledigen
  = Aktion an `POST /api/leads/:id/events`, danach neu laden. `followUpNumber` statt eigener Zählung.
- **Phase 2 Oberfläche:** Cockpit, Lead-Panel und Historie aus `GET /api/leads` bzw. `/api/leads/:id` statt aus
  `src/data/`; Entscheidungen als `POST /api/leads/:id/events`; „In den Tagesstapel“ → `POST /api/leads` mit den
  Handoff-Karten; „Demo zurücksetzen“ → `POST /api/leads/demo/reset` (nur Simulation). Pipeline-Board und
  Tabellenansicht (Kundenwunsch) bauen direkt auf `GET /api/leads` auf (Spalten = `LEAD_STAGES`).

- **Treg statt Clay (05.10.):** Für die Oberfläche ändert sich fast nichts – gleiche Routen und Felder. Unterschiede:
  live gibt es kein `pending` (Ergebnis sofort in der 202-Antwort), `enrichment.source` kann `'treg'` sein, der
  Status hat `provider` (`'treg'`/`'clay'`). Knopf-Text bitte neutral („Firmendaten holen“ statt „Mit Clay
  anreichern“). `failed` ohne Website ist normal („Keine Website bekannt …“). **Einstellungen:** `TREG_TOKEN`
  (secret, Passwort), `ENRICHMENT_PROVIDER` (choice treg/clay), `ENRICH_AUTO`, `ENRICH_MAX_PER_DAY` gehören in den
  Katalog; die `CLAY_*` können in eine Untergruppe „Clay (Alternative)“. Neu: `TREG_MAX_COST_USD` (number, 0–1).
  **Achtung Anzeige:** Tech-Stack, Umsatz und viele Social-Links kommen bei Treg oft **nicht** – Felder leer/„unbekannt“
  zeigen, nicht „keine“. Sicher sind meist Mitarbeiterspanne und LinkedIn-Link.
- **Clay in der Oberfläche** (gegen den Mock): `GET /api/enrichment/status` → bei `mode !== 'off'` am Lead
  einen Knopf „Mit Clay anreichern“ (`POST /api/leads/:id/enrich`, 202). Solange `lead.enrichment.status ===
  'pending'` „Wird angereichert …“ zeigen und den Lead alle paar Sekunden neu laden (Simulation: ~1,5 s).
  Danach Mitarbeiter (`employeesRange` bevorzugt), Umsatz, Tech-Stack, Meta-Pixel, Social-Links (nur verlinken,
  sind geprüft) in der Score-Karte bzw. im Lead-Panel. 409 `enrichment_off`, 429 `enrichment_limit` mit Meldung
  aus der Antwort. In der Simulation sind alle Demo-Leads ab „Anfrage gesendet“ schon angereichert, die in „Neu“
  nicht. Im Verlauf neues Ereignis `enriched` (Titel und Text kommen fertig vom Backend).

- **Phase 3 in der Oberfläche** (gegen den Mock): `GET /api/linkedin/status` → bei `mode !== 'off'` statt
  „Als erledigt markieren“ echte Knöpfe: „Vernetzen“ → `POST /api/leads/:id/linkedin/invite` (`{ message? }`, max.
  300 Zeichen), „Senden“ → `POST /api/leads/:id/linkedin/message` (`{ text, label }`). Antwort ist wie bei `/events`
  der Lead mit Verlauf. „Wird gesendet …“ während der Anfrage (live bis ~10 s wegen der Pausen), „Rückgängig“ nur
  vor dem Absenden (also im Frontend verzögern). Limits je Gründer (`invitesToday`, `messagesToday`) sichtbar,
  `pausedUntil`/`pauseReason` als Hinweis. Fehlermeldungen kommen fertig aus `error.message`. „Aktualisieren“ →
  `POST /api/linkedin/sync`; Simulation: ~2 von 3 Anfragen werden angenommen, auf ~jede 3. Nachricht kommt eine
  Antwort (mit MOCK_SPEED=1 nach 30 bzw. 60 s). Bei `mode === 'off'` bleibt alles wie bisher.
- **Dashboard aus `GET /api/dashboard`** statt `src/data/dashboard.ts`: `days.nick`/`days.johannes` sind dieselben
  Tage (älteste zuerst, lückenlos, Standard 112 = 8 sichtbar + 8 Vergleich) mit `requests`, `accepted`, `messaged`,
  `replies`, `meetings`, `handovers` (= bisher `exports`) – „Gesamt“ ist die Summe beider. Quoten selbst rechnen wie
  bisher. „Templates“-Ansicht: `templates[founder]` (`messaged`/`replied` je Vorlage) und `followUps[founder]`
  (Stufe 0 = Erstnachricht, `reached`/`replied`). Neu verfügbar: `pipeline[founder][stage]` (aktueller Stand).
  Simulation: gerechnet aus den 30 Demo-Leads → kleine Zahlen und nur die letzten Wochen belegt.
- **Einstellungen:** Die neuen `LINKEDIN_*`- und `UNIPILE_ACCOUNT_*`-Variablen (Liste in `.env.example`) gehören
  später in den Katalog `shared/settings.ts` (dein Vertrag) – `LINKEDIN_ACTIONS` am besten mit Passwort + Rückfrage.
- **Eure Wünsche an mich** (Einstellungen-Backend nach `shared/settings.ts`, Konto ohne Gründer) sind notiert; der
  Nutzer hat als Reihenfolge Phase 3 → Phase 6 → Clay vorgegeben, danach kommen sie dran.

- **Einstellungen jetzt gegen das echte Backend** (Branch `backend/settings`): alle Punkte aus deiner Liste sind
  umgesetzt (Prüfreihenfolge, `version`, Passwort/Sperre, `field`, Probe mit neuer Sitzung, Notfallmodus mit `stored`,
  `clientIp`, `live_leads_exist`, Server-Befehle). Abweichungen/Hinweise:
  - **Katalog erweitert:** neue Schlüssel `ENRICHMENT_PROVIDER`, `TREG_TOKEN`, `TREG_MAX_COST_USD`; `CLAY_AUTO_ENRICH`/
    `CLAY_MAX_PER_DAY` heißen jetzt `ENRICH_AUTO`/`ENRICH_MAX_PER_DAY` (Gruppe „Firmendaten (Treg, Clay)“).
  - **Probe:** gilt für jede Änderung eines Probe-Schlüssels (auch `null`), nur allein im PUT; die PUT-Antwort setzt die
    neue Sitzung (`Set-Cookie`) und enthält `clientIp` **nach** der Änderung.
  - **`clientIp`** ist `request.ip` mit dem wirksamen `TRUST_PROXY_HOPS`.
  - **Verbindungstest** Unipile: „Verbunden: LinkedIn-Account <Name>“; Anthropic: Modell-Liste; Meta: eine Abfrage der
    Werbebibliothek (`ok:false` mit festem Satz bei Fehlern, 429 mit `Retry-After` bei zu häufigen Tests).
  - Alle Routen verlangen eine Sitzung (auch im Übergang ohne Pflicht-Sitzung → 401).

- **Phase 4 Vorlagen + KI-Vorschläge** (gegen den Mock, Branch `backend/vorlagen-ki`) – **Knopf „Vorschlag“ ist
  erledigt** (Branch `frontend/vorschlag`, siehe frontend.md); offen bleibt die Vorlagen-Seite: **Gesendet wird von Hand**
  (Nutzer, 05.10.: keine automatischen LinkedIn-Aktionen) – also „Text kopieren“ + wie bisher die Aktion an
  `POST /api/leads/:id/events` melden, `label` = `templateId` des Vorschlags. Vorlagen aus `GET /api/templates` statt
  `src/data/templates.ts` (IDs G1/G2/R1/R2, F1A…F3B, N1; die alten A/B/C sprachen die falsche Zielgruppe an). Bei
  Erstnachricht/Follow-up/Antwort einen Knopf „Vorschlag“ → `POST /api/leads/:id/suggest` (`{ kind, templateId? }`),
  Antwort `MessageSuggestion`: `text` (fertig mit Grußformel), `basis` (ein Satz), `source` (ai/template/mock),
  optional `notice` (als Hinweis zeigen) und bei `reply` die Einschätzung `reply.intent` (`REPLY_INTENT_LABELS`) +
  `summary`. Live dauert die KI ein paar Sekunden → „Wird geschrieben …“. 429 mit `Retry-After`. Vorlagen-Seite:
  `PUT /api/templates/:id` (`{ text, name? }`, 400 `invalid_template` bei unbekannten Platzhaltern, N1 max. 300
  Zeichen), `POST /api/templates/:id/reset`; `isDefault`/`updatedBy` anzeigen. Simulation: feste Texte, Varianten je
  Lead stabil.

## Vertragsänderungen (`shared/`, HTTP-API)
- **31.10. (Wunsch des Nutzers, Entfernung):** `SettingKey 'AUTO_SEARCH_PROFILES_PER_DAY'` und
  `AUTO_SEARCH_PROFILES_PER_DAY_DEFAULT` entfernt. `AutoSearchToday.profilesPerDay` bleibt optional im Typ, wird aber
  nicht mehr geschickt → „x von y Profilabrufen“ fällt im Frontend von selbst weg. Minimaler Frontend-Fix (Ausnahme 1):
  Eintrag in `src/components/settings/settingsNav.ts` entfernt (Label + Seite Lead-Suche).
- **27.10. b `claude/practical-thompson-wknjtb`** – additiv: `AutoSearchSchedule.kapitalanlagePercent?`,
  `AutoSearchUpdate.kapitalanlagePercent?`, `AutoSearchField 'kapitalanlagePercent'`, `AUTO_SEARCH_KAPITALANLAGE_PERCENT_DEFAULT/STEP`,
  `nextAutoSearchFocus(counts, percent?)`. Entfernt: `AUTO_SEARCH_KAPITALANLAGE_TENTHS` (nur intern genutzt).
- **27.10. `claude/practical-thompson-wknjtb`** (Wunsch des Kunden, Bedeutung geändert): neue Union-Werte
  `LeadCategory`/`SearchAudience`/`AutoSearchFocus` `'finanzdienstleister'`; `QUALIFYING_CATEGORIES` + FDL;
  `DEFAULT_SEARCH_PROFILE`, Presets und „beide“ ohne Bauträger; `AUTO_SEARCH_KAPITALANLAGE_TENTHS` 7 → 5,
  `nextAutoSearchFocus` wechselt Kapitalanlage/FDL. Additiv: `TemplateSegment`, `MessageTemplate.segment?`,
  `Create/UpdateTemplateRequest.segment?`, `templateSegmentOf`, `templatesForSegment`, `SEARCH_AUDIENCE_OPTIONS`,
  `DECISION_MAKER_POSITIONS`, `TARGET_GROUPS_TEXT`, `focusOfTerm`.
- **22.10. i `claude/festive-tesla-rf5q3l`** – Bedeutung `UpdateLeadRequest.followUpPlan.column`: fehlt = automatisch die
  „Follow“-Spalte (nur im Antwort-Bereich), Lead steht sofort darin; null = keine (auf Wunsch des Nutzers).
- **22.10. h `claude/festive-tesla-rf5q3l`** – additiv: `BoardColumnsResponse.layout?`, `BoardLayout`, `boardColumnKey()`,
  `orderedBoardKeys()`, Routen `PUT /api/board/columns/order`, `PATCH /api/board/columns/stage/:stage`.
- **22.10. g `claude/festive-tesla-rf5q3l`** – neu `shared/mcp.ts` (MCP/OAuth-Routen, `McpConsentInfo`, `McpConnectionsResponse`,
  `MCP_CONSENT_PARAM`, `MCP_LEAD_PARAM`); `AUTH_OPEN_ROUTES` + `/api/oauth/register|authorize|token`.
- **20.10. `claude/wonderful-pasteur-koa2lt`** – additiv: `FollowUpPlan`, `CockpitLead.followUpPlan?`, `UpdateLeadRequest.followUpPlan?`.
- **19.10. c `claude/wonderful-pasteur-koa2lt`** – additiv: `ChatSyncRequest`, `ChatSyncStatus`, Routen `POST/GET /api/linkedin/chat-sync`.
- **19.10. b `claude/wonderful-pasteur-koa2lt`** – additiv: `UpdateLeadRequest.stage?/replyInterest?`, `CockpitLead.replyInterest?`,
  `ReplyInterest`, `REPLY_INTERESTS`, `REPLY_INTEREST_LABELS`, `replyInterestOf()`, Query `category=` an `GET /api/leads`.
- **19.10. `claude/wonderful-pasteur-koa2lt`** – additiv: `LeadOrigin` + `{ kind: 'contact' }` (Union-Wert, Frontend kompiliert),
  `AddContactRequest/Response`, `CONTACT_PROFILE_MAX_LENGTH`, Route `POST /api/leads/contact`.
- **13.10. `claude/hiring-signal`** – additiv: `LeadHiring`, `HIRING_ROLE_MAX_LENGTH`, `Qualification.hiring?`,
  `NewLeadCard.hiring?`, `CockpitLead.hiring?`, `UpdateLeadRequest.hiring?`; `TemplateAudience` + `'hiring'` und
  `TemplateCategory` + `'first_hiring'` (Union-Werte, Frontend angepasst), Platzhalter `stelle` + `hiringRoleText`.
- **11.10. f** – additiv: `UnsentInvitesResponse`, `RequeueInvitesRequest/Response`, Routen `/api/leads/unsent-invites*`.
- **11.10. c** – additiv: `CockpitLead.dealValue?`, `DEAL_VALUE_MAX`, `ManualMetaAds`, `UpdateLeadRequest.dealValue?/metaAds?`,
  `MetaAdsCheck.manual?`, `DashboardResponse.dealValue?`, Platzhalter `metapause` + `metaPauseText`,
  `TasksResponse.rules.inviteNote?`, Einstellung `INVITE_NOTE`.
- **11.10. b** – Bedeutung geändert (Nutzer-Auftrag): `MAX_RESULTS_LIMIT` 1000, `AUTO_SEARCH_MAX_ROUNDS_LIMIT` 100,
  `AUTO_SEARCH_PROFILE_LIMITS.maxResults` 1000, Einstellungen `MAX_RESULTS` ≤ 1000, `AUTO_SEARCH_PROFILES_PER_DAY` ≤ 20 000;
  additiv `LinkedInUnipileAccount.searching?`.
- **11.10. (`claude/dreamy-heisenberg-tnoyz3`)** – additiv: `LeadStatus` `screened_out`, `RunPhase` `screen`,
  `PipelineLead.prescreen?`, `PrescreenVerdict`/`PrescreenFit`, `FunnelCounts.screened?`, `LeadSearchConfig.searchHits?`,
  `SEARCH_HITS_*`; Einstellung `SEARCH_HITS_PER_RUN`; `AutoSearchSchedule/Update.secondTime?`, `AutoSearchField`
  `secondTime`.
- **`fix/split`** (`contract:`-Commit, additiv): Einstellung `LEAD_DISTRIBUTION` (`SETTING_KEYS`/`SETTINGS`),
  `LEAD_DISTRIBUTIONS`/`LeadDistribution` mit der Regel in `shared/leads.ts`, optional `origin.searchedBy` bei
  Such-Leads; Kommentar: `POST /api/leads` `owner` = Suchender, Chats nennen den Account über `lead.owner`.
- **08.10. `claude/neuigkeiten`:** neu `shared/notifications.ts` (Neuigkeiten, `GET /api/notifications`,
  `POST /api/notifications/seen`); `shared/auth.ts` additiv – `AuthUser.founderNames` (Namen der Gründer aus ihren
  Konten, an allen `/api/auth/*`-Antworten), `defaultFounderName()`, `AcceptInviteRequest.name` (eigener Name beim
  Einladungslink).
- **08.10. `claude/onboarding`:** `shared/autoSearch.ts` additiv – `dailyTarget`, `maxRounds`, `today` (`AutoSearchToday`),
  Konstanten `AUTO_SEARCH_DAILY_TARGET_MAX`, `AUTO_SEARCH_MAX_ROUNDS_LIMIT`, `AUTO_SEARCH_DEFAULT_MAX_ROUNDS`, Felder
  `dailyTarget`/`maxRounds` in `AutoSearchField`. Fehlen sie im PUT, bleiben die gespeicherten Werte.
- **08.10. `claude/onboarding`:** `shared/auth.ts` additiv – `SetupInfo`, `RegisterRequest`, `ApproveRequest`,
  `REGISTER_PATH`, `MAX_OPEN_REGISTRATIONS`, `AuthUser.founders/awaitingApproval/onboarding`,
  `AccountInfo.founders/awaitingApproval/registeredAt`, `CreateInviteRequest.founders`, Fehlercode `awaiting_approval`,
  `workingFounders()`. Neue Routen siehe PLAN.md.
- **Einstellungen `SLACK_WEBHOOK_URL`, `LOST_DELETE_DAYS`**, Gruppe `crm` heißt „CRM und Slack“; Löschregel im Kopf von `shared/leads.ts` (Branch `backend/slack-loeschen`).
- **Neu `shared/crm.ts`**, `CockpitLead.crm`, Einstellungen `CLOSE_API_KEY`/`CLOSE_STATUS_ID` + Gruppe `crm` (Branch `backend/close-crm`), rein additiv.
- **`CockpitLead.conversation` / `LeadConversation`** (Branch `backend/gespraech-einschaetzung`), rein additiv.
- **`clientId` an `LinkedInInviteRequest`/`LinkedInMessageRequest`** (Branch `backend/linkedin-clientid`), rein additiv.
- **Stapel-Wünsche** (Branch `backend/stapel-wuensche`, Commit `contract:`), rein additiv:
  - `LeadActionRequest.clientId` (1–64 Zeichen, je Lead eindeutig): Wiederholung → 200 mit `duplicate: true` und
    aktuellem Stand, ohne Stufenprüfung und ohne zweite Buchung. Ohne `clientId` wie bisher. Für `/linkedin/*` noch
    nicht (bleibt aus).
  - `POST /api/leads/:id/snooze` (`{ until? }`, Standard Mitternacht Ortszeit, max. 30 Tage) und
    `DELETE …/snooze`; Feld `snoozedUntil` am Lead. Übersprungene Leads fehlen in `GET /api/tasks`.
  - Tageslimit neuer Leads: heutige `invite_sent` (Ortszeit) werden abgezogen; heute **aus der Lead-Suche**
    übergebene Leads (`origin.kind === 'search'`) sind immer dabei. Neu `TasksResponse.invitesToday`.
  - Demo-Seed: `message_sent`-Labels jetzt `A`/`B`/`C`.
- **Neu `shared/messages.ts`** (Branch `backend/vorlagen-ki`, Commit `contract:`): Vorlagen, Vorschläge,
  `renderTemplate`, `unknownPlaceholders`, `FOUNDER_GREETINGS`, `REPLY_INTENT_LABELS`. Rein additiv.
- **`shared/settings.ts` erweitert** (Branch `backend/settings`, Commit `contract:`): Treg-Schlüssel und
  `ENRICH_AUTO`/`ENRICH_MAX_PER_DAY` statt `CLAY_AUTO_ENRICH`/`CLAY_MAX_PER_DAY` (Umbenennung – es gab noch kein Backend
  und keine Nutzung; bitte beim Review im Frontend prüfen).
- **`shared/enrichment.ts` erweitert** (Branch `backend/treg`): `source` auch `'treg'`, neuer Typ
  `EnrichmentProvider`, optionales `provider` im Status. Rein additiv.
- **Neu `shared/dashboard.ts`** (Branch `backend/dashboard`): `DashboardResponse`, `DashboardDay`, `TemplateStat`,
  `FollowUpStat`. Rein additiv.
- **Neu `shared/linkedin.ts`** (Branch `backend/linkedin-aktionen`): Status, Anfrage-/Antworttypen, Fehlercodes,
  `INVITE_NOTE_MAX_LENGTH`/`MESSAGE_MAX_LENGTH`; optionales Feld **`linkedin`** an `CockpitLead`. Ereignisse wie
  bisher (`invite_sent` …), Titel mit „· über LinkedIn“. Rein additiv.
- **Neu `shared/enrichment.ts`** (#14, gemergt): `CompanyEnrichment`, `EnrichmentStatusResponse`,
  Labels; optionales Feld **`enrichment`** an `CockpitLead`; neuer `LeadEventKind` **`enriched`**; Clay-Rückkanal
  `/api/enrichment/clay` in `AUTH_OPEN_ROUTES`. Rein additiv – der neue `LeadEventKind` wird im Frontend bisher
  nirgends vollständig aufgezählt, Typprüfung grün.
- **Neu `shared/scoring.ts`** (#8, gemergt): `LeadScore` (Gesamt + Stufe, ICP mit Einzelteilen,
  Hard-Filter, Meta-Evidenz, Lead-Typ, Vollständigkeit), Labels, `scoreTier()`. Optionales Feld **`score`** an
  `PipelineLead`, `NewLeadCard` und `CockpitLead`; `GET /api/leads?sort=score`. Rein additiv.
  **Für die Score-Karte:** Zahlen als Stufe/„Score“ zeigen, nicht als „% Wahrscheinlichkeit“ (nicht kalibriert).
- **Neu `shared/leads.ts`** (#5, gemergt): `CockpitLead`, `LeadEvent`, `LeadStage`
  (`LEAD_STAGES` + Labels), `LEAD_ACTIONS` + `LEAD_ACTION_RULES` (welche Aktion aus welcher Stufe wohin führt),
  Request-/Response-Typen. Routen und Verhalten im Dateikopf, API-Tabelle in `PLAN.md`. Rein additiv.
  Zuordnung zur Demo: `lead`→`new`, `first`→`connected`, `followup`→`contacted`, `reply`→`replied`.
- Erstmals `import type` zwischen Vertragsdateien (mit `.js`), in `shared/CLAUDE.md` vermerkt.
- `shared/auth.ts` (#3) unverändert umgesetzt. Cookie-Name: `cockpit_session`.
- **Neu `shared/tasks.ts`** (#12, gemergt): `DailyTask`, `TaskType` (= `CardType`-Werte),
  `TasksResponse`, „braucht Aufmerksamkeit“ (`AttentionItem`). Regeln im Dateikopf. Rein additiv.
- **Einladungen (#10, dein Vertrag)** unverändert umgesetzt, inkl. Reihenfolge in `accept`, atomarem Einlösen
  (`BEGIN IMMEDIATE`), eigenem IP-Zähler. Meldungen: `invalid_request` bei fehlendem Token „Der Link ist
  unvollständig …“, bei fehlendem Passwort „Bitte gib ein Passwort ein.“; `weak_password` aus den Konstanten.
  `PASSWORD_MIN_LENGTH`/`MAX_LENGTH` aus dem Vertrag gelten jetzt auch in der CLI (inkl. Maximum).

## Hinweise
- **Alte Entwicklungs-Datenordner löschen:** Wer lokal einen Datenordner auf dem kurzlebigen Branch `fix/auto-search`
  angelegt hat (dort war Migration 22 = Spalte `pending`), muss ihn löschen – die Nummern passen nicht mehr zu Migration
  22/23 im Integrations-Branch. Der Produktivserver stand auf v21 und ist nicht betroffen.
- **Review-Nachbesserungen 08.10.:** `GET /api/leads?columns=1` (mit `stage`: auch Leads in eigenen Board-Spalten);
  Übergabe bereinigt seltsame Website/Werbebibliothek-Adressen zu null statt 400 (`leads/webUrl.ts`, auch in
  `createFromCards`), nur gefährliche Profil-Adressen (`javascript:` …) → 400; Einrichtungs-Link entsteht auch nach dem
  Start, wenn die Konten auf 0 fallen; Sicherung vor dem Update nur, wenn wirklich eins kommt; DSGVO-Löschen räumt
  `linkedin_seen_messages`/`auto_search_checked` und löst `enrichment_requests`; „Wieder öffnen“ mit Termin → `meeting`.
- **Login-Backend:** Sitzungen und Konten in SQLite (`DATA_DIR/cockpit.db`). Testkonten `nick`/`johannes` (`demo`)
  nur mit `AUTH_DEMO_ACCOUNTS=true` **und** `AUTH_COOKIE_SECURE=false`, sonst startet das Backend nicht.
- **Demo-Leads:** erzeugt aus `src/data/` per `server/scripts/buildDemoSeed.ts` (nur gelesen). Änderst du die
  Demo-Daten, sag Bescheid, dann erzeuge ich den Seed neu.
- Simulation der Lead-Suche: Trichter 40 → 33 → 15 → 7 → 5 (unverändert). **Neu:** Die Datenbank ist zusätzliche
  Dubletten-Quelle. Schickt der Browser `known: []`, sind die 4 Demo-Leads trotzdem Dubletten, Grund dann
  „Bereits im Cockpit · Nick · Antwort“ (mit Stufe). Mit `known` bleibt der Grund wie bisher („… · Nick“).
  Die E2E-Erwartungen ändern sich dadurch nicht.
- Kundenmeeting 03.10.: Pipeline-Board wie Close, Tabellenansicht, Score-Karte, Ad-Historie, Signale, **Clay**.
  Konzept: `server/docs/SCORING.md`. Erfolg im Sinne des Lernens = **positive Antwort mit Terminwunsch**.
