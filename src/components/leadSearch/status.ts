import { CATEGORY_LABELS, isQualifyingCategory, metaAdsLabel, type LeadStatus, type PipelineLead } from '../../../shared/leadSearch';

export type StatusTone = 'neutral' | 'good' | 'warn' | 'bad' | 'active';

export interface StatusView {
  label: string;
  tone: StatusTone;
  /** true, solange gerade an diesem Lead gearbeitet wird. */
  active: boolean;
  final: boolean;
}

const VIEWS: Record<LeadStatus, StatusView> = {
  found: { label: 'Gefunden', tone: 'neutral', active: false, final: false },
  unique: { label: 'Wartet auf Profilabruf', tone: 'neutral', active: false, final: false },
  screened_out: { label: 'Vorprüfung: passt nicht', tone: 'warn', active: false, final: true },
  enriching: { label: 'Profil wird abgerufen …', tone: 'active', active: true, final: false },
  enriched: { label: 'Wartet auf KI', tone: 'neutral', active: false, final: false },
  qualifying: { label: 'KI prüft …', tone: 'active', active: true, final: false },
  checking_ads: { label: 'Meta-Ads prüfen …', tone: 'active', active: true, final: false },
  qualified: { label: 'Qualifiziert', tone: 'good', active: false, final: true },
  ads_active: { label: 'Qualifiziert · schaltet Meta-Ads', tone: 'good', active: false, final: true },
  rejected: { label: 'Aussortiert', tone: 'warn', active: false, final: true },
  unrated: { label: 'Nicht bewertet', tone: 'neutral', active: false, final: true },
  duplicate: { label: 'Dublette', tone: 'neutral', active: false, final: true },
  invited: { label: 'Offene Anfrage', tone: 'neutral', active: false, final: true },
  connected: { label: 'Bereits vernetzt', tone: 'neutral', active: false, final: true },
  deferred: { label: 'Zurückgestellt', tone: 'neutral', active: false, final: true },
  failed: { label: 'Fehler', tone: 'bad', active: false, final: true },
};

export function statusView(lead: PipelineLead): StatusView {
  if (lead.manual && lead.status === 'qualified') return { ...VIEWS.qualified, label: 'Von Hand qualifiziert' };
  return VIEWS[lead.status];
}

/** Reihenfolge der Ergebnistabelle: Qualifizierte zuerst, dann wer gerade Ads schaltet, dann was die KI aussortiert hat, dann der Rest. */
const RANK: Record<LeadStatus, number> = {
  qualified: 0,
  ads_active: 1,
  rejected: 2,
  unrated: 2,
  screened_out: 3,
  failed: 3,
  deferred: 4,
  duplicate: 5,
  invited: 6,
  connected: 7,
  checking_ads: 8,
  qualifying: 8,
  enriched: 8,
  enriching: 8,
  unique: 9,
  found: 10,
};

export function sortForResults(leads: PipelineLead[]): PipelineLead[] {
  return [...leads].sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] || (b.qualification?.confidence ?? 0) - (a.qualification?.confidence ?? 0),
  );
}

/** Warum Leads unter „Aussortiert“ stehen – eine Zeile, z. B. „5 von der KI aussortiert · 7 Dubletten“. */
export function rejectedSummary(leads: PipelineLead[]): string {
  const count = (status: LeadStatus) => leads.filter((lead) => lead.status === status).length;
  const open = leads.filter((lead) => !VIEWS[lead.status].final).length;
  const duplicates = count('duplicate');
  const invited = count('invited');
  const parts: Array<[number, string]> = [
    [count('rejected'), 'von der KI aussortiert'],
    [count('screened_out'), 'in der Vorprüfung aussortiert'],
    [count('deferred'), 'zurückgestellt (Limit pro Lauf)'],
    [duplicates, duplicates === 1 ? 'Dublette' : 'Dubletten'],
    [invited, invited === 1 ? 'offene Anfrage' : 'offene Anfragen'],
    [count('connected'), 'bereits vernetzt'],
    [count('failed'), 'Fehler'],
    [open, 'nicht fertig geprüft'],
  ];
  return parts
    .filter(([value]) => value > 0)
    .map(([value, label]) => `${value} ${label}`)
    .join(' · ');
}

/** Zweite Zeile zum Status: Grund bzw. Stand in der Meta-Werbebibliothek. */
export function statusDetail(lead: PipelineLead): string | null {
  if (lead.note) return lead.note;
  if (lead.metaAds) return metaAdsLabel(lead.metaAds);
  // Noch ohne Profil: Ergebnis der KI-Vorprüfung anhand der Headline.
  if (lead.prescreen && !lead.profile) return lead.prescreen.fit === 'likely' ? 'Vorprüfung: passt vermutlich' : 'Vorprüfung: unklar';
  return null;
}

export function categoryLabel(lead: PipelineLead): string | null {
  return lead.qualification ? CATEGORY_LABELS[lead.qualification.category] : null;
}

export function categoryIsQualifying(lead: PipelineLead): boolean {
  return !!lead.qualification && isQualifyingCategory(lead.qualification.category);
}

export function fullName(lead: PipelineLead): string {
  return `${lead.hit.firstName} ${lead.hit.lastName}`.trim();
}

export function percent(value: number): string {
  return `${Math.round(value * 100)} %`;
}
