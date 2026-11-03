import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/gesture';

/**
 * Bottom-Sheet innerhalb des Lead-Panels (Bearbeiten, Notiz, „Mehr“). Liegt über dem Panel, nicht über der Seite –
 * auf dem Desktop bleibt es in der rechten Spalte. Esc und Tippen auf den Hintergrund schließen; den Esc-Griff hat
 * `LeadPanel`, damit Esc zuerst das Sheet und erst dann das Panel schließt.
 */
export function PanelSheet({
  open,
  title,
  onClose,
  testId,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  testId?: string;
  children: ReactNode;
}) {
  const fade = useReducedMotion() ?? false;
  const desktop = useMediaQuery('(min-width: 640px)');
  const sheetRef = useRef<HTMLDivElement>(null);
  // Geschlossen, aber noch beim Ausblenden: Fokus sofort aus dem Sheet nehmen – sonst fängt das Textfeld das nächste Esc
  // ab und das Panel bliebe offen.
  useEffect(() => {
    if (open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && sheetRef.current?.contains(active)) active.blur();
  }, [open]);
  return (
    <AnimatePresence>
      {open && (
        <div className="absolute inset-0 z-20 flex flex-col justify-end sm:items-center sm:justify-center sm:p-6" data-no-swipe>
          <motion.div
            className="absolute inset-0 bg-black/55 sm:bg-black/45"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <motion.div
            ref={sheetRef}
            // Kein zweites role="dialog": Das Sheet gehört zum Panel-Dialog.
            role="group"
            aria-label={title}
            data-testid={testId}
            // Handy: Bottom-Sheet über die ganze Breite. Desktop: Dialog-Karte in der Mitte, ohne Griff.
            className="relative max-h-[85%] overflow-y-auto rounded-t-[22px] bg-surface-3 px-4 pt-2.5 pb-[calc(20px+var(--safe-bottom,0px))] sm:max-h-[80vh] sm:w-full sm:max-w-[440px] sm:rounded-[18px] sm:border sm:border-white/[0.08] sm:px-3 sm:pt-4 sm:pb-3 sm:shadow-[0_24px_60px_-12px_rgb(0_0_0/0.8)]"
            initial={fade ? { opacity: 0 } : { y: desktop ? 16 : '100%', opacity: desktop ? 0 : 1 }}
            animate={fade ? { opacity: 1 } : { y: 0, opacity: 1 }}
            exit={
              fade
                ? { opacity: 0, transition: { duration: 0.15 } }
                : desktop
                  ? { y: 8, opacity: 0, transition: { duration: 0.15 } }
                  : { y: '100%', transition: { type: 'spring', bounce: 0, duration: 0.3 } }
            }
            transition={desktop ? { duration: 0.2, ease: [0.23, 1, 0.32, 1] } : { type: 'spring', bounce: 0, duration: 0.35 }}
          >
            <div aria-hidden className="mx-auto mb-3.5 h-[5px] w-9 rounded-full bg-white/15 sm:hidden" />
            <SheetFocus />
            <h3 className="mx-1 mb-3 text-[17px] font-bold text-ink sm:text-[15px]">{title}</h3>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/**
 * Fokus ins Sheet, falls kein Feld darin `autoFocus` hat – sonst bleibt er hinter dem Hintergrund hängen. Beim
 * Schließen zurück an den Auslöser (DESIGN.md §9), solange der noch da ist.
 */
function SheetFocus() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const sheet = ref.current?.parentElement;
    const dialog = sheet?.closest('[role="dialog"]');
    // Nur Auslöser im Panel – ein Knopf hinter dem Panel würde sonst das nächste ↵ abfangen.
    const active = document.activeElement;
    const trigger = active instanceof HTMLElement && dialog?.contains(active) && !sheet?.contains(active) ? active : null;
    if (sheet && !sheet.contains(document.activeElement)) sheet.querySelector<HTMLElement>('input, textarea, select, button')?.focus({ preventScroll: true });
    return () => {
      const focused = document.activeElement;
      const inSheet = focused instanceof HTMLElement && !!sheet?.contains(focused);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else if (inSheet) (focused as HTMLElement).blur();
    };
  }, []);
  return <span ref={ref} hidden />;
}

/** Liste im Sheet: Zeilen wie in iOS-Aktionsblättern. */
export function SheetList({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-[14px] bg-surface-4/60 [&>*:last-child]:border-b-0">{children}</div>;
}

export function SheetItem({
  onClick,
  children,
  meta,
  tone = 'ink',
  disabled,
  testId,
  checked,
}: {
  onClick: () => void;
  children: ReactNode;
  meta?: ReactNode;
  tone?: 'ink' | 'bad';
  disabled?: boolean;
  testId?: string;
  /** Auswahlliste: Häkchen rechts. */
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-pressed={checked}
      className={cn(
        'flex min-h-[52px] w-full items-center justify-between gap-3 border-b border-white/[0.06] px-4 text-left text-[16px] transition-colors hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-[42px] sm:px-3.5 sm:text-[14px]',
        tone === 'bad' ? 'text-bad' : 'text-ink',
      )}
    >
      <span className="min-w-0">{children}</span>
      {checked ? <span className="text-good">✓</span> : meta ? <span className="shrink-0 text-[13px] text-ink-2 sm:text-[12.5px]">{meta}</span> : null}
    </button>
  );
}
