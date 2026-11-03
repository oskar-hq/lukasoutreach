import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  /** Kleine Zahl neben dem Titel in `ink-3`, z. B. die Anzahl der Leads. */
  aside?: ReactNode;
  /** Haupt-Aktion rechts in derselben Zeile. */
  action?: ReactNode;
  /** Höchstens ein Satz unter dem Titel – meist keiner. */
  children?: ReactNode;
  className?: string;
  titleId?: string;
}

/** Gleicher Seitenkopf überall: Titel, optional Zahl, Haupt-Aktion rechts – keine Eyebrow darüber (DESIGN.md §6). */
export function PageHeader({ title, aside, action, children, className, titleId }: PageHeaderProps) {
  return (
    <header className={className}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <h1 id={titleId} className="display text-[30px] font-bold leading-[1.1] tracking-[-0.025em]">
            {title}
          </h1>
          {aside !== undefined && aside !== null && <span className="text-[13px] font-semibold tabular-nums text-ink-3">{aside}</span>}
        </div>
        {action}
      </div>
      {children && <div className="mt-2 max-w-xl text-[13px] text-ink-2">{children}</div>}
    </header>
  );
}
