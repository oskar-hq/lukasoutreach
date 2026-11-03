import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const DOT: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  accent: 'bg-accent',
};

/** 6-px-Statuspunkt. Steht nie allein – immer neben neutralem Text (DESIGN.md §3). */
export function Dot({ tone = 'neutral', className }: { tone?: Tone; className?: string }) {
  return <span aria-hidden className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', DOT[tone], className)} />;
}

interface StatusLineProps {
  tone?: Tone;
  role?: 'status' | 'alert';
  testId?: string;
  className?: string;
  /** Kleiner Textknopf direkt hinter dem Satz (z. B. „Erneut versuchen“). */
  action?: ReactNode;
  children: ReactNode;
}

/** Eine Zeile Warnung, Fehler oder Hinweis: Punkt + ein Satz in `ink`. Schriftgröße setzt der Aufrufer. */
export function StatusLine({ tone = 'warn', role, testId, className, action, children }: StatusLineProps) {
  return (
    <p role={role} data-testid={testId} className={cn('flex items-baseline gap-2 text-ink', className)}>
      <Dot tone={tone} className="-translate-y-px" />
      <span className="min-w-0">
        {children}
        {action ? <> {action}</> : null}
      </span>
    </p>
  );
}

/** Kurzer Stand rechts in einer Zeile („Eingerichtet“, „Fehlt“) – Punkt nur bei einer Abweichung. */
export function StatusText({ tone, muted = false, testId, children }: { tone?: Exclude<Tone, 'neutral'>; muted?: boolean; testId?: string; children: ReactNode }) {
  return (
    <span data-testid={testId} className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-[13.5px]', muted ? 'text-ink-3' : 'text-ink-2')}>
      {tone && <Dot tone={tone} />}
      {children}
    </span>
  );
}
