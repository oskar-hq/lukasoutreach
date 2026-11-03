import { LEAD_STAGE_LABELS, type CockpitLead, type LeadAction, type LeadEventKind, type LeadStage } from '../../../shared/leads';
import type { TimelineEntry } from '../../state/cockpit';

/** Der Weg eines Leads als Schritte der Statuskarte (ohne „Verloren“ – das ist ein Abbruch, kein Schritt). */
export const STAGE_STEPS: readonly LeadStage[] = ['new', 'invited', 'connected', 'contacted', 'replied', 'meeting', 'handed_over'];

const HINTS: Record<LeadStage, string> = {
  new: 'Noch nicht kontaktiert. Anfrage auf LinkedIn senden und hier eintragen.',
  invited: 'Warte auf Annahme der Vernetzungsanfrage',
  connected: 'Vernetzt. Jetzt die erste Nachricht schicken und hier eintragen.',
  contacted: 'Angeschrieben. Kommt eine Antwort, trag sie hier ein.',
  replied: 'Hat geantwortet. Termin vereinbaren.',
  meeting: 'Termin steht.',
  handed_over: 'An Close übergeben – hier ist nichts mehr zu tun.',
  lost: 'Dieser Lead wird nicht weiter verfolgt.',
};

/** Ereignisse, mit denen ein Lead in seine Stufe gekommen ist – für „seit 4 Tagen“. */
const STAGE_EVENTS: Partial<Record<LeadStage, LeadEventKind[]>> = {
  invited: ['invite_sent'],
  connected: ['invite_accepted'],
  contacted: ['message_sent'],
  replied: ['message_received'],
  meeting: ['meeting_booked'],
};

const DAY = 24 * 60 * 60 * 1000;

/** „seit heute“, „seit gestern“, „seit 4 Tagen“. */
export function sinceText(at: number, now = Date.now()): string {
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / DAY);
  if (days <= 0) return 'seit heute';
  if (days === 1) return 'seit gestern';
  return `seit ${days} Tagen`;
}

export interface StageView {
  label: string;
  /** 0-basiert in `STAGE_STEPS`; bei „Verloren“ null. */
  step: number | null;
  hint: string;
}

export function stageView(lead: CockpitLead, events: TimelineEntry[] | null): StageView {
  const step = STAGE_STEPS.indexOf(lead.stage);
  const kinds = STAGE_EVENTS[lead.stage];
  const since = kinds && events ? events.filter((event) => kinds.includes(event.kind)).reduce<number | null>((last, event) => Math.max(last ?? 0, event.at), null) : null;
  // Warten auf die andere Seite: wie lange schon.
  const hint = lead.stage === 'invited' ? `${HINTS.invited}${since ? ` · ${sinceText(since)}` : ''}.` : HINTS[lead.stage];
  return { label: LEAD_STAGE_LABELS[lead.stage], step: step < 0 ? null : step, hint };
}

/** Formulare mit Text (Notiz, Nachricht, Antwort …) – im Panel als Sheet. */
export type ActionForm = 'note' | 'message' | 'reply' | 'meeting' | 'handover' | 'lost';

/**
 * Ein Klick, ohne Formular. „Anfrage angenommen“ gibt es nicht mehr von Hand (20.10., Wunsch des Nutzers: aus Versehen
 * geklickt stand ein Lead auf „Vernetzt“) – das setzt nur der LinkedIn-Abgleich.
 */
export type InstantAction = Extract<LeadAction, 'invite_sent' | 'reopened'>;

export type PrimaryAction =
  | { kind: 'instant'; action: InstantAction; label: string; testId: string }
  | { kind: 'form'; form: ActionForm; label: string; testId: string };

export const INSTANT_ACTIONS: { action: InstantAction; label: string; testId: string }[] = [
  { action: 'invite_sent', label: 'Anfrage gesendet', testId: 'action-invite-sent' },
  { action: 'reopened', label: 'Wieder öffnen', testId: 'action-reopen' },
];

export const FORM_LABELS: Record<ActionForm, string> = {
  note: 'Notiz',
  message: 'Nachricht gesendet',
  reply: 'Antwort eintragen',
  meeting: 'Termin vereinbart',
  handover: 'An Close übergeben',
  lost: 'Als verloren markieren',
};

const instant = (action: InstantAction): PrimaryAction => ({ kind: 'instant', ...INSTANT_ACTIONS.find((entry) => entry.action === action)! });
const form = (key: ActionForm): PrimaryAction => ({ kind: 'form', form: key, label: FORM_LABELS[key], testId: `action-form-${key}` });

/**
 * Der eine nächste Schritt je Stufe – der Knopf unten im Panel (eine Haupt-Aktion pro Bildschirm). Alles andere steht
 * unter „Mehr“. `canHandOver`: Übergabe eingeschaltet und Close angebunden oder von Hand möglich (`useCrm()`).
 */
export function primaryAction(stage: LeadStage, canHandOver: boolean): PrimaryAction {
  switch (stage) {
    case 'new':
      return instant('invite_sent');
    case 'invited':
      return form('note');
    case 'connected':
      return form('message');
    case 'contacted':
      return form('reply');
    case 'replied':
      return form('meeting');
    case 'meeting':
      return canHandOver ? form('handover') : form('message');
    case 'handed_over':
    case 'lost':
      return instant('reopened');
  }
}
