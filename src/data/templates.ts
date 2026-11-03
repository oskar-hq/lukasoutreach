/**
 * Alte Demo-Texte (A/B/C) für den Verlauf der Demo-Leads. Die echten Vorlagen kommen aus `GET /api/templates`
 * (Standardtexte: `server/src/messages/defaults.ts`, bearbeitbar unter Einstellungen → Vorlagen).
 *
 * Platzhalter:
 *   {{vorname}}     Vorname des Leads
 *   {{firma}}       Firmenname
 *   {{stelle}}      ausgeschriebene Stelle (nur Recruiting-Signal)
 *   {{thema}}       Kurzbeschreibung des Angebots passend zum Signal
 *   {{grussformel}} Grußformel des eingeloggten Gründers
 *
 * Nur noch Quelle des Demo-Seeds im Backend (`server/scripts/buildDemoSeed.ts` → `server/src/leads/demoSeed.ts`).
 * Die App selbst liest sie nicht – sie arbeitet mit `/api/*`. Nach einer Änderung den Seed neu erzeugen.
 */

import type { TemplateId } from '../state/types';

export interface FirstMessageTemplate {
  id: TemplateId;
  name: string;
  description: string;
  signal: 'meta_ads' | 'hiring';
  text: string;
}

export const FIRST_MESSAGE_TEMPLATES: Record<TemplateId, FirstMessageTemplate> = {
  A: {
    id: 'A',
    name: 'Template A',
    description: 'Meta Ads · Fokus Anfragequalität',
    signal: 'meta_ads',
    text: `Hallo {{vorname}},

danke fürs Vernetzen! Mir ist aufgefallen, dass {{firma}} gerade Meta Ads schaltet. Wir bringen Kapitalanlage-Vertrieben und Bauträgern planbar vorqualifizierte Käuferanfragen – geprüft, bevor sie bei eurem Vertrieb landen.

Wie zufrieden seid ihr aktuell mit der Qualität eurer Anfragen?

{{grussformel}}`,
  },
  B: {
    id: 'B',
    name: 'Template B',
    description: 'Meta Ads · Fokus Kosten pro Anfrage',
    signal: 'meta_ads',
    text: `Hi {{vorname}},

freut mich, dass wir jetzt vernetzt sind. Ich habe gesehen, dass bei {{firma}} gerade Kampagnen auf Meta laufen. Für Immobilienvertriebe senken wir die Kosten pro qualifizierter Anfrage meist deutlich – ohne mehr Budget.

Wäre ein kurzer Austausch spannend, wie das bei euch aussehen könnte?

{{grussformel}}`,
  },
  C: {
    id: 'C',
    name: 'Template C',
    description: 'Recruiting · offene Vertriebsstelle',
    signal: 'hiring',
    text: `Hallo {{vorname}},

danke fürs Annehmen! Ich habe gesehen, dass ihr bei {{firma}} gerade eine Stelle als {{stelle}} ausgeschrieben habt. Wir gewinnen für Immobilienvertriebe über Paid Social passende Vertriebler – auch solche, die gar nicht aktiv auf Jobsuche sind.

Darf ich dir kurz zeigen, wie das bei ähnlichen Unternehmen funktioniert hat?

{{grussformel}}`,
  },
};

/** {{thema}} je nach Signal. */
export const TOPIC_BY_SIGNAL = {
  meta_ads: 'planbare Käuferanfragen über Meta',
  hiring: 'neue Vertriebler über Paid Social',
  search: 'planbare Käuferanfragen über Paid Social',
} as const;

export type FollowUpTemplateVariant = 'A' | 'B' | 'C';

export interface FollowUpTemplate {
  variant: FollowUpTemplateVariant;
  name: string;
  text: string;
}

/** Follow-up-Texte je Stufe (1 = Erinnerung, 2 = Mehrwert, 3 = Abschluss). */
export const FOLLOW_UP_TEMPLATES: Record<1 | 2 | 3, Record<FollowUpTemplateVariant, FollowUpTemplate>> = {
  1: {
    A: {
      variant: 'A',
      name: 'Kurz nachgehakt',
      text: `Hallo {{vorname}}, kurz nachgehakt – sind {{thema}} bei euch gerade ein Thema? Ein kurzes Ja oder Nein reicht mir völlig.

{{grussformel}}`,
    },
    B: {
      variant: 'B',
      name: 'Beispiel anbieten',
      text: `Hi {{vorname}}, ich weiß, das Postfach ist voll. Falls es passt: Ich schicke dir gern ein kurzes Beispiel, wie wir das für einen ähnlichen Vertrieb wie {{firma}} umgesetzt haben.

{{grussformel}}`,
    },
    C: {
      variant: 'C',
      name: 'Direkte Terminfrage',
      text: `Hallo {{vorname}}, nur kurz nach oben geholt: Hättest du diese oder nächste Woche 15 Minuten für einen Austausch zu {{thema}}?

{{grussformel}}`,
    },
  },
  2: {
    A: {
      variant: 'A',
      name: 'Kundenergebnis',
      text: `Hallo {{vorname}}, ein Kunde aus dem Immobilienvertrieb hatte vor drei Monaten eine ähnliche Ausgangslage wie {{firma}} – heute kommen dort jede Woche 15+ qualifizierte Termine rein. Soll ich dir zeigen, wie?

{{grussformel}}`,
    },
    B: {
      variant: 'B',
      name: 'Engpass-Frage',
      text: `Hi {{vorname}}, kurze Frage: Woran hakt es bei euch aktuell eher – an der Menge der Anfragen oder an deren Qualität? Je nachdem hätte ich einen konkreten Vorschlag.

{{grussformel}}`,
    },
    C: {
      variant: 'C',
      name: 'Case Study',
      text: `Hallo {{vorname}}, ich habe eine kurze Case Study zu {{thema}} vorbereitet (2 Minuten Lesezeit). Darf ich sie dir hier schicken?

{{grussformel}}`,
    },
  },
  3: {
    A: {
      variant: 'A',
      name: 'Freundlicher Abschluss',
      text: `Hallo {{vorname}}, ich möchte nicht nerven – das ist meine letzte Nachricht dazu. Falls {{thema}} später relevant werden, meld dich jederzeit gern.

{{grussformel}}`,
    },
    B: {
      variant: 'B',
      name: 'Später melden?',
      text: `Hi {{vorname}}, ich nehme an, das Timing passt gerade nicht. Soll ich mich in ein paar Monaten nochmal melden oder lieber gar nicht? Beides völlig okay.

{{grussformel}}`,
    },
    C: {
      variant: 'C',
      name: 'Daumen hoch',
      text: `Hallo {{vorname}}, letzter Versuch, versprochen. Wenn du magst, schick mir einfach ein 👍 und ich sende dir zwei Terminvorschläge.

{{grussformel}}`,
    },
  },
};

export const MAX_FOLLOW_UPS = 3;
