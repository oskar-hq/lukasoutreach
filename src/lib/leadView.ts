import { REPLY_INTENT_LABELS, type LeadConversation } from '../../shared/messages';
import { CATEGORY_LABELS, germanDate, isQualifyingCategory, metaAdsLabel } from '../../shared/leadSearch';
import type { CockpitLead, LeadEvent } from '../../shared/leads';
import { metaStopText } from '../../shared/messages';
import { safeHref } from './safeHref';

/**
 * Anzeige-Helfer für Leads aus der Datenbank (`shared/leads.ts`). Ersetzt für das Cockpit die Helfer aus
 * `leadInfo.ts`, die nur noch die Demo-Daten in `src/data/` (Seed des Backends) bedienen.
 */

export const leadName = (lead: CockpitLead) => `${lead.person.firstName} ${lead.person.lastName}`.trim();

export const leadInitials = (lead: CockpitLead) =>
  `${lead.person.firstName.charAt(0)}${lead.person.lastName.charAt(0)}`.toUpperCase() || '?';

export const leadCompany = (lead: CockpitLead) => lead.company.name || 'Firma unbekannt';

export const leadPosition = (lead: CockpitLead) => lead.person.position || lead.person.headline;

export const leadRegion = (lead: CockpitLead) => lead.company.region ?? lead.person.location ?? null;

export function leadIndustry(lead: CockpitLead): string | null {
  return lead.company.industry ?? (lead.assessment ? CATEGORY_LABELS[lead.assessment.category] : null);
}

export interface FitView {
  label: string;
  good: boolean;
}

/** KI-Einschätzung wie in der Lead-Suche: „Passt (Kapitalanlage-Vertrieb)“ bzw. „Vermutlich unpassend (Makler)“. */
export function leadFit(lead: CockpitLead): FitView | null {
  if (!lead.assessment) return null;
  const { category } = lead.assessment;
  const good = isQualifyingCategory(category);
  return { label: `${good ? 'Passt' : 'Vermutlich unpassend'} (${CATEGORY_LABELS[category]})`, good };
}

export const confidencePercent = (lead: CockpitLead) =>
  lead.assessment ? `${Math.round(lead.assessment.confidence * 100)} %` : null;

/** Profil-Link (volle URL) – aus der Suche oder aus dem öffentlichen Kennzeichen. */
export function linkedinProfileUrl(lead: CockpitLead): string | null {
  // Nur http(s) – eine eingeschleuste `javascript:`-Adresse wird nie zum Link (LeadPanel, LeadCard, FocusParts).
  const profile = safeHref(lead.person.profileUrl);
  if (profile) return profile;
  if (lead.person.publicIdentifier) return `https://www.linkedin.com/in/${encodeURIComponent(lead.person.publicIdentifier)}`;
  return null;
}

/** Profil-Link ohne Protokoll, zum Anzeigen. */
export const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

/** Signal aus der Lead-Suche bzw. der Demo: steht im ersten Ereignis („Signal: Meta Ads aktiv – …“). */
export interface LeadSignal {
  kind: 'meta_ads' | 'hiring' | 'search';
  /** Kurztext für die Karte, z. B. „Meta Ads aktiv“, „Sucht: Vertriebsmitarbeiter (m/w/d)“, „Keine Meta-Ads · 2. Grad“. */
  label: string;
  /** Bei Recruiting: die ausgeschriebene Stelle (für {{stelle}}). */
  role?: string;
}

const SIGNAL_TEXT = /^Signal: (.+?)(?: – |$)/;

export function leadSignal(lead: CockpitLead, events?: LeadEvent[]): LeadSignal | null {
  if (lead.origin.kind === 'search' || lead.metaAds) {
    const ads = lead.metaAds;
    const distance = lead.person.networkDistance === 2 || lead.person.networkDistance === 3 ? ` · ${lead.person.networkDistance}. Grad` : '';
    // Der Pain-Point steht vorn: keine oder beendete Meta-Ads.
    const label =
      ads?.state === 'none'
        ? 'Keine Meta-Ads'
        : ads?.state === 'stopped'
          ? ads.lastStop
            ? `Meta-Ads aus seit ${germanDate(ads.lastStop)}`
            : 'Meta-Ads beendet'
          : ads?.state === 'active'
            ? metaAdsLabel(ads)
            : 'Lead-Suche';
    // Hiring-Signal (13.10.): gesuchte Stelle hinter dem Meta-Stand – die Erstnachricht schlägt dann Recruiting vor.
    if (lead.hiring) {
      const role = lead.hiring.role ?? undefined;
      const hiring = `Sucht: ${role ?? 'Mitarbeiter'}`;
      return { kind: 'hiring', label: `${lead.origin.kind === 'search' || ads ? `${label} · ` : ''}${hiring}${distance}`, role };
    }
    return { kind: ads?.state === 'active' ? 'meta_ads' : 'search', label: `${label}${distance}` };
  }
  if (lead.hiring) return { kind: 'hiring', label: `Sucht: ${lead.hiring.role ?? 'Mitarbeiter'}`, role: lead.hiring.role ?? undefined };
  const created = events?.find((event) => event.kind === 'created');
  const match = created?.text?.match(SIGNAL_TEXT);
  if (!match) return null;
  const label = match[1];
  if (label.startsWith('Sucht: ')) return { kind: 'hiring', label, role: label.slice('Sucht: '.length) };
  if (/meta.?ads aktiv/i.test(label)) return { kind: 'meta_ads', label };
  return { kind: 'search', label };
}

/** Eine Nachricht im Gespräch, abgeleitet aus dem Verlauf. Richtung immer aus der Ereignisart, nie aus `by`. */
export interface ThreadMessage {
  id: string;
  from: 'founder' | 'lead';
  text: string;
  at: number;
  /** Absenderzeile, z. B. „Erstnachricht · Template A“ oder „Follow-up 1 · Variante B“. */
  label: string | null;
  founder: CockpitLead['owner'] | null;
  /** Noch nicht gespeichert (Rückgängig-Fenster) bzw. wird gerade gespeichert. */
  pending?: boolean;
}

/** „Follow-up 1 · Variante A gesendet“ → „Follow-up 1 · Variante A“; „Nachricht gesendet“ → null. */
function messageLabel(event: LeadEvent): string | null {
  const title = event.title.replace(/ gesendet.*$/, '').trim();
  return title && title !== 'Nachricht' ? title : null;
}

export function threadMessages(events: LeadEvent[]): ThreadMessage[] {
  return events
    .filter((event) => event.kind === 'message_sent' || event.kind === 'message_received')
    .map((event) => ({
      id: event.id,
      from: event.kind === 'message_sent' ? 'founder' : 'lead',
      text: event.text ?? '',
      at: event.at,
      label: event.kind === 'message_sent' ? messageLabel(event) : null,
      founder: event.kind === 'message_sent' ? event.by : null,
    }));
}

/** Wörter der Fehlermeldungen des Backends, die nicht für Menschen gedacht sind (Validierung auf Englisch). */
export function readableError(error: { code: string; message: string }, fallback: string): string {
  if (error.code === 'invalid_request' || error.code === 'error') return fallback;
  return error.message || fallback;
}

/**
 * Einschätzung der Antwort als Label + Satz. Die schnelle Einschätzung ohne KI beginnt ihren Satz oft mit dem Label
 * („Kein Interesse – höflich abschließen.“) – dann ohne die Wiederholung.
 */
export function replyAssessmentParts(conversation: LeadConversation): { label: string; detail: string } {
  const label = REPLY_INTENT_LABELS[conversation.replyIntent];
  const summary = conversation.replySummary.trim();
  const detail = summary.startsWith(label) ? summary.slice(label.length).replace(/^[\s–—:-]+/, '') : summary;
  return { label, detail };
}

/**
 * Ältere Prüfungen speicherten den Seiten-Link ohne `search_type=page` – dann zeigt die Bibliothek nur das leere Suchfeld
 * statt der Seite des Werbetreibenden (Meldung des Nutzers 15.10.). Hier ergänzen, bis alle Leads neu geprüft sind.
 */
export function libraryLink(url: string): string {
  return url.includes('view_all_page_id=') && !url.includes('search_type=') ? `${url}&search_type=page&media_type=all` : url;
}

/**
 * Link in die Meta-Werbebibliothek (Wunsch des Nutzers 15.10.): der Link der Prüfung (Seite des Werbetreibenden oder
 * Suche), sonst eine Suche nach dem Firmennamen – so geht es auch bei noch nicht geprüften Leads mit einem Klick.
 */
export function metaLibraryUrl(lead: Pick<CockpitLead, 'metaAds' | 'company'>): string | null {
  if (lead.metaAds?.libraryUrl) return libraryLink(lead.metaAds.libraryUrl);
  const term = lead.company.name
    .replace(/\b(GmbH|mbH|UG|AG|KGaA|KG|OHG|GbR|SE|eG)\b\.?/g, ' ')
    .replace(/\(haftungsbeschränkt\)|&\s*Co\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!term) return null;
  return `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=DE&q=${encodeURIComponent(term)}&search_type=keyword_unordered&media_type=all`;
}

/** Führt der Link direkt auf die Seite des Werbetreibenden (sonst nur eine Stichwortsuche nach dem Firmennamen)? */
export const metaLibraryIsPage = (url: string | null) => !!url?.includes('view_all_page_id=');

const DAY_MS = 86_400_000;

/**
 * Meta-Ads „aus“ im Lead-Panel: Datum und wie lange her, bei jedem Öffnen neu gerechnet – „aus seit 09.10.2026 · vor 6
 * Tagen“. Ab 14 Tagen in Wochen/Monaten wie {{metapause}} in den Vorlagen. Ohne Datum „aus · seit einiger Zeit“.
 */
export function metaStoppedText(lastStop: string | null | undefined, now = Date.now()): string {
  if (!lastStop || !/^\d{4}-\d{2}-\d{2}/.test(lastStop)) return 'aus · seit einiger Zeit';
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(`${lastStop.slice(0, 10)}T00:00:00`).getTime()) / DAY_MS);
  const ago = days <= 0 ? 'heute' : days === 1 ? 'gestern' : days < 14 ? `vor ${days} Tagen` : metaStopText(lastStop, now);
  return `aus seit ${germanDate(lastStop)} · ${ago}`;
}
