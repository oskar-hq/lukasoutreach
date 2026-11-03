// Erzeugt von scripts/buildDemoSeed.ts aus src/data/ – nicht von Hand ändern.
import type { DemoSeedLead } from './demoTypes.js';

export const DEMO_SEED: DemoSeedLead[] = [
  {
    "key": "n01",
    "owner": "nick",
    "stage": "replied",
    "person": {
      "firstName": "Tobias",
      "lastName": "Brehm",
      "headline": "Geschäftsführer · Lindqvist & Brehm Anlageimmobilien GmbH",
      "position": "Geschäftsführer",
      "location": "Hamburg",
      "providerId": "ACoAAtqQ1U4x8BPqF5j9Uf9CFX8uLTfI6WjuR",
      "publicIdentifier": "tobias-brehm-n01",
      "profileUrl": "https://www.linkedin.com/in/tobias-brehm-n01",
      "networkDistance": 1
    },
    "company": {
      "name": "Lindqvist & Brehm Anlageimmobilien GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Hamburg"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Eigener Vertrieb von Kapitalanlage-Immobilien mit aktiven Lead-Kampagnen – Kernzielgruppe.",
      "summary": "Vertreibt Denkmal- und Neubau-Kapitalanlagen an Gutverdiener in Norddeutschland, Team mit rund 12 Beratern. Schaltet seit mehreren Wochen Meta-Kampagnen mit Lead-Formularen."
    },
    "template": "G1",
    "followUpsSent": 0,
    "nextStep": "Termin Do. 10:00 Uhr bestätigen",
    "events": [
      {
        "kind": "created",
        "offsetMs": -450960000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 5 aktive Anzeigen in der Meta-Werbebibliothek",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -450840000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Eigener Vertrieb von Kapitalanlage-Immobilien mit aktiven Lead-Kampagnen – Kernzielgruppe.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -361800000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -183000000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -109680000,
        "by": "nick",
        "title": "Erstnachricht · Vorlage G1 gesendet",
        "text": "Hallo Tobias,\n\ndanke fürs Vernetzen! Mir ist aufgefallen, dass Lindqvist & Brehm Anlageimmobilien GmbH gerade Meta Ads schaltet. Wir bringen Kapitalanlage-Vertrieben und Bauträgern planbar vorqualifizierte Käuferanfragen – geprüft, bevor sie bei eurem Vertrieb landen.\n\nWie zufrieden seid ihr aktuell mit der Qualität eurer Anfragen?\n\nViele Grüße\nNick",
        "label": "G1"
      },
      {
        "kind": "message_received",
        "offsetMs": -11640000,
        "by": null,
        "title": "Antwort von Tobias erhalten",
        "text": "Hallo Nick, danke für die Nachricht – Timing passt. Unsere Meta-Kampagnen bringen zwar Masse, aber die Hälfte der Leute ist nie erreichbar. Lass uns gern sprechen. Passt dir Donnerstag um 10 Uhr?",
        "label": null
      }
    ]
  },
  {
    "key": "n02",
    "owner": "nick",
    "stage": "replied",
    "person": {
      "firstName": "Claudia",
      "lastName": "Wernicke",
      "headline": "Vertriebsleiterin · Weidenhof Projektentwicklung GmbH",
      "position": "Vertriebsleiterin",
      "location": "Leipzig",
      "providerId": "ACoAAidQBs3H3OQz8AdvGSLrL80RPcWlwpMPI",
      "publicIdentifier": "claudia-wernicke-n02",
      "profileUrl": "https://www.linkedin.com/in/claudia-wernicke-n02",
      "networkDistance": 1
    },
    "company": {
      "name": "Weidenhof Projektentwicklung GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Leipzig"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit eigenem Vertrieb und laufender Projektvermarktung über Meta.",
      "summary": "Projektentwickler für Wohnquartiere im Raum Leipzig/Halle mit Eigenvertrieb. Aktuell ist ein Neubauprojekt mit 36 Wohneinheiten in der Vermarktung, beworben über Meta und Immobilienportale."
    },
    "template": "G2",
    "followUpsSent": 1,
    "nextStep": "Case Study Bauträger senden, Telefonat anbieten",
    "events": [
      {
        "kind": "created",
        "offsetMs": -715320000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 2 aktive Anzeigen · Neubauprojekt mit 36 WE",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -715200000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit eigenem Vertrieb und laufender Projektvermarktung über Meta.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -628860000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -451080000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -377940000,
        "by": "nick",
        "title": "Erstnachricht · Vorlage G2 gesendet",
        "text": "Hi Claudia,\n\nfreut mich, dass wir jetzt vernetzt sind. Ich habe gesehen, dass bei Weidenhof Projektentwicklung GmbH gerade Kampagnen auf Meta laufen. Für Immobilienvertriebe senken wir die Kosten pro qualifizierter Anfrage meist deutlich – ohne mehr Budget.\n\nWäre ein kurzer Austausch spannend, wie das bei euch aussehen könnte?\n\nViele Grüße\nNick",
        "label": "G2"
      },
      {
        "kind": "message_sent",
        "offsetMs": -118080000,
        "by": "nick",
        "title": "Follow-up 1 · Variante F1A gesendet",
        "text": "Hallo Claudia, kurz nachgehakt – sind planbare Käuferanfragen über Meta bei euch gerade ein Thema? Ein kurzes Ja oder Nein reicht mir völlig.\n\nViele Grüße\nNick",
        "label": "F1A"
      },
      {
        "kind": "message_received",
        "offsetMs": -22860000,
        "by": null,
        "title": "Antwort von Claudia erhalten",
        "text": "Hi Nick, sorry für die späte Rückmeldung. Wir gehen ab Januar mit zwei neuen Projekten in den Vertrieb. Kannst du mir vorab ein paar Zahlen zu euren Ergebnissen bei Bauträgern schicken? Dann können wir gern telefonieren.",
        "label": null
      }
    ]
  },
  {
    "key": "n03",
    "owner": "nick",
    "stage": "replied",
    "person": {
      "firstName": "Ralf",
      "lastName": "Ostermann",
      "headline": "Inhaber & Geschäftsführer · Rotdorn Kapitalanlagen GmbH",
      "position": "Inhaber & Geschäftsführer",
      "location": "Bielefeld",
      "providerId": "ACoAAu5pnCm6XRXA3rZgGk5XoFTp3eDcwQjEA",
      "publicIdentifier": "ralf-ostermann-n03",
      "profileUrl": "https://www.linkedin.com/in/ralf-ostermann-n03",
      "networkDistance": 1
    },
    "company": {
      "name": "Rotdorn Kapitalanlagen GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Bielefeld"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit dauerhaft laufenden Meta-Kampagnen.",
      "summary": "Kapitalanlage-Vertrieb mit Schwerpunkt auf Bestandsimmobilien in NRW und rund 8 Vertriebspartnern. Wirbt seit Monaten konstant auf Meta, der Inhaber postet regelmäßig zu Steuerthemen."
    },
    "template": "G1",
    "followUpsSent": 2,
    "nextStep": "Wiedervorlage in 6 Monaten",
    "events": [
      {
        "kind": "created",
        "offsetMs": -1032540000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 4 aktive Anzeigen in der Meta-Werbebibliothek",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -1032420000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit dauerhaft laufenden Meta-Kampagnen.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -946140000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -771300000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -697620000,
        "by": "nick",
        "title": "Erstnachricht · Vorlage G1 gesendet",
        "text": "Hallo Ralf,\n\ndanke fürs Vernetzen! Mir ist aufgefallen, dass Rotdorn Kapitalanlagen GmbH gerade Meta Ads schaltet. Wir bringen Kapitalanlage-Vertrieben und Bauträgern planbar vorqualifizierte Käuferanfragen – geprüft, bevor sie bei eurem Vertrieb landen.\n\nWie zufrieden seid ihr aktuell mit der Qualität eurer Anfragen?\n\nViele Grüße\nNick",
        "label": "G1"
      },
      {
        "kind": "message_sent",
        "offsetMs": -434880000,
        "by": "nick",
        "title": "Follow-up 1 · Variante F1B gesendet",
        "text": "Hi Ralf, ich weiß, das Postfach ist voll. Falls es passt: Ich schicke dir gern ein kurzes Beispiel, wie wir das für einen ähnlichen Vertrieb wie Rotdorn Kapitalanlagen GmbH umgesetzt haben.\n\nViele Grüße\nNick",
        "label": "F1B"
      },
      {
        "kind": "message_sent",
        "offsetMs": -168720000,
        "by": "nick",
        "title": "Follow-up 2 · Variante F2A gesendet",
        "text": "Hallo Ralf, ein Kunde aus dem Immobilienvertrieb hatte vor drei Monaten eine ähnliche Ausgangslage wie Rotdorn Kapitalanlagen GmbH – heute kommen dort jede Woche 15+ qualifizierte Termine rein. Soll ich dir zeigen, wie?\n\nViele Grüße\nNick",
        "label": "F2A"
      },
      {
        "kind": "message_received",
        "offsetMs": -73200000,
        "by": null,
        "title": "Antwort von Ralf erhalten",
        "text": "Hallo Nick, danke, aber kein Bedarf. Wir arbeiten seit Jahren mit einer festen Agentur und sind zufrieden.",
        "label": null
      }
    ]
  },
  {
    "key": "n04",
    "owner": "nick",
    "stage": "contacted",
    "person": {
      "firstName": "Jana",
      "lastName": "Wiechert",
      "headline": "Head of Sales · Hansekontor Anlagewerte GmbH",
      "position": "Head of Sales",
      "location": "Lübeck",
      "providerId": "ACoAAgBD4PzfTJ5dxYPuWSAs7tlgmemJm9Djs",
      "publicIdentifier": "jana-wiechert-n04",
      "profileUrl": "https://www.linkedin.com/in/jana-wiechert-n04",
      "networkDistance": 1
    },
    "company": {
      "name": "Hansekontor Anlagewerte GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Lübeck"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit akutem Recruiting-Bedarf im Vertrieb.",
      "summary": "Vertrieb von Kapitalanlage-Wohnungen an Angestellte und Selbstständige, das Team ist im Aufbau. Sucht seit über sechs Wochen Vertriebsmitarbeiter, eigene Recruiting-Kampagnen sind nicht erkennbar."
    },
    "template": "R1",
    "followUpsSent": 1,
    "nextStep": "Termin Di./Mi. nächste Woche anbieten",
    "events": [
      {
        "kind": "created",
        "offsetMs": -703800000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Vertriebsmitarbeiter (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -703680000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit akutem Recruiting-Bedarf im Vertrieb.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -611460000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -433320000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -360060000,
        "by": "nick",
        "title": "Erstnachricht · Vorlage R1 gesendet",
        "text": "Hallo Jana,\n\ndanke fürs Annehmen! Ich habe gesehen, dass ihr bei Hansekontor Anlagewerte GmbH gerade eine Stelle als Vertriebsmitarbeiter (m/w/d) ausgeschrieben habt. Wir gewinnen für Immobilienvertriebe über Paid Social passende Vertriebler – auch solche, die gar nicht aktiv auf Jobsuche sind.\n\nDarf ich dir kurz zeigen, wie das bei ähnlichen Unternehmen funktioniert hat?\n\nViele Grüße\nNick",
        "label": "R1"
      },
      {
        "kind": "message_sent",
        "offsetMs": -100800000,
        "by": "nick",
        "title": "Follow-up 1 · Variante F1A gesendet",
        "text": "Hallo Jana, kurz nachgehakt – sind neue Vertriebler über Paid Social bei euch gerade ein Thema? Ein kurzes Ja oder Nein reicht mir völlig.\n\nViele Grüße\nNick",
        "label": "F1A"
      }
    ]
  },
  {
    "key": "n05",
    "owner": "nick",
    "stage": "contacted",
    "person": {
      "firstName": "Stefan",
      "lastName": "Kaltwasser",
      "headline": "Geschäftsführer · Kaltwasser Kapitalpartner GmbH",
      "position": "Geschäftsführer",
      "location": "Düsseldorf",
      "providerId": "ACoAAlHwtBxGXGIgJV1XL2HbFYoxjeedWWcGt",
      "publicIdentifier": "stefan-kaltwasser-n05",
      "profileUrl": "https://www.linkedin.com/in/stefan-kaltwasser-n05",
      "networkDistance": 1
    },
    "company": {
      "name": "Kaltwasser Kapitalpartner GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Düsseldorf"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit Lead-Formular-Kampagnen auf Meta.",
      "summary": "Familiengeführter Kapitalanlage-Vertrieb mit Fokus auf Neubau-Apartments und rund 20 Beratern. Schaltet Meta-Anzeigen mit Lead-Formularen und baut laut Stellenportalen das Vertriebsteam aus."
    },
    "template": "G1",
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -514440000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 3 aktive Anzeigen · Lead-Formular",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -514320000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit Lead-Formular-Kampagnen auf Meta.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -426720000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -251040000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -178440000,
        "by": "nick",
        "title": "Erstnachricht · Vorlage G1 gesendet",
        "text": "Hallo Stefan,\n\ndanke fürs Vernetzen! Mir ist aufgefallen, dass Kaltwasser Kapitalpartner GmbH gerade Meta Ads schaltet. Wir bringen Kapitalanlage-Vertrieben und Bauträgern planbar vorqualifizierte Käuferanfragen – geprüft, bevor sie bei eurem Vertrieb landen.\n\nWie zufrieden seid ihr aktuell mit der Qualität eurer Anfragen?\n\nViele Grüße\nNick",
        "label": "G1"
      }
    ]
  },
  {
    "key": "n06",
    "owner": "nick",
    "stage": "contacted",
    "person": {
      "firstName": "Melanie",
      "lastName": "Hoffrath",
      "headline": "Leiterin Vertrieb · Quartierwerk Süd GmbH",
      "position": "Leiterin Vertrieb",
      "location": "Stuttgart",
      "providerId": "ACoAACSm6l0KJQuwYt60GPX81HGuxBmLAPGNG",
      "publicIdentifier": "melanie-hoffrath-n06",
      "profileUrl": "https://www.linkedin.com/in/melanie-hoffrath-n06",
      "networkDistance": 1
    },
    "company": {
      "name": "Quartierwerk Süd GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Stuttgart"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit drei Projekten in der Vermarktung und eigenem Vertriebsteam.",
      "summary": "Bauträger für Mehrfamilienhäuser im Großraum Stuttgart mit drei Projekten in der Vermarktung. Bewirbt Projekte über Meta mit Video-Anzeigen, der Vertrieb läuft teils inhouse, teils über Makler."
    },
    "template": "G2",
    "followUpsSent": 1,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -864420000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 2 aktive Anzeigen · Projekt-Landingpage",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -864300000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit drei Projekten in der Vermarktung und eigenem Vertriebsteam.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -771600000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -598380000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -525600000,
        "by": "nick",
        "title": "Erstnachricht · Vorlage G2 gesendet",
        "text": "Hi Melanie,\n\nfreut mich, dass wir jetzt vernetzt sind. Ich habe gesehen, dass bei Quartierwerk Süd GmbH gerade Kampagnen auf Meta laufen. Für Immobilienvertriebe senken wir die Kosten pro qualifizierter Anfrage meist deutlich – ohne mehr Budget.\n\nWäre ein kurzer Austausch spannend, wie das bei euch aussehen könnte?\n\nViele Grüße\nNick",
        "label": "G2"
      },
      {
        "kind": "message_sent",
        "offsetMs": -264540000,
        "by": "nick",
        "title": "Follow-up 1 · Variante F1B gesendet",
        "text": "Hallo Melanie, nur kurz nach oben geholt: Hättest du diese oder nächste Woche 15 Minuten für einen Austausch zu planbare Käuferanfragen über Meta?\n\nViele Grüße\nNick",
        "label": "F1B"
      }
    ]
  },
  {
    "key": "n07",
    "owner": "nick",
    "stage": "contacted",
    "person": {
      "firstName": "Dirk",
      "lastName": "Sanders",
      "headline": "Geschäftsführer · Mainquadrat Vertriebs GmbH",
      "position": "Geschäftsführer",
      "location": "Frankfurt am Main",
      "providerId": "ACoAAE0gCmTlRsIDArHsuB0O7f0y5mJeWGlzy",
      "publicIdentifier": "dirk-sanders-n07",
      "profileUrl": "https://www.linkedin.com/in/dirk-sanders-n07",
      "networkDistance": 1
    },
    "company": {
      "name": "Mainquadrat Vertriebs GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Frankfurt am Main"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit dauerhaft offener Vertriebsstelle.",
      "summary": "Strukturvertrieb für Kapitalanlage-Immobilien im Rhein-Main-Gebiet. Hat seit acht Wochen eine Vertriebsstelle ausgeschrieben, Bewertungsportale deuten auf hohe Fluktuation im Team hin."
    },
    "template": "R1",
    "followUpsSent": 2,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -1052580000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Vertriebsmitarbeiter (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -1052460000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit dauerhaft offener Vertriebsstelle.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -961620000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -782700000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -709020000,
        "by": "nick",
        "title": "Erstnachricht · Vorlage R1 gesendet",
        "text": "Hallo Dirk,\n\ndanke fürs Annehmen! Ich habe gesehen, dass ihr bei Mainquadrat Vertriebs GmbH gerade eine Stelle als Vertriebsmitarbeiter (m/w/d) ausgeschrieben habt. Wir gewinnen für Immobilienvertriebe über Paid Social passende Vertriebler – auch solche, die gar nicht aktiv auf Jobsuche sind.\n\nDarf ich dir kurz zeigen, wie das bei ähnlichen Unternehmen funktioniert hat?\n\nViele Grüße\nNick",
        "label": "R1"
      },
      {
        "kind": "message_sent",
        "offsetMs": -446880000,
        "by": "nick",
        "title": "Follow-up 1 · Variante F1A gesendet",
        "text": "Hallo Dirk, kurz nachgehakt – sind neue Vertriebler über Paid Social bei euch gerade ein Thema? Ein kurzes Ja oder Nein reicht mir völlig.\n\nViele Grüße\nNick",
        "label": "F1A"
      },
      {
        "kind": "message_sent",
        "offsetMs": -180960000,
        "by": "nick",
        "title": "Follow-up 2 · Variante F2B gesendet",
        "text": "Hi Dirk, kurze Frage: Woran hakt es bei euch aktuell eher – an der Menge der Anfragen oder an deren Qualität? Je nachdem hätte ich einen konkreten Vorschlag.\n\nViele Grüße\nNick",
        "label": "F2B"
      }
    ]
  },
  {
    "key": "n08",
    "owner": "nick",
    "stage": "connected",
    "person": {
      "firstName": "Patrick",
      "lastName": "Neuhaus",
      "headline": "Geschäftsführer · Feldberg Capital Sales GmbH",
      "position": "Geschäftsführer",
      "location": "Freiburg",
      "providerId": "ACoAA1RROp8zutBWyjk8UAPSUxIBlWa99Riwt",
      "publicIdentifier": "patrick-neuhaus-n08",
      "profileUrl": "https://www.linkedin.com/in/patrick-neuhaus-n08",
      "networkDistance": 1
    },
    "company": {
      "name": "Feldberg Capital Sales GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Freiburg"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit hoher Werbeaktivität und Webinar-Funnel.",
      "summary": "Kapitalanlage-Vertrieb mit Webinar-Funnel für Ärzte und Akademiker, Fokus auf Steuerersparnis. Kleines Team mit 5 Beratern, aber sehr hohe Werbeaktivität."
    },
    "template": null,
    "metaAds": {
      "state": "stopped",
      "advertiser": "Feldberg Capital Sales GmbH",
      "ads": 4,
      "activeAds": 0,
      "lastStop": "2026-06-03",
      "foreignAds": 0,
      "libraryUrl": null,
      "note": null
    },
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -354180000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 6 aktive Anzeigen · Webinar-Funnel",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -354060000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit hoher Werbeaktivität und Webinar-Funnel.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -266760000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -90420000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      }
    ]
  },
  {
    "key": "n09",
    "owner": "nick",
    "stage": "connected",
    "person": {
      "firstName": "Katrin",
      "lastName": "Albers",
      "headline": "Prokuristin · Lerchenfeld Bauträger GmbH",
      "position": "Prokuristin",
      "location": "Münster",
      "providerId": "ACoAAm2HMzEkrcD0cIJS12lSUiZZDrEY8aBiA",
      "publicIdentifier": "katrin-albers-n09",
      "profileUrl": "https://www.linkedin.com/in/katrin-albers-n09",
      "networkDistance": 1
    },
    "company": {
      "name": "Lerchenfeld Bauträger GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Münster"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Regionaler Bauträger mit aktueller Projektkampagne auf Meta.",
      "summary": "Regionaler Bauträger für Reihen- und Doppelhäuser im Münsterland. Bewirbt ein aktuelles Projekt mit 24 Einheiten über Meta, der Vertrieb liegt bei einem internen Team aus drei Personen."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -353280000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 2 aktive Anzeigen · Reihenhaus-Projekt",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -353160000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Regionaler Bauträger mit aktueller Projektkampagne auf Meta.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -264600000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -91560000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      }
    ]
  },
  {
    "key": "n10",
    "owner": "nick",
    "stage": "connected",
    "person": {
      "firstName": "Jonas",
      "lastName": "Vogt",
      "headline": "Gründer & Geschäftsführer · Isarblick Investment Vertrieb GmbH",
      "position": "Gründer & Geschäftsführer",
      "location": "München",
      "providerId": "ACoAA0cJ6AZrNqtiMz5QvwRyuvaPgH79JrjFV",
      "publicIdentifier": "jonas-vogt-n10",
      "profileUrl": "https://www.linkedin.com/in/jonas-vogt-n10",
      "networkDistance": 1
    },
    "company": {
      "name": "Isarblick Investment Vertrieb GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "München"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Wachsender Kapitalanlage-Vertrieb mit mehreren offenen Vertriebsstellen.",
      "summary": "Junger Kapitalanlage-Vertrieb aus München, 2021 gegründet und schnell gewachsen. Sucht aktuell mehrere Vertriebsmitarbeiter und postet Recruiting-Inhalte, bisher ohne bezahlte Kampagnen."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -354360000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Vertriebsmitarbeiter (m/w/d) Kapitalanlageimmobilien – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -354240000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Wachsender Kapitalanlage-Vertrieb mit mehreren offenen Vertriebsstellen.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -265560000,
        "by": "nick",
        "title": "Vernetzungsanfrage gesendet von Nick",
        "text": "Über den LinkedIn-Account von Nick",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -91920000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      }
    ]
  },
  {
    "key": "n11",
    "owner": "nick",
    "stage": "new",
    "person": {
      "firstName": "Henrik",
      "lastName": "Saalfeld",
      "headline": "Geschäftsführer · Elbstein Vermögenshaus GmbH",
      "position": "Geschäftsführer",
      "location": "Hamburg",
      "providerId": "ACoAAvBZBPVBvLJd7Bg9bF4c6RAIpE8DHBp8i",
      "publicIdentifier": "henrik-saalfeld-n11",
      "profileUrl": "https://www.linkedin.com/in/henrik-saalfeld-n11",
      "networkDistance": 2
    },
    "company": {
      "name": "Elbstein Vermögenshaus GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Hamburg"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit frisch gestarteten Meta-Kampagnen – hoher Bedarf an Lead-Qualität wahrscheinlich.",
      "summary": "Vertreibt Kapitalanlage-Immobilien in Hamburg und Schleswig-Holstein an vermögende Privatkunden. Seit drei Wochen mit vier Meta-Anzeigen aktiv, die auf eine Beratungs-Landingpage führen."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -18420000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 4 aktive Anzeigen · seit 3 Wochen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -18300000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit frisch gestarteten Meta-Kampagnen – hoher Bedarf an Lead-Qualität wahrscheinlich.",
        "label": null
      }
    ]
  },
  {
    "key": "n12",
    "owner": "nick",
    "stage": "new",
    "person": {
      "firstName": "Nadine",
      "lastName": "Brückner",
      "headline": "Geschäftsführende Gesellschafterin · Brückner & Söhne Wohnbau GmbH",
      "position": "Geschäftsführende Gesellschafterin",
      "location": "Dresden",
      "providerId": "ACoAAspQMWn708YjmUA4yeOCl05UxWCcPtuXf",
      "publicIdentifier": "nadine-brueckner-n12",
      "profileUrl": "https://www.linkedin.com/in/nadine-brueckner-n12",
      "networkDistance": 2
    },
    "company": {
      "name": "Brückner & Söhne Wohnbau GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Dresden"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit Eigenvertrieb und offener Vertriebsstelle – passt für Recruiting.",
      "summary": "Bauträger in zweiter Generation mit Neubauprojekten in Dresden und Umgebung. Sucht einen Immobilienberater für den Eigenvertrieb, Online-Marketing ist bisher kaum sichtbar."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -16560000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Immobilienberater Neubau (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -16440000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit Eigenvertrieb und offener Vertriebsstelle – passt für Recruiting.",
        "label": null
      }
    ]
  },
  {
    "key": "n13",
    "owner": "nick",
    "stage": "new",
    "person": {
      "firstName": "Uwe",
      "lastName": "Bartsch",
      "headline": "Inhaber · Immobilien Bartsch",
      "position": "Inhaber",
      "location": "Kassel",
      "providerId": "ACoAAoale4kirfnIcsIg4j3J3fAuP3lHkr6Co",
      "publicIdentifier": "uwe-bartsch-n13",
      "profileUrl": "https://www.linkedin.com/in/uwe-bartsch-n13",
      "networkDistance": 2
    },
    "company": {
      "name": "Immobilien Bartsch",
      "website": null,
      "industry": "Immobilienmakler",
      "region": "Kassel"
    },
    "assessment": {
      "category": "makler",
      "confidence": 0.9,
      "reason": "Klassischer Bestandsmakler – die Anzeigen dienen der Eigentümer-Akquise, nicht dem Vertrieb von Kapitalanlagen.",
      "summary": "Inhabergeführtes Maklerbüro mit Fokus auf Bestandsimmobilien in Kassel. Die aktive Meta-Anzeige wirbt um Verkäufer („Was ist Ihre Immobilie wert?“), ein eigenes Kapitalanlage-Produkt ist nicht erkennbar."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -14820000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 1 aktive Anzeige · Eigentümer-Akquise",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -14700000,
        "by": null,
        "title": "KI-Einschätzung: Vermutlich unpassend (Makler)",
        "text": "Klassischer Bestandsmakler – die Anzeigen dienen der Eigentümer-Akquise, nicht dem Vertrieb von Kapitalanlagen.",
        "label": null
      }
    ]
  },
  {
    "key": "n14",
    "owner": "nick",
    "stage": "new",
    "person": {
      "firstName": "Svenja",
      "lastName": "Lohmann",
      "headline": "Geschäftsführerin · Hausverwaltung Petersen & Lohmann GmbH",
      "position": "Geschäftsführerin",
      "location": "Bremen",
      "providerId": "ACoAAVsJ2iyuRpGDBozoc7epHjl7RCGcdrPpl",
      "publicIdentifier": "svenja-lohmann-n14",
      "profileUrl": "https://www.linkedin.com/in/svenja-lohmann-n14",
      "networkDistance": 2
    },
    "company": {
      "name": "Hausverwaltung Petersen & Lohmann GmbH",
      "website": null,
      "industry": "Hausverwaltung",
      "region": "Bremen"
    },
    "assessment": {
      "category": "hausverwaltung",
      "confidence": 0.9,
      "reason": "Hausverwaltung ohne Vertrieb – die offene Stelle ist keine Vertriebsposition.",
      "summary": "Hausverwaltung für rund 1.400 Einheiten (WEG- und Mietverwaltung) in Bremen. Die offene Stelle betrifft die Objektbetreuung, ein Neubau- oder Vertriebsgeschäft ist nicht erkennbar."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -17400000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Objektbetreuer (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -17280000,
        "by": null,
        "title": "KI-Einschätzung: Vermutlich unpassend (Hausverwaltung)",
        "text": "Hausverwaltung ohne Vertrieb – die offene Stelle ist keine Vertriebsposition.",
        "label": null
      }
    ]
  },
  {
    "key": "n15",
    "owner": "nick",
    "stage": "new",
    "person": {
      "firstName": "Matthias",
      "lastName": "Kern",
      "headline": "Vertriebsdirektor · Vierlinden Immobilienvertrieb GmbH",
      "position": "Vertriebsdirektor",
      "location": "Berlin",
      "providerId": "ACoAAmw4AhyM4aWTJvZ0tMxzT150S3XtODAnt",
      "publicIdentifier": "matthias-kern-n15",
      "profileUrl": "https://www.linkedin.com/in/matthias-kern-n15",
      "networkDistance": 2
    },
    "company": {
      "name": "Vierlinden Immobilienvertrieb GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Berlin"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Etablierter Kapitalanlage-Vertrieb mit Recruiting-Bedarf.",
      "summary": "Berliner Vertrieb für Kapitalanlage-Wohnungen mit rund 25 Beratern. Sucht seit vier Wochen Verstärkung im Vertrieb und wirbt zusätzlich mit Google Ads für Erstberatungen."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -17700000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Vertriebsmitarbeiter (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -17580000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Etablierter Kapitalanlage-Vertrieb mit Recruiting-Bedarf.",
        "label": null
      }
    ]
  },
  {
    "key": "j01",
    "owner": "johannes",
    "stage": "replied",
    "person": {
      "firstName": "Florian",
      "lastName": "Steinhage",
      "headline": "Geschäftsführer · Steinhage Bauprojekte GmbH",
      "position": "Geschäftsführer",
      "location": "Nürnberg",
      "providerId": "ACoAAipOmrmtCAbTFPehWZWzynio9jsSD6DWB",
      "publicIdentifier": "florian-steinhage-j01",
      "profileUrl": "https://www.linkedin.com/in/florian-steinhage-j01",
      "networkDistance": 1
    },
    "company": {
      "name": "Steinhage Bauprojekte GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Nürnberg"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit großem Projekt in der Vermarktung und neuer Meta-Kampagne.",
      "summary": "Bauträger aus Nürnberg mit Projekten in Franken, aktuell 48 Einheiten in Fürth im Vertrieb. Schaltet seit Kurzem Meta-Anzeigen mit Projektvideo und hat ein eigenes Vertriebsteam mit vier Personen."
    },
    "template": "G2",
    "followUpsSent": 0,
    "nextStep": "Termin Mi./Fr. vormittags bestätigen",
    "events": [
      {
        "kind": "created",
        "offsetMs": -441840000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 3 aktive Anzeigen · Neubau mit 48 WE",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -441720000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit großem Projekt in der Vermarktung und neuer Meta-Kampagne.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -352200000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -177960000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -104640000,
        "by": "johannes",
        "title": "Erstnachricht · Vorlage G2 gesendet",
        "text": "Hi Florian,\n\nfreut mich, dass wir jetzt vernetzt sind. Ich habe gesehen, dass bei Steinhage Bauprojekte GmbH gerade Kampagnen auf Meta laufen. Für Immobilienvertriebe senken wir die Kosten pro qualifizierter Anfrage meist deutlich – ohne mehr Budget.\n\nWäre ein kurzer Austausch spannend, wie das bei euch aussehen könnte?\n\nBeste Grüße\nJohannes",
        "label": "G2"
      },
      {
        "kind": "message_received",
        "offsetMs": -9480000,
        "by": null,
        "title": "Antwort von Florian erhalten",
        "text": "Hallo Johannes, interessant. Wir vermarkten gerade 48 Einheiten in Fürth und der Abverkauf stockt seit dem Sommer. Hast du Mittwoch oder Freitag Vormittag 20 Minuten?",
        "label": null
      }
    ]
  },
  {
    "key": "j02",
    "owner": "johannes",
    "stage": "replied",
    "person": {
      "firstName": "Anja",
      "lastName": "Reimers",
      "headline": "Leiterin Vertrieb · Sonnwend Invest GmbH",
      "position": "Leiterin Vertrieb",
      "location": "Köln",
      "providerId": "ACoAAPugDQ7qtLJYy3FVOKU6Rf1FsrsmSv8AE",
      "publicIdentifier": "anja-reimers-j02",
      "profileUrl": "https://www.linkedin.com/in/anja-reimers-j02",
      "networkDistance": 1
    },
    "company": {
      "name": "Sonnwend Invest GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Köln"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit Rechner-Funnels auf Meta.",
      "summary": "Kapitalanlage-Vertrieb aus Köln mit Fokus auf Pflegeimmobilien und Neubau. Wirbt auf Meta mit Rechner-Funnels zur Steuerersparnis und hat rund 15 Berater im Außendienst."
    },
    "template": "G1",
    "followUpsSent": 2,
    "nextStep": "Wiedervorlage Januar",
    "events": [
      {
        "kind": "created",
        "offsetMs": -1055640000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 7 aktive Anzeigen · Steuer-Rechner",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -1055520000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit Rechner-Funnels auf Meta.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -962220000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -788880000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -715140000,
        "by": "johannes",
        "title": "Erstnachricht · Vorlage G1 gesendet",
        "text": "Hallo Anja,\n\ndanke fürs Vernetzen! Mir ist aufgefallen, dass Sonnwend Invest GmbH gerade Meta Ads schaltet. Wir bringen Kapitalanlage-Vertrieben und Bauträgern planbar vorqualifizierte Käuferanfragen – geprüft, bevor sie bei eurem Vertrieb landen.\n\nWie zufrieden seid ihr aktuell mit der Qualität eurer Anfragen?\n\nBeste Grüße\nJohannes",
        "label": "G1"
      },
      {
        "kind": "message_sent",
        "offsetMs": -451620000,
        "by": "johannes",
        "title": "Follow-up 1 · Variante F1A gesendet",
        "text": "Hallo Anja, kurz nachgehakt – sind planbare Käuferanfragen über Meta bei euch gerade ein Thema? Ein kurzes Ja oder Nein reicht mir völlig.\n\nBeste Grüße\nJohannes",
        "label": "F1A"
      },
      {
        "kind": "message_sent",
        "offsetMs": -191520000,
        "by": "johannes",
        "title": "Follow-up 2 · Variante F2B gesendet",
        "text": "Hallo Anja, ich habe eine kurze Case Study zu planbare Käuferanfragen über Meta vorbereitet (2 Minuten Lesezeit). Darf ich sie dir hier schicken?\n\nBeste Grüße\nJohannes",
        "label": "F2B"
      },
      {
        "kind": "message_received",
        "offsetMs": -95100000,
        "by": null,
        "title": "Antwort von Anja erhalten",
        "text": "Danke für die Hartnäckigkeit 😉 Aktuell ist das Budget für dieses Jahr verplant. Melde dich gern im Januar nochmal.",
        "label": null
      }
    ]
  },
  {
    "key": "j03",
    "owner": "johannes",
    "stage": "replied",
    "person": {
      "firstName": "Thomas",
      "lastName": "Wiegand",
      "headline": "Geschäftsführer · Grünhaus Projekt GmbH",
      "position": "Geschäftsführer",
      "location": "Augsburg",
      "providerId": "ACoAAAaiRhcuIyhoQro0gcaRcsfGHr6yHRlz5",
      "publicIdentifier": "thomas-wiegand-j03",
      "profileUrl": "https://www.linkedin.com/in/thomas-wiegand-j03",
      "networkDistance": 1
    },
    "company": {
      "name": "Grünhaus Projekt GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Augsburg"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit seit Monaten offener Vertriebsstelle.",
      "summary": "Bauträger für Holz-Hybrid-Wohnbauten in Schwaben. Sucht seit über drei Monaten Vertriebsmitarbeiter für den Neubau, Social-Media-Aktivität ist kaum vorhanden."
    },
    "template": "R1",
    "followUpsSent": 0,
    "nextStep": "Ablauf kurz erklären, Erstgespräch vorschlagen",
    "events": [
      {
        "kind": "created",
        "offsetMs": -467880000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Vertriebsmitarbeiter Neubau (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -467760000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit seit Monaten offener Vertriebsstelle.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -378840000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -205920000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -132960000,
        "by": "johannes",
        "title": "Erstnachricht · Vorlage R1 gesendet",
        "text": "Hallo Thomas,\n\ndanke fürs Annehmen! Ich habe gesehen, dass ihr bei Grünhaus Projekt GmbH gerade eine Stelle als Vertriebsmitarbeiter Neubau (m/w/d) ausgeschrieben habt. Wir gewinnen für Immobilienvertriebe über Paid Social passende Vertriebler – auch solche, die gar nicht aktiv auf Jobsuche sind.\n\nDarf ich dir kurz zeigen, wie das bei ähnlichen Unternehmen funktioniert hat?\n\nBeste Grüße\nJohannes",
        "label": "R1"
      },
      {
        "kind": "message_received",
        "offsetMs": -33360000,
        "by": null,
        "title": "Antwort von Thomas erhalten",
        "text": "Hi Johannes, wir suchen tatsächlich seit Monaten Verstärkung im Vertrieb. Wie läuft das bei euch genau ab und mit welchen Kosten müssten wir rechnen?",
        "label": null
      }
    ]
  },
  {
    "key": "j04",
    "owner": "johannes",
    "stage": "contacted",
    "person": {
      "firstName": "Sabine",
      "lastName": "Krüger",
      "headline": "Geschäftsführerin · Altmühl Wohnkonzepte GmbH",
      "position": "Geschäftsführerin",
      "location": "Ingolstadt",
      "providerId": "ACoAAz97EcPXEDrwDSL1h5D6h7G4ojOMoevDb",
      "publicIdentifier": "sabine-krueger-j04",
      "profileUrl": "https://www.linkedin.com/in/sabine-krueger-j04",
      "networkDistance": 1
    },
    "company": {
      "name": "Altmühl Wohnkonzepte GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Ingolstadt"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit Lead-Formular-Kampagnen, Vertrieb durch die Geschäftsführung.",
      "summary": "Bauträger aus Ingolstadt mit Fokus auf Stadthäuser und kleine Mehrfamilienhäuser. Bewirbt Projekte über Meta mit Lead-Formular, den Vertrieb übernimmt bisher die Geschäftsführung selbst."
    },
    "template": "G2",
    "followUpsSent": 1,
    "nextStep": "Telefonat Do. Nachmittag fixieren",
    "events": [
      {
        "kind": "created",
        "offsetMs": -699120000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 2 aktive Anzeigen · Lead-Formular",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -699000000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit Lead-Formular-Kampagnen, Vertrieb durch die Geschäftsführung.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -611820000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -435960000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -362460000,
        "by": "johannes",
        "title": "Erstnachricht · Vorlage G2 gesendet",
        "text": "Hi Sabine,\n\nfreut mich, dass wir jetzt vernetzt sind. Ich habe gesehen, dass bei Altmühl Wohnkonzepte GmbH gerade Kampagnen auf Meta laufen. Für Immobilienvertriebe senken wir die Kosten pro qualifizierter Anfrage meist deutlich – ohne mehr Budget.\n\nWäre ein kurzer Austausch spannend, wie das bei euch aussehen könnte?\n\nBeste Grüße\nJohannes",
        "label": "G2"
      },
      {
        "kind": "message_sent",
        "offsetMs": -100680000,
        "by": "johannes",
        "title": "Follow-up 1 · Variante F1B gesendet",
        "text": "Hi Sabine, ich weiß, das Postfach ist voll. Falls es passt: Ich schicke dir gern ein kurzes Beispiel, wie wir das für einen ähnlichen Vertrieb wie Altmühl Wohnkonzepte GmbH umgesetzt haben.\n\nBeste Grüße\nJohannes",
        "label": "F1B"
      }
    ]
  },
  {
    "key": "j05",
    "owner": "johannes",
    "stage": "contacted",
    "person": {
      "firstName": "Kai",
      "lastName": "Brandes",
      "headline": "Geschäftsführer · Westpark Anlagekontor GmbH",
      "position": "Geschäftsführer",
      "location": "Essen",
      "providerId": "ACoAAeezjPPaYPeye0TStY3yPGMWea1dOKJ6T",
      "publicIdentifier": "kai-brandes-j05",
      "profileUrl": "https://www.linkedin.com/in/kai-brandes-j05",
      "networkDistance": 1
    },
    "company": {
      "name": "Westpark Anlagekontor GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Essen"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit laufenden Meta-Kampagnen.",
      "summary": "Kapitalanlage-Vertrieb aus dem Ruhrgebiet mit Fokus auf Bestandswohnungen und rund 12 Beratern. Schaltet Meta-Anzeigen mit einem Gutschein für die Erstberatung."
    },
    "template": "G1",
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -524760000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 3 aktive Anzeigen · Erstberatungs-Gutschein",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -524640000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit laufenden Meta-Kampagnen.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -431280000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -252480000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -177480000,
        "by": "johannes",
        "title": "Erstnachricht · Vorlage G1 gesendet",
        "text": "Hallo Kai,\n\ndanke fürs Vernetzen! Mir ist aufgefallen, dass Westpark Anlagekontor GmbH gerade Meta Ads schaltet. Wir bringen Kapitalanlage-Vertrieben und Bauträgern planbar vorqualifizierte Käuferanfragen – geprüft, bevor sie bei eurem Vertrieb landen.\n\nWie zufrieden seid ihr aktuell mit der Qualität eurer Anfragen?\n\nBeste Grüße\nJohannes",
        "label": "G1"
      }
    ]
  },
  {
    "key": "j06",
    "owner": "johannes",
    "stage": "contacted",
    "person": {
      "firstName": "Laura",
      "lastName": "Engel",
      "headline": "Head of Sales · Auenwald Projektbau GmbH",
      "position": "Head of Sales",
      "location": "Potsdam",
      "providerId": "ACoAAVV3QHTaQjdllKaLVmzfGQuBa6wjc4MX2",
      "publicIdentifier": "laura-engel-j06",
      "profileUrl": "https://www.linkedin.com/in/laura-engel-j06",
      "networkDistance": 1
    },
    "company": {
      "name": "Auenwald Projektbau GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Potsdam"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Projektentwickler mit zwei Projekten in der Vermarktung und Vertriebsteam.",
      "summary": "Projektentwickler für Eigentumswohnungen in Potsdam und Berlin-Südwest mit zwei Projekten in der Vermarktung. Anzeigen laufen auf Meta und Immobilienportalen, das Vertriebsteam hat 6 Personen."
    },
    "template": "G2",
    "followUpsSent": 1,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -777420000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 4 aktive Anzeigen · 2 Projekte",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -777300000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Projektentwickler mit zwei Projekten in der Vermarktung und Vertriebsteam.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -689160000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -511860000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -438480000,
        "by": "johannes",
        "title": "Erstnachricht · Vorlage G2 gesendet",
        "text": "Hi Laura,\n\nfreut mich, dass wir jetzt vernetzt sind. Ich habe gesehen, dass bei Auenwald Projektbau GmbH gerade Kampagnen auf Meta laufen. Für Immobilienvertriebe senken wir die Kosten pro qualifizierter Anfrage meist deutlich – ohne mehr Budget.\n\nWäre ein kurzer Austausch spannend, wie das bei euch aussehen könnte?\n\nBeste Grüße\nJohannes",
        "label": "G2"
      },
      {
        "kind": "message_sent",
        "offsetMs": -174660000,
        "by": "johannes",
        "title": "Follow-up 1 · Variante F1A gesendet",
        "text": "Hallo Laura, kurz nachgehakt – sind planbare Käuferanfragen über Meta bei euch gerade ein Thema? Ein kurzes Ja oder Nein reicht mir völlig.\n\nBeste Grüße\nJohannes",
        "label": "F1A"
      }
    ]
  },
  {
    "key": "j07",
    "owner": "johannes",
    "stage": "contacted",
    "person": {
      "firstName": "Christian",
      "lastName": "Möller",
      "headline": "Vertriebsleiter · Kronsberg Invest Vertrieb GmbH",
      "position": "Vertriebsleiter",
      "location": "Hannover",
      "providerId": "ACoAA0HxHMXoG0bkQ0GogQ2F2lsUyQWCf7cU2",
      "publicIdentifier": "christian-moeller-j07",
      "profileUrl": "https://www.linkedin.com/in/christian-moeller-j07",
      "networkDistance": 1
    },
    "company": {
      "name": "Kronsberg Invest Vertrieb GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Hannover"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Großer Kapitalanlage-Vertrieb mit dauerhaftem Recruiting-Bedarf.",
      "summary": "Kapitalanlage-Vertrieb aus Hannover mit rund 30 Beratern. Sucht kontinuierlich neue Vertriebsmitarbeiter und schaltet Stellenanzeigen auf mehreren Portalen."
    },
    "template": "R1",
    "followUpsSent": 2,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -1212540000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Vertriebsmitarbeiter (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -1212420000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Großer Kapitalanlage-Vertrieb mit dauerhaftem Recruiting-Bedarf.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -1123740000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -945060000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      },
      {
        "kind": "message_sent",
        "offsetMs": -873060000,
        "by": "johannes",
        "title": "Erstnachricht · Vorlage R1 gesendet",
        "text": "Hallo Christian,\n\ndanke fürs Annehmen! Ich habe gesehen, dass ihr bei Kronsberg Invest Vertrieb GmbH gerade eine Stelle als Vertriebsmitarbeiter (m/w/d) ausgeschrieben habt. Wir gewinnen für Immobilienvertriebe über Paid Social passende Vertriebler – auch solche, die gar nicht aktiv auf Jobsuche sind.\n\nDarf ich dir kurz zeigen, wie das bei ähnlichen Unternehmen funktioniert hat?\n\nBeste Grüße\nJohannes",
        "label": "R1"
      },
      {
        "kind": "message_sent",
        "offsetMs": -612240000,
        "by": "johannes",
        "title": "Follow-up 1 · Variante F1B gesendet",
        "text": "Hallo Christian, nur kurz nach oben geholt: Hättest du diese oder nächste Woche 15 Minuten für einen Austausch zu neue Vertriebler über Paid Social?\n\nBeste Grüße\nJohannes",
        "label": "F1B"
      },
      {
        "kind": "message_sent",
        "offsetMs": -348000000,
        "by": "johannes",
        "title": "Follow-up 2 · Variante F2B gesendet",
        "text": "Hi Christian, kurze Frage: Woran hakt es bei euch aktuell eher – an der Menge der Anfragen oder an deren Qualität? Je nachdem hätte ich einen konkreten Vorschlag.\n\nBeste Grüße\nJohannes",
        "label": "F2B"
      }
    ]
  },
  {
    "key": "j08",
    "owner": "johannes",
    "stage": "connected",
    "person": {
      "firstName": "Benedikt",
      "lastName": "Haas",
      "headline": "Geschäftsführer · Haas & Partner Anlageimmobilien GmbH",
      "position": "Geschäftsführer",
      "location": "Regensburg",
      "providerId": "ACoAAc8OhFPfnobwgExxvgxda0NR1heoOEqyQ",
      "publicIdentifier": "benedikt-haas-j08",
      "profileUrl": "https://www.linkedin.com/in/benedikt-haas-j08",
      "networkDistance": 1
    },
    "company": {
      "name": "Haas & Partner Anlageimmobilien GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Regensburg"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb, seit zwei Monaten mit Meta-Anzeigen aktiv.",
      "summary": "Kapitalanlage-Vertrieb aus Regensburg für Neubau-Apartments in Bayern. Seit zwei Monaten mit Meta-Anzeigen aktiv, der Geschäftsführer ist selbst im Vertrieb eines 7-köpfigen Teams."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -353460000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 3 aktive Anzeigen · seit 2 Monaten",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -353340000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb, seit zwei Monaten mit Meta-Anzeigen aktiv.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -265920000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -90660000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      }
    ]
  },
  {
    "key": "j09",
    "owner": "johannes",
    "stage": "connected",
    "person": {
      "firstName": "Miriam",
      "lastName": "Schott",
      "headline": "Geschäftsführerin · Zehntscheuer Wohnbau GmbH",
      "position": "Geschäftsführerin",
      "location": "Heilbronn",
      "providerId": "ACoAAKdvwEFPReGBCjqEVSTFC0eoR6Xadfp3t",
      "publicIdentifier": "miriam-schott-j09",
      "profileUrl": "https://www.linkedin.com/in/miriam-schott-j09",
      "networkDistance": 1
    },
    "company": {
      "name": "Zehntscheuer Wohnbau GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Heilbronn"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit aktiver Projektkampagne, Vertrieb durch die Geschäftsführung.",
      "summary": "Bauträger aus Heilbronn mit Reihenhaus- und Wohnungsprojekten. Wirbt aktuell für ein Projekt mit 18 Einheiten auf Meta, der Vertrieb läuft über die Geschäftsführung und eine Assistenz."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -356520000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 2 aktive Anzeigen · Projekt mit 18 WE",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -356400000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit aktiver Projektkampagne, Vertrieb durch die Geschäftsführung.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -265920000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -91680000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      }
    ]
  },
  {
    "key": "j10",
    "owner": "johannes",
    "stage": "connected",
    "person": {
      "firstName": "Sebastian",
      "lastName": "Krause",
      "headline": "Vertriebsleiter · Rheinbogen Kapitalanlagen GmbH",
      "position": "Vertriebsleiter",
      "location": "Mainz",
      "providerId": "ACoAAUyYsvD0UHyPOo8SOczJTySO7247Rtrvk",
      "publicIdentifier": "sebastian-krause-j10",
      "profileUrl": "https://www.linkedin.com/in/sebastian-krause-j10",
      "networkDistance": 1
    },
    "company": {
      "name": "Rheinbogen Kapitalanlagen GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Mainz"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit zwei offenen Vertriebsstellen.",
      "summary": "Kapitalanlage-Vertrieb aus Mainz mit Fokus auf Denkmalimmobilien. Sucht aktuell zwei Vertriebsmitarbeiter und gibt auf LinkedIn regelmäßig Einblicke ins Team."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -356160000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Vertriebsmitarbeiter (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -356040000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit zwei offenen Vertriebsstellen.",
        "label": null
      },
      {
        "kind": "invite_sent",
        "offsetMs": -269520000,
        "by": "johannes",
        "title": "Vernetzungsanfrage gesendet von Johannes",
        "text": "Über den LinkedIn-Account von Johannes",
        "label": null
      },
      {
        "kind": "invite_accepted",
        "offsetMs": -90360000,
        "by": null,
        "title": "Vernetzungsanfrage angenommen",
        "text": null,
        "label": null
      }
    ]
  },
  {
    "key": "j11",
    "owner": "johannes",
    "stage": "new",
    "person": {
      "firstName": "Philipp",
      "lastName": "Ahrens",
      "headline": "Geschäftsführer · Ahrens Wohnkonzept Projektentwicklung GmbH",
      "position": "Geschäftsführer",
      "location": "Kiel",
      "providerId": "ACoAAw7FCJwGM5yZBAb6WCTneRX4uDDk63zcF",
      "publicIdentifier": "philipp-ahrens-j11",
      "profileUrl": "https://www.linkedin.com/in/philipp-ahrens-j11",
      "networkDistance": 2
    },
    "company": {
      "name": "Ahrens Wohnkonzept Projektentwicklung GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Kiel"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit Eigenvertrieb und neuer Meta-Kampagne für ein aktuelles Projekt.",
      "summary": "Projektentwickler aus Kiel mit Fokus auf Wohnungen an der Ostseeküste. Hat vor zehn Tagen Meta-Kampagnen für ein neues Projekt gestartet, der Vertrieb erfolgt inhouse mit drei Personen."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -15540000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 2 aktive Anzeigen · seit 10 Tagen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -15420000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit Eigenvertrieb und neuer Meta-Kampagne für ein aktuelles Projekt.",
        "label": null
      }
    ]
  },
  {
    "key": "j12",
    "owner": "johannes",
    "stage": "new",
    "person": {
      "firstName": "Carina",
      "lastName": "Dietz",
      "headline": "Leiterin Vertrieb · Talwerk Capital GmbH",
      "position": "Leiterin Vertrieb",
      "location": "Wiesbaden",
      "providerId": "ACoAA66eWvslR1vomfKn7XP06Z0G9khqcxEa2",
      "publicIdentifier": "carina-dietz-j12",
      "profileUrl": "https://www.linkedin.com/in/carina-dietz-j12",
      "networkDistance": 2
    },
    "company": {
      "name": "Talwerk Capital GmbH",
      "website": null,
      "industry": "Kapitalanlage-Vertrieb",
      "region": "Wiesbaden"
    },
    "assessment": {
      "category": "kapitalanlage_vertrieb",
      "confidence": 0.9,
      "reason": "Kapitalanlage-Vertrieb mit dauerhaftem Meta-Budget – klassisches Profil.",
      "summary": "Kapitalanlage-Vertrieb aus Wiesbaden für vermögende Privatkunden mit rund 18 Mitarbeitenden. Schaltet seit mehreren Monaten Meta-Anzeigen mit Video-Testimonials."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -18720000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 5 aktive Anzeigen · Video-Testimonials",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -18600000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Kapitalanlage-Vertrieb)",
        "text": "Kapitalanlage-Vertrieb mit dauerhaftem Meta-Budget – klassisches Profil.",
        "label": null
      }
    ]
  },
  {
    "key": "j13",
    "owner": "johannes",
    "stage": "new",
    "person": {
      "firstName": "Oliver",
      "lastName": "Brandt",
      "headline": "Geschäftsführer · WEG-Service Brandt GmbH",
      "position": "Geschäftsführer",
      "location": "Bochum",
      "providerId": "ACoAAyKj7CgE4hawAlRSKwosg34u8qCTVjxAp",
      "publicIdentifier": "oliver-brandt-j13",
      "profileUrl": "https://www.linkedin.com/in/oliver-brandt-j13",
      "networkDistance": 2
    },
    "company": {
      "name": "WEG-Service Brandt GmbH",
      "website": null,
      "industry": "Hausverwaltung",
      "region": "Bochum"
    },
    "assessment": {
      "category": "hausverwaltung",
      "confidence": 0.9,
      "reason": "Reine Hausverwaltung – gesucht wird Verwaltungspersonal, kein Vertrieb.",
      "summary": "WEG- und Mietverwaltung mit rund 900 Einheiten im Ruhrgebiet. Sucht einen Immobilienkaufmann für die Verwaltung, ein Vertrieb von Immobilien ist nicht erkennbar."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -18300000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Immobilienkaufmann (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -18180000,
        "by": null,
        "title": "KI-Einschätzung: Vermutlich unpassend (Hausverwaltung)",
        "text": "Reine Hausverwaltung – gesucht wird Verwaltungspersonal, kein Vertrieb.",
        "label": null
      }
    ]
  },
  {
    "key": "j14",
    "owner": "johannes",
    "stage": "new",
    "person": {
      "firstName": "Marco",
      "lastName": "Wendisch",
      "headline": "Inhaber · Maklerkontor Wendisch",
      "position": "Inhaber",
      "location": "Erfurt",
      "providerId": "ACoAAxUhfgJsLF4pCNQfdLEWIPOfxhPyo0jwN",
      "publicIdentifier": "marco-wendisch-j14",
      "profileUrl": "https://www.linkedin.com/in/marco-wendisch-j14",
      "networkDistance": 2
    },
    "company": {
      "name": "Maklerkontor Wendisch",
      "website": null,
      "industry": "Immobilienmakler",
      "region": "Erfurt"
    },
    "assessment": {
      "category": "makler",
      "confidence": 0.9,
      "reason": "Makler mit Eigentümer-Akquise – vermittelt Kapitalanlagen nur gelegentlich für Dritte.",
      "summary": "Maklerbüro aus Erfurt für Wohn- und Gewerbeimmobilien. Die Meta-Anzeigen werben um Eigentümer für Bewertungen, Kapitalanlagen anderer Anbieter werden nur vereinzelt vermittelt."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -16680000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Meta Ads aktiv – 2 aktive Anzeigen · Immobilienbewertung",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -16560000,
        "by": null,
        "title": "KI-Einschätzung: Vermutlich unpassend (Makler)",
        "text": "Makler mit Eigentümer-Akquise – vermittelt Kapitalanlagen nur gelegentlich für Dritte.",
        "label": null
      }
    ]
  },
  {
    "key": "j15",
    "owner": "johannes",
    "stage": "new",
    "person": {
      "firstName": "Lena",
      "lastName": "Hartwig",
      "headline": "Geschäftsführerin · Hartwig Baukontor GmbH",
      "position": "Geschäftsführerin",
      "location": "Rostock",
      "providerId": "ACoAAABrjIvGWGezsCD3LLCCqwFN0Jx7kcmUn",
      "publicIdentifier": "lena-hartwig-j15",
      "profileUrl": "https://www.linkedin.com/in/lena-hartwig-j15",
      "networkDistance": 2
    },
    "company": {
      "name": "Hartwig Baukontor GmbH",
      "website": null,
      "industry": "Bauträger / Projektentwicklung",
      "region": "Rostock"
    },
    "assessment": {
      "category": "bautraeger_projektentwickler",
      "confidence": 0.9,
      "reason": "Bauträger mit offener Vertriebsstelle für den Neubau.",
      "summary": "Bauträger aus Rostock mit Doppelhaus- und Wohnungsprojekten. Sucht einen Vertriebsmitarbeiter für den Neubau, Werbekampagnen sind bisher nicht erkennbar."
    },
    "template": null,
    "followUpsSent": 0,
    "nextStep": null,
    "events": [
      {
        "kind": "created",
        "offsetMs": -16740000,
        "by": null,
        "title": "Lead gefunden",
        "text": "Signal: Sucht: Vertriebsmitarbeiter Neubau (m/w/d) – Offene Stelle auf LinkedIn und Jobportalen",
        "label": null
      },
      {
        "kind": "assessed",
        "offsetMs": -16620000,
        "by": null,
        "title": "KI-Einschätzung: Passt (Bauträger)",
        "text": "Bauträger mit offener Vertriebsstelle für den Neubau.",
        "label": null
      }
    ]
  }
];
