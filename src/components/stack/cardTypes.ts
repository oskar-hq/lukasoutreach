import type { LeadActionRequest } from '../../../shared/leads';
import type { ToastTexts } from '../../state/demo';
import type { CardState, Decision } from '../../state/types';

export interface DecideArgs {
  decision: Decision;
  /** Bestimmt die Richtung der Übergangsanimation. */
  positive: boolean;
  /** Was gespeichert wird – null = für heute überspringen (`POST /api/leads/:id/snooze`). */
  action: LeadActionRequest | null;
  toast: ToastTexts;
  /** Vernetzen/Nachricht wirklich über LinkedIn senden (`/api/leads/:id/linkedin/*`) statt nur eintragen. */
  viaLinkedIn?: boolean;
  /** Übergabe wirklich in Close anlegen (`POST /api/leads/:id/handover`) statt nur eintragen. */
  viaCrm?: boolean;
  /** Mit `action: null`: „Später“ – bis dahin pausiert, dann wieder in den Aufgaben (Wiedervorlage, `followUpPlan`). */
  resumeAt?: number;
}

export interface CardProps {
  card: CardState;
  onDecide: (args: DecideArgs) => void;
  onOpenLead: (leadId: string) => void;
  /** false während Panel/Modal offen sind oder die Karte gerade hinausanimiert. */
  hotkeysEnabled: boolean;
}
