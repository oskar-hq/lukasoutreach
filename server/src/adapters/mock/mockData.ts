/**
 * Simulierte Suchtreffer. Alle Personen, Firmen und Websites sind frei erfunden.
 *
 * Reihenfolge = Relevanz der Suche. Mischung über alle 40 Treffer:
 * 12 qualifiziert (30 %) · 4 Dubletten (Demo-Leads) · 3 offene Anfragen · 6 Makler · 5 Hausverwaltungen ·
 * 4 Bauunternehmen für Dritte · 3 Asset Manager/Bestandshalter · 3 Sonstige (davon einer „zu unsicher“).
 * Unter den ersten 15 eindeutigen Treffern (Standard-Limit) passen 7 Firmen, davon schalten 2 gerade Meta-Ads →
 * Trichter 40 → 33 → 15 → 7 → 5. Mit Limit 25: 10 passende Firmen, 3 mit aktiven Ads → 7.
 * KI-Vorprüfung (Headline): die letzten beiden Treffer (Hausverwaltung, Makler) fliegen ohne Profilabruf raus, alle
 * anderen gelten als „passt vermutlich“ – sie liegen hinter Platz 25, darum bleiben die Zahlen oben gleich
 * (40 → 33 → 31 vorgeprüft → 15 → 7 → 5).
 * Hiring-Signal (13.10.): Henrik Vossberg (Firmenbeschreibung „Wir suchen … (m/w/d)“) und Daniel Freiberger (KI).
 */

import type { EnrichedProfile, NetworkDistance, PrescreenVerdict, SearchHit } from '../../../../shared/leadSearch.js';
import type { QualificationOutput } from '../../qualify/schema.js';

/** Simulierter Stand in der Meta-Werbebibliothek (ohne Angabe: keine Anzeigen). */
export interface MockAds {
  /** Eigene Anzeigen insgesamt. */
  total: number;
  /** Davon laufen gerade so viele. */
  active?: number;
  /** Ohne aktive Anzeigen: vor so vielen Tagen endete die letzte. */
  stoppedDaysAgo?: number;
  /** Anzeigen anderer Werbetreibender, die zum Firmennamen passen (Fremdtreffer). */
  foreign?: number;
}

export interface MockLead {
  hit: SearchHit;
  profile: EnrichedProfile;
  /** Simulierte Rohausgabe des Sprachmodells – läuft durch dieselbe Validierung wie im Live-Modus. */
  ai: QualificationOutput;
  ads?: MockAds;
  /** Simuliert eine offene Vernetzungsanfrage (wie GET /users/invite/sent im Live-Modus). */
  openInvitation?: boolean;
  /** Simuliertes Urteil der KI-Vorprüfung (ohne Angabe: „passt vermutlich“). */
  prescreen?: PrescreenVerdict;
}

/** Provider-IDs der Demo-Leads, die in der Suche erneut auftauchen (siehe src/data/leads.ts). */
export const DEMO_PROVIDER_IDS = {
  n01: 'ACoAAtqQ1U4x8BPqF5j9Uf9CFX8uLTfI6WjuR',
  n03: 'ACoAAu5pnCm6XRXA3rZgGk5XoFTp3eDcwQjEA',
  n05: 'ACoAAlHwtBxGXGIgJV1XL2HbFYoxjeedWWcGt',
  j15: 'ACoAAABrjIvGWGezsCD3LLCCqwFN0Jx7kcmUn',
} as const;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Stabile, LinkedIn-ähnliche Fantasie-ID. */
function fakeProviderId(seed: string): string {
  let hash = 2166136261;
  let id = 'ACoAA';
  for (let i = 0; i < 34; i++) {
    hash ^= seed.charCodeAt(i % seed.length) + i;
    hash = Math.imul(hash, 16777619) >>> 0;
    id += ALPHABET[hash % ALPHABET.length];
  }
  return id;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface Entry {
  first: string;
  last: string;
  position: string;
  company: string;
  city: string;
  distance: NetworkDistance;
  headline: string;
  description: string;
  website?: string;
  industry: string;
  ai: QualificationOutput;
  ads?: MockAds;
  providerId?: string;
  openInvitation?: boolean;
  prescreen?: PrescreenVerdict;
}

function build(entry: Entry): MockLead {
  const publicIdentifier = `${slug(`${entry.first}-${entry.last}`)}-${fakeProviderId(entry.company).slice(5, 11).toLowerCase()}`;
  return {
    hit: {
      providerId: entry.providerId ?? fakeProviderId(`${entry.first} ${entry.last} ${entry.company}`),
      publicIdentifier,
      firstName: entry.first,
      lastName: entry.last,
      headline: entry.headline,
      location: entry.city,
      networkDistance: entry.distance,
      profileUrl: `https://www.linkedin.com/in/${publicIdentifier}`,
    },
    profile: {
      headline: entry.headline,
      position: entry.position,
      companyName: entry.company,
      companyDescription: entry.description,
      companyWebsite: entry.website ?? null,
      companyIndustry: entry.industry,
      location: entry.city,
    },
    ai: entry.ai,
    ads: entry.ads,
    openInvitation: entry.openInvitation,
    prescreen: entry.prescreen,
  };
}

const ka = (confidence: number, reason: string, summary: string): QualificationOutput => ({
  category: 'kapitalanlage_vertrieb',
  qualified: true,
  confidence,
  reason,
  summary,
  hiringRole: null,
});
const bt = (confidence: number, reason: string, summary: string): QualificationOutput => ({
  category: 'bautraeger_projektentwickler',
  qualified: true,
  confidence,
  reason,
  summary,
  hiringRole: null,
});
const fdl = (confidence: number, reason: string, summary: string): QualificationOutput => ({
  category: 'finanzdienstleister',
  qualified: true,
  confidence,
  reason,
  summary,
  hiringRole: null,
});
const no = (category: QualificationOutput['category'], confidence: number, reason: string, summary: string): QualificationOutput => ({
  category,
  qualified: false,
  confidence,
  reason,
  summary,
  hiringRole: null,
});

const ENTRIES: Entry[] = [
  // 1
  {
    first: 'Henrik',
    last: 'Vossberg',
    position: 'Geschäftsführer',
    company: 'Vossberg Anlageimmobilien GmbH',
    city: 'Hamburg',
    distance: 2,
    headline: 'Geschäftsführer · Kapitalanlage-Immobilien für Ärzte und Unternehmer',
    description: 'Vertrieb von Neubau- und Denkmal-Kapitalanlagen in Norddeutschland, eigenes Beraterteam mit 15 Mitarbeitenden. Wir suchen Vertriebsmitarbeiter (m/w/d) für Hamburg und Bremen.',
    website: 'vossberg-anlageimmobilien.de',
    industry: 'Immobilien',
    ai: ka(
      0.94,
      'Vertreibt Kapitalanlage-Immobilien direkt an Endkunden mit eigenem Beraterteam.',
      'Kapitalanlage-Vertrieb aus Hamburg mit rund 15 Beratern, Fokus auf Neubau und Denkmal für Ärzte und Unternehmer. Henrik Vossberg führt das Unternehmen selbst und ist damit direkter Entscheider.',
    ),
  },
  // 2 – Dublette (Demo-Lead n01)
  {
    providerId: DEMO_PROVIDER_IDS.n01,
    first: 'Tobias',
    last: 'Brehm',
    position: 'Geschäftsführer',
    company: 'Lindqvist & Brehm Anlageimmobilien GmbH',
    city: 'Hamburg',
    distance: 2,
    headline: 'Geschäftsführer bei Lindqvist & Brehm Anlageimmobilien',
    description: 'Vertrieb von Denkmal- und Neubau-Kapitalanlagen an Gutverdiener in Norddeutschland.',
    industry: 'Immobilien',
    ai: ka(0.93, 'Eigener Vertrieb von Kapitalanlage-Immobilien.', 'Kapitalanlage-Vertrieb aus Hamburg. Bereits im Cockpit.'),
  },
  // 3
  {
    first: 'Johanna',
    last: 'Achterberg',
    position: 'Geschäftsführende Gesellschafterin',
    company: 'Achterberg Wohnbau GmbH & Co. KG',
    ads: { total: 5, active: 2 },
    city: 'Münster',
    distance: 2,
    headline: 'Geschäftsführende Gesellschafterin · Wohnungsbau im Münsterland',
    description: 'Bauträger für Mehrfamilienhäuser und Reihenhäuser im Münsterland, Vertrieb der Wohnungen in Eigenregie.',
    website: 'achterberg-wohnbau.de',
    industry: 'Bauwesen',
    ai: bt(
      0.91,
      'Baut und verkauft eigene Wohnprojekte als Bauträger mit Eigenvertrieb.',
      'Bauträger aus Münster mit mehreren Mehrfamilienhaus-Projekten pro Jahr, die Wohnungen werden selbst vermarktet. Als geschäftsführende Gesellschafterin entscheidet Johanna Achterberg über Vertrieb und Marketing.',
    ),
  },
  // 4
  {
    first: 'Sven',
    last: 'Rautenberg',
    position: 'Inhaber',
    company: 'Rautenberg Immobilien',
    city: 'Kiel',
    distance: 3,
    headline: 'Inhaber · Ihr Immobilienmakler in Kiel und Umgebung',
    description: 'Maklerbüro für den Verkauf und die Vermietung von Wohnimmobilien, Schwerpunkt Eigentümer-Akquise.',
    website: 'rautenberg-immobilien-kiel.de',
    industry: 'Immobilien',
    ai: no(
      'makler',
      0.88,
      'Klassisches Maklerbüro, das Objekte von Eigentümern vermittelt – kein eigener Kapitalanlage-Vertrieb.',
      'Maklerbüro aus Kiel für Verkauf und Vermietung von Wohnimmobilien. Akquiriert vor allem Eigentümer, eigene Projekte oder Kapitalanlage-Produkte sind nicht erkennbar.',
    ),
  },
  // 5
  {
    first: 'Daniel',
    last: 'Freiberger',
    position: 'Gründer & CEO',
    company: 'Freiberger Capital Estates GmbH',
    ads: { total: 4, stoppedDaysAgo: 19 },
    city: 'München',
    distance: 2,
    headline: 'Gründer & CEO · Vermögensaufbau mit Immobilien',
    description: 'Vertrieb von Kapitalanlage-Wohnungen an Angestellte und Selbstständige, Beratung zu Finanzierung und Steuervorteilen.',
    website: 'freiberger-capital.de',
    industry: 'Finanzdienstleistungen',
    // Hiring-Signal aus der KI-Bewertung (die Beschreibung allein reicht der Erkennung ohne KI nicht).
    ai: {
      ...ka(
        0.89,
        'Vertreibt Kapitalanlage-Wohnungen mit Finanzierungs- und Steuerberatung an Privatanleger.',
        'Münchner Kapitalanlage-Vertrieb, der Wohnungen als Altersvorsorge an Angestellte und Selbstständige verkauft. Der Gründer tritt selbst als Gesicht der Marke auf und verantwortet den Vertrieb.',
      ),
      hiringRole: 'Immobilienberater (m/w/d)',
    },
  },
  // 6
  {
    first: 'Petra',
    last: 'Lohmeier',
    position: 'Geschäftsführerin',
    company: 'Lohmeier Hausverwaltung GmbH',
    city: 'Augsburg',
    distance: 3,
    headline: 'Geschäftsführerin · WEG- und Mietverwaltung',
    description: 'Verwaltung von rund 1.400 Wohneinheiten in Augsburg und Umgebung.',
    website: 'lohmeier-hausverwaltung.de',
    industry: 'Immobilienverwaltung',
    ai: no(
      'hausverwaltung',
      0.93,
      'Reine WEG- und Mietverwaltung ohne Vertrieb von Immobilien.',
      'Hausverwaltung aus Augsburg mit rund 1.400 verwalteten Einheiten. Ein Verkauf von Immobilien oder eigene Projekte sind nicht erkennbar.',
    ),
  },
  // 7 – offene Vernetzungsanfrage
  {
    openInvitation: true,
    first: 'Jens',
    last: 'Holtkamp',
    position: 'Geschäftsführer',
    company: 'Holtkamp Kapitalimmobilien GmbH',
    city: 'Osnabrück',
    distance: 2,
    headline: 'Geschäftsführer · Kapitalanlagen mit Substanz',
    description: 'Vertrieb von Bestands- und Neubauwohnungen als Kapitalanlage.',
    industry: 'Immobilien',
    ai: ka(0.9, 'Kapitalanlage-Vertrieb.', 'Kapitalanlage-Vertrieb aus Osnabrück. Anfrage bereits gesendet.'),
  },
  // 8
  {
    first: 'Konstantin',
    last: 'Weller',
    position: 'Geschäftsführer',
    company: 'Weller Quartiersentwicklung GmbH',
    ads: { total: 0, foreign: 3 },
    city: 'Leipzig',
    distance: 2,
    headline: 'Geschäftsführer · Wir entwickeln Wohnquartiere in Mitteldeutschland',
    description: 'Projektentwickler für Wohnquartiere mit 40 bis 120 Einheiten, Verkauf an Eigennutzer und Kapitalanleger.',
    website: 'weller-quartiere.de',
    industry: 'Immobilienentwicklung',
    ai: bt(
      0.87,
      'Entwickelt eigene Wohnquartiere und verkauft die Einheiten an Eigennutzer und Anleger.',
      'Projektentwickler aus Leipzig mit Quartieren von 40 bis 120 Wohnungen. Verkauft an Eigennutzer und Kapitalanleger und braucht dafür laufend Käuferanfragen.',
    ),
  },
  // 9
  {
    first: 'Ralf',
    last: 'Overbeck',
    position: 'Geschäftsführer',
    company: 'Overbeck Bau GmbH',
    city: 'Paderborn',
    distance: 3,
    headline: 'Geschäftsführer · Generalunternehmer für Wohn- und Gewerbebau',
    description: 'Generalunternehmer, der Wohn- und Gewerbeobjekte schlüsselfertig im Auftrag von Investoren errichtet.',
    website: 'overbeck-bau.de',
    industry: 'Bauwesen',
    ai: no(
      'bauunternehmen_fuer_dritte',
      0.84,
      'Baut als Generalunternehmer im Auftrag Dritter und vermarktet keine eigenen Projekte.',
      'Generalunternehmer aus Paderborn, der schlüsselfertig für Investoren baut. Vertrieb und Vermarktung liegen beim jeweiligen Auftraggeber.',
    ),
  },
  // 10
  {
    first: 'Sabrina',
    last: 'Kettler',
    position: 'Inhaberin',
    company: 'Kettler Invest & Immobilien',
    ads: { total: 3, active: 3 },
    city: 'Nürnberg',
    distance: 3,
    headline: 'Inhaberin · Kapitalanlage-Immobilien in Franken',
    description: 'Vermittlung von Kapitalanlage-Wohnungen aus Neubauprojekten mehrerer Bauträger an Privatanleger.',
    website: 'kettler-invest.de',
    industry: 'Immobilien',
    ai: ka(
      0.82,
      'Vertreibt Kapitalanlage-Wohnungen aus Neubauprojekten gezielt an Privatanleger.',
      'Kapitalanlage-Vertrieb aus Nürnberg, der Neubauwohnungen mehrerer Bauträger an Privatanleger verkauft. Kleines Team, die Inhaberin führt den Vertrieb selbst.',
    ),
  },
  // 11 – Grenzfall: Makler mit etwas Kapitalanlage
  {
    first: 'Bernd',
    last: 'Brandstätter',
    position: 'Inhaber',
    company: 'Brandstätter Immobilienvermittlung',
    city: 'Regensburg',
    distance: 2,
    headline: 'Inhaber · Verkauf, Vermietung, Kapitalanlage',
    description: 'Immobilienvermittlung für Eigentümer, vereinzelt Kapitalanlage-Angebote aus dem Bestand.',
    industry: 'Immobilien',
    ai: no(
      'makler',
      0.64,
      'Vermittelt überwiegend Bestandsobjekte für Eigentümer, Kapitalanlagen sind nur ein Nebengeschäft.',
      'Immobilienvermittlung aus Regensburg mit Schwerpunkt auf Eigentümer-Aufträgen. Kapitalanlagen tauchen nur vereinzelt im Angebot auf.',
    ),
  },
  // 12 – Dublette (Demo-Lead n05)
  {
    providerId: DEMO_PROVIDER_IDS.n05,
    first: 'Stefan',
    last: 'Kaltwasser',
    position: 'Geschäftsführer',
    company: 'Kaltwasser Kapitalpartner GmbH',
    city: 'Düsseldorf',
    distance: 2,
    headline: 'Geschäftsführer bei Kaltwasser Kapitalpartner',
    description: 'Familiengeführter Kapitalanlage-Vertrieb mit Fokus auf Neubau-Apartments.',
    industry: 'Immobilien',
    ai: ka(0.92, 'Kapitalanlage-Vertrieb.', 'Kapitalanlage-Vertrieb aus Düsseldorf. Bereits im Cockpit.'),
  },
  // 13
  {
    first: 'Thorsten',
    last: 'Albrecht-Nolte',
    position: 'Vorstand',
    company: 'Nordlicht Wohnbau AG',
    ads: { total: 2, stoppedDaysAgo: 160 },
    city: 'Bremen',
    distance: 3,
    headline: 'Vorstand · Neubauprojekte in Bremen und Niedersachsen',
    description: 'Bauträger mit jährlich rund 200 Wohneinheiten, Vertrieb über eigenes Team und Vertriebspartner.',
    website: 'nordlicht-wohnbau.de',
    industry: 'Immobilienentwicklung',
    ai: bt(
      0.9,
      'Bauträger mit rund 200 eigenen Wohneinheiten pro Jahr und eigenem Vertrieb.',
      'Bauträger aus Bremen mit etwa 200 Wohneinheiten im Jahr. Vertreibt über ein eigenes Team und Partner – hoher Bedarf an planbaren Käuferanfragen.',
    ),
  },
  // 14
  {
    first: 'Charlotte',
    last: 'von Imhoff',
    position: 'Geschäftsführerin',
    company: 'Imhoff Family Office GmbH',
    city: 'Frankfurt am Main',
    distance: 3,
    headline: 'Geschäftsführerin · Family Office mit Immobilienfokus',
    description: 'Verwaltet das Vermögen einer Unternehmerfamilie, Schwerpunkt Wohn- und Geschäftshäuser im Bestand.',
    industry: 'Vermögensverwaltung',
    ai: no(
      'asset_manager_bestandshalter',
      0.86,
      'Family Office, das Immobilien im eigenen Bestand hält und nicht an Endkunden verkauft.',
      'Family Office aus Frankfurt mit Wohn- und Geschäftshäusern im Bestand. Kauft eher selbst an, als Immobilien an Anleger zu vertreiben.',
    ),
  },
  // 15
  {
    first: 'Uwe',
    last: 'Kranich',
    position: 'Inhaber',
    company: 'Kranich WEG-Verwaltung',
    city: 'Kassel',
    distance: 2,
    headline: 'Inhaber · WEG-Verwaltung mit Herz',
    description: 'WEG-Verwaltung für rund 60 Eigentümergemeinschaften in Nordhessen.',
    industry: 'Immobilienverwaltung',
    ai: no(
      'hausverwaltung',
      0.9,
      'WEG-Verwaltung ohne eigenen Immobilienvertrieb.',
      'WEG-Verwaltung aus Kassel mit rund 60 Eigentümergemeinschaften. Kein Verkauf von Immobilien erkennbar.',
    ),
  },
  // 16
  {
    first: 'Marcel',
    last: 'Höfling',
    position: 'Geschäftsführer',
    company: 'Höfling Vermögensimmobilien GmbH',
    city: 'Stuttgart',
    distance: 2,
    headline: 'Geschäftsführer · Immobilien als Kapitalanlage für Fachkräfte',
    description: 'Kapitalanlage-Vertrieb mit Online-Beratung, rund 25 Vertriebspartner in Süddeutschland.',
    website: 'hoefling-vermoegensimmobilien.de',
    industry: 'Finanzdienstleistungen',
    ai: ka(
      0.86,
      'Kapitalanlage-Vertrieb mit eigenem Partnernetz und Online-Beratung.',
      'Stuttgarter Kapitalanlage-Vertrieb mit etwa 25 Vertriebspartnern und Online-Erstberatung. Zielgruppe sind gut verdienende Fachkräfte – passt genau ins Leadprofil.',
    ),
  },
  // 17
  {
    first: 'Andrea',
    last: 'Kowalczyk',
    position: 'Geschäftsführerin',
    company: 'Kowalczyk Hochbau GmbH',
    city: 'Dortmund',
    distance: 3,
    headline: 'Geschäftsführerin · Rohbau und Hochbau für Bauträger',
    description: 'Hochbauunternehmen, das Rohbauten für Bauträger und Generalunternehmer im Ruhrgebiet erstellt.',
    industry: 'Bauwesen',
    ai: no(
      'bauunternehmen_fuer_dritte',
      0.81,
      'Erstellt Rohbauten im Auftrag von Bauträgern, ohne eigene Projekte zu vermarkten.',
      'Hochbauunternehmen aus Dortmund, das als Nachunternehmer für Bauträger arbeitet. Eigene Projekte oder Vertrieb sind nicht erkennbar.',
    ),
  },
  // 18
  {
    first: 'Felix',
    last: 'Jürgensen',
    position: 'Gründer',
    company: 'Jürgensen & Partner Immobilien',
    city: 'Flensburg',
    distance: 2,
    headline: 'Gründer · Immobilienmakler an der Förde',
    description: 'Maklerunternehmen für Wohn- und Ferienimmobilien an der Ostseeküste.',
    industry: 'Immobilien',
    ai: no(
      'makler',
      0.85,
      'Maklerunternehmen für Wohn- und Ferienimmobilien ohne eigenes Kapitalanlage-Angebot.',
      'Makler aus Flensburg mit Schwerpunkt Wohn- und Ferienimmobilien. Vermittelt Objekte von Eigentümern, keine eigenen Projekte.',
    ),
  },
  // 19 – offene Vernetzungsanfrage
  {
    openInvitation: true,
    first: 'Birgit',
    last: 'Assmann',
    position: 'Geschäftsführerin',
    company: 'Assmann Projektbau GmbH',
    city: 'Dresden',
    distance: 2,
    headline: 'Geschäftsführerin · Wohnprojekte in Sachsen',
    description: 'Bauträger für Eigentumswohnungen in Dresden.',
    industry: 'Bauwesen',
    ai: bt(0.88, 'Bauträger.', 'Bauträger aus Dresden. Anfrage bereits gesendet.'),
  },
  // 20 – Finanzdienstleister (seit 27.10. Zielgruppe, vorher Bauträger Hauk Wohnprojekte)
  {
    first: 'Nils',
    last: 'Petersen-Hauk',
    position: 'Geschäftsführer',
    company: 'Hauk Finanzpartner GmbH',
    city: 'Hannover',
    distance: 2,
    headline: 'Geschäftsführer · Finanzdienstleister für Vorsorge und Vermögensaufbau',
    description: 'Unabhängiger Finanzdienstleister mit 25 Beratern in Niedersachsen: Altersvorsorge, private Krankenversicherung, Baufinanzierung und Immobilien als Kapitalanlage.',
    website: 'hauk-finanzpartner.de',
    industry: 'Finanzdienstleistungen',
    ai: fdl(
      0.88,
      'Finanzdienstleister mit eigenem Beraterteam und Immobiliensegment, Person ist Geschäftsführer.',
      'Finanzdienstleister aus Hannover mit rund 25 Beratern für Vorsorge, PKV und Kapitalanlage-Immobilien. Nils Petersen-Hauk führt die Firma und entscheidet selbst.',
    ),
  },
  // 21 – Kategorie passt, aber zu unsicher (strenge Regel)
  {
    first: 'Rüdiger',
    last: 'Falkner',
    position: 'Gesellschafter',
    company: 'Falkner Finanz & Immobilien GmbH',
    city: 'Mannheim',
    distance: 3,
    headline: 'Gesellschafter · Versicherungen, Finanzierung, Immobilien',
    description: 'Finanzberatung mit Versicherungen, Baufinanzierung und gelegentlicher Vermittlung von Anlageimmobilien.',
    industry: 'Finanzdienstleistungen',
    ai: {
      category: 'kapitalanlage_vertrieb',
      qualified: false,
      confidence: 0.52,
      reason: 'Vermittelt gelegentlich Anlageimmobilien, der Schwerpunkt liegt aber auf Versicherungen und Finanzierung.',
      summary:
        'Finanzberatung aus Mannheim mit Versicherungen und Baufinanzierung. Anlageimmobilien werden nur gelegentlich vermittelt – kein klarer Kapitalanlage-Vertrieb.',

      hiringRole: null,
    },
  },
  // 22
  {
    first: 'Gisela',
    last: 'Brenninger',
    position: 'Geschäftsführerin',
    company: 'Brenninger Immobilienverwaltung GmbH',
    city: 'Chemnitz',
    distance: 3,
    headline: 'Geschäftsführerin · Miet- und WEG-Verwaltung',
    description: 'Miet- und WEG-Verwaltung für private Eigentümer und Wohnungsgesellschaften.',
    industry: 'Immobilienverwaltung',
    ai: no(
      'hausverwaltung',
      0.92,
      'Hausverwaltung für Eigentümer, kein Verkauf von Immobilien.',
      'Hausverwaltung aus Chemnitz für private Eigentümer und Wohnungsgesellschaften. Ein Vertrieb von Immobilien ist nicht erkennbar.',
    ),
  },
  // 23 – Dublette (Demo-Lead n03)
  {
    providerId: DEMO_PROVIDER_IDS.n03,
    first: 'Ralf',
    last: 'Ostermann',
    position: 'Inhaber & Geschäftsführer',
    company: 'Rotdorn Kapitalanlagen GmbH',
    city: 'Bielefeld',
    distance: 2,
    headline: 'Inhaber & Geschäftsführer bei Rotdorn Kapitalanlagen',
    description: 'Kapitalanlage-Vertrieb mit Schwerpunkt auf Bestandsimmobilien in NRW.',
    industry: 'Immobilien',
    ai: ka(0.9, 'Kapitalanlage-Vertrieb.', 'Kapitalanlage-Vertrieb aus Bielefeld. Bereits im Cockpit.'),
  },
  // 24
  {
    first: 'Yasemin',
    last: 'Kaya',
    position: 'Geschäftsführerin',
    company: 'Kaya Real Invest GmbH',
    ads: { total: 6, active: 1 },
    city: 'Köln',
    distance: 2,
    headline: 'Geschäftsführerin · Kapitalanlage-Immobilien im Rheinland',
    description: 'Vertrieb von Neubau-Kapitalanlagen im Rheinland, Beratung auf Deutsch und Türkisch.',
    website: 'kaya-realinvest.de',
    industry: 'Immobilien',
    ai: ka(
      0.85,
      'Vertreibt Neubau-Kapitalanlagen an Privatanleger im Rheinland.',
      'Kapitalanlage-Vertrieb aus Köln mit Neubauwohnungen im Rheinland. Berät zweisprachig und baut gerade das Vertriebsteam aus.',
    ),
  },
  // 25
  {
    first: 'Holger',
    last: 'Siebrecht',
    position: 'Inhaber',
    company: 'Siebrecht Immobilien e. K.',
    city: 'Lübeck',
    distance: 3,
    headline: 'Inhaber · Immobilienmakler seit 1998',
    description: 'Maklerbüro für Wohnimmobilien in Lübeck und Ostholstein.',
    industry: 'Immobilien',
    ai: no(
      'makler',
      0.87,
      'Klassisches Maklerbüro für Wohnimmobilien von Eigentümern.',
      'Maklerbüro aus Lübeck für Wohnimmobilien. Vermittelt im Auftrag von Eigentümern, eigene Kapitalanlage-Produkte sind nicht erkennbar.',
    ),
  },
  // 26
  {
    first: 'Tim',
    last: 'Behrendt',
    position: 'Gründer & CEO',
    company: 'Mietwerk Software GmbH',
    city: 'Berlin',
    distance: 2,
    headline: 'Gründer & CEO · Software für Vermieter',
    description: 'PropTech-Startup mit einer Software für private Vermieter und kleine Hausverwaltungen.',
    industry: 'Software',
    ai: no(
      'sonstiges',
      0.9,
      'Software-Anbieter für Vermieter, kein Vertrieb oder Bau von Immobilien.',
      'PropTech-Startup aus Berlin mit Software für private Vermieter. Kein Immobilienvertrieb und keine eigenen Projekte.',
    ),
  },
  // 27
  {
    first: 'Martin',
    last: 'Ellerbrock',
    position: 'Vorstand',
    company: 'Ellerbrock Wohnen AG',
    city: 'Bochum',
    distance: 3,
    headline: 'Vorstand · Wohnungsbestand im Ruhrgebiet',
    description: 'Bestandshalter mit rund 3.000 Mietwohnungen im Ruhrgebiet, Ankauf und Modernisierung.',
    industry: 'Immobilien',
    ai: no(
      'asset_manager_bestandshalter',
      0.83,
      'Hält Mietwohnungen im eigenen Bestand und verkauft nicht an Anleger.',
      'Bestandshalter aus Bochum mit rund 3.000 Mietwohnungen. Wächst über Ankauf und Modernisierung, nicht über Verkauf an Endkunden.',
    ),
  },
  // 28
  {
    first: 'Corinna',
    last: 'Wendt',
    position: 'Geschäftsführende Gesellschafterin',
    company: 'Wendt & Söhne Projektentwicklung GmbH',
    ads: { total: 7, stoppedDaysAgo: 45 },
    city: 'Potsdam',
    distance: 2,
    headline: 'Geschäftsführende Gesellschafterin · Wohnen in Potsdam und Berlin',
    description: 'Projektentwicklung von Stadtvillen und Mehrfamilienhäusern, Verkauf der Wohnungen in Eigenregie.',
    website: 'wendt-projektentwicklung.de',
    industry: 'Immobilienentwicklung',
    ai: bt(
      0.86,
      'Entwickelt eigene Wohnprojekte und verkauft die Wohnungen selbst.',
      'Projektentwicklerin aus Potsdam mit Stadtvillen und Mehrfamilienhäusern. Vermarktet die Wohnungen selbst und sucht laufend Käufer.',
    ),
  },
  // 29
  {
    first: 'Murat',
    last: 'Yildiz',
    position: 'Geschäftsführer',
    company: 'Yildiz Rohbau GmbH',
    city: 'Duisburg',
    distance: 3,
    headline: 'Geschäftsführer · Rohbau für Wohn- und Gewerbebau',
    description: 'Rohbauunternehmen mit 45 Mitarbeitenden, tätig für Bauträger und private Bauherren.',
    industry: 'Bauwesen',
    ai: no(
      'bauunternehmen_fuer_dritte',
      0.88,
      'Rohbauunternehmen im Auftrag Dritter ohne eigene Projekte.',
      'Rohbauunternehmen aus Duisburg mit 45 Mitarbeitenden. Arbeitet für Bauträger und private Bauherren, vermarktet nichts selbst.',
    ),
  },
  // 30 – Dublette (Demo-Lead j15)
  {
    providerId: DEMO_PROVIDER_IDS.j15,
    first: 'Lena',
    last: 'Hartwig',
    position: 'Geschäftsführerin',
    company: 'Hartwig Baukontor GmbH',
    city: 'Rostock',
    distance: 2,
    headline: 'Geschäftsführerin bei Hartwig Baukontor',
    description: 'Bauträger mit Doppelhaus- und Wohnungsprojekten in Rostock.',
    industry: 'Bauwesen',
    ai: bt(0.86, 'Bauträger.', 'Bauträger aus Rostock. Bereits im Cockpit.'),
  },
  // 31
  {
    first: 'Stephan',
    last: 'Weidlich',
    position: 'Inhaber',
    company: 'Weidlich Hausverwaltungen',
    city: 'Wiesbaden',
    distance: 2,
    headline: 'Inhaber · Hausverwaltung im Rhein-Main-Gebiet',
    description: 'Miet- und WEG-Verwaltung für rund 800 Einheiten.',
    industry: 'Immobilienverwaltung',
    ai: no(
      'hausverwaltung',
      0.89,
      'Hausverwaltung ohne Immobilienvertrieb.',
      'Hausverwaltung aus Wiesbaden mit rund 800 Einheiten. Kein Verkauf von Immobilien erkennbar.',
    ),
  },
  // 32
  {
    first: 'Fabian',
    last: 'Reuter',
    position: 'Gründer',
    company: 'Reuter Capital Homes GmbH',
    ads: { total: 0, foreign: 1 },
    city: 'Mainz',
    distance: 3,
    headline: 'Gründer · Kapitalanlage-Wohnungen für Berufseinsteiger',
    description: 'Vertrieb von Kapitalanlage-Wohnungen mit Online-Beratung an junge Berufstätige.',
    website: 'reuter-capital-homes.de',
    industry: 'Immobilien',
    ai: ka(
      0.84,
      'Vertreibt Kapitalanlage-Wohnungen online an junge Berufstätige.',
      'Kapitalanlage-Vertrieb aus Mainz mit Online-Beratung für junge Berufstätige. Wächst schnell und gewinnt Kunden vor allem über Social Media.',
    ),
  },
  // 33
  {
    first: 'Katrin',
    last: 'Oberländer',
    position: 'Inhaberin',
    company: 'Oberländer Steuerberatung',
    city: 'Freiburg im Breisgau',
    distance: 3,
    headline: 'Inhaberin · Steuerberatung für Immobilieninvestoren',
    description: 'Steuerkanzlei mit Schwerpunkt auf Vermietung und Immobilieninvestments.',
    industry: 'Steuerberatung',
    ai: no(
      'sonstiges',
      0.91,
      'Steuerkanzlei mit Immobilienschwerpunkt, aber ohne eigenen Vertrieb von Immobilien.',
      'Steuerkanzlei aus Freiburg mit Schwerpunkt Vermietung und Immobilieninvestments. Berät Anleger, verkauft aber selbst keine Immobilien.',
    ),
  },
  // 34 – offene Vernetzungsanfrage
  {
    openInvitation: true,
    first: 'Moritz',
    last: 'Lenhardt',
    position: 'CEO',
    company: 'Lenhardt Wohnwert GmbH',
    city: 'Karlsruhe',
    distance: 2,
    headline: 'CEO · Kapitalanlagen in Baden',
    description: 'Vertrieb von Kapitalanlage-Wohnungen in Baden.',
    industry: 'Immobilien',
    ai: ka(0.87, 'Kapitalanlage-Vertrieb.', 'Kapitalanlage-Vertrieb aus Karlsruhe. Anfrage bereits gesendet.'),
  },
  // 35
  {
    first: 'Ingo',
    last: 'Paschke',
    position: 'Geschäftsführer',
    company: 'Paschke Immobilienmakler GmbH',
    city: 'Magdeburg',
    distance: 3,
    headline: 'Geschäftsführer · Immobilien verkaufen in Magdeburg',
    description: 'Maklerunternehmen für Verkauf und Bewertung von Wohnimmobilien.',
    industry: 'Immobilien',
    ai: no(
      'makler',
      0.83,
      'Makler für Verkauf und Bewertung im Auftrag von Eigentümern.',
      'Maklerunternehmen aus Magdeburg mit Fokus auf Verkauf und Bewertung. Eigene Projekte oder Kapitalanlage-Produkte sind nicht erkennbar.',
    ),
  },
  // 36
  {
    first: 'Annika',
    last: 'Thalheim',
    position: 'Geschäftsführerin',
    company: 'Thalheim Asset Management GmbH',
    city: 'Hamburg',
    distance: 3,
    headline: 'Geschäftsführerin · Asset Management für Wohnportfolios',
    description: 'Asset Manager für institutionelle Wohnportfolios mit rund 5.000 Einheiten.',
    industry: 'Vermögensverwaltung',
    ai: no(
      'asset_manager_bestandshalter',
      0.85,
      'Betreut institutionelle Portfolios und verkauft keine Wohnungen an Privatanleger.',
      'Asset Manager aus Hamburg für institutionelle Wohnportfolios. Kein Vertrieb an Privatanleger erkennbar.',
    ),
  },
  // 37
  {
    first: 'Robert',
    last: 'Kühnel',
    position: 'Geschäftsführer',
    company: 'Kühnel Wohnbau GmbH',
    ads: { total: 4, active: 4 },
    city: 'Erfurt',
    distance: 2,
    headline: 'Geschäftsführer · Neubau in Thüringen',
    description: 'Bauträger für Reihenhäuser und Eigentumswohnungen in Thüringen.',
    website: 'kuehnel-wohnbau.de',
    industry: 'Bauwesen',
    ai: bt(
      0.83,
      'Bauträger mit eigenen Reihenhaus- und Wohnungsprojekten.',
      'Bauträger aus Erfurt mit Reihenhäusern und Eigentumswohnungen. Vermarktet seine Projekte selbst und plant zwei neue Bauabschnitte.',
    ),
  },
  // 38
  {
    first: 'Sandra',
    last: 'Möllering',
    position: 'Geschäftsführerin',
    company: 'Möllering Schlüsselfertigbau GmbH',
    city: 'Gütersloh',
    distance: 3,
    headline: 'Geschäftsführerin · Schlüsselfertiges Bauen für Investoren',
    description: 'Baut schlüsselfertige Wohn- und Gewerbeobjekte im Auftrag von Investoren.',
    industry: 'Bauwesen',
    ai: no(
      'bauunternehmen_fuer_dritte',
      0.8,
      'Baut schlüsselfertig für Investoren, vermarktet aber keine eigenen Projekte.',
      'Schlüsselfertigbau aus Gütersloh im Auftrag von Investoren. Der Verkauf der Einheiten liegt bei den Auftraggebern.',
    ),
  },
  // 39
  {
    first: 'Werner',
    last: 'Pohlmann',
    position: 'Inhaber',
    company: 'Pohlmann Immobilienservice',
    city: 'Saarbrücken',
    distance: 3,
    headline: 'Inhaber · Hausverwaltung und Hausmeisterservice',
    description: 'Hausverwaltung mit angeschlossenem Hausmeisterservice im Saarland.',
    industry: 'Immobilienverwaltung',
    prescreen: { fit: 'no', reason: 'Hausverwaltung mit Hausmeisterservice – kein Immobilienvertrieb' },
    ai: no(
      'hausverwaltung',
      0.86,
      'Hausverwaltung mit Hausmeisterservice, kein Immobilienvertrieb.',
      'Hausverwaltung aus Saarbrücken mit eigenem Hausmeisterservice. Kein Verkauf von Immobilien erkennbar.',
    ),
  },
  // 40
  {
    first: 'Lars',
    last: 'Ehmke',
    position: 'Inhaber',
    company: 'Ehmke Immobilien',
    city: 'Oldenburg',
    distance: 2,
    headline: 'Inhaber · Makler für Oldenburg und das Ammerland',
    description: 'Maklerbüro für Häuser und Wohnungen im Oldenburger Land.',
    industry: 'Immobilien',
    prescreen: { fit: 'no', reason: 'Maklerbüro – vermittelt fremde Objekte' },
    ai: no(
      'makler',
      0.86,
      'Maklerbüro für Eigentümer-Aufträge ohne eigene Kapitalanlage-Produkte.',
      'Maklerbüro aus Oldenburg für Häuser und Wohnungen. Arbeitet im Auftrag von Eigentümern.',
    ),
  },
];

export const MOCK_LEADS: MockLead[] = ENTRIES.map(build);

export const MOCK_LEADS_BY_ID: ReadonlyMap<string, MockLead> = new Map(MOCK_LEADS.map((lead) => [lead.hit.providerId, lead]));
