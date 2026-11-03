/**
 * Vertrag für Nachrichten-Vorlagen und KI-Vorschläge (Roadmap Phase 4) – wird von Frontend (Vite) und Backend (Node)
 * importiert. Nur Typen, Konstanten, kleine reine Funktionen und `import type` aus anderen Vertragsdateien.
 *
 * Grundsatz (Entscheidung 05.10.2026): **Gesendet wird von Hand auf LinkedIn.** Das Cockpit schlägt Texte vor; der
 * Gründer kopiert sie, sendet selbst und meldet die Aktion wie bisher an `POST /api/leads/:id/events`.
 *
 * Zielgruppe (Pain-Point): Firmen, die **keine** Meta-Ads schalten (Greenfield) oder **früher** geschaltet haben und
 * aufgehört haben (Reactivation) – „Wir machen das besser bei euch“. Die alten Vorlagen „… gerade Meta Ads schaltet“
 * sprachen die falsche Gruppe an und sind ersetzt.
 *
 * Routen (alle mit Sitzung):
 *   GET  /api/templates                 → 200 TemplatesResponse (Standard + angepasste Texte)
 *   PUT  /api/templates/:id             UpdateTemplateRequest → 200 MessageTemplate · 400 invalid_template · 404
 *   POST /api/templates/:id/reset       → 200 MessageTemplate (zurück zum Standardtext)
 *   POST   /api/templates               CreateTemplateRequest → 201 MessageTemplate · 400 invalid_template ·
 *                                        409 template_limit (schon 26 in der Kategorie)
 *   DELETE /api/templates/:id           → 200 { ok: true } · 404 not_found · 409 last_template (die letzte einer Kategorie bleibt)
 *     Je Kategorie (`TEMPLATE_CATEGORIES`) gibt es immer mindestens eine Vorlage mit Text und höchstens 26. In der
 *     Oberfläche heißen sie nach ihrer Reihenfolge A bis Z (`templateLetter`), die `id` bleibt stabil.
 *   POST /api/leads/:id/suggest         SuggestRequest → 200 MessageSuggestion · 404 not_found · 429 too_many_requests
 *     kind „first“: Erstnachricht (Vorlage passend zum Lead-Typ), „followup“: nächstes Follow-up
 *     (Stufe = followUpsSent + 1) – beide aus dem Segment des Leads (`templatesForSegment`, seit 27.10.), „reply“: Antwort auf die letzte Nachricht des Leads inkl. Einschätzung.
 *     Live mit ANTHROPIC_API_KEY: von der KI aus Vorlage, Lead-Daten und Verlauf geschrieben (`source: 'ai'`);
 *     ohne Schlüssel bzw. wenn die KI ausfällt: ausgefüllte Vorlage (`source: 'template'`, `notice` sagt warum);
 *     Simulation: feste Beispieltexte ohne Netz (`source: 'mock'`).
 *
 * Platzhalter in Vorlagen: {{vorname}}, {{firma}}, {{thema}}, {{grussformel}}, {{metapause}} (`TEMPLATE_PLACEHOLDERS`).
 * {{metapause}} (11.10.): wie lange die Firma keine Meta-Ads mehr schaltet, z. B. „seit rund 4 Monaten“ (`metaPauseText`).
 * {{metastopp}} (12.10.): wann sie aufgehört hat, z. B. „vor rund 4 Monaten“ (`metaStopText`) – für „… dass ihr
 * {{metastopp}} aufgehört habt, Meta Ads zu schalten“ in den Vorlagen des Kunden.
 * {{stelle}} (13.10.): wen die Firma sucht, z. B. „Verstärkung als Vertriebsmitarbeiter (m/w/d)“ (`hiringRoleText`) – für
 * „… dass ihr gerade {{stelle}} sucht“ in den Recruiting-Vorlagen (Zielgruppe `hiring`, Hiring-Signal `LeadHiring`).
 */
import type { AuthFounderId } from './auth.js';
import type { LeadCategory } from './leadSearch.js';

export type MessageKind = 'first' | 'followup' | 'invite_note';

/**
 * Für wen eine Vorlage gedacht ist (Lead-Typ aus dem Score): greenfield = nie Meta-Ads · reactivation = hat aufgehört ·
 * active = schaltet gerade Meta-Ads (seit 12.10., Wunsch des Nutzers: Meta-Ads sind kein Ausschluss, nur der Aufhänger) ·
 * hiring = sucht gerade Mitarbeiter (seit 13.10.: Recruiting über Social Media; gilt vor dem Lead-Typ, sobald der Lead
 * ein Hiring-Signal hat – die Meta-Ads-Vorlagen bleiben zur Auswahl).
 */
export type TemplateAudience = 'greenfield' | 'reactivation' | 'active' | 'hiring' | 'any';

/**
 * Segment einer Vorlage (Kundengespräch 27.10.: „segmentierte Follow-up-Strecke“ – je eine Version für
 * Kapitalanlage-Vertriebe und Finanzdienstleister). Quer zu Kategorie und Zielgruppe: Eine Erstnachricht „Greenfield“
 * oder ein „Follow-up 2“ gibt es je Segment. Fehlt das Feld bzw. null = für alle Leads.
 * Welches Segment ein Lead hat, folgt aus seiner KI-Kategorie (`templateSegmentOf`): Finanzdienstleister →
 * `finanzdienstleister`, alles andere (auch Bauträger mit Vertrieb und Leads ohne Einstufung) → `kapitalanlage`.
 */
export type TemplateSegment = 'kapitalanlage' | 'finanzdienstleister';

export const TEMPLATE_SEGMENTS: readonly TemplateSegment[] = ['kapitalanlage', 'finanzdienstleister'];

export const TEMPLATE_SEGMENT_LABELS: Record<TemplateSegment, string> = {
  kapitalanlage: 'Kapitalanlage',
  finanzdienstleister: 'Finanzdienstleister',
};

export function templateSegmentOf(category: LeadCategory | null | undefined): TemplateSegment {
  return category === 'finanzdienstleister' ? 'finanzdienstleister' : 'kapitalanlage';
}

/**
 * Vorlagen für ein Segment: die des Segments und die für alle (in der gegebenen Reihenfolge). Passt keine, alle –
 * eine Nachricht gibt es immer. Gleich in Frontend und Backend.
 */
export function templatesForSegment<T extends { segment?: TemplateSegment | null }>(templates: readonly T[], segment: TemplateSegment): T[] {
  const fitting = templates.filter((template) => !template.segment || template.segment === segment);
  return fitting.length ? fitting : [...templates];
}

export const TEMPLATE_PLACEHOLDERS = ['vorname', 'firma', 'thema', 'grussformel', 'metapause', 'metastopp', 'stelle'] as const;

/**
 * {{stelle}}: „Verstärkung als Vertriebsmitarbeiter (m/w/d)“ aus der gesuchten Stelle, ohne Stelle „Verstärkung“.
 * Gleich in Frontend und Backend, damit Vorschau und Vorschlag übereinstimmen.
 */
export function hiringRoleText(role: string | null | undefined): string {
  const clean = role?.replace(/\s+/g, ' ').trim();
  return clean ? `Verstärkung als ${clean}` : 'Verstärkung';
}

/**
 * {{metapause}}: „seit rund 4 Monaten“ aus dem Ende der letzten Anzeige (JJJJ-MM-TT). Ohne Datum „seit einiger Zeit“.
 * Gleich in Frontend und Backend, damit Vorschau und Vorschlag übereinstimmen.
 */
export function metaPauseText(lastStop: string | null | undefined, now = Date.now()): string {
  if (!lastStop || !/^\d{4}-\d{2}-\d{2}/.test(lastStop)) return 'seit einiger Zeit';
  const days = Math.floor((now - Date.parse(`${lastStop.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 'seit einiger Zeit';
  if (days < 14) return 'seit ein paar Tagen';
  if (days < 60) return `seit rund ${Math.round(days / 7)} Wochen`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `seit rund ${months} Monaten`;
  return `seit rund ${Math.round(days / 365.25)} Jahren`;
}
/** {{metastopp}}: „vor rund 4 Monaten“ – gleiche Stufen wie `metaPauseText`. Ohne Datum „vor einiger Zeit“. */
export function metaStopText(lastStop: string | null | undefined, now = Date.now()): string {
  return metaPauseText(lastStop, now).replace(/^seit /, 'vor ');
}

export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

/** Höchstlänge eines Vorlagentexts bzw. Vorschlags. LinkedIn-Notizen zur Vernetzungsanfrage: 300 Zeichen. */
export const TEMPLATE_MAX_LENGTH = 2000;
export const INVITE_NOTE_LIMIT = 300;

/** Grußformel je Gründer (gleich wie im Frontend `src/data/founders.ts`). */
export const FOUNDER_GREETINGS: Record<AuthFounderId, string> = {
  nick: 'Viele Grüße\nNick',
  johannes: 'Beste Grüße\nJohannes',
};

/** Wofür wir stehen – {{thema}} in den Vorlagen. */
export const DEFAULT_TOPIC = 'planbare Käuferanfragen über Facebook und Instagram';

export interface MessageTemplate {
  /** Stabil, z. B. „G1“, „R2“, „F2B“ – steht als `label` im Verlauf (Auswertung je Vorlage im Dashboard). */
  id: string;
  kind: MessageKind;
  /** Nur bei Follow-ups: 1, 2 oder 3. */
  stage: number | null;
  audience: TemplateAudience;
  name: string;
  /** Ein Satz: wann passt die Vorlage. */
  description: string;
  text: string;
  /** false = Text wurde in der Software angepasst. */
  isDefault: boolean;
  /** true = in der Software angelegt (kein Standardtext, kein „Zurücksetzen“). Fehlt bei älteren Servern. */
  custom?: boolean;
  /** Segment (27.10.) – fehlt/null = für alle Leads (`TemplateSegment`). */
  segment?: TemplateSegment | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface TemplatesResponse {
  templates: MessageTemplate[];
}

export interface UpdateTemplateRequest {
  name?: string;
  text: string;
  /** Nur eigene Vorlagen: Segment ändern (null = für alle). Fehlt = bleibt. Bei Standardtexten ohne Wirkung. */
  segment?: TemplateSegment | null;
}

/** Höchstens so viele Vorlagen je Kategorie – A bis Z. */
export const TEMPLATE_MAX_PER_CATEGORY = 26;

/** Kategorie einer Vorlage: wofür und für wen sie gedacht ist. Jede hat mindestens eine Vorlage. */
export type TemplateCategory =
  | 'invite'
  | 'first_greenfield'
  | 'first_reactivation'
  | 'first_active'
  | 'first_hiring'
  | 'followup_1'
  | 'followup_2'
  | 'followup_3';

export interface TemplateCategoryInfo {
  id: TemplateCategory;
  label: string;
  kind: MessageKind;
  stage: number | null;
  audience: TemplateAudience;
}

/** In der Reihenfolge, in der die Nachrichten hinausgehen. */
export const TEMPLATE_CATEGORIES: readonly TemplateCategoryInfo[] = [
  { id: 'invite', label: 'Vernetzungsanfrage', kind: 'invite_note', stage: null, audience: 'any' },
  { id: 'first_greenfield', label: 'Erstnachricht · Greenfield', kind: 'first', stage: null, audience: 'greenfield' },
  { id: 'first_reactivation', label: 'Erstnachricht · Reactivation', kind: 'first', stage: null, audience: 'reactivation' },
  { id: 'first_active', label: 'Erstnachricht · Schaltet Meta-Ads', kind: 'first', stage: null, audience: 'active' },
  { id: 'first_hiring', label: 'Erstnachricht · Sucht Mitarbeiter', kind: 'first', stage: null, audience: 'hiring' },
  { id: 'followup_1', label: 'Follow-up 1', kind: 'followup', stage: 1, audience: 'any' },
  { id: 'followup_2', label: 'Follow-up 2', kind: 'followup', stage: 2, audience: 'any' },
  { id: 'followup_3', label: 'Follow-up 3', kind: 'followup', stage: 3, audience: 'any' },
];

/** Kategorie einer Vorlage – null, wenn sie in keine passt. */
export function templateCategory(template: Pick<MessageTemplate, 'kind' | 'stage' | 'audience'>): TemplateCategory | null {
  return (
    TEMPLATE_CATEGORIES.find(
      (category) =>
        category.kind === template.kind &&
        (category.kind !== 'followup' || category.stage === template.stage) &&
        (category.kind !== 'first' || category.audience === template.audience),
    )?.id ?? null
  );
}

/** Buchstabe nach der Reihenfolge in der Kategorie: 0 → „A“ … 25 → „Z“. */
export function templateLetter(index: number): string {
  return index >= 0 && index < TEMPLATE_MAX_PER_CATEGORY ? String.fromCharCode(65 + index) : String(index + 1);
}

/** Neue Vorlage in einer Kategorie; ohne Namen heißt sie „Neue Vorlage“. */
export interface CreateTemplateRequest {
  category: TemplateCategory;
  name?: string;
  text: string;
  /** Segment (27.10.), fehlt/null = für alle Leads. */
  segment?: TemplateSegment | null;
}

export type SuggestKind = 'first' | 'followup' | 'reply';

export interface SuggestRequest {
  kind: SuggestKind;
  /** Bestimmte Vorlage als Grundlage; ohne Angabe wählt das Backend passend zum Lead. */
  templateId?: string;
}

/** Einschätzung der letzten Antwort des Leads (nur bei kind „reply“). */
export type ReplyIntent = 'interested' | 'question' | 'not_now' | 'not_interested' | 'unclear';

export const REPLY_INTENT_LABELS: Record<ReplyIntent, string> = {
  interested: 'Interessiert',
  question: 'Hat eine Frage',
  not_now: 'Gerade nicht',
  not_interested: 'Kein Interesse',
  unclear: 'Unklar',
};

/**
 * Einschätzung des Gesprächs am Lead (`CockpitLead.conversation`). Das Backend rechnet sie bei jeder neuen Antwort des
 * Leads (`message_received`, auch aus dem LinkedIn-Abgleich) neu:
 *   - sofort eine schnelle Einschätzung ohne KI (`source: 'rules'`, in der Simulation `'mock'`);
 *   - live mit ANTHROPIC_API_KEY danach im Hintergrund von der KI (`source: 'ai'`, meist nach wenigen Sekunden –
 *     beim nächsten Laden des Leads bzw. Tagesstapels da). Fällt die KI aus, bleibt die schnelle Einschätzung.
 * Fehlt das Feld, gab es noch keine Antwort.
 */
export interface LeadConversation {
  /** Einschätzung der letzten Antwort (Labels in `REPLY_INTENT_LABELS`). */
  replyIntent: ReplyIntent;
  /** Ein Satz: was will der Lead (z. B. „Will telefonieren, schlägt Donnerstag vor.“). */
  replySummary: string;
  /** Höchstens drei Sätze: der Verlauf bisher. */
  summary: string;
  source: 'ai' | 'rules' | 'mock';
  /** Wann berechnet (ms). */
  updatedAt: number;
  /** Zu welcher Antwort (Zeitpunkt der Nachricht des Leads, ms) – älter als `lastReplyAt` = wird gerade neu berechnet. */
  replyAt: number;
}

export interface MessageSuggestion {
  kind: SuggestKind;
  /** Fertiger Text zum Kopieren (inklusive Grußformel). */
  text: string;
  /** Grundlage: Vorlage (für `label` beim Melden der Aktion) – null bei freien Antworten. */
  templateId: string | null;
  /** ai = KI · template = ausgefüllte Vorlage · mock = Simulation. */
  source: 'ai' | 'template' | 'mock';
  /** Ein Satz, warum dieser Text (z. B. „Greenfield – keine Meta-Ads gefunden“). */
  basis: string;
  /** Nur bei kind „reply“. */
  reply?: { intent: ReplyIntent; summary: string };
  /** Hinweis, falls die KI nicht genutzt werden konnte (z. B. kein Schlüssel). */
  notice?: string;
}

/**
 * Fehlercodes: `invalid_template` (400), `not_found` (404), `too_many_requests` (429, Header Retry-After),
 * `template_limit` (409, schon 26 in der Kategorie), `last_template` (409, die letzte Vorlage einer Kategorie).
 */
export type MessagesErrorCode = 'invalid_template' | 'not_found' | 'too_many_requests' | 'template_limit' | 'last_template';

/** Platzhalter ersetzen; unbekannte bleiben stehen (fällt beim Lesen auf). */
export function renderTemplate(text: string, values: Partial<Record<TemplatePlaceholder, string>>): string {
  return text.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (match, key: string) => values[key as TemplatePlaceholder] ?? match);
}

/** Platzhalter im Text, die es nicht gibt (z. B. Tippfehler „{{vornam}}“). */
export function unknownPlaceholders(text: string): string[] {
  const found = [...text.matchAll(/\{\{\s*([a-z]+)\s*\}\}/gi)].map((match) => match[1]);
  return [...new Set(found.filter((key) => !(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(key)))];
}
