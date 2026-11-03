import { AnimatePresence, animate, motion, useDragControls, useIsPresent, useMotionValue, useReducedMotion, type PanInfo } from 'motion/react';
import { workingFounders } from '../../../shared/auth';
import { ArrowUpRight, X } from 'lucide-react';
import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { type CockpitLead, type LeadEventKind } from '../../../shared/leads';
import { LEAD_TYPE_LABELS } from '../../../shared/scoring';
import { ApiError, leadsApi } from '../../lib/leadSearchApi';
import { metaLibraryIsPage, metaLibraryUrl, readableError } from '../../lib/leadView';
import { FOUNDERS } from '../../data/founders';
import { cn } from '../../lib/cn';
import { NO_GESTURE, SPRING_BACK, shouldDismiss, useMediaQuery } from '../../lib/gesture';
import { EASE_OUT } from '../../lib/motion';
import { confidencePercent, leadCompany, leadFit, leadName, leadPosition, leadRegion, leadSignal, linkedinProfileUrl, replyAssessmentParts } from '../../lib/leadView';
import { formatDateTime } from '../../lib/time';
import { isActivatableTarget, isTypingTarget } from '../../lib/useHotkeys';
import { useAccess } from '../../state/auth';
import { useCockpit, useLeadDetail, type TimelineEntry } from '../../state/cockpit';
import { useCrm } from '../../state/crm';
import { useDemo } from '../../state/demo';
import { Kbd } from '../ui/Kbd';
import { Dot } from '../ui/Status';
import { CompanyData } from './CompanyData';
import { Eyebrow } from './Eyebrow';
import {
  ActionFormSheet,
  DataRows,
  DeleteSheetContent,
  FIELD_LABELS,
  FieldEditor,
  LeadFooter,
  MoreSheetContent,
  QualityFeedback,
  formTitle,
  useLeadRun,
  type DataField,
} from './LeadActions';
import { primaryAction, stageView, STAGE_STEPS, type ActionForm } from './leadStage';
import { PanelSheet } from './PanelSheet';
import { FailedFilters, HardFilterChips, HardFilterList, ScoreAnalysis, ScoreChip } from './ScoreCard';
import { safeHref } from '../../lib/safeHref';

/** Art eines Verlaufseintrags – farbige Zeile über dem Titel und Punkt auf der Linie. */
type EventGroup = 'Quelle' | 'KI' | 'Kontakt' | 'Status' | 'Notiz' | 'Daten';

const EVENT_GROUPS: Record<LeadEventKind, EventGroup> = {
  created: 'Quelle',
  assessed: 'KI',
  invite_sent: 'Kontakt',
  invite_accepted: 'Kontakt',
  message_sent: 'Kontakt',
  message_received: 'Kontakt',
  meeting_booked: 'Kontakt',
  handed_over: 'Status',
  lost: 'Status',
  stage_changed: 'Status',
  owner_changed: 'Status',
  reopened: 'Status',
  note: 'Notiz',
  enriched: 'Daten',
};

/** Farben aus dem Entwurf (Lead-Ansicht Redesign): leise Töne, nur Punkt und Eyebrow – nie flächig. */
const GROUP_COLORS: Record<EventGroup, string> = {
  Quelle: 'var(--color-ink-2)',
  Daten: 'var(--color-ink-2)',
  KI: 'oklch(0.74 0.13 300)',
  Kontakt: 'var(--color-good)',
  Status: 'oklch(0.78 0.12 80)',
  Notiz: 'oklch(0.75 0.11 240)',
};

const PENDING_LABELS = {
  scheduled: 'Noch nicht gespeichert',
  sending: 'Wird gespeichert …',
  waiting: 'Wartet aufs Speichern',
} as const;

type Tab = 'overview' | 'history' | 'analysis';

type Sheet = null | { kind: 'more' } | { kind: 'form'; form: ActionForm } | { kind: 'edit'; field: DataField } | { kind: 'delete' };

export function LeadPanel() {
  const { state, dispatch } = useDemo();
  return createPortal(
    <AnimatePresence>
      {state.panelLeadId && (
        <PanelContent key={state.panelLeadId} leadId={state.panelLeadId} onClose={() => dispatch({ type: 'CLOSE_PANEL' })} />
      )}
    </AnimatePresence>,
    document.body,
  );
}

function PanelContent({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const detail = useLeadDetail(leadId);
  const { ensureDetail } = useCockpit();
  const present = useIsPresent();
  const lead = detail.lead;
  // Mit dem Finger nach rechts wegwischen – dorthin, woher das Panel kam. Die Maus markiert weiter Text.
  const x = useMotionValue(0);
  const dragControls = useDragControls();
  const [flick, setFlick] = useState(0);
  // „Bewegung reduzieren“: Transforms fallen weg – dann überblenden statt hart aufploppen.
  const fade = useReducedMotion() ?? false;
  const desktop = useMediaQuery('(min-width: 640px)');
  // Offenes Sheet im Panel: Esc schließt zuerst das Sheet, erst das nächste Esc das Panel.
  const closeSheet = useRef<(() => void) | null>(null);

  const startDrag = (event: ReactPointerEvent) => {
    if (!present || event.pointerType === 'mouse' || (event.target as HTMLElement).closest(NO_GESTURE)) return;
    dragControls.start(event);
  };

  const endDrag = (event: PointerEvent, info: PanInfo) => {
    const width = (event.target as HTMLElement | null)?.closest('aside')?.getBoundingClientRect().width ?? 400;
    if (shouldDismiss(x.get(), info.velocity.x, width)) {
      setFlick(info.velocity.x);
      onClose();
      return;
    }
    animate(x, 0, { ...SPRING_BACK, velocity: info.velocity.x });
  };

  useEffect(() => {
    if (!present) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (closeSheet.current) {
        event.stopPropagation();
        event.preventDefault();
        closeSheet.current();
        return;
      }
      // Esc in einem Eingabefeld bricht dort ab – erst das nächste Esc schließt.
      if (!isTypingTarget(event.target)) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [present, onClose]);

  return (
    <div className={cn('fixed inset-0 z-50', !present && 'pointer-events-none')}>
      <motion.div
        className="absolute inset-0 bg-black/45"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        onClick={onClose}
      />
      <motion.aside
        role="dialog"
        aria-modal={present ? 'true' : undefined}
        aria-label={lead ? `Historie von ${leadName(lead)}` : 'Lead-Historie'}
        aria-busy={detail.status === 'loading'}
        // Vollbild (Wunsch des Nutzers 15.10.): auf dem Handy von rechts hereingeschoben, am Desktop kurz eingeblendet.
        className="absolute inset-0 flex w-full touch-pan-y flex-col overflow-hidden bg-surface-1 pt-[var(--safe-top)] pb-[var(--safe-bottom)] sm:pt-0 sm:pb-0"
        style={{ x }}
        initial={fade ? { opacity: 0 } : desktop ? { opacity: 0, y: 12 } : { x: '105%' }}
        animate={fade ? { opacity: 1 } : desktop ? { opacity: 1, y: 0 } : { x: 0 }}
        exit={
          fade || desktop
            ? { opacity: 0, transition: { duration: 0.18 } }
            : { x: '105%', transition: { type: 'spring', bounce: 0, duration: 0.45, velocity: flick } }
        }
        transition={desktop ? { duration: 0.22, ease: EASE_OUT } : { type: 'spring', bounce: 0, duration: 0.45 }}
        drag="x"
        dragListener={false}
        dragControls={dragControls}
        dragDirectionLock
        // Nach links nur zäher Widerstand (Gummiband), nach rechts folgt das Panel dem Finger 1:1.
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0.06, right: 1 }}
        dragMomentum={false}
        onPointerDown={startDrag}
        onDragEnd={endDrag}
      >
        <DesktopBar onClose={onClose} />
        {lead ? (
          <PanelBody detail={detail} onClose={onClose} onRetry={() => ensureDetail(leadId, true)} closeSheet={closeSheet} />
        ) : (
          <div className="scroll-thin flex-1 overflow-y-auto">
            <div className="sm:hidden">
              <PanelHeader lead={null} onClose={onClose} />
            </div>
            {detail.status === 'error' ? (
              <PanelError onRetry={() => ensureDetail(leadId, true)} />
            ) : (
              <p role="status" className="py-16 text-center text-[14px] text-ink-3">
                Wird geladen …
              </p>
            )}
          </div>
        )}
      </motion.aside>
    </div>
  );
}

/** Desktop: schmale Leiste oben wie im Fokus-Modus („Beenden Esc“). Auf dem Handy sitzt ✕ neben dem Namen. */
function DesktopBar({ onClose }: { onClose: () => void }) {
  return (
    <div className="hidden h-14 shrink-0 items-center border-b border-white/[0.05] px-6 sm:flex">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] font-semibold text-ink-2 transition-colors hover:bg-white/[0.05] hover:text-ink"
        data-testid="panel-close"
      >
        <X className="h-4 w-4" aria-hidden />
        Schließen
        <Kbd>Esc</Kbd>
      </button>
    </div>
  );
}

function PanelHeader({ lead, onClose }: { lead: CockpitLead | null; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3 px-5 pt-4 sm:px-0 sm:pt-0">
      <div className="min-w-0 flex-1">
        {lead && (
          <>
            <h2 className="display text-[26px] font-bold leading-[1.15] tracking-[-0.02em] [overflow-wrap:anywhere] sm:text-[32px]">{leadName(lead)}</h2>
            <p className="mt-1 text-[14px] leading-[1.35] text-ink-2 [text-wrap:pretty] sm:text-[15px]">
              {leadPosition(lead)} · {leadCompany(lead)}
            </p>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Schließen"
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-surface-4 text-ink-2 transition-colors hover:bg-white/10 hover:text-ink sm:hidden"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function PanelError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="py-16 text-center">
      <p className="text-[15px] text-ink">Der Lead konnte nicht geladen werden.</p>
      <button type="button" onClick={onRetry} className="mt-3 text-[13.5px] font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline">
        Erneut versuchen
      </button>
    </div>
  );
}

const CHIP = 'inline-flex h-[30px] items-center gap-1 whitespace-nowrap rounded-full bg-surface-3 px-[11px] text-[13px]';

function LinkChip({ href, label, testId, children }: { href: string; label: string; testId?: string; children: ReactNode }) {
  return (
    <a
      href={safeHref(href)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      data-testid={testId}
      className={cn(CHIP, 'text-ink transition-colors hover:bg-surface-4')}
    >
      {children}
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

function PanelBody({
  detail,
  onClose,
  onRetry,
  closeSheet,
}: {
  detail: ReturnType<typeof useLeadDetail>;
  onClose: () => void;
  onRetry: () => void;
  closeSheet: MutableRefObject<(() => void) | null>;
}) {
  const lead = detail.lead!;
  const events = detail.events;
  const ready = detail.status === 'ready';
  // Noch offene Entscheidung zu diesem Lead (Rückgängig-Fenster, offline): erst die – sonst überholt eine Änderung
  // hier die Entscheidung und das Backend lehnt sie ab.
  const locked = events.some((event) => !!event.pending);
  const access = useAccess();
  // Mitarbeiter bearbeiten nur Leads ihrer Gründer (mit mehreren Gründern: aller).
  const readOnly = access.role === 'assistant' && !(access.user ? workingFounders(access.user) : [access.founder]).includes(lead.owner);
  // Mit Close-Anbindung legt das Backend den Lead in Close an, sonst wird die Übergabe nur eingetragen. Ist die
  // Übergabe ausgeschaltet (Einstellung „An Close übergeben“), gibt es sie hier gar nicht.
  const { mode: crmMode, handover } = useCrm();
  const viaClose = crmMode === 'mock' || crmMode === 'live';
  const canHandOver = crmMode !== null && handover;
  const runner = useLeadRun(lead);
  const [tab, setTab] = useState<Tab>('overview');
  const [sheet, setSheet] = useState<Sheet>(null);
  const primary = primaryAction(lead.stage, canHandOver);
  const busy = runner.busy;

  useEffect(() => {
    closeSheet.current = sheet ? () => setSheet(null) : null;
    return () => {
      closeSheet.current = null;
    };
  }, [sheet, closeSheet]);

  // Formular, das in dieser Stufe nicht mehr gilt (z. B. nach „Wieder öffnen“ an anderer Stelle), schließen.
  useEffect(() => {
    if (sheet?.kind === 'form' && sheet.form === 'lost' && lead.stage === 'lost') setSheet(null);
  }, [sheet, lead.stage]);

  const openSheet = (next: Sheet) => {
    runner.setError(null);
    setSheet(next);
  };

  const runInstant = (action: Parameters<typeof leadsApi.act>[1]['action']) => {
    setSheet(null);
    void runner.run(() => leadsApi.act(lead.id, { action }));
  };

  const onPrimary = () => {
    if (primary.kind === 'instant') runInstant(primary.action);
    else openSheet({ kind: 'form', form: primary.form });
  };

  // Tastatur (DESIGN.md §9): ↵ Haupt-Aktion, N Notiz, M weitere Aktionen, 1–3 bzw. V Reiter. Nicht beim Tippen, nicht
  // mit offenem Sheet (dort gehört ↵ dem Formular), nicht auf einem per Tastatur fokussierten Knopf.
  const keys = useRef({ onPrimary, openSheet, setTab, canAct: false, tab });
  keys.current = { onPrimary, openSheet, setTab, canAct: !readOnly && !locked && !busy, tab };
  useEffect(() => {
    if (sheet) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if ((event.key === 'Enter' || event.key === ' ') && isActivatableTarget(event.target)) return;
      const k = keys.current;
      const key = event.key.toLowerCase();
      const tabKey: Record<string, Tab> = { '1': 'overview', '2': 'history', '3': 'analysis' };
      if (tabKey[key]) k.setTab(tabKey[key]);
      else if (key === 'v') k.setTab(k.tab === 'history' ? 'overview' : 'history');
      else if (key === 'm') k.openSheet({ kind: 'more' });
      else if (key === 'enter' && k.canAct) k.onPrimary();
      else if (key === 'n' && k.canAct) k.openSheet({ kind: 'form', form: 'note' });
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const sheetTitle =
    sheet?.kind === 'more'
      ? 'Weitere Aktionen'
      : sheet?.kind === 'form'
        ? formTitle(sheet.form, viaClose)
        : sheet?.kind === 'edit'
          ? FIELD_LABELS[sheet.field]
          : sheet?.kind === 'delete'
            ? `${leadName(lead)} endgültig löschen?`
            : '';

  const tabs: { value: Tab; label: string; title: string }[] = [
    { value: 'overview', label: 'Übersicht', title: 'Übersicht' },
    { value: 'history', label: ready ? `Verlauf · ${events.length}` : 'Verlauf', title: 'Verlauf' },
    { value: 'analysis', label: 'Analyse', title: 'Analyse' },
  ];

  return (
    <>
      <div className="scroll-thin relative flex-1 touch-pan-y overflow-y-auto">
        {/* Desktop: Inhalt mittig (max. 1120 px), Kopf links, Statuskarte rechts daneben. */}
        <div className="mx-auto w-full max-w-[1120px] sm:px-8">
          <div className="pb-3.5 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,380px)] sm:items-start sm:gap-x-10 sm:pt-8 sm:pb-6">
            <div className="min-w-0">
              <PanelHeader lead={lead} onClose={onClose} />
              <div className="px-5 sm:px-0">
                <PanelChips lead={lead} events={ready ? events : undefined} />
              </div>
            </div>
            <div className="px-5 sm:px-0">
              <StatusCard lead={lead} events={ready ? events : null} locked={locked} readOnly={readOnly} />
              {lead.score && <FailedFilters score={lead.score} />}
            </div>
          </div>

          <div className="sticky top-0 z-10 bg-surface-1 px-5 pt-1.5 pb-2.5 sm:px-0 sm:pt-2 sm:pb-4">
            <PanelTabs tabs={tabs} value={tab} onChange={setTab} />
          </div>

          <TabPanel id="overview" active={tab === 'overview'}>
            <Overview lead={lead} readOnly={readOnly} disabled={locked || busy} runner={runner} onEdit={(field) => openSheet({ kind: 'edit', field })} />
          </TabPanel>
          <TabPanel id="history" active={tab === 'history'}>
            <div className="sm:max-w-[720px]">
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => openSheet({ kind: 'form', form: 'note' })}
                  disabled={locked}
                  className="mb-[18px] h-11 w-full rounded-xl border border-dashed border-white/15 text-[14px] text-ink-2 transition-colors hover:border-white/25 hover:text-ink disabled:opacity-40"
                  data-testid="history-add-note"
                >
                  + Notiz hinzufügen
                </button>
              )}
              {ready ? (
                <Timeline events={events} />
              ) : detail.status === 'error' ? (
                <p className="text-[13.5px] text-ink-2">
                  Verlauf konnte nicht geladen werden.{' '}
                  <button type="button" onClick={onRetry} className="font-medium text-ink underline-offset-4 hover:underline">
                    Erneut versuchen
                  </button>
                </p>
              ) : (
                <p role="status" className="text-[13.5px] text-ink-3">
                  Verlauf wird geladen …
                </p>
              )}
            </div>
          </TabPanel>
          <TabPanel id="analysis" active={tab === 'analysis'}>
            <Analysis lead={lead} readOnly={readOnly} locked={locked} />
          </TabPanel>
        </div>
      </div>

      {runner.error && !sheet && (
        <p role="alert" className="mx-auto flex w-full max-w-[1120px] shrink-0 items-baseline gap-2 border-t border-white/[0.05] px-5 pt-2.5 text-[13px] text-ink sm:border-t-0 sm:px-8">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {runner.error}
        </p>
      )}
      {readOnly ? (
        // Mitarbeiter buchen nur auf Leads ihres Gründers (`shared/auth.ts` → Rollen und Rechte).
        <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.05] px-5 py-3 sm:justify-center">
          <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-ink-3" data-testid="lead-read-only">
            Dieser Lead gehört {FOUNDERS[lead.owner].name} – du kannst ihn nur ansehen.
          </p>
        </div>
      ) : (
        <LeadFooter
          primary={primary}
          disabled={locked || busy}
          busy={busy}
          onPrimary={onPrimary}
          onNote={() => openSheet({ kind: 'form', form: 'note' })}
          onMore={() => openSheet({ kind: 'more' })}
        />
      )}

      <PanelSheet open={sheet !== null} title={sheetTitle} onClose={() => setSheet(null)} testId="panel-sheet">
        {sheet?.kind === 'more' && (
          <MoreSheetContent
            lead={lead}
            primary={primary}
            canHandOver={canHandOver}
            readOnly={readOnly}
            disabled={locked || busy}
            onForm={(form) => openSheet({ kind: 'form', form })}
            onInstant={runInstant}
            onOwner={(owner) => {
              setSheet(null);
              void runner.run(() => leadsApi.update(lead.id, { owner }));
            }}
            onResetInvite={() => {
              if (!window.confirm(`${leadName(lead)} zurück auf „Anfrage gesendet“? Nimmt die Person wirklich an, trägt der LinkedIn-Abgleich das wieder ein.`)) return;
              setSheet(null);
              void runner.run(() => leadsApi.update(lead.id, { stage: 'invited' }));
            }}
            onDelete={() => openSheet({ kind: 'delete' })}
          />
        )}
        {sheet?.kind === 'form' && (
          <ActionFormSheet
            key={sheet.form}
            form={sheet.form}
            lead={lead}
            runner={runner}
            viaClose={viaClose}
            locked={locked}
            onDone={() => {
              // Neue Notiz: gleich im Verlauf zeigen.
              if (sheet.form === 'note') setTab('history');
              setSheet(null);
            }}
          />
        )}
        {sheet?.kind === 'edit' && <FieldEditor key={sheet.field} field={sheet.field} lead={lead} runner={runner} onDone={() => setSheet(null)} />}
        {sheet?.kind === 'delete' && <DeleteSheetContent lead={lead} onCancel={() => setSheet(null)} />}
      </PanelSheet>
    </>
  );
}

/** Kurzfakten als Chips: Score, Lead-Typ, Hiring, Kontaktgrad und die Wege nach LinkedIn, Meta und Close. */
function PanelChips({ lead, events }: { lead: CockpitLead; events: TimelineEntry[] | undefined }) {
  const profile = linkedinProfileUrl(lead);
  // Meta-Werbebibliothek mit einem Klick (15.10.): Seite des Werbetreibenden bzw. Suche nach der Firma.
  const metaUrl = metaLibraryUrl(lead);
  const distance = lead.person.networkDistance;
  // Leads aus der Tracking-Liste: Signal steht im Verlauf („Signal: …“) – Such-Leads zeigen Meta und Hiring einzeln.
  const signal = lead.origin.kind !== 'search' && !lead.metaAds && !lead.hiring ? leadSignal(lead, events) : null;
  const leadType = lead.score && lead.score.leadType !== 'unclear' ? LEAD_TYPE_LABELS[lead.score.leadType] : null;

  return (
    <div className="mt-3.5 flex flex-wrap gap-2" data-testid="panel-meta">
      {lead.score && <ScoreChip score={lead.score} />}
      {leadType && <span className={cn(CHIP, 'text-ink/80')}>{leadType}</span>}
      {lead.hiring && <span className={cn(CHIP, 'max-w-full truncate text-ink/80')}>Sucht: {lead.hiring.role ?? 'Mitarbeiter'}</span>}
      {signal && <span className={cn(CHIP, 'max-w-full truncate text-ink/80')}>{signal.label}</span>}
      {lead.origin.kind === 'contact' && (
        <span className={cn(CHIP, 'text-ink/80')} data-testid="contact-chip">
          Persönlicher Kontakt
        </span>
      )}
      {(distance === 2 || distance === 3) && <span className={cn(CHIP, 'text-ink/80')}>{distance}. Grad</span>}
      {profile && (
        <LinkChip href={profile} label="LinkedIn-Profil öffnen">
          LinkedIn
        </LinkChip>
      )}
      {metaUrl && (
        <LinkChip
          href={metaUrl}
          label={metaLibraryIsPage(metaUrl) ? 'Seite in der Meta-Werbebibliothek öffnen' : 'In der Meta-Werbebibliothek nach der Firma suchen'}
          testId="meta-library-link"
        >
          {metaLibraryIsPage(metaUrl) ? 'Werbebibliothek' : 'Werbebibliothek · Suche'}
        </LinkChip>
      )}
      {lead.crm &&
        (lead.crm.url ? (
          <LinkChip href={lead.crm.url} label="In Close öffnen" testId="crm-link">
            Close
          </LinkChip>
        ) : (
          <span data-testid="crm-link" className={cn(CHIP, 'text-ink/80')}>
            Close · {lead.crm.externalId}
          </span>
        ))}
    </div>
  );
}

/** Wo der Lead steht: Stufe, Schritt x von 7, Fortschritt und was als Nächstes zu tun ist. */
function StatusCard({ lead, events, locked, readOnly }: { lead: CockpitLead; events: TimelineEntry[] | null; locked: boolean; readOnly: boolean }) {
  const view = stageView(lead, events);
  const lost = view.step === null;
  return (
    <section className="mt-4 rounded-2xl bg-surface-3 p-3.5" data-testid="status-card" aria-label="Stand">
      <div className="flex items-baseline justify-between gap-2">
        <p className={cn('text-[15px] font-semibold', lost ? 'text-bad' : 'text-ink')} data-testid="status-stage">
          {view.label}
        </p>
        {!lost && (
          <p className="text-[12px] tabular-nums text-ink-2">
            Schritt {view.step! + 1} von {STAGE_STEPS.length}
          </p>
        )}
      </div>
      <div className="mt-2.5 flex gap-1" aria-hidden>
        {STAGE_STEPS.map((step, index) => (
          <span
            key={step}
            className={cn(
              'h-1 flex-1 rounded-full',
              lost ? 'bg-bad/25' : index === view.step ? 'bg-ink' : index < view.step! ? 'bg-ink-2' : 'bg-white/[0.09]',
            )}
          />
        ))}
      </div>
      <p className="mt-2.5 text-[13px] leading-[1.4] text-ink-2">{view.hint}</p>
      {!readOnly && <SnoozedLine lead={lead} disabled={locked} />}
      {locked && (
        <p role="status" className="mt-2 text-[12.5px] text-ink-3" data-testid="actions-locked">
          Wartet, bis die letzte Entscheidung gespeichert ist.
        </p>
      )}
    </section>
  );
}

function PanelTabs({ tabs, value, onChange }: { tabs: { value: Tab; label: string; title: string }[]; value: Tab; onChange: (tab: Tab) => void }) {
  return (
    <div role="tablist" aria-label="Lead-Ansicht" className="flex rounded-[11px] bg-surface-3 p-[3px] sm:max-w-[420px]">
      {tabs.map((tab, index) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`lead-tab-${tab.value}`}
            aria-selected={active}
            aria-controls={`lead-tabpanel-${tab.value}`}
            onClick={() => onChange(tab.value)}
            title={`${tab.title} (${index + 1})`}
            data-testid={`lead-tab-${tab.value}`}
            className={cn(
              'relative h-8 min-w-0 flex-1 rounded-[8px] text-[14px] font-semibold transition-colors',
              active ? 'text-ink' : 'text-ink-2 hover:text-ink',
            )}
          >
            {active && (
              <motion.span
                layoutId="lead-tab"
                className="absolute inset-0 rounded-[8px] bg-white/[0.14]"
                transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
              />
            )}
            <span className="relative tabular-nums">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Alle Reiter bleiben eingehängt – Firmendaten fragen im Hintergrund weiter nach und behalten ihren Stand. */
function TabPanel({ id, active, children }: { id: Tab; active: boolean; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={`lead-tabpanel-${id}`}
      aria-labelledby={`lead-tab-${id}`}
      hidden={!active}
      data-testid={`lead-tabpanel-${id}`}
      className="px-5 pt-1.5 pb-7 sm:px-0 sm:pb-12"
    >
      {children}
    </div>
  );
}

function Overview({
  lead,
  readOnly,
  disabled,
  runner,
  onEdit,
}: {
  lead: CockpitLead;
  readOnly: boolean;
  disabled: boolean;
  runner: ReturnType<typeof useLeadRun>;
  onEdit: (field: DataField) => void;
}) {
  const reply = lead.conversation ? replyAssessmentParts(lead.conversation) : null;
  return (
    // Desktop: links „Warum“ (und Gespräch), rechts Daten und Lead-Qualität.
    <div className="flex flex-col gap-[22px] lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
      <div className="flex flex-col gap-[22px]">
        {reply && lead.conversation && (
          <section data-testid="panel-conversation">
            <Eyebrow>Gespräch</Eyebrow>
            <div className="rounded-2xl bg-surface-3 p-3.5">
              <p className="text-[15px] font-semibold leading-[1.4] text-ink">
                {reply.label}
                {reply.detail && <span className="font-normal text-ink/80"> · {reply.detail}</span>}
              </p>
              {lead.conversation.summary && <p className="mt-1.5 text-[14px] leading-[1.5] text-ink/70">{lead.conversation.summary}</p>}
            </div>
          </section>
        )}

        <WhyThisLead lead={lead} />
      </div>

      <div className="flex flex-col gap-[22px]">
        <DataRows
          lead={lead}
          disabled={disabled}
          readOnly={readOnly}
          onEdit={onEdit}
          onBoardColumn={(boardColumn) => void runner.run(() => leadsApi.update(lead.id, { boardColumn }))}
        />

        {!readOnly && <QualityFeedback lead={lead} disabled={disabled} onSave={(feedback) => void runner.run(() => leadsApi.update(lead.id, { feedback }))} />}
      </div>
    </div>
  );
}

/** Lange KI-Begründungen: drei Zeilen, dann „Mehr lesen“. */
const SUMMARY_CLAMP_CHARS = 200;

/** KI-Einschätzung und Hard-Filter in einer Karte – warum dieser Lead im Stapel ist. */
function WhyThisLead({ lead }: { lead: CockpitLead }) {
  const [open, setOpen] = useState(false);
  const fit = leadFit(lead);
  const confidence = confidencePercent(lead);
  const summary = lead.assessment?.summary ?? null;
  const long = !!summary && summary.length > SUMMARY_CLAMP_CHARS;
  const checks = lead.score?.hardFilters ?? [];
  if (!fit && checks.length === 0) return null;

  return (
    <section data-testid="panel-why">
      <Eyebrow>Warum dieser Lead</Eyebrow>
      <div className="rounded-2xl bg-surface-3 p-3.5">
        {fit ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[15px] font-semibold text-ink">{fit.label.replace(/ \((.*)\)$/, ' · $1')}</p>
              {confidence && <p className="shrink-0 text-[13px] tabular-nums text-ink-2">{confidence}</p>}
            </div>
            {summary && (
              <p className={cn('mt-1.5 text-[14px] leading-[1.5] text-ink/70', long && !open && 'line-clamp-3')} data-testid="panel-ai-summary">
                {summary}
              </p>
            )}
            {long && (
              <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="mt-1.5 text-[13px] font-semibold text-ink hover:underline">
                {open ? 'Weniger' : 'Mehr lesen'}
              </button>
            )}
          </>
        ) : (
          <p className="text-[14px] text-ink-2">Noch nicht von der KI bewertet.</p>
        )}
        {checks.length > 0 && (
          <div className="mt-3 border-t border-white/[0.06] pt-3">
            <HardFilterChips checks={checks} />
          </div>
        )}
      </div>
    </section>
  );
}

function Analysis({ lead, readOnly, locked }: { lead: CockpitLead; readOnly: boolean; locked: boolean }) {
  const region = leadRegion(lead);
  const facts: [string, string][] = [];
  if (lead.company.industry) facts.push(['Branche', lead.company.industry]);
  if (region) facts.push(['Region', region]);
  if (!lead.assessment) facts.push(['KI', 'Nicht bewertet']);

  return (
    // Desktop: links der Score, rechts Hard-Filter, Firma und Firmendaten.
    <div className="flex flex-col gap-[22px] lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
      {lead.score ? (
        <ScoreAnalysis score={lead.score} libraryUrl={metaLibraryUrl(lead)} />
      ) : (
        <p className="rounded-2xl bg-surface-3 p-3.5 text-[14px] text-ink-2">Noch kein Score – der Lead ist nicht über die Lead-Suche bewertet.</p>
      )}
      <div className="flex flex-col gap-[22px]">
        {lead.score && lead.score.hardFilters.length > 0 && <HardFilterList checks={lead.score.hardFilters} />}
        {facts.length > 0 && (
          <section>
            <Eyebrow>Firma</Eyebrow>
            <dl className="overflow-hidden rounded-2xl bg-surface-3">
              {facts.map(([label, value]) => (
                <div key={label} className="flex gap-2.5 border-b border-white/[0.05] px-3.5 py-3 text-[14px] last:border-b-0">
                  <dt className="w-[126px] shrink-0 text-ink-2">{label}</dt>
                  <dd className="min-w-0 break-words text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        {!readOnly && <CompanyData lead={lead} disabled={locked} />}
      </div>
    </div>
  );
}

/** „Heute, 22:00“ mitten im Satz: „heute, 22:00“. */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Übersprungen („Nicht senden“, „Für heute überspringen“): fehlt im Tagesstapel bis `snoozedUntil`. Wunsch des Nutzers
 * 15.10.: weggeklickte Erstnachrichten wiederholen können, ohne bis morgen zu warten.
 */
function SnoozedLine({ lead, disabled }: { lead: CockpitLead; disabled: boolean }) {
  const { mutateLead } = useCockpit();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!lead.snoozedUntil || lead.snoozedUntil <= Date.now()) return null;
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await mutateLead(() => leadsApi.unsnooze(lead.id), lead.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? readableError(caught, 'Das Backend hat es nicht angenommen.') : 'Backend nicht erreichbar.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-white/[0.06] pt-2.5 text-[13px] text-ink-2" data-testid="panel-snoozed">
      <span className="inline-flex items-baseline gap-1.5">
        <Dot tone="warn" />
        Übersprungen bis {lowerFirst(formatDateTime(lead.snoozedUntil))}
      </span>
      <button
        type="button"
        onClick={() => void restore()}
        disabled={busy || disabled}
        className="font-semibold text-ink underline-offset-4 hover:underline disabled:opacity-40"
        data-testid="panel-unsnooze"
      >
        {busy ? 'Wird zurückgeholt …' : 'Zurück in den Tagesstapel'}
      </button>
      {error && <span className="w-full text-bad">{error}</span>}
    </p>
  );
}

/** Verlauf, neuester Eintrag oben: farbige Art, Titel, Zeit, Text. */
function Timeline({ events }: { events: TimelineEntry[] }) {
  const ordered = [...events].reverse();
  return (
    <ol className="relative" data-testid="timeline">
      {ordered.map((event, index) => {
        const isMessage = event.kind === 'message_sent' || event.kind === 'message_received';
        const last = index === ordered.length - 1;
        const group = EVENT_GROUPS[event.kind] ?? 'Notiz';
        const color = event.pending === 'waiting' ? 'var(--color-warn)' : event.pending ? 'var(--color-ink-3)' : GROUP_COLORS[group];
        return (
          <motion.li
            key={event.id}
            // Ohne Staffelung: Das Panel öffnest du oft und willst den Verlauf sofort lesen. Neue Einträge blenden kurz ein.
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15, ease: EASE_OUT }}
            className="flex gap-3"
          >
            <div className="flex w-3 shrink-0 flex-col items-center" aria-hidden>
              <span
                className={cn('mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full', event.pending && 'border border-dashed bg-transparent')}
                style={event.pending ? { borderColor: color } : { backgroundColor: color }}
              />
              {!last && <span className="my-1 w-px flex-1 bg-white/10" />}
            </div>
            <div className="min-w-0 flex-1 pb-[18px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color }}>
                {group}
              </p>
              <p className="mt-0.5 text-[15px] font-semibold leading-[1.35] text-ink [text-wrap:pretty]">{event.title}</p>
              <time className="mt-0.5 block text-[13px] tabular-nums text-ink-2">{formatDateTime(event.at)}</time>
              {/* `actor` setzt das Backend nur, wenn nicht der Gründer selbst gebucht hat (`shared/leads.ts`). */}
              {event.actor && (
                <p className="text-[12.5px] text-ink-3" data-testid="event-actor">
                  von {event.actor}
                  {event.by ? ` für ${FOUNDERS[event.by].name}` : ''}
                </p>
              )}
              {event.pending && (
                <span className="mt-0.5 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-2">
                  <span className={cn('h-1.5 w-1.5 rounded-full', event.pending === 'waiting' ? 'bg-warn' : 'bg-ink-3')} aria-hidden />
                  {PENDING_LABELS[event.pending]}
                </span>
              )}
              {event.text &&
                (isMessage ? (
                  <p className="mt-2 whitespace-pre-wrap rounded-xl bg-surface-3 px-3 py-2.5 text-[13.5px] leading-[1.5] text-ink/80 [overflow-wrap:anywhere]">
                    {event.text}
                  </p>
                ) : (
                  <p className="mt-1 text-[13px] leading-[1.45] text-ink/70 [overflow-wrap:anywhere]">{event.text}</p>
                ))}
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}
