import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { NewLeadCard } from '../../shared/leadSearch';
import type { CockpitLead, CreateLeadsRequest, LeadActionRequest, LeadDetailResponse, LeadEvent } from '../../shared/leads';
import type { DailyTask } from '../../shared/tasks';
import { FOUNDERS } from '../data/founders';
import { ApiError, crmApi, leadsApi, linkedinApi, tasksApi } from '../lib/leadSearchApi';
import { leadName, readableError, threadMessages, type ThreadMessage } from '../lib/leadView';
import { useAuth } from './auth';
import { stackOwnerOf, useDemo, type DemoState, type ToastTexts } from './demo';
import { fitsKeepalive, outbox } from './outbox';
import { replyDrafts } from './replyDrafts';
import type { CardState, Decision, FounderId } from './types';

/** Rückgängig-Fenster in ms. Über ?undo=2 (Sekunden) anpassbar – für Tests. */
export const UNDO_WINDOW_MS = (() => {
  const param = new URLSearchParams(window.location.search).get('undo');
  const seconds = param === null ? NaN : Number(param);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 5000;
})();

/** Übergabe aus der Lead-Suche: gespeichert wird beim Weiterarbeiten, spätestens nach einer Minute. */
const HANDOFF_HOLD_MS = 60_000;
const POLL_MS = 60_000;
/** Beim Zurückkehren in den Tab nur neu laden, wenn der Stand älter ist. */
const STALE_AFTER_MS = 20_000;
/** Grenzen des Backends (`server/src/leads/routes.ts`) – vorher prüfen statt eine englische Fehlermeldung zu zeigen. */
export const MESSAGE_TEXT_LIMIT = 10_000;

// ───────────────────────────── Für heute überspringen (im Backend) ─────────────────────────────

const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/** Übersprungen bis Mitternacht (Ortszeit) – „heute“ meint den Tag des Nutzers, nicht den UTC-Tag des Servers. */
function nextLocalMidnight(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

const snoozeJobId = (taskId: string) => `snooze:${taskId}`;
const unsnoozeJobId = (taskId: string) => `unsnooze:${taskId}`;
const planJobId = (taskId: string) => `plan:${taskId}`;
const unplanJobId = (taskId: string) => `unplan:${taskId}`;

// Früher merkte sich der Browser übersprungene Aufgaben – die alten Einträge aufräumen (kann ab November weg).
try {
  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const key = window.localStorage.key(i);
    if (key?.startsWith('cockpit.skipped.')) window.localStorage.removeItem(key);
  }
} catch {
  // Privates Fenster o. Ä.
}

/**
 * Kennung einer Meldung für `clientId` (gilt beim Server je Lead): gleiche Aufgabe, gleiche Aktion, gleicher Stand
 * ergibt dieselbe Kennung – auch in einem zweiten Tab. So bucht der Server eine Wiederholung (Netzfehler, zweiter Tab)
 * nur einmal; eine *andere* Entscheidung zur selben Aufgabe hat eine andere Kennung und scheitert an der Stufe (409).
 * `updatedAt` statt `lastActivityAt`: Jede Buchung setzt `updatedAt` auf jetzt, ein rückdatiertes Ereignis lässt
 * `lastActivityAt` aber stehen – eine spätere, neue Meldung zur selben Aufgabe bekäme sonst dieselbe Kennung.
 */
export function clientIdFor(task: DailyTask, action: LeadActionRequest['action']): string {
  // Die Lead-ID steckt vorn in der Aufgaben-ID – je Lead überflüssig und zu lang für 64 Zeichen.
  const taskPart = task.id.startsWith(`${task.lead.id}:`) ? task.id.slice(task.lead.id.length + 1) : task.id;
  return `${taskPart}|${action}@${task.lead.updatedAt}`.slice(-64);
}

// ───────────────────────────── Ist die Aktion schon gespeichert? ─────────────────────────────

/** Nach unklarem Ausgang: zeigt der Lead schon, dass die Aktion angekommen ist? (Sonst gäbe es sie doppelt.) */
function reflects(task: DailyTask, request: LeadActionRequest, lead: CockpitLead): boolean {
  // Nur positive Belege zählen – „verloren“ ist z. B. kein Beweis, dass die Anfrage angekommen ist.
  const advanced = (stages: readonly CockpitLead['stage'][]) => stages.includes(lead.stage);
  switch (request.action) {
    case 'lost':
      return lead.stage === 'lost';
    case 'handed_over':
      return lead.stage === 'handed_over';
    case 'invite_sent':
      return advanced(['invited', 'connected', 'contacted', 'replied', 'meeting', 'handed_over']);
    case 'message_sent':
      if (task.type === 'first') return advanced(['contacted', 'replied', 'meeting', 'handed_over']) && (!request.label || lead.template === request.label);
      if (task.type === 'followup') return lead.followUpsSent >= (task.followUpNumber ?? lead.followUpsSent + 1);
      return false;
    case 'meeting_booked':
      return advanced(['meeting', 'handed_over']);
    case 'message_received':
      // Neuere Antwort als beim Laden der Aufgabe – oder der Lead ist seitdem zu „geantwortet“ (oder weiter) gerückt.
      if (lead.lastReplyAt !== null && lead.lastReplyAt > (task.lead.lastReplyAt ?? 0)) return true;
      return !['replied', 'meeting', 'handed_over'].includes(task.lead.stage) && advanced(['replied', 'meeting', 'handed_over']);
    default:
      return false;
  }
}

/**
 * Vorprüfung vor einer Nachricht (Erstnachricht, Follow-up): Ist sie schon gesendet (anderer Tab, anderes Gerät)? Bei
 * der Erstnachricht zählt jede Stufe ab „angeschrieben“ – egal mit welcher Vorlage –, sonst buchte der Server die zweite
 * Erstnachricht als Follow-up 1 (bzw. sendete über LinkedIn eine zweite Nachricht).
 */
function alreadySent(task: DailyTask, request: LeadActionRequest, lead: CockpitLead): boolean {
  if (task.type === 'first') return ['contacted', 'replied', 'meeting', 'handed_over'].includes(lead.stage);
  return reflects(task, request, lead);
}

// ───────────────────────────── Verlauf eines Leads mit noch nicht gespeicherten Entscheidungen ─────────────────────────────

export type PendingMark = 'scheduled' | 'sending' | 'waiting';

export interface TimelineEntry extends LeadEvent {
  /** Noch nicht gespeichert (Rückgängig-Fenster), wird gespeichert, wartet (offline). */
  pending?: PendingMark;
}

function pendingTitle(task: DailyTask, request: LeadActionRequest, founder: FounderId): string {
  switch (request.action) {
    case 'invite_sent':
      return `Vernetzungsanfrage gesendet von ${FOUNDERS[founder].name}`;
    case 'message_sent':
      if (task.type === 'first') return `Erstnachricht${request.label ? ` · Vorlage ${request.label}` : ''} gesendet`;
      if (task.type === 'followup')
        return `Follow-up ${task.followUpNumber ?? task.lead.followUpsSent + 1}${request.label ? ` · Variante ${request.label}` : ''} gesendet`;
      return 'Nachricht gesendet';
    case 'handed_over':
      return 'An das CRM übergeben';
    case 'lost':
      return 'Als verloren markiert';
    case 'message_received':
      return `Antwort von ${task.lead.person.firstName} eingetragen`;
    case 'meeting_booked':
      return 'Termin vereinbart';
    default:
      return 'Notiz';
  }
}

/** Den Lead gibt es nicht mehr (gelöscht: Datenschutz, Aufbewahrungsfrist) – nicht „Fehler“, sondern weg. */
export function isLeadGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'not_found';
}

export function pendingEvents(state: DemoState, leadId: string): TimelineEntry[] {
  const founder = state.founder;
  if (!founder) return [];
  const entries: TimelineEntry[] = [];
  for (const id of state.stack.decisionLog) {
    const task = state.stack.tasks[id];
    const outcome = state.stack.outcomes[id];
    if (!task || task.lead.id !== leadId || !outcome?.action) continue;
    if (outcome.commit !== 'scheduled' && outcome.commit !== 'sending' && outcome.commit !== 'waiting') continue;
    entries.push({
      id: `pending-${id}`,
      leadId,
      kind: outcome.action.action,
      at: outcome.decidedAt,
      // Unter „Alle“ gebucht für den Besitzer des Leads (wie im Backend).
      by: task.lead.owner,
      title: pendingTitle(task, outcome.action, task.lead.owner),
      text: outcome.action.text ?? null,
      label: outcome.action.label ?? null,
      pending: outcome.commit,
    });
  }
  return entries;
}

export interface LeadDetailView {
  status: 'loading' | 'ready' | 'error';
  lead: CockpitLead | null;
  /** Verlauf, älteste zuerst – inklusive noch nicht gespeicherter Entscheidungen. */
  events: TimelineEntry[];
  messages: ThreadMessage[];
  error: string | null;
}

// ───────────────────────────── Provider ─────────────────────────────

interface CockpitApi {
  decide: (
    card: CardState,
    args: { decision: Decision; positive: boolean; action: LeadActionRequest | null; toast: ToastTexts; viaLinkedIn?: boolean; viaCrm?: boolean; resumeAt?: number },
  ) => void;
  /** Letzte Entscheidung zurücknehmen: undone, zu spät (schon gespeichert) oder nichts da. */
  undoLatest: () => 'undone' | 'too_late' | 'nothing';
  /** Tagesstapel neu laden (gebündelt). */
  refresh: () => void;
  reload: () => Promise<void>;
  ensureDetail: (leadId: string, force?: boolean) => void;
  /**
   * Änderung direkt am Lead (Lead-Panel: Notiz, Termin, Zuständig, Firmendaten …) – ohne Rückgängig-Fenster.
   * Übernimmt die Antwort als neuen Stand und lädt den Tagesstapel nach. Fehler gehen an den Aufrufer; mit `leadId`
   * räumt ein „Lead gibt es nicht mehr“ (404) dessen Aufgaben und Panel auf. `messageSent`: Es wurde eine Nachricht
   * gesendet bzw. eingetragen (Chats, „Nachricht gesendet“) – ein auf der Antwort-Karte angefangener Text ist damit
   * verbraucht und darf die nächste Antwort-Karte nicht vorbefüllen (sonst ginge er doppelt raus).
   */
  mutateLead: (run: () => Promise<LeadDetailResponse>, leadId?: string, options?: { messageSent?: boolean }) => Promise<LeadDetailResponse>;
  scheduleHandoff: (runId: string, cards: NewLeadCard[]) => void;
  /** Wartende Übergabe sofort speichern und den Stapel neu laden. */
  commitHandoff: (runId: string) => Promise<void>;
  undoHandoff: () => 'undone' | 'too_late' | 'nothing';
  /** Vor dem Abmelden: alles speichern. Gibt zurück, wie viele Entscheidungen noch warten (offline). */
  prepareSignOut: () => Promise<number>;
  discardPending: () => void;
  retryWaiting: () => void;
  /**
   * Lead selbst gelöscht: seine offenen Aufträge, Aufgaben und Entscheidungen hier verwerfen (ohne Hinweis). true, wenn
   * dabei Aufgaben aus dem Stapel entfernt wurden.
   */
  forgetLead: (leadId: string) => boolean;
}

const CockpitContext = createContext<CockpitApi | null>(null);

export function useCockpit() {
  const context = useContext(CockpitContext);
  if (!context) throw new Error('useCockpit muss innerhalb von CockpitProvider verwendet werden');
  return context;
}

/** Verbindung des Cockpits zum Backend: Tagesstapel laden und aktuell halten, Entscheidungen speichern. */
export function CockpitProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useDemo();
  const { auth } = useAuth();
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestId = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    const { founder, epoch, scope } = stateRef.current;
    if (!founder) return;
    const id = ++requestId.current;
    dispatch({ type: 'STACK_LOADING', epoch });
    try {
      const response = await tasksApi.get(stackOwnerOf(founder, scope), { signal: AbortSignal.timeout(15_000) });
      if (id !== requestId.current) return;
      dispatch({ type: 'STACK_LOADED', epoch, response });
    } catch (error) {
      if (id !== requestId.current) return;
      const message = error instanceof ApiError && error.code !== 'offline' ? readableError(error, 'Fehler beim Laden.') : 'Backend nicht erreichbar.';
      dispatch({ type: 'STACK_FAILED', epoch, message });
    }
  }, [dispatch]);

  const refresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void reload(), 300);
  }, [reload]);

  /** Alles Offene verwerfen – auch eine noch nicht gespeicherte Übergabe darf dann nicht als „wartet“ hängen bleiben. */
  const discardOutbox = useCallback(
    (reason: string) => {
      outbox.discardAll();
      const handoff = stateRef.current.leadSearch.lastHandoff;
      if (handoff && handoff.status !== 'saved' && handoff.status !== 'failed') {
        dispatch({ type: 'LS_HANDOFF_FAILED', runId: handoff.runId, message: reason });
      }
    },
    [dispatch],
  );

  /**
   * Lead gibt es nicht mehr (Datenschutz-Löschung, Aufbewahrungsfrist): nur seine offenen Aufträge, Aufgaben und
   * Entscheidungen verwerfen, Panel/Chat schließen – die übrigen Entscheidungen bleiben und werden gespeichert.
   */
  const forgetLead = useCallback(
    (leadId: string): boolean => {
      // Ein noch laufendes Laden des Stapels (vor dem Löschen gestartet) brächte die Aufgaben des Leads zurück – seine
      // Antwort verwerfen. Beide Aufrufer laden danach ohnehin neu (`refresh` bzw. `reload`).
      requestId.current++;
      const hadTasks = Object.values(stateRef.current.stack.tasks).some((task) => task.lead.id === leadId);
      outbox.discardQueue(leadId);
      replyDrafts.delete(leadId);
      dispatch({ type: 'LEAD_GONE', leadId });
      return hadTasks;
    },
    [dispatch],
  );
  const leadGone = useCallback(
    (leadId: string) => {
      const hadTasks = forgetLead(leadId);
      dispatch(
        hadTasks
          ? { type: 'NOTIFY', title: 'Lead gibt es nicht mehr (gelöscht)', detail: 'Seine Aufgaben sind aus deinem Stapel entfernt.' }
          : { type: 'NOTIFY', title: 'Lead gibt es nicht mehr (gelöscht)' },
      );
      refresh();
    },
    [dispatch, refresh, forgetLead],
  );

  // Neuer Gründer, neue Sitzung (Epoche) → Tagesstapel laden.
  useEffect(() => {
    if (state.founder) void reload();
  }, [state.founder, state.epoch, reload]);

  // Angefangene Antworten gehören zum Gründer bzw. Konto.
  useEffect(() => replyDrafts.clear(), [state.founder]);

  // Aktuell halten: alle 60 s, beim Zurückkehren in den Tab und auf der Startseite. Neuer Tag (auch im über Nacht
  // offenen Tab, den der Takt prüft): neuer Stapel.
  useEffect(() => {
    if (!state.founder) return;
    const sessionDate = localDate();
    const newDay = () => {
      if (localDate() === sessionDate) return false;
      dispatch({ type: 'NEW_SESSION' });
      return true;
    };
    const check = () => {
      if (document.visibilityState !== 'visible' || newDay()) return;
      const fetchedAt = stateRef.current.stack.fetchedAt ?? 0;
      if (Date.now() - fetchedAt > STALE_AFTER_MS) void reload();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !newDay()) void reload();
    }, POLL_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [state.founder, state.epoch, reload, dispatch]);

  useEffect(() => {
    if (state.view === 'home' && state.stack.status === 'ready') refresh();
  }, [state.view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Panel offen: Rückgängig-Fenster läuft nicht ab (Z geht dort nicht).
  useEffect(() => {
    if (!state.panelLeadId) return;
    outbox.hold('panel');
    return () => outbox.release('panel');
  }, [state.panelLeadId]);

  // Sitzung abgelaufen: nichts senden, nichts verwerfen. Gleiches Konto wieder da → weiter; anderes → verwerfen.
  const lastUser = useRef<string | null>(null);
  useEffect(() => {
    if (auth.status === 'anonymous') outbox.pause();
    if (auth.status !== 'authenticated') return;
    const username = auth.user.username;
    if (lastUser.current && lastUser.current !== username) {
      const hadPending = outbox.getSnapshot().entries.length > 0;
      discardOutbox('Gehörte zu einem anderen Konto.');
      if (hadPending) dispatch({ type: 'NOTIFY', title: 'Nicht gespeicherte Entscheidungen verworfen', detail: 'Sie gehörten zu einem anderen Konto.' });
    }
    lastUser.current = username;
    outbox.resume();
  }, [auth, dispatch, discardOutbox]);

  const ensureDetail = useCallback(
    (leadId: string, force = false) => {
      const { details, epoch } = stateRef.current;
      const current = details[leadId];
      if (!force && current && (current.status === 'loading' || (current.status === 'ready' && !current.outdated))) return;
      dispatch({ type: 'DETAIL_LOADING', epoch, leadId });
      leadsApi
        .get(leadId, { signal: AbortSignal.timeout(15_000) })
        .then((detail) => dispatch({ type: 'DETAIL_LOADED', epoch, detail }))
        .catch((error: unknown) => {
          if (isLeadGone(error)) return leadGone(leadId);
          dispatch({ type: 'DETAIL_FAILED', epoch, leadId, message: 'Verlauf konnte nicht geladen werden.' });
        });
    },
    [dispatch, leadGone],
  );

  const mutateLead = useCallback<CockpitApi['mutateLead']>(
    async (run, leadId, options) => {
      const { epoch } = stateRef.current;
      try {
        const detail = await run();
        if (options?.messageSent) replyDrafts.delete(detail.lead.id);
        dispatch({ type: 'DETAIL_LOADED', epoch, detail });
        refresh();
        return detail;
      } catch (error) {
        if (leadId && isLeadGone(error)) leadGone(leadId);
        throw error;
      }
    },
    [dispatch, refresh, leadGone],
  );

  /**
   * „Für heute überspringen“ im Backend speichern – nach dem Rückgängig-Fenster wie jede Entscheidung. Klappt es nicht,
   * gilt das Überspringen nur in dieser Sitzung (die Aufgabe kommt nach dem Neuladen wieder).
   */
  const scheduleSnooze = useCallback(
    (task: DailyTask, epoch: number) => {
      // Rückgängig war noch nicht beim Server: dann gilt das frühere Überspringen weiter.
      if (outbox.cancel(unsnoozeJobId(task.id))) return;
      // „Heute“ = der Tag der Entscheidung – auch wenn die Anfrage erst später (offline, nach Mitternacht) rausgeht.
      const until = nextLocalMidnight();
      let waited = false;
      outbox.schedule<LeadDetailResponse>({
        id: snoozeJobId(task.id),
        queue: task.lead.id,
        delayMs: UNDO_WINDOW_MS,
        send: ({ keepalive, signal }) =>
          Date.now() >= until
            ? leadsApi.get(task.lead.id, { signal }) // Der Tag ist vorbei – nichts mehr zu überspringen.
            : leadsApi.snooze(task.lead.id, { until }, { keepalive, signal }),
        idempotent: true,
        onWaiting: () => {
          waited = true;
          dispatch({ type: 'COMMIT_STATE', epoch, taskId: task.id, commit: 'waiting' });
        },
        onSuccess: (detail) => {
          if (waited) dispatch({ type: 'COMMIT_STATE', epoch, taskId: task.id, commit: 'local' });
          dispatch({ type: 'DETAIL_LOADED', epoch, detail });
        },
        onFinalError: (error) => {
          if (waited) dispatch({ type: 'COMMIT_STATE', epoch, taskId: task.id, commit: 'local' });
          if (isLeadGone(error)) return leadGone(task.lead.id);
          dispatch({
            type: 'NOTIFY',
            title: `Überspringen nicht gespeichert · ${leadName(task.lead)}`,
            detail: `${readableError(error, 'Das Backend hat es nicht angenommen.')} Die Aufgabe kommt beim nächsten Laden wieder.`,
          });
        },
      });
    },
    [dispatch, leadGone],
  );

  /**
   * „Später“ (Wiedervorlage, 22.10.): wie Überspringen mit Rückgängig-Fenster, aber als geplantes Follow-up – bis
   * `resumeAt` pausiert der Lead, dann steht er wieder in den Aufgaben (`PATCH /api/leads/:id { followUpPlan }`).
   */
  const schedulePlan = useCallback(
    (task: DailyTask, epoch: number, resumeAt: number) => {
      if (outbox.cancel(unplanJobId(task.id))) return;
      outbox.schedule<LeadDetailResponse>({
        id: planJobId(task.id),
        queue: task.lead.id,
        delayMs: UNDO_WINDOW_MS,
        send: ({ keepalive, signal }) => leadsApi.update(task.lead.id, { followUpPlan: { at: resumeAt } }, { keepalive, signal }),
        idempotent: true,
        onSuccess: (detail) => dispatch({ type: 'DETAIL_LOADED', epoch, detail }),
        onFinalError: (error) => {
          if (isLeadGone(error)) return leadGone(task.lead.id);
          dispatch({
            type: 'NOTIFY',
            title: `Wiedervorlage nicht gespeichert · ${leadName(task.lead)}`,
            detail: `${readableError(error, 'Das Backend hat es nicht angenommen.')} Die Aufgabe kommt beim nächsten Laden wieder.`,
          });
        },
      });
    },
    [dispatch, leadGone],
  );

  /** „Später“ zurücknehmen – noch nicht gesendet: verwerfen, sonst den Plan im Backend wieder löschen. */
  const scheduleUnplan = useCallback(
    (task: DailyTask, epoch: number) => {
      if (outbox.cancel(planJobId(task.id))) return;
      outbox.schedule<LeadDetailResponse>({
        id: unplanJobId(task.id),
        queue: task.lead.id,
        delayMs: 0,
        send: ({ keepalive, signal }) => leadsApi.update(task.lead.id, { followUpPlan: null }, { keepalive, signal }),
        idempotent: true,
        onSuccess: (detail) => {
          dispatch({ type: 'DETAIL_LOADED', epoch, detail });
          refresh();
        },
        onFinalError: (error) => {
          if (isLeadGone(error)) return leadGone(task.lead.id);
          dispatch({
            type: 'NOTIFY',
            title: `Rückgängig nicht gespeichert · ${leadName(task.lead)}`,
            detail: `${readableError(error, 'Das Backend hat es nicht angenommen.')} Die Wiedervorlage bleibt – entfernen im Lead-Panel unter „Follow-up“.`,
          });
        },
      });
    },
    [dispatch, refresh, leadGone],
  );

  /** Überspringen zurücknehmen – noch nicht gesendet: einfach verwerfen, sonst im Backend aufheben. */
  const scheduleUnsnooze = useCallback(
    (task: DailyTask, epoch: number) => {
      if (outbox.cancel(snoozeJobId(task.id))) return;
      outbox.schedule<LeadDetailResponse>({
        id: unsnoozeJobId(task.id),
        queue: task.lead.id,
        delayMs: 0,
        send: ({ keepalive, signal }) => leadsApi.unsnooze(task.lead.id, { keepalive, signal }),
        idempotent: true,
        onSuccess: (detail) => {
          dispatch({ type: 'DETAIL_LOADED', epoch, detail });
          refresh();
        },
        onFinalError: (error) => {
          if (isLeadGone(error)) return leadGone(task.lead.id);
          dispatch({
            type: 'NOTIFY',
            title: `Rückgängig nicht gespeichert · ${leadName(task.lead)}`,
            detail: `${readableError(error, 'Das Backend hat es nicht angenommen.')} Im Backend bleibt die Aufgabe übersprungen – nach dem nächsten Laden fehlt sie bis morgen.`,
          });
        },
      });
    },
    [dispatch, refresh, leadGone],
  );

  const decide = useCallback<CockpitApi['decide']>(
    (card, args) => {
      const snapshot = stateRef.current;
      const founder = snapshot.founder;
      const task = snapshot.stack.tasks[card.id];
      if (!founder || !task || snapshot.stack.outcomes[card.id]) return;
      dispatch({ type: 'DECIDE', payload: { cardId: card.id, ...args } });
      const request = args.action;
      const epoch = snapshot.epoch;
      if (!request) {
        if (args.resumeAt) schedulePlan(task, epoch, args.resumeAt);
        else scheduleSnooze(task, epoch);
        return;
      }
      const clientId = clientIdFor(task, request.action);
      const accepted = outbox.schedule<LeadDetailResponse>({
        id: task.id,
        queue: task.lead.id,
        delayMs: UNDO_WINDOW_MS,
        send: async ({ keepalive, signal, urgent, retry }) => {
          // Ein Follow-up zählt der Server einfach hoch – vorher prüfen, ob es nicht schon jemand gesendet hat (anderes
          // Gerät mit älterem Stand, also anderer `clientId`). Wiederholungen schützen `clientId` bzw. `verify`.
          // Ebenso die Erstnachricht: Hat ein anderer Tab sie schon gesendet, buchte der Server sie sonst als Follow-up 1.
          if (!urgent && !retry && (task.type === 'followup' || task.type === 'first') && request.action === 'message_sent') {
            const current = await leadsApi.get(task.lead.id, { signal });
            if (alreadySent(task, request, current.lead)) return current;
          }
          if (args.viaLinkedIn && request.action === 'invite_sent') {
            const body = request.text ? { message: request.text, clientId } : { clientId };
            return linkedinApi.invite(task.lead.id, body, { keepalive, signal });
          }
          if (args.viaLinkedIn && request.action === 'message_sent' && request.text) {
            return linkedinApi.message(task.lead.id, { text: request.text, label: request.label, clientId }, { keepalive, signal });
          }
          if (args.viaCrm && request.action === 'handed_over') {
            return crmApi.handover(task.lead.id, { ...(request.text ? { note: request.text } : {}), clientId }, { keepalive, signal });
          }
          return leadsApi.act(task.lead.id, { ...request, clientId }, { keepalive, signal });
        },
        // Mit `clientId` bucht bzw. sendet der Server eine Wiederholung nur einmal – auch über LinkedIn.
        idempotent: true,
        verify: async () => {
          const current = await leadsApi.get(task.lead.id, { signal: AbortSignal.timeout(15_000) });
          return reflects(task, request, current.lead) ? current : null;
        },
        onStart: () => dispatch({ type: 'COMMIT_STATE', epoch, taskId: task.id, commit: 'sending' }),
        onWaiting: () => dispatch({ type: 'COMMIT_STATE', epoch, taskId: task.id, commit: 'waiting' }),
        onSuccess: (detail) => {
          // Antwort gesendet und gespeichert: der angefangene Text ist verbraucht. Erst jetzt – ein Rückgängig oder Fehler
          // lässt ihn so stehen. Andere Entscheidungen (Termin, kein Interesse, Übergabe) lassen den Text stehen.
          if (task.type === 'reply' && request.action === 'message_sent') replyDrafts.delete(task.lead.id);
          dispatch({ type: 'COMMIT_DONE', epoch, taskId: task.id, detail });
          refresh();
        },
        onFinalError: (error) => {
          if (isLeadGone(error)) return leadGone(task.lead.id);
          const message = readableError(error, 'Das Backend hat die Entscheidung nicht angenommen.');
          dispatch({ type: 'COMMIT_FAILED', epoch, taskId: task.id, message });
          dispatch({ type: 'NOTIFY', title: `Nicht gespeichert · ${leadName(task.lead)}`, detail: message, taskId: task.id });
          refresh();
        },
      });
      if (!accepted) {
        // Dieselbe Aufgabe wird aus einer früheren Sitzung noch gespeichert – nicht doppelt senden.
        dispatch({ type: 'COMMIT_FAILED', epoch, taskId: task.id, message: 'Wird gerade noch gespeichert – versuch es gleich noch einmal.' });
      }
    },
    [dispatch, refresh, leadGone, scheduleSnooze, schedulePlan],
  );

  const undoLatest = useCallback<CockpitApi['undoLatest']>(() => {
    const { stack, founder } = stateRef.current;
    const taskId = stack.decisionLog[stack.decisionLog.length - 1];
    const outcome = taskId ? stack.outcomes[taskId] : undefined;
    if (!taskId || !outcome || !founder) return 'nothing';
    if (!outcome.action) {
      // Übersprungen (auch wenn das Speichern gerade wartet).
      const task = stack.tasks[taskId];
      if (task) {
        if (outcome.resumeAt) scheduleUnplan(task, stateRef.current.epoch);
        else scheduleUnsnooze(task, stateRef.current.epoch);
      }
      dispatch({ type: 'UNDO', taskId });
      return 'undone';
    }
    if (outcome.commit !== 'scheduled' || !outbox.cancel(taskId)) return 'too_late';
    // Zurückgenommene Antwort: der Text steht wieder im Feld.
    const task = stack.tasks[taskId];
    if (task?.type === 'reply' && outcome.action.action === 'message_sent' && outcome.action.text) replyDrafts.set(task.lead.id, outcome.action.text);
    dispatch({ type: 'UNDO', taskId });
    return 'undone';
  }, [dispatch, scheduleUnsnooze, scheduleUnplan]);

  const handoffId = (runId: string) => `handoff:${runId}`;

  const scheduleHandoff = useCallback<CockpitApi['scheduleHandoff']>(
    (runId, cards) => {
      const founder = stateRef.current.founder;
      if (!founder) return;
      dispatch({ type: 'LS_HANDOFF', runId, count: cards.length });
      const body: CreateLeadsRequest = { cards, owner: founder };
      outbox.schedule({
        id: handoffId(runId),
        queue: 'handoff',
        delayMs: HANDOFF_HOLD_MS,
        send: ({ keepalive, signal }) => leadsApi.create(body, { keepalive: keepalive && fitsKeepalive(body), signal }),
        onStart: () => dispatch({ type: 'LS_HANDOFF_STATE', runId, status: 'saving' }),
        onWaiting: () => dispatch({ type: 'LS_HANDOFF_STATE', runId, status: 'waiting' }),
        onSuccess: (response) => {
          // Nach einem Wiederholen meldet das Backend die eigenen, schon gespeicherten Leads als Dubletten –
          // die gehören trotzdem zu dieser Übergabe.
          const cardIds = new Set(cards.map((card) => card.providerId));
          const ownRepeat = response.skipped.filter((entry) => entry.owner === founder && cardIds.has(entry.providerId));
          const orderOf = (providerId: string) => cards.findIndex((card) => card.providerId === providerId);
          // Verteilt das Backend auf beide Gründer (`LEAD_DISTRIBUTION=balanced`), landen manche beim anderen.
          const mine = response.created.filter((lead) => lead.owner === founder);
          const created = [
            ...mine.map((lead) => ({ id: lead.id, at: orderOf(lead.person.providerId) })),
            ...ownRepeat.map((entry) => ({ id: entry.leadId, at: orderOf(entry.providerId) })),
          ]
            .sort((a, b) => a.at - b.at)
            .map((entry) => entry.id);
          dispatch({
            type: 'LS_HANDOFF_SAVED',
            runId,
            created,
            createdOthers: response.created.filter((lead) => lead.owner !== founder).map((lead) => ({ owner: lead.owner })),
            skipped: response.skipped.filter((entry) => !ownRepeat.includes(entry)).map((entry) => ({ owner: entry.owner })),
          });
          void reload();
        },
        onFinalError: (error) =>
          dispatch({ type: 'LS_HANDOFF_FAILED', runId, message: readableError(error, 'Das Backend hat die Leads nicht angenommen.') }),
      });
    },
    [dispatch, reload],
  );

  const commitHandoff = useCallback(
    async (runId: string) => {
      if (!outbox.has(handoffId(runId))) return;
      await outbox.commitNow(handoffId(runId));
      await reload();
    },
    [reload],
  );

  const undoHandoff = useCallback<CockpitApi['undoHandoff']>(() => {
    const handoff = stateRef.current.leadSearch.lastHandoff;
    if (!handoff) return 'nothing';
    if (handoff.status !== 'pending' || !outbox.cancel(handoffId(handoff.runId))) return 'too_late';
    dispatch({ type: 'LS_UNDO_HANDOFF' });
    return 'undone';
  }, [dispatch]);

  const value = useMemo<CockpitApi>(
    () => ({
      decide,
      undoLatest,
      refresh,
      reload,
      ensureDetail,
      mutateLead,
      scheduleHandoff,
      commitHandoff,
      undoHandoff,
      prepareSignOut: () => outbox.drain(),
      discardPending: () => discardOutbox('Beim Abmelden verworfen.'),
      retryWaiting: () => outbox.retryWaiting(),
      forgetLead,
    }),
    [decide, undoLatest, refresh, reload, ensureDetail, mutateLead, scheduleHandoff, commitHandoff, undoHandoff, discardOutbox, forgetLead],
  );

  return <CockpitContext.Provider value={value}>{children}</CockpitContext.Provider>;
}

/** Verlauf und Gespräch eines Leads – lädt bei Bedarf nach. */
export function useLeadDetail(leadId: string | null): LeadDetailView {
  const { state } = useDemo();
  const { ensureDetail } = useCockpit();
  const detail = leadId ? state.details[leadId] : undefined;
  const outdated = detail?.outdated;

  useEffect(() => {
    if (leadId) ensureDetail(leadId);
  }, [leadId, outdated, ensureDetail]);

  return useMemo(() => {
    if (!leadId) return { status: 'loading', lead: null, events: [], messages: [], error: null };
    const fromTask = Object.values(state.stack.tasks).find((task) => task.lead.id === leadId)?.lead ?? null;
    const data = detail?.data ?? null;
    const lead = data && fromTask ? (fromTask.updatedAt > data.lead.updatedAt ? fromTask : data.lead) : (data?.lead ?? fromTask);
    const events: TimelineEntry[] = [...(data?.events ?? []), ...pendingEvents(state, leadId)];
    const messages = threadMessages(events).map((message) => ({
      ...message,
      pending: (events.find((event) => event.id === message.id) as TimelineEntry | undefined)?.pending !== undefined,
    }));
    return {
      status: data ? 'ready' : detail?.status === 'error' ? 'error' : 'loading',
      lead,
      events,
      messages,
      error: detail?.error ?? null,
    };
  }, [leadId, detail, state]);
}
