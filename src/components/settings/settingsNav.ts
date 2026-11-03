import { SETTINGS, type SettingGroup, type SettingKey, type SettingValue } from '../../../shared/settings';

/**
 * Einstellungen wie eine Einstellungs-App (Wunsch des Nutzers 23.10., Aufbau nach dem „Clean Finance“-DESIGN.md):
 * Die erste Ebene zeigt **alle** Bereiche auf einmal – unter drei kleinen Überschriften, je Zeile ein Symbol im
 * schwarzen Kreis, Name, ein paar Wörter, Pfeil. Ein Klick → Bereich (Liste der Unterseiten) → Unterseite mit wenigen
 * Werten. Früher lag davor noch eine Ebene „Kategorie“ – die suchte man vergeblich. Werte-Bereiche heißen wie ihre
 * `SettingGroup`, dazu die eigenen Seiten „Auf einen Blick“, Automatische Suche, Vorlagen, Software-Update und Verlauf.
 */
export type SettingsSection = 'overview' | SettingGroup | 'auto' | 'templates' | 'update' | 'history';

/** Überschriften auf der ersten Ebene (keine eigene Ebene mehr). */
export type CategoryId = 'connections' | 'outreach' | 'system';

export interface NavItem {
  id: SettingsSection;
  label: string;
  /** Ein paar Wörter unter dem Namen in der Liste – was man dort findet. */
  lead: string;
}

export interface NavGroup {
  id: CategoryId;
  title: string;
  items: NavItem[];
}

export const OVERVIEW_ITEM: NavItem = { id: 'overview', label: 'Auf einen Blick', lead: 'Was noch fehlt' };

export const SETTINGS_NAV: readonly NavGroup[] = [
  {
    id: 'outreach',
    title: 'Outreach',
    items: [
      { id: 'leadSearch', label: 'Lead-Suche', lead: 'Profile pro Lauf, KI-Sicherheit' },
      { id: 'auto', label: 'Automatische Suche', lead: 'Sucht nach Plan selbst' },
      { id: 'linkedin', label: 'Senden über LinkedIn', lead: 'Accounts, Grenzen, Arbeitszeit' },
      { id: 'tasks', label: 'Tagesstapel', lead: 'Leads pro Tag, Follow-ups' },
      { id: 'templates', label: 'Vorlagen', lead: 'Anfragen und Nachrichten' },
    ],
  },
  {
    id: 'connections',
    title: 'Verbindungen',
    items: [
      { id: 'unipile', label: 'LinkedIn (Unipile)', lead: 'Zugang und Such-Account' },
      { id: 'anthropic', label: 'KI-Bewertung', lead: 'Schlüssel und Modell' },
      { id: 'meta', label: 'Meta-Werbebibliothek', lead: 'Läuft gerade Werbung?' },
      { id: 'clay', label: 'Firmendaten', lead: 'Treg oder Clay' },
      { id: 'crm', label: 'Close und Slack', lead: 'Übergabe und Ping bei Antworten' },
    ],
  },
  {
    id: 'system',
    title: 'System',
    items: [
      { id: 'update', label: 'Software-Update', lead: 'Neue Version mit einem Klick' },
      { id: 'backup', label: 'Sicherungen', lead: 'Jede Nacht gesichert' },
      { id: 'server', label: 'Server und Anmeldung', lead: 'Adresse und Anmeldung' },
      { id: 'history', label: 'Verlauf', lead: 'Wer hat was geändert' },
    ],
  },
];

export const NAV_ITEMS: readonly NavItem[] = [OVERVIEW_ITEM, ...SETTINGS_NAV.flatMap((group) => group.items)];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = NAV_ITEMS.map((item) => item.id);

export function navItem(section: SettingsSection): NavItem {
  return NAV_ITEMS.find((item) => item.id === section)!;
}

/** Überschrift, unter der ein Bereich steht – `null` für „Auf einen Blick“. */
export function categoryOf(section: SettingsSection): NavGroup | null {
  return SETTINGS_NAV.find((group) => group.items.some((item) => item.id === section)) ?? null;
}

/** Bereiche, deren Werte aus `shared/settings.ts` kommen (die Seite „Werte“ von früher). */
export function isValueSection(section: SettingsSection): section is 'overview' | SettingGroup | 'history' {
  return section !== 'auto' && section !== 'templates' && section !== 'update';
}

/**
 * Die Werte für automatische Updates gehören im Katalog zur Gruppe `backup`, stehen aber auf der Seite
 * „Software-Update“ – dort sucht man sie. Diese Unterseite fehlt deshalb in der Liste der Sicherungen.
 */
export const UPDATE_PAGE = 'backup.updates';

/** Bereich, in dem eine Unterseite angezeigt wird (fast immer ihre Gruppe). */
export function sectionOfPage(page: SettingsSubpage): SettingsSection {
  return page.id === UPDATE_PAGE ? 'update' : page.group;
}

// ── Einfache Seiten (Wunsch des Nutzers 23.10.) ──
// Muster jeder Einstellungsseite: oben ein großer Knopf für das, was man dort tut (Update, Jetzt sichern, Testen),
// darunter nur Schalter, die man sofort versteht und die sofort gelten. Kein Kleingedrucktes, keine Uhrzeiten.

/** Ein Schalter, der beim Umlegen sofort speichert. */
export interface QuickToggle {
  key: SettingKey;
  label: string;
  isOn: (value: SettingValue | null | undefined) => boolean;
  valueFor: (on: boolean) => SettingValue;
}

export const QUICK_TOGGLES: Partial<Record<SettingsSection, readonly QuickToggle[]>> = {
  update: [{ key: 'UPDATE_AUTO', label: 'Jede Nacht automatisch updaten', isOn: (value) => value === true, valueFor: (on) => on }],
  // Ein: zurück auf 2 Uhr UTC (Standard), aus: „off“ – die Uhrzeit interessiert niemanden.
  backup: [{ key: 'BACKUP_HOUR_UTC', label: 'Jede Nacht sichern', isOn: (value) => value !== 'off', valueFor: (on) => (on ? 2 : 'off') }],
};

/**
 * Kurze Namen für die Werte, die direkt auf einer Seite stehen – der Katalog (`shared/settings.ts`) erklärt mehr, als
 * man beim Hinsehen braucht.
 */
export const SHORT_LABELS: Partial<Record<SettingKey, string>> = {
  MAX_RESULTS: 'Profile pro Suchlauf',
  UNIPILE_DSN: 'Adresse (DSN)',
  UNIPILE_API_KEY: 'Zugangs-Token',
  LINKEDIN_ACTIONS: 'Über LinkedIn senden',
  LINKEDIN_INVITES_PER_DAY: 'Anfragen pro Tag',
  LINKEDIN_WORK_HOURS: 'Arbeitszeit',
  ENRICHMENT_PROVIDER: 'Quelle',
  CRM_HANDOVER: 'Leads an Close übergeben',
  CLOSE_API_KEY: 'Close-Schlüssel',
  SLACK_WEBHOOK_URL: 'Slack-Webhook',
  FOLLOWUP_AFTER_DAYS: 'Follow-up nach Tagen',
  MAX_FOLLOW_UPS: 'Follow-ups höchstens',
};

// ── Unterseiten der Werte-Bereiche ──

/** Eigene Inhalte einer Unterseite neben den Werten. */
export type PageExtra = 'searchAccount' | 'linkedinAccounts' | 'unsentInvites';

export interface SettingsSubpage {
  /** Eindeutig über alle Bereiche: `<group>.<name>`. */
  id: string;
  group: SettingGroup;
  label: string;
  keys: readonly SettingKey[];
  extra?: PageExtra;
  /** Grauer Text unter dem Namen mit Platzhaltern `{KEY}` – sonst die Werte nacheinander. */
  summary?: string;
  /** Die wichtigen Werte: stehen direkt auf der Seite des Bereichs, nicht hinter einer Zeile. */
  inline?: boolean;
}

/**
 * Aufbau jedes Bereichs (Wunsch des Nutzers 23.10.): `main` = die wenigen Werte, die man wirklich braucht – direkt auf
 * der Seite, Schalter gelten sofort. Eigene Bausteine (Accounts, Such-Account) als Zeile. Alles andere landet von
 * selbst auf „Erweitert“.
 */
const PAGE_PLAN: Record<SettingGroup, readonly (Omit<SettingsSubpage, 'group' | 'id'> & { name: string })[]> = {
  leadSearch: [{ name: 'main', label: 'Lead-Suche', inline: true, keys: ['MAX_RESULTS', 'LEAD_DISTRIBUTION'] }],
  unipile: [
    { name: 'main', label: 'Zugang', inline: true, keys: ['UNIPILE_DSN', 'UNIPILE_API_KEY'] },
    { name: 'searchAccount', label: 'Such-Account', keys: ['UNIPILE_ACCOUNT_ID'], extra: 'searchAccount' },
  ],
  linkedin: [
    {
      name: 'main',
      label: 'Senden',
      inline: true,
      keys: ['LINKEDIN_ACTIONS', 'LINKEDIN_ACCOUNT_FALLBACK', 'LINKEDIN_INVITES_PER_DAY', 'LINKEDIN_MESSAGES_PER_DAY', 'LINKEDIN_WORK_HOURS', 'LINKEDIN_WORK_DAYS'],
    },
    { name: 'accounts', label: 'LinkedIn-Accounts', keys: ['UNIPILE_ACCOUNT_NICK', 'UNIPILE_ACCOUNT_JOHANNES', 'UNIPILE_WARMUP_ACCOUNTS', 'UNIPILE_ACCOUNTS_USED'], extra: 'linkedinAccounts' },
    { name: 'unsent', label: 'Nicht gesendete Anfragen', keys: [], extra: 'unsentInvites' },
  ],
  anthropic: [{ name: 'main', label: 'KI-Bewertung', inline: true, keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'] }],
  meta: [{ name: 'main', label: 'Meta', inline: true, keys: ['META_ACCESS_TOKEN'] }],
  clay: [
    {
      name: 'main',
      label: 'Firmendaten',
      inline: true,
      keys: ['ENRICHMENT_PROVIDER', 'TREG_TOKEN', 'CLAY_WEBHOOK_URL', 'CLAY_WEBHOOK_TOKEN', 'CLAY_CALLBACK_SECRET', 'ENRICH_AUTO', 'ENRICH_MAX_PER_DAY'],
    },
  ],
  crm: [{ name: 'main', label: 'Close und Slack', inline: true, keys: ['CRM_HANDOVER', 'CLOSE_API_KEY', 'SLACK_WEBHOOK_URL'] }],
  tasks: [{ name: 'main', label: 'Tagesstapel', inline: true, keys: ['NEW_LEADS_PER_DAY', 'FOLLOWUP_AFTER_DAYS', 'MAX_FOLLOW_UPS', 'INVITE_NOTE'] }],
  // Sicherungen zeigen nur Knopf und Schalter (QUICK_TOGGLES) – die Unterseiten findet nur die Suche.
  backup: [
    { name: 'plan', label: 'Zeitplan', keys: ['BACKUP_HOUR_UTC', 'BACKUP_KEEP', 'BACKUP_MAX_AGE_DAYS'] },
    { name: 'updates', label: 'Automatisch updaten', keys: ['UPDATE_AUTO', 'UPDATE_HOUR'] },
  ],
  server: [{ name: 'main', label: 'Server', inline: true, keys: ['PUBLIC_URL', 'AUTH_COOKIE_SECURE'] }],
};

export const SUBPAGES: readonly SettingsSubpage[] = (Object.keys(PAGE_PLAN) as SettingGroup[]).flatMap((group) => {
  const planned = PAGE_PLAN[group].map(({ name, ...page }) => ({ ...page, id: `${group}.${name}`, group }));
  const known = new Set(planned.flatMap((page) => page.keys));
  const rest = SETTINGS.filter((definition) => definition.group === group && !known.has(definition.key)).map((definition) => definition.key);
  return rest.length ? [...planned, { id: `${group}.more`, group, label: 'Erweitert', keys: rest }] : planned;
});

export function subpagesOf(group: SettingGroup): SettingsSubpage[] {
  return SUBPAGES.filter((page) => page.group === group);
}

export function subpage(id: string): SettingsSubpage | undefined {
  return SUBPAGES.find((page) => page.id === id);
}

/** Unterseite, auf der ein Wert steht. */
export function subpageOf(key: SettingKey): SettingsSubpage {
  return SUBPAGES.find((page) => page.keys.includes(key))!;
}

// ── Suche ──

/** Suchbegriffe der eigenen Seiten, die keine Werte im Katalog haben. */
const EXTRA_WORDS: Partial<Record<SettingsSection, string>> = {
  overview: 'zu erledigen schlüssel limits grenzen',
  auto: 'zeitplan uhrzeit stichwörter positionen region suchprofil automatisch budget',
  templates: 'vorlage text anfrage erstnachricht follow-up nachricht',
  backup: 'sicherung herunterladen wiederherstellen schlüssel geheimnisse',
  update: 'update aktualisieren version neu einspielen automatisch nachts',
  history: 'verlauf geändert änderungen wer wann',
};

const words = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

const SECTION_TEXT = new Map<SettingsSection, string>(NAV_ITEMS.map((item) => [item.id, [item.label, item.lead, EXTRA_WORDS[item.id] ?? ''].join(' ').toLowerCase()]));

const PAGE_TEXT = new Map<string, string>(
  SUBPAGES.map((page) => {
    const fields = page.keys.flatMap((key) => {
      const definition = SETTINGS.find((entry) => entry.key === key)!;
      return [definition.label, definition.help ?? ''];
    });
    return [page.id, [page.label, navItem(page.group).label, ...fields].join(' ').toLowerCase()];
  }),
);

/** Passt der Bereich selbst (Name, Kurztext, Stichwörter) zur Suche? */
export function matchesSearch(section: SettingsSection, query: string): boolean {
  const text = SECTION_TEXT.get(section) ?? '';
  return words(query).every((word) => text.includes(word));
}

/** Unterseiten, deren Name oder Werte (Name, Hilfetext) zur Suche passen – „Zeitzone“ → Arbeitszeit. */
export function searchSubpages(query: string): SettingsSubpage[] {
  const list = words(query);
  if (!list.length) return [];
  return SUBPAGES.filter((page) => list.every((word) => PAGE_TEXT.get(page.id)!.includes(word)));
}
