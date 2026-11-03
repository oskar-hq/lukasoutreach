/**
 * Adressen aus fremden Daten (Lead-Suche, Scraper, Werbebibliothek), die die Oberfläche als Link zeigt
 * (Sicherheitsprüfung 08.10.): gespeichert wird nur http(s) oder ohne Schema („www.firma.de“) – nie `javascript:`,
 * `data:` o. Ä. Gilt für die Übergabe (`POST /api/leads`) und die automatische Suche gleichermaßen.
 */

/** Schemata, die nach Angriff aussehen – eine Übergabe damit wird abgelehnt statt still bereinigt. */
const DANGEROUS_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob']);

const schemeOf = (value: string): string | undefined => /^\s*([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();

/** Grund, warum die Adresse nicht gespeichert werden darf – oder null, wenn sie passt. Leer = null. */
export function webUrlProblem(value: string): string | null {
  if (!value) return null;
  const scheme = schemeOf(value);
  if (scheme === undefined) return /^\/\/|[\s<>"]/.test(value) ? 'Bitte eine Adresse mit https:// angeben.' : null;
  if (scheme !== 'http' && scheme !== 'https') return 'Nur Adressen mit http:// oder https:// sind erlaubt.';
  try {
    new URL(value);
    return null;
  } catch {
    return 'Diese Adresse ist ungültig.';
  }
}

/**
 * Adresse zum Speichern: passt sie, getrimmt zurück – sonst null. Gescrapte Werte sind oft seltsam
 * („www.a.de, www.b.de“, „firma.de:8080“); daran soll keine ganze Übergabe scheitern.
 */
export function safeWebUrl(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  return webUrlProblem(text) ? null : text;
}

/** `javascript:`, `data:` … – eindeutig gefährlich (Steuerzeichen und Leerraum vorher zählen nicht). */
export function hasDangerousScheme(value: string | null | undefined): boolean {
  // eslint-disable-next-line no-control-regex
  const compact = (value ?? '').replace(/[\u0000- ]/g, '');
  const scheme = schemeOf(compact);
  return scheme !== undefined && DANGEROUS_SCHEMES.has(scheme);
}
