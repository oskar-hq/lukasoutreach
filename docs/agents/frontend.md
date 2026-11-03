# Handoff · Frontend-Agent

> Nur der Frontend-Agent schreibt hier. Kurz halten, bei jedem Push aktualisieren, Erledigtes nach einer Woche löschen.

## Woran ich arbeite
- **`claude/firmenseiten-von-unten` (02.11., Nutzer, Backend + Frontend in einem)** – Einstellungen → LinkedIn → Accounts:
  Satz `linkedin-company-order` „Profile von oben nach unten, Firmenseiten von unten nach oben – nie über die Gründer“.
  Kein Vertrag. E2E `ohneShell`.
  **Dazu (Nutzer: „geänderte Vorlagen erscheinen nicht, andere sind weg“):** `firstFor`/`followupsFor` filtern nicht mehr
  nach Segment – Karten zeigen alle Vorlagen der Kategorie in Server-Reihenfolge (Kundentexte G/R/S vorn, FDL-Entwürfe
  dahinter). Vorher sahen FDL-Leads nur GF1/RF1/SF1. `templatesForSegment` (shared) bleibt für den KI-Vorschlag ohne
  Vorlage. E2E `templates` (Tab-Zahlen +1).
- **`claude/inspiring-wozniak-9jev4j` (01.11., Nutzer)** – Standard überall „Alle“: Leads (`scope` 'all') und Tagesstapel
  (`readStackScope` ohne Speicher → 'all', Schlüssel jetzt `cockpit.stackScope.v2.*` – alte Wahl einmal zurückgesetzt).
  Chats/Dashboard waren schon „Alle“. E2E: `signIn(page, founder)` wählt vorher „Meine“ (eigener Stapel),
  `signIn(…, 'default')` lässt den Standard; neue Prüfung in `stackScope`, `login` erwartet 28 statt 14. Kein Vertrag.
- **`claude/laughing-darwin-1pgq8m` (31.10., Nutzer)** – Dashboard: KPI „Übergaben“ raus (Close abgeschaltet), an ihrer
  Stelle `kpi-cost-per-lead` „Ø Kosten je qualifiziertem Lead“ (`aiCost.perQualifiedEur`, beide Gründer, Notiz statt
  Wochenvergleich: `KpiTile.note`). Zeile „Übergaben“ auch aus Nick vs. Johannes raus. Kein Vertrag. E2E `demo`.
- **`claude/practical-thompson-wknjtb` (28.10., Nutzer)** – Einstellungen → LinkedIn: Account-Liste (mit Such-Reihenfolge
  ↑↓) lädt sofort, nicht erst über „Accounts laden“. E2E `settings` (Wort „Simulation“ nur in Account-Namen erlaubt).
- **`claude/practical-thompson-wknjtb` (27.10. b, Wunsch des Nutzers)** – Einstellungen → Automatische Suche: Regler
  „Zielgruppen-Mix“ (`auto-mix-slider`, `auto-mix-ka`, `auto-mix-fdl`), speichert `kapitalanlagePercent`. E2E `autoSearch`.
- **`claude/practical-thompson-wknjtb` (27.10., Kundengespräch „neue Zielgruppe“, Backend + Frontend in einem)** –
  Lead-Suche: Zielgruppe als **Dropdown** `audience-select` (Beide · Kapitalanlage-Vertriebe · Finanzdienstleister,
  `AudienceSelect.tsx`), auch im Start-Dialog ohne „Anpassen“ (`sheet-audience`). Leads-Menü: „Alle Zielgruppen |
  Kapitalanlage | Finanzdienstleister | Bauträger“. Karten (Erstnachricht, Follow-up) zeigen nur Vorlagen des
  Lead-Segments (`firstFor/followupsFor(…, segment)`). Einstellungen → Vorlagen: Segment am Titel, „Für:“ beim Anlegen
  bzw. bei eigenen Vorlagen wählbar (`template-segment-select-*`). E2E `leadSearch` (Zielgruppe neu), `leads` angepasst.
- **`claude/tender-wright-1n6u9b` (25.10. b, Wunsch des Nutzers: UX-Leitfaden, vor allem weniger Auswahl und „zeigen,
  dass gearbeitet wird“; Regeln jetzt oben in `DESIGN.md`)** – Nur Frontend, kein Vertrag. **Weniger Auswahl:**
  Start-Dialog der Lead-Suche = ein Satz + „Jetzt suchen“, Werte hinter `sheet-adjust` „Anpassen“ (`sheet-settings`).
  Fünf Tabs: **„KI“ ist kein Tab mehr**, sondern Knopf `dashboard-ask` „KI fragen“ im Dashboard (`assistant-back` zurück,
  Tab „Dashboard“ bleibt markiert; E2E-Helfer `openAssistant`). Leads: Zielgruppe im Menü `leads-view-options`
  (`menuitemradio` „Beide Zielgruppen | Kapitalanlage | Bauträger“), „Kontakt hinzufügen“ auf dem Handy nur Symbol.
  Chats: Account als `<select data-testid="chats-account">` neben der Suche. Erstnachricht: Kategorie als Pille
  `audience-toggle`, `audience-picker` erst auf Klick. Dashboard: KI-Kosten und Lernen hinter `dashboard-more`.
  **Labor Illusion:** Suchlauf `RunNow` (`run-now`, `run-now-text`, `run-now-detail`, Balken + Restzeit beim
  Profilelesen, nur aus Phase/Status der Leads); KI-Vorschlag zeigt Schritte (`suggest-progress`, mind. 1,2 s);
  Firmendaten „Liest beispiel.de · …“. **Fortschritt:** Fokus-Kopf 4-px-Balken + `progress-remaining`
  (`remainingTime()`), Startseite `home-progress` und Serie `home-streak` (`useHomeStreak`, 2 min Cache),
  Einstellungen `settings-setup-progress`. **Höhepunkt/Ende:** `win-moment` nach Termin/Übergabe (1,6 s, blockiert
  nichts), „Gute Runde“-Hinweis beim Beenden mittendrin; `NOTIFY` hat jetzt `tone` (`good | neutral | bad`, Standard
  `bad`), „Kommt später wieder“ neutral. **Hervorheben:** Chats-Gruppe `chat-group-yours` „Wartet auf dich“ (Blau nur
  dort), Board-Marke `board-today` „heute · Follow-up“ (nicht bei neuen Leads).
- **`claude/dazzling-brown-e10lxk` (25.10., Kundengespräch, Backend + Frontend in einem)** – Lead-Suche: der Server hat
  die Leads am Ende des Laufs gespeichert (`run.saved`) → `LeadSearchProvider` zeigt sie sofort als übergeben, kein Knopf
  `handoff`/Rückgängig mehr (bleibt nur ohne `run.saved`, z. B. Admin). `leadSearchContext` schickt `owner`.
  `LeadCard`: Sperre und Satz je **Account** (`inviteViaByOwner[lead.owner]`, `invitesByAccount`,
  `invitesPerDayByAccount`), nicht mehr Anfragen je Besitzer gegen das Limit je Account. **Chats**: Standard „Alle“,
  Filter `Alle | Aktiv` (Antwort ≥ 1), Account-Schalter `Beide Accounts | Deiner | <Name>`, Account am Chat aus
  `chatAccount()` (`account` ?? `sentBy` ?? Besitzer), immer sichtbar. `FollowUpCard` mit `task.active`: eigener Text
  statt Vorlage, „Aktives Gespräch · nachfassen“. Senden oder Eintragen entscheidet für Nachrichten der Account aus
  `messageAccount(lead)` (sentBy), wie auf dem Server (`FocusView`, Karten, `LinkedInBlockLine`). Startseite zählt
  Anfragen über den eigenen Account. Nachrücker neuer Leads kommen sofort hinten in den Stapel (vorher erst nach
  Neuladen). Fremde Chats für Mitarbeiter nur lesbar (`chat-readonly`). Fehlgeschlagene, noch nicht gespeicherte
  Entscheidungen → `beforeunload`-Rückfrage. E2E `chats`, `leadSearch`, `accountSwitch`, `demo` angepasst.
- **`claude/great-pascal-o6ef7p` (24.10., Wunsch des Nutzers)** – „Meine“ leer oder erledigt (nur Gründer): statt
  „Heute steht nichts an“ bzw. Erfolgsbild `mine-done` mit Knopf `to-all` „Zu „Alle““ (↵) – weiter nur dort.
  E2E `stackScope.spec.ts`, `demo.spec.ts` angepasst.
- **`claude/great-pascal-o6ef7p` (23.10. e, Wunsch des Nutzers)** – Startseite mit festem Abstand von oben statt mittig
  (`pt` aus `--app-h`): Gruß, Schalter, Zahl und `start-focus` stehen in „Meine“ und „Alle“ an derselben Stelle; Platz für
  die Zeile der Arten und `followup-notice` ist immer reserviert.
- **`claude/great-pascal-o6ef7p` (23.10. d, Wunsch des Nutzers)** – Startseite ohne Scrollen und ohne Springen: beim
  Umschalten „Meine / Alle“ bleibt der alte Stand abgeblendet stehen, bis der neue Stapel da ist (`HomeView` merkt sich
  den letzten Inhalt); Erklärung zu „Alle“ nur noch als `title` an `stack-scope`; Follow-up-Hinweis als eine Zeile;
  Abstände und Zahl schrumpfen bei Fensterhöhe ≤ 920 px. Zahlen zählen beim Betreten in 0,45 s von 0 hoch
  (`CountUp` aus `Funnel.tsx`, jetzt mit `duration`). E2E `stackScope.spec.ts` angepasst (liest die Zahl erst im Stillstand).
- **`claude/great-pascal-o6ef7p` (23.10., Wunsch des Nutzers „ich finde nichts, Update ist zu viel“)** – Einstellungen neu
  aufgebaut: keine Kategorie-Ebene mehr – die erste Ebene zeigt alle Bereiche unter den Überschriften Outreach /
  Verbindungen / System (`settings-cat-*` sind jetzt Überschriften), je mit Symbol im schwarzen Kreis. Neuer Bereich
  `update` „Software-Update“ (`UpdatePage`, `useSoftwareUpdate` in `system/SystemSection.tsx`): ein Satz, ein Knopf
  `update-start`, Neuerungen nur auf Wunsch (`update-changes-toggle`), darunter `backup.updates` (automatisch).
  Bei neuer Version oben auf der ersten Ebene `settings-update-banner` mit `settings-update-start` – ein Klick, **kein
  Passwort**. „Sicherungen und Updates“ heißt jetzt „Sicherungen“. Tests: `helpers.openSettingsSection` ohne Kategorie.
  **Alle Seiten einfach (23.10. b/c):** oben der große Knopf (Verbindung testen, Update, Jetzt sichern, Jetzt einmal
  ausführen), darunter direkt die wichtigen Werte (`PAGE_PLAN` → Unterseite `<group>.main` mit `inline: true`, kurze
  Namen `SHORT_LABELS`), Ein/Aus als `QuickSwitch` (gilt sofort, Passwort/Rückfrage wo der Wert sie verlangt), eigene
  Bausteine als Zeile, der Rest unter „Erweitert“ (`<group>.more`). Software-Update: nur Knopf, „Version <commit>“,
  „Jede Nacht automatisch updaten“; Sicherungen: „Jetzt sichern“, Liste, „Jede Nacht sichern“ (`QUICK_TOGGLES`).
  Weg: Stand-Zeilen (`group-status-*`), „.env“ am Feld, Symbole an Namen, Schlüssel/Limits in „Auf einen Blick“,
  `auto-updated`/„Gut zu wissen“ bei der automatischen Suche.
- **`claude/festive-tesla-rf5q3l` (22.10. i, Wunsch des Nutzers)** – Verloren = Archiv: Board/Tabelle ohne `lost` (Ausnahme:
  mit Follow-up in eigener Spalte), Spalte „Verloren“ klein mit `lost-open` → `LostLeadsDialog` (`lost-search`, `lost-item`,
  `lost-reopen`); Menü „Übergebene zeigen“. E2E `leads.spec.ts`, `workflow.spec.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. h, Wunsch des Nutzers)** – Board: alle Spalten mit gleichem Kopf `ColumnHeader`
  (`board-column-title`, beim Überfahren `board-column-left/right/edit`), Reihenfolge aus `layout.order`, Stufen umbenennbar;
  eigene Spalten nicht mehr blau. E2E in `leads.spec.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. g, Wunsch des Nutzers)** – Claude-App verbinden: `components/mcp/McpConsent.tsx`
  (Freigabe bei `/?mcp_consent=`, nach der Anmeldung statt des Cockpits), `McpConnections.tsx` (Dialog im Tab KI, `mcp-open`),
  `/?lead=<id>` öffnet das Lead-Panel, `mcpApi`. nginx + vite leiten `/mcp` und `/.well-known/oauth-` ans Backend. E2E `mcp.spec.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. f, Wunsch des Nutzers)** – Tab **KI** (`View 'assistant'`, `nav-assistant`, Handy-Tab-Leiste jetzt mit
  so vielen Spalten wie Tabs): `components/assistant/AssistantView.tsx` (Chats links, `assistant-model` Modellwahl, Stream mit
  `assistant-tools`, `assistant-stop`, Vorschläge im leeren Chat), `Markdown.tsx` (Lead-Links → Lead-Panel). `assistantApi` in
  `leadSearchApi.ts` (SSE per fetch). E2E `assistant.spec.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. e, Wunsch des Nutzers)** – Schnellwahl jetzt 2 Tage · 4 Tage · 1 Woche · 2 Wochen
  (Lead-Panel `FollowUpEditor` und `later-menu`), im Menü zusätzlich eigenes Datum (`later-date`, `later-date-ok`).
- **`claude/festive-tesla-rf5q3l` (22.10. d, Wünsche des Nutzers)** – Fokus: `later` „Später“ (W) → `later-menu`
  (`later-1…4`), `decide({ action: null, resumeAt })` → `PATCH followUpPlan { at, column: null }` mit Rückgängig (Z).
  Startseite: `row-resume` „In 2 Wochen wieder“ bei followups_done/conversation_quiet. Lead-Panel `FollowUpEditor`: Spalte
  optional („Keine – Stufe bleibt“), Anzeige „pausiert bis …“ / „fällig“. Chats: `chat-meeting` „Termin vereinbart“,
  `chat-meeting-chip`. E2E `wiedervorlage.spec.ts`, `leads.spec.ts` angepasst.
- **`claude/festive-tesla-rf5q3l` (22.10. c, Wunsch des Nutzers)** – Automatische Suche: bei `followUpAt` zeigt `auto-next` →
  `auto-follow-up` „Sucht weiter – heute, 12:10“ (pulsierender Punkt) + „Pause zwischen zwei Läufen · bis 40 Leads“;
  Abfrage alle 5 s läuft auch in der Pause. E2E `autoSearch.spec.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10. b, Wunsch des Nutzers)** – `useCrm()` (`state/crm.ts`, ersetzt `useCrmMode`) mit `handover`.
  Aus: Antwort-Karte ohne Übergabe – Haupt-Aktion `reply-primary` „Termin vereinbart“ (sonst „Antwort senden“), ↵/→/Wischen
  ebenso; Lead-Panel `canHandOver` false; `StepRail` ohne „Übergabe“. Schalter `CRM_HANDOVER` unter Einstellungen → Close.
  E2E in `close.spec.ts`.
- **`claude/festive-tesla-rf5q3l` (22.10., Wunsch des Nutzers)** – Einstellungen → LinkedIn-Accounts: `linkedin-order-up/down`
  jetzt für alle Accounts (auch Gründer), gespeichert wird die ganze Liste; Gründer ohne Platz zeigen „Suche: zuletzt (Gründer)“.
  `auto-run` hat einen Hinweis (title), dass bis zum Tagesziel weitergesucht wird.
- **`claude/accounts-aufwaermen` (21.10., Wunsch des Nutzers)** – Einstellungen → LinkedIn-Accounts: Knopf `linkedin-warmup`
  („Aufwärmen“, nur Accounts ohne Gründer) → `UNIPILE_WARMUP_ACCOUNTS`; Zeile `linkedin-warmup-status` aus
  `linkedinApi.warmup()`. „Grenzen“ zeigt `LINKEDIN_WARMUP_PER_DAY`. E2E `ohneShell.spec.ts` (jetzt 3 Simulations-Accounts).
  **Dazu (21.10. b):** je Account `linkedin-order-up/down` (nur Scraping-Accounts, sofort gespeichert) und `linkedin-limits-toggle`
  → `AccountLimitsForm` (`linkedin-limit-*`, `linkedin-limits-save`, `linkedin-limits-result`).
- **`claude/vernetzt-zuruecksetzen` (20.10. e, Wunsch des Nutzers)** – Lead-Panel „Mehr“: `action-reset-invite` „Zurück auf
  „Anfrage gesendet““ (nur Stufe Vernetzt, mit Rückfrage) → `PATCH { stage: 'invited' }`. E2E `workflow.spec.ts`.
- **`claude/vernetzt-pruefen` (20.10. d, Wunsch des Nutzers)** – „Anfrage angenommen“ von Hand entfernt: Lead-Panel
  (`action-accepted` weg, Haupt-Aktion bei „Anfrage gesendet“ jetzt Notiz), Startseite (`row-accepted` weg), Board: Ziehen aus
  Neu/Anfrage gesendet nach „Vernetzt“ → `board-notice`, nichts geändert. E2E `workflow.spec.ts`, `leadPanel.spec.ts`.
- **`claude/wonderful-pasteur-koa2lt` (20.10., Wunsch des Nutzers)** – Lead-Panel „Daten“: Zeile `follow-up-plan` → `FollowUpEditor`
  (Schnellwahl 1 Woche…3 Monate, `follow-up-date`, `follow-up-column` mit „Follow“-Spalte vorgewählt, `follow-up-save`,
  `follow-up-remove`). Follow-up-Karte: Verlauf standardmäßig offen. E2E in `leads.spec.ts`. Chat-Abgleich
  (`settings/ChatSync.tsx`) aus den Chats nach **Einstellungen → LinkedIn** verschoben, startet erst nach Rückfrage
  (`chat-sync-confirm`, `chat-sync-confirm-start`). E2E jetzt in `ohneShell.spec.ts`.
- **`claude/wonderful-pasteur-koa2lt` (19.10. c, Wunsch des Nutzers)** – Chats: `ChatSyncButton` („Mit LinkedIn abgleichen“, `chat-sync-start`,
  Fortschritt „Abgleich läuft … x von y“, Ergebnis `chat-sync-result`, Abfrage alle 2 s, danach Chats + Stapel neu).
  E2E in `chats.spec.ts`.
- **`claude/wonderful-pasteur-koa2lt` (19.10. b, Wunsch des Nutzers)** – Leads-Board: in jede Stufe ziehbar, auch zurück (vorwärts nach
  Vernetzt/Termin/Verloren weiter als Aktion, sonst `PATCH stage`; `board-notice` für „geht nicht“ entfällt). Spalte
  „Antwort“ geteilt in `column-replied-interested` / `column-replied-not_interested` (eigene Ablagen, `stopPropagation`).
  Umschalter „Beide / Kapitalanlage / Bauträger“ (`category=`, in localStorage `cockpit.leads.segment`). E2E in
  `leads.spec.ts`, `manualFlow.spec.ts` angepasst (Termin aus „Anfrage gesendet“ geht jetzt).
- **`claude/wonderful-pasteur-koa2lt` (19.10., Wunsch des Nutzers; ein Agent für beide Seiten)** – Leads-Ansicht: Knopf „Kontakt hinzufügen“
  (`contact-add`) öffnet `AddContactDialog` (`contact-dialog`, `contact-profile-input`, `contact-submit`, `contact-error`),
  `leadsApi.addContact` → Hinweis `contact-notice` und Lead-Panel öffnet sich. Panel-Chip „Persönlicher Kontakt“
  (`contact-chip`). Besitzer = gewählter Gründer. E2E in `leads.spec.ts`. Backend-Teil siehe `backend.md`.
- **`claude/wonderful-bell-vongu4` (18.10. b, Wunsch des Nutzers)** – `useSendState(owner)` in `actionMode.ts`: „Senden“
  hängt am Account des **Besitzers** (nicht mehr immer „von Hand“ für fremde Leads); `reason` off/account/role für den
  Hinweis auf der Karte (`protocol-note` sagt jetzt „Der LinkedIn-Account von … ist nicht verbunden“ statt „Echt
  senden einschalten“, wenn es schon an ist). `LinkedInBlockLine` nimmt `owner`, Chats senden über den Besitzer.
- **`claude/wonderful-bell-vongu4` (18.10., Wunsch des Nutzers; ein Agent für beide Seiten)** – Startseite: Phase
  `paused` (`account-paused`, „Deine Aufgaben sind pausiert.“ + `ACCOUNT_PAUSED_MESSAGE`), wenn der eigene Gründer in
  `stack.accountPaused` steht (nur „Meine“). LeadCard: Hinweis `adopted-from` bei `task.adoptedFrom`; `useTaskCard`
  behält für übernommene Leads den Besitzer aus der Aufgabe (der nachgeladene Lead hat noch den alten). E2E
  `accountPause.spec.ts` (Antwort von `/api/tasks` verändert, die Simulation hat beide Accounts).
- **`claude/lead-detail-implementation-b4rzt8` (16.10., Wunsch des Nutzers „als Nick auch Johannes' Aufgaben“; ein Agent für
  beide Seiten)** – Startseite: Umschalter „Meine / Alle“ (`stack-scope`, `scope-mine`, `scope-all`, nur Gründer-Konten,
  `DemoState.scope`, `SET_SCOPE`, gespeichert je Gründer in localStorage, vorher `prepareSignOut`). „Alle“ lädt
  `GET /api/tasks?owner=all` (`stackOwnerOf`), Karte zeigt `for-founder` „Für Johannes · über Johannes' LinkedIn“,
  `useActionMode(owner)` = immer „von Hand“ für fremde Leads. Wartende Verlaufseinträge `by` = Besitzer. E2E
  `stackScope.spec.ts`.
- **`claude/lead-detail-implementation-b4rzt8` (15.10. b, Meldung des Nutzers „Werbebibliothek führt nicht zur Seite“)** –
  `libraryLink` in `lib/leadView.ts` ergänzt alte Seiten-Links um `search_type=page` (sonst leeres Suchfeld), auch in der
  Ergebnisliste. Chip „Werbebibliothek“ nur mit Seiten-ID, sonst „Werbebibliothek · Suche“ (`metaLibraryIsPage`).
  Meta-Zeile „aus seit 09.10.2026 · vor 6 Tagen“ (`metaStoppedText`, bei jedem Öffnen neu gerechnet). Backend-Teil siehe
  `backend.md` (ein Agent für beide Seiten, Wunsch des Nutzers).
- **`claude/lead-detail-implementation-b4rzt8` (15.10., Entwurf des Nutzers „Lead-Ansicht Redesign“ aus Claude Design)** –
  Lead-Panel neu: Chips (`score-card`, Lead-Typ, Grad, LinkedIn, `meta-library-link`, `crm-link`), Statuskarte
  (`status-card`, `status-stage`, Schritt x von 7 aus `STAGE_STEPS`, Hinweis je Stufe, „seit 4 Tagen“ bei „Anfrage
  gesendet“), Reiter `lead-tab-overview|history|analysis` (alle eingehängt, `hidden`). Übersicht: „Warum dieser Lead“,
  „Daten“ (Zeilen `next-step`, `deal-value`, `meta-ads`, `hiring`, `owner` → Sheet), Lead-Qualität. Verlauf neuester oben,
  farbige Art (Quelle/KI/Kontakt/Status/Notiz). Unten eine Haupt-Aktion je Stufe (`primaryAction` in `lead/leadStage.ts`,
  `testId` wie bisher `action-invite-sent`, `action-form-message` …), `footer-note`, `footer-more` → Sheet
  `panel-sheet` (übrige Aktionen, `action-owner`, `lead-export`, `lead-delete`). Texte im Sheet: `action-text`,
  `action-submit`. **Vollbild** (Wunsch des Nutzers): am Desktop Leiste „Schließen Esc“ (`panel-close`), Inhalt mittig
  max. 1120 px, Kopf links + Statuskarte rechts, Übersicht/Analyse zweispaltig (`lg`), Sheets als Dialog in der Mitte,
  Aktionsleiste rechtsbündig. Handy unverändert. Desktop: kompaktere Zeilen, Kürzel ↵ Haupt-Aktion · N Notiz · M Mehr ·
  1–3/V Reiter (sichtbar per `Kbd`), Fokus zurück an den Auslöser. Baut auf `claude/meta-link` auf (gemergt). Kein
  Vertrag geändert. E2E angepasst, neu: Tastatur-Test in `leadPanel.spec.ts`.
- **`claude/meta-link` (15.10., Wunsch des Nutzers)** – Meta-Werbebibliothek mit einem Klick: Lead-Panel (Zeile oben neben
  LinkedIn, `meta-library-link`) und Meta-Warnung der Erstnachricht („Werbebibliothek öffnen“). `metaLibraryUrl` in
  `lib/leadView.ts`: Link der Prüfung, sonst Suche nach dem Firmennamen. E2E `outreachFixes.spec.ts`.
- **`claude/meta-nachpruefung` (15.10., Wünsche des Nutzers; ein Agent für beide Seiten)** – Automatische Suche: Zeile
  „Heute: 8 Läufe · 43 von 40 Leads“ (`auto-today`, `todayText`) über „Letzter Lauf“, der nur den jüngsten Lauf zeigt.
  Erstnachricht: Kategorie von Hand wählen (`audience-picker`, `audience-<greenfield|reactivation|active|hiring>`),
  danach keine Meta-Warnung. Lead-Panel: „Übersprungen bis … · Zurück in den Tagesstapel“ (`panel-snoozed`,
  `panel-unsnooze`). Ergebnisliste: „LinkedIn“ neben „Qualifizieren“ (`qualify-profile-link`). Einstellungen →
  Meta-Werbebibliothek: „Alle Leads nachprüfen“ (`meta-recheck`, `settingsApi.metaRecheck/startMetaRecheck`), Panel zeigt
  „über den privaten Namen“. E2E `outreachFixes.spec.ts`, `autoSearch`, `leadSearch`.
- **`claude/hiring-signal` (13.10., Wunsch des Nutzers; ein Agent für beide Seiten)** – Erstnachricht: Mit
  `lead.hiring` zuerst die Recruiting-Vorlagen (`firstAudiences` in `lib/template.ts`), danach die zum Lead-Typ; Variable
  `stelle`, keine Meta-Warnung bei Recruiting. Signalzeile „… · Sucht: Vertriebsmitarbeiter (m/w/d)“ (`leadSignal`).
  Lead-Panel → Eintragen: „Sucht Mitarbeiter“ (`hiring`, `hiring-form`, `hiring-role`, `hiring-save`, `hiring-remove`).
  Vorlagen-Seite: Kategorie „Erstnachricht · Sucht Mitarbeiter“, Hilfe zu `{{stelle}}`.
  **„Jetzt nicht“** im Fokus-Modus (`defer`, Taste J): Aufgabe ans Ende des Stapels, nichts gespeichert, Hinweis mit
  „Ansehen“; sind im Filter alle Aufgaben zurückgestellt, geht es mit „Alle Aufgaben“ weiter (`DEFER`,
  `stack.deferred`). E2E `hiring.spec.ts`, `templates.spec.ts` (H1).
- **`claude/suchtreffer-warteliste` (13.10. c, Wunsch des Nutzers)** – Alle Bottom-Sheets (`ui/Modal.tsx`) lassen sich mit
  dem Finger **überall** nach unten wegwischen, nicht nur am Griff: `lib/sheetSwipe.ts` (Touch-Events, `preventDefault`
  nur nach unten am oberen Rand; scrollt der Inhalt, erst scrollen). Griff mit Maus wie bisher. E2E `leadSearch.spec.ts`
  (Touch). Bereiche, in denen Ziehen etwas anderes heißt: `data-no-swipe`.
- **`claude/suchtreffer-warteliste` (13.10. b, Wunsch des Nutzers)** – Start-Dialog „Suche starten“ auf dem Handy: Inhalt
  scrollt im Sheet (`sheet-scroll`, `overscroll-contain`, Höhe `--sheet-inner-max-h`), Abbrechen/„Jetzt suchen“ fest
  unten (`sheet-actions`). Vorher wuchs der Inhalt über den Bildschirm, gescrollt hat die Seite dahinter. E2E
  `leadSearch.spec.ts`.
- **`claude/lead-lernen` (13.10.)** – Lead-Panel → Eintragen: „Lead-Qualität: Passt / Passt nicht“ (`lead-feedback-*`,
  Gründe `lead-feedback-reason-*`, automatisch `lead-feedback-auto`) über `leadsApi.update(…, { feedback })`. Dashboard:
  Abschnitt `dashboard/LearningSection.tsx` (`learning-section`, `learningApi.get`). E2E `learning.spec.ts`.
- **`claude/suchtreffer-warteliste` (13.10.)** – Automatische Suche: „Heute: … 100 von 100 Profilabrufen“ und der
  Stopp-Grund in Warnfarbe (`auto-stop-reason`) unter dem Tagesziel. E2E `autoSearch.spec.ts`.
- **`claude/suchtreffer-warteliste` (12.10. g, Wunsch des Nutzers)** – Trichter ohne „ohne Meta-Ads“-Stufe
  („7 qualifiziert · 2 davon schalten gerade Meta-Ads“, Reiter „Schalten Meta-Ads“), `audienceFor` kennt `active`.
  Einstellungen: Modell per Auswahl (`SettingField` → `ModelSelect`, `model-select`/`model-input`). Suche: Zielgruppe
  (`audience-picker`, Kapitalanlage/Bauträger/Beide). Tagesstapel: `AccountHint` (`account-hint`) auf Lead-, Erst-,
  Follow-up- und Antwortkarte; Sperre erst bei `inviteVia === null`; Menü „Zweiter Account“. E2E `accountSwitch.spec.ts`,
  `settings`, `leadSearch`, `templates`.
- **`claude/suchtreffer-warteliste` (12.10. f, Wunsch des Nutzers)** – Ergebnisliste: „Qualifizieren“
  (`qualify-manually`) bei Aussortierten/Zurückgestellten; vor der Übergabe zählt der Lead mit, danach legt
  `LeadSearchProvider.qualify` ihn sofort an (`manual-placed`). Spielstand nach der Suche `leadSearch/RunScore.tsx`
  (`run-score`: neue Leads, KI-Kosten je Lead mit Vergleich zur letzten Suche, Trefferquote, Tagesziel bzw. Warteliste,
  Konfetti einmal je Lauf). `Confetti` aus `SuccessScreen` exportiert. E2E `leadSearch.spec.ts`.
- **`claude/suchtreffer-warteliste` (12.10. e, Wunsch des Nutzers)** – Start-Dialog: Kasten „So läuft diese Suche“
  (`sheet-run-plan`: Warteliste + neue Treffer = Treffer, höchstens N Profile, Rest → Warteliste; Hinweis bei
  angehobenen Treffern). Laufansicht: „N Treffer aus der Warteliste · bis zu M neu gesucht“ (`run-search-plan`, nur
  live). Zeitschätzung rechnet wie das Backend. E2E `leadSearch.spec.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (12.10. d)** – Variable `metastopp` in `lib/template.ts` und Vorlagen-Hilfe; E2E auf
  eine Follow-up-Vorlage je Stufe umgestellt (Taste 1 statt 2, eigene Vorlage = B).
- **`claude/dreamy-heisenberg-tnoyz3` (12.10. c, Wunsch des Nutzers)** – Lead-Suche: „Suche starten“ (↵) öffnet
  `leadSearch/SearchStartSheet.tsx` (Modal/Bottom-Sheet) mit Profile pro Lauf (nur dieser Lauf) und
  `SEARCH_HITS_PER_RUN`, `QUALIFY_MIN_CONFIDENCE` (in %), `AUTO_QUALIFY_TERMS`, `LEAD_DISTRIBUTION` (über
  `/api/settings`, gelten danach weiter); „Jetzt suchen“ (↵, `start-search-confirm`) speichert Geändertes und startet.
  Ohne Rechte für Einstellungen (Mitarbeiter): nur Profile pro Lauf. E2E `leadSearch.spec.ts`, `login.spec.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (12.10. b)** – Einstellungen → Lead-Suche: Unterseite „Ohne KI qualifizieren“
  (`AUTO_QUALIFY_TERMS`, `settingsNav.ts`). Sonst keine Oberfläche geändert.
- **`claude/einstellungen-untermenues` (Wunsch des Nutzers 11.10. j)** – Einstellungen als Untermenüs wie Trade
  Republic: erste Ebene (Suche, Auf einen Blick, Verbindungen, Outreach, System) → Kategorie → Bereich (Zeilen
  „Name · Wert ›“, Stand, Verbindungstests) → Unterseite mit höchstens 4 Werten (`settingsNav.ts` → `PAGE_PLAN`,
  `SUBPAGES`). `MenuRow.tsx`, `SettingField` mit `solo`, Esc/„‹ Zurück“, Suche findet Werte (`settings-result-*`),
  Sprungziele (`openSettingsTab(section, page)`) nur einmal. Test-Helfer `openSetting(page, key)`; Test-IDs
  `settings-cat-*`, `settings-row-<group>.<name>`, `settings-page-*`. Kein Vertrag geändert.
- **`claude/mobile-web-app` (Wunsch des Nutzers 11.10. i)** – Handy wie eine iOS-App (Home-Bildschirm): Tab-Leiste unten
  (`TopNav.tsx` → `PhoneNav`/`TabBar` unter 640 px, sonst `DesktopNav`; Test-IDs `nav-*` bleiben, neu `tab-bar`),
  Kopfleiste mit Titel beim Scrollen, Manifest `public/manifest.webmanifest` + iOS-Meta (`viewport-fit=cover`),
  Safe-Area-Variablen `--safe-*`, `--nav-top/-bottom`, `--app-h`, `--sheet-max-h` in `index.css` (alle festen
  Leisten/Höhen umgestellt), Felder ≥ 16 px auf Touch (kein iOS-Zoom), Tab-Wechsel beginnt oben. Regeln für künftige
  Features: `DESIGN.md` → „Mobil = native iOS-App“. E2E `mobile.spec.ts`. Kein Vertrag geändert.
- **`claude/dreamy-heisenberg-tnoyz3` (11.10. h, ein Agent baut beide Seiten)** – Dashboard: `dashboard/AiCostSection.tsx`
  (KI-Kosten Monat/Gesamt/je Lead/je Zweck, „Deal Value deckt die KI-Kosten x-fach“) unter dem Deal Value;
  Automatische Suche: „KI-Tagesbudget in € (0 = ohne)“ statt „Höchstens Suchläufe“ (nur ohne Budget sichtbar),
  Statuszeile mit Budget; Einrichtung „Tagesziel“: Budget-Stepper statt Suchläufe. E2E `autoSearch`, `onboarding`,
  `leadPanel`. Deal-Value-Karte zeigt „KI-Kosten bisher … · Ø je Abschluss …“ (`deal-value-ai-cost`), Einzelheiten unter dem ersten
  Bildschirm mit „Ø je qualifiziertem Lead“ (`ai-cost-per-lead`) und „Ø je abgeschlossenem Lead“ (`ai-cost-per-closed`);
  Dashboard lädt jede Minute neu, solange der Tab sichtbar ist.
- **`claude/compassionate-pasteur-09u8ux` (Wunsch des Nutzers 11.10. g)** – Dashboard ohne Scrollen: „Offener Deal Value“
  als kompakte Karte neben dem Trichter (`xl:grid-cols-4`, Testids unverändert). Leads-Board in voller Monitorbreite:
  Spalten `flex-1` (min. 150 px, ausgeblendete Endstufen schmaler), „+ Eigene Spalte“ zugeklappt nur als „+“. Kein
  Vertrag geändert.
- **`claude/dreamy-heisenberg-tnoyz3` (11.10. f)** – Einstellungen → Senden über LinkedIn: `settings/UnsentInvites.tsx`
  (Liste mit Häkchen, „N zurück in den Tagesstapel“); Vorlagen: Kategorie „Vernetzungsanfrage“ ausgegraut + Hinweis bei
  `INVITE_NOTE=off` (liest `/api/settings` beim Öffnen). E2E `ohneShell.spec.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (11.10. e)** – automatischer Abgleich beim Öffnen auch bei `mode: 'off'`, wenn
  `status.watching`; Hinweis „Angenommene Anfragen erkennt es automatisch“.
- **`claude/dreamy-heisenberg-tnoyz3` (Sperre 11.10. d)** – Karte „Neuer Lead“: „Vernetzen“ gesperrt + Hinweis
  `invite-limit-reached`, sobald `invitesToday ≥ rules.invitesPerDay`; Startseite zählt gegen dieses Limit. E2E `demo.spec.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (Wunsch des Nutzers 11.10. c)** – Lead-Panel: „Deal Value“ und „Meta-Ads“ (Nie
  geschaltet/Aus seit/Läuft) unter „Eintragen“; Dashboard „Offener Deal Value“ (Summe + Balken je Stufe); Karte „Neuer
  Lead“: Notiz nur mit `rules.inviteNote !== false`, im Eintragen-Modus Hinweis `protocol-note`; Variable `metapause`.
  E2E `leadPanel.spec.ts`, `demo.spec.ts`.
- **`claude/dreamy-heisenberg-tnoyz3` (Wunsch des Nutzers 11.10. b)** – „Profile pro Lauf“ (Lead-Suche + automatische
  Suche) und „Suchläufe pro Tag“ frei eintippbar ohne „von 25/10“ (`Stepper` `showMax`); Einstellungen → LinkedIn
  (Unipile): „Such-Account der Lead-Suche“ (`SearchAccountPicker`, setzt `UNIPILE_ACCOUNT_ID`), Lead-Suche „Account
  ändern“ führt dorthin. E2E `leadSearch`, `autoSearch`, `settings`, `ohneShell`.
- **`claude/dreamy-heisenberg-tnoyz3` (Kunden-Feedback 11.10., ein Agent baut beide Seiten)** – Trichter mit Stufe
  „vorgeprüft“, „angereichert“ heißt jetzt „Profil gelesen“; Status `screened_out` („Vorprüfung: passt nicht“, unter
  Aussortiert, Zusammenfassung „x in der Vorprüfung aussortiert“), Detail „Vorprüfung: passt vermutlich/unklar“;
  Suchzeile „400 Treffer“ + Hinweis zu Profilbesuchen; Zeitschätzung mit Suchseiten; `screened_out` zählt als geprüft
  (`LS_RUN`); automatische Suche: Feld „2. Uhrzeit (optional)“ (`secondTime`). E2E `leadSearch.spec.ts`, `autoSearch.spec.ts`.
- **`claude/redesign-v2`** (Wunsch des Nutzers 09.10., baut auf `claude/vorlagen-einstellungen` auf) – ganze Software im
  Look v2 (DESIGN.md oben): neue Farb-Tokens in `index.css`, Kopfleiste 72 px mit Navigation rechts, blauer Avatar,
  Knöpfe/Segmente/Felder ohne Rahmen, keine Trennlinien in Listen, Chats ohne Rahmen (Gespräch als Fläche), neues
  Favicon + Logo (`public/favicon.svg`, `apple-touch-icon.png`, `icon-512.png`, `layout/Logo.tsx`).
- **`claude/vorlagen-einstellungen`** (Wunsch des Nutzers 09.10., ein Agent baut beide Seiten) – Vorlagen je Kategorie
  (Vernetzungsanfrage, Erstnachricht Greenfield/Reactivation, Follow-up 1–3) mit A bis Z: „+ Vorlage“ legt an, „Löschen“
  entfernt, die letzte einer Kategorie bleibt; Karten zeigen dieselben Buchstaben, ab I über „Weitere“
  (`stack/MoreTemplates.tsx`). Alle Einstellungsseiten im Look „Server und Anmeldung v2“: Stilbausteine in
  `settings/look.ts`, Zeile = Beschriftung links/Steuerung rechts, Hilfetexte nur für Screenreader, Zahlen als
  Stepper, grüner Schalter, „Gespeichert“ neben dem Titel. E2E `templates.spec.ts`.
- **`claude/friendly-davinci-evy5vr` (Leads auf beide Gründer, Wunsch aus backend.md `fix/split`)** – Chats: Auswahl
  „Meine | Alle“ (`conversationsApi.list()` ohne `owner`), in „Alle“ je Chat „über deinen Account“ / „über Johannes'
  Account“ aus `lead.owner`, im Gespräch immer; letzte eigene Nachricht eines anderen Gründers „Johannes: …“ statt „Du:“.
  Übergabe: Leads in `created` mit fremdem `owner` → Meldung „4 Leads bei dir, 3 bei Johannes“ (`createdOthers`), nur
  eigene kommen in `handoffFirst`. Kein Vertrag geändert. E2E `chats.spec.ts`, `leadSearch.spec.ts` (Verteilung per
  `page.route` simuliert, bis `fix/split` im Mock gemergt ist). Offen: Punkte 3 (`origin.searchedBy`) und 4 (Hinweis
  bei `balanced`) aus backend.md. Randfall: Wird eine Übergabe nach Netzfehler wiederholt, zählen dem anderen Gründer
  schon zugeteilte Leads als „schon im Cockpit“ (Backend meldet sie in `skipped`) – nur die Meldung, keine Daten.
- **`claude/pensive-shannon-gzgyij` (Review 09.10. b)** – angefangene Antwort wird nur nach „gesendet“ gelöscht (nicht
  bei Termin/Kein Interesse/Übergabe); `forgetLead` verwirft laufendes Laden des Stapels (`requestId`), Hinweis nennt den
  Stapel nur, wenn Aufgaben entfernt wurden; Erstnachricht aus einem veralteten Tab gilt als erledigt, wenn der Lead
  schon angeschrieben ist (kein Follow-up 1). E2E `manualFlow.spec.ts`, `demo.spec.ts`.
- **`claude/pensive-shannon-gzgyij`** – Review-Befunde: angefangene Antwort wird gelöscht, sobald eine Nachricht an
  den Lead über Chats oder „Nachricht gesendet“ (`mutateLead(…, { messageSent })`) gespeichert ist, bei Entscheidungen
  auf der Antwort-Karte erst nach dem Speichern (Rückgängig behält den Text); `reflects()` kennt `meeting_booked` und
  `message_received` (409 aus anderem Tab = gespeichert); wieder geöffnete aktuelle Karte bleibt an ihrem Platz.
  E2E `tests/manualFlow.spec.ts`.
- **`fix/flow2`** – Sackgassen im manuellen Betrieb (ein Agent baut beide Seiten): 404 eines Leads (`not_found`,
  gelöscht) verwirft nur dessen Aufträge/Aufgaben (`LEAD_GONE`, `outbox.discardQueue`) statt alles zurückzusetzen –
  Hinweis „Lead gibt es nicht mehr (gelöscht)“; „Wieder öffnen“ holt eine schon entschiedene Aufgabe zurück
  (`Outcome.savedAt`); angefangene Antwort wandert auf die nächste Antwort-Aufgabe (`state/replyDrafts.ts`); neuer Tag
  auch im 60-s-Takt; Karten: „<Name> hat geantwortet“ (A) auf Erstnachricht/Follow-up, „Termin vereinbart“ (T) auf
  der Antwort; Panel: „Anfrage gesendet“, „Nachricht gesendet“; Board: „Termin“ nur wenn erlaubt, „Neu“ und übrige
  Stufen je eigene Abfrage (Limit je Teil); Chats: verloren/übergeben → nur Antwort eintragen + „Wieder öffnen“.
  E2E `tests/manualFlow.spec.ts`.
- **`fix/ops`** – Betrieb und Datenschutz (ein Agent baut beide Seiten): unten im Lead-Panel „Daten exportieren“ und
  „Lead endgültig löschen“ mit Rückfrage im Panel (`LeadDataActions.tsx`, nur Admin/Gründer); unter Sicherungen und
  Updates freier Speicherplatz, Art „vor einem Update“ und „Schlüssel für Geheimnisse anzeigen“ (mit Passwort).
  `leadsApi.exportData/remove`, `systemApi.settingsKey`, gemeinsamer Datei-Download `fetchFile`/`saveBlob`.
  E2E `tests/datenschutz.spec.ts`.
- **`fix/workflow`** – manueller Betrieb (ein Agent baut beide Seiten): Startseite „Braucht Aufmerksamkeit“ + „Offene Anfragen“ (`HomeLists.tsx`, „Angenommen“/„Verloren“ mit einem Klick), Panel „Anfrage angenommen“/„Wieder öffnen“, Board: Anfrage → Vernetzt ziehen, „Verloren“ mit Rückfrage, Abgeschlossene ausgeblendet + Limit-Hinweis (`sort=recent`), neue Leads kommen hinten in den offenen Stapel, lange Wörter brechen in Chat-Blasen um.
- **`claude/neuigkeiten`** – Neuigkeiten (Wunsch des Nutzers 08.10., ein Agent baut beide Seiten): Glocke links neben
  dem Avatar (`src/components/layout/NotificationBell.tsx`), Punkt in der Farbe des Wichtigsten, Liste mit Klick zum
  Ziel, Mitarbeiter sehen „Sag … Bescheid“ statt Sprüngen in Einstellungen. Der blaue Punkt am Avatar für wartende
  Registrierungen ist weg (steht jetzt an der Glocke). Gründernamen aus den Konten: `applyFounderNames` in
  `src/data/founders.ts` (beim Anmelden, im `AuthProvider`), Dashboard-Beschriftungen. Einladungsseite mit Feld
  „Dein Name“. E2E `tests/notifications.spec.ts`; DESIGN.md §7 Navigation angepasst.
- **`claude/sicherheit`** – Sicherheits-Prüfung (Wunsch des Nutzers 08.10., ein Agent baut beide Seiten): nginx setzt
  CSP (`script-src 'self'`, `frame-ancestors 'none'` …), HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`; Cache-Regeln per `map` (sonst erben locations die Header nicht), Zugriffsprotokoll ohne Query.
  **Dieselben Header in `vite.config.ts` → `preview`**, die E2E-Tests laufen also mit der CSP – neue Skripte, Styles
  oder Quellen von außen brauchen eine Anpassung an **beiden** Stellen. Log-Rotation in `docker-compose.yml`.
- **`claude/onboarding` (3)** – Einrichtung: Schritt „Tagesziel“ (`TargetStep.tsx`, Ziffernblock wie Trade Republic),
  Einstellungen → Automatische Suche mit „Qualifizierte Leads pro Tag“ und „Höchstens Suchläufe pro Tag“.
- **`claude/onboarding` (2)** – Einrichtungs-Assistent: neuer Schritt „Bisherige Leads“ (`HistoryStep.tsx`) lädt die
  Excel-Liste über `PUT /api/lead-search/tracking` hoch (wie bei der Lead-Suche). Keine Vertragsänderung.
- **`frontend/einstellungen-untermenues`** – Einstellungen mit Untermenüs (Wunsch des Nutzers 08.10., nach Entwurf):
  Seitenleiste „Auf einen Blick · Verbindungen · Outreach · System“ mit Suche statt vier Reitern und Klappbereichen;
  auf dem Handy Liste → Bereich mit „‹ Einstellungen“. Kennzeichen („geändert“, „Prüfen“, „Fehlt“) in der Leiste,
  Entwürfe bleiben beim Wechseln. Vorlagen, Automatische Suche und System sind Untermenüs; System heißt jetzt
  „Sicherungen und Updates“ (Werte darunter). Struktur in `src/components/settings/settingsNav.ts`, E2E-Helfer
  `openSettingsSection`. Keine Vertragsänderung.
- **`frontend/bewegung-feinschliff`** – Animations-Audit umgesetzt (Wunsch des Nutzers 08.10.): keine doppelten
  Einblendungen (Startseite, Lead-Suche), Panel-Verlauf ohne Staffel, Fokus-Ausblenden mit `EASE_OUT`, Sheet/Panel
  blenden bei reduzierter Bewegung über, Dashboard-Balken nur einmal pro Besuch (0,5 s), Pulsieren steht bei reduzierter
  Bewegung still, gemeinsames Modul `src/lib/motion.ts`. Keine Vertragsänderung.
- **`frontend/bewegung-luecken`** – fehlende Übergänge (Wunsch des Nutzers 08.10.): neue Zeilen der Live-Liste,
  geöffnete Einstellungs-Bereiche und nachgeladene Firmendaten blenden per `@starting-style` ein; Chats auf dem Handy
  gleiten von rechts herein und nach rechts hinaus. Regeln in `DESIGN.md` §8. Keine Vertragsänderung.
- **`frontend/apple-design`** – ganze Oberfläche gegen Apples „Designing Fluid Interfaces“ geprüft (Wunsch des Nutzers
  08.10.): Druck-Rückmeldung für alle Knöpfe (globale Regel in `src/index.css`), Wischkarte/Sheet/Panel übergeben die
  Fingergeschwindigkeit, Dialog auf dem Handy als wegziehbares Bottom-Sheet, Seitenpanel per Finger nach rechts
  wegwischen, `touch-pan-y` für Gesten ohne eigenen Listener (sonst bricht der Browser sie ab), Balken per
  `transform` statt `width`, Ansichtswechsel blockiert nur noch 0,1 s, kein künstliches Warten beim Login,
  `reduced-transparency:`-Variante. Neue Helfer `src/lib/gesture.ts`. Regeln in `DESIGN.md` §6, §8, §12. Keine
  Vertragsänderung.
- **Onboarding ohne Shell** (Wunsch des Nutzers 08.10., ein Agent baut beide Seiten, Branch `claude/onboarding`):
  Anmeldeseite mit „Gründer-Konto erstellen“ (erstes Konto) bzw. „Registrieren“ (`/registrieren`), Einrichtungs-
  Assistent für alle Schlüssel (`src/components/onboarding/SetupWizard.tsx`), Warteseite bis zur Freigabe,
  Einarbeitung (`WorkIntro`), Konten → „Warten auf Freigabe“ mit `ApproveDialog`, Mitarbeiter für mehrere Gründer
  (Checkboxen `FounderChecks`, Umschalter „Aufgaben von“ im Konto-Menü, blauer Punkt bei wartenden Registrierungen).
- **Wünsche 07.10.** (ein Agent baut beide Seiten, Branch `claude/pensive-shannon-gzgyij`): aktive Meta-Ads gehen
  markiert mit in den Tagesstapel (`HANDOFF_STATUSES`, Übergabe 7 statt 5 im Mock, Trichter bleibt 40 → 33 → 15 → 7 → 5),
  70/30 der automatischen Suchläufe (`AutoSearchFocus`, Migration 17; die Mischung im Tagesstapel ist
  wieder raus), Aussortier-Grund „Falsche Branche“ mit Erklärung, Follow-up-Hinweis auf der Startseite (keine
  Slack-Erinnerung, Wunsch des Nutzers), Sicherungen nach 7 Tagen löschen (`BACKUP_MAX_AGE_DAYS`, neue Einstellung), Test-LinkedIn-Account
  (`/api/linkedin/test-profile`, `/test-message`, `/test-connect`) statt Test-Anfrage in der Oberfläche,
  Antwort direkt in der Antwort-Karte, Chats (`GET /api/conversations`), eigene Board-Spalten (`/api/board/columns`,
  `boardColumn`, Migration 18), Einstellungen mit „Auf einen Blick“.
- **Echter Betrieb** (Wunsch des Nutzers 07.10., ein Agent baut beide Seiten, Branch `claude/pensive-shannon-gzgyij`):
  Demo-Hinweis, Modus-Schild „Simulation/Live“, „Demo zurücksetzen“ und der simulierte Slack-Ping sind raus
  (`DemoBadge.tsx`, `SlackToast.tsx`, `src/data/pingDemo.ts` gelöscht, `?ping=` wirkungslos). E2E prüfen, dass nirgends
  „Simulation“/„Demo“ steht. Interne Namen (`useDemo`, `src/state/demo.tsx`) bleiben – Umbenennen nur nach Absprache.
- **`frontend/aufgeraeumt`** – Design aufgeräumt (Wunsch des Nutzers 07.10.): neue Bausteine `src/components/ui`
  (`PageHeader`, `Disclosure`, `DisclosureRow`, `Status`, `SectionLabel`, `MetaLine`); Einstellungen/Konten im
  Avatar-Menü; Startseite, Fokus-Karten, Panel, Lead-Suche, Leads, Dashboard, Einstellungen aufgeräumt; nichts
  entfernt, Seltenes einen Klick entfernt; keine Vertragsänderung. Regeln in `DESIGN.md` (§1, §6, §7, §15).

- **`frontend/minimal-schritte`** (baut auf `frontend/aufgeraeumt` auf, enthält es samt Merge von `main`
  #55–#58): Arbeitsschritte minimalistisch (Wunsch des Nutzers 07.10.) – Schrittleiste Vernetzen → Nachricht →
  Follow-up → Antwort → Übergabe statt Überschrift, ein Status-Satz statt KI-Blöcken, bei allen Schritten außer
  Vernetzen „Deine Nachricht …“ mit „Leeren & selbst schreiben“, Notiz bei der Übergabe auch ohne Close. Neuer
  Erfolgs-Screen `SuccessScreen.tsx` (Haken, Konfetti, Tagesbilanz, Serie „Tage in Folge“ aus `GET /api/dashboard`).
  Leads-Board als ruhige Zeilen. Keine Vertragsänderung.

## Fertig (PRs)
- #52 „Nie auf die Shell“: Konten, LinkedIn einrichten, Einstellungen → System, Sicherungen, Update-Dienst (gemergt).
- #44 Aufräumen: Demo-Daten nicht mehr in der App, STAND/ROADMAP auf Stand. #49 (vom Backend-Agent): Absturz
  „l is not a function“ in Chrome 154 – Effekte mit Klammern schreiben, nie `scrollTo` zurückgeben.
- #39–#43 Automatische Lead-Suche (Vertrag, Backend `server/src/autoSearch/*`, Oberfläche) – gemergt.
- #36–#38 Rollen und Konten (Admin, Gründer, Mitarbeiter, Seite „Konten“) – Vertrag, Backend, Oberfläche.
- #34, #35 Tagesstapel mit `clientId` und „für heute überspringen“ im Backend.
- #33 Vorlagen aus `GET /api/templates` (Karten, Einstellungen → Vorlagen, Dashboard-Achse = ID).
- #32 Dashboard aus `GET /api/dashboard` (Beispieldaten entfernt, Wochenquoten auf 100 % gedeckelt).
- #31 Phase-3-Knöpfe: Vernetzen/Nachrichten über `/api/leads/:id/linkedin/*`, sobald `GET /api/linkedin/status` es
  erlaubt (live nur mit `LINKEDIN_ACTIONS=on`); Startseite mit Zählern, Pause, Arbeitszeit und „Jetzt abgleichen“.
- #27 Tagesstapel und Lead-Historie aus der Datenbank · #28 Lead-Panel (Score, Firmendaten holen, Eintragen) ·
  #29 Leads-Ansicht (Board + Tabelle) – alle gemergt.
- #3, #10, #16 `[contract]` Login, Einladungen, Einstellungen · #7, #13, #17 `[frontend]` Anmeldung, „Konto
  einrichten“, Seite „Einstellungen“ (alle gemergt).

## Brauche von der anderen Seite
- Kleinigkeit in `rulesSummary` (`server/src/messages/conversation.ts`): „zuletzt am 04.10.. Ralf hat …“ – doppelter
  Punkt nach dem Datum. Die Oberfläche lässt außerdem das Label vorn in `replySummary` weg, falls es sich wiederholt
  („Kein Interesse – höflich abschließen.“ → „höflich abschließen.“).

## Vertragsänderungen (`shared/`, HTTP-API)
- **22.10. g `claude/festive-tesla-rf5q3l`:** siehe `backend.md` (neu `shared/mcp.ts`, MCP-Server).
- **19.10. `claude/wonderful-pasteur-koa2lt`:** siehe `backend.md` (Kontakt per Link, `origin.kind='contact'`).
- **13.10. `claude/hiring-signal`:** siehe `backend.md` (Hiring-Signal, Zielgruppe `hiring`, `{{stelle}}`).
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
- **Echter Betrieb** (07.10.): `LEAD_SEARCH_MODE`, `MOCK_SPEED` und `AUTH_DEMO_ACCOUNTS` sind aus `SETTING_KEYS`/`SETTINGS`
  entfernt (nur noch Umgebung, für Tests). PUT mit diesen Schlüsseln → 400 `invalid_setting`.
- **Ohne Shell** (`contract/ohne-shell`): Gründer verwalten Konten wie Admins (`invitableRoles`, letztes Konto mit
  Kontenverwaltung nicht entfernbar), neue Einstellungen `LINKEDIN_*`, `UNIPILE_ACCOUNT_*`, `UPDATE_AUTO`/`UPDATE_HOUR`,
  `SettingsTestService` + treg/close/slack, `shared/linkedin.ts` + accounts/test-invite/resume, neu `shared/system.ts`.
- **Automatische Lead-Suche** (`contract/auto-suche`): neue Datei `shared/autoSearch.ts`, Routen `/api/auto-search*`.
- **Rollen und Konten** (Branch `contract/rollen`, Entscheidung des Nutzers 06.10.): `AuthUser.founder` darf `null`
  sein (Admin), neu `AuthUser.role` (`admin`/`founder`/`assistant`) mit Rechte-Helfern (`authRole`, `canEditSettings`,
  `canManageAccounts`, `canSendOnLinkedIn`, `invitableRoles`), Routen `/api/accounts*`, Fehlercodes `not_allowed`,
  `not_found`, `account_exists`, `LeadEvent.actor`. Regeln im Kopf von `shared/auth.ts`. Auf Wunsch des Nutzers baut
  der Frontend-Agent auch das Backend dazu (`backend/rollen`) – bitte nicht parallel daran arbeiten.

## Hinweise
- **E2E:** Jeder Test beginnt mit `resetCockpit(request)` (`tests/helpers.ts`: eigener Request-Kontext, Login nick,
  `POST /api/leads/demo/reset`) – alle Tests teilen sich ein Mock-Backend. Erwartete Reihenfolge laut deinem
  `/api/tasks`: Nick beginnt mit Ralf Ostermann, neue Leads mit Henrik Saalfeld/Nadine Brückner, Johannes mit
  Anja Reimers. Änderst du Seed oder Sortierung, bitte die Namen in `tests/demo.spec.ts` mit anpassen.
- **E2E LinkedIn:** `playwright.config.ts` setzt `LINKEDIN_*_PER_DAY/WEEK=10000`, weil die Simulation über alle Tests
  (und Läufe am selben Tag im gleichen `DATA_DIR`) mitzählt. Limits, Pausen und Arbeitszeit testet
  `tests/linkedin.spec.ts` mit nachgebauten Antworten.
- `?undo=<s>` stellt das Rückgängig-Fenster ein (Standard 5 s), `?ping=off` schaltet den Slack-Ping aus.
- `signIn` wartet jetzt auf `data-testid="home"` (die Startseite gibt es auch ohne offene Aufgaben).
- **E2E mit echter Einladung:** `tests/invite.spec.ts` ruft `npx tsx src/accountsCli.ts invite e2e-<zeit> …` mit
  `DATA_DIR=../test-results/e2e-data` auf (muss zu `playwright.config.ts` passen) – Namen nie `nick`/`johannes`.
