# DESIGN.md – Schwarz & Weiß

Design-System aus dem *Outreach Cockpit*. Ziel: Neue Projekte sehen und fühlen sich sofort gleich an –
ruhig, schwarz-weiß, im Stil von Apple, mit einer Aufgabe pro Bildschirm.

> **Für Claude / Entwickler:** Diese Datei ist verbindlich. Werte (Farben, Größen, Kurven, Dauern) exakt
> übernehmen, nicht „ähnlich“ nachbauen. Abweichungen nur mit Begründung.

> **Redesign v2 (Wunsch des Nutzers 09.10.) – gilt vor älteren Angaben unten.** Vorbild: Entwurf „Server und Anmeldung
> v2“ (Claude Design) und Trade Republic. Für die ganze Software:
> - **Farben:** Grund `#0b0b0c` (`canvas`), Flächen `#111113`/`#151517`/`#1a1a1c`/`#242427` (`surface-1…4`), Text
>   `#f2f2f3`, Grau `#8a8a8f` (`ink-2`) und `#66666c` (`ink-3`), Warnung `#ff9f43`, Erfolg `#30d158`.
> - **Kopfleiste:** 72 px, Glas; links das Logo (weiße Kachel, Sprechblase, grüner Punkt = Favicon), rechts die
>   Navigation in 14 px fett (`ink-2` → `ink` aktiv, keine Pille), Glocke, Avatar als blauer Kreis `#2f6bff`.
> - **Keine Rahmen und Trennlinien.** Felder, Chips und Knöpfe sind Flächen (`surface-3`), Fokus = blauer Rand.
>   Karten/Paneele `surface-1/2` ohne Rahmen. Listen ohne Linien, Hover = Fläche.
> - **Formen:** Felder 38 px, Radius 10; Knöpfe Radius 8–14 (je Größe), fett; Segment-Schalter auf `surface-3`, die
>   Auswahl als dunkle Fläche (`surface-4`), nicht weiß. Primär-Knopf bleibt weiß.
> - **Typo:** Seitentitel 30 px fett, eng (−0,025 em); Abschnittsüberschriften 15 px fett; Beschriftungen 13 px
>   `ink-2`, Werte fett; Eyebrows ohne Großbuchstaben (12 px, halbfett). Kaum Erklärtext.


> **Mobil = native iOS-App (Wunsch des Nutzers 11.10.) – gilt für jedes Feature.** Das Cockpit wird auf dem iPhone
> über „Zum Home-Bildschirm“ als Web-App benutzt und soll sich wie eine normale App anfühlen. Jede neue oder geänderte
> Ansicht wird deshalb **immer für beide Formen gebaut und geprüft**: Desktop (1440 × 900) und Handy (390 × 844).
> - **Navigation:** Handy (< 640 px) = Tab-Leiste unten (Symbol 23 px über Name 10,5 px, aktiv `ink`, sonst `ink-3`,
>   Zähler als kleine blaue Pille am Symbol), schmale Kopfleiste oben (52 px: Logo · Titel · Glocke + Konto). Der
>   Titel blendet erst ein, wenn die große Überschrift weggescrollt ist. Erneutes Tippen auf den aktiven Tab scrollt
>   nach oben; ein Tab-Wechsel beginnt oben. Ab 640 px die Navigation oben (`TopNav.tsx` rendert genau eine davon).
>   Höchstens 5 Tabs – Neues kommt in eine bestehende Ansicht oder ins Konto-Menü, nicht als 6. Tab.
> - **Safe Areas:** Die Seite läuft mit `viewport-fit=cover` unter Notch und Home-Indikator. Nie feste Pixel für
>   Bildschirmhöhen oder Leisten-Abstände – immer die Variablen aus `src/index.css`: `--safe-top/-bottom/-left/-right`,
>   `--nav-top`, `--nav-bottom` (Tab-Leiste, auf Desktop 0), `--app-h` (Höhe einer Cockpit-Ansicht),
>   `--sheet-max-h`. Sticky oben: `top-[var(--safe-top)]`; fest/sticky unten im Cockpit: `bottom-[var(--nav-bottom)]`;
>   Vollbild ohne Tab-Leiste (Fokus, Panels): unten `var(--safe-bottom)` dazurechnen.
> - **Touch:** Tippziele mindestens 44 × 44 px; Felder auf Touch-Geräten mindestens 16 px Schrift (sonst zoomt iOS –
>   regelt `index.css` global, nicht wieder überschreiben). Haupt-Aktionen in Daumenreichweite unten. Hover ist auf
>   dem Handy nie die einzige Möglichkeit (Tooltips, Aktionen nur bei Hover). Dialoge als Bottom-Sheet (`Modal`).
> - **Platz:** eine Spalte, keine horizontale Scrollleiste der Seite (Board/Tabellen scrollen in sich). Tabellen
>   werden zu Listen, Seitenleisten zu „Liste → Detail mit Zurück“ (wie Chats und Einstellungen).
> - **Prüfen:** Screenshot bei 390 × 844 für jede geänderte Ansicht; E2E-Tests für Handy-Ansichten mit
>   `page.setViewportSize({ width: 390, height: 844 })` (dort gibt es `tab-bar` statt der Navigation oben).

> **Einstellungen = Untermenüs wie in einer App (Wunsch des Nutzers 11.10., Vorbild Trade Republic).** Erst die grobe
> Richtung, dann genauer: Einstellungen → Kategorie (Verbindungen, Outreach, System) → Bereich → Unterseite.
> - **Jede Ebene ist eine kurze Liste** (`settings/MenuRow.tsx`): Name fett 16 px, darunter grau in ein paar Wörtern
>   der aktuelle Wert oder was dort steckt, rechts ›. Keine Eingaben in Listen, keine Erklärtexte, keine Linien.
>   Erste Ebene mit Symbol im weißen Kreis. Abweichungen („geändert“, „Prüfen“, „Fehlt“) als Punkt + Wort rechts.
> - **Erst die letzte Ebene hat Eingaben – höchstens vier Werte pro Seite**, was zusammengehört (Zugang = Adresse +
>   Token). Ein Wert allein: Seite trägt seinen Namen als Titel, der Hilfetext steht grau darunter, die Eingabe in
>   voller Breite.
> - **Zurück** oben links („‹ Name der Ebene darüber“) oder Esc. Die Suche auf der ersten Ebene findet auch einzelne
>   Werte und springt direkt auf deren Unterseite.
> - **Neue Einstellung:** in `shared/settings.ts` anlegen und in `settingsNav.ts` → `PAGE_PLAN` einer Unterseite
>   zuordnen (sonst landet sie auf „Weitere“). Neuer Bereich: in `SETTINGS_NAV` einer Kategorie zuordnen.

> **UX-Leitfaden (Wunsch des Nutzers 25.10.) – gilt für jede neue oder geänderte Ansicht.** Fünf Prinzipien, mit den
> Mitteln dieses Design-Systems umgesetzt:
> - **Weniger Auswahl auf einmal (wichtigstes Prinzip):** höchstens eine Schalterreihe pro Kopfzeile. Seltenes
>   (Zielgruppe, Account, Kategorie, Lauf-Einstellungen) liegt in einem Menü oder hinter „Anpassen ⌄“, sichtbar ist nur
>   die Abweichung vom Standard (z. B. „Board · Bauträger“). Dialoge vor einer Aktion: ein Satz, was passiert, plus der
>   Knopf – keine Einstellungen zuerst. Höchstens fünf Hauptansichten (die KI steht als „KI fragen“ im Dashboard).
> - **Zeigen, dass gearbeitet wird:** Wo wirklich etwas im Hintergrund läuft (Lead-Suche, KI-Vorschlag, Firmendaten),
>   steht in Worten, was gerade passiert – mit echten Zahlen und Namen („Liest Profil 9 von 15 · Name · Firma“).
>   Nichts erfinden. Künstlich warten nur bei KI-Texten (mindestens 1,2 s), nie bei Senden, Eintragen, Wischen.
> - **Fortschritt sichtbar:** „x von y erledigt“ immer mit Balken (4 px, `bg-ink` auf `surface-4`, per `scaleX`),
>   Restzeit erst, wenn sie sich aus echten Daten schätzen lässt. Serie („Tage in Folge“) auf Start- und Erfolgsseite.
> - **Höhepunkt und Ende:** Termin und Übergabe bekommen einen kurzen Erfolgsmoment (grüner Haken, ein Satz, 1,6 s,
>   blockiert nichts). Wer mittendrin beendet, bekommt eine Zwischenbilanz als Hinweis. Rote Punkte nur bei echten
>   Problemen – Hinweise haben einen Ton (`good`, `neutral`, `bad`).
> - **Das Wichtige hebt sich ab:** Akzentblau nur für das, was auf *dich* wartet (Chats „Wartet auf dich“, „heute ·
>   Follow-up“ im Board) – nie für alles in einer Liste.

---

## 1. Grundprinzipien

1. **Schwarz & Weiß, eine Akzentfarbe.** Fast alles ist Schwarz, Weiß und Grau. Blau (`#2997ff`) nur sparsam
   für Hervorhebungen – nie flächig.
2. **Eine Sache pro Bildschirm.** Startseite = eine Zahl + ein Button. Aufgaben = eine ganze Seite pro Aufgabe
   mit genau zwei Entscheidungen unten. Details sind einen Klick entfernt (progressive Offenlegung).
   Jede Seite: Titel, höchstens ein Satz, Inhalt. Was die Oberfläche schon zeigt, wird nicht noch einmal erklärt.
   Selten Gebrauchtes (Zähler, Zeitpläne, Aufschlüsselungen, Optionen, Rohdaten) liegt einen Klick entfernt – nicht
   gelöscht, nicht ausgeschrieben. Warnungen, Fehler und Schutzhinweise sind nie eingeklappt. Markiert wird nur, was
   abweicht – nie der Normalzustand. Ausgänge, die der Rahmen schon bietet („Beenden“, Navigation, Avatar-Menü),
   bekommen keinen zweiten Button.
3. **Typografie statt Kästen.** Hierarchie über Größe, Gewicht und Grauton – nicht über Rahmen und Boxen.
   Rahmen nur, wo etwas wirklich eine Fläche ist (Karte, Eingabefeld, Dialog).
4. **Bewegung erklärt, sie dekoriert nicht.** Sie zeigt, woher etwas kommt und wohin es geht. Häufige Aktionen
   bekommen kaum oder keine Animation, seltene Momente (Login, „Alles erledigt“) dürfen glänzen.
5. **Tastatur zuerst.** Enter = Haupt-Aktion, ← = ablehnen, Esc = zurück, Z = rückgängig. Kürzel stehen sichtbar
   auf den Buttons.
6. **Verzeihen statt fragen.** Rückgängig nach jeder Entscheidung. Bestätigungsdialoge nur für wirklich
   Zerstörerisches (z. B. ein Konto entfernen).
7. **Sofortige Rückmeldung.** Jeder Klick reagiert beim Drücken (100 ms). Hintergrundprozesse zeigen Status
   („wird gesendet…“ → „Gesendet ✓“).

---

## 2. Technik

| Bereich | Wahl |
| --- | --- |
| Framework | React + Vite + TypeScript |
| Styling | Tailwind CSS v4 mit Tokens in `@theme` (siehe §11) |
| Animation | `motion` (`import { motion } from 'motion/react'`), App in `<MotionConfig reducedMotion="user">` |
| Icons | `lucide-react`, Größe 14–16 px (`h-3.5 w-3.5` / `h-4 w-4`), Stroke Standard |
| Diagramme | Recharts |
| Schrift-Fallback | `@fontsource-variable/inter` (für Windows/Linux; auf dem Mac greift SF Pro) |
| Auslieferung | Docker, Multi-Stage (Node-Build → nginx), SPA-Fallback |

---

## 3. Farben

Dunkles Theme, `color-scheme: dark`. Hintergrund ist **reines Schwarz**.

| Token | Wert | Verwendung |
| --- | --- | --- |
| `canvas` | `#000000` | Seitenhintergrund |
| `surface-1` | `#0c0c0d` | Karten, Panels |
| `surface-2` | `#141415` | Eingabefelder, Dialoge |
| `surface-3` | `#1c1c1e` | Menüs, Popover, Tooltips |
| `surface-4` | `#262628` | eigene Chat-Blasen, deaktivierte Flächen |
| `line` | `rgb(255 255 255 / 0.08)` | Haarlinien, Kartenrahmen |
| `line-strong` | `rgb(255 255 255 / 0.14)` | betonte Rahmen, Outline-Buttons |
| `ink` | `#f5f5f7` | Haupttext, Primär-Button-Fläche |
| `ink-2` | `#a1a1a6` | Sekundärtext |
| `ink-3` | `#6e6e73` | Labels, Zeitstempel, Hinweise |
| `ink-4` | `#48484a` | deaktiviert |
| `accent` | `#2997ff` | siehe Regeln unten |
| `accent-soft` | `rgb(41 151 255 / 0.14)` | hinterlegte Hervorhebung |
| `good` | `#30d158` | Status „passt / erledigt“ |
| `warn` | `#ff9f0a` | Status „Achtung / vermutlich unpassend“ |
| `bad` | `#ff453a` | Status „negativ“ |

**Regeln**

- **Akzentblau nur für:** Variablen im Text, Textauswahl, Fokusring, „Neu“-Marker, die zweite Datenreihe in
  Diagrammen, den besten Wert eines Diagramms. Nie für Buttons oder Flächen.
- **Primär-Button ist weiß** (`ink`) mit schwarzer Schrift – das ist die „Akzentfarbe“ der Bedienung.
- **Statusfarben nie allein:** immer als kleiner Punkt (6 px) oder Icon neben neutralem Text. Text bleibt `ink`.
- Weiße Flächen-Transparenzen als Abstufung: `white/[0.03]` (Fläche), `white/[0.06]` (Hover), `white/[0.08–0.12]`
  (sekundäre Buttons).

---

## 4. Typografie

Schrift: Systemschrift (SF Pro auf Apple-Geräten), Fallback Inter.

```
--font-sans:    -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter Variable', 'Segoe UI', system-ui, sans-serif;
--font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter Variable', 'Segoe UI', system-ui, sans-serif;
```

Body: 15 px, Zeilenhöhe 1.5, `antialiased`.

| Rolle | Größe | Gewicht | Tracking / Zeilenhöhe | Farbe |
| --- | --- | --- | --- | --- |
| Hero-Zahl (Startseite) | 96 px / sm: 120 px | 600 | −0.04em, leading-none | ink |
| Login-Headline | 44 px / sm: 64 px | 600 | `.display` | ink |
| Seitentitel (H1) | 34 px / sm: 40–44 px | 600 | `.display` (−0.025em, 1.08) | ink |
| Name / Fokus-Titel | 28–30 px / sm: 30–36 px | 600 | `.display` | ink |
| Abschnittstitel | 15 px | 600 | −0.01em | ink |
| Fließtext groß | 16–17 px | 400 | 1.6 | ink-2 |
| Fließtext | 14.5–15 px | 400 | 1.5–1.6 | ink / ink-2 |
| Sekundär | 13–14 px | 400–500 | – | ink-2 |
| Hinweis / Meta | 12–12.5 px | 400 | – | ink-3 |
| Eyebrow (Label über Inhalt) | 11.5–12 px | 500, UPPERCASE | +0.08–0.1em | ink-3 |

**Regeln**

- Große Schrift → negatives Tracking (`.display`), kleine Großbuchstaben → positives Tracking.
- Hierarchie über Gewicht + Größe + Grauton zusammen, nicht nur über Größe.
- `tabular-nums` nur für Zahlen, die sich ändern oder untereinander stehen (Zähler, Tabellen, Achsen).
- Deutsche Zahlenformate: `1.234`, `23,4 %`, `+1,6 Pp.`; Zeiten „Heute, 09:14“, „vor 3 Std.“.
- Prozent ohne Nachkommastelle, wo Fallzahlen klein sind (Dashboard: „23 %“, „+2 Pp.“); eine Nachkommastelle nur im Tooltip.

```css
.display {
  font-family: var(--font-display);
  letter-spacing: -0.025em;
  line-height: 1.08;
}
```

---

## 5. Raster, Abstände, Radien, Tiefe

| Was | Wert |
| --- | --- |
| Seitenrand | `px-4 sm:px-6` (Fokus-Seiten `px-5`) |
| Max. Breite App/Navigation/Dashboard | 1240 px |
| Fokus-Spalte (eine Aufgabe) | 600 px, zentriert |
| Lesespalte für Fließtext | 460–540 px |
| Abstände | 4er-Raster; Abschnitte 24–40 px (`mt-6`…`mt-10`) |
| Navigation | Höhe 56 px (`h-14`), Fokus-Kopfleiste 64 px (`h-16`) |
| Radius Buttons, Pills, Tabs | `rounded-full` |
| Radius Karten | 24–28 px |
| Radius Felder / innere Flächen | 16–22 px (`rounded-2xl`, Editor 22 px) |
| Radius Tastenkürzel | 6 px |
| Rahmen | immer 1 px, `line` oder `line-strong` |
| Schatten (nur schwebende Elemente) | `0 24px 60px -12px rgb(0 0 0 / 0.85)` |
| Schatten Dialog | `0 40px 120px -20px rgb(0 0 0 / 0.9)` |

**Material („Glas“)** – nur für feststehende Leisten (Navigation), nie für bewegte Elemente:

```css
.glass {
  background: rgb(12 12 13 / 0.72);
  backdrop-filter: blur(24px) saturate(160%);
}
```

Trennlinie unter der Navigation erst zeigen, wenn Inhalt darunter scrollt (`useScrolled`).

---

## 6. Komponenten

Alle Bausteine liegen in `src/components/ui/` und können 1:1 kopiert werden.

### Button

Basis: `inline-flex items-center justify-center rounded-full font-medium tracking-[-0.01em]
transition-[background-color,color,transform,border-color,opacity] duration-100 ease-out active:scale-[0.97]
disabled:opacity-40`

| Variante | Klassen | Einsatz |
| --- | --- | --- |
| `primary` | `bg-ink text-black hover:bg-white` + `shadow-[0_1px_0_rgb(255_255_255/0.4)_inset]` | genau eine Haupt-Aktion pro Bildschirm |
| `outline` | `bg-canvas border border-line-strong text-ink hover:bg-surface-2` | Gegenentscheidung („Nicht senden“) |
| `secondary` | `bg-white/[0.08] hover:bg-white/[0.12]` | Nebenaktionen |
| `ghost` | `text-ink-2 hover:text-ink hover:bg-white/[0.06]` | Navigation, „Beenden“, „Bearbeiten“ |

| Größe | Höhe | Text |
| --- | --- | --- |
| `sm` | 32 px | 13 px |
| `md` | 40 px | 14 px |
| `lg` | 48 px | 15 px |
| `xl` | 56 px | 16 px – Entscheidungsleiste |
| Hero-CTA | 64 px | 17 px – Startseite |

Tastenkürzel als `Kbd` im Button: Haupt-Aktion `↵` am Ende, Ablehnen `←` am Anfang.

### Kbd (Tastenkürzel-Hinweis)

`h-5 min-w-5 rounded-[6px] px-1.5 text-[11px] font-medium`, auf dunklem Grund `border border-white/10
bg-white/[0.06] text-ink-2`, im weißen Button `bg-black/[0.08] text-black/55`. **Unter `md` ausgeblendet**
(Touch-Geräte haben keine Tastatur).

### Pill (Label / Status)

`rounded-full border border-line bg-white/[0.04] h-7 px-2.5 text-[13px] font-medium text-ink`, links ein 6-px-Punkt
in Statusfarbe **oder** ein Icon (14 px, `ink-2`). Nur Abweichungen markieren („Angepasst“, „Geändert“,
„Eingeladen“) – nie den Normalzustand („Standard“, „Live“, „ok“).

### Segmented Control (Tabs, Varianten)

Container `rounded-full border border-line bg-white/[0.03] p-1`, Optionen `h-8 px-3.5 text-[13px]`. Aktive
Option: weiße Pille (`bg-ink`, Text schwarz), die per `layoutId` gleitet –
Feder `{ type: 'spring', bounce: 0, duration: 0.35 }`. Zähler als kleine Kapsel, Kürzel (1, 2, …) in `ink-3`.

### Karte / Fläche

`rounded-[24px] border border-line bg-surface-1 p-5 sm:p-6`. Keine Karten in Karten. Innere Gruppen nur über
Abstand und Eyebrow-Label trennen.

### Eingabefeld / Editor

`rounded-[22px] bg-white/[0.04]`, beim Fokus `border-white/25 bg-white/[0.05]`, Text 16 px / 1.6,
Innenabstand 18 × 22 px. Platzhalter (`{{vorname}}` usw.) werden im Text farbig hinterlegt:
transparente Textarea über einem Backdrop mit identischer Typografie (siehe `MessageEditor.tsx`,
Klasse `.variable-mark`). Unter dem Feld eine Zeile Textknöpfe (Button `ghost` `sm`): „Bearbeiten E“, „Vorschlag K“,
live „Kopieren“. Die Zeichenzahl erscheint erst ab 90 % des Limits („9.512 / 10.000“).

### Dialog (Modal)

Abdunkelung `bg-black/60 backdrop-blur-[6px]`, Fläche `rounded-[28px] border-line-strong bg-surface-2`,
max. 672 px (`max-w-2xl`). Wächst aus der Richtung, aus der er ausgelöst wurde
(`transformOrigin: '50% 100%'` bei Auslösung aus der unteren Leiste). Esc schließt, Enter bestätigt.
Auf Mobil (< 640 px) ein **Bottom-Sheet**: kommt von unten (`y: '100%'`), geht nach unten, Griff oben (36 × 4 px,
`white/25`). Am Griff folgt es dem Finger 1:1 nach unten, nach oben nur zäher Widerstand (Gummiband); beim
Loslassen entscheidet die hochgerechnete Endposition (`shouldDismiss` in `src/lib/gesture.ts`), die Ausblend-Feder
übernimmt die Fingergeschwindigkeit, sonst `SPRING_BACK` zurück.
Die Headline sagt die Aufgabe („Ralf Ostermann an Close übergeben“), keine Eyebrow darüber, genau eine Hinweiszeile.
Vorschauen (z. B. die Close-Felder) liegen hinter „Angaben ansehen“.

### Seitenpanel (Details / Historie)

Rechts, max. 500 px, `rounded-[24px]` mit 8 px Abstand zum Rand, massiv `bg-surface-1` (bewegt sich, also kein
Glas). Kommt von rechts und geht nach rechts (`x: '105%'`, Feder 0.45 s). Leichte Abdunkelung `bg-black/45`. Esc
schließt. Mit dem Finger (nicht mit der Maus – die markiert Text) nach rechts wegwischen, gleiche Regeln wie beim
Bottom-Sheet; nach links Gummiband.

Inhalt von oben nach unten, ohne Kästen und ohne Deko-Icons: fester Kopf mit Name und Position · Firma neben ✕ –
keine Überzeile, kein Avatar. Eine Meta-Zeile: Stufe mit Punkt · Signal · LinkedIn ↗ · Close. Score-Zeile (Zahl,
Stufe, verletzte Hard-Filter) mit „Details ⌄“ rechts – dahinter liegt alles Seltene (Branche, Region, Meta-Ads,
Score-Aufschlüsselung, Firmendaten). Dann Gespräch, ✦ KI-Einschätzung (Urteil fett, dann Zusammenfassung), Eintragen
(nächster Schritt, nur die Aktionen, die in dieser Stufe gehen, Zeile „Zuständig: X · An Y übergeben“) und zuletzt
der Verlauf. Jede Angabe steht nur einmal. Aktionen, die im aktuellen Zustand nicht gehen, werden ausgeblendet; nur
kurz gesperrte (Speichern läuft) werden ausgegraut.

### Statusmeldung (Hintergrund-Aktion)

Immer **nur eine** Meldung gleichzeitig, Pille `h-11 rounded-full border-line-strong`. Sie folgt dem echten
Stand der Entscheidung (Ausgangskorb, `src/state/outbox.ts`) – gesendet bzw. gespeichert wird erst nach dem
Rückgängig-Fenster (5 s), denn der Server kennt kein „Rückgängig“:

1. **Noch rückgängig machbar:** grauer Punkt + Text in der Verlaufsform („Vernetzungsanfrage wird gesendet“),
   „Rückgängig Z“, darunter eine 2-px-Leiste, die abläuft (`scaleX`, bei reduzierter Bewegung ausgeblendet).
   Maus über der Meldung, Fokus auf „Rückgängig“ oder offenes Seitenpanel halten die Zeit an.
2. **Wird gespeichert:** Spinner, gleicher Text, kein Rückgängig mehr.
3. **Gespeichert:** grüner Haken + „Gesendet“ für 1,2 s.
4. **Für heute übersprungen:** nur im Browser – sofort Haken-los mit „Rückgängig“.
5. Z ohne Rückgängig-Möglichkeit: „Schon gespeichert – Rückgängig geht nicht mehr“.

Auf dem Handy Kurztexte („Wird gesendet“) und „Rückgängig“ nur als Symbol. Im Fokus-Modus erscheint die Meldung
mittig in der Kopfleiste (anstelle des Fortschritts, auf dem Handy direkt darunter), sonst unten mittig.
Offline wartende Entscheidungen stehen statt des Fortschritts: Punkt `warn` + „Offline – 2 Entscheidungen warten
aufs Speichern · Erneut versuchen“. Abgelehnte Entscheidungen: eigene Meldung (`role="alert"`, 8 s, Punkt `bad`,
„Nicht gespeichert · Name“ + Grund, „Ansehen“), die Aufgabe kommt direkt hinter die aktuelle zurück.

### Benachrichtigung (externes Ereignis, z. B. Slack)

Oben rechts, max. 380 px, `rounded-[18px]`, App-Icon links, Titel fett, Vorschau 2 Zeilen, Aktion als
Textlink in Akzentblau. Federt von rechts herein (`bounce 0.22`), verschwindet nach 15 s (pausiert bei Hover).
Derzeit nicht im Einsatz (der simulierte Slack-Ping ist entfernt) – Muster für echte Ereignisse.

### Avatar

Initialen auf Graustufen-Verlauf (`from-[#3a3a3c] to-[#1c1c1e]`, 5 Varianten per Namens-Hash), innerer
Lichtrand `inset 0 1px 0 rgb(255 255 255 / 0.12)`. Keine Fotos in Demos. Nur dort, wo er Seiten unterscheidet:
neben Chat-Blasen und als Konto-Knopf in der Navigation. Nicht in Fokus-Köpfen, im Panel-Kopf, in Listen oder
Tabellen – der Name steht ohnehin daneben.

### Keine Simulations- oder Demo-Hinweise

Die Oberfläche zeigt nirgends „Simulation“ oder „Demo“: keine Modus-Pille, kein Hinweis am Bildschirmrand, kein
„Demo zurücksetzen“. Die Simulation gibt es nur noch für Tests (E2E gegen das Mock-Backend).

### Senden oder eintragen

Solange das Cockpit nicht selbst auf LinkedIn sendet, sagen die Knöpfe, was passiert: „Anfrage eintragen“,
„Als gesendet eintragen“, „Als übergeben eintragen“ (auf dem Handy „Eintragen“), Tastenhinweis „⌘ ↵ eintragen“.
Auf der Startseite ist das die eine ruhige Zeile unter dem Hero-Button: „Das Cockpit sendet noch nichts – vernetzen
und schreiben auf LinkedIn, dann hier eintragen.“ Ein Klick darauf zeigt die heute eingetragenen Anfragen.
Nachrichtenfelder haben dann „Kopieren“; den Link „LinkedIn-Profil öffnen ↗“ tragen die Karten, bei denen du selbst
auf LinkedIn handelst (Neuer Lead immer, Erstnachricht/Follow-up nur im Eintragen-Modus, Antwort neben „Kopieren“
des Vorschlags). Sendet das Cockpit selbst, heißen die Knöpfe „Vernetzen“, „Senden“, „An Close übergeben“.

### Seitenkopf

`PageHeader` (`src/components/ui/PageHeader.tsx`): H1 34/40 px `.display`, daneben optional eine Zahl in `ink-3`
(„Leads 15“), rechts in derselben Zeile die Haupt-Aktion. Darunter höchstens ein Satz – meist keiner. Keine Eyebrow
über dem Titel, wenn Navigation oder Reiter den Ort schon nennen. Zeitraum oder Stand stehen an dem Block, den sie
beschreiben (`SectionLabel`), nicht über dem Titel.

### Aufklappen (Disclosure)

Ein Klick zeigt Seltenes: leiser Textknopf mit `ChevronDown`, der sich beim Öffnen um 180° dreht, `aria-expanded` +
`aria-controls`, immer `type="button"`. Das Label bleibt in beiden Zuständen gleich („Details“, „Verlauf (3)“,
„Anpassen“, „Angaben ansehen“, „Gut zu wissen“). Zwei Formen: `inline` (erbt Schrift und Farbe, z. B. ein Satz, der
aufklappt) und `chip` (`h-7 rounded-full px-2 text-[12.5px] text-ink-2`). Listen von Bereichen als `DisclosureRow`
(Zeile ≥ 56 px, Haarlinien, Name links, Stand rechts, Chevron). Bereiche mit Fehlern öffnen sich selbst, bevor der
Fokus hinspringt – imperativ, nie aus dem Fehlerzustand abgeleitet. Bausteine: `src/components/ui/Disclosure.tsx`,
`DisclosureRow.tsx`.

### Statuszeile

Ausnahmen und Warnungen als eine Zeile: 6-px-Punkt (`warn`/`bad`, selten `accent`) + ein Satz in `ink`,
`role="status"` bzw. `role="alert"` (`StatusLine` in `src/components/ui/Status.tsx`). Der Normalzustand bekommt keine
Beschriftung und keinen Punkt. Ein Punkt steht nie allein, immer mit Text. Keine Kästen um Hinweise – Ausnahme ist
die Probe-Änderung mit Restzeit und Entscheidung.

---

## 7. Layout-Muster

### Navigation

Glas-Leiste, 56 px, max. 1240 px. Links das Logo-Zeichen (ab `sm`, ohne Namen), dann die vier Ansichten
„Aufgaben · Lead-Suche · Leads · Dashboard“ – ab `md` nur Text, darunter nur Icons (Text als `sr-only`). Zähler nur an
„Aufgaben“, Punkt an „Lead-Suche“ (Akzent pulsierend: Suche läuft · `warn`: nicht startklar). Rechts die Glocke
„Neuigkeiten“ und der Avatar ohne Namen. Die Glocke hat nur einen Punkt, wenn etwas Neues da ist (Farbe nach dem
Wichtigsten: `bad` Fehler · `warn` Warnung · Akzent Hinweis); ihr Popover (wie das Avatar-Menü, 380 px, auf dem Handy
volle Breite mit 16 px Rand) listet Meldungen mit Punkt, Titel, einem Satz und „Neu · vor 2 Std.“. Beim Öffnen gilt
alles als gesehen. Keine Chats in der Glocke. Avatar-Menü: Name, „Angemeldet als …“, bei Admin/Mitarbeiter eine Zeile zur Rolle, „Aufgaben von“
(Admin), Einstellungen, Konten (je nach Recht), Abmelden; Esc schließt und gibt den Fokus an den Avatar zurück.
Einstellungen und Konten stehen nicht in der Leiste – solange man dort ist, ist der Avatar hinterlegt. Außer Glocke und
Avatar keine weiteren Knöpfe in der Leiste.

### Willkommen / Login

Zentriert: Headline (44/64 px) → Inhalt. Ein Satz unter der Headline nur, wenn es einen Grund gibt (Sitzung
abgelaufen, Server nicht erreichbar, bestehendes Konto). Kein Slogan, kein Fußzeilen-Hinweis, kein Schloss. Unten ein
**Horizont**: riesige schwarze Ellipse (`2200 × 1400 px`, `rounded-[50%]`, `border-t border-white/25`, Leuchten
`shadow-[0_-40px_160px_-20px_rgb(255_255_255/0.22)]`) bei 78 % der Höhe, plus weicher Lichthof als radialer Verlauf.

- **Echte Anmeldung:** Formular max. 400 px breit. Beschriftung über dem Feld (13 px, `ink-2`), Felder `h-12
  rounded-2xl border-line bg-white/[0.04]`, Text **16 px** (sonst zoomt iOS beim Fokus). Passwort mit Auge-Knopf
  zum Anzeigen, Hinweis bei Feststelltaste (Punkt in `warn`). Checkbox „Angemeldet bleiben“ (vorausgewählt). Ein
  weißer Button „Anmelden ↵“ über die volle Breite (`xl`). Fehler als ein Satz in `ink` mit Punkt in `bad` direkt
  über dem Button (`role="alert"`, jede Meldung ein neuer Knoten), `aria-invalid` nur am betroffenen Feld, danach
  Passwortfeld leeren und fokussieren. Enter im Namensfeld springt ins Passwortfeld. Gibt es einen Grund („Deine
  Sitzung ist abgelaufen …“), steht er als ein Satz unter der Headline und ist mit dem Passwortfeld verknüpft – sonst
  steht dort nichts.
- **Ohne Login im Backend:** zwei Auswahlkarten nebeneinander (Avatar, Name, „N Aufgaben für heute“), kein Satz
  darüber, kein Simulations-Hinweis.
- **Konto einrichten (Einladungslink `/einladung#…`):** gleicher Aufbau, Headline „Willkommen, Name.“ (bestehendes
  Konto: „Hallo Name.“). Anmeldename als nur lesbares Feld (damit Passwort-Manager ihn speichern), Passwort mit
  Hinweis „Mindestens 10 Zeichen.“, „Passwort wiederholen“, „Angemeldet bleiben“, „Konto einrichten ↵“. Kein Satz
  unter „Willkommen, Name.“ (bestehendes Konto: „Leg ein neues Passwort fest – überall sonst wirst du dabei
  abgemeldet.“). Unten eine Meta-Zeile „Kontoart · Link gültig bis …“ (z. B. „Mitarbeiter für Nick · Link gültig bis
  14.10., 18:00 Uhr“). Ungültiger Link: Headline „Dieser Link gilt nicht mehr.“, ein Satz,
  ein Button „Zur Anmeldung“.

### Einstellungen

**Look v2 (Wunsch des Nutzers 09.10., gilt vor den Details unten):** aufgeräumt nach „Server und Anmeldung v2“ –
Seitenleiste 200 px mit Suchfeld (Fläche `surface-3`, ohne Rahmen), Gruppen 11 px; rechts max. 600 px, nur der Titel
(30 px, fett) und rechts daneben kurz „Gespeichert“ in `good`. Keine Gruppe über dem Titel, kein Einleitungssatz, keine
Kästen und Trennlinien. Jede Zeile: Beschriftung links (13 px `ink-2`), Steuerung rechts; Hilfetexte nur für
Screenreader, sichtbar höchstens ein paar Wörter in 11 px. Eingaben 38 px, `surface-3`, Radius 10, Fokus blau; ganze
Zahlen als Stepper „− 1 +“, Schalter grün. Abschnitte mit 15-px-Überschrift („Nur in .env änderbar“, „Zeitplan“).
Bausteine in `src/components/settings/look.ts`. Vorlagen: je Kategorie eine Überschrift mit „+ Vorlage“, Zeilen mit
runder Buchstaben-Marke A–Z (wie auf den Karten), „Löschen“ fehlt bei der letzten Vorlage einer Kategorie.

**Untermenüs** (Wunsch des Nutzers 08.10.): links eine Seitenleiste (232 px, ab `md` sticky) mit H1 „Einstellungen“,
Suchfeld (findet Bereiche auch über Namen und Hilfetexte ihrer Werte) und Gruppen „Verbindungen · Outreach · System“
(Eyebrow in `ink-3`), oben allein „Auf einen Blick“. Einträge als Textzeilen ohne Kästen, der aktive hinterlegt
(`white/8`, `aria-current="page"`). Rechts genau ein Bereich (max. 760 px): Gruppe klein in `ink-3`, Titel, ein Satz.
Auf dem Handy erst die Liste als gruppierte Karten mit Chevron (Zeilen ≥ 48 px), ein Tipp öffnet den Bereich, oben
„‹ Einstellungen“ zurück. Kennzeichen in der Seitenleiste nur, wenn etwas zu tun ist: blau + „geändert“, `bad` +
„Prüfen“ (Fehler), `warn` („Prüfen“ bei einem Problem oder im Notfallmodus gespeicherten Werten, „auf Probe“, „Fehlt“
im Live-Betrieb, „Aus“ bei ausgeschalteter Sicherung). Im Bereich oben „Stand“ in ein, zwei Wörtern („Eingerichtet“,
„An“/„Aus“, „Treg“, „Close · Slack“). Entwürfe bleiben beim Wechseln erhalten; ein Fehler beim Speichern wechselt in
den Bereich des Felds. „Sicherungen und Updates“ zeigt erst Stand und Knöpfe, darunter „Zeitplan“ mit den Werten.
Je Wert: Beschriftung, Hilfetext in `ink-3` nur, wenn er mehr sagt als Beschriftung oder
Wert, dann die Eingabe – Schalter, Zahlen, Auswahl und kurze Texte ab `sm` rechts neben der Beschriftung. Quelle nur
bei Abweichung: „.env“ klein neben der Beschriftung, Werte aus der Software mit „Zurück zu .env (…)“ bzw. „Zurück zu
Standard (…)“, Standard ohne Hinweis. Was nur bei einer Wahl gilt (Clay statt Treg, Uhrzeit der Updates,
Test-Anfrage), erscheint erst mit dieser Wahl. Schlüssel nie anzeigen: „Gesetzt · endet auf …abcd“ mit „Ersetzen“/
„Entfernen“. Nur-.env-Werte unter „Nur über die .env“ mit Schloss. Verbindungstests („Treg testen“, „Close testen“,
„Slack-Testnachricht“) am Ende ihres Bereichs. Notfallmodus als Statuszeile, nicht als Kasten. Vorlagen als
zuklappbare Zeilen (Kennung, Name, Status nur bei Abweichung, z. B. „Angepasst“); Suchprofil, Hintergrundwissen
(„Gut zu wissen“) und ältere Sicherungen einen Klick entfernt. Verweise auf einen anderen Wert als Link „Ändern ›“ /
„Einschalten ›“, nie als Satz („einschalten unter …“). Unten eine Glas-Leiste mit „N Änderungen · Verwerfen ·
Speichern ↵“ als einziger Haupt-Aktion; vor dem Speichern von Schlüsseln ein Dialog mit Passwort. Probe-Änderung als
Fläche oben mit Restzeit, „Behalten“ und „Jetzt zurücksetzen“.

### Startseite („Heute“)

Nur: Begrüßung („Guten Tag, **Name**.“ – Name in `ink`, Rest in `ink-2`; bei Admin/Mitarbeiter darunter „Aufgaben
von **Name**“), **eine große Zahl**, darunter was sie bedeutet, eine Zeile kleiner Einstiege („3 Antworten · 5 neue
Leads“) und **ein** weißer Hero-Button „Starten ↵“ (danach „Weitermachen ↵“). Kein Datum, keine Hinweiszeile.
Darunter **eine** ruhige Zeile in `ink-3`, wie gesendet wird, mit Chevron – ein Klick zeigt Tageszähler,
LinkedIn-Abgleich und den nächsten automatischen Lauf. Ausnahmen (Pause, Arbeitszeit, Limit, Abgleich-Fehler,
Offline) stehen sichtbar mit Punkt `warn` darüber. Enter startet.
Zustände: Laden („Aufgaben werden geladen …“ erst nach 300 ms, Platz der Zahl bleibt frei), Fehler („Deine
Aufgaben konnten nicht geladen werden.“ + „Erneut versuchen ↵“), leerer Tag („Heute steht nichts an.“ +
„Neue Leads suchen ↵“, ohne weiteren Satz – nie „Alles erledigt“, wenn nichts anstand), erledigt („Alles erledigt
für heute 🎉“).

### Fokus-Modus (eine Aufgabe pro Bildschirm)

```
┌──────────────────────────────────────────────────────┐
│ ✕ Beenden Esc        3 von 14 erledigt          ⧩    │  64 px, schwarz/80 + Blur
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│  1-px-Fortschrittslinie (weiß)
│                     EYEBROW                          │
│                  Name der Person ›                   │  öffnet Details
│               Position · Firma                       │
│         eine Kontextzeile (Signal / Ort)             │
│               [ A | B ]  Variante                    │
│          ┌──────────────────────────────┐            │
│          │ Nachricht / Inhalt           │            │
│          └──────────────────────────────┘            │
│          Bearbeiten E · Vorschlag K · Kopieren       │  eine Zeile Textknöpfe
│   ┌──────────────────┐  ┌──────────────────┐         │  sticky, Verlauf nach Schwarz
│   │ ← Nicht senden   │  │  Senden       ↵  │         │  2 Spalten, 56 px
│   └──────────────────┘  └──────────────────┘         │
└──────────────────────────────────────────────────────┘
```

- Keine Hauptnavigation. Raus kommt man über „Beenden“ (Esc).
- Unten **immer genau zwei** Buttons an derselben Stelle: links `outline` (negativ, ←), rechts `primary`
  (positiv, ↵). Leiste: `sticky bottom-0 bg-gradient-to-t from-black from-70% to-transparent`.
- Alles Wichtige ohne Scrollen sichtbar (Ziel: 1440 × 800). Weiteres hinter Textlinks („Verlauf anzeigen V“).
- Seiten lassen sich wischen (siehe §8).
- Was erst nachgeladen wird (Verlauf, Signal, Vorlage), bekommt einen ruhigen Platzhalter in fester Höhe
  (`bg-white/[0.04]`, kein Schimmern); entschieden werden kann eine Antwort erst, wenn sie zu sehen ist.
- Wurde die Aufgabe inzwischen anderswo erledigt, verschwindet sie nicht unter dem Finger, sondern zeigt
  „Diese Aufgabe ist nicht mehr fällig.“ + „Weiter ↵“.
- Kopf = Eyebrow (Art · Zeitbezug), Name ›, Position · Firma, höchstens eine Kontextzeile. Kein Avatar, keine Pills
  im Kopf.
- Was für die Entscheidung nicht nötig ist, steht im Seitenpanel (Name ›): KI-Zusammenfassung, Branche,
  Gesprächszusammenfassung, nächster Schritt.
- Neuer Lead = Ort · Signal, LinkedIn-Link, ✦ KI-Einschätzung (Urteil + ein Satz). Erstnachricht = Signal,
  Vorlagen-Tabs (Name im Tab), Warnung nur bei Meta-Ads aktiv/unklar, Editor. Follow-up = „Verlauf (n) V“,
  Varianten-Tabs, Editor. Antwort = Antwort-Blase, eine Zeile ✦ KI-Einschätzung, Zeile „Verlauf V · Antwort
  vorschlagen K · Heute überspringen S“.
- Nebenaktionen als eine Zeile Textknöpfe (Button `ghost` `sm` mit Kbd), nie gestapelt. Hinweise nur, wenn sie etwas
  ändern (Meta-Ads-Warnung, gesperrtes Senden, Fehler).
- Filter als Symbol; aktiver Filter als gefüllte Pille, ab `sm` mit Namen.
- Abschlussseiten (erledigt, Filter erledigt, leer) haben keinen eigenen Zurück-Button – raus geht es über „Beenden“
  (Esc).

### „Alles erledigt“

Großer weißer Kreis mit Haken (80 px, weißer Schein), Headline „Alles erledigt für heute 🎉“, ein Satz mit Anzahl
und Dauer – ein Klick darauf klappt die Kennzahlen des Tages als eine ruhige Zeile auf (ohne Kästen) –, dann **ein**
Primär-Button („Zum Dashboard“).

### Dashboard

Titel ohne Meta-Zeile, darunter **Tabs für Ansichten** (Überblick · Vorlagen · Nick vs. Johannes), jede Ansicht
passt auf einen Bildschirm. Filter (Person: Gesamt · Nick · Johannes) rechts in derselben Zeile. Jeder Block nennt
seinen Zeitraum **einmal** als Eyebrow („Letzte 7 Tage · vs. Woche davor“, „Letzte 8 Wochen“). Die Uhrzeit des Stands
erscheint nur, wenn das Nachladen fehlschlug. Kennzahlen als große Zahlen **ohne Kästen**: Label, Zahl, Veränderung;
ein Pfeil nur bei echter Veränderung, sonst „–“ bzw. „±0 %“. Minikurven nur hinter „Verlauf“. Darunter max. zwei
Diagramme nebeneinander, Titel ohne Untertitel, Definitionen höchstens als Tooltip; Klartext statt Fachwort („Von der
Anfrage zum Termin“ statt „Funnel“). Zwei Werte je Kennzahl als Tabelle. Reine Ansicht: kein weißer Button.

### Lead-Suche

Formular: Titel „Neue Leads finden“ → Stichwörter → Positionen → eine Zeile „Deutschland · 15 Profile · 2./3. Grad ·
ohne aktive Meta-Ads · Anpassen ⌄“ (Region, Anzahl mit Schutzhinweis und Tracking-Liste dahinter; fehlt die Region,
steht „Region fehlt“ in `ink`) → „Suche starten ↵“ → eine Zeile, worüber gesucht wird, und die Dauer („Über LinkedIn
· ca. 2 Min.“). Hinweise führen in die Einstellungen („Einstellungen öffnen“), nie auf die Shell. Lauf: Titel =
Ergebnis in Worten; eine Zeile „Region · Stichwörter“ (der Rest im Tooltip); rechts „Abbrechen“ bzw. „Neue Suche“;
Trichter als eine Zahlenzeile (40 Treffer › 33 ohne Dubletten › 15 angereichert › 7 passend › 5 ohne Meta-Ads;
ungeprüfte Meta-Ads im Label nennen); darunter die Liste ohne Avatare. Nach dem Lauf zuerst nur die Qualifizierten
(Reiter „Qualifiziert · Aktive Ads · Nicht bewertet · Aussortiert · Alle“, leere Reiter fallen weg); Aussortiertes mit
einer Zeile Gründe; KI-Einschätzung, Kategorie, Confidence und Rohdaten per Klick auf die Zeile. Unten genau eine
Haupt-Aktion.

### Leads

Titel mit Anzahl daneben; eine Zeile: Meine/Alle · Suche („Name, Firma …“) · Menü „Board ▾“ (Darstellung,
Sortierung). Leere Spalten nur mit Kopf und 0. Tabelle ohne Rahmen, leere Zellen bleiben leer.

### Konten

Titel „Konten“ mit „Konto einladen ↵“ (Gründer: „Mitarbeiter einladen ↵“) rechts in derselben Zeile. Eine Liste,
nach Rolle und Name sortiert, Rolle in jeder Zeile; „Testkonto“ am Ende der Meta-Zeile, offene Einladung als
Statuszeile. Einladungsdialog ohne Feldhinweise – Beispiele als Platzhalter („z. B. anna“), Regeln erst in der
Fehlermeldung; nur unter der Rolle ein Satz, was sie darf.

---

## 8. Bewegung

### Kurven & Federn

```css
--ease-out:    cubic-bezier(0.23, 1, 0.32, 1);   /* Auftritte, Standard */
--ease-apple:  cubic-bezier(0.32, 0.72, 0, 1);   /* Schubladen, Seiten */
```

```ts
const SPRING = { type: 'spring', bounce: 0, duration: 0.35 };        // Menüs, Tabs, Dialoge
const SPRING_PAGE = { type: 'spring', bounce: 0, duration: 0.5 };    // Seitenwechsel
const SPRING_BACK = { type: 'spring', bounce: 0.25, duration: 0.5 }; // Zurückfedern nach einer Geste
```

Federn sind kritisch gedämpft (`bounce: 0`). Nachschwingen **nur**, wenn vorher eine Geste Schwung hatte.
Kurven und Federn kommen aus `src/lib/motion.ts` (`EASE_OUT`, `EASE_APPLE`, `SPRING`, `SPRING_MENU`, `SPRING_PAGE`,
`SPRING_BACK`) – keine eigenen Literale, keine eingebauten Kurven wie `'easeOut'` (zu flach).

### Dauern

| Was | Dauer |
| --- | --- |
| Button drücken | 100 ms (`active:scale-[0.97]`) |
| Hover, Farbe | 150–200 ms |
| Menü / Popover | Feder 0.3 s, `transform-origin` am Auslöser |
| Dialog | Feder 0.35 s, Start `scale 0.96, y 12` |
| Seitenwechsel im Fokus-Modus | Feder 0.45–0.5 s |
| Gestaffelter Auftritt | 70 ms zwischen Elementen |
| Login-Auftritt | 0.8 s pro Element, Horizont 1.8 s (seltener Moment) |

### Regeln

- **Nur `transform` und `opacity`** animieren. Nie `width`, `height`, `top`, `left` (Ausnahme: Akkordeon-Höhe).
- **Nie `scale(0)`** – Start bei `0.95–0.97` + `opacity: 0`.
- **Nie `ease-in`** für Oberflächen.
- **Räumlich konsistent:** Raus, wie es reinkam. Positive Entscheidung verlässt den Bildschirm nach rechts,
  negative nach links, die nächste Aufgabe kommt von unten. **Rückgängig** holt die Aufgabe von der Seite zurück,
  zu der sie ging. Seitenpanel: rechts rein, rechts raus.
- **Nie Eingaben blockieren** während einer Animation – die nächste Aufgabe ist sofort bedienbar. Muss eine Ansicht
  erst ausblenden (`AnimatePresence mode="wait"`, z. B. Startseite ↔ Fokus-Modus), dann in höchstens 0,1 s.
- **Rückmeldung beim Drücken:** `Button` skaliert (`active:scale-[0.97]`). Jeder andere Knopf ohne eigenes `active:`
  (Textlink, Zeile, Symbol) wird beim Drücken sofort auf 60 % gedimmt (globale Regel in `src/index.css`) –
  eigene Druck-Effekte nur mit `active:`-Klasse, dann greift die Regel nicht. `touch-action: manipulation` auf allen
  Bedienelementen (kein Doppeltipp-Warten).
- **Geschwindigkeit übergeben:** Wo eine Geste in eine Animation übergeht (Karte wegwischen, Sheet/Panel schließen,
  Zurückfedern), bekommt die Feder `velocity` = Fingergeschwindigkeit beim Loslassen. Keine Naht zwischen Ziehen
  und Animieren.
- **Ziehen ohne eigenen Listener** (`dragListener={false}` + `dragControls`) braucht selbst `touch-pan-y` bzw.
  `touch-pan-x` – sonst übernimmt der Browser die Geste als Scrollen und bricht sie ab.
- **Auftauchen statt Aufploppen:** Inhalt, der ohne Klick-Ziel neu erscheint, blendet per `@starting-style`
  (Tailwind `starting:`) ein – neue Zeilen der Live-Liste (`starting:opacity-0 starting:translate-y-1`, 200 ms
  `ease-out`), geöffnete `DisclosureRow` (`starting:-translate-y-1`, 200 ms), nachgeladene Firmendaten (nur Opacity,
  150 ms). Schließen bleibt sofort. Tailwind 4 verschiebt über die CSS-Eigenschaft `translate`, deshalb
  `transition-[opacity,translate]` – nicht `transform`. Bei reduzierter Bewegung nur Opacity
  (`motion-reduce:starting:translate-y-0`).
- **Chats auf dem Handy** wie ein Navigations-Stapel: Das Gespräch kommt von rechts (`x: 24`, Opacity, Feder 0.35 s)
  und geht beim Zurück nach rechts; die Liste darunter ist dabei schon bedienbar. Ab `md` keine Bewegung.
- **Eine Einblendung pro Ansicht:** Die Ansicht als Ganzes blendet ein (`App.tsx`); Seiteninhalte darunter bekommen
  keine zweite, längere Einblendung. Listen, die du sofort lesen willst (Verlauf im Panel), werden nicht gestaffelt.
- **Daten springen nicht neu an:** Diagramm- und Trichterbalken animieren einmal pro Besuch, nicht bei jedem Filter.
- **Reduzierte Bewegung** schaltet in `motion` nur Transforms ab: Was sich allein per `x`/`y` bewegt (Sheet, Panel),
  bekommt dann ein Überblenden (`useReducedMotion()`); Endlos-Pulsieren steht still (`motion-reduce:animate-none`).
- **Bewusst ohne Bewegung:** Tastenkürzel, „Kopieren → Kopiert“, Diagramme, Zahlen des Trichters, „Details“ im Panel.
- **Balken und Fortschritt** per `transform` (`translateX(-x%)` eines vollen Balkens in einer `overflow-hidden`-Spur),
  nie `width` animieren.
- **Häufige Aktionen** (Tastenkürzel, 100+ Mal am Tag) bekommen höchstens eine minimale Rückmeldung.
- **Reduzierte Bewegung:** `<MotionConfig reducedMotion="user">` – Bewegungen entfallen, Einblenden bleibt.

### Wischgeste (Karten / Aufgaben)

- Ziehen folgt 1:1, leichte Neigung: `rotate = map(x, [-600, 0, 600], [-5°, 0, 5°])`.
- Beim Loslassen Endpunkt hochrechnen (Apple, „Designing Fluid Interfaces“):
  `projected = x + (v / 1000) * 0.998 / (1 - 0.998)`.
- Entscheidung, wenn `|projected| > 160 px` **und** Weg > 40 px; sonst `SPRING_BACK` zur Mitte.
- Beim Hinausfliegen übernimmt die Feder die Fingergeschwindigkeit (`velocity` aus `onDragEnd`, ausdrücklich
  übergeben); beim Zurückfedern ebenso.
- Hinweis in Gestenrichtung: Label („Senden →“ / „← Nicht senden“) blendet zwischen 24 und 140 px Auslenkung
  ein und ersetzt die Eyebrow-Zeile.
- Nicht auf Buttons, Feldern, Tabs starten; Textmarkierung beim Ziehen verhindern.

---

## 9. Interaktion & Tastatur

| Taste | Bedeutung (überall gleich) |
| --- | --- |
| `↵` Enter | Haupt-Aktion des Bildschirms (Start, Senden, Vernetzen, Exportieren, Bestätigen) |
| `→` | ebenfalls Haupt-Aktion (Alternative) |
| `←` | Ablehnen / Nicht senden / Verwerfen |
| `Esc` | Schließen bzw. eine Ebene zurück |
| `Z` | Rückgängig |
| `1`–`4` | Variante / Template wählen |
| `E` | Text bearbeiten |
| `V` | Verlauf ein-/ausblenden |
| `S` | Antwort für heute überspringen |
| `K` | Vorschlag holen |
| `⌘/Strg + ↵` | Im Textfeld senden (Enter = Zeilenumbruch) |

- Kürzel sind auf den Buttons sichtbar (`Kbd`), auf Touch-Geräten ausgeblendet.
- Globale Kürzel sind aus, solange in ein Feld getippt wird oder ein Dialog offen ist.
- Hover-Effekte nur auf Geräten mit Maus/Trackpad (Tailwind v4 macht das bei `hover:` automatisch).
- Druck-Feedback beim Drücken, nicht erst beim Loslassen.
- Klickbare Namen öffnen Details: Unterstreichung + Chevron (›) erst bei Hover.
- Esc schließt Menüs und Popover und gibt den Fokus an den Auslöser zurück. Popover setzen keinen Autofokus.

---

## 10. Texte & Ton

- Deutsch, per **Du**, kurz und konkret.
- Buttons sind Verben: „Vernetzen“, „Senden“, „Nicht senden“, „In Close exportieren“, „Beenden“.
- Status in zwei Schritten: „Nachricht wird gesendet“ → „Gesendet“ (live: „wird eingetragen“ → „Eingetragen“).
- Ehrlich bleiben: Nichts „Gesendet“ nennen, was das Cockpit nicht gesendet hat (siehe §6 „Senden oder eintragen“).
- Zahlen mit Bedeutung: „14 Aufgaben für heute“, „3 von 14 erledigt“.
- Leere Zustände sind freundlich und fassen zusammen („Alles erledigt für heute 🎉 – 14 Aufgaben in 3:12 Min.“).
- KI-Inhalte immer als solche kennzeichnen (Eyebrow „✦ KI-Zusammenfassung“, „KI-Einschätzung“).
- Höchstens ein Satz unter einem Titel; nichts erklären, was Beschriftung, Knopf, Dialog oder Meldung schon sagen.
- Ein Begriff pro Sache in der ganzen App: „Vorlage“ (nicht „Template“), „Zuständig“, „Einstellungen öffnen“.

---

## 11. Diagramme

| Element | Wert |
| --- | --- |
| Reihe 1 | `#e8e8ed` (fast weiß) |
| Reihe 2 / Hervorhebung | `#2997ff` |
| Gitter | `rgba(255,255,255,0.07)`, nur horizontal, 1 px |
| Achsen | keine Linie, Beschriftung `#6e6e73`, 11 px |
| Linien | 2 px, Fläche darunter als Verlauf 12–22 % → 0 % |
| Balken | max. 24–28 px breit, oben 4 px Radius, bester Wert in Blau |
| Tooltip | `surface-3`, Wert zuerst und fett, Reihenname danach, kurzer Farbstrich als Schlüssel |

Mehr als 2 Reihen vermeiden; eine Achse pro Diagramm; Legende ab 2 Reihen; Prozentwerte direkt über die Balken.
Keine Untertitel, die Zahlen des Diagramms wiederholen oder es erklären. Zwei Werte je Kennzahl als Tabelle, nicht als
Balkenpaare.

---

## 12. Barrierefreiheit

- Fokusring: `outline: 2px solid rgb(41 151 255 / 0.8); outline-offset: 2px` (`:focus-visible`).
- `prefers-reduced-motion`: Bewegung aus, Einblenden bleibt.
- `prefers-reduced-transparency` und `prefers-contrast: more`: Glas wird massiv, Linien/Texte kräftiger
  (siehe CSS unten). Jede Fläche mit `backdrop-blur-*` außerhalb von `.glass` bekommt
  `reduced-transparency:bg-… reduced-transparency:backdrop-blur-none` (eigene Tailwind-Variante in `src/index.css`).
- Dialoge mit `role="dialog"` + `aria-modal`, Esc schließt.
- Tipp-Ziele mindestens 44 px hoch für Hauptaktionen (`xl` = 56 px).

---

## 13. Bekannte Stolperfallen

| Problem | Lösung |
| --- | --- |
| Safari zeigt dunkle Kästen/Artefakte bei `backdrop-filter` auf animierten Elementen | Glas nur auf feststehenden Leisten; bewegte Karten mit massivem `surface-1` |
| Große `blur()`-Filter ruckeln / rendern falsch | Lichthöfe als `radial-gradient(closest-side, …)` statt `filter: blur` |
| Grid-Kind sprengt die Breite auf Mobil | `grid-cols-[minmax(0,1fr)]` |
| Meldungen verdecken Menüs | Ebenen: Benachrichtigung `z-25` < Navigation `z-30` < Statusmeldung `z-40` < Dialog/Panel `z-50` |
| Toasts stapeln sich und überdecken Inhalt | immer nur eine Meldung |
| Docker-Build bricht in Proxmox-LXC bei `npm ci` ab | in `docker-compose.yml`: `build: { context: ., network: host }` |
| KPIs sehen je nach Präsentationstag schlecht aus | Demo-Daten wochenweise mit festem Trend erzeugen, nicht tagesabhängig |

---

## 14. Startpaket

### `src/index.css`

```css
@import 'tailwindcss';

@theme {
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter Variable', 'Segoe UI', system-ui, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter Variable', 'Segoe UI', system-ui, sans-serif;

  --color-canvas: #000000;
  --color-surface-1: #0c0c0d;
  --color-surface-2: #141415;
  --color-surface-3: #1c1c1e;
  --color-surface-4: #262628;
  --color-line: rgb(255 255 255 / 0.08);
  --color-line-strong: rgb(255 255 255 / 0.14);
  --color-ink: #f5f5f7;
  --color-ink-2: #a1a1a6;
  --color-ink-3: #6e6e73;
  --color-ink-4: #48484a;
  --color-accent: #2997ff;
  --color-accent-soft: rgb(41 151 255 / 0.14);
  --color-good: #30d158;
  --color-warn: #ff9f0a;
  --color-bad: #ff453a;

  /* überschreibt Tailwinds `ease-out` mit einer kräftigeren Kurve */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-apple: cubic-bezier(0.32, 0.72, 0, 1);
}

@layer base {
  :root { color-scheme: dark; }
  html, body { background: var(--color-canvas); color: var(--color-ink); }
  body {
    font-family: var(--font-sans);
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  ::selection { background: rgb(41 151 255 / 0.35); }
  button { cursor: pointer; }
  :focus-visible { outline: 2px solid rgb(41 151 255 / 0.8); outline-offset: 2px; }
}

@layer components {
  .display { font-family: var(--font-display); letter-spacing: -0.025em; line-height: 1.08; }
  .glass {
    background: rgb(12 12 13 / 0.72);
    backdrop-filter: blur(24px) saturate(160%);
    -webkit-backdrop-filter: blur(24px) saturate(160%);
  }
}

@media (prefers-reduced-transparency: reduce) {
  .glass { background: var(--color-surface-1); backdrop-filter: none; -webkit-backdrop-filter: none; }
}

@media (prefers-contrast: more) {
  :root {
    --color-line: rgb(255 255 255 / 0.22);
    --color-line-strong: rgb(255 255 255 / 0.36);
    --color-ink-2: #d1d1d6;
    --color-ink-3: #a1a1a6;
  }
  .glass { background: var(--color-surface-1); backdrop-filter: none; -webkit-backdrop-filter: none; }
}
```

### Dateien zum Übernehmen aus diesem Repo

| Datei | Inhalt |
| --- | --- |
| `src/components/ui/Button.tsx` | Button mit Varianten, Größen, Kürzel-Hinweis |
| `src/components/ui/Kbd.tsx` | Tastenkürzel |
| `src/components/ui/Pill.tsx` | Label mit Status-Punkt/Icon |
| `src/components/ui/Segmented.tsx` | Tabs mit gleitender Auswahl |
| `src/components/ui/Modal.tsx` | Dialog mit Abdunkelung, Esc, Ausblend-Logik |
| `src/components/ui/Avatar.tsx` | Initialen-Avatar |
| `src/components/ui/PageHeader.tsx` | Seitenkopf: Titel, Zahl, Haupt-Aktion |
| `src/components/ui/Disclosure.tsx`, `DisclosureRow.tsx` | Aufklappen (Textknopf, Zeile mit Stand) |
| `src/components/ui/Status.tsx` | Punkt, Statuszeile, Stand-Text |
| `src/components/ui/SectionLabel.tsx`, `MetaLine.tsx` | Eyebrow, Meta-Zeile mit · |
| `src/components/stack/FocusParts.tsx` | Fokus-Seite, Eyebrow, Personen-Kopf, Wisch-Hinweise |
| `src/components/stack/FocusView.tsx` | Kopfleiste, Seitenwechsel, Wischgeste |
| `src/components/stack/swipe.tsx` | Wisch-Aktionen |
| `src/lib/gesture.ts` | Projektionsformel, `shouldDismiss`, `SPRING_BACK`, `useMediaQuery` |
| `src/components/stack/ActivityToasts.tsx` | Statusmeldung mit Rückgängig |
| `src/components/stack/MessageEditor.tsx` | Textfeld mit farbigen Variablen |
| `src/lib/useHotkeys.ts`, `src/lib/useScrolled.ts`, `src/lib/cn.ts` | Hilfsfunktionen |
| `src/pages/Login.tsx` | Willkommensseite mit Horizont-Animation |
| `Dockerfile`, `nginx.conf`, `docker-compose.yml` | Auslieferung |

---

## 15. Checkliste für jeden neuen Bildschirm

- [ ] Gibt es genau **eine** Haupt-Aktion (weißer Button, Enter)? (Reine Ansichten wie das Dashboard: keine.)
- [ ] Passt das Wichtigste ohne Scrollen auf 1440 × 800?
- [ ] Nur Schwarz/Weiß/Grau – Blau nur für Hervorhebung?
- [ ] Hierarchie über Typografie statt über Kästen?
- [ ] Kürzel sichtbar, Esc führt zurück, Rückgängig möglich?
- [ ] Bewegung nur mit `transform`/`opacity`, räumlich logisch, Eingaben nie blockiert?
- [ ] Reduzierte Bewegung, Fokusring und Kontrast geprüft?
- [ ] Mobil ohne horizontalen Überlauf (390 px)?
- [ ] Texte auf Deutsch, per Du, Buttons als Verben?
- [ ] Kein Eyebrow, das nur Navigation oder Reiter wiederholt; höchstens ein Satz unter dem Titel?
- [ ] Steht jede Information nur einmal auf dem Bildschirm?
- [ ] Normalzustand unbeschriftet, nur Abweichungen markiert?
- [ ] Seltenes (Zähler, Zeitpläne, Optionen, Aufschlüsselungen) einen Klick entfernt – Warnungen und Fehler sichtbar,
  kein doppelter Ausgang?
- [ ] Hinweise führen in die Oberfläche, nie auf die Shell?
