import {
  AnimatePresence,
  animate,
  motion,
  useDragControls,
  useIsPresent,
  useMotionValue,
  useTransform,
  type PanInfo,
  type Variants,
} from 'motion/react';
import { CalendarClock, Check, Clock, ListFilter, X } from 'lucide-react';
import { Component, useEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useHotkeys } from '../../lib/useHotkeys';
import { useCockpit } from '../../state/cockpit';
import { founderCards, pendingCards, useDemo, type PageMotion } from '../../state/demo';
import type { CardState, CardType, FounderId, StackFilter } from '../../state/types';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { useActivity } from './ActivityToasts';
import { SKIP_TOAST, messageAccount, useActionMode } from './actionMode';
import { LinkedInBlockLine } from './LinkedInStatus';
import { FirstMessageCard } from './FirstMessageCard';
import { FollowUpCard } from './FollowUpCard';
import { LeadCard } from './LeadCard';
import { ReplyCard } from './ReplyCard';
import type { CardProps, DecideArgs } from './cardTypes';
import { NO_GESTURE, SPRING_BACK, project } from '../../lib/gesture';
import { SwipeContext, type SwipeActions } from './swipe';
import { SuccessScreen } from './SuccessScreen';
import { TYPE_LABELS, TYPE_ORDER } from './summary';
import { EASE_OUT, SPRING_MENU, SPRING_PAGE } from '../../lib/motion';

const CARD_COMPONENTS: Record<CardType, ComponentType<CardProps>> = {
  reply: ReplyCard,
  followup: FollowUpCard,
  first: FirstMessageCard,
  lead: LeadCard,
};

interface PageTransition extends PageMotion {
  /** Entscheidung kam per Wischgeste – die Seite fliegt dann mit dem Schwung hinaus. */
  swiped: boolean;
  /** Geschwindigkeit des Fingers beim Loslassen (px/s) – die Feder übernimmt sie nahtlos. */
  velocity: number;
}

const sign = (positive: boolean) => (positive ? 1 : -1);

/**
 * Räumlich konsistent: Entscheidungen verlassen den Bildschirm zur jeweiligen Seite, die nächste Aufgabe
 * kommt von unten aus dem Stapel. „Rückgängig“ holt die Aufgabe von der Seite zurück, zu der sie gegangen ist,
 * und die aktuelle Aufgabe sinkt zurück in den Stapel. Alles mit kritisch gedämpften Federn (keine Überschwinger).
 */
const pageVariants: Variants = {
  enter: (t: PageTransition) =>
    t.kind === 'undo' ? { opacity: 0, x: sign(t.positive) * 360, y: 0, scale: 1 } : { opacity: 0, x: 0, y: 32, scale: 0.98 },
  center: {
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
    zIndex: 1,
    transition: SPRING_PAGE,
  },
  exit: (t: PageTransition) =>
    t.kind === 'decide'
      ? {
          // Per Wischen: weit hinaus, die Feder übernimmt die Geschwindigkeit des Fingers.
          // Per Tastatur/Klick: kurzer, ruhiger Weg.
          x: sign(t.positive) * (t.swiped ? window.innerWidth : 160),
          opacity: 0,
          zIndex: 2,
          pointerEvents: 'none',
          transition: {
            x: t.swiped ? { type: 'spring', bounce: 0, duration: 0.6, velocity: t.velocity } : { type: 'spring', bounce: 0, duration: 0.45 },
            opacity: { duration: t.swiped ? 0.3 : 0.26, ease: EASE_OUT },
          },
        }
      : { opacity: 0, y: 24, scale: 0.97, zIndex: 0, pointerEvents: 'none', transition: { duration: 0.22, ease: EASE_OUT } },
};

/** Ab dieser hochgerechneten Endposition (px) gilt eine Wischgeste als Entscheidung. */
const SWIPE_COMMIT = 160;
/** Mindestweg, damit ein reines Zucken keine Entscheidung auslöst. */
const SWIPE_MIN_TRAVEL = 40;

function haptic() {
  if (window.matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(8);
}

interface SwipeablePageProps {
  card: CardState;
  transition: PageTransition;
  onSwipeCommit: (velocity: number) => void;
  onSwipeCancel: () => void;
  children: ReactNode;
}

/** Eine Aufgabe als Karte, die sich mit Finger/Trackpad 1:1 zur Seite ziehen lässt. */
function SwipeablePage({ card, transition, onSwipeCommit, onSwipeCancel, children }: SwipeablePageProps) {
  const x = useMotionValue(0);
  // Leichte Neigung in Zugrichtung – deutet an, wohin die Karte geht.
  const rotate = useTransform(x, [-600, 0, 600], [-5, 0, 5]);
  const actionsRef = useRef<SwipeActions | null>(null);
  const dragControls = useDragControls();
  const present = useIsPresent();

  const startDrag = (event: ReactPointerEvent) => {
    if (!present || event.button !== 0) return;
    if ((event.target as HTMLElement).closest(NO_GESTURE)) return;
    event.preventDefault(); // kein versehentliches Markieren von Text während der Geste
    dragControls.start(event);
  };

  const endDrag = (_event: PointerEvent, info: PanInfo) => {
    const offset = x.get();
    const projected = offset + project(info.velocity.x);
    const action = projected > 0 ? actionsRef.current?.right : actionsRef.current?.left;
    if (Math.abs(projected) > SWIPE_COMMIT && Math.abs(offset) > SWIPE_MIN_TRAVEL && action && action.enabled !== false) {
      onSwipeCommit(info.velocity.x);
      if (action.run() !== false) {
        haptic();
        return;
      }
      onSwipeCancel();
    }
    // Nicht weit genug: zurückfedern – mit leichtem Nachschwingen, weil die Geste Schwung hatte.
    animate(x, 0, { ...SPRING_BACK, velocity: info.velocity.x });
  };

  return (
    <SwipeContext.Provider value={{ x, actionsRef }}>
      <motion.div
        custom={transition}
        variants={pageVariants}
        initial="enter"
        animate="center"
        exit="exit"
        style={{ x, rotate }}
        drag="x"
        dragListener={false}
        dragControls={dragControls}
        dragMomentum={false}
        dragDirectionLock
        onPointerDown={startDrag}
        onDragEnd={endDrag}
        className="relative touch-pan-y bg-canvas [grid-area:1/1]"
        data-testid="stack-card"
        data-card-type={card.type}
        data-card-id={card.id}
      >
        {children}
      </motion.div>
    </SwipeContext.Provider>
  );
}

/** Fokus-Modus: genau eine Aufgabe füllt den Bildschirm. */
export function FocusView() {
  const { state, dispatch } = useDemo();
  const { decide, ensureDetail } = useCockpit();
  const founder = state.founder as FounderId;
  const { busy } = useActivity();
  // Geschwindigkeit der Wischgeste, die gerade entscheidet (null = Entscheidung per Klick/Taste).
  const pendingSwipe = useRef<number | null>(null);
  const [lastSwipe, setLastSwipe] = useState<number | null>(null);

  const all = founderCards(state, founder);
  const pendingAll = all.filter((card) => card.status === 'pending');
  const visible = pendingCards(state, founder, state.filter);
  const current = visible[0];
  // Ob echt gesendet wird, entscheidet der Account, über den der Server sendet: Anfragen über den des Besitzers,
  // Nachrichten über den, über den die Anfrage ging (`sentBy`, 25.10.) – sonst zeigte die Karte „Senden“, wo der Server
  // ablehnt, oder „eintragen“, wo er senden könnte.
  const currentLead = current ? state.stack.tasks[current.id]?.lead : undefined;
  const mode = useActionMode(current && currentLead && current.type !== 'lead' ? messageAccount(currentLead) : current?.owner);
  const doneCount = all.length - pendingAll.length;
  const remaining = remainingTime(all, pendingAll.length);
  const ready = state.stack.status === 'ready';
  const waiting = Object.values(state.stack.outcomes).filter((outcome) => outcome.commit === 'waiting').length;
  // Zwischenbilanz beim Beenden (Peak-End, Wunsch des Nutzers 25.10.): Wer mittendrin aufhört, geht mit einem positiven
  // Satz statt stumm – kein Dialog, nur ein Hinweis. Gezählt wird, was seit dem Öffnen des Fokus-Modus entschieden wurde.
  const openedAt = useRef(Date.now());
  const exit = () => {
    const session = all.filter((card) => card.status === 'done' && (card.decidedAt ?? 0) >= openedAt.current);
    if (session.length > 0 && pendingAll.length > 0) {
      const minutes = Math.max(1, Math.round((Date.now() - openedAt.current) / 60_000));
      dispatch({
        type: 'NOTIFY',
        tone: 'good',
        title: 'Gute Runde',
        detail: `${session.length} ${session.length === 1 ? 'Aufgabe' : 'Aufgaben'} in ${minutes} Min. erledigt · noch ${pendingAll.length} offen.`,
      });
    }
    dispatch({ type: 'SET_VIEW', view: 'home' });
  };
  // „Jetzt nicht“: Karte ans Ende des Stapels, ohne zu entscheiden – nur sinnvoll, wenn danach etwas anderes kommt.
  const canDefer = ready && !!current && pendingAll.length > 1;
  const defer = () => {
    if (!current || !canDefer) return;
    setLastSwipe(null);
    dispatch({ type: 'DEFER', taskId: current.id });
    const person = state.stack.tasks[current.id]?.lead.person;
    dispatch({
      type: 'NOTIFY',
      tone: 'neutral',
      title: 'Kommt später wieder',
      detail: person ? `${person.firstName} ${person.lastName} steht jetzt am Ende des Stapels.` : 'Die Aufgabe steht jetzt am Ende des Stapels.',
      taskId: current.id,
    });
  };

  // „Später“ (Wiedervorlage, 22.10.): bis zum Tag pausiert, dann wieder in den Aufgaben.
  const [laterOpen, setLaterOpen] = useState(false);
  const canLater = ready && !!current;
  const later = (resumeAt: number) => {
    setLaterOpen(false);
    if (!current) return;
    const day = new Date(resumeAt).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
    handleDecide(current, {
      decision: 'skip',
      positive: false,
      action: null,
      resumeAt,
      toast: { pending: `Pausiert bis ${day}`, done: `Kommt am ${day} wieder`, short: { pending: 'Pausiert', done: `Ab ${day}` } },
    });
  };

  useHotkeys({ escape: exit, j: defer, w: () => canLater && setLaterOpen((open) => !open) }, !state.panelLeadId && !laterOpen);

  // Verlauf der aktuellen und der nächsten zwei Aufgaben vorab laden – dann gibt es beim Weiterblättern kein Warten.
  const upcoming = visible
    .slice(0, 3)
    .map((card) => card.leadId)
    .join(',');
  useEffect(() => {
    for (const leadId of upcoming.split(',').filter(Boolean)) ensureDetail(leadId);
  }, [upcoming, ensureDetail]);

  // Der Höhepunkt eines Gesprächs – Termin oder Übergabe – bekommt einen eigenen kurzen Moment (Peak-End, 25.10.).
  const [win, setWin] = useState<Win | null>(null);
  const handleDecide = (card: CardState, args: DecideArgs) => {
    setLastSwipe(pendingSwipe.current);
    pendingSwipe.current = null;
    decide(card, { ...args, viaLinkedIn: mode === 'send' });
    if (args.decision === 'meeting' || args.decision === 'export') {
      const person = state.stack.tasks[card.id]?.lead.person;
      const today = all.filter((entry) => entry.status === 'done' && (entry.decision === 'meeting' || entry.decision === 'export')).length + 1;
      setWin({ id: Date.now(), kind: args.decision, name: person?.firstName ?? '', today });
    }
  };

  const CardComponent = current ? CARD_COMPONENTS[current.type] : null;
  const transition: PageTransition = { ...state.pageMotion, swiped: lastSwipe !== null, velocity: lastSwipe ?? 0 };
  const stale = current ? state.stack.stale.includes(current.id) : false;

  return (
    <div className="min-h-dvh">
      <WinMoment win={win} onDone={() => setWin(null)} />
      <header className="sticky top-[var(--safe-top)] z-30 bg-canvas/80 backdrop-blur-xl reduced-transparency:bg-canvas reduced-transparency:backdrop-blur-none">
        <div className="mx-auto grid h-16 max-w-[1240px] grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:h-[72px] sm:px-10">
          <div>
            <Button variant="ghost" size="sm" onClick={exit} icon={<X className="h-4 w-4" />} shortcut="Esc">
              Beenden
            </Button>
          </div>
          {waiting > 0 ? (
            <WaitingStatus count={waiting} />
          ) : (
            // Fortschritt zum Anfassen (Goal-Gradient, Wunsch des Nutzers 25.10.): Zahl, Balken, Restzeit aus dem eigenen Tempo.
            <div className={cn('flex flex-col items-center gap-1.5 transition-opacity duration-200', (busy || !ready) && 'opacity-0')}>
              <p className="whitespace-nowrap text-[13px] font-semibold tabular-nums text-ink" data-testid="progress">
                {doneCount} von {all.length} erledigt
              </p>
              <div className="h-1 w-28 overflow-hidden rounded-full bg-surface-4 sm:w-40" aria-hidden>
                <motion.div
                  className="h-full origin-left rounded-full bg-ink"
                  initial={false}
                  animate={{ scaleX: all.length ? doneCount / all.length : 0 }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.6 }}
                />
              </div>
              {remaining !== null && (
                <p className="-mt-0.5 whitespace-nowrap text-[11.5px] tabular-nums text-ink-3 max-sm:hidden" data-testid="progress-remaining">
                  {remaining}
                </p>
              )}
            </div>
          )}
          <div className="flex items-center justify-end gap-1">
            {canDefer && (
              <Button
                variant="ghost"
                size="sm"
                onClick={defer}
                icon={<Clock className="h-4 w-4" />}
                shortcut="J"
                title="Ans Ende des Stapels – erst andere Aufgaben erledigen"
                aria-label="Jetzt nicht"
                className="max-sm:px-2"
                data-testid="defer"
              >
                {/* Mobil nur das Symbol – sonst passt der Filter nicht mehr in die Kopfzeile. */}
                <span className="hidden sm:inline">Jetzt nicht</span>
              </Button>
            )}
            {canLater && <LaterMenu open={laterOpen} onOpenChange={setLaterOpen} onPick={later} />}
            {pendingAll.length > 0 && <FilterMenu pending={pendingAll} />}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)]">
        <AnimatePresence custom={transition} initial={false}>
          {!ready ? (
            <motion.div key="status" className="[grid-area:1/1]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <StackStatusPage />
            </motion.div>
          ) : current && CardComponent ? (
            <SwipeablePage
              key={current.id}
              card={current}
              transition={transition}
              onSwipeCommit={(velocity) => (pendingSwipe.current = velocity)}
              onSwipeCancel={() => (pendingSwipe.current = null)}
            >
              <CardBoundary card={current} onSkip={(args) => handleDecide(current, args)}>
                {stale ? (
                  <StaleCard card={current} />
                ) : (
                  <>
                    <FailureLine taskId={current.id} />
                    <LinkedInBlockLine type={current.type} owner={current.type !== 'lead' && currentLead ? messageAccount(currentLead) : current.owner} />
                    <CardComponent
                      card={current}
                      onDecide={(args) => handleDecide(current, args)}
                      onOpenLead={(leadId) => dispatch({ type: 'OPEN_PANEL', leadId })}
                      hotkeysEnabled={!state.panelLeadId && !laterOpen}
                    />
                  </>
                )}
              </CardBoundary>
            </SwipeablePage>
          ) : (
            <motion.div
              key={all.length === 0 ? 'empty' : pendingAll.length === 0 ? 'done' : `empty-${state.filter}`}
              className="[grid-area:1/1]"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0, transition: { type: 'spring', bounce: 0, duration: 0.55, delay: 0.15 } }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
            >
              {all.length === 0 ? (
                <EmptyPage />
              ) : pendingAll.length === 0 ? (
                <DonePage cards={all} />
              ) : (
                <FilterDonePage remaining={pendingAll.length} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

type Win = { id: number; kind: 'meeting' | 'export'; name: string; today: number };

/**
 * Kurzer Erfolgsmoment nach Termin oder Übergabe: grüner Haken, ein Satz, nach 1,6 s weg. Blockiert nichts – die
 * nächste Aufgabe ist darunter sofort bedienbar (DESIGN.md §8). Bei „Bewegung reduzieren“ nur Ein- und Ausblenden.
 */
function WinMoment({ win, onDone }: { win: Win | null; onDone: () => void }) {
  // Der Timer hängt nur am Moment selbst – ein neues `onDone` bei jedem Rendern darf ihn nicht neu starten.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!win) return;
    const timer = window.setTimeout(() => done.current(), 1600);
    return () => window.clearTimeout(timer);
  }, [win]);
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-6" aria-live="polite">
      <AnimatePresence>
        {win && (
          <motion.div
            key={win.id}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.25 } }}
            transition={{ type: 'spring', bounce: 0, duration: 0.45 }}
            className="flex flex-col items-center rounded-[28px] bg-surface-2/95 px-10 py-8 text-center shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)] backdrop-blur-xl"
            data-testid="win-moment"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-good shadow-[0_0_60px_rgb(48_209_88/0.35)]">
              <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="#000" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35, delay: 0.15, ease: EASE_OUT }} />
              </svg>
            </span>
            <p className="display mt-5 text-[26px] font-semibold leading-tight">
              {win.kind === 'meeting' ? `Termin${win.name ? ` mit ${win.name}` : ''} steht.` : `${win.name || 'Lead'} ist übergeben.`}
            </p>
            <p className="mt-1.5 text-[15px] text-ink-2">
              {win.today > 1 ? `Schon ${win.today} Abschlüsse heute.` : win.kind === 'meeting' ? 'Genau dafür machst du das.' : 'Der Kollege übernimmt ab hier.'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * „noch ca. 9 Min.“ aus dem eigenen Tempo: Median der Abstände zwischen den Entscheidungen dieser Sitzung (Pausen über
 * 5 Min. zählen nicht). Erst ab 3 erledigten Aufgaben – vorher wäre die Schätzung geraten.
 */
export function remainingTime(cards: CardState[], open: number): string | null {
  if (open === 0) return null;
  const times = cards
    .map((card) => card.decidedAt ?? 0)
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (times.length < 3) return null;
  const gaps = times
    .slice(1)
    .map((at, index) => at - times[index])
    .filter((gap) => gap > 0 && gap <= 5 * 60_000)
    .sort((a, b) => a - b);
  if (gaps.length < 2) return null;
  const median = gaps[Math.floor(gaps.length / 2)];
  const minutes = Math.round((median * open) / 60_000);
  return minutes < 1 ? 'noch unter 1 Min.' : `noch ca. ${minutes} Min.`;
}

/** Statt des Fortschritts: Entscheidungen warten aufs Speichern (offline). */
function WaitingStatus({ count }: { count: number }) {
  const { retryWaiting } = useCockpit();
  return (
    <p role="status" className="flex items-center gap-2 text-[13px] text-ink" data-testid="waiting-status">
      <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
      <span className="sm:hidden">Offline · {count} offen</span>
      <span className="hidden sm:inline">
        Offline – {count} {count === 1 ? 'Entscheidung wartet' : 'Entscheidungen warten'} aufs Speichern
      </span>
      <button type="button" onClick={retryWaiting} aria-label="Erneut versuchen" className="whitespace-nowrap font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline">
        <span className="sm:hidden">Nochmal</span>
        <span className="hidden sm:inline">Erneut versuchen</span>
      </button>
    </p>
  );
}

/** Laden bzw. Fehler beim ersten Laden des Tagesstapels. */
function StackStatusPage() {
  const { state } = useDemo();
  const { reload } = useCockpit();
  const failed = state.stack.status === 'error';
  useHotkeys({ enter: () => void reload() }, failed);
  return (
    <CenteredPage>
      {failed ? (
        <div role="alert" className="flex flex-col items-center">
          <h1 className="display text-[28px] font-semibold sm:text-[34px]">Deine Aufgaben konnten nicht geladen werden.</h1>
          <p className="mt-3 text-[16px] text-ink-2">{state.stack.error}</p>
          <Button variant="primary" size="xl" shortcut="↵" className="mt-10" onClick={() => void reload()}>
            Erneut versuchen
          </Button>
        </div>
      ) : (
        <DelayedStatus>Aufgaben werden geladen …</DelayedStatus>
      )}
    </CenteredPage>
  );
}

/** Ladehinweis erst nach kurzer Zeit – sonst blitzt er bei schneller Antwort nur auf. */
export function DelayedStatus({ children, className }: { children: ReactNode; className?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShow(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p role="status" className={cn('text-[15px] text-ink-3 transition-opacity duration-200', show ? 'opacity-100' : 'opacity-0', className)}>
      {children}
    </p>
  );
}

/** Abgelehnte Entscheidung: Die Aufgabe ist zurück – mit Grund. */
function FailureLine({ taskId }: { taskId: string }) {
  const { state } = useDemo();
  const failure = state.stack.failures[taskId];
  if (!failure) return null;
  return (
    <p className="mx-auto mt-4 flex max-w-[600px] items-baseline gap-2 px-5 text-[13.5px] text-ink" data-testid="card-failure">
      <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
      <span>
        Nicht gespeichert: {failure.message} Entscheide bitte neu.
      </span>
    </p>
  );
}

/** Die Aufgabe wurde inzwischen woanders erledigt – nicht mehr bearbeiten, nur weiter. */
function StaleCard({ card }: { card: CardState }) {
  const { dispatch } = useDemo();
  const next = () => dispatch({ type: 'DISMISS_STALE', taskId: card.id });
  useHotkeys({ enter: next, arrowright: next });
  return (
    <CenteredPage>
      <h1 className="display text-[28px] font-semibold sm:text-[34px]">Diese Aufgabe ist nicht mehr fällig.</h1>
      <Button variant="primary" size="xl" shortcut="↵" className="mt-10" onClick={next} data-testid="stale-next">
        Weiter
      </Button>
    </CenteredPage>
  );
}

/** Fängt Anzeigefehler einer einzelnen Aufgabe ab – der Rest des Cockpits bleibt bedienbar. */
class CardBoundary extends Component<{ card: CardState; onSkip: (args: DecideArgs) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: { card: CardState }) {
    if (previous.card.id !== this.props.card.id && this.state.failed) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <CenteredPage>
        <h1 className="display text-[28px] font-semibold">Diese Aufgabe kann nicht angezeigt werden.</h1>
        <Button
          variant="primary"
          size="xl"
          className="mt-10"
          onClick={() => this.props.onSkip({ decision: 'skip', positive: false, action: null, toast: SKIP_TOAST })}
        >
          Überspringen
        </Button>
      </CenteredPage>
    );
  }
}

/** Schnellwahl für „Später“: Tage ab heute, um 8 Uhr (wie im Lead-Panel unter „Follow-up“, dort auch ein freies Datum). */
const LATER_PRESETS: { label: string; days?: number; months?: number }[] = [
  { label: 'In 2 Tagen', days: 2 },
  { label: 'In 4 Tagen', days: 4 },
  { label: 'In 1 Woche', days: 7 },
  { label: 'In 2 Wochen', days: 14 },
];

function laterAt(preset: (typeof LATER_PRESETS)[number]): number {
  const date = new Date();
  if (preset.days) date.setDate(date.getDate() + preset.days);
  if (preset.months) date.setMonth(date.getMonth() + preset.months);
  date.setHours(8, 0, 0, 0);
  return date.getTime();
}

/**
 * „Später“ (Wunsch des Nutzers 22.10.): Lead jetzt pausieren und an einem Tag wieder in die Aufgaben holen – auch nach
 * allen Follow-ups. W öffnet, 1–4 wählt. Rückgängig wie beim Überspringen.
 */
function LaterMenu({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (at: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Eigenes Datum (22.10.): „JJJJ-MM-TT“, frühestens morgen.
  const [custom, setCustom] = useState('');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const min = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const pickCustom = () => {
    if (custom && custom >= min) onPick(new Date(`${custom}T08:00`).getTime());
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open, onOpenChange]);
  useHotkeys(
    {
      escape: () => onOpenChange(false),
      ...Object.fromEntries(LATER_PRESETS.map((preset, index) => [String(index + 1), () => onPick(laterAt(preset))])),
    },
    open,
  );

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onOpenChange(!open)}
        icon={<CalendarClock className="h-4 w-4" />}
        shortcut="W"
        title="Pausieren und an einem Tag wieder in die Aufgaben holen"
        aria-label="Später"
        aria-haspopup="menu"
        aria-expanded={open}
        className="max-sm:px-2"
        data-testid="later"
      >
        <span className="hidden sm:inline">Später</span>
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING_MENU}
            style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-10 z-40 w-[240px] overflow-hidden rounded-[14px] border border-line bg-surface-2 p-1.5 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.85)]"
            data-testid="later-menu"
          >
            <p className="px-3 pb-1 pt-1.5 text-[12px] text-ink-3">Pausieren – kommt dann wieder in die Aufgaben</p>
            {LATER_PRESETS.map((preset, index) => (
              <button
                key={preset.label}
                type="button"
                role="menuitem"
                onClick={() => onPick(laterAt(preset))}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] text-ink transition-colors hover:bg-surface-3"
                data-testid={`later-${index + 1}`}
              >
                <span className="flex-1">{preset.label}</span>
                <span className="tabular-nums text-ink-3">{new Date(laterAt(preset)).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })}</span>
                <Kbd>{index + 1}</Kbd>
              </button>
            ))}
            <form
              className="mt-1 flex items-center gap-1.5 border-t border-line px-1.5 pb-0.5 pt-2"
              onSubmit={(event) => {
                event.preventDefault();
                pickCustom();
              }}
            >
              <input
                type="date"
                value={custom}
                min={min}
                onChange={(event) => setCustom(event.target.value)}
                aria-label="Eigenes Datum"
                className="h-8 min-w-0 flex-1 rounded-lg bg-surface-3 px-2 text-[13px] text-ink [color-scheme:dark]"
                data-testid="later-date"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!custom || custom < min} data-testid="later-date-ok">
                OK
              </Button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FilterMenu({ pending }: { pending: CardState[] }) {
  const { state, dispatch } = useDemo();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options: { value: StackFilter; label: string; count: number }[] = [
    { value: 'all', label: 'Alle Aufgaben', count: pending.length },
    ...TYPE_ORDER.map((type) => ({
      value: type as StackFilter,
      label: TYPE_LABELS[type].many.replace(/^n/, 'N'),
      count: pending.filter((card) => card.type === type).length,
    })),
  ];
  const active = options.find((option) => option.value === state.filter) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Filter: ${active.label}`}
        title="Aufgaben filtern"
        data-testid="filter-menu"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-8 min-w-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full text-[13px] font-medium transition-colors hover:bg-surface-3 hover:text-ink',
          // Aktiver Filter gefüllt – so ist er auch mobil (nur Symbol) als aktiv erkennbar.
          state.filter === 'all' ? 'px-2 text-ink-2' : 'bg-surface-3 px-2 text-ink sm:px-3',
        )}
      >
        <ListFilter className="h-4 w-4" aria-hidden />
        {state.filter !== 'all' && <span className="hidden sm:inline">{active.label}</span>}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12 } }}
            transition={SPRING_MENU}
            style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-10 z-40 w-[220px] overflow-hidden rounded-[14px] border border-line bg-surface-2 p-1.5 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.85)]"
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === state.filter}
                disabled={option.count === 0}
                onClick={() => {
                  dispatch({ type: 'SET_FILTER', filter: option.value });
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] text-ink transition-colors hover:bg-surface-3 disabled:text-ink-4"
              >
                <span className="flex w-4 justify-center">
                  {option.value === state.filter && <Check className="h-4 w-4" strokeWidth={2.5} />}
                </span>
                <span className="flex-1">{option.label}</span>
                <span className="tabular-nums text-ink-3">{option.count}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CenteredPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[calc(100dvh-65px-var(--safe-top))] flex-col items-center justify-center px-5 pb-24 pt-10 text-center">
      {children}
    </div>
  );
}

function DonePage({ cards }: { cards: CardState[] }) {
  const { state, dispatch } = useDemo();
  return (
    <CenteredPage>
      <SuccessScreen cards={cards} founder={state.founder as FounderId} onNext={() => dispatch({ type: 'SET_VIEW', view: 'dashboard' })} />
    </CenteredPage>
  );
}

function FilterDonePage({ remaining }: { remaining: number }) {
  const { state, dispatch } = useDemo();
  const label = { all: 'Aufgaben', reply: 'Antworten', followup: 'Follow-ups', first: 'Erstnachrichten', lead: 'neuen Leads' }[state.filter];

  useHotkeys({ enter: () => dispatch({ type: 'SET_FILTER', filter: 'all' }) });

  return (
    <CenteredPage>
      <h1 className="display text-[32px] font-semibold sm:text-[40px]">Alle {label} erledigt</h1>
      <p className="mt-3 text-[17px] text-ink-2">
        Noch {remaining} {remaining === 1 ? 'Aufgabe' : 'Aufgaben'} offen.
      </p>
      <Button variant="primary" size="xl" shortcut="↵" className="mt-10" onClick={() => dispatch({ type: 'SET_FILTER', filter: 'all' })}>
        Mit allen weitermachen
      </Button>
    </CenteredPage>
  );
}

/** Heute steht nichts an (noch keine Leads, alles erledigt in einer früheren Sitzung). */
function EmptyPage() {
  const { dispatch } = useDemo();
  const search = () => dispatch({ type: 'SET_VIEW', view: 'search' });
  useHotkeys({ enter: search });
  return (
    <CenteredPage>
      <h1 className="display text-[32px] font-semibold sm:text-[40px]">Heute steht nichts an.</h1>
      <Button variant="primary" size="xl" shortcut="↵" className="mt-10" onClick={search}>
        Neue Leads suchen
      </Button>
    </CenteredPage>
  );
}
