import { useMemo, useRef } from 'react';
import type { CockpitLead } from '../../../shared/leads';
import type { DailyTask, TasksResponse } from '../../../shared/tasks';
import { leadSignal, type LeadSignal } from '../../lib/leadView';
import { useLeadDetail, type LeadDetailView } from '../../state/cockpit';
import { useDemo } from '../../state/demo';
import type { CardState } from '../../state/types';

export interface TaskCardData {
  task: DailyTask;
  lead: CockpitLead;
  detail: LeadDetailView;
  /** Signal erst, wenn der Verlauf da ist (steht im ersten Ereignis) – sonst null. Leads aus der Suche sofort. */
  signal: LeadSignal | null;
  signalReady: boolean;
  rules: TasksResponse['rules'] | null;
  /** Entwurf aus einer abgelehnten Entscheidung, damit nichts Getipptes verloren geht. */
  draft: { text: string; label?: string } | null;
}

/** Alles, was eine Karte im Stapel braucht: Aufgabe, aktueller Lead, Verlauf, Signal. */
export function useTaskCard(card: CardState): TaskCardData {
  const { state } = useDemo();
  // Die Karte animiert noch hinaus, während der Stapel sie schon nicht mehr kennt (neuer Tag, Lead gelöscht): mit dem
  // letzten Stand weiterzeichnen statt abzustürzen.
  const last = useRef<DailyTask | undefined>(undefined);
  const task = state.stack.tasks[card.id] ?? last.current!;
  last.current = task;
  const detail = useLeadDetail(card.leadId);
  const loaded = detail.lead ?? task.lead;
  // Übernommener Lead (17.10., `adoptedFrom`): im Stapel schon Lead des übernehmenden Gründers – Account, Limit, Grußformel.
  const owner = task.adoptedFrom ? task.lead.owner : null;
  const lead = useMemo(() => (owner && loaded.owner !== owner ? { ...loaded, owner } : loaded), [loaded, owner]);
  const fromSearch = lead.origin.kind === 'search' || !!lead.metaAds;
  const events = detail.status === 'ready' ? detail.events : undefined;
  const signal = useMemo(() => leadSignal(lead, events), [lead, events]);
  return {
    task,
    lead,
    detail,
    signal,
    signalReady: fromSearch || detail.status !== 'loading',
    rules: state.stack.rules,
    draft: state.stack.failures[card.id]?.draft ?? null,
  };
}
