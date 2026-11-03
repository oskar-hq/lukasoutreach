import type { MessageKind, TemplateAudience, TemplateSegment } from '../../../shared/messages.js';

/**
 * Standard-Vorlagen (Vertrag `shared/messages.ts`) – seit 12.10. die Outreach-Nachrichten des Kunden (Wunsch des
 * Nutzers: „das sind deren Outreach-Nachrichten, als Standard eintragen“). Zielgruppe: Firmen **ohne** Meta-Ads
 * (Greenfield, „Meta Ads nie“) und Firmen, die **aufgehört** haben (Reactivation, „Meta Ads aus seit“, {{metastopp}} =
 * „vor rund 4 Monaten“). Zahlen und Kundennamen stammen vom Kunden. Je Follow-up-Stufe eine Nachricht (die früheren
 * B-Varianten F1B–F3B sind entfallen). Die IDs sind stabil (stehen als `label` im Verlauf); in der Software geänderte
 * Texte bleiben, bis man sie unter Einstellungen → Vorlagen zurücksetzt.
 *
 * Segmente (Kundengespräch 27.10.): Die Kundentexte sprechen Kapitalanlage-Vertriebe an (Reservierungen, Notar) und
 * gelten nur für dieses Segment. Für Finanzdienstleister gibt es eigene Entwürfe (IDs mit „F“ am Ende bzw. „GF“, „RF“,
 * „SF“), ohne erfundene Zahlen – der Kunde ergänzt seine Fallstudien unter Einstellungen → Vorlagen. Recruiting und
 * Vernetzungsnotiz gelten für alle.
 */
export interface DefaultTemplate {
  id: string;
  kind: MessageKind;
  stage: number | null;
  audience: TemplateAudience;
  /** null = für alle Leads. */
  segment: TemplateSegment | null;
  name: string;
  description: string;
  text: string;
}

export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    id: 'G1',
    kind: 'first',
    stage: null,
    audience: 'greenfield',
    segment: 'kapitalanlage',
    name: 'Meta Ads nie · Option 1',
    description: 'Keine Werbeanzeigen in der Meta Ad Library – Frage nach Empfehlung oder externen Leads, Zahlen der Kunden.',
    text: `Hey {{vorname}},

hab in der Meta Ad Library gesehen, dass ihr aktuell bei {{firma}} keine Werbeanzeigen schaltet.

Läuft bei euch aktuell alles über Empfehlung oder holt ihr Leads extern dazu?

Ich frage, weil wir die Werbeanzeigen für Vertriebe wie Betongold, Finanzstarter oder Proper API mit folgenden Ergebnissen erstellen:

— Bonitäts-Lead (über 3.000 € netto, 10.000 € EK, schufafrei): 100–200 €

— Kosten pro abgeschlossener Reservierung: 1.000–2.000 €

Falls ihr aktuell nicht voll ausgelastet seid: Macht ein 15-Minuten-Call Sinn, in dem ich dir zeige, wieso unsere Strategie so gut funktioniert und was bei euch drin wäre?`,
  },
  {
    id: 'G2',
    kind: 'first',
    stage: null,
    audience: 'greenfield',
    segment: 'kapitalanlage',
    name: 'Meta Ads nie · Option 2',
    description: 'Keine Meta Ads – „Hand aufs Herz, woran lag’s?“ mit drei Gründen und drei Kundenbeispielen.',
    text: `Hey {{vorname}},

mir ist aufgefallen, dass ihr aktuell keine Meta Ads schaltet. Hand aufs Herz, woran lag's:

1. Wird seit Monaten aufgeschoben, nie der „richtige“ Zeitpunkt

2. Die letzte Agentur hat mal wieder 10.000 € Ad Spend verbrannt

3. Nicht die gewünschten Ergebnisse

Wir lösen genau das. Mit unserem Bonitäts-Leadflow-System schließen unsere Kunden im Schnitt 5–8 Einheiten pro Monat zum Notar ab, bei unter 1.000 € pro Termin.

Drei Beispiele:

— Proper API: Von 100k € auf 500k € Monatsumsatz in 9 Monaten

— Finanzstarter: 12 neue Reservierungen pro Monat – ausschließlich durch uns

— Betongold: 120 € pro Bonitäts-Lead (>3k € netto, 10k € EK, schufafrei), 800 € pro Reservierung

Macht ein 15-Minuten-Call Sinn?

PS: Expose uns bitte danach öffentlich auf LinkedIn, falls wir Scheiße labern sollten.`,
  },
  {
    id: 'R1',
    kind: 'first',
    stage: null,
    audience: 'reactivation',
    segment: 'kapitalanlage',
    name: 'Meta Ads aus seit · Option 1',
    description: 'Hat aufgehört, Meta Ads zu schalten – drei mögliche Gründe, Tipp auf 1., drei Kundenbeispiele.',
    text: `Hey {{vorname}},

mir ist aufgefallen, dass ihr {{metastopp}} aufgehört habt, Meta Ads zu schalten. Hand aufs Herz, woran lag's:

1. Die letzte Agentur hat mal wieder 10.000 € Ad Spend verbrannt ohne Ergebnisse
2. Vertrieb war überlastet
3. Aktuell keine Zeit mehr

(Basierend auf den Werbeanzeigen tippe ich auf 1., hab ich recht?)

Wir lösen genau das. Mit unserem Bonitäts-Leadflow-System schließen unsere Kunden im Schnitt 5–8 Einheiten pro Monat zum Notar ab, bei unter 1.000 € pro Termin.

Drei Beispiele, damit du weißt, dass wir keine Schwätzer sind und Ergebnisse liefern:

— Proper API: Von 100k € auf 500k € Monatsumsatz in 9 Monaten
— Finanzstarter: 12 neue Reservierungen pro Monat – ausschließlich durch uns
— Betongold: 120 € pro Bonitäts-Lead (>3k € netto, 10k € EK, schufafrei), 800 € pro Reservierung

Macht ein 15-Minuten-Call Sinn?

PS: Expose uns bitte danach öffentlich auf LinkedIn, falls wir Scheiße labern sollten.`,
  },
  {
    id: 'R2',
    kind: 'first',
    stage: null,
    audience: 'reactivation',
    segment: 'kapitalanlage',
    name: 'Meta Ads aus seit · Option 2',
    description: 'Kurze Variante im Stil von „Meta Ads nie · Option 1“ – Ad Library, aufgehört, Zahlen der Kunden.',
    text: `Hey {{vorname}},

hab in der Meta Ad Library gesehen, dass ihr bei {{firma}} {{metastopp}} aufgehört habt, Werbeanzeigen zu schalten.

Läuft bei euch inzwischen alles über Empfehlung oder holt ihr Leads extern dazu?

Ich frage, weil wir die Werbeanzeigen für Vertriebe wie Betongold, Finanzstarter oder Proper API mit folgenden Ergebnissen erstellen:

— Bonitäts-Lead (über 3.000 € netto, 10.000 € EK, schufafrei): 100–200 €

— Kosten pro abgeschlossener Reservierung: 1.000–2.000 €

Falls ihr aktuell nicht voll ausgelastet seid: Macht ein 15-Minuten-Call Sinn, in dem ich dir zeige, was beim zweiten Anlauf bei euch drin wäre?`,
  },
  // Schaltet gerade Meta-Ads (12.10., Wunsch des Nutzers: „vielleicht verbrennst du da gerade Kohle“) – Entwurf im Stil
  // der Kundenvorlagen, Zahlen wie dort. Der Kunde passt sie unter Einstellungen → Vorlagen an.
  {
    id: 'S1',
    kind: 'first',
    stage: null,
    audience: 'active',
    segment: 'kapitalanlage',
    name: 'Schaltet Meta Ads · Option 1',
    description: 'Schaltet gerade Meta Ads – läuft es so wie gedacht? Zahlen der Kunden als Vergleich.',
    text: `Hey {{vorname}},

hab in der Meta Ad Library gesehen, dass ihr bei {{firma}} gerade Werbeanzeigen schaltet.

Kurze ehrliche Frage: Läuft das so, wie ihr euch das vorstellt, oder geht gerade mehr Ad Spend drauf, als hinten rauskommt?

Ich frage, weil wir die Werbeanzeigen für Vertriebe wie Betongold, Finanzstarter oder Proper API mit folgenden Ergebnissen erstellen:

— Bonitäts-Lead (über 3.000 € netto, 10.000 € EK, schufafrei): 100–200 €

— Kosten pro abgeschlossener Reservierung: 1.000–2.000 €

Falls eure Zahlen da nicht rankommen: Macht ein 15-Minuten-Call Sinn, in dem ich mir eure aktuellen Anzeigen anschaue und dir zeige, was drin wäre?`,
  },
  {
    id: 'S2',
    kind: 'first',
    stage: null,
    audience: 'active',
    segment: 'kapitalanlage',
    name: 'Schaltet Meta Ads · Option 2',
    description: 'Schaltet gerade Meta Ads – „Hand aufs Herz, wie läuft’s?“ mit drei Möglichkeiten und drei Kundenbeispielen.',
    text: `Hey {{vorname}},

mir ist aufgefallen, dass ihr gerade Meta Ads schaltet. Hand aufs Herz, wie läuft's:

1. Leads kommen, aber ohne Bonität und Eigenkapital

2. Die Kosten pro Termin sind deutlich höher als gedacht

3. Läuft super – dann ignorier diese Nachricht einfach

Falls es 1. oder 2. ist: Mit unserem Bonitäts-Leadflow-System schließen unsere Kunden im Schnitt 5–8 Einheiten pro Monat zum Notar ab, bei unter 1.000 € pro Termin.

Drei Beispiele:

— Proper API: Von 100k € auf 500k € Monatsumsatz in 9 Monaten

— Finanzstarter: 12 neue Reservierungen pro Monat – ausschließlich durch uns

— Betongold: 120 € pro Bonitäts-Lead (>3k € netto, 10k € EK, schufafrei), 800 € pro Reservierung

Macht ein 15-Minuten-Call Sinn?`,
  },
  // ── Finanzdienstleister (27.10., Kundengespräch: „segmentierte Follow-up-Strecke“) – Entwürfe im Stil der
  // Kundenvorlagen, ohne erfundene Zahlen oder Kundennamen. ──
  {
    id: 'GF1',
    kind: 'first',
    stage: null,
    audience: 'greenfield',
    segment: 'finanzdienstleister',
    name: 'FDL · Meta Ads nie',
    description: 'Finanzdienstleister ohne Werbeanzeigen – Empfehlung oder externe Termine? Entwurf, Fallstudie ergänzen.',
    text: `Hey {{vorname}},

hab in der Meta Ad Library gesehen, dass ihr bei {{firma}} aktuell keine Werbeanzeigen schaltet.

Läuft bei euch die Neukundengewinnung über Empfehlungen und Bestandskunden oder holt ihr Termine extern dazu?

Ich frage, weil wir für Finanzdienstleister planbar Beratungstermine über Facebook und Instagram aufbauen – vorqualifiziert nach Einkommen und Bedarf, damit eure Berater nicht jedem Lead hinterhertelefonieren müssen.

Macht ein 15-Minuten-Call Sinn, in dem ich dir zeige, wie das bei euch aussehen könnte?`,
  },
  {
    id: 'RF1',
    kind: 'first',
    stage: null,
    audience: 'reactivation',
    segment: 'finanzdienstleister',
    name: 'FDL · Meta Ads aus seit',
    description: 'Finanzdienstleister, der aufgehört hat, Meta Ads zu schalten – drei mögliche Gründe. Entwurf.',
    text: `Hey {{vorname}},

mir ist aufgefallen, dass ihr bei {{firma}} {{metastopp}} aufgehört habt, Meta Ads zu schalten. Hand aufs Herz, woran lag's:

1. Die Leads hatten kein Budget oder kein echtes Interesse
2. Die Agentur hat Ad Spend verbrannt, ohne dass Termine rauskamen
3. Eure Berater hatten keine Zeit, die Leads abzuarbeiten

Genau das lösen wir für Finanzdienstleister: vorqualifizierte Beratungstermine über Facebook und Instagram, gefiltert nach Einkommen und Bedarf.

Macht ein 15-Minuten-Call Sinn?`,
  },
  {
    id: 'SF1',
    kind: 'first',
    stage: null,
    audience: 'active',
    segment: 'finanzdienstleister',
    name: 'FDL · Schaltet Meta Ads',
    description: 'Finanzdienstleister, der gerade Meta Ads schaltet – kommen Termine mit Budget raus? Entwurf.',
    text: `Hey {{vorname}},

hab in der Meta Ad Library gesehen, dass ihr bei {{firma}} gerade Werbeanzeigen schaltet.

Kurze ehrliche Frage: Kommen da Termine mit Leuten raus, die wirklich Budget für Vorsorge und Vermögensaufbau haben – oder eher viele Kontakte, die eure Berater nur Zeit kosten?

Wir bauen für Finanzdienstleister Kampagnen, die nach Einkommen und Bedarf vorqualifizieren, damit am Ende Beratungstermine stehen und nicht nur Leads.

Macht ein 15-Minuten-Call Sinn, in dem ich mir eure aktuellen Anzeigen anschaue?`,
  },
  // Sucht Mitarbeiter (13.10., Wunsch des Nutzers: Hiring-Signal → Leute über Social Media erreichen, die man anstellen
  // kann). Gilt vor dem Lead-Typ, sobald der Lead ein Hiring-Signal hat; {{stelle}} = „Verstärkung als …“. Entwurf im Stil
  // der Kundenvorlagen, ohne erfundene Zahlen – der Kunde passt ihn unter Einstellungen → Vorlagen an.
  {
    id: 'H1',
    kind: 'first',
    stage: null,
    audience: 'hiring',
    segment: null,
    name: 'Sucht Mitarbeiter · Recruiting',
    description: 'Die Firma sucht gerade Mitarbeiter – Bewerber über Facebook und Instagram statt nur über Jobportale.',
    text: `Hey {{vorname}},

hab gesehen, dass ihr bei {{firma}} gerade {{stelle}} sucht.

Kurze ehrliche Frage: Kommen über Jobportale und Empfehlungen genug passende Bewerbungen rein?

Die meisten guten Vertriebler suchen gar nicht aktiv nach einem neuen Job – erreichen kann man sie trotzdem, und zwar dort, wo sie jeden Tag sind: auf Facebook und Instagram. Genau dafür bauen wir Recruiting-Kampagnen, mit einer kurzen Bewerbung in 60 Sekunden, ganz ohne Lebenslauf.

Macht ein 15-Minuten-Call Sinn, in dem ich dir zeige, wie das bei euch aussehen würde?`,
  },
  {
    id: 'F1A',
    kind: 'followup',
    stage: 1,
    audience: 'any',
    segment: 'kapitalanlage',
    name: 'Follow-up 1 · Update Finanzstarter',
    description: 'Erinnerung mit frischem Kundenergebnis, Frage nach 30-Minuten-Call.',
    text: `Hey {{vorname}},

ich hatte dir eine Nachricht gesendet bzgl. unserer Meta-Ads-Strategie.

Nur ein kleines Update von einem unserer Kunden: Finanzstarter hat diesen Monat 6 Reservierungen und einen Umsatz von 120.000 € zusätzlich durch uns gewonnen.

Lohnt sich ein kurzer 30-Minuten-Call, in dem ich dir zeige, wie genau das für euch aussehen könnte?

Beste Grüße`,
  },
  {
    id: 'F2A',
    kind: 'followup',
    stage: 2,
    audience: 'any',
    segment: 'kapitalanlage',
    name: 'Follow-up 2 · Case Study Proper API',
    description: 'Case Study: von Bestandskunden abhängig zu planbarem Wachstum.',
    text: `Hey {{vorname}},

ich wollte dir kurz eine weitere Case Study von uns zeigen:

Dariusch von Proper API war 3 Jahre lang abhängig von Bestandskunden – mit schwankenden Umsätzen und Stagnation bei circa 100k/Monat, obwohl er eigentlich skalieren wollte.

Ergebnis durch unser Bonitäts-Leadflow-System:

1. +400k monatlich wiederkehrender Umsatz in 7 Monaten
2. 150 € pro Bonitätsanfrage
3. Ein System, das jeden Monat planbar zu Neukunden führt

Klingt das grundsätzlich interessant?

Beste Grüße`,
  },
  {
    id: 'F3A',
    kind: 'followup',
    stage: 3,
    audience: 'any',
    segment: 'kapitalanlage',
    name: 'Follow-up 3 · Drei Antworten',
    description: 'Letzte Nachricht: „Nicht interessiert“, „Zu viel zu tun“ oder „Call“.',
    text: `Hey {{vorname}},

ich habe von dir bisher noch keine Rückmeldung bekommen.

Antworte einfach mit:

„Nicht interessiert“ – und wir melden uns nie wieder bei dir

„Zu viel zu tun“ – und wir schreiben dir in ein paar Wochen nochmal

„Call“ – und ich zeige dir in 30 Minuten, wie wir für unsere Kunden Reservierungen für im Schnitt 1.000–1.500 € generieren

So oder so, all good!

Beste Grüße`,
  },
  {
    id: 'F1F',
    kind: 'followup',
    stage: 1,
    audience: 'any',
    segment: 'finanzdienstleister',
    name: 'FDL · Follow-up 1 · Kurz zur Einordnung',
    description: 'Finanzdienstleister: Erinnerung, was wir für FDLs machen, Frage nach 30-Minuten-Call. Entwurf, Fallstudie ergänzen.',
    text: `Hey {{vorname}},

ich hatte dir eine Nachricht bzgl. Neukundengewinnung über Facebook und Instagram gesendet.

Kurz zur Einordnung: Wir arbeiten mit Finanzdienstleistern zusammen und liefern ihnen planbar vorqualifizierte Beratungstermine – ohne Kaltakquise und ohne dass die Berater Leads hinterhertelefonieren.

Lohnt sich ein kurzer 30-Minuten-Call, in dem ich dir zeige, wie das für euch aussehen könnte?

Beste Grüße`,
  },
  {
    id: 'F2F',
    kind: 'followup',
    stage: 2,
    audience: 'any',
    segment: 'finanzdienstleister',
    name: 'FDL · Follow-up 2 · Weg von Empfehlungen',
    description: 'Finanzdienstleister: abhängig von Empfehlungen und Bestandskunden → planbar neue Interessenten. Entwurf.',
    text: `Hey {{vorname}},

kurze Frage noch: Wie viele neue Beratungstermine bekommt euer Team aktuell pro Monat – und wie viele davon kommen aus Empfehlungen?

Die meisten Finanzdienstleister, mit denen wir sprechen, hängen fast komplett an Empfehlungen und Bestandskunden. Das funktioniert, bis man wachsen will.

Mit unserem System kommen jeden Monat planbar neue Interessenten mit Budget dazu.

Klingt das grundsätzlich interessant?

Beste Grüße`,
  },
  {
    id: 'F3F',
    kind: 'followup',
    stage: 3,
    audience: 'any',
    segment: 'finanzdienstleister',
    name: 'FDL · Follow-up 3 · Drei Antworten',
    description: 'Finanzdienstleister, letzte Nachricht: „Nicht interessiert“, „Zu viel zu tun“ oder „Call“.',
    text: `Hey {{vorname}},

ich habe von dir bisher noch keine Rückmeldung bekommen.

Antworte einfach mit:

„Nicht interessiert“ – und wir melden uns nie wieder bei dir

„Zu viel zu tun“ – und wir schreiben dir in ein paar Wochen nochmal

„Call“ – und ich zeige dir in 30 Minuten, wie wir für Finanzdienstleister planbar Beratungstermine generieren

So oder so, all good!

Beste Grüße`,
  },
  {
    id: 'N1',
    kind: 'invite_note',
    stage: null,
    audience: 'any',
    segment: null,
    name: 'Notiz zur Vernetzungsanfrage',
    description: 'Optional, höchstens 300 Zeichen.',
    text: `Hallo {{vorname}}, ich vernetze mich gern mit Entscheidern aus der Immobilien- und Finanzbranche – {{firma}} ist mir dabei aufgefallen. Freue mich auf den Austausch!`,
  },
];
