import type { SettingKey, SettingsTestService } from '../../../shared/settings';

/** Ein Dienst im Einrichtungs-Assistenten: was er tut, wo man den Schlüssel findet, welche Einstellungen er setzt. */
export interface SetupService {
  id: SettingsTestService;
  name: string;
  tag: 'Pflicht' | 'Empfohlen' | 'Optional';
  title: string;
  why: string;
  minutes: string;
  steps: string[];
  link: { href: string; label: string };
  fields: { key: SettingKey; label: string; placeholder: string; secret: boolean }[];
  note?: string;
}

/** Reihenfolge = Reihenfolge im Assistenten. Nur LinkedIn (Unipile) ist Pflicht. */
export const SETUP_SERVICES: SetupService[] = [
  {
    id: 'unipile',
    name: 'LinkedIn',
    tag: 'Pflicht',
    title: 'LinkedIn über Unipile verbinden',
    why: 'Unipile ist die Brücke zu LinkedIn. Darüber sucht das Cockpit Leads – mit zufälligen Pausen zwischen den Profilen und Abbruch, sobald LinkedIn ein Limit meldet.',
    minutes: 'ca. 3 Minuten',
    steps: [
      'Leg ein Konto bei Unipile an und öffne das Dashboard.',
      'Verbinde dort deinen LinkedIn-Account.',
      'Erzeuge unter „Access Tokens“ ein neues Token. Die DSN steht oben im Dashboard.',
    ],
    link: { href: 'https://dashboard.unipile.com', label: 'Unipile-Dashboard öffnen' },
    fields: [
      { key: 'UNIPILE_DSN', label: 'DSN', placeholder: 'api1.unipile.com:13111', secret: false },
      { key: 'UNIPILE_API_KEY', label: 'Access Token', placeholder: 'Token einfügen', secret: true },
    ],
  },
  {
    id: 'anthropic',
    name: 'KI (Claude)',
    tag: 'Empfohlen',
    title: 'Die KI bewertet deine Leads',
    why: 'Claude liest jedes Profil und entscheidet mit Begründung, ob der Lead zu deiner Zielgruppe passt. Außerdem schlägt Claude Nachrichten vor. Ohne Schlüssel werden Leads gefunden, aber nicht bewertet.',
    minutes: 'ca. 2 Minuten',
    steps: [
      'Melde dich in der Anthropic Console an.',
      'Lade unter „Billing“ etwas Guthaben auf und setz am besten gleich ein Ausgabenlimit.',
      'Erzeuge unter „API Keys“ einen neuen Schlüssel.',
    ],
    link: { href: 'https://console.anthropic.com', label: 'Anthropic Console öffnen' },
    fields: [{ key: 'ANTHROPIC_API_KEY', label: 'API-Schlüssel', placeholder: 'sk-ant-…', secret: true }],
  },
  {
    id: 'treg',
    name: 'Firmendaten',
    tag: 'Optional',
    title: 'Firmendaten mit Treg',
    why: 'Treg ergänzt jede Firma um Mitarbeiterzahl, Umsatz, Tech-Stack und Social-Links. Das macht den Lead-Score genauer.',
    minutes: 'ca. 1 Minute',
    steps: ['Melde dich auf treg.to an und lade Guthaben auf.', 'Kopiere im Dashboard dein API-Token.'],
    link: { href: 'https://treg.to', label: 'Treg öffnen' },
    fields: [{ key: 'TREG_TOKEN', label: 'Token', placeholder: 'Token einfügen', secret: true }],
    note: 'Der Preis je Abruf ist gedeckelt – ändern kannst du das später unter Einstellungen.',
  },
  {
    id: 'meta',
    name: 'Meta-Ads',
    tag: 'Optional',
    title: 'Meta-Werbebibliothek prüfen',
    why: 'Wer gerade Meta-Ads schaltet, hat oft schon eine Agentur. Das Cockpit prüft das in der öffentlichen Werbebibliothek und markiert solche Leads.',
    minutes: 'ca. 5 Minuten',
    steps: [
      'Bestätige bei Meta deine Identität für die Ad Library API.',
      'Leg unter developers.facebook.com eine App an.',
      'Erzeuge im Graph API Explorer ein Access Token für diese App.',
    ],
    link: { href: 'https://www.facebook.com/ads/library/api', label: 'Ad Library API öffnen' },
    fields: [{ key: 'META_ACCESS_TOKEN', label: 'Access Token', placeholder: 'EAAG…', secret: true }],
    note: 'Die Identitätsprüfung bei Meta kann ein, zwei Tage dauern. Überspring den Schritt ruhig und hol ihn unter Einstellungen nach.',
  },
  {
    id: 'close',
    name: 'Close (CRM)',
    tag: 'Optional',
    title: 'Heiße Leads an Close übergeben',
    why: 'Zeigt ein Lead Interesse, landet er mit Verlauf und Firmendaten in Close. Ohne Schlüssel wird er nur im Cockpit als übergeben markiert.',
    minutes: 'ca. 1 Minute',
    steps: ['Öffne in Close „Settings → Developer“.', 'Leg unter „API Keys“ einen neuen Schlüssel an und kopiere ihn.'],
    link: { href: 'https://app.close.com/settings/developer/api-keys/', label: 'Close-Einstellungen öffnen' },
    fields: [{ key: 'CLOSE_API_KEY', label: 'API-Schlüssel', placeholder: 'api_…', secret: true }],
  },
  {
    id: 'slack',
    name: 'Slack',
    tag: 'Optional',
    title: 'Slack meldet neue Antworten',
    why: 'Antwortet ein Lead, bekommt dein Kanal eine kurze Nachricht. So reagierst du schnell, auch wenn das Cockpit gerade zu ist.',
    minutes: 'ca. 2 Minuten',
    steps: ['Erstelle unter api.slack.com/apps eine neue App.', 'Schalte „Incoming Webhooks“ ein und wähle den Kanal.', 'Kopiere die Webhook-Adresse.'],
    link: { href: 'https://api.slack.com/apps', label: 'Slack-Apps öffnen' },
    fields: [{ key: 'SLACK_WEBHOOK_URL', label: 'Webhook-Adresse', placeholder: 'https://hooks.slack.com/services/…', secret: true }],
  },
];
