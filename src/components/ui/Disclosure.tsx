import { ChevronDown } from 'lucide-react';
import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** `chip`: kleiner runder Textknopf · `inline`: fließt im Text mit und erbt Schrift und Farbe. */
export type DisclosureLook = 'inline' | 'chip';

interface DisclosureToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onToggle'> {
  open: boolean;
  onToggle: () => void;
  /** id des Inhalts → aria-controls; nur angeben, solange der Inhalt im DOM ist. */
  controls?: string;
  look?: DisclosureLook;
  testId?: string;
  children: ReactNode;
}

/**
 * „Einen Klick entfernt“ (DESIGN.md §1): ruhiger Textknopf mit Pfeil, der sich beim Öffnen dreht. Die Beschriftung
 * bleibt in beiden Zuständen gleich – Pfeil und aria-expanded zeigen den Zustand.
 */
export function DisclosureToggle({ open, onToggle, controls, look = 'chip', testId, className, children, ...rest }: DisclosureToggleProps) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      data-testid={testId}
      onClick={onToggle}
      className={cn(
        look === 'chip'
          ? 'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink'
          : 'inline text-left text-balance transition-colors hover:text-ink',
        className,
      )}
      {...rest}
    >
      {children}
      <ChevronDown
        aria-hidden
        className={cn(
          'shrink-0 transition-transform duration-200 motion-reduce:transition-none',
          look === 'chip' ? 'h-3.5 w-3.5' : 'ml-1 inline h-[0.8em] w-[0.8em] align-[-0.05em]',
          open && 'rotate-180',
        )}
      />
    </button>
  );
}

interface DisclosureProps {
  /** Inhalt des Knopfs. */
  summary: ReactNode;
  children: ReactNode;
  /** Gesteuert (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Ungesteuert: Startzustand bei jedem Einhängen (Standard zu). */
  defaultOpen?: boolean;
  look?: DisclosureLook;
  align?: 'center' | 'start';
  /** Inhalt bleibt eingehängt (nur versteckt) – z. B. wenn darin Entwürfe oder Abrufe leben. */
  keepMounted?: boolean;
  /** Knopf: `${testId}-toggle`, Inhalt: `${testId}`. */
  testId?: string;
  className?: string;
  toggleClassName?: string;
  contentClassName?: string;
}

/** Knopf + Inhalt, der erst auf Klick erscheint. Ohne Höhen-Animation. */
export function Disclosure({
  summary,
  children,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  look = 'inline',
  align = 'center',
  keepMounted = false,
  testId,
  className,
  toggleClassName,
  contentClassName,
}: DisclosureProps) {
  const id = useId();
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const open = controlledOpen ?? ownOpen;
  const toggle = () => {
    const next = !open;
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  return (
    <div className={cn('flex flex-col', align === 'center' ? 'items-center' : 'items-start', className)}>
      <DisclosureToggle look={look} open={open} onToggle={toggle} controls={keepMounted || open ? id : undefined} testId={testId && `${testId}-toggle`} className={toggleClassName}>
        {summary}
      </DisclosureToggle>
      {keepMounted ? (
        <div id={id} hidden={!open} data-testid={testId} className={contentClassName}>
          {children}
        </div>
      ) : (
        open && (
          <div id={id} data-testid={testId} className={contentClassName}>
            {children}
          </div>
        )
      )}
    </div>
  );
}
