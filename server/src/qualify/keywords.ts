import type { EnrichedProfile, LeadCategory, Qualification, SearchHit } from '../../../shared/leadSearch.js';

/**
 * Qualifizierung ohne KI (Wunsch des Kunden 12.10.: „Kosten krass verringern, wenn wir automatisch alle als qualified
 * markieren, die ‚Projektentwicklung‘ … in Bio oder Jobbeschreibung haben“). Greift nur bei eindeutigen Fällen:
 *   - ein Stichwort aus `AUTO_QUALIFY_TERMS` in Headline, aktueller Position oder Firmenname,
 *   - eine leitende Rolle in Position oder Headline,
 *   - kein Gegenbeleg (Versicherung, Finanzberatung, Makler, Hausverwaltung …),
 *   - bei Bauträger-Begriffen zusätzlich ein Hinweis auf eigenen Vertrieb (seit 27.10.).
 * Finanzdienstleister stuft immer die KI ein (Größe: keine Einzelberater, keine Konzerne).
 * Alles andere bewertet weiter die KI. Meta-Ads werden wie bei der KI geprüft.
 */

const DECISION_MAKER =
  /\b(geschäftsführ\w*|geschaeftsfuehr\w*|inhaber\w*|gründer\w*|gruender\w*|co-?founder|founder|ceo|gesellschafter\w*|vorstand\w*|managing director|owner|geschäftsleitung|prokurist\w*)\b/i;

const EXCLUDED =
  /(versicherung|finanzberat|finanzplan|finanzcoach|vermögensberat|vermoegensberat|anlageberat|makler|hausverwalt|immobilienverwalt|wegverwalt|steuerberat|\bbank\b|bausparkasse|personalberat|recruit)/i;

/** Begriffe, die auf Bauträger/Projektentwicklung deuten – alles andere gilt als Kapitalanlage-Vertrieb. */
const BUILDER = /(bau|projekt|wohn)/i;
/**
 * Bauträger zählen seit 27.10. (Kundengespräch) nur mit eigenem Vertrieb. Ohne Hinweis darauf in Headline, Position
 * oder Firmenname entscheidet die KI (sie sieht auch die Firmenbeschreibung).
 */
const OWN_SALES = /vertrieb|verkauf|sales/i;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

export function quickQualify(hit: SearchHit, profile: EnrichedProfile, terms: readonly string[]): Qualification | null {
  if (!terms.length) return null;
  const fields: Array<[label: string, text: string]> = [
    ['in der Headline', profile.headline || hit.headline || ''],
    ['in der Position', profile.position ?? ''],
    ['im Firmennamen', profile.companyName ?? ''],
  ];
  const all = fields.map(([, text]) => text).join(' · ');
  if (!all.trim() || EXCLUDED.test(all)) return null;
  const role = (profile.position ?? '').match(DECISION_MAKER)?.[0] ?? (profile.headline || hit.headline || '').match(DECISION_MAKER)?.[0];
  if (!role) return null;
  for (const term of terms) {
    const wanted = normalize(term.trim());
    if (!wanted) continue;
    const field = fields.find(([, text]) => normalize(text).includes(wanted));
    if (!field) continue;
    const category: LeadCategory = BUILDER.test(wanted) ? 'bautraeger_projektentwickler' : 'kapitalanlage_vertrieb';
    if (category === 'bautraeger_projektentwickler' && !OWN_SALES.test(all)) return null;
    const company = profile.companyName?.trim() || 'Die Firma';
    return {
      category,
      qualified: true,
      confidence: 0.8,
      reason: `„${term.trim()}“ ${field[0]} und Rolle „${role}“ – ohne KI eingestuft.`,
      summary: `${company} nennt „${term.trim()}“ im LinkedIn-Profil. ${hit.firstName} ${hit.lastName} ist dort ${role}.`.trim(),
    };
  }
  return null;
}
