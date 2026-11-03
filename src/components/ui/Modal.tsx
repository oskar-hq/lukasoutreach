import { AnimatePresence, animate, motion, useDragControls, useIsPresent, useMotionValue, useReducedMotion, type PanInfo } from 'motion/react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { SPRING_BACK, shouldDismiss, useMediaQuery } from '../../lib/gesture';
import { useSheetSwipe } from '../../lib/sheetSwipe';
import { SPRING } from '../../lib/motion';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  className?: string;
}

export function Modal({ open, ...props }: ModalProps) {
  return createPortal(<AnimatePresence>{open && <ModalContent {...props} />}</AnimatePresence>, document.body);
}

function ModalContent({ onClose, children, labelledBy, className }: Omit<ModalProps, 'open'>) {
  // Während der Ausblend-Animation gilt der Dialog nicht mehr als modal → Tastenkürzel sind sofort wieder aktiv.
  const present = useIsPresent();
  // Auf dem Handy ein Bottom-Sheet: kommt von unten, geht nach unten und lässt sich am Griff wegziehen.
  const sheet = useMediaQuery('(max-width: 639px)');
  // „Bewegung reduzieren“: MotionConfig schaltet Transforms ab – ohne Ausweichen ploppte das Sheet hart auf. Dann überblenden.
  const fade = useReducedMotion() ?? false;
  const y = useMotionValue(0);
  const dragControls = useDragControls();
  // Schwung des Fingers, wenn das Sheet weggezogen wurde – die Ausblend-Feder setzt ihn nahtlos fort.
  const [flick, setFlick] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const release = (offset: number, velocity: number, height: number) => {
    if (shouldDismiss(offset, velocity, height)) {
      setFlick(velocity);
      onClose();
    }
    // Immer zurückfedern: Schließt der Dialog, übernimmt die Ausblend-Feder ab der aktuellen Stelle. Darf er gerade
    // nicht schließen (z. B. während des Sendens), kehrt das Sheet an seinen Platz zurück, statt verschoben zu bleiben.
    animate(y, 0, { ...SPRING_BACK, velocity });
  };

  // Mit dem Finger lässt sich das ganze Sheet nach unten wegwischen – nicht nur am Griff (Wunsch des Nutzers 13.10.:
  // „der graue Strich suggeriert es, aber es geht nicht“). Scrollt der Inhalt, wischt es erst, wenn er oben ist.
  useSheetSwipe(dialogRef, sheet && present, y, release);

  useEffect(() => {
    if (!present) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [present, onClose]);

  // Maus (oder Stift) am Griff; Finger übernimmt `useSheetSwipe` für das ganze Sheet.
  const startDrag = (event: ReactPointerEvent) => {
    if (!present || !sheet || event.pointerType === 'touch') return;
    event.preventDefault();
    dragControls.start(event);
  };

  const endDrag = (event: PointerEvent, info: PanInfo) => {
    const height = (event.target as HTMLElement | null)?.closest('[role="dialog"]')?.getBoundingClientRect().height ?? 400;
    release(y.get(), info.velocity.y, height);
  };

  return (
    <div className={cn('fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6', !present && 'pointer-events-none')}>
      <motion.div
        className="absolute inset-0 bg-black/60 backdrop-blur-[6px] reduced-transparency:bg-black/80 reduced-transparency:backdrop-blur-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal={present ? 'true' : undefined}
        aria-labelledby={labelledBy}
        className={cn(
          'relative z-10 max-h-[var(--sheet-max-h)] w-full overflow-hidden rounded-t-[20px] max-sm:pb-[var(--safe-bottom)] bg-surface-2 shadow-[0_40px_120px_-20px_rgb(0_0_0/0.9)] sm:max-w-2xl sm:rounded-[20px]',
          className,
        )}
        style={{ transformOrigin: '50% 100%', y }}
        initial={fade ? { opacity: 0 } : sheet ? { y: '100%' } : { opacity: 0, scale: 0.96, y: 12 }}
        animate={fade ? { opacity: 1 } : sheet ? { y: 0 } : { opacity: 1, scale: 1, y: 0 }}
        exit={
          fade
            ? { opacity: 0, transition: { duration: 0.2 } }
            : sheet
              ? { y: '100%', transition: { ...SPRING, velocity: flick } }
              : { opacity: 0, scale: 0.97, y: 8 }
        }
        transition={SPRING}
        drag={sheet ? 'y' : false}
        dragListener={false}
        dragControls={dragControls}
        // Nach oben nur zäher Widerstand (Gummiband), nach unten folgt das Sheet dem Finger 1:1.
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.06, bottom: 1 }}
        dragMomentum={false}
        onDragEnd={endDrag}
      >
        {sheet && (
          <div
            aria-hidden
            data-testid="sheet-grabber"
            onPointerDown={startDrag}
            className="absolute inset-x-0 top-0 z-10 flex h-6 cursor-grab touch-none justify-center pt-2 active:cursor-grabbing"
          >
            <span className="h-1 w-9 rounded-full bg-white/25" />
          </div>
        )}
        {children}
      </motion.div>
    </div>
  );
}
