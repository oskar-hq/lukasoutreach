import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  BOARD_COLUMN_NAME_MAX,
  CLOSED_LEAD_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_STAGES,
  REPLY_INTEREST_LABELS,
  REPLY_INTERESTS,
  orderedBoardKeys,
  replyInterestOf,
  type BoardColumn,
  type BoardColumnsResponse,
  type BoardLayout,
  type CockpitLead,
  type LeadStage,
  type ReplyInterest,
} from '../../../shared/leads';
import type { LeadCategory } from '../../../shared/leadSearch';
import { SCORE_TIER_LABELS, type ScoreTier } from '../../../shared/scoring';
import { FOUNDERS } from '../../data/founders';
import { cn } from '../../lib/cn';
import { ApiError, boardApi, leadsApi } from '../../lib/leadSearchApi';
import { leadCompany, leadName, leadPosition } from '../../lib/leadView';
import { formatRelative } from '../../lib/time';
import { useAuth } from '../../state/auth';
import { useDemo } from '../../state/demo';
import { canEditBoardColumns } from '../../../shared/auth';
import { actionAllowed } from '../lead/LeadActions';
import type { CardType, FounderId } from '../../state/types';
import { TYPE_LABELS } from '../stack/summary';
import { Button } from '../ui/Button';
import { AddContactDialog } from './AddContactDialog';
import { LostLeadsDialog } from './LostLeadsDialog';
import { PageHeader } from '../ui/PageHeader';
import { Segmented } from '../ui/Segmented';
import { SPRING_MENU } from '../../lib/motion';

type Layout = 'board' | 'table';
type Scope = 'mine' | 'all';
type Sort = 'activity' | 'score';
/**
 * Überblick nach Zielgruppe (Wunsch des Nutzers 19.10.): KI-Kategorie der Lead-Suche. Seit 27.10. (Kundengespräch)
 * mit Finanzdienstleistern; Bauträger bleiben für die bisherigen Leads wählbar.
 */
type Segment = 'all' | 'kapitalanlage' | 'finanzdienstleister' | 'bautraeger';
const SEGMENT_CATEGORIES: Record<Segment, LeadCategory[] | undefined> = {
  all: undefined,
  kapitalanlage: ['kapitalanlage_vertrieb'],
  finanzdienstleister: ['finanzdienstleister'],
  bautraeger: ['bautraeger_projektentwickler'],
};

const LAYOUT_KEY = 'cockpit.leads.layout';
const SEGMENT_KEY = 'cockpit.leads.segment';
/**
 * Mehr zeigt die Ansicht nicht auf einmal – die Datenbank hat in Phase 2 einige hundert Leads. Im Board je für „Neu“
 * und für die übrigen Stufen, damit viele neue Leads die weiteren Spalten nicht verdrängen.
 */
const LIMIT = 500;
/** Offene Stufen – Übergebene erst auf Wunsch („Übergebene zeigen“), Verlorene nur im Archiv (`LostLeadsDialog`). */
const OPEN_STAGES = LEAD_STAGES.filter((stage) => !CLOSED_LEAD_STAGES.includes(stage));
const WITHOUT_LOST = LEAD_STAGES.filter((stage) => stage !== 'lost');

/**
 * Verlorene sind archiviert (22.10.): nicht im Board und nicht in der Tabelle. Ausnahme: ein verlorener Lead mit
 * geplantem Follow-up in einer eigenen Spalte – der soll dort sichtbar bleiben.
 */
const visible = (lead: CockpitLead) => lead.stage !== 'lost' || (!!lead.boardColumn && !!lead.followUpPlan);

const TIER_DOT: Record<ScoreTier, string> = { high: 'bg-good', medium: 'bg-warn', low: 'bg-ink-3' };

/** Reihenfolge wie im Backend (`sort=recent` bzw. `sort=score`) – fürs Zusammenführen der Teilabfragen im Board. */
const byRecent = (a: CockpitLead, b: CockpitLead) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id);
const byScore = (a: CockpitLead, b: CockpitLead) => {
  const left = a.score?.total ?? null;
  const right = b.score?.total ?? null;
  if (left === null || right === null) return left === right ? a.lastActivityAt - b.lastActivityAt || a.id.localeCompare(b.id) : left === null ? 1 : -1;
  return right - left || a.lastActivityAt - b.lastActivityAt || a.id.localeCompare(b.id);
};

function readSegment(): Segment {
  try {
    const value = localStorage.getItem(SEGMENT_KEY);
    return value === 'kapitalanlage' || value === 'finanzdienstleister' || value === 'bautraeger' ? value : 'all';
  } catch {
    return 'all';
  }
}

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'table' ? 'table' : 'board';
  } catch {
    return 'board';
  }
}

/** Alle Leads aus der Datenbank (`GET /api/leads`) – als Pipeline-Board nach Stufe oder als Tabelle. */
export function LeadsView() {
  const { state, dispatch } = useDemo();
  const founder = state.founder as FounderId;
  // Eigene Spalten gelten für alle – anlegen, umbenennen, löschen nur Gründer und Admin (Mitarbeiter: nur ansehen).
  const { auth } = useAuth();
  const editColumns = auth.status !== 'authenticated' || canEditBoardColumns(auth.user);
  const [layout, setLayout] = useState<Layout>(readLayout);
  // Standard „Alle“ (Wunsch des Nutzers 01.11.), wie Chats und Aufgaben.
  const [scope, setScope] = useState<Scope>('all');
  const [sort, setSort] = useState<Sort>('activity');
  const [segment, setSegment] = useState<Segment>(readSegment);
  const [showClosed, setShowClosed] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [result, setResult] = useState<{ leads: CockpitLead[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  // Reihenfolge und Namen der Stufen-Spalten (22.10.) – fehlt bei älteren Servern.
  const [boardLayout, setBoardLayout] = useState<BoardLayout | null>(null);
  const [boardNotice, setBoardNotice] = useState<string | null>(null);
  // Archiv „Verloren“ (22.10.): Anzahl im Board, Liste im Dialog.
  const [lostTotal, setLostTotal] = useState<number | null>(null);
  const [lostOpen, setLostOpen] = useState(false);
  // Persönlicher Kontakt per Link (Wunsch des Nutzers 19.10.).
  const [contactOpen, setContactOpen] = useState(false);
  const [contactNotice, setContactNotice] = useState<string | null>(null);
  const requestId = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const applyBoard = (response: BoardColumnsResponse) => {
    setColumns(response.columns);
    setBoardLayout(response.layout ?? null);
  };

  useEffect(() => {
    boardApi
      .columns()
      .then(applyBoard)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setError(null);
    try {
      // „Länger nichts passiert“: zuletzt bearbeitete zuerst laden und umdrehen – bei mehr als LIMIT Leads fehlen so die
      // ältesten, nicht die neuesten.
      const base = {
        owner: scope === 'mine' ? founder : undefined,
        q: debounced,
        sort: sort === 'activity' ? ('recent' as const) : sort,
        limit: LIMIT,
        category: SEGMENT_CATEGORIES[segment],
      };
      let response: { leads: CockpitLead[]; total: number };
      if (layout === 'board') {
        // „Neu“ getrennt laden. Eigene Spalten bleiben vollständig: auch verlorene/übergebene Leads, die in einer eigenen
        // Spalte liegen (und neue in eigenen Spalten – die doppelten fallen unten heraus).
        const rest = WITHOUT_LOST.filter((stage) => stage !== 'new' && (showClosed || OPEN_STAGES.includes(stage)));
        const [fresh, others, lost] = await Promise.all([
          leadsApi.list({ ...base, stage: ['new'] }),
          leadsApi.list({ ...base, stage: rest, withBoardColumns: true }),
          leadsApi.list({ ...base, stage: ['lost'], limit: 1 }),
        ]);
        if (id === requestId.current) setLostTotal(lost.total);
        const known = new Set(others.leads.map((lead) => lead.id));
        const extra = fresh.leads.filter((lead) => !known.has(lead.id));
        const doubled = fresh.leads.length - extra.length;
        const shown = [...others.leads, ...extra].filter(visible);
        response = { leads: shown.sort(sort === 'score' ? byScore : byRecent), total: fresh.total + others.total - doubled - (others.leads.length + extra.length - shown.length) };
      } else {
        const [list, lost] = await Promise.all([
          leadsApi.list({ ...base, stage: showClosed ? WITHOUT_LOST : OPEN_STAGES }),
          leadsApi.list({ ...base, stage: ['lost'], limit: 1 }),
        ]);
        if (id === requestId.current) setLostTotal(lost.total);
        response = list;
      }
      if (id === requestId.current) setResult(sort === 'activity' ? { ...response, leads: [...response.leads].reverse() } : response);
    } catch {
      if (id === requestId.current) setError('Die Leads konnten nicht geladen werden.');
    }
  }, [scope, founder, debounced, sort, showClosed, layout, segment]);

  // Neu laden bei anderen Filtern, nach Änderungen im Lead-Panel (schließt) und wenn der Tagesstapel neu kam.
  const panelOpen = !!state.panelLeadId;
  useEffect(() => {
    if (!panelOpen) void load();
  }, [load, panelOpen, state.stack.fetchedAt]);

  const changeLayout = (next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // nur Komfort
    }
  };

  const changeSegment = (next: Segment) => {
    setSegment(next);
    try {
      localStorage.setItem(SEGMENT_KEY, next);
    } catch {
      // nur Komfort
    }
  };

  const open = (leadId: string) => dispatch({ type: 'OPEN_PANEL', leadId });
  const contactOwnerName = auth.status === 'authenticated' && auth.user.founder === founder ? null : FOUNDERS[founder].name;
  const leads = result?.leads ?? [];

  // Ziehen und Ablegen im Board (Wunsch des Nutzers 19.10.: frei, auch zurück): in eigene Spalten und jede Stufe.
  // Vorwärts nach „Vernetzt“, „Termin“ und „Verloren“ als echte Aktion (zählt im Dashboard), sonst nur die Stufe.
  // In „Antwort“ zusätzlich interessiert / nicht interessiert.
  const move = async (lead: CockpitLead, target: BoardTarget) => {
    setBoardNotice(null);
    // Schon etwas gespeichert (z. B. die Stufe), das Zweite scheitert: trotzdem neu laden, sonst stimmt das Board nicht.
    let changed = false;
    try {
      if (target.kind === 'custom') {
        if (lead.boardColumn === target.id) return;
        await leadsApi.update(lead.id, { boardColumn: target.id });
      } else if (target.stage === lead.stage) {
        const interest = target.interest && target.interest !== replyInterestOf(lead) ? target.interest : undefined;
        if (!lead.boardColumn && !interest) return;
        await leadsApi.update(lead.id, { ...(lead.boardColumn ? { boardColumn: null } : {}), ...(interest ? { replyInterest: interest } : {}) });
      } else {
        // Rückfrage erst nach dem Ablegen – ein Dialog mitten im Ziehen bringt den Browser durcheinander.
        if (target.stage === 'lost') {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          if (!window.confirm(`${leadName(lead)} als verloren markieren? Im Lead-Panel kannst du ihn wieder öffnen.`)) return;
        }
        // „Vernetzt“ setzt nur der LinkedIn-Abgleich (20.10., Wunsch des Nutzers) – nicht von Hand aus „Neu“/„Anfrage gesendet“.
        if (target.stage === 'connected' && (lead.stage === 'new' || lead.stage === 'invited')) {
          setBoardNotice('„Vernetzt“ trägt der LinkedIn-Abgleich ein, sobald die Anfrage wirklich angenommen ist.');
          return;
        }
        const action =
          target.stage === 'meeting' && actionAllowed(lead, 'meeting_booked')
              ? ('meeting_booked' as const)
              : target.stage === 'lost' && actionAllowed(lead, 'lost')
                ? ('lost' as const)
                : null;
        if (action) await leadsApi.act(lead.id, { action });
        changed = !!action;
        const interest = target.interest && target.interest !== replyInterestOf(lead) ? target.interest : undefined;
        if (!action || lead.boardColumn || interest) {
          await leadsApi.update(lead.id, {
            ...(action ? {} : { stage: target.stage }),
            ...(lead.boardColumn ? { boardColumn: null } : {}),
            ...(interest ? { replyInterest: interest } : {}),
          });
        }
      }
      await load();
    } catch (caught) {
      setBoardNotice(caught instanceof ApiError ? caught.message : 'Verschieben hat nicht geklappt.');
      if (changed) void load();
    }
  };

  const addColumn = async (name: string) => {
    await boardApi.add(name);
    applyBoard(await boardApi.columns());
  };
  const renameColumn = async (id: string, name: string) => {
    const column = await boardApi.rename(id, name);
    setColumns((current) => current.map((entry) => (entry.id === id ? column : entry)));
  };
  const removeColumn = async (id: string) => {
    applyBoard(await boardApi.remove(id));
    await load();
  };
  // Spalten frei anordnen und Stufen umbenennen (Wunsch des Nutzers 22.10.) – die Funktion der Stufe bleibt.
  const reorderColumns = async (order: string[]) => {
    setBoardLayout((current) => (current ? { ...current, order } : current));
    try {
      applyBoard(await boardApi.order(order));
    } catch (caught) {
      setBoardNotice(caught instanceof ApiError ? caught.message : 'Verschieben der Spalte hat nicht geklappt.');
      applyBoard(await boardApi.columns().catch(() => ({ columns })));
    }
  };
  const renameStage = async (stage: LeadStage, name: string | null) => {
    applyBoard(await boardApi.renameStage(stage, name));
  };

  return (
    // Board nutzt die ganze Monitorbreite (Wunsch des Nutzers 11.10.: möglichst wenig seitlich scrollen), Tabelle bleibt schmal.
    <div
      className={cn('mx-auto w-full px-4 pb-28 pt-8 sm:px-6 sm:pt-12', layout === 'board' ? 'lg:px-10' : 'max-w-[1240px]')}
      data-testid="leads-view"
    >
      <PageHeader
        className="mb-6"
        title="Leads"
        aside={
          result && (
            <span data-testid="leads-count">
              {result.total}
              {result.total > leads.length ? ` · die ersten ${leads.length}` : ''}
            </span>
          )
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Segmented
          ariaLabel="Zuständig"
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'mine', label: 'Meine' },
            { value: 'all', label: 'Alle' },
          ]}
        />
        <label className="relative order-last w-full sm:order-none sm:ml-auto sm:w-64">
          <span className="sr-only">Leads durchsuchen</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, Firma …"
            className="h-[38px] w-full rounded-[10px] border border-transparent bg-surface-3 pl-9 pr-3 text-[16px] text-ink outline-none placeholder:text-ink-4 focus:border-accent sm:text-[13px]"
            data-testid="leads-search"
          />
        </label>
        <button
          type="button"
          onClick={() => setContactOpen(true)}
          data-testid="contact-add"
          aria-label="Kontakt hinzufügen"
          title="Kontakt hinzufügen"
          className="ml-auto flex h-8 min-w-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <UserPlus className="h-4 w-4" aria-hidden />
          {/* Handy: nur das Symbol – eine Zeile weniger über dem Board. */}
          <span className="hidden sm:inline">Kontakt hinzufügen</span>
        </button>
        <div className="relative" ref={menuRef}>
          <ViewMenu
            layout={layout}
            sort={sort}
            segment={segment}
            showClosed={showClosed}
            onLayout={changeLayout}
            onSegment={changeSegment}
            onSort={setSort}
            onShowClosed={setShowClosed}
            container={menuRef}
          />
        </div>
      </div>

      {contactNotice && (
        <p role="status" className="mb-4 flex items-baseline gap-2 text-[13.5px] text-ink" data-testid="contact-notice">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-good" aria-hidden />
          {contactNotice}
        </p>
      )}

      {result && result.total > leads.length && (
        <p role="status" className="mb-4 flex items-baseline gap-2 text-[13.5px] text-ink" data-testid="leads-limit">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-warn" aria-hidden />
          {sort === 'score' ? `Nur die ${leads.length} mit dem höchsten Score` : `Nur die ${leads.length} zuletzt bearbeiteten`} von {result.total} Leads –
          such nach Name oder Firma, um die übrigen zu finden.
        </p>
      )}

      {error ? (
        <div role="alert" className="py-16 text-center">
          <p className="text-[15px] text-ink">{error}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
            Erneut versuchen
          </Button>
        </div>
      ) : !result ? (
        <p role="status" className="py-16 text-center text-[14px] text-ink-3">
          Leads werden geladen …
        </p>
      ) : leads.length === 0 ? (
        <p className="py-16 text-center text-[14px] text-ink-3">{debounced.trim() ? 'Keine Leads zu dieser Suche.' : 'Noch keine Leads.'}</p>
      ) : layout === 'board' ? (
        <>
          {boardNotice && (
            <p role="status" className="mb-4 flex items-baseline gap-2 text-[13.5px] text-ink" data-testid="board-notice">
              <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-warn" aria-hidden />
              {boardNotice}
            </p>
          )}
          <Board
            leads={leads}
            columns={columns}
            layout={boardLayout}
            lostTotal={lostTotal}
            onOpenLost={() => setLostOpen(true)}
            showOwner={scope === 'all'}
            closedHidden={!showClosed}
            onShowClosed={() => setShowClosed(true)}
            onOpen={open}
            onMove={(lead, target) => void move(lead, target)}
            {...(editColumns
              ? { onAddColumn: addColumn, onRenameColumn: renameColumn, onRemoveColumn: removeColumn, onReorder: reorderColumns, onRenameStage: renameStage }
              : {})}
          />
        </>
      ) : (
        <>
          <Table leads={leads} showOwner={scope === 'all'} onOpen={open} />
          <button
            type="button"
            onClick={() => setLostOpen(true)}
            className="mt-4 text-[13px] text-ink-3 transition-colors hover:text-ink"
            data-testid="lost-open"
          >
            Verloren{lostTotal === null ? '' : ` · ${lostTotal}`} · ansehen
          </button>
        </>
      )}

      <LostLeadsDialog
        open={lostOpen}
        owner={scope === 'mine' ? founder : undefined}
        category={SEGMENT_CATEGORIES[segment]}
        onClose={() => setLostOpen(false)}
        onOpenLead={(leadId) => {
          setLostOpen(false);
          open(leadId);
        }}
        onChanged={() => void load()}
      />
      <AddContactDialog
        open={contactOpen}
        owner={founder}
        ownerName={contactOwnerName}
        onClose={() => setContactOpen(false)}
        onAdded={(response) => {
          setContactOpen(false);
          setContactNotice(response.message);
          // Gleich im Lead-Panel zeigen – beim Schließen lädt die Liste neu.
          open(response.lead.id);
        }}
      />
    </div>
  );
}

const LAYOUTS: Array<{ value: Layout; label: string }> = [
  { value: 'board', label: 'Board' },
  { value: 'table', label: 'Tabelle' },
];
const SEGMENTS: Array<{ value: Segment; label: string }> = [
  { value: 'all', label: 'Alle Zielgruppen' },
  { value: 'kapitalanlage', label: 'Kapitalanlage' },
  { value: 'finanzdienstleister', label: 'Finanzdienstleister' },
  { value: 'bautraeger', label: 'Bauträger' },
];
const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'activity', label: 'Länger nichts passiert' },
  { value: 'score', label: 'Score' },
];

/**
 * Darstellung, Zielgruppe und Sortierung in einem Menü – wie der Filter im Fokus-Modus. Die Zielgruppe stand bis 25.10.
 * als zweiter Schalter in der Zeile (Wunsch des Nutzers: weniger Auswahl auf einmal); am Knopf steht sie nur, wenn
 * sie von „Alle“ abweicht.
 */
function ViewMenu({
  layout,
  sort,
  segment,
  showClosed,
  onLayout,
  onSegment,
  onSort,
  onShowClosed,
  container,
}: {
  layout: Layout;
  sort: Sort;
  segment: Segment;
  showClosed: boolean;
  onLayout: (layout: Layout) => void;
  onSegment: (segment: Segment) => void;
  onSort: (sort: Sort) => void;
  onShowClosed: (show: boolean) => void;
  container: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Esc schließt nur das Menü – nicht zusätzlich die Ansicht dahinter.
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, container, close]);

  const item = (checked: boolean, label: string, onSelect: () => void, role: 'menuitemradio' | 'menuitemcheckbox' = 'menuitemradio') => (
    <button
      key={label}
      type="button"
      role={role}
      aria-checked={checked}
      onClick={() => {
        onSelect();
        close();
      }}
      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] text-ink transition-colors hover:bg-surface-3"
    >
      <span className="flex w-4 justify-center">{checked && <Check className="h-4 w-4" strokeWidth={2.5} />}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
  const eyebrow = 'px-3 pb-1 pt-2 text-[11.5px] font-semibold text-ink-3';

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="leads-view-options"
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <span className="sr-only">Ansicht: </span>
        {layout === 'board' ? 'Board' : 'Tabelle'}
        {segment !== 'all' ? ` · ${SEGMENTS.find((option) => option.value === segment)?.label}` : ''}
        {sort === 'score' ? ' · Score' : ''}
        {showClosed ? ' · alle' : ''}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Ansicht"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING_MENU}
            style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-10 z-40 w-[240px] overflow-hidden rounded-[14px] border border-line bg-surface-2 p-1.5 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.85)]"
          >
            <div role="group" aria-label="Darstellung">
              <p aria-hidden className={eyebrow}>
                Darstellung
              </p>
              {LAYOUTS.map((option) => item(layout === option.value, option.label, () => onLayout(option.value)))}
            </div>
            <div role="group" aria-label="Zielgruppe" className="mt-1 border-t border-line pt-1">
              <p aria-hidden className={eyebrow}>
                Zielgruppe
              </p>
              {SEGMENTS.map((option) => item(segment === option.value, option.label, () => onSegment(option.value)))}
            </div>
            <div role="group" aria-label="Sortierung" className="mt-1 border-t border-line pt-1">
              <p aria-hidden className={eyebrow}>
                Sortierung
              </p>
              {SORTS.map((option) => item(sort === option.value, option.label, () => onSort(option.value)))}
            </div>
            <div role="group" aria-label="Filter" className="mt-1 border-t border-line pt-1">
              {item(showClosed, 'Übergebene zeigen', () => onShowClosed(!showClosed), 'menuitemcheckbox')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function ScoreBadge({ lead }: { lead: CockpitLead }) {
  if (!lead.score) return null;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" title={`Score ${SCORE_TIER_LABELS[lead.score.tier]}`}>
      <span className={cn('h-1.5 w-1.5 rounded-full', TIER_DOT[lead.score.tier])} aria-hidden />
      {Math.round(lead.score.total * 100)}
    </span>
  );
}

type BoardTarget = { kind: 'stage'; stage: LeadStage; interest?: ReplyInterest } | { kind: 'custom'; id: string };

interface BoardProps {
  leads: CockpitLead[];
  columns: BoardColumn[];
  /** Reihenfolge und Namen der Stufen-Spalten; null = Standard. */
  layout: BoardLayout | null;
  showOwner: boolean;
  /** Archiv „Verloren“: Anzahl (null = noch unbekannt) und Öffnen des Dialogs. */
  lostTotal: number | null;
  onOpenLost: () => void;
  /** Übergebene nicht geladen – Spalte bleibt klein mit „Ausgeblendet · zeigen“. */
  closedHidden: boolean;
  onShowClosed: () => void;
  onOpen: (leadId: string) => void;
  onMove: (lead: CockpitLead, target: BoardTarget) => void;
  /** Fehlen alle drei, lassen sich Spalten nur ansehen (Mitarbeiter). */
  onAddColumn?: (name: string) => Promise<void>;
  onRenameColumn?: (id: string, name: string) => Promise<void>;
  onRemoveColumn?: (id: string) => Promise<void>;
  /** Fehlen beide, lassen sich Spalten nicht verschieben oder Stufen umbenennen (Mitarbeiter). */
  onReorder?: (order: string[]) => Promise<void>;
  onRenameStage?: (stage: LeadStage, name: string | null) => Promise<void>;
}

/**
 * Pipeline nach `LEAD_STAGES` plus eigene Spalten (z. B. „Meeting Close“) – Leads per Ziehen verschieben. Spalten
 * scrollen innerhalb des Boards, nie die ganze Seite.
 */
function Board({ leads, columns, layout, lostTotal, onOpenLost, showOwner, closedHidden, onShowClosed, onOpen, onMove, onAddColumn, onRenameColumn, onRemoveColumn, onReorder, onRenameStage }: BoardProps) {
  const stageName = (stage: LeadStage) => layout?.stageNames[stage] ?? LEAD_STAGE_LABELS[stage];
  const keys = orderedBoardKeys(LEAD_STAGES, columns, layout?.order);
  // Wer heute dran ist, sticht als Einziges heraus (Von-Restorff, Wunsch des Nutzers 25.10.): offene Aufgaben im Stapel.
  const { state } = useDemo();
  const todayTask = new Map<string, CardType>();
  for (const id of state.stack.order) {
    const task = state.stack.tasks[id];
    // Neue Leads sind immer „heute“ dran – die Marke dort würde die ganze Spalte „Neu“ blau färben.
    if (task && task.type !== 'lead' && !state.stack.outcomes[id]) todayTask.set(task.lead.id, task.type);
  }
  // Nach links/rechts tauschen – nur mit Rechten (onReorder).
  const shift = (key: string, by: -1 | 1) => {
    const index = keys.indexOf(key);
    const target = index + by;
    if (!onReorder || target < 0 || target >= keys.length) return undefined;
    return () => {
      const next = [...keys];
      [next[index], next[target]] = [next[target], next[index]];
      void onReorder(next);
    };
  };
  const [dragOver, setDragOver] = useState<string | null>(null);
  const byColumn = useMemo(() => {
    const map = new Map<string, CockpitLead[]>();
    const custom = new Set(columns.map((column) => column.id));
    for (const lead of leads) {
      const key = lead.boardColumn && custom.has(lead.boardColumn) ? `custom:${lead.boardColumn}` : `stage:${lead.stage}`;
      map.set(key, [...(map.get(key) ?? []), lead]);
    }
    return map;
  }, [leads, columns]);

  const dropProps = (key: string, target: BoardTarget) => ({
    // Die Ablagen in „Antwort“ liegen in der Spalte – nur die innerste reagiert.
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      if (dragOver !== key) setDragOver(key);
    },
    onDragLeave: () => setDragOver((current) => (current === key ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDragOver(null);
      const lead = leads.find((entry) => entry.id === event.dataTransfer.getData('text/plain'));
      if (lead) onMove(lead, target);
    },
  });

  // Ruhige Zeilen statt Karten (Wunsch des Nutzers 07.10.: minimalistisch): Name, Score, Firma – mehr im Lead-Panel.
  const renderCards = (list: CockpitLead[]) => (
    <ul className="space-y-0.5">
      {list.map((lead) => (
        <li key={lead.id}>
          <button
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', lead.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => onOpen(lead.id)}
            className="-mx-2.5 w-[calc(100%+1.25rem)] cursor-grab rounded-[10px] px-2.5 py-2.5 text-left transition-colors hover:bg-surface-3 active:cursor-grabbing"
            data-testid="board-card"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{leadName(lead)}</span>
              <span className="shrink-0 text-[12.5px] text-ink-3">
                <ScoreBadge lead={lead} />
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[12.5px] text-ink-2">{leadCompany(lead)}</span>
            {todayTask.has(lead.id) && (
              <span className="mt-1 flex items-center gap-1.5 text-[12px] font-medium text-accent" data-testid="board-today">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
                heute · {TYPE_LABELS[todayTask.get(lead.id)!].one}
              </span>
            )}
            {(showOwner || lead.boardColumn) && (
              <span className="mt-0.5 block truncate text-[12px] text-ink-3">
                {showOwner && FOUNDERS[lead.owner].name}
                {showOwner && lead.boardColumn && ' · '}
                {lead.boardColumn && stageName(lead.stage)}
              </span>
            )}
          </button>
        </li>
      ))}
      {list.length === 0 && <li className="py-2.5 text-[13px] text-ink-4">Noch niemand</li>}
    </ul>
  );

  return (
    <div className="scroll-thin -mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10" data-testid="leads-board">
      {/* Spalten wachsen gleichmäßig mit der Breite; erst unter der Mindestbreite scrollt das Board seitlich. */}
      <div className="flex gap-5">
        {keys.map((columnKey) => {
          const custom = columnKey.startsWith('custom:') ? columns.find((column) => `custom:${column.id}` === columnKey) : undefined;
          const moveLeft = shift(columnKey, -1);
          const moveRight = shift(columnKey, 1);
          if (custom) {
            const column = custom;
            const key = columnKey;
            const list = byColumn.get(key) ?? [];
            return (
              <section
                key={key}
                className={cn('min-w-[150px] flex-1 basis-0 rounded-xl transition-colors', dragOver === key && 'bg-surface-2')}
                aria-label={column.name}
                data-testid="custom-column"
                {...dropProps(key, { kind: 'custom', id: column.id })}
              >
                <ColumnHeader
                  name={column.name}
                  count={list.length}
                  onRename={onRenameColumn && ((name) => onRenameColumn(column.id, name))}
                  onRemove={onRemoveColumn && (() => onRemoveColumn(column.id))}
                  onMoveLeft={moveLeft}
                  onMoveRight={moveRight}
                />
                {renderCards(list)}
              </section>
            );
          }
          const stage = columnKey.slice('stage:'.length) as LeadStage;
          const key = `stage:${stage}`;
          const list = byColumn.get(key) ?? [];
          // „Verloren“ ist immer klein: ein Ordner zum Archiv (22.10.) und Ablage zum Verlieren per Ziehen.
          const archive = stage === 'lost';
          const hidden = archive || (closedHidden && CLOSED_LEAD_STAGES.includes(stage));
          return (
            <section
              key={stage}
              className={cn(
                'basis-0 rounded-xl transition-colors',
                // Ausgeblendete Endstufen brauchen nur Platz für „Ausgeblendet · zeigen“.
                hidden ? 'min-w-[120px] flex-[0.6]' : 'min-w-[150px] flex-1',
                dragOver === key && 'bg-surface-2',
              )}
              aria-label={stageName(stage)}
              data-testid={`column-${stage}`}
              {...dropProps(key, { kind: 'stage', stage })}
            >
              <ColumnHeader
                name={stageName(stage)}
                count={hidden ? undefined : list.length}
                defaultName={LEAD_STAGE_LABELS[stage]}
                onRename={onRenameStage && ((name) => onRenameStage(stage, name))}
                onMoveLeft={moveLeft}
                onMoveRight={moveRight}
              />
              {stage === 'replied' ? (
                // Antwort geteilt (Wunsch des Nutzers 19.10.): je eine Ablage für interessiert / nicht interessiert.
                REPLY_INTERESTS.map((interest) => {
                  const subKey = `${key}:${interest}`;
                  return (
                    <div
                      key={interest}
                      className={cn('-mx-1.5 mb-3 rounded-[10px] px-1.5 transition-colors', dragOver === subKey && 'bg-surface-3')}
                      data-testid={`column-replied-${interest}`}
                      {...dropProps(subKey, { kind: 'stage', stage, interest })}
                    >
                      <h3 className="mb-1 flex items-baseline justify-between text-[12px] font-medium text-ink-3">
                        {REPLY_INTEREST_LABELS[interest]}
                        <span className="tabular-nums">{list.filter((lead) => replyInterestOf(lead) === interest).length}</span>
                      </h3>
                      {renderCards(list.filter((lead) => replyInterestOf(lead) === interest))}
                    </div>
                  );
                })
              ) : archive ? (
                <button
                  type="button"
                  onClick={onOpenLost}
                  className="w-full py-2.5 text-left text-[13px] text-ink-3 transition-colors hover:text-ink"
                  data-testid="lost-open"
                >
                  {lostTotal === null ? 'Archiv' : `${lostTotal} archiviert`} · ansehen
                </button>
              ) : hidden ? (
                <button
                  type="button"
                  onClick={onShowClosed}
                  className="w-full py-2.5 text-left text-[13px] text-ink-3 transition-colors hover:text-ink"
                  data-testid={`show-closed-${stage}`}
                >
                  Ausgeblendet · zeigen
                </button>
              ) : (
                renderCards(list)
              )}
            </section>
          );
        })}
        {onAddColumn && <AddColumn onAdd={onAddColumn} />}
      </div>
    </div>
  );
}

/**
 * Kopf jeder Board-Spalte (Wunsch des Nutzers 22.10.: alle gleich): Name, Anzahl und – mit Rechten – umbenennen, nach
 * links/rechts schieben, eigene Spalten löschen. Stufen: leerer Name = Standardname (`defaultName`).
 */
function ColumnHeader({
  name,
  count,
  defaultName,
  onRename,
  onRemove,
  onMoveLeft,
  onMoveRight,
}: {
  name: string;
  /** undefined = keine Zahl (ausgeblendete Endstufe). */
  count?: number;
  /** Nur Stufen-Spalten: leer speichern setzt auf diesen Namen zurück. */
  defaultName?: string;
  onRename?: (name: string) => Promise<void>;
  onRemove?: () => Promise<void>;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setValue(name);
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    const clean = value.trim();
    if (clean === name || (!clean && !defaultName)) return setEditing(false);
    try {
      // Stufe: Standardname oder leer = eigener Name weg.
      await onRename?.(defaultName && (clean === defaultName || !clean) ? '' : clean);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Umbenennen hat nicht geklappt.');
    }
  };
  if (editing) {
    return (
      <div className="mb-3">
        <input
          autoFocus
          value={value}
          maxLength={BOARD_COLUMN_NAME_MAX}
          placeholder={defaultName}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
            if (event.key === 'Escape') setEditing(false);
          }}
          aria-label="Name der Spalte"
          className="h-8 w-full rounded-[8px] border border-transparent bg-surface-3 px-2 text-[16px] font-bold text-ink outline-none placeholder:font-normal placeholder:text-ink-4 focus:border-accent sm:text-[13px]"
          data-testid="board-column-rename"
        />
        {error && <p className="mt-1 text-[11.5px] text-ink">{error}</p>}
      </div>
    );
  }
  const tool = 'rounded p-0.5 text-ink-4 hover:text-ink-2';
  const tools = !!(onMoveLeft || onMoveRight || onRename || onRemove);
  return (
    <h2 className="group relative mb-3 flex items-center justify-between gap-2 text-[13px] font-bold text-ink" data-testid="board-column-header">
      <span className="min-w-0 flex-1 truncate" data-testid="board-column-title">
        {name}
      </span>
      {/* Desktop: Knöpfe erst beim Überfahren, über der Zahl – sonst kosten sie den Namen Platz. Handy: immer sichtbar. */}
      {tools && (
        <span className="flex shrink-0 items-center gap-1 font-normal md:absolute md:right-0 md:top-1/2 md:-translate-y-1/2 md:bg-canvas md:pl-2 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100">
          {onMoveLeft && (
            <button type="button" onClick={onMoveLeft} aria-label={`Spalte „${name}“ nach links`} className={tool} data-testid="board-column-left">
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          )}
          {onMoveRight && (
            <button type="button" onClick={onMoveRight} aria-label={`Spalte „${name}“ nach rechts`} className={tool} data-testid="board-column-right">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
          {onRename && (
            <button type="button" onClick={start} aria-label={`Spalte „${name}“ umbenennen`} className={tool} data-testid="board-column-edit">
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Spalte „${name}“ löschen? Die Leads darin kommen zurück in ihre Stufe.`)) void onRemove();
              }}
              aria-label={`Spalte „${name}“ löschen`}
              className={tool}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
      )}
      {count !== undefined && <span className="shrink-0 font-normal tabular-nums text-ink-3">{count}</span>}
    </h2>
  );
}

function AddColumn({ onAdd }: { onAdd: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    if (!name.trim()) return;
    try {
      await onAdd(name);
      setName('');
      setOpen(false);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Anlegen hat nicht geklappt.');
    }
  };
  return (
    <section className={cn('shrink-0', open ? 'w-[200px]' : 'w-9')} aria-label="Eigene Spalte anlegen">
      {open ? (
        <div className="px-1">
          <input
            autoFocus
            value={name}
            maxLength={BOARD_COLUMN_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
              if (event.key === 'Escape') setOpen(false);
            }}
            placeholder="z. B. Meeting Close"
            aria-label="Name der neuen Spalte"
            className="h-9 w-full rounded-[10px] border border-transparent bg-surface-3 px-3 text-[16px] text-ink outline-none placeholder:text-ink-4 focus:border-accent sm:text-[13px]"
            data-testid="board-column-name"
          />
          {error && <p className="mt-1 text-[11.5px] text-ink">{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void add()} disabled={!name.trim()} data-testid="board-column-add">
              Anlegen
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Abbrechen
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          // Zugeklappt nur „+“ – spart Breite, damit das ganze Board auf den Bildschirm passt.
          aria-label="Eigene Spalte"
          title="Eigene Spalte"
          className="flex h-9 w-full items-center justify-center rounded-[10px] bg-surface-2 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          data-testid="board-column-new"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </section>
  );
}

function Table({ leads, showOwner, onOpen }: { leads: CockpitLead[]; showOwner: boolean; onOpen: (leadId: string) => void }) {
  return (
    <div data-testid="leads-table">
      <table className="w-full table-fixed text-left text-[13.5px]">
        <thead className="text-[12px] font-semibold text-ink-3">
          <tr>
            <th className="w-[60%] px-2 py-2.5 font-medium sm:w-[30%]">Lead</th>
            <th className="w-[40%] px-3 py-2.5 font-medium sm:w-[14%]">Stufe</th>
            <th className="hidden w-[9%] px-3 py-2.5 font-medium sm:table-cell">Score</th>
            {showOwner && <th className="hidden w-[11%] px-3 py-2.5 font-medium md:table-cell">Zuständig</th>}
            <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Nächster Schritt</th>
            <th className="hidden w-[14%] px-2 py-2.5 text-right font-medium sm:table-cell">Zuletzt</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr
              key={lead.id}
              onClick={() => onOpen(lead.id)}
              className="cursor-pointer transition-colors hover:bg-surface-2"
            >
              <td className="px-2 py-3">
                {/* Der Name ist der Knopf – so erreicht man jede Zeile auch per Tastatur. */}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(lead.id);
                  }}
                  className="block max-w-full truncate text-left font-semibold text-ink hover:underline"
                >
                  {leadName(lead)}
                </button>
                <span className="block truncate text-[12.5px] text-ink-3">
                  <span className="hidden sm:inline">{leadPosition(lead)} · </span>
                  {leadCompany(lead)}
                </span>
              </td>
              <td className="truncate px-3 py-3 text-ink-2">{LEAD_STAGE_LABELS[lead.stage]}</td>
              <td className="hidden px-3 py-3 text-ink-2 sm:table-cell">
                <ScoreBadge lead={lead} />
              </td>
              {showOwner && <td className="hidden px-3 py-3 text-ink-2 md:table-cell">{FOUNDERS[lead.owner].name}</td>}
              <td className="hidden truncate px-3 py-3 text-ink-2 lg:table-cell">{lead.nextStep ?? null}</td>
              <td className="hidden px-2 py-3 text-right text-[12.5px] tabular-nums text-ink-3 sm:table-cell">{formatRelative(lead.lastActivityAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
