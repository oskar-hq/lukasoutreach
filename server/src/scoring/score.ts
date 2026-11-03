import { CATEGORY_LABELS, isQualifyingCategory, type LeadCategory, type MetaAdsCheck } from '../../../shared/leadSearch.js';
import {
  SCORE_VERSION,
  scoreTier,
  type AdEvidence,
  type HardFilterCheck,
  type LeadScore,
  type LeadType,
  type ScoreComponent,
} from '../../../shared/scoring.js';

/**
 * Scoring v1 – regelbasiert, erklärbar, für Simulation und Live gleich. Konzept: `server/docs/SCORING.md`.
 * Die Gewichte stammen aus dem Konzept des Nutzers (Branche 0,35 · Entscheider 0,25 · Größe 0,15 · Region 0,15 ·
 * Sonstiges 0,10). Werden echte Ergebnisse gesammelt, ersetzt ein gelerntes Modell diese Startwerte.
 */

export const ICP_WEIGHTS = { industry: 0.35, decision_maker: 0.25, company_size: 0.15, region: 0.15, presence: 0.1 } as const;
/** Gesamt = 0,7 · ICP + 0,3 · Opportunity. */
export const TOTAL_WEIGHTS = { icp: 0.7, opportunity: 0.3 } as const;

export interface ScoreInput {
  category: LeadCategory;
  /** KI-Sicherheit der Kategorie (0–1). */
  confidence: number;
  qualified: boolean;
  position: string | null;
  headline: string | null;
  location: string | null;
  website: string | null;
  /** Mitarbeiterzahl, sobald eine Quelle sie liefert (z. B. Clay) – heute meist unbekannt. */
  employees?: number | null;
  /** Social-Profile der Firma gefunden (Clay); null/fehlt = unbekannt. */
  hasSocials?: boolean | null;
  /** Meta-Pixel auf der Website (Clay); null/fehlt = unbekannt. */
  metaPixel?: boolean | null;
  metaAds: MetaAdsCheck | null;
}

const round = (value: number) => Math.round(value * 100) / 100;
const percent = (value: number) => `${Math.round(value * 100)} %`;

// ── Branche ────────────────────────────────────────────────────────────────

/** Nicht qualifizierende Kategorien: grobe Nähe zur Zielgruppe. */
const OTHER_CATEGORY_VALUES: Partial<Record<LeadCategory, number>> = {
  makler: 0.3,
  asset_manager_bestandshalter: 0.25,
  bauunternehmen_fuer_dritte: 0.25,
  hausverwaltung: 0.15,
  sonstiges: 0.1,
};

function industry(input: ScoreInput): ScoreComponent {
  const label = CATEGORY_LABELS[input.category];
  if (isQualifyingCategory(input.category)) {
    // Kernzielgruppe: Wert folgt der KI-Sicherheit (0,6 → 0,6 … 1,0 → 1,0), unter 0,6 ist sie nicht qualifiziert.
    const value = Math.min(1, Math.max(0, input.confidence));
    return { key: 'industry', label: 'Branche', weight: ICP_WEIGHTS.industry, value: round(value), detail: `${label}, KI-Sicherheit ${percent(input.confidence)}` };
  }
  const value = OTHER_CATEGORY_VALUES[input.category] ?? 0.1;
  return { key: 'industry', label: 'Branche', weight: ICP_WEIGHTS.industry, value, detail: `${label} – nicht die Kernzielgruppe` };
}

// ── Entscheider ────────────────────────────────────────────────────────────

const TOP_ROLE = /(gründer|gruender|founder|inhaber|geschäftsführ|geschaeftsfuehr|\bceo\b|vorstand|gesellschafter|managing director|\bowner\b|\bmd\b)/i;
const SALES_ROLE = /(head of sales|vertriebsleit|leiter(in)? vertrieb|sales director|director of sales|chief sales|\bcso\b|prokurist|bereichsleit|vertriebsdirektor)/i;

function decisionMaker(input: ScoreInput): ScoreComponent {
  const text = [input.position, input.headline].filter(Boolean).join(' · ');
  const base = { key: 'decision_maker' as const, label: 'Entscheider', weight: ICP_WEIGHTS.decision_maker };
  if (TOP_ROLE.test(text)) return { ...base, value: 1, detail: `Geschäftsführung/Inhaber: „${input.position ?? input.headline}“` };
  if (SALES_ROLE.test(text)) return { ...base, value: 0.6, detail: `Vertriebsleitung, nicht Geschäftsführung: „${input.position ?? input.headline}“` };
  return { ...base, value: 0.3, detail: text ? `Keine Leitungsposition erkennbar: „${input.position ?? input.headline}“` : 'Position unbekannt' };
}

// ── Firmengröße ────────────────────────────────────────────────────────────

function companySize(input: ScoreInput): ScoreComponent {
  const base = { key: 'company_size' as const, label: 'Firmengröße', weight: ICP_WEIGHTS.company_size };
  const n = input.employees;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) {
    return { ...base, value: null, detail: 'Mitarbeiterzahl unbekannt (kommt mit Clay) – zählt nicht mit' };
  }
  // Vorläufige Skala, bis die Zielgröße mit Johannes geklärt ist (siehe SCORING.md, offene Fragen).
  const value = n <= 2 ? 0.4 : n <= 10 ? 0.8 : n <= 50 ? 1 : n <= 200 ? 0.8 : n <= 1000 ? 0.6 : 0.4;
  return { ...base, value, detail: `${n} Mitarbeiter (vorläufige Skala)` };
}

// ── Region ─────────────────────────────────────────────────────────────────

const GERMANY = new RegExp(
  [
    'deutschland', 'germany', 'baden-württemberg', 'bayern', 'bavaria', 'berlin', 'brandenburg', 'bremen', 'hamburg',
    'hessen', 'mecklenburg', 'niedersachsen', 'nordrhein', 'rheinland', 'saarland', 'sachsen', 'schleswig', 'thüringen',
    'münchen', 'munich', 'köln', 'cologne', 'frankfurt', 'stuttgart', 'düsseldorf', 'dortmund', 'essen', 'leipzig',
    'dresden', 'hannover', 'nürnberg', 'duisburg', 'bochum', 'wuppertal', 'bielefeld', 'bonn', 'münster', 'mannheim',
    'karlsruhe', 'augsburg', 'wiesbaden', 'mainz', 'kiel', 'lübeck', 'rostock', 'potsdam', 'freiburg', 'heidelberg',
    'regensburg', 'erfurt', 'magdeburg', 'halle', 'braunschweig', 'aachen', 'osnabrück', 'oldenburg', 'ulm', 'würzburg',
  ].join('|'),
  'i',
);
const DACH_ABROAD = /(österreich|austria|wien|vienna|graz|linz|salzburg|innsbruck|schweiz|switzerland|zürich|zurich|basel|bern|genf|geneva|luzern|liechtenstein)/i;

function region(input: ScoreInput): ScoreComponent {
  const base = { key: 'region' as const, label: 'Region', weight: ICP_WEIGHTS.region };
  const location = input.location?.trim();
  if (!location) return { ...base, value: null, detail: 'Standort unbekannt – zählt nicht mit' };
  if (DACH_ABROAD.test(location)) return { ...base, value: 0.5, detail: `${location} – Ausland (DACH), Markt noch offen` };
  if (GERMANY.test(location)) return { ...base, value: 1, detail: `${location} – Deutschland` };
  return { ...base, value: 0.3, detail: `${location} – nicht als Deutschland erkannt` };
}

// ── Online-Präsenz ─────────────────────────────────────────────────────────

function presence(input: ScoreInput): ScoreComponent {
  const base = { key: 'presence' as const, label: 'Online-Präsenz', weight: ICP_WEIGHTS.presence };
  if (input.website) {
    const site = input.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    return { ...base, value: 1, detail: `Website vorhanden (${site})${input.hasSocials ? ' und Social-Profile' : ''}` };
  }
  if (input.hasSocials) return { ...base, value: 0.6, detail: 'Keine Website, aber Social-Profile (Clay)' };
  return { ...base, value: 0.3, detail: 'Keine Website im LinkedIn-Profil' };
}

// ── Meta-Werbung ───────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

const PIXEL_NOTE = 'Meta-Pixel auf der Website – Werbung vorbereitet oder früher geschaltet';

export function adEvidence(metaAds: MetaAdsCheck | null, website: string | null, now = Date.now(), metaPixel: boolean | null = null): AdEvidence {
  if (!metaAds || metaAds.state === 'unchecked') {
    const detail = metaAds?.note ?? 'Meta-Werbebibliothek nicht geprüft';
    return { status: 'unknown', confidence: 0, opportunity: 0.5, detail: metaPixel ? `${detail} · ${PIXEL_NOTE}` : detail };
  }
  switch (metaAds.state) {
    case 'active':
      return {
        status: 'active',
        confidence: 0.9,
        // Entscheidung 07.10.: kein Ausschluss mehr – laufende Kampagnen verbrennen oft viel Budget, das ist eine Chance.
        opportunity: 0.6,
        detail: `${metaAds.activeAds} aktive eigene Anzeige(n) – Kampagnen von Hand prüfen, oft wird dort viel Budget verbrannt`,
      };
    case 'stopped': {
      const age = metaAds.lastStop ? (now - Date.parse(metaAds.lastStop)) / DAY_MS : null;
      const recent = age !== null && age <= 365;
      return {
        status: 'historical',
        confidence: 0.85,
        opportunity: recent ? 0.9 : 0.8,
        detail: `${metaAds.ads} eigene Anzeige(n), beendet${metaAds.lastStop ? ` am ${metaAds.lastStop}` : ''} – hat es probiert, läuft nicht mehr`,
      };
    }
    case 'none': {
      // Ohne Website-Domain kann der Abgleich eigene Anzeigen schlechter erkennen; namensgleiche Fremdtreffer machen unsicher.
      let confidence = website ? 0.7 : 0.55;
      if (metaAds.foreignAds > 0) confidence -= 0.1;
      const detail = `Keine eigenen Anzeigen gefunden${metaAds.foreignAds ? ` (${metaAds.foreignAds} Fremdtreffer ignoriert)` : ''} – nicht ganz sicher „nie“`;
      // Pixel ohne laufende Anzeigen: Interesse an Paid Social ist belegt, es läuft aber nichts – etwas bessere Chance.
      return metaPixel
        ? { status: 'none_found', confidence: round(confidence), opportunity: 0.85, detail: `${detail} · ${PIXEL_NOTE}` }
        : { status: 'none_found', confidence: round(confidence), opportunity: 0.8, detail };
    }
  }
}

function leadTypeOf(ads: AdEvidence): LeadType {
  switch (ads.status) {
    case 'active':
      return 'active';
    case 'historical':
      return 'reactivation';
    case 'none_found':
      return ads.confidence >= 0.6 ? 'greenfield' : 'unclear';
    case 'unknown':
      return 'unclear';
  }
}

// ── Gesamt ─────────────────────────────────────────────────────────────────

export function scoreLead(input: ScoreInput, now = Date.now()): LeadScore {
  const components = [industry(input), decisionMaker(input), companySize(input), region(input), presence(input)];
  const known = components.filter((component) => component.value !== null);
  const knownWeight = known.reduce((sum, component) => sum + component.weight, 0);
  const icpScore = knownWeight > 0 ? known.reduce((sum, component) => sum + component.weight * (component.value as number), 0) / knownWeight : 0;

  const ads = adEvidence(input.metaAds, input.website, now, input.metaPixel ?? null);
  const total = TOTAL_WEIGHTS.icp * icpScore + TOTAL_WEIGHTS.opportunity * ads.opportunity;

  const dm = components[1].value ?? 0;
  const regionValue = components[3].value;
  const hardFilters: HardFilterCheck[] = [
    { key: 'industry', label: 'Branche passt', passed: input.qualified, detail: components[0].detail },
    {
      key: 'region',
      label: 'Deutschland',
      passed: regionValue === null ? null : regionValue >= 1,
      detail: components[3].detail,
    },
    { key: 'decision_maker', label: 'Entscheider gefunden', passed: dm >= 1, detail: components[1].detail },
    {
      key: 'active',
      label: 'Firma aktiv',
      passed: input.website || input.employees ? true : null,
      detail: input.website ? 'Website vorhanden' : input.employees ? `${input.employees} Mitarbeiter laut Clay` : 'Nicht geprüft (keine Website bekannt)',
    },
  ];

  return {
    version: SCORE_VERSION,
    total: round(total),
    tier: scoreTier(total),
    icp: { score: round(icpScore), tier: scoreTier(icpScore), components },
    hardFilters,
    ads,
    leadType: leadTypeOf(ads),
    completeness: round(knownWeight),
    scoredAt: now,
  };
}
