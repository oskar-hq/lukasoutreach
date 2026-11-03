import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type { PipelineLead, RunError, RunPhase, RunSnapshot, SearchProfile } from '../../shared/leadSearch';
import type { LeadActionRequest, LeadDetailResponse } from '../../shared/leads';
import type { AttentionItem, DailyTask, TasksResponse } from '../../shared/tasks';
import type { CardState, CardType, Decision, FounderId, StackFilter, View } from './types';

export const TYPE_PRIORITY: Record<CardType, number> = { reply: 0, followup: 1, first: 2, lead: 3 };

/**
 * Wie die zuletzt sichtbare Aufgabe den Bildschirm verlassen hat – steuert die Übergänge,
 * damit Ein- und Ausgang räumlich zusammenpassen (z. B. kommt „Rückgängig“ von der Seite zurück,
 * zu der die Aufgabe verschwunden ist).
 */
export interface PageMotion {
  kind: 'decide' | 'undo' | 'jump';
  /** Richtung der Entscheidung: true = rechts (positiv), false = links. */
  positive: boolean;
}

/** Stand einer Entscheidung: im Rückgängig-Fenster, wird gespeichert, wartet (offline), gespeichert, übersprungen. */
export type CommitState = 'scheduled' | 'sending' | 'waiting' | 'done' | 'local';

export interface ToastTexts {
  /** Solange noch rückgängig machbar, z. B. „Vernetzungsanfrage wird gesendet“. */
  pending: string;
  /** Danach, z. B. „Vernetzungsanfrage gesendet“. */
  done: string;
  /** Kurzform für schmale Bildschirme. */
  short?: { pending: string; done: string };
}

export interface Outcome {
  decision: Decision;
  positive: boolean;
  decidedAt: number;
  commit: CommitState;
  /** Was ans Backend geht – fehlt bei „Für heute überspringen“. */
  action: LeadActionRequest | null;
  toast: ToastTexts;
  /** „Später“ (Wiedervorlage, 22.10.): statt für heute überspringen bis zu diesem Zeitpunkt pausieren. */
  resumeAt?: number;
  /** `updatedAt` des Leads laut Antwort beim Speichern (Serverzeit) – ist der Lead danach neuer, wurde er z. B. wieder geöffnet. */
  savedAt?: number;
}

/** Eine Entscheidung, die das Backend abgelehnt hat – die Aufgabe ist zurück, mit Grund und dem alten Entwurf. */
export interface Failure {
  message: string;
  draft: { text: string; label?: string } | null;
}

/** Tagesstapel dieser Sitzung (aus `GET /api/tasks`, ergänzt um die Entscheidungen der Sitzung). */
export interface StackSession {
  owner: FounderId | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Fehler beim ersten Laden. */
  error: string | null;
  /** Späteres Aktualisieren ging nicht – die Daten bleiben stehen. */
  refreshError: string | null;
  fetchedAt: number | null;
  /** Stand (Serverzeit) des ersten Ladens – danach angelegte Leads kommen hinten in den Stapel. */
  since: number | null;
  rules: TasksResponse['rules'] | null;
  /** Heute (UTC) gesendete Vernetzungsanfragen je Gründer – fehlt bei einem älteren Backend. */
  invitesToday: TasksResponse['invitesToday'] | null;
  /** Über wessen LinkedIn-Account die nächste Anfrage geht (null = beide voll); fehlt bei älteren Backends. */
  inviteVia?: TasksResponse['inviteVia'];
  /** Je Lead-Besitzer: über wessen Account seine nächste Anfrage geht (null = gesperrt) – auch unter „Alle“ (25.10.). */
  inviteViaByOwner?: TasksResponse['inviteViaByOwner'];
  /** Heute je LinkedIn-Account gesendete Anfragen und das Tageslimit je Account (25.10.). */
  invitesByAccount?: TasksResponse['invitesByAccount'];
  invitesPerDayByAccount?: TasksResponse['invitesPerDayByAccount'];
  /** Gründer, deren LinkedIn-Account gerade nicht verbunden ist (17.10.) – ihre Aufgaben pausieren. */
  accountPaused?: TasksResponse['accountPaused'];
  attention: AttentionItem[];
  /** Alle Aufgaben dieser Sitzung (offen und entschieden). */
  tasks: Record<string, DailyTask>;
  /** Reihenfolge im Stapel (Aufgaben-IDs). */
  order: string[];
  outcomes: Record<string, Outcome>;
  /** Entscheidungen in zeitlicher Reihenfolge – „Rückgängig“ nimmt immer die letzte. */
  decisionLog: string[];
  failures: Record<string, Failure>;
  /** Aufgaben, die der Server nicht mehr liefert, die aber gerade offen auf dem Bildschirm sind. */
  stale: string[];
  /** Leads der letzten Übergabe aus der Lead-Suche – kommen vor die übrigen neuen Leads. */
  handoffFirst: string[];
  /** Mit „Jetzt nicht“ ans Ende gesetzte Aufgaben seit dem Start des Fokus-Modus bzw. dem letzten Filterwechsel. */
  deferred: string[];
}

export interface DetailState {
  status: 'loading' | 'ready' | 'error';
  data: LeadDetailResponse | null;
  error: string | null;
  /** Der Lead hat sich laut Tagesstapel geändert – beim nächsten Zugriff neu laden. */
  outdated?: boolean;
}

/** Zustand der Lead-Suche – überlebt Seitenwechsel und Gründerwechsel. */
export interface LeadSearchState {
  run: RunSnapshot | null;
  /** Zuletzt verwendetes Suchprofil – das Formular startet damit. */
  lastProfile: SearchProfile | null;
  /** Provider-IDs, die in abgeschlossenen Läufen schon angereichert wurden – werden nicht erneut abgerufen. */
  checked: string[];
  /** Letzte Übergabe in den Tagesstapel (für Bestätigung und „Rückgängig“, solange sie noch nicht gespeichert ist). */
  lastHandoff: HandoffState | null;
}

export interface HandoffState {
  runId: string;
  count: number;
  status: 'pending' | 'saving' | 'waiting' | 'saved' | 'failed';
  created?: string[];
  /** Davon heute im Tagesstapel (Tageslimit für neue Leads). */
  inStack?: number;
  /** Neu angelegt, aber dem anderen Gründer zugeteilt (`LEAD_DISTRIBUTION=balanced`) – nicht in `created`. */
  createdOthers?: { owner: FounderId }[];
  skipped?: { owner: FounderId }[];
  /** Stand des Tagesstapels beim Speichern – „heute im Stapel“ zählt erst ab dem nächsten Laden. */
  savedAgainst?: number | null;
  error?: string;
}

/** Hinweis am unteren Rand, z. B. eine abgelehnte Entscheidung. Immer nur einer zugleich. */
export interface Notice {
  id: number;
  title: string;
  detail?: string;
  /** Zur zurückgekehrten Aufgabe springen. */
  taskId?: string;
  /** Punkt am Hinweis: `bad` (Standard) nur bei Problemen, `good` für Erfolge, `neutral` für reine Info (25.10.). */
  tone?: 'bad' | 'good' | 'neutral';
}

/**
 * Welche Aufgaben im Tagesstapel stehen (Wunsch des Nutzers 16.10.): `mine` = Leads des angemeldeten Gründers, `all` =
 * auch die des anderen Gründers – die erledigst du dann in seinem Namen (seine Grußformel, sein Tageslimit, im Verlauf
 * „von Nick für Johannes“). Nur für Gründer-Konten; Admin und Mitarbeiter wechseln den Gründer oben im Menü.
 */
export type StackScope = 'mine' | 'all';

// „v2“ (Wunsch des Nutzers 01.11.): Standard ist jetzt „Alle“ – der neue Schlüssel setzt alte Wahl einmal zurück.
const SCOPE_KEY = 'cockpit.stackScope.v2.';

/** Zuletzt gewählter Umfang je Gründer (nur Bequemlichkeit – ohne Speicher gilt „Alle“). */
export function readStackScope(founder: FounderId): StackScope {
  try {
    return window.localStorage.getItem(SCOPE_KEY + founder) === 'mine' ? 'mine' : 'all';
  } catch {
    return 'all';
  }
}

function writeStackScope(founder: FounderId, scope: StackScope) {
  try {
    window.localStorage.setItem(SCOPE_KEY + founder, scope);
  } catch {
    // Privates Fenster o. Ä.: gilt nur für diese Sitzung.
  }
}

/** Für wen der Stapel geladen wird (`GET /api/tasks?owner=…`): null = alle Gründer. */
export const stackOwnerOf = (founder: FounderId | null, scope: StackScope): FounderId | null => (scope === 'all' ? null : founder);

export interface DemoState {
  founder: FounderId | null;
  /** Meine Aufgaben oder die aller Gründer (`StackScope`). */
  scope: StackScope;
  loginAt: number | null;
  view: View;
  filter: StackFilter;
  /** Erhöht sich bei Anmeldung, Abmeldung und Neuladen – ältere Antworten werden verworfen. */
  epoch: number;
  stack: StackSession;
  details: Record<string, DetailState>;
  notice: Notice | null;
  panelLeadId: string | null;
  pageMotion: PageMotion;
  leadSearch: LeadSearchState;
  /** React-Key zum vollständigen Neuaufbau. */
  generation: number;
}

export interface DecisionPayload {
  cardId: string;
  decision: Decision;
  positive: boolean;
  action: LeadActionRequest | null;
  toast: ToastTexts;
  resumeAt?: number;
}

export type DemoAction =
  | { type: 'LOGIN'; founder: FounderId; scope?: StackScope }
  | { type: 'SET_SCOPE'; scope: StackScope }
  | { type: 'LOGOUT' }
  | { type: 'NEW_SESSION' }
  | { type: 'SET_VIEW'; view: View }
  | { type: 'SET_FILTER'; filter: StackFilter }
  | { type: 'START_FOCUS'; filter: StackFilter }
  | { type: 'STACK_LOADING'; epoch: number }
  | { type: 'STACK_LOADED'; epoch: number; response: TasksResponse }
  | { type: 'STACK_FAILED'; epoch: number; message: string }
  | { type: 'DECIDE'; payload: DecisionPayload }
  | { type: 'UNDO'; taskId: string }
  | { type: 'COMMIT_STATE'; epoch: number; taskId: string; commit: 'sending' | 'waiting' | 'local' }
  | { type: 'COMMIT_DONE'; epoch: number; taskId: string; detail: LeadDetailResponse | null }
  | { type: 'COMMIT_FAILED'; epoch: number; taskId: string; message: string }
  | { type: 'DISMISS_STALE'; taskId: string }
  | { type: 'LEAD_GONE'; leadId: string }
  | { type: 'DETAIL_LOADING'; epoch: number; leadId: string }
  | { type: 'DETAIL_LOADED'; epoch: number; detail: LeadDetailResponse }
  | { type: 'DETAIL_FAILED'; epoch: number; leadId: string; message: string }
  | { type: 'NOTIFY'; title: string; detail?: string; taskId?: string; tone?: Notice['tone'] }
  | { type: 'DISMISS_NOTICE'; id: number }
  | { type: 'FOCUS_LEAD'; leadId: string }
  | { type: 'DEFER'; taskId: string }
  | { type: 'OPEN_PANEL'; leadId: string }
  | { type: 'CLOSE_PANEL' }
  | { type: 'LS_RUN'; run: RunSnapshot }
  | { type: 'LS_PHASE'; runId: string; phase: RunPhase }
  | { type: 'LS_LEADS'; runId: string; leads: PipelineLead[] }
  | { type: 'LS_CONNECTION_LOST'; runId: string; error: RunError }
  | { type: 'LS_CLEAR' }
  | { type: 'LS_HANDOFF'; runId: string; count: number }
  | { type: 'LS_HANDOFF_STATE'; runId: string; status: 'saving' | 'waiting' }
  | { type: 'LS_HANDOFF_SAVED'; runId: string; created: string[]; createdOthers?: { owner: FounderId }[]; skipped: { owner: FounderId }[] }
  | { type: 'LS_HANDOFF_FAILED'; runId: string; message: string }
  | { type: 'LS_UNDO_HANDOFF' };

const emptyStack = (owner: FounderId | null): StackSession => ({
  owner,
  status: 'idle',
  error: null,
  refreshError: null,
  fetchedAt: null,
  since: null,
  rules: null,
  invitesToday: null,
  attention: [],
  tasks: {},
  order: [],
  outcomes: {},
  decisionLog: [],
  failures: {},
  stale: [],
  handoffFirst: [],
  deferred: [],
});

function createInitialState(generation = 0): DemoState {
  return {
    founder: null,
    scope: 'mine',
    loginAt: null,
    view: 'home',
    filter: 'all',
    epoch: 0,
    stack: emptyStack(null),
    details: {},
    notice: null,
    panelLeadId: null,
    pageMotion: { kind: 'jump', positive: true },
    leadSearch: { run: null, lastProfile: null, checked: [], lastHandoff: null },
    generation,
  };
}

/** Karte (Ansicht) einer Aufgabe im Stapel. */
function cardOf(stack: StackSession, id: string): CardState | null {
  const task = stack.tasks[id];
  if (!task) return null;
  const outcome = stack.outcomes[id];
  return {
    id,
    leadId: task.lead.id,
    type: task.type,
    owner: task.lead.owner,
    status: outcome ? 'done' : 'pending',
    available: true,
    decision: outcome?.decision,
    decidedAt: outcome?.decidedAt,
  };
}

/** Alle Karten dieser Sitzung (offen und erledigt) in Stapel-Reihenfolge. */
export function founderCards(state: DemoState, founder: FounderId): CardState[] {
  if (state.stack.owner !== stackOwnerOf(founder, state.scope)) return [];
  return state.stack.order.map((id) => cardOf(state.stack, id)).filter((card): card is CardState => !!card);
}

/** Offene Karten des Gründers in Stapel-Reihenfolge, optional gefiltert. */
export function pendingCards(state: DemoState, founder: FounderId, filter: StackFilter = 'all'): CardState[] {
  return founderCards(state, founder).filter((card) => card.status === 'pending' && (filter === 'all' || card.type === filter));
}

/** Die Aufgabe, die gerade im Fokus-Modus zu sehen ist. */
export function currentCardId(state: DemoState): string | null {
  if (state.view !== 'focus' || !state.founder) return null;
  return pendingCards(state, state.founder, state.filter)[0]?.id ?? pendingCards(state, state.founder)[0]?.id ?? null;
}

function moveToFront(order: string[], id: string): string[] {
  return [id, ...order.filter((entry) => entry !== id)];
}

/** Hinter die aktuelle Aufgabe einsortieren – nie davor, damit nichts unter dem Finger springt. */
function insertAfter(order: string[], anchor: string | null, id: string): string[] {
  const rest = order.filter((entry) => entry !== id);
  if (!anchor) return [id, ...rest];
  const index = rest.indexOf(anchor);
  return index === -1 ? [...rest, id] : [...rest.slice(0, index + 1), id, ...rest.slice(index + 1)];
}

/** Position nach Aufgabentyp: vor die erste offene Aufgabe eines späteren Typs, aber nie vor die aktuelle. */
function insertByType(stack: StackSession, order: string[], task: DailyTask, current: string | null): string[] {
  const minIndex = current ? order.indexOf(current) + 1 : 0;
  const isHandoff = task.type === 'lead' && stack.handoffFirst.includes(task.lead.id);
  let index = order.findIndex((id, position) => {
    if (position < minIndex || stack.outcomes[id]) return false;
    const other = stack.tasks[id];
    if (!other) return false;
    if (isHandoff && other.type === 'lead') {
      // Übergebene Leads in Übergabe-Reihenfolge, vor allen anderen neuen Leads.
      const otherRank = stack.handoffFirst.indexOf(other.lead.id);
      return otherRank === -1 || otherRank > stack.handoffFirst.indexOf(task.lead.id);
    }
    return TYPE_PRIORITY[other.type] > TYPE_PRIORITY[task.type];
  });
  if (index === -1) index = order.length;
  return [...order.slice(0, index), task.id, ...order.slice(index)];
}

/** Antwort von `GET /api/tasks` einarbeiten, ohne die laufende Arbeit durcheinanderzubringen. */
function mergeTasks(state: DemoState, response: TasksResponse): StackSession {
  const stack = state.stack;
  const initial = stack.status !== 'ready';
  const current = currentCardId(state);
  const serverIds = new Set(response.tasks.map((task) => task.id));
  const tasks = { ...stack.tasks };
  for (const task of response.tasks) tasks[task.id] = task;
  const working: StackSession = { ...stack, tasks };

  const stale = new Set(stack.stale.filter((id) => !serverIds.has(id)));
  let order = stack.order.filter((id) => {
    if (stack.outcomes[id] || serverIds.has(id)) return true;
    // Nicht mehr fällig (anderswo erledigt) – die gerade sichtbare Aufgabe bleibt, als „veraltet“ markiert.
    if (id === current) {
      stale.add(id);
      return true;
    }
    return false;
  });

  // Gespeicherte Entscheidung, deren Aufgabe der Server wieder liefert, obwohl sich der Lead danach geändert hat (z. B.
  // „Wieder öffnen“ im Lead-Panel): wieder offen – die alte Entscheidung gilt nicht mehr.
  const outcomes = { ...stack.outcomes };
  let decisionLog = stack.decisionLog;
  const reopened = new Set<string>();
  for (const task of response.tasks) {
    const outcome = outcomes[task.id];
    if (!outcome?.action || outcome.commit !== 'done' || task.lead.updatedAt <= (outcome.savedAt ?? outcome.decidedAt)) continue;
    delete outcomes[task.id];
    decisionLog = decisionLog.filter((id) => id !== task.id);
    // Die gerade sichtbare Karte bleibt an ihrem Platz (kein Springen), andere werden neu einsortiert.
    if (task.id === current) continue;
    order = order.filter((id) => id !== task.id);
    reopened.add(task.id);
  }
  working.outcomes = outcomes;

  const known = new Set(order);
  for (const task of response.tasks) {
    if (known.has(task.id)) continue;
    if (reopened.has(task.id)) {
      order = insertByType(working, order, task, current);
      continue;
    }
    if (initial) {
      order.push(task.id);
      continue;
    }
    if (task.type === 'lead' && !stack.handoffFirst.includes(task.lead.id)) {
      // Neu oder nachgerückt (automatische Suche, Suche eines Kollegen, freier Platz nach „Nicht geeignet“): hinten
      // anhängen. Der Stapel zeigt genau, was der Server heute vorsieht (25.10.) – vorher kamen Nachrücker erst nach dem
      // Neuladen, und die Zahl der Leads sprang. Das Tageslimit begrenzt der Server selbst.
      order = [...order, task.id];
      continue;
    }
    order = task.type === 'reply' && current ? insertAfter(order, current, task.id) : insertByType(working, order, task, current);
  }

  return {
    ...working,
    status: 'ready',
    error: null,
    refreshError: null,
    fetchedAt: response.generatedAt,
    since: stack.since ?? response.generatedAt,
    rules: response.rules,
    invitesToday: response.invitesToday ?? null,
    inviteVia: response.inviteVia,
    inviteViaByOwner: response.inviteViaByOwner,
    invitesByAccount: response.invitesByAccount,
    invitesPerDayByAccount: response.invitesPerDayByAccount,
    accountPaused: response.accountPaused,
    attention: response.attention,
    order,
    decisionLog,
    stale: [...stale],
  };
}

function markOutdatedDetails(details: Record<string, DetailState>, response: TasksResponse): Record<string, DetailState> {
  let next = details;
  for (const task of response.tasks) {
    const detail = details[task.lead.id];
    if (detail?.data && task.lead.updatedAt > detail.data.lead.updatedAt && !detail.outdated) {
      if (next === details) next = { ...details };
      next[task.lead.id] = { ...detail, outdated: true };
    }
  }
  return next;
}

function mergeLeads(current: PipelineLead[], updates: PipelineLead[]): PipelineLead[] {
  const byId = new Map(updates.map((lead) => [lead.id, lead]));
  const merged = current.map((lead) => byId.get(lead.id) ?? lead);
  const known = new Set(current.map((lead) => lead.id));
  for (const lead of updates) if (!known.has(lead.id)) merged.push(lead);
  return merged;
}

function withRun(state: DemoState, runId: string, update: (run: RunSnapshot) => RunSnapshot): DemoState {
  const run = state.leadSearch.run;
  if (!run || run.id !== runId) return state;
  return { ...state, leadSearch: { ...state.leadSearch, run: update(run) } };
}

function withHandoff(state: DemoState, runId: string, update: (handoff: HandoffState) => HandoffState): DemoState {
  const handoff = state.leadSearch.lastHandoff;
  if (!handoff || handoff.runId !== runId) return state;
  return { ...state, leadSearch: { ...state.leadSearch, lastHandoff: update(handoff) } };
}

function withOutcome(state: DemoState, epoch: number, taskId: string, update: (outcome: Outcome) => Outcome | null): DemoState {
  if (epoch !== state.epoch) return state;
  const outcome = state.stack.outcomes[taskId];
  if (!outcome) return state;
  const next = update(outcome);
  const outcomes = { ...state.stack.outcomes };
  if (next) outcomes[taskId] = next;
  else delete outcomes[taskId];
  return { ...state, stack: { ...state.stack, outcomes } };
}

let noticeId = 0;

function reducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'LOGIN': {
      if (state.founder === action.founder) return state;
      const scope = action.scope ?? 'all';
      return {
        ...state,
        founder: action.founder,
        scope,
        loginAt: Date.now(),
        view: 'home',
        filter: 'all',
        epoch: state.epoch + 1,
        stack: emptyStack(stackOwnerOf(action.founder, scope)),
        details: {},
        notice: null,
      };
    }

    case 'SET_SCOPE':
      // Neuer Umfang = neuer Stapel (wie ein neuer Tag); offene Entscheidungen hat die Oberfläche vorher gespeichert.
      if (state.scope === action.scope || !state.founder) return state;
      writeStackScope(state.founder, action.scope);
      return {
        ...state,
        scope: action.scope,
        epoch: state.epoch + 1,
        stack: emptyStack(stackOwnerOf(state.founder, action.scope)),
        details: {},
        panelLeadId: null,
      };

    case 'LOGOUT':
      return {
        ...state,
        founder: null,
        scope: 'mine',
        loginAt: null,
        epoch: state.epoch + 1,
        stack: emptyStack(null),
        details: {},
        notice: null,
        panelLeadId: null,
      };

    case 'NEW_SESSION':
      // Neuer Tag: Stapel neu laden, Ansicht bleibt.
      return { ...state, epoch: state.epoch + 1, stack: emptyStack(stackOwnerOf(state.founder, state.scope)), details: {}, panelLeadId: null };

    case 'SET_VIEW':
      return { ...state, view: action.view, panelLeadId: null };

    case 'SET_FILTER':
      return { ...state, filter: action.filter, stack: { ...state.stack, deferred: [] }, pageMotion: { kind: 'jump', positive: true } };

    case 'START_FOCUS':
      return {
        ...state,
        view: 'focus',
        filter: action.filter,
        stack: { ...state.stack, deferred: [] },
        panelLeadId: null,
        pageMotion: { kind: 'jump', positive: true },
      };

    case 'STACK_LOADING':
      if (action.epoch !== state.epoch || state.stack.status === 'ready') return state;
      return { ...state, stack: { ...state.stack, status: 'loading', error: null } };

    case 'STACK_LOADED': {
      if (action.epoch !== state.epoch || action.response.owner !== state.stack.owner) return state;
      return {
        ...state,
        stack: mergeTasks(state, action.response),
        details: markOutdatedDetails(state.details, action.response),
      };
    }

    case 'STACK_FAILED':
      if (action.epoch !== state.epoch) return state;
      return state.stack.status === 'ready'
        ? { ...state, stack: { ...state.stack, refreshError: action.message } }
        : { ...state, stack: { ...state.stack, status: 'error', error: action.message } };

    case 'DECIDE': {
      const { cardId, decision, positive, action: request, toast, resumeAt } = action.payload;
      const stack = state.stack;
      if (!stack.tasks[cardId] || stack.outcomes[cardId]) return state;
      const failures = { ...stack.failures };
      delete failures[cardId];
      return {
        ...state,
        stack: {
          ...stack,
          outcomes: {
            ...stack.outcomes,
            [cardId]: { decision, positive, decidedAt: Date.now(), commit: request ? 'scheduled' : 'local', action: request, toast, ...(resumeAt ? { resumeAt } : {}) },
          },
          decisionLog: [...stack.decisionLog.filter((id) => id !== cardId), cardId],
          failures,
          stale: stack.stale.filter((id) => id !== cardId),
        },
        pageMotion: { kind: 'decide', positive },
      };
    }

    case 'UNDO': {
      const stack = state.stack;
      const outcome = stack.outcomes[action.taskId];
      const task = stack.tasks[action.taskId];
      if (!outcome || !task) return state;
      const outcomes = { ...stack.outcomes };
      delete outcomes[action.taskId];
      const filterMatches = state.filter === 'all' || state.filter === task.type;
      return {
        ...state,
        stack: {
          ...stack,
          outcomes,
          decisionLog: stack.decisionLog.filter((id) => id !== action.taskId),
          order: moveToFront(stack.order, action.taskId),
        },
        filter: filterMatches ? state.filter : 'all',
        view: 'focus',
        panelLeadId: null,
        pageMotion: { kind: 'undo', positive: outcome.positive },
      };
    }

    case 'COMMIT_STATE':
      return withOutcome(state, action.epoch, action.taskId, (outcome) => ({ ...outcome, commit: action.commit }));

    case 'COMMIT_DONE': {
      const next = withOutcome(state, action.epoch, action.taskId, (outcome) => ({
        ...outcome,
        commit: 'done',
        ...(action.detail ? { savedAt: action.detail.lead.updatedAt } : {}),
      }));
      if (next === state || !action.detail) return next;
      const current = next.details[action.detail.lead.id]?.data;
      if (current && current.lead.updatedAt > action.detail.lead.updatedAt) return next;
      return { ...next, details: { ...next.details, [action.detail.lead.id]: { status: 'ready', data: action.detail, error: null } } };
    }

    case 'COMMIT_FAILED': {
      if (action.epoch !== state.epoch) return state;
      const stack = state.stack;
      const outcome = stack.outcomes[action.taskId];
      if (!outcome) return state;
      const outcomes = { ...stack.outcomes };
      delete outcomes[action.taskId];
      const current = currentCardId(state);
      const request = outcome.action;
      return {
        ...state,
        stack: {
          ...stack,
          outcomes,
          decisionLog: stack.decisionLog.filter((id) => id !== action.taskId),
          // Zurück in den Stapel – direkt hinter die aktuelle Aufgabe, nie davor.
          order: current && current !== action.taskId ? insertAfter(stack.order, current, action.taskId) : stack.order,
          failures: {
            ...stack.failures,
            [action.taskId]: {
              message: action.message,
              draft: request?.text ? { text: request.text, label: request.label } : null,
            },
          },
        },
      };
    }

    case 'DISMISS_STALE':
      return {
        ...state,
        stack: {
          ...state.stack,
          order: state.stack.order.filter((id) => id !== action.taskId),
          stale: state.stack.stale.filter((id) => id !== action.taskId),
        },
        pageMotion: { kind: 'decide', positive: true },
      };

    case 'LEAD_GONE': {
      // Lead gelöscht (Datenschutz, Aufbewahrungsfrist): nur seine Aufgaben, Entscheidungen und sein Verlauf fallen weg.
      const stack = state.stack;
      const gone = new Set(Object.keys(stack.tasks).filter((id) => stack.tasks[id].lead.id === action.leadId));
      const keep = (id: string) => !gone.has(id);
      const without = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => keep(id)));
      const details = { ...state.details };
      delete details[action.leadId];
      return {
        ...state,
        stack: {
          ...stack,
          tasks: without(stack.tasks),
          outcomes: without(stack.outcomes),
          failures: without(stack.failures),
          order: stack.order.filter(keep),
          decisionLog: stack.decisionLog.filter(keep),
          stale: stack.stale.filter(keep),
          handoffFirst: stack.handoffFirst.filter((id) => id !== action.leadId),
        },
        details,
        panelLeadId: state.panelLeadId === action.leadId ? null : state.panelLeadId,
        pageMotion: gone.size ? { kind: 'jump', positive: true } : state.pageMotion,
      };
    }

    case 'DETAIL_LOADING': {
      if (action.epoch !== state.epoch) return state;
      const current = state.details[action.leadId];
      return {
        ...state,
        details: { ...state.details, [action.leadId]: { status: current?.data ? current.status : 'loading', data: current?.data ?? null, error: null } },
      };
    }

    case 'DETAIL_LOADED': {
      if (action.epoch !== state.epoch) return state;
      const current = state.details[action.detail.lead.id]?.data;
      // Ältere Antworten (z. B. ein Vorab-Laden, das eine Speicherung überholt hat) überschreiben nichts.
      if (current && current.lead.updatedAt > action.detail.lead.updatedAt) return state;
      return { ...state, details: { ...state.details, [action.detail.lead.id]: { status: 'ready', data: action.detail, error: null } } };
    }

    case 'DETAIL_FAILED': {
      if (action.epoch !== state.epoch) return state;
      const current = state.details[action.leadId];
      if (current?.data) return { ...state, details: { ...state.details, [action.leadId]: { ...current, status: 'ready', outdated: false } } };
      return { ...state, details: { ...state.details, [action.leadId]: { status: 'error', data: null, error: action.message } } };
    }

    case 'NOTIFY':
      return { ...state, notice: { id: ++noticeId, title: action.title, detail: action.detail, taskId: action.taskId, tone: action.tone } };

    case 'DISMISS_NOTICE':
      return state.notice?.id === action.id ? { ...state, notice: null } : state;

    case 'FOCUS_LEAD': {
      const id = state.stack.order.find((taskId) => state.stack.tasks[taskId]?.lead.id === action.leadId && !state.stack.outcomes[taskId]);
      if (!id) return state;
      return {
        ...state,
        stack: { ...state.stack, order: moveToFront(state.stack.order, id) },
        filter: 'all',
        view: 'focus',
        panelLeadId: null,
        pageMotion: { kind: 'jump', positive: true },
      };
    }

    case 'DEFER': {
      // „Jetzt nicht“ (Wunsch des Nutzers 13.10.): ans Ende des Stapels, ohne Entscheidung – nichts wird gespeichert, die
      // Aufgabe bleibt heute offen. So lassen sich erst andere Kategorien abarbeiten.
      const { stack } = state;
      if (!stack.order.includes(action.taskId) || stack.outcomes[action.taskId]) return state;
      const order = [...stack.order.filter((id) => id !== action.taskId), action.taskId];
      const deferred = [...stack.deferred.filter((id) => id !== action.taskId), action.taskId];
      const next = { ...state, stack: { ...stack, order, deferred }, pageMotion: { kind: 'jump', positive: true } satisfies PageMotion };
      // Im Filter ist jede offene Aufgabe zurückgestellt: weiter mit allen Kategorien – sonst drehte sich der Filter im Kreis.
      const founder = state.founder;
      const upNext = founder && state.filter !== 'all' ? pendingCards(next, founder, state.filter)[0]?.id : undefined;
      if (upNext && deferred.includes(upNext)) return { ...next, filter: 'all' };
      return next;
    }

    case 'OPEN_PANEL':
      return { ...state, panelLeadId: action.leadId };

    case 'CLOSE_PANEL':
      return { ...state, panelLeadId: null };

    case 'LS_RUN': {
      const { run } = action;
      let checked = state.leadSearch.checked;
      if (run.status !== 'running') {
        // Mit Profil geprüft oder von der KI-Vorprüfung aussortiert – beides nicht noch einmal ansehen.
        const processed = run.leads.filter((lead) => lead.profile || lead.status === 'screened_out').map((lead) => lead.id);
        checked = [...new Set([...checked, ...processed])];
      }
      return { ...state, leadSearch: { ...state.leadSearch, run, checked, lastProfile: run.profile } };
    }

    case 'LS_PHASE':
      return withRun(state, action.runId, (run) => ({ ...run, phase: action.phase }));

    case 'LS_LEADS':
      return withRun(state, action.runId, (run) => ({ ...run, leads: mergeLeads(run.leads, action.leads) }));

    case 'LS_CONNECTION_LOST':
      return withRun(state, action.runId, (run) =>
        run.status === 'running' ? { ...run, status: 'failed', error: action.error, finishedAt: Date.now() } : run,
      );

    case 'LS_CLEAR':
      return { ...state, leadSearch: { ...state.leadSearch, run: null, lastHandoff: null } };

    case 'LS_HANDOFF': {
      const run = state.leadSearch.run;
      if (!run || run.id !== action.runId) return state;
      return {
        ...state,
        leadSearch: {
          ...state.leadSearch,
          run: { ...run, handedOff: true },
          lastHandoff: { runId: run.id, count: action.count, status: 'pending' },
        },
      };
    }

    case 'LS_HANDOFF_STATE':
      return withHandoff(state, action.runId, (handoff) => ({ ...handoff, status: action.status }));

    case 'LS_HANDOFF_SAVED': {
      const next = withHandoff(state, action.runId, (handoff) => ({
        ...handoff,
        status: 'saved',
        created: action.created,
        createdOthers: action.createdOthers ?? [],
        skipped: action.skipped,
        savedAgainst: state.stack.fetchedAt,
      }));
      return { ...next, stack: { ...next.stack, handoffFirst: action.created } };
    }

    case 'LS_HANDOFF_FAILED':
      return withHandoff(state, action.runId, (handoff) => ({ ...handoff, status: 'failed', error: action.message }));

    case 'LS_UNDO_HANDOFF': {
      const handoff = state.leadSearch.lastHandoff;
      const run = state.leadSearch.run;
      if (!handoff || handoff.status !== 'pending') return state;
      return {
        ...state,
        leadSearch: {
          ...state.leadSearch,
          run: run && run.id === handoff.runId ? { ...run, handedOff: false } : run,
          lastHandoff: null,
        },
      };
    }
  }
}

/** Zählt die Übergabe schon mit, solange sie noch rückgängig machbar ist (sonst sähe man sie erst nach dem Speichern). */
export function pendingHandoffCount(state: DemoState): number {
  const handoff = state.leadSearch.lastHandoff;
  return handoff && (handoff.status === 'pending' || handoff.status === 'saving' || handoff.status === 'waiting') ? handoff.count : 0;
}

/** Was die Lead-Suche wissen muss: schon Geprüftes. Bekannte Leads gleicht das Backend selbst mit der Datenbank ab. */
export function leadSearchContext(state: DemoState) {
  // `owner`: für wen gesucht wird – an ihn legt der Server die Leads am Ende des Laufs selbst an (25.10.).
  return { known: [], pendingInvitations: [], checked: state.leadSearch.checked, ...(state.founder ? { owner: state.founder } : {}) };
}

const DemoContext = createContext<{ state: DemoState; dispatch: Dispatch<DemoAction> } | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, 0, createInitialState);
  return <DemoContext.Provider value={{ state, dispatch }}>{children}</DemoContext.Provider>;
}

export function useDemo() {
  const context = useContext(DemoContext);
  if (!context) throw new Error('useDemo muss innerhalb von DemoProvider verwendet werden');
  return context;
}
