import type { FitCategory, Lead, Signal } from '../state/types';

export interface FitInfo {
  label: string;
  short: string;
  good: boolean;
}

export const FIT_INFO: Record<FitCategory, FitInfo> = {
  kapitalanlage: { label: 'Passt (Kapitalanlage-Vertrieb)', short: 'Kapitalanlage-Vertrieb', good: true },
  bautraeger: { label: 'Passt (Bauträger)', short: 'Bauträger', good: true },
  makler: { label: 'Vermutlich unpassend (Makler)', short: 'Makler', good: false },
  hausverwaltung: { label: 'Vermutlich unpassend (Hausverwaltung)', short: 'Hausverwaltung', good: false },
};

export function signalLabel(signal: Signal): string {
  switch (signal.type) {
    case 'meta_ads':
      return 'Meta Ads aktiv';
    case 'hiring':
      return `Sucht: ${signal.role}`;
    case 'search':
      return signal.detail;
  }
}

export function signalDetail(signal: Signal): string {
  switch (signal.type) {
    case 'meta_ads':
      return signal.detail;
    case 'hiring':
      return 'Offene Stelle auf LinkedIn und Jobportalen';
    case 'search':
      return 'Über die Lead-Suche gefunden und von der KI qualifiziert';
  }
}

export function fullName(lead: Lead): string {
  return `${lead.firstName} ${lead.lastName}`;
}

export function initials(lead: Lead): string {
  return `${lead.firstName[0]}${lead.lastName[0]}`;
}

export function linkedinUrl(lead: Lead): string {
  if (lead.source?.profileUrl) return lead.source.profileUrl.replace(/^https?:\/\/(www\.)?/, '');
  const slug = `${lead.firstName}-${lead.lastName}`
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
  return `linkedin.com/in/${slug}-${lead.id}`;
}

/** Deterministischer Hash für stabile „Zufallswerte“ je Lead. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}
