import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const DOTS: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  accent: 'bg-accent',
};

interface PillProps {
  children: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  dot?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  wrap?: boolean;
}

/** Kleines Label. Farbe nur über Punkt/Icon – der Text bleibt neutral. */
export function Pill({ children, tone = 'neutral', icon, dot = !icon, className, size = 'md', wrap = false }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border border-transparent bg-surface-3 font-medium text-ink',
        size === 'md' ? 'min-h-7 px-2.5 text-[13px]' : 'min-h-6 px-2 text-[12px]',
        wrap && 'py-1',
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOTS[tone])} />}
      {icon && <span className="flex shrink-0 items-center text-ink-2 [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
      <span className={wrap ? 'leading-snug' : 'truncate'}>{children}</span>
    </span>
  );
}
