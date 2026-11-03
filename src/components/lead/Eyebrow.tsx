import type { ReactNode } from 'react';

/** Überschrift eines Abschnitts im Lead-Panel: klein, Versalien, über einer Karte. */
export function Eyebrow({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-2">
      {children}
    </h3>
  );
}
