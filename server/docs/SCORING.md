# Scoring-Konzept (Lead-Potenzial)

Stand: 03.10.2026 · Besitzer: Backend-Agent · **Konzept, noch kein Code.** Grundlage: handschriftliches Konzept des
Nutzers („Algorithmus“), Kundenmeeting vom 03.10.2026, Besprechung mit dem Backend-Agent.

## Entscheidungen des Nutzers (03.10.2026)

| # | Frage | Antwort |
| --- | --- | --- |
| 1 | Wo entsteht das Backend? | Hier in `oskar-hq/lukasoutreach` (`server/`). |
| 2 | Datenbank | **SQLite** (Empfehlung des Backend-Agents, vom Nutzer bestätigt). Läuft seit Phase 1 (`server/src/db/`). |
| 3 | Was zählt als Erfolg (Lernziel)? | **Positive Antwort mit Terminwunsch.** Close (Abschluss) hängt von den Verkäufern ab, nicht vom Programm. |
| 4 | Ideale Firmengröße | Unklar. Nutzer vermutet „eher größere Firmen“ (Referenzen wie Adobe, Lovable). **Mit Johannes klären** – siehe offene Fragen. |
| 5 | Markt | Ganz Deutschland, evtl. auch Ausland. |
| 6 | Änderungen am Konzept (unten) | Freigegeben. |
| 7 | Login (Roadmap Phase 1) | Vertrag aus PR #3 übernommen; Backend gebaut auf `backend/login`. |
| 8 | Clay | Kunde will Clay – fest eingeplant, siehe Abschnitt 7. Felder freigegeben (03.10.): Mitarbeiterzahl, Umsatz, Tech-Stack, Social-Links. Konto/Credits: Nick und Johannes (05.10.). **Quelle: Treg statt Clay (05.10.).** |

## Datenbank: Empfehlung

**SQLite im Docker-Volume** (wie in `docs/ROADMAP.md` empfohlen), mit einer Abfrageschicht, die auch Postgres kann,
damit ein späterer Umzug (Postgres oder Supabase) billig bleibt.

- Daten bleiben auf dem eigenen Server → kein weiterer Auftragsverarbeiter (DSGVO), keine Zusatzkosten,
  Free-Tier-Pausen bei Supabase entfallen.
- Der Login-Vertrag (`shared/auth.ts`, PR #3) setzt auf eigene Cookie-Sitzungen; Supabase Auth würde nicht genutzt.
- Sicherung = Datei kopieren (nächtlich). Für zwei Nutzer und zehntausende Leads reicht SQLite.
- Für Supabase spräche: Tabellenansicht im Browser, Zugriff des Agents per Supabase-Werkzeug. Bei Bedarf später.
- Vorschlag: SQLite schon in Phase 1 (Konten, Sitzungen), statt erst Dateien zu bauen und in Phase 2 umzuziehen.

## Ablauf (Kostenkaskade)

Billige Prüfungen zuerst, teure (KI, Deep Scan) zuletzt. Weitergegeben werden die **besten k nach Kapazität**
(z. B. ~20 Vernetzungen je Gründer und Tag), nicht feste Grenzwerte.

```
Suche (Unipile) → Hard-Filter → ICP-Score → Ad-Evidence (Meta) → Lead-Typ → Deep Scan → Human Review → Kampagne
```

Hinweis: Mit dem LinkedIn-Schutz (max. 25 Profile pro Lauf) ist der Trichter klein; „10.000 Kandidaten“ ist
unrealistisch. Das Lernen (freie Variablen) braucht deshalb viele Läufe und die Datenbank (Phase 2) plus echte
Ergebnisse (ab Phase 3).

## 1 · Hard-Filter (alles muss erfüllt sein)

- Branche: Kapitalanlage-Vertrieb oder Bauträger/Projektentwickler (wie heute in `qualify/`).
  **Offen:** Das Konzept des Nutzers nennt auch „Finanzberatung“ – der heutige Prompt sortiert sie aus.
- Standort: Deutschland (Ausland später als Option; Meta-Abfrage und Vorlagen sind heute auf DE ausgelegt).
- Firma aktiv (Website erreichbar, Impressum, Aktivität in den letzten 12 Monaten).
- Entscheider auffindbar (GF, Inhaber, Gründer, CEO, Vorstand) **mit LinkedIn-Profil-URL**.
- Neu: nicht schon im CRM/Tracking (Dubletten), nicht in den letzten X Monaten kontaktiert, keine Insolvenz.
- Unsichere Branchen-Einstufung fliegt nicht raus, sondern geht ins Review.

## 2 · ICP-Score (0–1, gewichtete Summe, Gewichte summieren auf 1)

Startgewichte aus dem Konzept: Branche 0,35 · Entscheider 0,25 · Größe 0,15 · Region 0,15 · Sonstiges 0,10.

Änderung (freigegeben): Branche und Entscheider sind schon Hard-Filter, daher **abgestuft** statt 0/1, sonst sind
60 % des Scores bei allen gleich.
- Branche: Kerngeschäft eindeutig = 1,0 · Mischform = 0,7 · Randbereich = 0,4.
- Entscheider: Gründer/GF aktiv auf LinkedIn = 1,0 · GF mit inaktivem Profil = 0,7 · nur Head of Sales = 0,5.
- Größe: Skala erst festlegen, wenn die Zielgröße geklärt ist; bis dahin geringes Gewicht.
- Zusatz-Beleg: Eintrag im Vermittlerregister (§34c/f/i GewO) – öffentlich und prüfbar.

## 3 · Freie Variablen / MOS (Market Opportunity Score)

Änderung (freigegeben): **Aussagekraft statt Häufigkeit.** n/N misst nur, wie verbreitet ein Merkmal ist. Gemessen
wird stattdessen, ob Firmen **mit** Merkmal häufiger Erfolg haben als Firmen **ohne** (Lift bzw. Log-Odds).
- Gewicht je Merkmal = geglättetes Log-Odds-Verhältnis, bei wenigen Fällen gedämpft. Negative Gewichte erlaubt.
- Aufnahme: mindestens ~15 Firmen mit Merkmal, davon ≥ 5 Erfolge, Effekt klar von 0 verschieden.
- Entfernen mit Hysterese: erst nach zwei Neuberechnungen ohne Effekt.
- Von der KI vorgeschlagene Merkmale: festes Vokabular, erst im Schattenmodus (zählen nicht), Freigabe durch einen
  Menschen, strengere Schwelle wegen Zufallsfunden.
- Kombination: logistische Funktion aus ICP + Merkmalsgewichten → Wert 0–1, später kalibrierbar (statt ICP + MOS > 1).

Startliste (gemeinsam festlegen): Webinar-Funnel/Landingpage mit Formular · Vertriebsstellen ausgeschrieben ·
GF postet aktiv auf LinkedIn · Instagram/Facebook aktiv · Tracking installiert (Meta-Pixel, GA4, GTM) ·
Terminbuchungs-Tool · Bewertungen (Anzahl/Schnitt) · Zielgruppen-Nische (Ärzte, Akademiker) · Produktfokus
(Denkmal, Neubau, Pflege) · Mitarbeiterwachstum · Agentur im Impressum (eher negativ).

## 4 · Ad-Evidence (Meta)

Änderung (freigegeben): drei getrennte Werte statt eines Scores.
- **Status:** aktiv · historisch · keine gefunden · unbekannt (Seite nicht sicher zugeordnet).
- **Konfidenz:** wie sicher der Status ist (Seite eindeutig zugeordnet, Pixel gefunden, Domain im Anzeigenlink …).
- **Opportunity:** wie sehr die Firma Ads braucht – **je Lead-Typ** berechnet.

Quelle: Meta-Werbebibliothek (`ads_archive`, schon in `ads/metaAds.ts`), inkl. Start-/Enddatum → Ad-Historie,
Laufzeit, Anzahl Varianten. Fehler im Konzept: Advertising-Score-Gewichte 0,5 + 0,3 + 0,25 + 0,05 = 1,10; außerdem
zählt dort der ICP doppelt und Meta-Präsenz wirkt je nach Lead-Typ entgegengesetzt.

## 5 · Lead-Typen

- **A Greenfield:** ICP hoch, Marketing aktiv, keine erkennbare Meta-Werbung.
- **B Reactivation:** ICP hoch, historische Meta-Aktivität oder schwache Ads, heute kaum/keine Aktivität.
- Vorschlag: **C Aktiv/Optimierung** (schaltet gerade schwache Ads) und **Unklar** (Konfidenz niedrig → Deep Scan).
  Hinweis: Laut `docs/STAND.md` wird heute aussortiert, wer gerade Ads schaltet – Typ C nur nach Freigabe.

## 6 · Anzeige und Lernen

- Bis zur Kalibrierung Stufen bzw. „Score“ anzeigen, keine „Wahrscheinlichkeit in %“.
- Kalibrieren ab ~200 Ergebnissen mit ≥ 30–50 Erfolgen (Erfolg = positive Antwort mit Terminwunsch).
- Exploration: 10–15 % des Tagesstapels aus mittleren Scores, damit das System nicht nur sich selbst bestätigt.
- Jeder Score speichert Version und Einzelwerte (für die Erklärung in der Oberfläche).
- Signale/Posts als allgemeine Tabelle (Typ, Quelle, Link, 1–2 Sätze, Relevanz, Datum) – neue Quellen ansteckbar.

## 7 · Clay (Kundenwunsch, fest eingeplant)

Der Kunde will Clay. Clay reichert Firmen und Personen an, bevor teure Schritte (Deep Scan, KI) laufen.
- **Wo im Ablauf:** nach Hard-Filter und ICP-Score, vor dem Deep Scan – so kosten nur aussichtsreiche Leads Credits.
- **Felder (freigegeben 03.10.2026):** Mitarbeiterzahl, Umsatzschätzung, Tech-Stack (u. a. Meta-Pixel, GTM),
  Social-Links. E-Mail/Telefon des Entscheiders bewusst nicht (teuer, rechtlich erst zu prüfen).
- **Technik (vor dem Bau in der Clay-Doku prüfen, nichts erfinden):** Leads per Webhook in eine Clay-Tabelle schicken,
  Clay schickt die Ergebnisse per HTTP-Spalte an eine Backend-Route zurück (mit geheimem Schlüssel). Schlüssel nur in
  der Server-`.env`.
- **Wie alles:** Adapter mit Mock (feste Beispielwerte) und Live; Ergebnisse in der Datenbank (braucht Phase 2).
- **Umgesetzt (Vertrag `shared/enrichment.ts`):** Webhook hin, HTTP-API-Spalte zurück an `/api/enrichment/clay`
  (Header `x-cockpit-secret`); auf Knopfdruck oder automatisch für neue Leads mit Score Hoch/Mittel; Tageslimit.
  Wirkung im Score: Mitarbeiterzahl → Firmengröße · Social-Profile ohne Website → Online-Präsenz 0,6 statt 0,3 ·
  Meta-Pixel ohne gefundene Anzeigen → Opportunity 0,85 statt 0,8 · Mitarbeiterzahl → Hard-Filter „Firma aktiv“.
- **Konto/Credits:** zahlen Nick und Johannes (Entscheidung 05.10.2026).
- **Entscheidung 05.10.2026: Treg statt Clay.** Treg (treg.to) reicht Abrufe an Datenanbieter durch und rechnet je
  Abruf ab; wir nutzen den Katalog-Dienst `treg.companies.enrich` (probiert bis zu 27 Anbieter, ca. 0,2 Cent je Treffer,
  Kostendeckel `TREG_MAX_COST_USD`). Vorteile: kein Abo, Ergebnis sofort (kein Rückkanal), nur die Domain geht hinaus.
  **Erster echter Test 05.10.:** exporo.de und zinsland.de (kleine deutsche Firmen) gefunden – Mitarbeiterspanne,
  Branche, Standort, LinkedIn-Link; Tech-Stack/Umsatz je nach Anbieter nicht dabei, Meta-Pixel bleibt dann unbekannt.
  Frühere Annahme (CompanyEnrich direkt über die rohe Adresse) war falsch – Treg kennt dafür nur Katalog-Namen.
  Abdeckung nach den ersten Wochen prüfen (Anteil `failed` am Lead); Clay bleibt als Alternative im Code.

## Umsetzung v1 (Stand 03.10.2026)

Code: `server/src/scoring/score.ts`, Vertrag: `shared/scoring.ts`. Regelbasiert, jeder Wert mit Begründung.
Berechnet in der Lead-Suche (jeder von der KI bewertete Lead) und beim Speichern in der Datenbank (das Backend rechnet
selbst, vertraut keinem Wert aus dem Browser). Ältere Leads werden beim Start nachgerechnet.

| Teil | Gewicht | Werte v1 |
| --- | --- | --- |
| Branche | 0,35 | Kernzielgruppe = KI-Sicherheit (0,6–1,0) · Makler 0,3 · Asset Manager/Bau für Dritte 0,25 · Hausverwaltung 0,15 · Sonstiges 0,1 |
| Entscheider | 0,25 | GF/Inhaber/Gründer/CEO/Vorstand/Gesellschafter 1,0 · Vertriebsleitung 0,6 · sonst 0,3 |
| Firmengröße | 0,15 | unbekannt → zählt nicht mit (kommt mit Clay); vorläufig 1–2: 0,4 · 3–10: 0,8 · 11–50: 1,0 · 51–200: 0,8 · 201–1000: 0,6 · >1000: 0,4 |
| Region | 0,15 | Deutschland 1,0 · Österreich/Schweiz 0,5 · anderes 0,3 · unbekannt → zählt nicht mit |
| Online-Präsenz | 0,10 | Website 1,0 · keine 0,3 |

- **ICP** = gewichteter Schnitt der bekannten Teile; `completeness` = Summe der bekannten Gewichte.
- **Meta-Evidenz:** aktiv → Konfidenz 0,9, Opportunity 0,2 · beendet → 0,85 / 0,9 (≤ 12 Monate) bzw. 0,8 ·
  keine gefunden → 0,7 (mit Website) bzw. 0,55, je −0,1 bei Fremdtreffern / Opportunity 0,8 · nicht geprüft → 0 / 0,5.
- **Lead-Typ:** beendet → Reactivation · keine gefunden mit Konfidenz ≥ 0,6 → Greenfield · aktiv → Aktiv · sonst Unklar.
- **Gesamt** = 0,7 · ICP + 0,3 · Opportunity · Stufen: ≥ 0,75 hoch, ≥ 0,55 mittel, sonst niedrig.
- Noch nicht in v1: freie Variablen/MOS (brauchen Ergebnisdaten), Marketing-Aktivität (Website-/Social-Analyse,
  Deep Scan), Firmengröße (Clay), Kalibrierung.

## Offene Fragen

- [ ] Finanzberatung als Branche: dazu oder raus?
- [ ] Zielgröße: Adobe/Lovable sind keine Kapitalanlage-Vertriebe/Bauträger – sind das Referenzen der Agentur
      (nicht die Zielgruppe)? Mit Johannes klären, welche Größe die Leads haben sollen.
- [ ] Ausland: welche Länder, und sollen Vorlagen dann mehrsprachig sein?
- [ ] Treg: Abdeckung nach den ersten echten Leads prüfen (wie oft „Keine Firmendaten gefunden“).
- [ ] Rechtliches vor dem Schritt „Mail“: LinkedIn-Nutzungsbedingungen, DSGVO Art. 14, UWG §7.
