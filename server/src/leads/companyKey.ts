/**
 * Firmen-Dubletten (Wunsch des Nutzers 27.10.): Steht schon jemand aus derselben Firma im Cockpit – egal in welcher
 * Stufe, auch „Verloren“ –, fliegt jeder weitere Kontakt dieser Firma als Dublette raus. Verglichen wird der Firmenname
 * ohne Rechtsform und Satzzeichen sowie die Website-Domain.
 */

/** Rechtsformen und Zusätze, die für den Vergleich keine Rolle spielen („Muster GmbH & Co. KG“ = „Muster“). */
const LEGAL_FORMS =
  /\b(gmbh|mbh|ggmbh|ag|kg|kgaa|ohg|gbr|ug|haftungsbeschränkt|haftungsbeschraenkt|se|eg|ek|e\.?\s?k|e\.?\s?v|ev|ltd|limited|inc|llc|co|und co|und cie|cie|holding|gruppe|group)\b/g;

/** Klein, ohne Akzente/Umlaut-Punkte, „&“ = „und“, ohne Klammern und Satzzeichen. */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' und ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .replace(/[-.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kein Firmenname: Selbstständige und Platzhalter teilen sich sonst eine „Firma“. */
const NO_COMPANY = new Set(
  ['', 'Selbstständig', 'Selbständig', 'Selbststaendig', 'Freiberuflich', 'Freelance', 'Freelancer', 'Self employed', 'Self-employed', 'Privat', 'n/a', 'na', 'keine', 'diverse'].map(normalize),
);

/** Vergleichsschlüssel des Firmennamens – null, wenn zu kurz oder kein echter Firmenname. */
export function companyNameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const plain = normalize(name);
  if (NO_COMPANY.has(plain)) return null;
  const key = plain.replace(LEGAL_FORMS, ' ').replace(/\bund\s*$/, ' ').replace(/\s+/g, ' ').trim();
  return key.length >= 3 && !NO_COMPANY.has(key) ? key : null;
}

/** Domain der Website ohne „www.“ – null ohne Website oder bei großen Plattformen (LinkedIn, Facebook …). */
export function companyDomainKey(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`).hostname.toLowerCase().replace(/^www\./, '');
    if (!host.includes('.') || /(^|\.)(linkedin|facebook|instagram|xing|google|t-online|gmx|web)\.[a-z]+$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/** Alle Schlüssel einer Firma („name:…“, „web:…“) – leer, wenn nichts Vergleichbares bekannt ist. */
export function companyKeys(company: { name?: string | null; website?: string | null }): string[] {
  const name = companyNameKey(company.name);
  const domain = companyDomainKey(company.website);
  return [...(name ? [`name:${name}`] : []), ...(domain ? [`web:${domain}`] : [])];
}
