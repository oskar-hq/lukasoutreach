# Lukas-Instanz – Ziel und Umbauplan

Kopie von `oskar-hq/Scraper` (Stand `72be0b0`, 03.11.2026) als **eigene Instanz für Lukas (CEO)**, läuft parallel zur
bisherigen Installation auf eigenem Server unter **https://lukas.ylvalabs.de**. Technik (Stack, Login, Unipile,
Anthropic, Updates, Sicherungen) bleibt gleich – nur Zielgruppe, Signal, Nachrichten und Ablauf ändern sich.
Quelle: Call vom 31.10.2026 („DACH LinkedIn Outreach Plan“).

## Was anders ist als beim Bestand

| | Bestand (Scraper) | Lukas |
| --- | --- | --- |
| Zielgruppe | Kapitalanlage-Vertriebe, Finanzdienstleister | DACH-Startup-Ökosystem: **VCs** und **Startups/Founder** (Leute, die etwas launchen) |
| Woher kommen Leads | Unipile-Suche (Scraping) | **Vorhandene Liste mit ca. 4000 Personen** – nur importieren und anreichern, nicht suchen |
| Signal | Meta-Ads (ja/nein/gestoppt) | **Events:** Finanzierungsrunde, Launch, Investment eines VCs in ein Startup (bestes Signal: Paarung VC ↔ Startup) |
| Vorlagen | Greenfield / Reactivation | **Drei Szenarien:** VC · Startup · Paarung (VC + Startup), je Erstnachricht + Follow-ups. Pitch an VCs anders als an Startups; Pain-Point bei Funding (Investoren, B2B-Interesse) anders als bei Launch |
| Personalisierung | KI-Vorschlag | **Nur Variablen** in festen Texten (z. B. „I just saw you're going to {{event}} …“), keine voll generierten Sätze – klingt sonst nach KI. Günstiges Modell (Haiku/Sonnet), Budget ca. 100 €/Monat |
| Ansprache | 1 Person pro Firma | **Firmen-Kette:** bis zu 3 Personen je Firma, **nacheinander**, nicht am selben Tag |

## Umbau-Schritte (Vorschlag, in dieser Reihenfolge)

1. **Server läuft** unter lukas.ylvalabs.de (dieses Repo, `deploy/install.sh`), Lukas legt sein Gründer-Konto an und
   verbindet seinen LinkedIn-Account über Unipile.
2. **Listen-Import:** Die 4000er-Liste (Excel/CSV) als Leads importieren – mit Firma, Rolle, Typ (VC/Startup) und
   ggf. Event. Ausgangspunkt: der bestehende Tracking-Listen-Upload (`server/src/tracking/`).
3. **Firma als Einheit:** Leads je Firma gruppieren, Anzeige „Firma X · 2 von 3 angeschrieben“, damit nie dieselbe Firma
   mehrfach parallel angeschrieben wird.
4. **Kette statt paralleler Ansprache:** Firmen A, B, C, D … je mit Person 1 am ersten Tag; antwortet Person 1 nach
   ~3 Tagen nicht, folgt Person 2 derselben Firma, dann Person 3. Follow-up bezieht sich auf den Vorgänger
   („Hey, I just wrote {{vorgaenger}} regarding …“).
5. **Events/Signale:** Event je Firma (Typ: Funding / Launch / Investment, Datum, beteiligter VC/Startup) erfassen –
   zuerst von Hand bzw. aus der Liste, später automatisch. Paarungen VC ↔ Startup verknüpfen (≈ 6 Kontakte je Event).
6. **Vorlagen neu:** VC · Startup · Paarung, je Erstnachricht + Follow-ups, Variablen statt Freitext. Texte schreibt
   Lukas, gemeinsame Review-Runde vor dem Start.
7. **Versand:** ca. 20 Vernetzungen pro Tag, über den Tag verteilt (bestehende Grenzen und Arbeitszeiten). Nachrichten
   **Human in the Loop** – jede Nachricht vor dem Senden kurz prüfen (≈ 10 am Tag).
8. Altlasten entfernen, die für Lukas nichts bedeuten: Meta-Ads-Filter, Kapitalanlage-Zielgruppe
   (`server/src/qualify/targetGroup.ts`), Greenfield/Reactivation-Vorlagen, Close-Übergabe (falls nicht gebraucht).
