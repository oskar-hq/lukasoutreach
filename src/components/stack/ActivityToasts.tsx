import { AnimatePresence, motion } from 'motion/react';
import { Check, Undo2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useHotkeys } from '../../lib/useHotkeys';
import { UNDO_WINDOW_MS, useCockpit } from '../../state/cockpit';
import { useDemo } from '../../state/demo';
import { outbox } from '../../state/outbox';
import { Kbd } from '../ui/Kbd';
import { SPRING_MENU } from '../../lib/motion';

interface ActivityContextValue {
  /** Letzte Entscheidung zurücknehmen (Taste Z oder Knopf in der Meldung). */
  undoLatest: () => void;
  /** true, solange eine Meldung sichtbar ist (im Fokus-Modus steht sie an Stelle des Fortschritts). */
  busy: boolean;
}

const ActivityContext = createContext<ActivityContextValue | null>(null);

export function useActivity() {
  const context = useContext(ActivityContext);
  if (!context) throw new Error('useActivity muss innerhalb von ActivityProvider verwendet werden');
  return context;
}

type Mode = 'pending' | 'sending' | 'done' | 'skip' | 'info';

interface ToastView {
  key: string;
  mode: Mode;
  text: string;
  short: string;
  undoable: boolean;
  /** Ende des Rückgängig-Fensters (für die Leiste). */
  commitAt?: number;
}

/** Wie lange Meldungen nach ihrem Ende noch stehen bleiben. */
const DONE_MS = 1200;
const INFO_MS = 2200;
const NOTICE_MS = 8000;

/**
 * Meldungen zu Entscheidungen – folgen dem echten Stand im Ausgangskorb:
 * Rückgängig-Fenster (mit ablaufender Leiste) → wird gespeichert → gespeichert ✓. Immer nur eine zugleich.
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useDemo();
  const cockpit = useCockpit();
  const focus = state.view === 'focus';
  const snapshot = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);
  const [hidden, setHidden] = useState<Record<string, true>>({});
  const [info, setInfo] = useState<{ id: number; text: string; at: number } | null>(null);
  const infoId = useRef(0);

  const latestId = state.stack.decisionLog[state.stack.decisionLog.length - 1];
  const outcome = latestId ? state.stack.outcomes[latestId] : undefined;
  // Ersetzte Meldungen kommen nicht zurück (z. B. nach „Rückgängig“ die der vorletzten Entscheidung).
  // Je Entscheidung (ID + Zeitpunkt), damit eine neu getroffene Entscheidung wieder eine Meldung bekommt.
  const instance = latestId && outcome ? `${latestId}-${outcome.decidedAt}` : undefined;
  const [retired, setRetired] = useState<Set<string>>(() => new Set());
  const previousInstance = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = previousInstance.current;
    previousInstance.current = instance;
    if (previous && previous !== instance) setRetired((current) => new Set(current).add(previous));
  }, [instance]);

  let toast: ToastView | null = null;
  // Eine neue Entscheidung verdrängt den Hinweis (z. B. „Rückgängig gemacht“).
  if (info && !(outcome && outcome.decidedAt > info.at)) {
    toast = { key: `info-${info.id}`, mode: 'info', text: info.text, short: info.text, undoable: false };
  } else if (latestId && outcome && instance && outcome.commit !== 'waiting' && !retired.has(instance)) {
    const key = `${latestId}-${outcome.decidedAt}-${outcome.commit}`;
    const mode: Mode =
      outcome.commit === 'scheduled' ? 'pending' : outcome.commit === 'sending' ? 'sending' : outcome.commit === 'done' ? 'done' : 'skip';
    const short = outcome.toast.short ?? outcome.toast;
    toast = {
      key,
      mode,
      text: mode === 'done' ? outcome.toast.done : outcome.toast.pending,
      short: mode === 'done' ? short.done : short.pending,
      undoable: mode === 'pending' || mode === 'skip',
      commitAt: snapshot.entries.find((entry) => entry.id === latestId)?.commitAt,
    };
  }
  const visible = toast && !hidden[toast.key] ? toast : null;

  // Gespeichert/übersprungen/Hinweis: nach kurzer Zeit ausblenden.
  useEffect(() => {
    if (!toast || hidden[toast.key]) return;
    const delay = toast.mode === 'done' ? DONE_MS : toast.mode === 'skip' ? UNDO_WINDOW_MS : toast.mode === 'info' ? INFO_MS : null;
    if (delay === null) return;
    const key = toast.key;
    const timer = window.setTimeout(() => {
      setHidden((current) => ({ ...current, [key]: true }));
      if (key.startsWith('info-')) setInfo((current) => (current && `info-${current.id}` === key ? null : current));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [toast?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const showInfo = useCallback((text: string) => setInfo({ id: ++infoId.current, text, at: Date.now() }), []);

  const undoLatest = useCallback(() => {
    const result = cockpit.undoLatest();
    if (result === 'undone') showInfo('Rückgängig gemacht');
    else if (result === 'too_late') showInfo('Schon gespeichert – Rückgängig geht nicht mehr');
  }, [cockpit, showInfo]);

  // Maus oder Tastatur-Fokus auf der Meldung hält das Rückgängig-Fenster an. Als Effekt, damit das Anhalten auch
  // endet, wenn die Meldung verschwindet, während die Maus noch darauf steht (kein mouseleave mehr).
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const holding = !!visible?.undoable && (pointerInside || focusInside);
  useEffect(() => {
    if (!holding) return;
    outbox.hold('toast');
    return () => outbox.release('toast');
  }, [holding, visible?.key]);
  useEffect(() => {
    if (visible) return;
    setPointerInside(false);
    setFocusInside(false);
  }, [!!visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Z im Fokus-Modus immer (ist die Entscheidung schon gespeichert, sagt die Meldung das), sonst nur, solange die
  // Meldung zu sehen ist – sonst nähme Z aus anderen Ansichten heraus unbemerkt eine alte Entscheidung zurück.
  useHotkeys({ z: undoLatest }, !!outcome && !state.panelLeadId && (focus || !!visible));

  return (
    <ActivityContext.Provider value={{ undoLatest, busy: !!visible }}>
      {children}
      <div
        aria-live="polite"
        // Im Fokus-Modus erscheint die Meldung mittig in der Kopfleiste (auf dem Handy darunter), sonst unten.
        className={cn(
          'pointer-events-none fixed inset-x-0 z-40 flex flex-col items-center gap-2 px-4',
          focus ? 'top-[calc(72px+var(--safe-top))] sm:top-[calc(10px+var(--safe-top))]' : 'bottom-[calc(1.25rem+var(--nav-bottom))]',
        )}
      >
        <AnimatePresence initial={false}>
          {visible && (
            <motion.div
              key={visible.mode === 'info' ? visible.key : (latestId ?? visible.key)}
              layout
              initial={{ opacity: 0, y: focus ? -6 : 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
              transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
              onMouseEnter={() => setPointerInside(true)}
              onMouseLeave={() => setPointerInside(false)}
              className={cn(
                'pointer-events-auto relative flex h-11 max-w-full items-center gap-2.5 overflow-hidden rounded-full border border-line-strong pl-3.5 pr-2 text-[13.5px] shadow-[0_16px_40px_-12px_rgb(0_0_0/0.8)]',
                focus ? 'bg-surface-3' : 'glass',
              )}
              data-testid="activity-toast"
              data-mode={visible.mode}
            >
              <StatusIcon mode={visible.mode} />
              <span className="min-w-0 truncate pr-1.5 font-medium text-ink">
                <span className="sm:hidden">{visible.short}</span>
                <span className="hidden sm:inline">{visible.text}</span>
              </span>
              {visible.undoable && (
                <button
                  type="button"
                  onClick={undoLatest}
                  onFocus={() => setFocusInside(true)}
                  onBlur={() => setFocusInside(false)}
                  aria-label="Rückgängig (Z)"
                  aria-keyshortcuts="z"
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-white/10 hover:text-ink"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Rückgängig</span>
                  <Kbd>Z</Kbd>
                </button>
              )}
              {visible.mode === 'pending' && visible.commitAt && <UndoBar commitAt={visible.commitAt} held={snapshot.held} />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <NoticeToast
        onOpen={(taskId) => {
          const leadId = state.stack.tasks[taskId]?.lead.id;
          if (leadId) dispatch({ type: 'FOCUS_LEAD', leadId });
        }}
      />
    </ActivityContext.Provider>
  );
}

function StatusIcon({ mode }: { mode: Mode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {mode === 'sending' ? (
        <motion.span
          key="spin"
          exit={{ opacity: 0, scale: 0.6 }}
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-[1.75px] border-white/20 border-t-ink"
        />
      ) : mode === 'done' || mode === 'info' ? (
        <motion.span
          key="check"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          // Kommt 100+ Mal am Tag und folgt keiner Geste – deshalb ohne Nachschwingen.
          transition={SPRING_MENU}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-good text-black"
        >
          <Check className="h-3 w-3" strokeWidth={3.2} />
        </motion.span>
      ) : (
        <motion.span key="dot" className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-2" />
      )}
    </AnimatePresence>
  );
}

/** Leiste am unteren Rand der Meldung: so lange geht „Rückgängig“ noch. Läuft nicht, solange angehalten. */
function UndoBar({ commitAt, held }: { commitAt: number; held: boolean }) {
  const remaining = Math.max(0, commitAt - Date.now());
  const share = Math.min(1, remaining / Math.max(UNDO_WINDOW_MS, 1));
  return (
    <motion.span
      key={`${commitAt}-${held}`}
      aria-hidden
      className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-ink/40 motion-reduce:hidden"
      initial={{ scaleX: share }}
      animate={{ scaleX: held ? share : 0 }}
      transition={{ duration: held ? 0 : remaining / 1000, ease: 'linear' }}
    />
  );
}

/** Abgelehnte Entscheidung o. Ä.: eigene, deutlichere Meldung (wird vorgelesen), 8 s, Maus darüber hält sie. */
function NoticeToast({ onOpen }: { onOpen: (taskId: string) => void }) {
  const { state, dispatch } = useDemo();
  const notice = state.notice;
  const [hovered, setHovered] = useState(false);
  // Neue Meldung: Zeit läuft wieder (die alte verschwand evtl. unter der Maus, ohne mouseleave).
  useEffect(() => setHovered(false), [notice?.id]);

  useEffect(() => {
    if (!notice || hovered) return;
    const timer = window.setTimeout(() => dispatch({ type: 'DISMISS_NOTICE', id: notice.id }), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, hovered, dispatch]);

  return (
    <div role="alert" className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+var(--nav-bottom))] z-40 flex justify-center px-4">
      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="pointer-events-auto flex w-full max-w-[440px] items-start gap-3 rounded-[18px] border border-line-strong bg-surface-3 px-4 py-3 text-[13.5px] shadow-[0_16px_40px_-12px_rgb(0_0_0/0.8)]"
            data-testid="notice"
          >
            <span
              className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', notice.tone === 'good' ? 'bg-good' : notice.tone === 'neutral' ? 'bg-ink-3' : 'bg-bad')}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{notice.title}</p>
              {notice.detail && <p className="mt-0.5 text-ink-2">{notice.detail}</p>}
            </div>
            {notice.taskId && state.stack.order.includes(notice.taskId) && !state.stack.outcomes[notice.taskId] && (
              <button
                type="button"
                onClick={() => {
                  onOpen(notice.taskId!);
                  dispatch({ type: 'DISMISS_NOTICE', id: notice.id });
                }}
                className="shrink-0 rounded-full px-2.5 py-1 text-[12.5px] font-medium text-ink-2 hover:bg-white/10 hover:text-ink"
              >
                Ansehen
              </button>
            )}
            <button
              type="button"
              aria-label="Meldung schließen"
              onClick={() => dispatch({ type: 'DISMISS_NOTICE', id: notice.id })}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-white/10 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
