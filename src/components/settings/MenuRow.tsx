import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Dot, type Tone } from '../ui/Status';

/** Kennzeichen rechts in einer Zeile – nur was abweicht (DESIGN.md §1). */
export type RowBadge = { text: string; tone: Tone };

/**
 * Eine Zeile der Einstellungs-Menüs (Vorbild Trade Republic): Name fett, darunter grau der aktuelle Wert oder was man
 * dort findet, rechts ein Pfeil. Optional ein Symbol im weißen Kreis (erste Ebene). Keine Linien, Hover = Fläche.
 */
export function MenuRow({
  title,
  subtitle,
  icon,
  badge,
  onClick,
  testId,
  badgeTestId,
  current,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  badge?: RowBadge | null;
  onClick: () => void;
  testId?: string;
  badgeTestId?: string;
  /** Diese Zeile führt zur gerade offenen Seite (für Screenreader und Tests). */
  current?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
        className="-mx-3 flex min-h-[64px] w-[calc(100%+1.5rem)] items-center gap-4 rounded-[14px] px-3 py-3 text-left transition-colors hover:bg-surface-2"
      >
        {icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-canvas" aria-hidden>
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold tracking-[-0.01em] text-ink">{title}</span>
          {subtitle && <span className="mt-0.5 block truncate text-[13.5px] text-ink-3">{subtitle}</span>}
        </span>
        {badge && (
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] text-ink-2" data-testid={badgeTestId}>
            <Dot tone={badge.tone} />
            {badge.text}
          </span>
        )}
        <ChevronRight className="h-[18px] w-[18px] shrink-0 text-ink-4" aria-hidden />
      </button>
    </li>
  );
}

/** Liste von `MenuRow`s ohne Trennlinien. */
export function MenuList({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ul className={cn('space-y-1', className)} aria-label={label}>
      {children}
    </ul>
  );
}
