import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Kbd({ children, tone = 'light', className }: { children: ReactNode; tone?: 'light' | 'dark'; className?: string }) {
  return (
    <kbd
      className={cn(
        'hidden h-5 min-w-5 items-center justify-center rounded-[6px] px-1.5 font-sans text-[11px] font-medium leading-none md:inline-flex',
        tone === 'dark' ? 'bg-black/[0.08] text-black/55' : 'border border-white/10 bg-surface-3 text-ink-2',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
