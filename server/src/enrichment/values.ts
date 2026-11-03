import { createHash } from 'node:crypto';
import type { CompanyEnrichment, CompanySocials } from '../../../shared/enrichment.js';

/**
 * Werte der Clay-Anreicherung (Vertrag `shared/enrichment.ts`): Rückmeldung von Clay großzügig lesen und auf feste
 * Felder bringen, feste Beispielwerte für die Simulation, ein Satz für den Verlauf.
 *
 * Clay schickt, was in der Tabelle steht – oft alles als Text („11-50“, „1.234“, „WordPress, Meta Pixel“) und leere
 * Zellen als "" oder "null". Deshalb hier nichts streng ablehnen, sondern Unbrauchbares als „unbekannt“ werten.
 */

export type EnrichmentValues = Pick<
  CompanyEnrichment,
  'employees' | 'employeesRange' | 'revenue' | 'techStack' | 'metaPixel' | 'googleTagManager' | 'socials'
>;

export const SOCIAL_KEYS = ['instagram', 'facebook', 'linkedin', 'youtube', 'tiktok', 'x'] as const satisfies readonly (keyof CompanySocials)[];

/** Erlaubte Hosts je Netzwerk – andere Links werden verworfen (die Oberfläche verlinkt sie direkt). */
const SOCIAL_HOSTS: Record<keyof CompanySocials, string[]> = {
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.com'],
  linkedin: ['linkedin.com'],
  youtube: ['youtube.com', 'youtu.be'],
  tiktok: ['tiktok.com'],
  x: ['x.com', 'twitter.com'],
};

const EMPTY = new Set(['', 'null', 'undefined', 'none', 'n/a', 'na', '-', '–', 'unknown', 'unbekannt', 'false']);

export const NO_SOCIALS: CompanySocials = { instagram: null, facebook: null, linkedin: null, youtube: null, tiktok: null, x: null };

function cell(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return EMPTY.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** „11-50“ → 30 / „11–50“ · „1.234“ → 1234 · „10,001+“ → 10001 / „10001+“ · 25 → 25. */
export function parseEmployees(value: unknown): Pick<EnrichmentValues, 'employees' | 'employeesRange'> {
  const raw = cell(value);
  if (!raw) return { employees: null, employeesRange: null };
  // „501-1k“ → „501-1000“
  const text = raw.replace(/(\d+(?:[.,]\d+)?)\s*k\b/gi, (_, n: string) => String(Math.round(parseFloat(n.replace(',', '.')) * 1000)));
  // Mitarbeiterzahlen sind ganze Zahlen – Tausendertrennzeichen (Punkt oder Komma) einfach entfernen.
  const numbers = (text.match(/\d[\d.,]*/g) ?? []).map((part) => Number(part.replace(/[.,]/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
  if (!numbers.length) return { employees: null, employeesRange: null };
  if (numbers.length >= 2) {
    const [low, high] = numbers[0] <= numbers[1] ? [numbers[0], numbers[1]] : [numbers[1], numbers[0]];
    return { employees: Math.round((low + high) / 2), employeesRange: `${low}–${high}` };
  }
  return { employees: numbers[0], employeesRange: /\+/.test(text) ? `${numbers[0]}+` : null };
}

function parseList(value: unknown): string[] | null {
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else {
    const text = cell(value);
    if (!text) return null;
    items = text.split(/[,;\n|]/);
  }
  const seen = new Map<string, string>();
  for (const item of items) {
    const entry = cell(item)?.slice(0, 80);
    if (entry && !seen.has(entry.toLowerCase())) seen.set(entry.toLowerCase(), entry);
  }
  return [...seen.values()].slice(0, 50);
}

function parseFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : null;
  if (text === 'true' || text === 'yes' || text === 'ja' || text === '1') return true;
  if (text === 'false' || text === 'no' || text === 'nein' || text === '0') return false;
  return null;
}

/** Nur echte Profil-Links des jeweiligen Netzwerks, immer mit https://. */
export function parseSocial(key: keyof CompanySocials, value: unknown): string | null {
  const text = cell(value);
  if (!text || /\s/.test(text) || text.length > 300) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|de)\./, '');
  if (!SOCIAL_HOSTS[key].includes(host) || url.pathname.length <= 1) return null;
  url.protocol = 'https:';
  return url.toString();
}

const META_PIXEL = /(meta|facebook|fb)[\s_-]*pixel|fbevents|facebook conversion/i;
const GTM = /google tag manager|\bgtm\b/i;

/** Rückmeldung von Clay → Felder. `usable` = mindestens ein Wert gefunden. */
export function parseClayResult(body: Record<string, unknown>): { values: EnrichmentValues; usable: boolean } {
  const { employees, employeesRange } = parseEmployees(body.employees ?? body.employeeCount ?? body.employee_count);
  const revenueRaw = body.revenue;
  const revenue =
    typeof revenueRaw === 'number' && Number.isFinite(revenueRaw) && revenueRaw > 0
      ? `ca. ${revenueRaw.toLocaleString('de-DE')}`
      : (cell(revenueRaw)?.slice(0, 80) ?? null);
  const techStack = parseList(body.techStack ?? body.tech_stack ?? body.technologies);
  const explicitPixel = parseFlag(body.metaPixel);
  const explicitGtm = parseFlag(body.googleTagManager);
  const metaPixel = explicitPixel ?? (techStack ? techStack.some((tool) => META_PIXEL.test(tool)) : null);
  const googleTagManager = explicitGtm ?? (techStack ? techStack.some((tool) => GTM.test(tool)) : null);

  const nested = body.socials && typeof body.socials === 'object' ? (body.socials as Record<string, unknown>) : {};
  const socials = { ...NO_SOCIALS };
  for (const key of SOCIAL_KEYS) {
    socials[key] = parseSocial(key, body[key] ?? nested[key] ?? (key === 'x' ? (body.twitter ?? nested.twitter) : undefined));
  }

  const values: EnrichmentValues = { employees, employeesRange, revenue, techStack: techStack ?? [], metaPixel, googleTagManager, socials };
  const usable =
    employees !== null || revenue !== null || (techStack?.length ?? 0) > 0 || metaPixel !== null || SOCIAL_KEYS.some((key) => socials[key] !== null);
  return { values, usable };
}

export function socialCount(socials: CompanySocials): number {
  return SOCIAL_KEYS.filter((key) => socials[key] !== null).length;
}

// ── Simulation ─────────────────────────────────────────────────────────────

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/\b(gmbh|ag|kg|ug|mbh|co|se)\b/g, '')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 30) || 'firma'
  );
}

const MOCK_SIZES = [
  { employees: 4, range: '2–10', revenue: '< 1 Mio. €' },
  { employees: 8, range: '2–10', revenue: '< 1 Mio. €' },
  { employees: 18, range: '11–50', revenue: '1–5 Mio. €' },
  { employees: 35, range: '11–50', revenue: '5–10 Mio. €' },
  { employees: 60, range: '51–200', revenue: '10–50 Mio. €' },
  { employees: 140, range: '51–200', revenue: '10–50 Mio. €' },
];
const MOCK_SITES = ['WordPress', 'Webflow', 'Wix', 'TYPO3', 'Jimdo'];

/** Feste Beispielwerte je Firma – gleiche Firma, gleiche Werte. */
export function mockValues(company: { name: string; website: string | null }): EnrichmentValues {
  const hash = createHash('sha256').update(company.name.toLowerCase()).digest();
  const size = MOCK_SIZES[hash[0] % MOCK_SIZES.length];
  const name = slug(company.name);
  const pixel = company.website ? hash[1] % 3 === 0 : null;
  const gtm = company.website ? hash[2] % 2 === 0 : null;
  const techStack = company.website
    ? [MOCK_SITES[hash[3] % MOCK_SITES.length], ...(gtm ? ['Google Tag Manager'] : []), ...(pixel ? ['Meta Pixel'] : []), 'Google Analytics']
    : [];
  return {
    employees: size.employees,
    employeesRange: size.range,
    revenue: size.revenue,
    techStack,
    metaPixel: pixel,
    googleTagManager: gtm,
    socials: {
      instagram: hash[4] % 4 !== 0 ? `https://www.instagram.com/${name}/` : null,
      facebook: hash[5] % 3 !== 1 ? `https://www.facebook.com/${name}` : null,
      linkedin: `https://www.linkedin.com/company/${name}/`,
      youtube: hash[6] % 5 === 0 ? `https://www.youtube.com/@${name}` : null,
      tiktok: null,
      x: null,
    },
  };
}

/** Titel für das Ereignis `enriched`, z. B. „Firmendaten ergänzt (Treg): 11–50 Mitarbeiter · Meta-Pixel · 3 Social-Profile“. */
export function enrichedTitle(enrichment: CompanyEnrichment): string {
  const parts: string[] = [];
  if (enrichment.employeesRange || enrichment.employees) parts.push(`${enrichment.employeesRange ?? enrichment.employees} Mitarbeiter`);
  if (enrichment.metaPixel) parts.push('Meta-Pixel');
  const socials = socialCount(enrichment.socials);
  if (socials) parts.push(socials === 1 ? '1 Social-Profil' : `${socials} Social-Profile`);
  const source = { mock: 'Simulation', clay: 'Clay', treg: 'Treg' }[enrichment.source];
  return parts.length ? `Firmendaten ergänzt (${source}): ${parts.join(' · ')}` : `Firmendaten ergänzt (${source})`;
}

// ── Treg (treg.companies.enrich) ───────────────────────────────────────────

const SOCIAL_BY_HOST: [RegExp, keyof CompanySocials][] = [
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(facebook|fb)\.com$/, 'facebook'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(x|twitter)\.com$/, 'x'],
];

/** Alle Text-Werte eines beliebig verschachtelten Werts (begrenzte Tiefe und Menge). */
function collectStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length > 400 || depth > 4) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, depth + 1, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectStrings(entry, depth + 1, out));
  return out;
}

/** Social-Links am Host erkennen, nicht am Feldnamen (jeder Anbieter benennt sie anders). Der erste Treffer je Netzwerk gilt. */
function socialsFrom(...sources: unknown[]): CompanySocials {
  const socials = { ...NO_SOCIALS };
  for (const text of sources.flatMap((source) => collectStrings(source))) {
    if (!/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}\/\S+$/i.test(text.trim())) continue;
    let host: string;
    try {
      host = new URL(/^https?:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`).hostname.toLowerCase().replace(/^(www|m|de)\./, '');
    } catch {
      continue;
    }
    const key = SOCIAL_BY_HOST.find(([pattern]) => pattern.test(host))?.[1];
    if (key && !socials[key]) socials[key] = parseSocial(key, text.trim());
  }
  return socials;
}

/**
 * Antwort von `POST /call/treg.companies.enrich` (`{ output, raw, _treg }`). `output` ist von Treg vereinheitlicht
 * (name, domain, industry, description, employees als Spanne „10-50“, founded, location, linkedin_url); `raw` ist die
 * Antwort des Anbieters, der geantwortet hat – je nach Anbieter mit mehr (Tech-Stack, Social-Links, Umsatz). Daraus
 * nehmen wir nur, was eindeutig erkennbar ist. Treffer = `output.name` gesetzt (laut Treg-Katalog: Fehlschlag ist
 * `output.name == null`).
 */
export function parseTregCompany(output: Record<string, unknown>, raw: unknown): { values: EnrichmentValues; usable: boolean } {
  const rawObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const employees = parseEmployees(output.employees ?? rawObject.employees ?? rawObject.employeeCount ?? rawObject.employee_count);
  const technologies = output.technologies ?? rawObject.technologies ?? rawObject.tech_stack ?? rawObject.techStack;
  const techStack = parseList(
    Array.isArray(technologies) ? technologies.map((tool) => (tool && typeof tool === 'object' ? ((tool as { name?: unknown }).name ?? null) : tool)) : technologies,
  );
  const revenueSource = output.revenue ?? rawObject.revenue ?? rawObject.annual_revenue;
  const values: EnrichmentValues = {
    ...employees,
    revenue: typeof revenueSource === 'string' || typeof revenueSource === 'number' ? parseRevenue(revenueSource) : null,
    techStack: techStack ?? [],
    metaPixel: techStack ? techStack.some((tool) => META_PIXEL.test(tool)) : null,
    googleTagManager: techStack ? techStack.some((tool) => GTM.test(tool)) : null,
    socials: socialsFrom(output, rawObject),
  };
  const found = typeof output.name === 'string' && output.name.trim() !== '';
  return { values, usable: found };
}

/** Umsatz als Text (z. B. „1-10M“) oder Zahl – nur zur Anzeige. */
function parseRevenue(value: string | number): string | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? `ca. ${value.toLocaleString('de-DE')}` : null;
  return cell(value)?.slice(0, 80) ?? null;
}
