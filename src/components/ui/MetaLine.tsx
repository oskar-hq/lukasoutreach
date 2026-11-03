import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Eine Zeile Fakten, getrennt durch „·“, bricht sauber um. Leere Einträge fallen weg. */
export function MetaLine({ items, className, testId }: { items: ReactNode[]; className?: string; testId?: string }) {
  const shown = items.filter((item) => item !== null && item !== undefined && item !== false && item !== '');
  if (shown.length === 0) return null;
  return (
    <div data-testid={testId} className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-1', className)}>
      {shown.map((item, index) => (
        <Fragment key={index}>
          {/* Leerzeichen halten textContent lesbar („Deutschland · 15 Profile“) – Flex ignoriert sie. */}
          {index > 0 && (
            <>
              {' '}
              <span aria-hidden className="text-ink-3">
                ·
              </span>{' '}
            </>
          )}
          {item}
        </Fragment>
      ))}
    </div>
  );
}
