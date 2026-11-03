import type { EnrichedProfile, Qualification, SearchHit } from '../../../shared/leadSearch.js';

/**
 * Zielgruppe seit dem Kundengespräch 27.10.: mittelgroße Kapitalanlage-Vertriebe und Finanzdienstleister mit
 * Geschäftsführung – keine Einzelberater und keine Konzerne („deutsche Vermögensberatung brauchen wir nicht, die
 * arbeiten sowieso nicht mit uns zusammen“). Die Größe schätzt die KI (Prompt); große Konzerne und Strukturvertriebe
 * sortiert diese Liste zusätzlich fest aus, auch wenn die KI sie durchlässt oder die Stichwort-Einstufung greift.
 * Nur eindeutige Marken – lieber einen Konzern übersehen als einen kleinen Vertrieb mit ähnlichem Namen verlieren.
 */
const LARGE_GROUPS: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ['Deutsche Vermögensberatung', /deutsche verm(?:ö|oe)gensberatung|\bdvag\b/i],
  ['Swiss Life Select', /swiss ?life select|\bawd\b/i],
  ['MLP', /\bmlp\b/i],
  ['OVB', /\bovb\b/i],
  ['Tecis', /\btecis\b/i],
  ['Bonnfinanz', /bonnfinanz/i],
  ['Plansecur', /plansecur/i],
  ['Telis Finanz', /telis finanz/i],
  ['Global Finanz', /global finanz/i],
  ['Formaxx', /formaxx/i],
  ['Postbank Finanzberatung', /postbank/i],
  ['Allianz', /\ballianz\b/i],
  ['ERGO', /\bergo\b/i],
  ['AXA', /\baxa\b/i],
  ['Generali', /\bgenerali\b/i],
  ['Debeka', /\bdebeka\b/i],
  ['Signal Iduna', /signal iduna/i],
  ['HanseMerkur', /hanse ?merkur/i],
  ['Wüstenrot', /w(?:ü|ue)stenrot/i],
  ['Sparkasse', /sparkasse/i],
  ['Volksbank', /volksbank|raiffeisenbank/i],
  ['Deutsche Bank', /deutsche bank/i],
  ['Commerzbank', /commerzbank/i],
];

/** Satzanfang der Begründung, wenn die Liste greift – daran erkennt `rejectionNote` den Grund. */
export const LARGE_GROUP_REASON = 'Konzern bzw. großer Strukturvertrieb';

/** Name der Marke, wenn Firma, Position oder Headline zu einem Konzern gehören – sonst null. */
export function largeGroupOf(hit: Pick<SearchHit, 'headline'>, profile: Pick<EnrichedProfile, 'companyName' | 'position' | 'headline'>): string | null {
  // Firmenname zuerst: „ehemals bei der DVAG“ in der Headline allein reicht nicht, wenn die eigene Firma bekannt ist.
  const company = profile.companyName?.trim();
  const texts = company ? [company] : [profile.position ?? '', profile.headline || hit.headline || ''];
  for (const [label, pattern] of LARGE_GROUPS) {
    if (texts.some((text) => pattern.test(text))) return label;
  }
  return null;
}

/** Feste Regeln nach der Einstufung: Konzerne sind nie qualifiziert, egal was KI oder Stichwort sagen. */
export function applyTargetRules(hit: SearchHit, profile: EnrichedProfile, qualification: Qualification): Qualification {
  if (!qualification.qualified) return qualification;
  const group = largeGroupOf(hit, profile);
  if (!group) return qualification;
  return {
    ...qualification,
    qualified: false,
    reason: `${LARGE_GROUP_REASON} (${group}) – gesucht sind mittelgroße Firmen.`,
  };
}
