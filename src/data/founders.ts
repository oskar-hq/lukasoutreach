import { defaultFounderName } from '../../shared/auth';
import type { FounderId } from '../state/types';

export interface Founder {
  id: FounderId;
  name: string;
  fullName: string;
  role: string;
  initials: string;
  /** Grußformel am Ende jeder Nachricht. */
  greeting: string;
  linkedinAccount: string;
}

export const FOUNDERS: Record<FounderId, Founder> = {
  nick: {
    id: 'nick',
    name: 'Nick',
    fullName: 'Nick',
    role: 'Gründer · Vertrieb',
    initials: 'N',
    greeting: 'Viele Grüße\nNick',
    linkedinAccount: 'LinkedIn-Account Nick',
  },
  johannes: {
    id: 'johannes',
    name: 'Johannes',
    fullName: 'Johannes',
    role: 'Gründer · Performance',
    initials: 'J',
    greeting: 'Beste Grüße\nJohannes',
    linkedinAccount: 'LinkedIn-Account Johannes',
  },
};

export const FOUNDER_IDS: FounderId[] = ['nick', 'johannes'];

/** Grußformel ohne Namen – der Name kommt aus dem Konto (`applyFounderNames`). */
const SALUTATIONS: Record<FounderId, string> = { nick: 'Viele Grüße', johannes: 'Beste Grüße' };

/** „Lena Berg“ → „LB“, „Nick“ → „N“. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0]?.[0] ?? '?')).toUpperCase();
}

/**
 * Namen der Gründer aus ihren Konten übernehmen (Vertrag `AuthUser.founderNames`, Wunsch des Nutzers 08.10.: niemand
 * heißt fest „Nick“ oder „Johannes“). Ändert `FOUNDERS` an Ort und Stelle, damit alle Stellen, die daraus lesen,
 * ohne Umbau den richtigen Namen zeigen. Fehlt ein Name (kein Gründer-Konto, älteres Backend), gilt der bisherige.
 * Läuft beim Anmelden, bevor das Cockpit zeichnet (`AuthProvider`).
 */
export function applyFounderNames(names: Partial<Record<FounderId, string>> | undefined): void {
  for (const id of FOUNDER_IDS) {
    const name = names?.[id]?.trim() || defaultFounderName(id);
    const founder = FOUNDERS[id];
    if (founder.fullName === name) continue;
    const first = name.split(/\s+/)[0];
    founder.name = first;
    founder.fullName = name;
    founder.initials = initialsOf(first);
    founder.greeting = `${SALUTATIONS[id]}\n${first}`;
    founder.linkedinAccount = `LinkedIn-Account ${first}`;
  }
}

export function otherFounder(id: FounderId): FounderId {
  return id === 'nick' ? 'johannes' : 'nick';
}
