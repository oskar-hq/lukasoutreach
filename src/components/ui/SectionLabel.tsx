import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type SectionLabelProps = {
  as?: 'p' | 'h2' | 'h3' | 'h4';
  /** Nur ✦ (Sparkles, h-3.5 w-3.5) für KI-Inhalte. */
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>;

/** Eyebrow über einem Abschnitt (Zeitraum, KI-Einschätzung …) – überall gleich, ohne eigenen Abstand. */
export function SectionLabel({ as: Tag = 'p', icon, className, children, ...rest }: SectionLabelProps) {
  return (
    <Tag className={cn('flex items-center gap-1.5 text-[12px] font-semibold text-ink-3', className)} {...rest}>
      {icon}
      {children}
    </Tag>
  );
}
