import { HIRING_ROLE_MAX_LENGTH, type EnrichedProfile, type LeadHiring, type SearchHit } from '../../../shared/leadSearch.js';

/**
 * Hiring-Signal ohne KI (Wunsch des Nutzers 13.10.): Sucht die Firma laut LinkedIn-Profil gerade Mitarbeiter? Dann passt
 * eine Recruiting-Erstnachricht (Vorlagen der Zielgruppe `hiring`). Greift nur bei eindeutigen Formulierungen in
 * Headline, Position oder Firmenbeschreibung – „#hiring“, „Wir stellen ein“, „Wir suchen …“, Stellentitel mit „(m/w/d)“.
 * Kostet nichts und läuft in Simulation und Live gleich; die KI-Bewertung kann zusätzlich ein Signal liefern.
 */

/** Geschlechtszusatz einer Stellenanzeige: (m/w/d), (w/m/d), (m/f/d), (all genders) … */
const GENDER = String.raw`\((?:[mwfd]\s*\/\s*[mwfd](?:\s*\/\s*[mwfdx*])?|all genders?)\)`;

/** „Wir suchen ab sofort einen Vertriebsmitarbeiter (m/w/d)“ → „Vertriebsmitarbeiter (m/w/d)“. */
const SEARCHING_WITH_ROLE = new RegExp(
  String.raw`\b(?:wir suchen|suchen wir|gesucht(?: wird)?:?|we(?:'re| are) hiring:?|hiring:?|wir stellen ein:?)\s+(?:(?:ab sofort|aktuell|dich|als|eine?n?|zur verstärkung|unseres teams|für unser team|neue)\s+)*([A-ZÄÖÜ][^.,;:!?()\n·|]{1,60}?)\s*(${GENDER})`,
  'iu',
);

/** Stellentitel mit Geschlechtszusatz, z. B. „Immobilienberater Neubau (m/w/d)“. */
const ROLE_WITH_GENDER = new RegExp(String.raw`([A-ZÄÖÜ][\wÄÖÜäöüß\-]+(?:\s+[\wÄÖÜäöüß\-]+){0,3})\s*(${GENDER})`, 'u');

/** Eindeutige Hinweise ohne Stellentitel. */
const HIRING_HINT =
  /(#hiring\b|#wirstellenein\b|\bwe(?:'re| are) hiring\b|\bwir stellen ein\b|\bwir suchen (?:dich|verstärkung|vertriebler\w*|mitarbeiter\w*|berater\w*|makler\w*)\b|\bverstärkung gesucht\b|\bjetzt bewerben\b|\bopen to hiring\b)/iu;

/** Rollen, die ein Hinweis ohne Titel immerhin nennt („Wir suchen Vertriebler“). */
const HINT_ROLE = /\bwir suchen (vertriebler\w*|mitarbeiter\w*|berater\w*|makler\w*)\b/iu;

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Ausschnitt um die Fundstelle für den Beleg. */
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

function normalizeRole(role: string, gender: string | undefined): string {
  const title = role.replace(/\s+/g, ' ').trim();
  const capitalized = title.charAt(0).toUpperCase() + title.slice(1);
  return clip(gender ? `${capitalized} ${gender.replace(/\s+/g, '')}` : capitalized, HIRING_ROLE_MAX_LENGTH);
}

export function detectHiring(hit: Pick<SearchHit, 'headline'>, profile: Pick<EnrichedProfile, 'headline' | 'position' | 'companyDescription'> | null): LeadHiring | null {
  const fields: Array<[label: string, text: string]> = [
    ['Headline', profile?.headline || hit.headline || ''],
    ['Position', profile?.position ?? ''],
    ['Firmenbeschreibung', profile?.companyDescription ?? ''],
  ];
  // Erst mit Stellentitel suchen (in allen Feldern), dann nur nach einem Hinweis.
  for (const pattern of [SEARCHING_WITH_ROLE, ROLE_WITH_GENDER]) {
    for (const [label, text] of fields) {
      const match = pattern.exec(text);
      if (!match) continue;
      return { role: normalizeRole(match[1], match[2]), source: 'profile', evidence: `${label}: „${excerpt(text, match.index, match[0].length)}“` };
    }
  }
  for (const [label, text] of fields) {
    const match = HIRING_HINT.exec(text);
    if (!match) continue;
    const role = HINT_ROLE.exec(text)?.[1];
    return { role: role ? normalizeRole(role, undefined) : null, source: 'profile', evidence: `${label}: „${excerpt(text, match.index, match[0].length)}“` };
  }
  return null;
}

/** Stelle aus der KI-Ausgabe (`hiringRole`) – null/leer = kein Signal. */
export function hiringFromAi(role: string | null | undefined): LeadHiring | null {
  const clean = role?.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  // „Mitarbeiter“ allein = sucht, Stelle unbekannt.
  return { role: /^(mitarbeiter(?:innen)?|unbekannt|ja)$/i.test(clean) ? null : clip(clean, HIRING_ROLE_MAX_LENGTH), source: 'ai', evidence: null };
}
