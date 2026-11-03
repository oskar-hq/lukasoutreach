import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface DisclosureRowProps {
  /** Grundlage für `${id}-title` und `${id}-panel`. */
  id: string;
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Rechts: kurzer Stand, z. B. <StatusText>. */
  status?: ReactNode;
  /** Vor dem Titel, z. B. die Vorlagen-ID. */
  leading?: ReactNode;
  as?: 'h2' | 'h3';
  titleWeight?: 'semibold' | 'normal';
  /** data-testid am Knopf. */
  testId?: string;
  panelClassName?: string;
  children: ReactNode;
}

/**
 * Aufklappbare Zeile für Listen von Bereichen (Vorlagen): links der Name, rechts der Stand,
 * ein Pfeil. Der Inhalt bleibt eingehängt und wird nur versteckt – Entwürfe, Abrufe und Fokus-Code laufen weiter.
 * Der Aufrufer umschließt das Fragment mit <section>/<article> und `aria-labelledby={`${id}-title`}`.
 */
export function DisclosureRow({ id, title, open, onToggle, status, leading, as: Tag = 'h2', titleWeight = 'semibold', testId, panelClassName, children }: DisclosureRowProps) {
  return (
    <>
      <Tag className="m-0">
        {/* type="button" ist Pflicht: Die Zeilen liegen in Formularen. */}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={onToggle}
          data-testid={testId}
          className="flex min-h-14 w-full items-center gap-3 py-3 text-left"
        >
          {leading && <span className="shrink-0">{leading}</span>}
          <span id={`${id}-title`} className={cn('min-w-0 flex-1 break-words text-[15px] tracking-[-0.01em] text-ink', titleWeight === 'semibold' && 'font-semibold')}>
            {title}
          </span>
          {status && <span className="flex shrink-0 items-center">{status}</span>}
          <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-ink-3 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-180')} />
        </button>
      </Tag>
      <div id={`${id}-panel`} role="region" aria-labelledby={`${id}-title`} hidden={!open}
        // Beim Öffnen kurz einblenden statt aufzuploppen; Schließen bleibt sofort. Keine Höhen-Animation: Der Inhalt
        // bleibt eingehängt (Entwürfe, Abrufe) und schiebt den Rest einfach nach unten.
        className={cn(
          'transition-[opacity,translate] duration-200 ease-out starting:-translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0',
          panelClassName ?? 'pb-6',
        )}
      >
        {children}
      </div>
    </>
  );
}
